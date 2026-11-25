import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { OAuthCredentials } from './oauth.js';
import { RUN } from './package.js';

export interface Config extends OAuthCredentials {
  baseUrl: string;
  /** Skip TLS verification — development instances with self-signed certificates only. */
  insecureTls: boolean;
  /** Per-install random key for hashing journal arguments. */
  journalKey: string;
  /** Human name for this store, shown wherever the site is named; absent means "use the host". */
  label?: string;
  /** false lets irreversible actions run without asking a person — development stores only. Absent means true. */
  confirmActions?: boolean;
}

const DEV_HOST = String.raw`(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.(local|test|localhost))(:\d+)?`;

/** localhost, a loopback address or a *.local / *.test / *.localhost name. */
export const isDevHost = (baseUrl: string): boolean => new RegExp(`^https?://${DEV_HOST}$`).test(baseUrl);

export const MAX_LABEL_CHARS = 80;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** A label is display text from a local file: control characters out, length capped, blank means none. */
export const sanitizeLabel = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.replace(CONTROL_CHARS, '').trim().slice(0, MAX_LABEL_CHARS);
  return clean === '' ? undefined : clean;
};

export const MAX_CREDENTIALS_BYTES = 64 * 1024;
const NOFOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;

export const configDir = (): string => process.env.WEBFORMS_MCP_HOME ?? join(homedir(), '.webforms-mcp');

export class ConfigError extends Error {}

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A profile is a short name, never a path: it becomes a filename inside the config directory. */
export const validateProfile = (raw: string): string => {
  const profile = raw.trim();
  if (!PROFILE_PATTERN.test(profile)) {
    throw new ConfigError(`Profile "${raw}" must be 1-32 characters of a-z, 0-9, "-" or "_", starting with a letter or digit.`);
  }
  return profile;
};

export const credentialsPath = (profile?: string): string =>
  join(configDir(), profile ? `credentials.${validateProfile(profile)}.json` : 'credentials.json');

export const RESERVED_SITE_KEY = 'default';

/** The key a credentials file stands for; a site without one has no id prefix and no resource URI. */
export const siteKeyFromPath = (path: string): string => {
  const name = basename(path);
  if (name === 'credentials.json') return RESERVED_SITE_KEY;
  const match = /^credentials\.([^.]+)\.json$/.exec(name);
  if (!match || match[1] === RESERVED_SITE_KEY || !PROFILE_PATTERN.test(match[1])) {
    throw new ConfigError(`SITE_KEY_UNDERIVABLE: cannot derive a site key from "${name}"; name it credentials.<key>.json or pass --profile.`);
  }
  return match[1];
};

/**
 * Which credentials file this invocation means, most specific first: an explicit --profile, an explicit
 * file path in the environment, a profile in the environment, then the default file.
 */
export const resolveCredentialsPath = (argv: string[] = []): string => {
  const flag = readFlag(argv, '--profile');
  if (flag !== undefined) {
    if (flag === '') throw new ConfigError('--profile needs a name, e.g. --profile stage.');
    return credentialsPath(flag);
  }
  if (process.env.WEBFORMS_MCP_CREDENTIALS_FILE) return process.env.WEBFORMS_MCP_CREDENTIALS_FILE;
  if (process.env.WEBFORMS_MCP_PROFILE) return credentialsPath(process.env.WEBFORMS_MCP_PROFILE);
  return credentialsPath();
};

/**
 * Reads "--flag value" or "--flag=value", left to right so the first spelling wins, and stops at a bare
 * "--". Returns undefined when the flag is absent, '' when it is present without a value.
 */
export const readFlag = (argv: string[], flag: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return undefined;
    if (arg === flag) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith('--') ? '' : next;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
};

/** https is mandatory; plain http is allowed for localhost only unless the user opted in explicitly. */
/** Untrusted text is echoed back only as a short, control-character-free excerpt. */
const excerpt = (raw: string, max = 40): string =>
  raw.replace(CONTROL_CHARS, '').slice(0, max) + (raw.length > max ? '...' : '');

export const validateBaseUrl = (raw: string, allowInsecure = false): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Base URL is not a valid URL: ${excerpt(raw)}`);
  }
  if (url.protocol === 'http:' && !allowInsecure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ConfigError('Base URL must use https (http is allowed for localhost only, or with --allow-insecure).');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('Base URL must be http(s).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('Base URL must not carry credentials, a query string or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
};

const REQUIRED = ['baseUrl', 'consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret', 'journalKey'] as const;

/** The directory holding credentials and journal must be ours, a real directory, and private. */
export const ensurePrivateDir = async (dir: string): Promise<void> => {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConfigError(`${dir} must be a real directory.`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new ConfigError(`${dir} is not owned by the current user.`);
    }
    if ((stat.mode & 0o077) !== 0) {
      await fs.chmod(dir, 0o700);
    }
  }
};

/** Opens without following symlinks and validates the descriptor itself (no stat/read window). */
export const openPrivateFile = async (path: string, flags: number, mode = 0o600): Promise<fs.FileHandle> => {
  await ensurePrivateDir(dirname(path));
  const handle = await fs.open(path, flags | NOFOLLOW, mode);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ConfigError(`${path} is not a regular file.`);
    }
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) {
        throw new ConfigError(`${path} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600.`);
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new ConfigError(`${path} is not owned by the current user.`);
      }
    }
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
};

export const loadConfig = async (path = credentialsPath()): Promise<Config> => {
  let handle: fs.FileHandle;
  try {
    handle = await openPrivateFile(path, fsConstants.O_RDONLY);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const profile = /credentials\.([^\\/]+)\.json$/.exec(path)?.[1];
    throw new ConfigError(`No credentials at ${path}. Run: ${RUN} setup${profile === undefined ? '' : ` --profile ${profile}`}`);
  }
  let raw: string;
  try {
    const { size } = await handle.stat();
    if (size > MAX_CREDENTIALS_BYTES) {
      throw new ConfigError(`${path} is larger than ${MAX_CREDENTIALS_BYTES} bytes; refusing to parse.`);
    }
    raw = (await handle.readFile()).toString('utf8');
  } finally {
    await handle.close();
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Run: ${RUN} setup --overwrite`);
  }
  for (const key of REQUIRED) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') {
      throw new ConfigError(`${path} lacks "${key}". Run: ${RUN} setup`);
    }
  }
  // Plain http to a remote store leaves the body unsigned in transit, so the file alone cannot allow it.
  const plain = validateBaseUrl(parsed.baseUrl as string, true);
  if (parsed.allowInsecure === true && plain.startsWith('http:') && !isDevHost(plain) && process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS !== '1') {
    throw new ConfigError('allowInsecure (plain http) is only honoured for local/development hosts; set WEBFORMS_MCP_ALLOW_INSECURE_TLS=1 to override.');
  }
  const baseUrl = validateBaseUrl(parsed.baseUrl as string, parsed.allowInsecure === true);
  const insecureTls = parsed.insecureTls === true;
  if (insecureTls && !new RegExp(`^https://${DEV_HOST}$`).test(baseUrl) && process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS !== '1') {
    throw new ConfigError('insecureTls is only honoured for local/development hosts; set WEBFORMS_MCP_ALLOW_INSECURE_TLS=1 to override.');
  }
  const confirmActions = parsed.confirmActions !== false;
  if (!confirmActions && !new RegExp(`^https?://${DEV_HOST}$`).test(baseUrl)) {
    throw new ConfigError('confirmActions: false is only honoured for local/development hosts.');
  }
  return {
    baseUrl,
    consumerKey: parsed.consumerKey as string,
    consumerSecret: parsed.consumerSecret as string,
    accessToken: parsed.accessToken as string,
    accessTokenSecret: parsed.accessTokenSecret as string,
    insecureTls,
    journalKey: parsed.journalKey as string,
    label: sanitizeLabel(parsed.label),
    confirmActions,
  };
};

/**
 * Exclusive create unless --overwrite. The bytes go to a sibling 0600 temp file that is fsynced and then
 * renamed over the target, so an interrupted write can never leave a truncated or half-written profile.
 */
export const saveConfig = async (config: Config & { allowInsecure?: boolean }, path = credentialsPath(), overwrite = false): Promise<void> => {
  const dir = dirname(path);
  await ensurePrivateDir(dir);
  if (!overwrite) {
    // Claim the name first, so two setups cannot both think they created it.
    const claim = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    await claim.close();
  }
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8');
    await handle.datasync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, path);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
  const dirHandle = await fs.open(dir, fsConstants.O_RDONLY);
  try {
    await dirHandle.datasync();
  } catch {
    // Directory fsync is unsupported on some platforms; the rename itself is still atomic.
  } finally {
    await dirHandle.close();
  }
};
