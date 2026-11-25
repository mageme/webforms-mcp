#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, configDir } from './config.js';
import { runSetup, probe } from './setup.js';
import { buildServerFrom } from './server.js';
import { resolveMode } from './mode.js';
import { SiteRegistry } from './registry.js';
import { SiteContextFactory } from './context.js';
import { formatSites } from './cli.js';
import { RUN, VERSION } from './package.js';
import { failure } from './setup.js';

const log = (line: string): void => {
  process.stderr.write(`[webforms-mcp] ${line}\n`);
};

/** What the process found, so a person can see which stores it picked up before trusting it with any. */
const announce = (registry: SiteRegistry): void => {
  const sites = registry.keys().map((key) => `${key} (${registry.get(key)!.host})`);
  log(`stores: ${sites.join(', ') || 'none'}`);
  for (const key of registry.keys()) {
    if (registry.get(key)!.config.confirmActions === false) log(`confirmations OFF for ${key}: its irreversible actions run without asking a person`);
  }
  if (registry.isolatedKeys.length > 0) {
    log(`isolated, not served here: ${registry.isolatedKeys.join(', ')}`);
  }
  for (const { file, reason, detail } of registry.diagnostics) {
    log(`skipped ${file}: ${reason}${detail ? ` - ${detail}` : ''}`);
  }
};

const USAGE = `Usage:
  ${RUN} [--profile <name>]          run the MCP server (started by Claude Code / Claude Desktop)
  ${RUN} setup [options]             connect a store; ${RUN} setup --help lists the options
  ${RUN} sites [--profile <name>]    list the configured stores (contacts none)
  ${RUN} probe [--profile <name>]    check each configured store: connection, API version, permissions
  ${RUN} --help | --version
`;

const COMMANDS = ['setup', 'sites', 'probe'];

/** An argument is echoed only when it reads like a word: a mistyped command line can hold a connection string. */
const shownArg = (a: string): string => (/^-{0,2}[a-z][a-z-]{0,30}$/.test(a) ? `"${a}"` : '(argument not shown)');

/** The command and the server's own flags; anything else is refused rather than silently starting the server. */
const parseArgs = (argv: string[]): { command?: string; rest: string[] } => {
  let first = -1;
  for (let i = 0; i < argv.length && first < 0; i++) {
    if (argv[i] === '--profile') i++;
    else if (!argv[i].startsWith('-')) first = i;
  }
  // setup parses its own options, wherever --profile stands
  if (first >= 0 && argv[first] === 'setup') return { command: 'setup', rest: [...argv.slice(0, first), ...argv.slice(first + 1)] };
  let command: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') { rest.push(a, argv[++i] ?? ''); continue; }
    if (a.startsWith('--profile=')) { rest.push(a); continue; }
    if (a.startsWith('-')) throw new ConfigError(`Unknown option ${shownArg(a.split('=')[0])}${a.includes('=') ? ' (its value is not shown)' : ''}.\n${USAGE}`);
    if (command !== undefined || !COMMANDS.includes(a)) throw new ConfigError(`Unknown command ${shownArg(a)}.\n${USAGE}`);
    command = a;
  }
  return { command, rest };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if ((argv.includes('--help') || argv.includes('-h')) && !argv.includes('setup')) {
    process.stdout.write(USAGE);
    return;
  }
  const { command, rest } = parseArgs(argv);
  if (command === 'setup') {
    await runSetup(rest);
    return;
  }
  const mode = resolveMode(rest);
  const registry = await SiteRegistry.discover(mode);
  if (command === 'sites') {
    process.stdout.write(formatSites(registry, mode.kind));
    return;
  }
  if (registry.size === 0) {
    announce(registry);
    const isolated = registry.isolatedKeys.length > 0
      ? ` Every configured profile is isolated (${registry.isolatedKeys.join(', ')}); start one with --profile <name>.`
      : '';
    const unread = registry.diagnostics.length > 0 ? ' The files listed above could not be read; fix them rather than running setup again.' : ` Run: ${RUN} setup`;
    throw new ConfigError(`No stores configured in ${configDir()}.${isolated}${unread}`);
  }
  if (command === 'probe') {
    let failed = 0;
    for (const key of registry.keys()) {
      process.stdout.write(`\n${key} (${registry.get(key)!.host}):\n`);
      try {
        await probe(registry.get(key)!.config);
      } catch (e) {
        failed++;
        process.stdout.write(`  failed: ${failure(e)}\n`);
      }
    }
    if (failed > 0) process.exitCode = 1;
    return;
  }
  announce(registry);
  const factory = new SiteContextFactory(registry, mode.kind, log);
  await buildServerFrom(factory).connect(new StdioServerTransport());
};

main().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`fatal: ${failure(e)}\n`);
  process.exit(1);
});
