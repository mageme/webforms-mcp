import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedCredentialsPath, resolveMode } from '../src/mode.js';
import { runSetup } from '../src/setup.js';
import { credentialsPath } from '../src/config.js';

const ENV_KEYS = ['WEBFORMS_MCP_PROFILE', 'WEBFORMS_MCP_CREDENTIALS_FILE', 'WEBFORMS_MCP_HOME'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('runtime mode', () => {
  it('is shared when nothing selects a profile', () => {
    expect(resolveMode([])).toEqual({ kind: 'shared' });
  });

  it('is dedicated for --profile, including default', () => {
    expect(resolveMode(['--profile', 'stage'])).toEqual({ kind: 'dedicated', credentialsPath: credentialsPath('stage') });
    expect(resolveMode(['--profile', 'default'])).toEqual({ kind: 'dedicated', credentialsPath: credentialsPath() });
  });

  it('is dedicated for the environment variables, the flag winning', () => {
    process.env.WEBFORMS_MCP_PROFILE = 'envprofile';
    expect(resolveMode([])).toEqual({ kind: 'dedicated', credentialsPath: credentialsPath('envprofile') });
    expect(resolveMode(['--profile', 'flag'])).toEqual({ kind: 'dedicated', credentialsPath: credentialsPath('flag') });
  });

  it('lets an explicit credentials file win over a profile in the environment', () => {
    process.env.WEBFORMS_MCP_PROFILE = 'envprofile';
    process.env.WEBFORMS_MCP_CREDENTIALS_FILE = '/tmp/credentials.custom.json';
    expect(resolveMode([])).toEqual({ kind: 'dedicated', credentialsPath: '/tmp/credentials.custom.json' });
  });

  it('refuses --profile without a name', () => {
    expect(() => resolveMode(['--profile'])).toThrow(/needs a name/);
  });

  it('finds a profile that setup --isolated wrote, by flag and by environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'wfmcp-mode-'));
    process.env.WEBFORMS_MCP_HOME = home;
    try {
      mkdirSync(join(home, 'isolated'));
      writeFileSync(isolatedCredentialsPath('big'), '{}');
      expect(isolatedCredentialsPath('big')).toBe(join(home, 'isolated', 'credentials.big.json'));
      expect(resolveMode(['--profile', 'big'])).toEqual({ kind: 'dedicated', credentialsPath: join(home, 'isolated', 'credentials.big.json') });
      process.env.WEBFORMS_MCP_PROFILE = 'big';
      expect(resolveMode([])).toEqual({ kind: 'dedicated', credentialsPath: join(home, 'isolated', 'credentials.big.json') });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('names the shared file when there is none at all, and refuses a name taken in both places', () => {
    const home = mkdtempSync(join(tmpdir(), 'wfmcp-mode-'));
    process.env.WEBFORMS_MCP_HOME = home;
    try {
      expect(resolveMode(['--profile', 'nowhere'])).toEqual({ kind: 'dedicated', credentialsPath: join(home, 'credentials.nowhere.json') });
      mkdirSync(join(home, 'isolated'));
      writeFileSync(join(home, 'credentials.both.json'), '{}');
      writeFileSync(isolatedCredentialsPath('both'), '{}');
      expect(() => resolveMode(['--profile', 'both'])).toThrow(/SITE_KEY_CONFLICT/);
      process.env.WEBFORMS_MCP_PROFILE = 'both';
      expect(() => resolveMode([])).toThrow(/SITE_KEY_CONFLICT/);
      writeFileSync(join(home, 'credentials.json'), '{}');
      expect(resolveMode(['--profile', 'default'])).toEqual({ kind: 'dedicated', credentialsPath: join(home, 'credentials.json') });
      writeFileSync(isolatedCredentialsPath(), '{}');
      expect(() => resolveMode(['--profile', 'default'])).toThrow(/SITE_KEY_CONFLICT: "default"/);
      process.env.WEBFORMS_MCP_PROFILE = 'default';
      expect(() => resolveMode([])).toThrow(/SITE_KEY_CONFLICT: "default"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup refuses to give a profile a second home before asking for anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wfmcp-mode-'));
    process.env.WEBFORMS_MCP_HOME = home;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true; });
    try {
      writeFileSync(join(home, 'credentials.big.json'), '{}');
      await runSetup(['--profile', 'big', '--isolated', '--from', 'wf1_never_read']);
      mkdirSync(join(home, 'isolated'));
      writeFileSync(isolatedCredentialsPath('small'), '{}');
      await runSetup(['--profile', 'small', '--from', 'wf1_never_read']);
      writeFileSync(isolatedCredentialsPath(), '{}');
      await runSetup(['--from', 'wf1_never_read']);
      rmSync(isolatedCredentialsPath());
      writeFileSync(join(home, 'credentials.json'), '{}');
      await runSetup(['--profile', 'default', '--isolated', '--from', 'wf1_never_read']);
    } finally {
      spy.mockRestore();
      process.exitCode = 0;
      rmSync(home, { recursive: true, force: true });
    }
    expect(written.filter((line) => /Setup failed: SITE_KEY_CONFLICT/.test(line))).toHaveLength(4);
    expect(written.join('')).not.toMatch(/connection string passed on the command line/);
  });
});
