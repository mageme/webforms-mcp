import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.js';

/**
 * An approved write whose answer is lost (NETWORK) may already be applied: a mail sent, a form published, a field
 * removed. The retry with the same confirmation_id must go out under the same request id, so the store replays its
 * first answer instead of acting again, and the person, who already approved this very call, is not asked again.
 *
 * The stand-in store applies a write once per request id and answers a repeated id with the first answer; while
 * `drop` is set it applies the write and then cuts the connection before answering.
 */
let stub: Server;
let home = '';
let drop = false;
let asked = 0;
let approve = true;
const applied = new Map<string, { path: string; answer: unknown }>();
const writes: Array<{ path: string; requestId: string }> = [];

const conflict = (code: string) => [409, { message: code, parameters: { code, details_schema_version: '1', details_json: '{}' } }] as const;
const future = '2099-01-01 00:00:00';

/** Prepare steps and a gated command without a token; null for a write the store applies. */
const answerBefore = (path: string, request: Record<string, unknown>): readonly [number, unknown] | null => {
  if (path.endsWith('/capabilities')) return [200, { api_version: '1.0' }];
  if (path.endsWith('/results/7/commands/prepare-set-status')) return [200, { confirmation_token: 'tok-status', expires_at: future, requires_confirmation: true, impact_json: JSON.stringify({ notifies_customer: true, status: { code: 'shipped', label: 'Shipped' }, email_template: 'Shipped Mail', count: 1, recipient: 'j***@example.com', result_revision: 3 }) }];
  if (path.endsWith('/results/7/commands/set-status') && request.confirmation_token === undefined) return conflict('CONFIRMATION_REQUIRED');
  if (path.endsWith('/drafts/6/commands/prepare-publish')) return [200, { confirmation_token: 'tok-publish', expires_at: future, requires_confirmation: true, impact_json: JSON.stringify([{ kind: 'field_delete', severity: 'destructive', subject: { entity: 'field', id: 4, name: 'Email' }, detail: { submissions: 12 } }]) }];
  if (path.endsWith('/notifications/9/activation/prepare')) return [200, { confirmation_token: 'tok-act', expires_at: future, first_activation: true, diff_json: JSON.stringify({ first_activation: true, recipients: { added: [{ role: 'to', source: 'fixed', address: 'shop@store.example' }], removed: [] } }) }];
  if (path.endsWith('/results/7/commands/prepare-reply')) return [200, { confirmation_token: 'tok-reply', expires_at: future, impact_json: JSON.stringify({ recipient: 'j***@example.com', body: 'Hello', result_revision: 3 }) }];
  if (path.endsWith('/drafts/8/commands/prepare-remove-field')) return [200, { draft_id: 8, draft_revision: 2, changed: false, payload_json: JSON.stringify({ requires_confirmation: true, confirmation_token: 'tok-remove', expires_at: future, references: [{ kind: 'notification', id: 9, name: 'Sales Inquiry' }] }) }];
  return null;
};

/** The write a valid token applies, and its answer. */
const write = (path: string, request: Record<string, unknown>): readonly [number, unknown] => {
  const token = request.confirmation_token;
  if (path.endsWith('/results/7/commands/set-status')) return token === 'tok-status' ? [200, { id: 7, form_id: 3, revision: 4 }] : conflict('CONFIRMATION_INVALID');
  if (path.endsWith('/drafts/6/commands/publish')) return token === 'tok-publish' ? [200, { draft_id: 6, form_id: 3, live_revision: 5, changed: true, payload_json: '{}' }] : conflict('CONFIRMATION_INVALID');
  if (path.endsWith('/notifications/9/activation/confirm')) return token === 'tok-act' ? [200, { notification_id: 9, is_active: true }] : conflict('CONFIRMATION_REQUIRED');
  if (path.endsWith('/results/7/commands/reply')) return token === 'tok-reply' ? [200, { outbox_id: 1, state: 'sent', message_id: 'm', recipient_masked: 'j***@example.com' }] : conflict('CONFIRMATION_INVALID');
  if (path.endsWith('/drafts/8/commands/remove-field')) return token === 'tok-remove' ? [200, { draft_id: 8, draft_revision: 3, changed: true, payload_json: '{}' }] : conflict('CONFIRMATION_INVALID');
  return [404, { message: 'no route' }];
};

const client = async (): Promise<Client> => {
  const port = (stub.address() as AddressInfo).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, journalKey: 'k'.repeat(64) } as never, () => undefined, join(mkdtempSync(join(home, 'j-')), 'journal.jsonl'));
  const c = new Client({ name: 'retry', version: '0' }, { capabilities: { elicitation: {} } });
  c.setRequestHandler(ElicitRequestSchema, async () => { asked++; return approve ? { action: 'accept', content: { proceed: true } } : { action: 'decline' }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'wf-mcp-network-retry-'));
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const request = (() => { try { return (JSON.parse(body) as { request?: Record<string, unknown> }).request ?? {}; } catch { return {}; } })();
      const send = ([status, answer]: readonly [number, unknown]) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      const before = answerBefore(path, request);
      if (before) return send(before);
      const requestId = String(request.request_id ?? '');
      writes.push({ path, requestId });
      let done = applied.get(requestId);
      if (!done) {
        done = { path, answer: write(path, request) };
        applied.set(requestId, done);
      }
      if (drop) { req.socket.destroy(); return; }
      send(done.answer as readonly [number, unknown]);
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  if (home) rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  drop = false;
  asked = 0;
  approve = true;
  writes.length = 0;
  applied.clear();
});

/** First confirmed call loses its answer, the retry with the same arguments gets the store's first answer. */
const lostThenRetried = async (c: Client, tool: string, args: Record<string, unknown>, path: string) => {
  drop = true;
  const first: any = await c.callTool({ name: tool, arguments: args });
  expect(first.isError, JSON.stringify(first.content)).toBe(true);
  expect(JSON.stringify(first.content)).toMatch(/NETWORK/);
  const sentFirst = writes.filter((w) => w.path.endsWith(path)).length;
  expect(sentFirst).toBeGreaterThan(0);
  drop = false;
  const second: any = await c.callTool({ name: tool, arguments: args });
  expect(second.isError, JSON.stringify(second.content)).toBeFalsy();
  const sent = writes.filter((w) => w.path.endsWith(path));
  expect(sent.length).toBeGreaterThan(sentFirst);
  // one request id, so the store acted once: one mail, one publish, one removal
  expect(new Set(sent.map((w) => w.requestId)).size).toBe(1);
  expect([...applied.values()].filter((a) => a.path.endsWith(path)).length).toBe(1);
  // the person approved this call once; the retry of the same call does not ask again
  expect(asked).toBe(1);
  return second;
};

describe('an approved write retried after a lost connection', () => {
  it('set_submission_status (gated, emails the customer)', async () => {
    const c = await client();
    const args = { result_id: 7, expected_result_revision: 3, status_code: 'shipped' };
    const prepared: any = await c.callTool({ name: 'set_submission_status', arguments: args });
    const confirmationId = prepared.structuredContent.confirmation_id;
    expect(confirmationId).toMatch(/^[0-9a-f]{16}$/);
    await lostThenRetried(c, 'set_submission_status', { ...args, confirmation_id: confirmationId }, '/results/7/commands/set-status');
    await c.close();
  }, 30_000);

  it('draft_publish', async () => {
    const c = await client();
    const prepared: any = await c.callTool({ name: 'draft_prepare_publish', arguments: { draft_id: 6, expected_draft_revision: 2, expected_live_revision: 4 } });
    const confirmationId = prepared.structuredContent.confirmation_id;
    await lostThenRetried(c, 'draft_publish', { draft_id: 6, expected_draft_revision: 2, expected_live_revision: 4, confirmation_id: confirmationId }, '/drafts/6/commands/publish');
    await c.close();
  }, 30_000);

  it('activate_notification', async () => {
    const c = await client();
    const prepared: any = await c.callTool({ name: 'activate_notification', arguments: { notification_id: 9 } });
    const confirmationId = prepared.structuredContent.confirmation_id;
    await lostThenRetried(c, 'activate_notification', { notification_id: 9, confirmation_id: confirmationId }, '/notifications/9/activation/confirm');
    await c.close();
  }, 30_000);

  it('draft_remove_field', async () => {
    const c = await client();
    const prepared: any = await c.callTool({ name: 'draft_remove_field', arguments: { draft_id: 8, expected_draft_revision: 2, field_id: 'email' } });
    const confirmationId = prepared.structuredContent.confirmation_id;
    expect(prepared.structuredContent.removed).toBe(false);
    await lostThenRetried(c, 'draft_remove_field', { draft_id: 8, expected_draft_revision: 2, field_id: 'email', confirmation_id: confirmationId }, '/drafts/8/commands/remove-field');
    await c.close();
  }, 30_000);

  it('send_reply', async () => {
    const c = await client();
    const prepared: any = await c.callTool({ name: 'prepare_reply', arguments: { result_id: 7, body_text: 'Hello' } });
    const confirmationId = prepared.structuredContent.confirmation_id;
    await lostThenRetried(c, 'send_reply', { result_id: 7, body_text: 'Hello', expected_result_revision: 3, confirmation_id: confirmationId }, '/results/7/commands/reply');
    await c.close();
  }, 30_000);
});

describe('what the retry without a second question does not cover', () => {
  const args = { result_id: 7, expected_result_revision: 3, status_code: 'shipped' };
  const confirmationOf = async (c: Client): Promise<string> =>
    ((await c.callTool({ name: 'set_submission_status', arguments: args })) as any).structuredContent.confirmation_id;

  it('a person who declined is asked again on the next call', async () => {
    const c = await client();
    const confirmationId = await confirmationOf(c);
    approve = false;
    const declined: any = await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    expect(JSON.stringify(declined.content)).toMatch(/did not approve/);
    expect(writes.length).toBe(0);
    approve = true;
    const second: any = await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    expect(second.isError, JSON.stringify(second.content)).toBeFalsy();
    expect(asked).toBe(2);
    await c.close();
  }, 30_000);

  it('a retry with other arguments after a lost answer is refused unasked and sends nothing', async () => {
    const c = await client();
    const confirmationId = await confirmationOf(c);
    drop = true;
    await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    drop = false;
    const sent = writes.length;
    const moved: any = await c.callTool({ name: 'set_submission_status', arguments: { ...args, expected_result_revision: 4, confirmation_id: confirmationId } });
    expect(moved.isError).toBe(true);
    expect(JSON.stringify(moved.content)).toMatch(/first used with other arguments/);
    expect(writes.length).toBe(sent);
    expect(asked).toBe(1);
    await c.close();
  }, 30_000);

  it('the store\'s answer spends the approval', async () => {
    const c = await client();
    const confirmationId = await confirmationOf(c);
    drop = true;
    await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    drop = false;
    await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    const third: any = await c.callTool({ name: 'set_submission_status', arguments: { ...args, confirmation_id: confirmationId } });
    expect(JSON.stringify(third.content)).toMatch(/Unknown or expired confirmation_id/);
    expect(asked).toBe(1);
    await c.close();
  }, 30_000);
});
