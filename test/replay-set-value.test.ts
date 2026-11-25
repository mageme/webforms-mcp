import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { acceptingClient } from './accepting-client.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/**
 * A tool that sets a value carries no revision of its own: setting A, then B, then A again within the journal's
 * replay window is three intents, and the third must reach the store instead of being answered by the first one's
 * success while the store still holds B.
 */
const NOTIFICATION = '11111111-1111-4111-8111-111111111111';
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
const OK = { form_id: 3, changed: true, payload_json: '{}' };
let minted = 0;
// like the server, a request_id seen before is answered with its first outcome
const outcomes = new Map<unknown, unknown>();
const answer = (path: string, requestId: unknown): unknown => {
  if (outcomes.has(requestId)) return outcomes.get(requestId);
  const outcome = mint(path);
  outcomes.set(requestId, outcome);
  return outcome;
};
const mint = (path: string): unknown => {
  if (path.endsWith('/deactivate')) return { notification_id: 9, is_active: false };
  if (path.endsWith('/pii-grants')) return { grant_id: ++minted, expires_at: new Date(Date.now() + 300_000).toISOString() };
  if (path.endsWith('/restore-version')) return { draft_id: ++minted, draft_revision: 1 };
  if (path.endsWith('/commands/discard')) return true;
  return OK;
};

let http: Server;
let client: Client;

beforeAll(async () => {
  http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = req.method === 'POST' ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === 'POST') posted.push({ path, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer(path, (body.request as Record<string, unknown> | undefined)?.request_id)));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = acceptingClient('replay-set-value-test');
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  http.close();
});

const answers: string[] = [];
const requestIds = async (calls: Array<[string, Record<string, unknown>]>): Promise<unknown[]> => {
  const before = posted.length;
  answers.length = 0;
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    answers.push(JSON.stringify(result.structuredContent ?? result.content));
  }
  return posted.slice(before).map((p) => (p.body.request as Record<string, unknown>).request_id);
};

describe('a value set again after another is a new request', () => {
  it('update_notification', async () => {
    const patch = (name: string) => ['update_notification', { form_id: 3, notification: NOTIFICATION, patch: { name } }] as [string, Record<string, unknown>];
    const ids = await requestIds([patch('A'), patch('B'), patch('A')]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('set_notification_conditions', async () => {
    const set = (value: string) => ['set_notification_conditions', { form_id: 3, notification: NOTIFICATION, conditions: [{ field_code: 'topic', operator: 'is', values: [value] }] }] as [string, Record<string, unknown>];
    const ids = await requestIds([set('A'), set('B'), set('A')]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('set_notification_store_settings', async () => {
    const set = (enabled: boolean) => ['set_notification_store_settings', { form_id: 3, notification: NOTIFICATION, store_code: 'de', settings: { enabled } }] as [string, Record<string, unknown>];
    const ids = await requestIds([set(true), set(false), set(true)]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('set_notification_store_settings names the store view by its code, and settings null drops the store view\'s own', async () => {
    const before = posted.length;
    await requestIds([
      ['set_notification_store_settings', { form_id: 3, notification: NOTIFICATION, store_code: 'de', settings: { enabled: false } }],
      ['set_notification_store_settings', { form_id: 3, notification: NOTIFICATION, store_code: 'de', settings: null }],
      ['set_notification_store_settings', { form_id: 3, notification: NOTIFICATION, settings: { enabled: true } }],
    ]);
    const sent = posted.slice(before);
    expect(sent.map((p) => p.path)).toEqual(Array(3).fill('/V1/webforms/forms/3/notifications/commands/set-store-settings'));
    const fields = sent.map(({ body }) => { const { request_id: _id, ...rest } = body.request as Record<string, unknown>; return rest; });
    expect(fields).toEqual([
      { notification_ref: NOTIFICATION, store_code: 'de', notification_json: '{"enabled":false}' },
      { notification_ref: NOTIFICATION, store_code: 'de', notification_json: null },
      { notification_ref: NOTIFICATION, notification_json: '{"enabled":true}' },
    ]);
  });

  it('set_notification_content with content null sends no content, which drops the store view\'s override', async () => {
    const before = posted.length;
    await requestIds([['set_notification_content', { form_id: 3, notification: NOTIFICATION, store_code: 'de', content: null }]]);
    const sent = posted.slice(before);
    expect(sent.map((p) => p.path)).toEqual(['/V1/webforms/forms/3/notifications/commands/set-content']);
    expect((sent[0].body.request as Record<string, unknown>).notification_json).toBeNull();
  });

  it('deactivate_notification called again: the notification may have been switched back on in between', async () => {
    const off = ['deactivate_notification', { notification_id: 9, confirmed_by_user: true }] as [string, Record<string, unknown>];
    const ids = await requestIds([off, off]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('mass_status: setting a status does not raise the submissions\' revisions', async () => {
    const set = (status_code: string) => ['mass_status', { items: [{ result_id: 4, expected_result_revision: 5 }], status_code }] as [string, Record<string, unknown>];
    const ids = await requestIds([set('new'), set('done'), set('new')]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('request_pii_grant asked again gets a new grant, not the first one, which lives shorter than the replay window', async () => {
    const ask = ['request_pii_grant', { form_id: 3, fields: ['email'], max_results: 1, purpose: 'reply to the customer' }] as [string, Record<string, unknown>];
    const ids = await requestIds([ask, ask]);
    expect(new Set(ids).size).toBe(2);
    expect(answers[1], 'the second answer is not the first grant').not.toBe(answers[0]);
  });

  it('restore_version after the restored draft was discarded opens a new draft', async () => {
    const restore = ['restore_version', { form_id: 3, version_id: 8, expected_live_revision: 2 }] as [string, Record<string, unknown>];
    const discard = ['draft_discard', { draft_id: 50, expected_draft_revision: 1, confirmed_by_user: true }] as [string, Record<string, unknown>];
    const ids = await requestIds([restore, discard, restore]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(answers[2], 'the second restore does not answer with the discarded draft').not.toBe(answers[0]);
  });

  it('link_submission_order and unlink_submission_order', async () => {
    const link = ['link_submission_order', { result_id: 4, order_id: 12 }] as [string, Record<string, unknown>];
    const unlink = ['unlink_submission_order', { result_id: 4, order_id: 12 }] as [string, Record<string, unknown>];
    const ids = await requestIds([link, unlink, link, unlink]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});
