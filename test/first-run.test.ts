import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup, probe, failure } from '../src/setup.js';
import { VERSION } from '../src/package.js';

/** What a person sees the first time: help, typos, a second setup, an unreadable key file, a store without the API. */
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'index.ts'), ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000, input: '',
  });

const encode = (payload: Record<string, string>): string => 'wf1_' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const stdoutOf = async (run: () => Promise<void>): Promise<string> => {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true; });
  try { await run(); } finally { spy.mockRestore(); }
  return written.join('');
};

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  process.exitCode = 0;
  delete process.env.WEBFORMS_MCP_HOME;
});

describe('the command line', () => {
  const home = mkdtempSync(join(tmpdir(), 'wfmcp-first-run-'));
  it('--help and --version answer without a store and without starting the server', () => {
    const help = cli(['--help'], { WEBFORMS_MCP_HOME: home });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage:[\s\S]*setup[\s\S]*probe/);
    const version = cli(['--version'], { WEBFORMS_MCP_HOME: home });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
  });

  it('an unknown command or option is refused instead of starting the server', () => {
    for (const args of [['frobnicate'], ['--frob']]) {
      const run = cli(args, { WEBFORMS_MCP_HOME: home });
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/Unknown (command|option)[\s\S]*Usage:/);
    }
  });

  it('setup --help lists the options and asks for nothing', () => {
    const run = cli(['setup', '--help'], { WEBFORMS_MCP_HOME: home });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/--overwrite/);
    expect(run.stdout).not.toMatch(/Store base URL/);
  });

  it('a command after --profile is still that command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-first-run-profile-'));
    writeFileSync(join(dir, 'credentials.shop.json'), JSON.stringify({ baseUrl: 'https://shop.example', consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', journalKey: 'k'.repeat(64) }), { mode: 0o600 });
    const run = cli(['--profile', 'shop', 'sites'], { WEBFORMS_MCP_HOME: dir });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Dedicated process|Shared process/);
  });

  it('setup after --profile keeps its own options', () => {
    const run = cli(['--profile', 'shop', 'setup', '--help'], { WEBFORMS_MCP_HOME: home });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/--overwrite/);
  });

  it('says why a key file was not read, instead of only "run setup"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-first-run-perm-'));
    const file = join(dir, 'credentials.shop.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    const run = cli([], { WEBFORMS_MCP_HOME: dir });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/skipped credentials\.shop\.json: UNREADABLE - .*chmod 600/);
    expect(run.stderr).toMatch(/could not be read; fix them rather than running setup again/);
  });
});

describe('setup', () => {
  it('a second setup of the same profile stops before asking for secrets, naming --overwrite', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wfmcp-first-run-again-'));
    process.env.WEBFORMS_MCP_HOME = home;
    writeFileSync(join(home, 'credentials.json'), '{}', { mode: 0o600 });
    const out = await stdoutOf(() => runSetup(['--from', encode({ u: 'https://shop.example', k: 'ck', s: 'cs', t: 'at', ts: 'ats' })]));
    expect(out).toMatch(/already set up .*--overwrite/);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to skip certificate checks for a store that is not a local host', async () => {
    process.env.WEBFORMS_MCP_HOME = mkdtempSync(join(tmpdir(), 'wfmcp-first-run-tls-'));
    const saved = process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS;
    delete process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS;
    try {
      const out = await stdoutOf(() => runSetup(['--insecure-tls', '--from', encode({ u: 'https://shop.example', k: 'ck', s: 'cs', t: 'at', ts: 'ats' })]));
      expect(out).toMatch(/--insecure-tls is for development stores, and shop\.example is not a local host/);
    } finally {
      if (saved !== undefined) process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS = saved;
    }
  });

  it('a bare argument (perhaps a pasted connection string) is refused without being echoed', async () => {
    const out = await stdoutOf(() => runSetup(['wf1_SECRETSECRET']));
    expect(out).toMatch(/Unknown setup argument \(not shown\)/);
    expect(out).not.toContain('SECRET');
    const flagged = await stdoutOf(() => runSetup(['--overwrite=1']));
    expect(flagged).toMatch(/Unknown setup option "--overwrite"/);
  });

  it('an unknown option is refused before anything is asked', async () => {
    const out = await stdoutOf(() => runSetup(['--overwite']));
    expect(out).toMatch(/Unknown setup option "--overwite"/);
    expect(process.exitCode).toBe(2);
  });
});

describe('probe', () => {
  it('a base URL without the API reads as such, not as "re-list and pick an existing id"', async () => {
    server = createServer((_req, res) => res.writeHead(404, { 'content-type': 'text/html' }).end('<html>Not Found</html>'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    let message = '';
    try {
      await stdoutOf(() => probe({ baseUrl: base, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, journalKey: 'k' }));
    } catch (e) { message = failure(e); }
    expect(message).toMatch(/^API_NOT_FOUND \(HTTP 404\): .* has no WebForms API .*module:status MageMe_WebFormsApi/);
    expect(message).not.toMatch(/Re-list/);
  });
});
