import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConfigError,
  readFlag,
  saveConfig,
  validateBaseUrl,
  validateProfile,
  isDevHost,
  type Config,
} from './config.js';
import { ApiClient } from './client.js';
import { isolatedCredentialsPath, profileConflict, sharedCredentialsPath } from './mode.js';
import type { Capabilities } from './context.js';
import { ApiError, describe, sanitize } from './errors.js';
import { formAccess } from './context.js';
import { PACKAGE_SPEC, RUN } from './package.js';

const ETX = String.fromCharCode(3);
const DEL = String.fromCharCode(127);

const CONNECTION_PREFIX = 'wf1_';
/** A real string is ~220 characters; anything far larger is not one, and must not reach JSON.parse. */
const MAX_CONNECTION_CHARS = 4096;
const MAX_FIELD_CHARS = 512;

export interface ConnectionCredentials {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/**
 * Decodes the one-line string `bin/magento webforms:api:connect` prints: "wf1_" + base64url(JSON) with
 * short keys. Everything the store put in there is treated as untrusted input and validated here.
 */
export const decodeConnectionString = (raw: string, allowInsecure = false): ConnectionCredentials => {
  if (raw.length > MAX_CONNECTION_CHARS) {
    throw new ConfigError(`A connection string is at most ${MAX_CONNECTION_CHARS} characters; this input is longer, so it is not one.`);
  }
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed.startsWith(CONNECTION_PREFIX)) {
    throw new ConfigError(`A connection string starts with "${CONNECTION_PREFIX}"; got "${sanitize(trimmed.slice(0, 12), 12)}...".`);
  }
  const body = trimmed.slice(CONNECTION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new ConfigError('The connection string carries characters that cannot come from one; re-copy it, unbroken, from the command output.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new ConfigError('The connection string is damaged (it did not decode); re-copy it, unbroken, from the command output.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('The connection string does not carry a credential set; re-run webforms:api:connect on the store.');
  }
  const payload = parsed as Record<string, unknown>;
  const field = (key: string, label: string): string => {
    const value = payload[key];
    if (typeof value !== 'string' || value === '') {
      throw new ConfigError(`The connection string lacks ${label}; re-run webforms:api:connect on the store.`);
    }
    if (value.length > MAX_FIELD_CHARS) {
      throw new ConfigError(`The connection string's ${label} is implausibly long; re-run webforms:api:connect on the store.`);
    }
    return value;
  };
  return {
    baseUrl: validateBaseUrl(field('u', 'the store URL'), allowInsecure),
    consumerKey: field('k', 'the consumer key'),
    consumerSecret: field('s', 'the consumer secret'),
    accessToken: field('t', 'the access token'),
    accessTokenSecret: field('ts', 'the access token secret'),
  };
};

/** Reads the piped connection string, bounded, so a wrong pipe cannot stream forever. */
const readAll = async (): Promise<string> => {
  let text = '';
  for await (const chunk of stdin) {
    text += chunk.toString('utf8');
    if (text.length > MAX_CONNECTION_CHARS) {
      throw new ConfigError(`Refusing to read more than ${MAX_CONNECTION_CHARS} characters from stdin; that is not a connection string.`);
    }
  }
  return text;
};

const ask = async (rl: ReturnType<typeof createInterface>, label: string, secret = false): Promise<string> => {
  if (!secret || !stdin.isTTY) return (await rl.question(`${label}: `)).trim();
  stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const restore = () => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      if (stdin.isTTY) stdin.setRawMode(false);
    };
    const onError = (e: Error) => {
      restore();
      reject(e);
    };
    const onData = (chunk: Buffer) => {
      try {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\n' || ch === '\r') {
            restore();
            stdout.write('\n');
            resolve(buffer.trim());
            return;
          }
          if (ch === ETX) {
            restore();
            stdout.write('\n');
            process.exit(130);
          }
          if (ch === DEL) buffer = buffer.slice(0, -1);
          else buffer += ch;
        }
      } catch (e) {
        onError(e as Error);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('error', onError);
  });
};

/** POSIX single-quoting, so a path with spaces or metacharacters stays one argument. */
const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** True when the running entry lives inside an installed package (npx cache or node_modules), on any OS. */
export const runsFromPackage = (entry: string): boolean =>
  entry.split(/[\\/]/).some((segment) => segment === '_npx' || segment === 'node_modules');

export interface HostSetup {
  server: string;
  cli: string;
  desktop: string;
}

/**
 * The host registration for this server. Run from the package, it names the package rather than the file
 * that happens to run now: the npx cache is temporary and its path would pin today's version forever.
 * Run from a clone, it names the built file.
 */
export const hostSetup = (
  entry: string,
  profile: string | undefined,
  isolated: boolean,
  platform: NodeJS.Platform = process.platform,
): HostSetup => {
  const dedicated = isolated && profile !== undefined;
  const server = dedicated ? `webforms-${profile}` : 'webforms';
  const profileArgs = dedicated ? ['--profile', profile as string] : [];
  const fromPackage = runsFromPackage(entry);
  const [command, args] = fromPackage
    ? ['npx', ['-y', PACKAGE_SPEC, ...profileArgs]]
    : ['node', [entry, ...profileArgs]];
  // native Windows cannot spawn npx directly, so both hosts go through cmd /c
  const [run, runArgs] = platform === 'win32' && fromPackage ? ['cmd', ['/c', command, ...args]] : [command, args];
  return {
    server,
    cli: `claude mcp add ${server} --scope user -- ${run} ${runArgs.map(shellQuote).join(' ')}`,
    desktop: JSON.stringify({ mcpServers: { [server]: { command: run, args: runArgs } } }),
  };
};

/**
 * The exact host commands to register this server, so nobody has to assemble a path by hand. A store
 * that shares the process needs no entry of its own - the one shared server already serves it - so the
 * per-profile command is printed only for a store deliberately kept on its own.
 */
const printHostSetup = (profile: string | undefined, isolated: boolean, uncheckedRemote: boolean): void => {
  const entry = resolve(process.argv[1] ?? 'dist/start.js');
  // a global install runs through a symlink in bin/; its real path tells the package apart from a clone
  const setup = hostSetup(existsSync(entry) ? realpathSync(entry) : entry, profile, isolated, process.platform);
  if (isolated && profile !== undefined) {
    stdout.write(`\n"${profile}" is kept out of the shared process. Register its own server:\n`);
  } else {
    stdout.write('\nThis store joins the shared server. If it is already registered, nothing more is needed:\n');
  }
  stdout.write(`  ${setup.cli}\n`);
  stdout.write('\nOr, for Claude Desktop, add to its config file:\n');
  stdout.write(`  ${setup.desktop}\n`);
  if (uncheckedRemote) {
    stdout.write(`\nThis store's certificate is not checked and it is not a local host, so the server refuses it unless its own environment sets ${INSECURE_ENV}=1. That is deliberately not part of the commands above: add it yourself, and only for a development store.\n`);
  }
};

const INSECURE_ENV = 'WEBFORMS_MCP_ALLOW_INSECURE_TLS';

const SETUP_USAGE = `Usage: ${RUN} setup [options]
  --from [<string>]   a connection string from bin/magento webforms:api:connect (asked for when no value follows)
  --from-stdin        read the connection string from standard input
  --profile <name>    store the credentials under this name (credentials.<name>.json)
  --isolated          keep this profile out of the shared process (needs --profile)
  --overwrite         replace a profile that already exists
  --insecure-tls      do not check the store's TLS certificate (development stores only)
  --allow-insecure    allow plain http (development stores only)
Without --from or --from-stdin, setup asks for the base URL and the four OAuth values.
`;

const SETUP_FLAGS = new Set(['--from', '--from-stdin', '--profile', '--isolated', '--overwrite', '--insecure-tls', '--allow-insecure']);

/** What a failed setup or probe tells a person: the code, the store's sentence and what to do about it. */
export const failure = (e: unknown): string =>
  e instanceof ApiError ? describe(e) : e instanceof Error ? e.message : String(e);

/**
 * Interactive setup: either one connection string from `bin/magento webforms:api:connect`, or the base
 * URL and the four OAuth values one by one. Stores them 0600 and probes the store.
 */
export const runSetup = async (args: string[]): Promise<void> => {
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write(SETUP_USAGE);
    return;
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split('=')[0];
    // a bare argument may be a pasted connection string: it is never echoed
    const shown = args[i].startsWith('-') ? `option "${sanitize(flag, 40)}"` : 'argument (not shown)';
    const valued = flag === '--profile' || flag === '--from';
    if (!SETUP_FLAGS.has(flag) || (!valued && args[i].includes('='))) {
      stdout.write(`Unknown setup ${shown}.\n${SETUP_USAGE}`);
      process.exitCode = 2;
      return;
    }
    // the value of --profile / --from is not an option
    if ((flag === '--profile' || flag === '--from') && !args[i].includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
  }
  const allowInsecure = args.includes('--allow-insecure');
  const insecureTls = args.includes('--insecure-tls');
  const overwrite = args.includes('--overwrite');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const profileFlag = readFlag(args, '--profile');
    if (profileFlag === '') throw new ConfigError('--profile needs a name, e.g. --profile stage.');
    const profile = profileFlag === undefined ? undefined : validateProfile(profileFlag);
    const isolated = args.includes('--isolated');
    if (isolated && profile === undefined) {
      throw new ConfigError('--isolated needs a profile name: which store is being kept out of the shared process?');
    }
    // A store kept out of the shared process lives in a directory that process never opens.
    const path = isolated ? isolatedCredentialsPath(profile) : sharedCredentialsPath(profile);
    if (existsSync(isolated ? sharedCredentialsPath(profile) : isolatedCredentialsPath(profile))) throw profileConflict(profile ?? 'default');
    // Said before any secret is typed, not after.
    if (existsSync(path) && !overwrite) {
      throw new ConfigError(`A store is already set up at ${path}. Run setup again with --overwrite to replace it${profile === undefined ? ', or add --profile <name> to set up another store next to it' : ''}.`);
    }
    const fromFlag = readFlag(args, '--from');
    const fromStdin = args.includes('--from-stdin');

    let credentials: ConnectionCredentials;
    if (fromStdin) {
      credentials = decodeConnectionString(await readAll(), allowInsecure);
    } else if (fromFlag !== undefined) {
      if (fromFlag !== '') {
        stdout.write('Note: a connection string passed on the command line stays in your shell history and is visible to other users on this machine. Pipe it into --from-stdin, or use a bare --from, which asks for it.\n');
      }
      const raw = fromFlag !== '' ? fromFlag : await ask(rl, 'Connection string (wf1_...)', true);
      credentials = decodeConnectionString(raw, allowInsecure);
    } else {
      credentials = {
        baseUrl: validateBaseUrl(await ask(rl, 'Store base URL (https://...)'), allowInsecure),
        consumerKey: await ask(rl, 'Consumer key'),
        consumerSecret: await ask(rl, 'Consumer secret', true),
        accessToken: await ask(rl, 'Access token', true),
        accessTokenSecret: await ask(rl, 'Access token secret', true),
      };
    }
    rl.close();

    const config: Config & { allowInsecure: boolean } = {
      ...credentials,
      insecureTls,
      allowInsecure,
      journalKey: randomBytes(32).toString('hex'),
    };
    const remote = !isDevHost(credentials.baseUrl);
    if (remote && (insecureTls || allowInsecure) && process.env[INSECURE_ENV] !== '1') {
      throw new ConfigError(`${insecureTls ? '--insecure-tls' : '--allow-insecure'} is for development stores, and ${new URL(credentials.baseUrl).host} is not a local host. For a development store under a public-looking name, run setup with ${INSECURE_ENV}=1 in its environment; a live store needs a valid certificate and https.`);
    }
    if (insecureTls) stdout.write('WARNING: TLS verification disabled - development instances only.\n');
    // Probe first: a store that refuses these credentials must not cost you a working profile.
    await probe(config);
    await saveConfig(config, path, overwrite);
    stdout.write(`Saved ${path} (mode 600).\n`);
    printHostSetup(profile, isolated, insecureTls && remote);
  } catch (e) {
    rl.close();
    if (e instanceof ConfigError || e instanceof ApiError) {
      stdout.write(`Setup failed: ${failure(e)}\n`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
};

/** Reads the granted permissions off /capabilities; older stores that do not report them get probed instead. */
const reportPermissions = async (api: ApiClient, caps: Capabilities): Promise<void> => {
  let granted: Record<string, unknown> | undefined;
  try {
    const features = caps.features_json ? (JSON.parse(caps.features_json) as Record<string, unknown>) : undefined;
    const permissions = features?.permissions;
    if (permissions && typeof permissions === 'object') granted = permissions as Record<string, unknown>;
  } catch {
    granted = undefined;
  }
  const permissions = granted ? Object.keys(granted).filter((p) => typeof granted![p] === 'boolean') : [];
  if (!granted || permissions.length === 0) {
    for (const [label, run] of [
      ['forms_view', () => api.get('/V1/webforms/forms', { 'searchCriteria[pageSize]': '1' })],
      ['results_view', () => api.get('/V1/webforms/statuses')],
    ] as [string, () => Promise<unknown>][]) {
      try {
        await run();
        stdout.write(`  ${label.padEnd(18)} granted\n`);
      } catch (e) {
        stdout.write(`  ${label.padEnd(18)} ${e instanceof ApiError ? `${e.code} - ${sanitize(e.message, 200)}` : sanitize((e as Error).message, 200)}\n`);
      }
    }
    return;
  }
  const allowed = permissions.filter((permission) => granted[permission] === true);
  stdout.write(`Permissions granted to this integration (${allowed.length} of ${permissions.length}):\n`);
  for (const permission of permissions) {
    stdout.write(`  ${sanitize(permission, 40).padEnd(18)} ${granted[permission] === true ? 'granted' : '-'}\n`);
  }
  if (allowed.length === 0) {
    stdout.write('None granted: open the integration in the admin and tick the permissions it needs under WebForms > API, then Reauthorize.\n');
  }
};

/** GET /capabilities, then report what this integration is actually allowed to do. */
export const probe = async (config: Config): Promise<void> => {
  const api = new ApiClient(config);
  let caps: Capabilities;
  try {
    caps = await api.get<Capabilities>('/V1/webforms/capabilities');
  } catch (e) {
    // At the very first route a 404 does not mean a missing object: the API itself is not there.
    if (e instanceof ApiError && e.http === 404) {
      throw new ApiError(404, 'API_NOT_FOUND', `${config.baseUrl} has no WebForms API (${e.message}). Check that the base URL is the store's root, and that the module is installed and enabled: bin/magento module:status MageMe_WebFormsApi.`);
    }
    throw e;
  }
  stdout.write(`Connected: API v${sanitize(caps.api_version, 20)}, document schema ${sanitize(caps.document_schema_version, 20)}, ${Array.isArray(caps.field_types) ? caps.field_types.length : 0} field types.\n`);
  stdout.write(`Form access: ${formAccess(caps.features_json) ?? 'not reported'}\n`);
  await reportPermissions(api, caps);
};
