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
 * One value is set by a pair of operations (deactivate and activate, link and unlink, a notification's update and
 * its set-content / set-conditions). When the first call's answer is lost, the other operation then sets the value,
 * and the first call is made again, the journal must send a new request: reusing the lost one's request id makes the
 * server replay the first outcome without running it, and the store keeps the other operation's value.
 */
const NOTIFICATION = '22222222-2222-4222-8222-222222222222';
const store = {
  active: new Map<number, boolean>(),
  content: new Map<string, string>(),
  orders: new Set<string>(),
  status: new Map<string, string>(),
};
let losing = false;
let grants = 0;
let skewed = false;
const outcomes = new Map<unknown, unknown>();

const run = (path: string, request: Record<string, unknown>): unknown => {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/notifications\/(\d+)\/deactivate$/))) { store.active.set(Number(m[1]), false); return { notification_id: Number(m[1]), is_active: false }; }
  if (path.match(/notifications\/(\d+)\/activation\/prepare$/)) return { confirmation_token: `tok-${outcomes.size}`, expires_at: new Date(Date.now() + 600_000).toISOString(), diff_json: '{}', first_activation: false };
  if ((m = path.match(/notifications\/(\d+)\/activation\/confirm$/))) { store.active.set(Number(m[1]), true); return true; }
  if ((m = path.match(/notifications\/commands\/(update|set-content|set-store-settings|set-conditions)$/))) {
    store.content.set(String(request.notification_ref), `${m[1]}:${String(request.notification_json)}`);
    return { form_id: 3, changed: true, payload_json: '{}' };
  }
  if ((m = path.match(/results\/(\d+)\/commands\/(link-order|unlink-order)$/))) {
    const link = `${m[1]}:${String(request.order_id)}`;
    if (m[2] === 'link-order') store.orders.add(link); else store.orders.delete(link);
    return { id: Number(m[1]), result_revision: 1 };
  }
  if ((m = path.match(/results\/(\d+)\/commands\/set-status$/))) { store.status.set(m[1], String(request.status_code)); return { id: Number(m[1]), result_revision: 2 }; }
  if (path.endsWith('/results/commands/mass-status')) {
    for (const item of JSON.parse(String(request.items_json)) as Array<{ result_id: number }>) store.status.set(String(item.result_id), String(request.status_code));
    return { updated: 1 };
  }
  // the first grant is already past its lifetime when its lost answer is asked for again
  if (path.endsWith('/results/pii-grants')) return { grant_id: ++grants, expires_at: new Date(Date.now() + (grants === 1 || skewed ? -1000 : 300_000)).toISOString() };
  throw new Error(`unexpected ${path}`);
};

let http: Server;
let client: Client;
const posted: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      // the client's one-time question about the API version is not part of what these tests count
      if (path === '/V1/webforms/capabilities') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"api_version":"1"}');
      const request = (JSON.parse(raw || '{}') as { request?: Record<string, unknown> }).request ?? {};
      const id = request.request_id;
      posted.push(String(id));
      // like the server, a request id seen before is answered with its first outcome and not run again
      if (!outcomes.has(id)) outcomes.set(id, run(path, request));
      if (losing) { res.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcomes.get(id)));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-pairs-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = acceptingClient('replay-value-pairs-test');
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  http.close();
});

const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
};
const lose = async (name: string, args: Record<string, unknown>): Promise<void> => {
  losing = true;
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, 'the answer was lost').toBe(true);
  } finally {
    losing = false;
  }
};
const activate = async (notification_id: number): Promise<void> => {
  const prepared = await call('activate_notification', { notification_id });
  await call('activate_notification', { notification_id, confirmation_id: prepared.confirmation_id, confirmed_by_user: true });
};

describe('a value set by a pair of operations, after a lost answer', () => {
  it('deactivate_notification after activate_notification switched it back on', { timeout: 20_000 }, async () => {
    const off = { notification_id: 9, confirmed_by_user: true };
    await lose('deactivate_notification', off);
    await activate(9);
    expect(store.active.get(9)).toBe(true);
    await call('deactivate_notification', off);
    expect(store.active.get(9), 'the notification is off again').toBe(false);
  });

  it('link_submission_order after unlink_submission_order, and unlink after link', { timeout: 20_000 }, async () => {
    await lose('link_submission_order', { result_id: 4, order_id: 12 });
    await call('unlink_submission_order', { result_id: 4, order_id: 12 });
    await call('link_submission_order', { result_id: 4, order_id: 12 });
    expect(store.orders.has('4:12'), 'the order is linked again').toBe(true);

    await lose('unlink_submission_order', { result_id: 4, order_id: 12 });
    await call('link_submission_order', { result_id: 4, order_id: 12 });
    await call('unlink_submission_order', { result_id: 4, order_id: 12 });
    expect(store.orders.has('4:12'), 'the order is unlinked again').toBe(false);
  });

  it('update_notification after set_notification_conditions', { timeout: 20_000 }, async () => {
    const update = { form_id: 3, notification: NOTIFICATION, patch: { conditions: [] } };
    await lose('update_notification', update);
    await call('set_notification_conditions', { form_id: 3, notification: NOTIFICATION, conditions: [{ field_code: 'topic', operator: 'is', values: ['B'] }] });
    await call('update_notification', update);
    expect(store.content.get(NOTIFICATION)).toMatch(/^update:/);
  });

  it('set_notification_content after update_notification', { timeout: 20_000 }, async () => {
    const content = { form_id: 3, notification: NOTIFICATION, content: { subject: 'A' } };
    await lose('set_notification_content', content);
    await call('update_notification', { form_id: 3, notification: NOTIFICATION, patch: { contents: { default: { subject: 'B' } } } });
    await call('set_notification_content', content);
    expect(store.content.get(NOTIFICATION)).toMatch(/^set-content:/);
  });

  it('set_notification_store_settings after update_notification', { timeout: 20_000 }, async () => {
    const settings = { form_id: 3, notification: NOTIFICATION, store_code: 'de', settings: { enabled: false } };
    await lose('set_notification_store_settings', settings);
    await call('update_notification', { form_id: 3, notification: NOTIFICATION, patch: { store_settings: [{ store_code: 'de', enabled: true }] } });
    await call('set_notification_store_settings', settings);
    expect(store.content.get(NOTIFICATION)).toMatch(/^set-store-settings:/);
  });

  it('set_notification_conditions after update_notification', { timeout: 20_000 }, async () => {
    const conditions = { form_id: 3, notification: NOTIFICATION, conditions: [{ field_code: 'topic', operator: 'is', values: ['A'] }] };
    await lose('set_notification_conditions', conditions);
    await call('update_notification', { form_id: 3, notification: NOTIFICATION, patch: { conditions: [] } });
    await call('set_notification_conditions', conditions);
    expect(store.content.get(NOTIFICATION)).toMatch(/^set-conditions:/);
  });

  it('mass_status after set_submission_status', { timeout: 20_000 }, async () => {
    const mass = { items: [{ result_id: 5, expected_result_revision: 1 }], status_code: 'new' };
    await lose('mass_status', mass);
    await call('set_submission_status', { result_id: 5, expected_result_revision: 1, status_code: 'done' });
    await call('mass_status', mass);
    expect(store.status.get('5'), 'the status is new again').toBe('new');
  });

  it('set_submission_status after mass_status, the submission not first in its list', { timeout: 20_000 }, async () => {
    const set = { result_id: 6, expected_result_revision: 1, status_code: 'done' };
    await lose('set_submission_status', set);
    await call('mass_status', { items: [{ result_id: 7, expected_result_revision: 1 }, { result_id: 6, expected_result_revision: 1 }], status_code: 'new' });
    await call('set_submission_status', set);
    expect(store.status.get('6'), 'the status is done again').toBe('done');
  });

  it('set_submission_status answered before mass_status is not replayed after it', { timeout: 20_000 }, async () => {
    const set = { result_id: 8, expected_result_revision: 1, status_code: 'done' };
    await call('set_submission_status', set);
    await call('mass_status', { items: [{ result_id: 8, expected_result_revision: 1 }], status_code: 'new' });
    await call('set_submission_status', set);
    expect(store.status.get('8'), 'the status is done again').toBe('done');
  });

  it('set_submission_status on another submission does not overtake a lost one', { timeout: 20_000 }, async () => {
    const set = { result_id: 15, expected_result_revision: 1, status_code: 'done' };
    const before = posted.length;
    await lose('set_submission_status', set);
    await call('set_submission_status', { result_id: 16, expected_result_revision: 1, status_code: 'done' });
    await call('set_submission_status', set);
    const ids = posted.slice(before);
    expect(ids[ids.length - 1], 'the retry carries the lost call\'s request id').toBe(ids[0]);
  });

  it('switching another notification on does not overtake a lost deactivate', { timeout: 20_000 }, async () => {
    const off = { notification_id: 13, confirmed_by_user: true };
    const before = posted.length;
    await lose('deactivate_notification', off);
    await activate(14);
    await call('deactivate_notification', off);
    const ids = posted.slice(before);
    expect(ids[ids.length - 1], 'the retry carries the lost call\'s request id').toBe(ids[0]);
  });

  it('a lost value nothing overtook is retried with its request id', { timeout: 20_000 }, async () => {
    const off = { notification_id: 11, confirmed_by_user: true };
    const before = posted.length;
    await lose('deactivate_notification', off);
    await call('deactivate_notification', { notification_id: 11, confirmed_by_user: true });
    expect(new Set(posted.slice(before)).size, 'one request id across the lost call and its retry').toBe(1);
  });
});

describe('a lost grant', () => {
  it('asked for again after it expired is issued anew, not handed back expired', { timeout: 20_000 }, async () => {
    const ask = { form_id: 3, fields: ['email'], max_results: 1, purpose: 'reply to the customer' };
    await lose('request_pii_grant', ask);
    const grant = await call('request_pii_grant', ask);
    expect(Date.parse(String(grant.expires_at)), 'the grant handed over is still alive').toBeGreaterThan(Date.now());
    expect(grant.grant_id).toBe(2);
  });

  it('a fresh grant is not asked for twice, even when the clocks disagree about its expiry', async () => {
    skewed = true;
    try {
      const before = posted.length;
      await call('request_pii_grant', { form_id: 4, fields: ['email'], max_results: 1, purpose: 'reply to the customer' });
      expect(posted.length - before, 'one grant per call').toBe(1);
    } finally {
      skewed = false;
    }
  });
});
