import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { credentialsPath, loadConfig, readFlag, resolveCredentialsPath, saveConfig, validateProfile } from '../src/config.js';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decodeConnectionString, probe } from '../src/setup.js';
import type { Config } from '../src/config.js';

/** Builds a connection string the way bin/magento webforms:api:connect does. */
const encode = (payload: Record<string, string>): string =>
  'wf1_' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const GOOD = { u: 'https://shop.example', k: 'ck', s: 'cs', t: 'at', ts: 'ats' };

const ENV_KEYS = ['WEBFORMS_MCP_HOME', 'WEBFORMS_MCP_PROFILE', 'WEBFORMS_MCP_CREDENTIALS_FILE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('connection string', () => {
  it('carries the store URL and all four OAuth values', () => {
    expect(decodeConnectionString(encode(GOOD))).toEqual({
      baseUrl: 'https://shop.example',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 'at',
      accessTokenSecret: 'ats',
    });
  });

  it('tolerates the quotes and whitespace a copy-paste brings along', () => {
    expect(decodeConnectionString(`  "${encode(GOOD)}"  `).consumerKey).toBe('ck');
  });

  it('names what is missing instead of failing obscurely', () => {
    const { s, ...withoutSecret } = GOOD;
    expect(() => decodeConnectionString(encode(withoutSecret as Record<string, string>))).toThrow(/consumer secret/);
    expect(() => decodeConnectionString(encode({ ...GOOD, t: '' }))).toThrow(/access token/);
  });

  it('refuses an implausibly large input before parsing it', () => {
    expect(() => decodeConnectionString('wf1_' + 'A'.repeat(5000))).toThrow(/at most 4096 characters/);
    expect(() => decodeConnectionString(encode({ ...GOOD, k: 'x'.repeat(600) }))).toThrow(/implausibly long/);
  });

  it('refuses valid JSON that is not a credential set', () => {
    for (const body of ['null', '[]', '"text"', '42']) {
      expect(() => decodeConnectionString('wf1_' + Buffer.from(body, 'utf8').toString('base64url')))
        .toThrow(/does not carry a credential set|lacks/);
    }
  });

  it('rejects anything that is not one of ours', () => {
    expect(() => decodeConnectionString('hunter2')).toThrow(/starts with "wf1_"/);
    expect(() => decodeConnectionString('wf1_not base64!')).toThrow(/cannot come from one/);
    expect(() => decodeConnectionString('wf1_' + Buffer.from('{oops', 'utf8').toString('base64url'))).toThrow(/damaged/);
  });

  it('holds the store URL to the same rule as an interactive setup', () => {
    expect(() => decodeConnectionString(encode({ ...GOOD, u: 'http://shop.example' }))).toThrow(/https/);
    expect(decodeConnectionString(encode({ ...GOOD, u: 'http://shop.example' }), true).baseUrl).toBe('http://shop.example');
    expect(decodeConnectionString(encode({ ...GOOD, u: 'http://localhost' })).baseUrl).toBe('http://localhost');
  });
});

describe('profiles', () => {
  it('turns a profile into a file beside the default one', () => {
    process.env.WEBFORMS_MCP_HOME = '/tmp/wfmcp-home';
    expect(credentialsPath()).toBe(join('/tmp/wfmcp-home', 'credentials.json'));
    expect(credentialsPath('stage')).toBe(join('/tmp/wfmcp-home', 'credentials.stage.json'));
  });

  it('refuses a profile that could escape the config directory', () => {
    expect(() => validateProfile('../../etc/passwd')).toThrow(/1-32 characters/);
    expect(() => validateProfile('stage/../prod')).toThrow(/1-32 characters/);
    expect(() => validateProfile('')).toThrow(/1-32 characters/);
    expect(() => validateProfile('Stage')).toThrow(/1-32 characters/);
    expect(validateProfile('stage-2_eu')).toBe('stage-2_eu');
  });

  it('picks the most specific source: flag, then explicit file, then env profile', () => {
    process.env.WEBFORMS_MCP_HOME = '/tmp/wfmcp-home';
    process.env.WEBFORMS_MCP_CREDENTIALS_FILE = '/tmp/explicit.json';
    process.env.WEBFORMS_MCP_PROFILE = 'fromenv';
    expect(resolveCredentialsPath(['--profile', 'flag'])).toBe(join('/tmp/wfmcp-home', 'credentials.flag.json'));
    expect(resolveCredentialsPath(['--profile=flag'])).toBe(join('/tmp/wfmcp-home', 'credentials.flag.json'));
    expect(resolveCredentialsPath([])).toBe('/tmp/explicit.json');
    delete process.env.WEBFORMS_MCP_CREDENTIALS_FILE;
    expect(resolveCredentialsPath([])).toBe(join('/tmp/wfmcp-home', 'credentials.fromenv.json'));
    delete process.env.WEBFORMS_MCP_PROFILE;
    expect(resolveCredentialsPath([])).toBe(join('/tmp/wfmcp-home', 'credentials.json'));
  });

  it('says so when --profile is given without a name', () => {
    expect(() => resolveCredentialsPath(['--profile'])).toThrow(/needs a name/);
    expect(() => resolveCredentialsPath(['--profile', '--insecure-tls'])).toThrow(/needs a name/);
  });

  it('reads both flag spellings and reports absence', () => {
    expect(readFlag(['--from', 'wf1_x'], '--from')).toBe('wf1_x');
    expect(readFlag(['--from=wf1_x'], '--from')).toBe('wf1_x');
    expect(readFlag(['--from'], '--from')).toBe('');
    expect(readFlag(['--from='], '--from')).toBe('');
    expect(readFlag([], '--from')).toBeUndefined();
  });
});

describe('probe', () => {
  const start = async (capabilities: Record<string, unknown>, seen: string[] = []): Promise<{ config: Config; stop: () => void; seen: string[] }> => {
    const http = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes('/capabilities')) {
        res.end(JSON.stringify(capabilities));
        return;
      }
      if ((req.url ?? '').includes('/statuses')) {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: 'The integration lacks the "results_view" permission.', parameters: { code: 'ACTOR_NOT_ALLOWED' } }));
        return;
      }
      res.end(JSON.stringify({ items: [], total_count: 0 }));
    });
    await new Promise<void>((ready) => http.listen(0, '127.0.0.1', ready));
    const { port } = http.address() as AddressInfo;
    return {
      config: {
        baseUrl: `http://127.0.0.1:${port}`,
        consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessTokenSecret: 'ts',
        insecureTls: false, journalKey: 'j',
      },
      stop: () => http.close(),
      seen,
    };
  };

  const capture = async (run: () => Promise<void>): Promise<string> => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: string) => { chunks.push(String(chunk)); return true; };
    try { await run(); } finally { (process.stdout as unknown as { write: unknown }).write = write; }
    return chunks.join('');
  };

  const CAPS = { api_version: '1', document_schema_version: '4.0', field_types: ['text', 'email'] };

  it('reports every permission the store grants, in one request', async () => {
    const { config, stop, seen } = await start({
      ...CAPS,
      features_json: JSON.stringify({ permissions: { forms_view: true, forms_create: false, forms_edit: true, results_view: false, results_pii_read: false, results_edit: false, results_reply: false, results_export: false, attachments_read: false } }),
    });
    try {
      const out = await capture(() => probe(config));
      expect(out).toContain('2 of 9');
      expect(out).toContain('Form access: not reported\n');
      expect(out).toMatch(/forms_view\s+granted/);
      expect(out).toMatch(/results_pii_read\s+-/);
      expect(seen.filter((u) => !u.includes('/capabilities'))).toEqual([]);
    } finally { stop(); }
  });

  it('lists every permission the store reports, including ones this client does not know by name', async () => {
    const leaves = ['forms_view', 'forms_create', 'forms_edit', 'results_view', 'results_pii_read', 'results_pii_direct', 'results_edit', 'results_reply', 'results_export', 'attachments_read', 'results_import', 'sales_orders_view'];
    const { config, stop } = await start({
      ...CAPS,
      features_json: JSON.stringify({ permissions: Object.fromEntries(leaves.map((p) => [p, ['forms_edit', 'results_import'].includes(p)])) }),
    });
    try {
      const out = await capture(() => probe(config));
      expect(out).toContain('2 of 12');
      expect(out).toMatch(/forms_edit\s+granted/);
      expect(out).toMatch(/results_import\s+granted/);
      expect(out).toMatch(/results_pii_direct\s+-/);
    } finally { stop(); }
  });

  it('tells which forms the integration reaches', async () => {
    const { config, stop } = await start({ ...CAPS, features_json: JSON.stringify({ permissions: { forms_view: true }, form_scope: 'none' }) });
    try {
      expect(await capture(() => probe(config))).toContain('Form access: No forms\n');
    } finally { stop(); }
  });

  it('says plainly when the integration was granted nothing', async () => {
    const { config, stop } = await start({
      ...CAPS,
      features_json: JSON.stringify({ permissions: Object.fromEntries(['forms_view', 'results_view'].map((p) => [p, false])) }),
    });
    try {
      expect(await capture(() => probe(config))).toContain('None granted');
    } finally { stop(); }
  });

  it('falls back to probing routes against a store that does not report permissions', async () => {
    const { config, stop, seen } = await start({ ...CAPS, features_json: JSON.stringify({ pii_grants: false }) });
    try {
      const out = await capture(() => probe(config));
      expect(out).toMatch(/forms_view\s+granted/);
      expect(out).toContain('ACTOR_NOT_ALLOWED');
      expect(seen.some((u) => u.includes('/statuses'))).toBe(true);
    } finally { stop(); }
  });
});

describe('saving credentials', () => {
  it('leaves the previous profile untouched when the write cannot complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-save-'));
    const path = join(dir, 'credentials.json');
    const good: Config & { allowInsecure?: boolean } = {
      baseUrl: 'https://shop.example', consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessTokenSecret: 'ts',
      insecureTls: false, journalKey: 'j',
    };
    await saveConfig(good, path);
    await expect(saveConfig({ ...good, consumerKey: 'other' }, path)).rejects.toThrow();
    expect((await loadConfig(path)).consumerKey).toBe('k', 'an exclusive create never clobbers a live profile');

    await saveConfig({ ...good, consumerKey: 'replaced' }, path, true);
    expect((await loadConfig(path)).consumerKey).toBe('replaced');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('plain http from the credentials file', () => {
  const write = (baseUrl: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-http-')), 'credentials.json');
    writeFileSync(path, JSON.stringify({ baseUrl, consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessTokenSecret: 'ts', allowInsecure: true, journalKey: 'j' }), { mode: 0o600 });
    return path;
  };
  it('is honoured for a local/development host only', async () => {
    const saved = process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS;
    delete process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS;
    try {
      await expect(loadConfig(write('http://shop.example'))).rejects.toThrow(/allowInsecure \(plain http\) is only honoured for local\/development hosts/);
      expect((await loadConfig(write('http://shop.test'))).baseUrl).toBe('http://shop.test');
      process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS = '1';
      expect((await loadConfig(write('http://shop.example'))).baseUrl).toBe('http://shop.example');
    } finally {
      if (saved === undefined) delete process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS; else process.env.WEBFORMS_MCP_ALLOW_INSECURE_TLS = saved;
    }
  });
});

describe('flag parsing', () => {
  it('stops at a bare -- so later words stay data', () => {
    expect(readFlag(['--', '--profile', 'stage'], '--profile')).toBeUndefined();
  });

  it('takes the first spelling, left to right', () => {
    expect(readFlag(['--profile=first', '--profile', 'second'], '--profile')).toBe('first');
    expect(readFlag(['--profile', 'first', '--profile=second'], '--profile')).toBe('first');
  });

  it('does not confuse a longer flag with the same prefix', () => {
    expect(readFlag(['--from-stdin'], '--from')).toBeUndefined();
  });
});
