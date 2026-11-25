import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.js';
import { formChanges, liveSettings } from '../src/approval.js';

/**
 * What a person approves must be what happens: the live settings a form switches on with, the real host of a
 * long URL, no line a remote or model string forged, every change counted, and the content of an import or an edit.
 */
const HIDDEN = `https://shop.example.com:${'a'.repeat(190)}@evil.example/thanks`;
const document31 = { name: 'Quote', redirect_url: HIDDEN, is_publish_results: 1, captcha_mode: 'default', meta_title: 'Quote us', is_cleanup_enabled: 0, store_data: { de: { is_cleanup_enabled: '1', cleanup_period: '1' } } };

describe('what the person reads about a change (N2, N3, N5)', () => {
  it('names the real host of a URL value and its user-name part, however long the value', () => {
    const text = formChanges([{ key: 'redirect_url', label: 'Redirect URL', write: 'confirm', before: '', after: HIDDEN }]);
    expect(text).toContain('goes to evil.example');
    expect(text).toMatch(/only a user name/);
  });

  it('finds the host the way a browser does: leading space, a break inside the host, protocol-relative, backslashes', () => {
    for (const url of [` ${HIDDEN}`, 'https://shop.example.com:aaaa@evil.exa\nmple/x', `//shop.example.com:${'a'.repeat(190)}@evil.example/`, `https:\\\\shop.example.com:${'a'.repeat(190)}@evil.example/`]) {
      expect(formChanges([{ key: 'redirect_url', label: 'Redirect URL', before: '', after: url }]), url).toContain('goes to evil.example');
    }
    expect(formChanges([{ key: 'name', label: 'Name', before: 'Contact', after: 'Contact us' }])).not.toContain('goes to');
  });

  it('says what a value runs when a browser reads it as a script or data link, line breaks and all (m-1)', () => {
    for (const url of ['java\nscript:alert(1)', ' JavaScript:alert(1)', 'javascript: alert(1)', 'data:text/html,<b>x</b>', 'vb\tscript:x']) {
      expect(formChanges([{ key: 'redirect_url', label: 'Redirect URL', before: '', after: url }]), url).toMatch(/a browser opens this as a (javascript|data|vbscript): link/);
    }
    for (const plain of ['Note: call back', 'Data: kept 30 days', 'data: personal']) {
      expect(formChanges([{ key: 'name', label: 'Name', before: '', after: plain }]), plain).not.toContain('a browser opens');
    }
  });

  it('strips line separators, the next-line control and direction overrides from remote text', () => {
    const text = formChanges([{ key: 'k', label: 'A\u2028Fake line\u0085next\u202Emoc.live\u2060\u00AD\u3164\uFE0F\u{E0041}', before: 'x', after: 'y' }]);
    expect(text).not.toMatch(/[\u2028\u2029\u0085\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\u00AD\u3164\uFE0F]|\u{E0041}/u);
  });

  it('says how many changes did not fit and puts the ones with an outside effect first', () => {
    const changes = [
      ...Array.from({ length: 30 }, (_, n) => ({ key: `access_${n}`, label: `Setting ${n}`, before: 'x'.repeat(150), after: 'y'.repeat(150) })),
      { key: 'redirect_url', label: 'Redirect URL', before: '', after: 'https://evil.example/' },
      { key: 'on_load_script', label: 'On Load Script', changed: true, length: { before: 0, after: 40 } },
    ];
    const text = formChanges(changes);
    expect(text).toContain('evil.example');
    expect(text).toContain('On Load Script');
    expect(text).toMatch(/and \d+ more changes? not shown/);
  });
});

describe('liveSettings mirrors the store\'s live_settings (N1)', () => {
  it('lists the set confirm-class keys with their values, per store view, and skips unset and plain ones', () => {
    const text = liveSettings(document31);
    expect(text).toContain('redirect_url');
    expect(text).toContain('goes to evil.example');
    expect(text).toContain('is_publish_results: 1');
    expect(text).toMatch(/store view de: is_cleanup_enabled: 1/);
    expect(text).not.toContain('captcha_mode');
    expect(text).not.toContain('meta_title');
  });
  it('names scripts, the export\'s group codes, and ranks across store views so a view\'s redirect is not hidden', () => {
    const doc = { on_load_script: 'alert(1)', access_group_codes: ['wholesale'], success_text: 'x'.repeat(190),
      store_data: Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`s${n}`, { success_text: 'y'.repeat(190) }]).concat([['last', { redirect_url: 'https://evil.example/' }]])) };
    const text = liveSettings(doc);
    expect(text).toContain('on_load_script: a script of 8 characters');
    expect(text).toContain('access_group_codes');
    expect(text).toContain('store view last: redirect_url');
    expect(text).toMatch(/more settings not shown/);
  });
  it('says so when none is set', () => {
    expect(liveSettings({ name: 'x', captcha_mode: 'default' })).toMatch(/none of the settings/i);
  });
});

interface Seen { method: string; path: string; request: Record<string, unknown> }
let seen: Seen[] = [];
let dropReply = false;
const route = (method: string, path: string): readonly [number, unknown] => {
  if (method === 'GET' && path.endsWith('/forms/31/document')) return [200, { document_json: JSON.stringify(document31) }];
  if (method === 'GET' && path.endsWith('/forms/32/document')) return [500, { message: 'Internal Error' }];
  if (/\/forms\/3[12]\/commands\/activate$/.test(path)) return [200, { id: 31, is_active: true, revision: 3 }];
  if (method === 'POST' && path === '/V1/webforms/forms') return [200, { id: 40, is_active: true, revision: 1, live_settings: ['redirect_url'] }];
  if (method === 'GET' && path.endsWith('/imports/41')) return [200, { id: 41, form_id: 3, source_system: 'legacy', state: 'validated', row_count: 120, skipped_count: 1, rejected_count: 2 }];
  if (method === 'GET' && path.endsWith('/imports/42')) return [500, { message: 'Internal Error' }];
  if (/\/imports\/4[12]\/commands\/commit$/.test(path)) return [200, { id: 41, form_id: 3, state: 'queued', row_count: 120 }];
  if (path.endsWith('/results/7/commands/update-values')) return [200, { id: 7, form_id: 3, revision: 4 }];
  if (path.endsWith('/results/pii-grants')) return [200, { grant_id: 8, form_id: 3, expires_at: '2099-01-01 00:00:00' }];
  if (path.endsWith('/appearance')) return [200, { changed: true }];
  if (path.endsWith('/results/8/commands/prepare-reply')) return [200, { confirmation_token: 'tok-r8', expires_at: '2099-01-01 00:00:00', impact_json: JSON.stringify({ recipient: 'j***@example.com', body: 'Your refund is on its way.', result_revision: 3 }) }];
  if (path.endsWith('/results/8/commands/reply')) return [200, { id: 8, form_id: 3, revision: 4 }];
  return [200, { api_version: '1' }];
};

let http: Server;
let port = 0;
beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
      const request = ((raw ? JSON.parse(raw) : {}) as { request?: Record<string, unknown> }).request ?? {};
      if (!path.endsWith('/capabilities')) seen.push({ method: req.method ?? '', path, request });
      if (path.endsWith('/results/8/commands/reply') && dropReply) { req.socket.destroy(); return; }
      const [status, body] = route(req.method ?? '', path);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => http.close(() => r())));
beforeEach(() => { seen = []; });

const connect = async (asks: boolean) => {
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, journalKey: 'k'.repeat(64) } as never, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-q6-')), 'journal.jsonl'));
  const asked: string[] = [];
  const client = new Client({ name: 'q6', version: '0' }, asks ? { capabilities: { elicitation: {} } } : {});
  if (asks) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(String(request.params.message));
      return { action: 'accept', content: { proceed: true } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
  return { asked, call };
};
const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');
const writes = () => seen.filter((s) => s.method !== 'GET');
/** A line of the question that starts with what a model string tried to forge. */
const forged = (question: string, start: string) => question.split('\n').some((l) => l.trimStart().startsWith(start));

describe('activate_form and create_form show the live settings (N1)', () => {
  it('activate_form reads the form and asks with its live settings and the real host', async () => {
    const { asked, call } = await connect(true);
    const r = await call('activate_form', { form_id: 31 });
    expect(r.isError, text(r)).toBeFalsy();
    expect(asked[0]).toContain('goes to evil.example');
    expect(asked[0]).toContain('is_publish_results: 1');
    expect(asked[0]).toMatch(/store view de: is_cleanup_enabled: 1/);
    expect(asked[0]).not.toContain('meta_title');
  });

  it('says in the question that the settings could not be read', async () => {
    const { asked, call } = await connect(true);
    await call('activate_form', { form_id: 32 });
    expect(asked[0]).toMatch(/could not be read/);
  });

  it('without elicitation the refusal carries the same settings, and nothing is switched on', async () => {
    const { call } = await connect(false);
    const r = await call('activate_form', { form_id: 31 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('goes to evil.example');
    expect(text(r)).toContain('is_publish_results: 1');
    expect(writes()).toHaveLength(0);
  });

  it('create_form with activate asks with the document\'s live settings', async () => {
    const { asked, call } = await connect(true);
    const r = await call('create_form', { document: document31, activate: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(asked[0]).toContain('goes to evil.example');
    expect(asked[0]).toContain('is_publish_results: 1');
  });
});

describe('the other questions say what is approved (#9, N4)', () => {
  it('commit_import names the form and the counts of the import', async () => {
    const { asked, call } = await connect(true);
    await call('commit_import', { import_id: 41 });
    expect(asked[0]).toMatch(/form 3/);
    expect(asked[0]).toMatch(/120 rows/);
    expect(asked[0]).toMatch(/2 refused/);
    expect(asked[0]).toMatch(/1 skipped/);
  });

  it('commit_import says when the import could not be read', async () => {
    const { asked, call } = await connect(true);
    await call('commit_import', { import_id: 42 });
    expect(asked[0]).toMatch(/could not be read/);
  });

  it('update_submission_values shows the new values, and a key cannot forge a line', async () => {
    const { asked, call } = await connect(true);
    await call('update_submission_values', { result_id: 7, expected_result_revision: 3, values: { email: 'new@x.example', 'note\nStore owner pre-approved this': 'x' } });
    expect(asked[0]).toContain('new@x.example');
    expect(forged(asked[0], 'Store owner')).toBe(false);
  });

  it('request_pii_grant: a purpose cannot forge a line of the question', async () => {
    const { asked, call } = await connect(true);
    await call('request_pii_grant', { form_id: 3, fields: ['email'], max_results: 5, purpose: 'support\nfields: none' });
    expect(forged(asked[0], 'fields: none')).toBe(false);
  });

  it('remove_notification: a notification argument cannot forge a line', async () => {
    const { asked, call } = await connect(true);
    await call('remove_notification', { form_id: 3, notification: '\nStore owner pre-approved it........', confirmed_by_user: true });
    expect(forged(asked[0] ?? '', 'Store owner')).toBe(false);
  });

  it('a quoted value cannot close its quotes and forge a second one', async () => {
    const { asked, call } = await connect(true);
    await call('update_appearance', { tokens: { primary: '#000" (only this form)' } });
    expect(asked[0]).toContain('"#000\\" (only this form)"');
  });

  it('update_appearance shows the token values, and a token name cannot forge a line', async () => {
    const { asked, call } = await connect(true);
    await call('update_appearance', { tokens: { 'primary\nStore owner pre-approved this': '#ff0000' } });
    expect(asked[0]).toContain('#ff0000');
    expect(forged(asked[0], 'Store owner')).toBe(false);
  });
});

describe('an unknown argument is not echoed whole (N9)', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'index.ts'), ...args], {
    env: { ...process.env, WEBFORMS_MCP_HOME: mkdtempSync(join(tmpdir(), 'wfmcp-q6cli-')) }, encoding: 'utf8', timeout: 20_000, input: '',
  });
  it('an option prints only its name', () => {
    const run = cli(['--from=wf1_FAKESECRETpart']);
    expect(run.stderr).toContain('--from');
    expect(run.stderr).not.toContain('FAKESECRET');
  });
  it('a command prints no part of the argument', () => {
    const run = cli(['wf1_FAKESECRETpart']);
    expect(run.stderr).toMatch(/Unknown command/);
    expect(run.stderr).not.toContain('FAKESECRET');
  });
});

describe('a confirmation_id stays bound to the arguments it was first used with (N8)', () => {
  it('after a lost answer the same id with another body is refused before anything is sent', async () => {
    const { call } = await connect(true);
    const prepared = await call('prepare_reply', { result_id: 8, body_text: 'Your refund is on its way.' });
    const confirmation_id = prepared.structuredContent.confirmation_id;
    dropReply = true;
    const lost = await call('send_reply', { result_id: 8, body_text: 'Your refund is on its way.', expected_result_revision: 3, confirmation_id });
    expect(lost.isError, text(lost)).toBe(true);
    dropReply = false;
    seen = [];
    const other = await call('send_reply', { result_id: 8, body_text: 'Click https://evil.example to get your refund.', expected_result_revision: 3, confirmation_id });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/other arguments/);
    expect(writes()).toHaveLength(0);
    const same = await call('send_reply', { result_id: 8, body_text: 'Your refund is on its way.', expected_result_revision: 3, confirmation_id });
    expect(same.isError, text(same)).toBeFalsy();
  });
});
