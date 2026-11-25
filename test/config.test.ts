import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, siteKeyFromPath, validateBaseUrl } from '../src/config.js';

describe('config', () => {
  it('insists on https except localhost', () => {
    expect(validateBaseUrl('https://shop.example/')).toBe('https://shop.example');
    expect(validateBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => validateBaseUrl('http://shop.example')).toThrow(/https/);
    expect(validateBaseUrl('http://shop.example', true)).toBe('http://shop.example');
    expect(() => validateBaseUrl('https://u:p@shop.example')).toThrow(/credentials/);
  });
  it('refuses group/world-readable credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const path = join(dir, 'credentials.json');
    writeFileSync(path, JSON.stringify({ baseUrl: 'https://s.example', consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', journalKey: 'e' }));
    chmodSync(path, 0o644);
    await expect(loadConfig(path)).rejects.toThrow(/readable by other users/);
    chmodSync(path, 0o600);
    expect((await loadConfig(path)).baseUrl).toBe('https://s.example');
  });
  it('lets only a development store run actions without asking a person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const load = (fields: Record<string, unknown>) => {
      const path = join(dir, 'credentials.json');
      writeFileSync(path, JSON.stringify({ consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', journalKey: 'e', ...fields }), { mode: 0o600 });
      return loadConfig(path);
    };
    expect((await load({ baseUrl: 'https://s.example' })).confirmActions).toBe(true);
    expect((await load({ baseUrl: 'https://shop.test', confirmActions: false })).confirmActions).toBe(false);
    expect((await load({ baseUrl: 'http://localhost:8080', confirmActions: false })).confirmActions).toBe(false);
    await expect(load({ baseUrl: 'https://s.example', confirmActions: false })).rejects.toThrow(/only honoured for local\/development hosts/);
    await expect(load({ baseUrl: 'https://s.example.test.evil.com', confirmActions: false })).rejects.toThrow(/only honoured/);
    expect((await load({ baseUrl: 'https://s.example', confirmActions: 'false' })).confirmActions, 'only a literal false switches it off').toBe(true);
  });
});

describe('site key derivation', () => {
  it('derives default and named keys from the canonical file names', () => {
    expect(siteKeyFromPath('/home/u/.webforms-mcp/credentials.json')).toBe('default');
    expect(siteKeyFromPath('/home/u/.webforms-mcp/credentials.acme-prod.json')).toBe('acme-prod');
    expect(siteKeyFromPath('credentials.stage.json')).toBe('stage');
  });
  it('refuses a name it cannot derive a key from', () => {
    expect(() => siteKeyFromPath('/tmp/my-creds.json')).toThrow(/SITE_KEY_UNDERIVABLE/);
    expect(() => siteKeyFromPath('/tmp/credentials.NotAKey.json')).toThrow(/SITE_KEY_UNDERIVABLE/);
    expect(() => siteKeyFromPath('/tmp/credentials.default.json')).toThrow(/SITE_KEY_UNDERIVABLE/);
  });

  it('a missing named profile is set up under that name, not as the default store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-missing-'));
    await expect(loadConfig(join(dir, 'credentials.nope.json'))).rejects.toThrow(/setup --profile nope$/);
    await expect(loadConfig(join(dir, 'credentials.json'))).rejects.toThrow(/setup$/);
  });
});
