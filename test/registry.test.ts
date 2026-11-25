import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteRegistry } from '../src/registry.js';

const creds = (baseUrl: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  baseUrl, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats',
  journalKey: 'jk', ...extra,
});

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wfmcp-reg-'));
  process.env.WEBFORMS_MCP_HOME = dir;
  return dir;
};

const savedHome = process.env.WEBFORMS_MCP_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.WEBFORMS_MCP_HOME;
  else process.env.WEBFORMS_MCP_HOME = savedHome;
});

describe('site registry', () => {
  it('discovers the top level and reports the roster complete', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.json'), creds('https://a.example'), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.acme.json'), creds('https://b.example', { label: 'Acme' }), { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'shared' });
    expect(registry.keys().sort()).toEqual(['acme', 'default']);
    expect(registry.get('acme')!.label).toBe('Acme');
    expect(registry.get('default')!.label).toBe('a.example');
    expect(registry.complete).toBe(true);
  });

  it('never opens a file under isolated/, so a broken one cannot break the start', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.json'), creds('https://a.example'), { mode: 0o600 });
    mkdirSync(join(dir, 'isolated'));
    writeFileSync(join(dir, 'isolated', 'credentials.big.json'), '{ this is not json', { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'shared' });
    expect(registry.keys()).toEqual(['default']);
    expect(registry.isolatedKeys).toEqual(['big']);
    expect(registry.complete).toBe(true);
    expect(registry.find('big')).toEqual({ ok: false, reason: 'ISOLATED' });
  });

  it('skips what it cannot read and marks the roster incomplete', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.json'), creds('https://a.example'), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.broken.json'), '{ nope', { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.open.json'), creds('https://c.example'), { mode: 0o600 });
    chmodSync(join(dir, 'credentials.open.json'), 0o644);
    writeFileSync(join(dir, 'credentials.default.json'), creds('https://d.example'), { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'shared' });
    expect(registry.keys()).toEqual(['default']);
    expect(registry.complete).toBe(false);
    expect(registry.diagnostics.map((d) => d.reason).sort()).toEqual(['INVALID', 'KEY_RESERVED', 'UNREADABLE']);
  });

  it('refuses to start when a key exists both at the top level and isolated', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.acme.json'), creds('https://a.example'), { mode: 0o600 });
    mkdirSync(join(dir, 'isolated'));
    writeFileSync(join(dir, 'isolated', 'credentials.acme.json'), creds('https://a.example'), { mode: 0o600 });
    await expect(SiteRegistry.discover({ kind: 'shared' })).rejects.toThrow(/SITE_KEY_CONFLICT/);
  });

  it('resolves a host alias only when it is unambiguous', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.a.json'), creds('https://same.example'), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.b.json'), creds('https://same.example/'), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.c.json'), creds('https://other.example'), { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'shared' });
    expect(registry.find('other.example')).toMatchObject({ ok: true });
    expect(registry.find('same.example')).toMatchObject({ ok: false, reason: 'AMBIGUOUS', candidates: ['a', 'b'] });
  });

  it('ignores a label that is not usable and falls back to the host', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.json'), creds('https://a.example', { label: '   ' }), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.b.json'), creds('https://b.example', { label: 42 }), { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'shared' });
    expect(registry.get('default')!.label).toBe('a.example');
    expect(registry.get('b')!.label).toBe('b.example');
  });

  it('in dedicated mode holds exactly the named site and nothing else', async () => {
    const dir = home();
    writeFileSync(join(dir, 'credentials.json'), creds('https://a.example'), { mode: 0o600 });
    writeFileSync(join(dir, 'credentials.other.json'), creds('https://b.example'), { mode: 0o600 });
    const registry = await SiteRegistry.discover({ kind: 'dedicated', credentialsPath: join(dir, 'credentials.other.json') });
    expect(registry.keys()).toEqual(['other']);
    expect(registry.complete).toBe(true);
  });
});
