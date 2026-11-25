import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { acceptingClient } from './accepting-client.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/**
 * A creation tool takes the agent's idempotency_key: the same key and arguments are one creation, a new key is
 * another, the same key with other arguments is refused. Every answer says how its object came about, and an object
 * removed since is never handed back as the creation's result.
 */
const SOURCE = '44444444-4444-4444-8444-444444444444';
const store = { notifications: new Set<string>(), exports: new Map<number, string>(), forms: new Set<number>() };
const executed: string[] = [];
const outcomes = new Map<unknown, { status: number; body: unknown }>();
let losing = false;
let indeterminate = false;
const bodies: string[] = [];
let forgetting = false;
/** the store's answer to a request it refuses before running anything */
let refusing: { status: number; body: unknown } | null = null;
/** the first send of a request creates and its answer is lost to a gateway error; the client's own retry is refused */
let refusingRetry: { status: number; body: unknown } | null = null;
const sent = new Set<unknown>();
let serial = 0;

const run = (path: string, request: Record<string, unknown>): unknown => {
  executed.push(path);
  let m: RegExpMatchArray | null;
  if ((m = path.match(/forms\/(\d+)\/notifications\/commands\/(add|duplicate|remove)$/))) {
    if (m[2] === 'remove') { store.notifications.delete(String(request.notification_ref)); return { form_id: Number(m[1]), changed: true, payload_json: '{}' }; }
    const uuid = `${String(++serial).padStart(8, '0')}-5555-4555-8555-555555555555`;
    store.notifications.add(uuid);
    return { form_id: Number(m[1]), changed: true, payload_json: JSON.stringify({ uuid, notification_id: serial }) };
  }
  if ((m = path.match(/forms\/(\d+)\/commands\/duplicate$/))) { store.forms.add(++serial); return { id: serial, name: 'Copy' }; }
  if ((m = path.match(/drafts\/(\d+)\/commands\/add-field$/))) return { draft_id: Number(m[1]), draft_revision: Number(request.expected_draft_revision) + 1, payload_json: JSON.stringify({ field_id: ++serial }) };
  if ((m = path.match(/results\/(\d+)\/commands\/add-note$/))) return { id: Number(m[1]), result_revision: 1 };
  if (path.endsWith('/results/export')) { store.exports.set(++serial, 'queued'); return { export_id: serial, state: 'queued' }; }
  throw new Error(`unexpected ${path}`);
};

let http: Server;
let client: Client;
const journalPath = join(mkdtempSync(join(tmpdir(), 'wfmcp-create-')), 'journal.jsonl');

beforeAll(async () => {
  http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      let m: RegExpMatchArray | null;
      if (req.method === 'GET') {
        // as the API sends it: the document is a JSON string, listing every notification, switched on or off
        if ((m = path.match(/forms\/(\d+)\/document$/))) return send(200, { schema_version: 1, revision: 1, document_json: JSON.stringify({ id: Number(m[1]), notifications: [...store.notifications].map((uuid) => ({ uuid, is_active: false })) }) });
        if ((m = path.match(/forms\/(\d+)$/))) return store.forms.has(Number(m[1])) ? send(200, { id: Number(m[1]) }) : send(404, { message: 'Not found.' });
        if ((m = path.match(/results\/(\d+)$/))) return send(200, { id: Number(m[1]) });
        if ((m = path.match(/exports\/(\d+)$/))) return send(200, { export_id: Number(m[1]), state: store.exports.get(Number(m[1])) });
        return send(404, { message: 'Not found.' });
      }
      bodies.push(raw);
      const request = (JSON.parse(raw || '{}') as { request?: Record<string, unknown> }).request ?? {};
      const id = request.request_id;
      // like FormWrite: a replayed creation answers with the form as it is now
      const replayedForm = outcomes.get(id)?.body as { id?: number } | undefined;
      if (outcomes.has(id) && /\/forms\/\d+\/commands\/duplicate$/.test(path) && !store.forms.has(Number(replayedForm?.id))) return send(404, { message: 'Not found.' });
      if (!outcomes.has(id) && refusing) outcomes.set(id, refusing);
      if (refusingRetry) {
        if (!sent.has(id)) { sent.add(id); run(path, request); return send(503, { message: 'Bad gateway' }); }
        return send(refusingRetry.status, refusingRetry.body);
      }
      if (!outcomes.has(id) && indeterminate) { run(path, request); outcomes.set(id, { status: 409, body: { message: 'The request failed midway', parameters: { code: 'INDETERMINATE' } } }); }
      // like the server: a request id seen before is answered with its first outcome and not run again
      if (outcomes.has(id) && forgetting) return send(409, { message: 'no longer replayable', parameters: { code: 'REPLAY_UNAVAILABLE' } });
      if (!outcomes.has(id)) outcomes.set(id, { status: 200, body: run(path, request) });
      if (losing) { res.destroy(); return; }
      const outcome = outcomes.get(id)!;
      send(outcome.status, outcome.body);
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, journalPath);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = acceptingClient('replay-create-test');
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  http.close();
});

type Status = { outcome: string; created: boolean; first_call_at?: string; note?: string; to_create_another?: string };
const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown> & { idempotency: Status }> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  return result.structuredContent as Record<string, unknown> & { idempotency: Status };
};
const runs = async <T>(work: () => Promise<T>): Promise<{ value: T; ran: number }> => {
  const before = executed.length;
  const value = await work();
  return { value, ran: executed.length - before };
};
const duplicate = (key?: string) => ({ form_id: 3, notification: SOURCE, ...(key ? { idempotency_key: key } : {}) });

describe('idempotency_key on a creation', () => {
  it('a new key makes a second, intended copy', async () => {
    const one = await runs(() => call('duplicate_notification', duplicate('copy-1')));
    const two = await runs(() => call('duplicate_notification', duplicate('copy-2')));
    expect(one.ran + two.ran).toBe(2);
    expect(two.value.uuid).not.toBe(one.value.uuid);
    expect(two.value.idempotency).toEqual({ outcome: 'created', created: true });
  });

  it('the same key and arguments are answered as a replay: nothing is created, and the answer says so', async () => {
    const first = await call('duplicate_notification', duplicate('copy-3'));
    const again = await runs(() => call('duplicate_notification', duplicate('copy-3')));
    expect(again.ran, 'nothing ran in the store').toBe(0);
    expect(again.value.uuid).toBe(first.uuid);
    expect(again.value.idempotency).toMatchObject({ outcome: 'replayed', created: false });
    expect(Date.parse(String(again.value.idempotency.first_call_at))).toBeLessThanOrEqual(Date.now());
    expect(again.value.idempotency.to_create_another).toMatch(/idempotency_key not used before/);
  });

  it('the same key with other arguments is refused and nothing runs', async () => {
    await call('add_notification', { form_id: 3, notification: { name: 'A' }, idempotency_key: 'add-1' });
    const before = executed.length;
    const refused = await client.callTool({ name: 'add_notification', arguments: { form_id: 3, notification: { name: 'B' }, idempotency_key: 'add-1' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(executed.length).toBe(before);
  });

  it('a lost answer retried with the same key reaches the one object the first call created', { timeout: 20_000 }, async () => {
    const before = store.notifications.size;
    losing = true;
    try {
      expect((await client.callTool({ name: 'add_notification', arguments: { form_id: 3, notification: { name: 'Lost' }, idempotency_key: 'add-lost' } })).isError).toBe(true);
    } finally {
      losing = false;
    }
    const retry = await runs(() => call('add_notification', { form_id: 3, notification: { name: 'Lost' }, idempotency_key: 'add-lost' }));
    expect(retry.ran).toBe(0);
    expect(store.notifications.size).toBe(before + 1);
    expect(retry.value.idempotency).toMatchObject({ outcome: 'retried', created: true });
  });

  it('a key whose answer the store no longer keeps creates nothing and says so', async () => {
    await call('duplicate_form', { form_id: 3, idempotency_key: 'form-forgotten' });
    forgetting = true;
    try {
      const again = await runs(() => call('duplicate_form', { form_id: 3, idempotency_key: 'form-forgotten' }));
      expect(again.ran).toBe(0);
      expect(again.value.idempotency).toMatchObject({ outcome: 'not_created', created: false });
    } finally {
      forgetting = false;
    }
  });
});

describe('a key stays bound to its request', () => {
  it('a removed form under the same key is not copied again, however often the key comes back', async () => {
    const first = await call('duplicate_form', { form_id: 3, name: 'Keyed', idempotency_key: 'form-removed' });
    store.forms.delete(Number(first.id));
    for (let i = 0; i < 2; i++) {
      const again = await runs(() => call('duplicate_form', { form_id: 3, name: 'Keyed', idempotency_key: 'form-removed' }));
      expect(again.ran).toBe(0);
      expect(again.value.idempotency).toMatchObject({ outcome: 'not_created', created: false });
    }
  });

  it('a removed form without a key is copied anew', async () => {
    const first = await call('duplicate_form', { form_id: 3, name: 'Unkeyed' });
    store.forms.delete(Number(first.id));
    const again = await runs(() => call('duplicate_form', { form_id: 3, name: 'Unkeyed' }));
    expect(again.ran).toBe(1);
    expect(again.value.idempotency).toMatchObject({ outcome: 'created', created: true });
  });

  it('after a failure whose effect is unknown the same key sends the same request, never a second creation', async () => {
    indeterminate = true;
    try {
      expect((await client.callTool({ name: 'add_notification', arguments: { form_id: 3, notification: { name: 'Unknown' }, idempotency_key: 'add-unknown' } })).isError).toBe(true);
    } finally {
      indeterminate = false;
    }
    const before = executed.length;
    const again = await client.callTool({ name: 'add_notification', arguments: { form_id: 3, notification: { name: 'Unknown' }, idempotency_key: 'add-unknown' } });
    expect(again.isError, 'the store answers that request again').toBe(true);
    expect(executed.length).toBe(before);
  });

  it('a call without a key does not reuse a request made under one, and the key keeps its object', async () => {
    const node = { form_id: 3, notification: { name: 'Shared args' } };
    const keyed = await call('add_notification', { ...node, idempotency_key: 'add-shared' });
    const plain = await runs(() => call('add_notification', node));
    expect(plain.ran).toBe(1);
    expect(plain.value.uuid).not.toBe(keyed.uuid);
    const again = await call('add_notification', { ...node, idempotency_key: 'add-shared' });
    expect(again.uuid).toBe(keyed.uuid);
  });

  it('the key never leaves in a request body nor lands in the journal', async () => {
    const secret = 'key-0f9e8d7c6b5a';
    await call('export_submissions', { form_id: 12, idempotency_key: secret });
    await call('add_submission_note', { result_id: 4, text: 'note', idempotency_key: secret + '-note' });
    await call('add_notification', { form_id: 3, notification: { name: 'Secret' }, idempotency_key: secret + '-add' });
    await call('duplicate_notification', duplicate(secret + '-dup'));
    expect(bodies.join('\n')).not.toContain(secret);
    expect(readFileSync(journalPath, 'utf8')).not.toContain(secret);
    const entries = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { operation: string; args_hash: string; key?: string });
    const keyed = entries.find((e) => e.operation === 'export_submissions' && e.key !== undefined)!;
    await call('export_submissions', { form_id: 12 });
    const plain = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { operation: string; args_hash: string; key?: string })
      .filter((e) => e.operation === 'export_submissions' && e.key === undefined).pop()!;
    expect(plain.args_hash, 'the key is not part of the arguments\' hash').toBe(keyed.args_hash);
  });
});

describe('a key refused before anything ran', () => {
  const refused = async (args: Record<string, unknown>, answer: { status: number; body: unknown }): Promise<void> => {
    refusing = answer;
    try {
      expect((await client.callTool({ name: 'add_notification', arguments: args })).isError).toBe(true);
    } finally {
      refusing = null;
    }
  };

  it('takes corrected arguments under the same key after VALIDATION_FAILED', async () => {
    await refused({ form_id: 3, notification: { name: '' }, idempotency_key: 'add-invalid' }, { status: 400, body: { message: 'name is required', parameters: { code: 'VALIDATION_FAILED' } } });
    const fixed = await runs(() => call('add_notification', { form_id: 3, notification: { name: 'Fixed' }, idempotency_key: 'add-invalid' }));
    expect(fixed.ran).toBe(1);
    expect(fixed.value.idempotency).toEqual({ outcome: 'created', created: true });
    const again = await runs(() => call('add_notification', { form_id: 3, notification: { name: 'Fixed' }, idempotency_key: 'add-invalid' }));
    expect(again.ran, 'the key now belongs to the call that created').toBe(0);
    expect(again.value.uuid).toBe(fixed.value.uuid);
  });

  it('stays bound when the refusal came on the client\'s retry of a send that may have created', { timeout: 20_000 }, async () => {
    const args = { form_id: 3, notification: { name: 'Created behind a gateway' }, idempotency_key: 'add-gateway' };
    refusingRetry = { status: 403, body: { message: 'Forbidden by the gateway.' } };
    try {
      const before = executed.length;
      expect((await client.callTool({ name: 'add_notification', arguments: args })).isError).toBe(true);
      expect(executed.length - before, 'the first send created').toBe(1);
    } finally {
      refusingRetry = null;
    }
    const refused = await client.callTool({ name: 'add_notification', arguments: { ...args, notification: { name: 'Other' } } });
    expect(JSON.stringify(refused.content), 'the key still belongs to that send').toContain('IDEMPOTENCY_KEY_REUSED');
  });

  it('stays bound for export_submissions, whose job is queued before the store can still answer VALIDATION_FAILED', async () => {
    refusing = { status: 400, body: { message: 'The request could not be applied.', parameters: { code: 'VALIDATION_FAILED' } } };
    try {
      expect((await client.callTool({ name: 'export_submissions', arguments: { form_id: 21, idempotency_key: 'export-refused' } })).isError).toBe(true);
    } finally {
      refusing = null;
    }
    const other = await client.callTool({ name: 'export_submissions', arguments: { form_id: 22, idempotency_key: 'export-refused' } });
    expect(JSON.stringify(other.content)).toContain('IDEMPOTENCY_KEY_REUSED');
  });

  it('runs the same call under the same key once the permission is granted', async () => {
    const args = { form_id: 3, notification: { name: 'Allowed later' }, idempotency_key: 'add-forbidden' };
    await refused(args, { status: 403, body: { message: 'Not allowed.' } });
    const allowed = await runs(() => call('add_notification', args));
    expect(allowed.ran).toBe(1);
    expect(allowed.value.idempotency).toEqual({ outcome: 'created', created: true });
  });
});

describe('a key past its 30-day term', () => {
  it('is a new request: the call runs again and says it created', async () => {
    const args = { form_id: 3, name: 'Month old', idempotency_key: 'form-month-old' };
    const first = await call('duplicate_form', args);
    const month = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const keyed = new Set(readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { request_id: string; key?: string }).filter((e) => e.key !== undefined).map((e) => e.request_id));
    // the journal ages: every record of a keyed request is a month old, as the server's own record would be gone by 90 days
    writeFileSync(journalPath, readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l) as { request_id: string; ts: string };
      return JSON.stringify(keyed.has(e.request_id) ? { ...e, ts: month } : e);
    }).join('\n') + '\n', { mode: 0o600 });
    const again = await runs(() => call('duplicate_form', args));
    expect(again.ran).toBe(1);
    expect(again.value.id).not.toBe(first.id);
    expect(again.value.idempotency).toEqual({ outcome: 'created', created: true });
  });
});

describe('without a key', () => {
  it('an identical call whose answer the store no longer keeps runs anew and says it created', async () => {
    await call('duplicate_form', { form_id: 3, name: 'Forgotten' });
    forgetting = true;
    try {
      const again = await runs(() => call('duplicate_form', { form_id: 3, name: 'Forgotten' }));
      expect(again.ran).toBe(1);
      expect(again.value.idempotency).toEqual({ outcome: 'created', created: true });
    } finally {
      forgetting = false;
    }
  });

  it('an identical call inside the window is answered as a replay', async () => {
    const first = await call('duplicate_form', { form_id: 3, name: 'Twin' });
    expect(first.idempotency).toEqual({ outcome: 'created', created: true });
    const again = await runs(() => call('duplicate_form', { form_id: 3, name: 'Twin' }));
    expect(again.ran).toBe(0);
    expect(again.value.id).toBe(first.id);
    expect(again.value.idempotency).toMatchObject({ outcome: 'replayed', created: false });
  });

  it('a lost answer retried is reported as the retry it is', { timeout: 20_000 }, async () => {
    losing = true;
    try {
      expect((await client.callTool({ name: 'export_submissions', arguments: { form_id: 8 } })).isError).toBe(true);
    } finally {
      losing = false;
    }
    const retry = await runs(() => call('export_submissions', { form_id: 8 }));
    expect(retry.ran).toBe(0);
    expect(retry.value.idempotency).toMatchObject({ outcome: 'retried', created: true });
  });
});

describe('an object removed since', () => {
  it('is not handed back: add_notification after remove_notification creates a new one', async () => {
    const node = { form_id: 3, notification: { name: 'Gone' } };
    const first = await call('add_notification', node);
    await call('remove_notification', { form_id: 3, notification: first.uuid });
    const again = await runs(() => call('add_notification', node));
    expect(again.ran).toBe(1);
    expect(again.value.uuid).not.toBe(first.uuid);
    expect(store.notifications.has(String(again.value.uuid))).toBe(true);
    expect(again.value.idempotency).toMatchObject({ outcome: 'created', created: true });
    expect(again.value.idempotency.note).toMatch(/removed/);
  });

  it('under the same key creates nothing and says the object was removed', async () => {
    const node = { form_id: 3, notification: { name: 'Gone with key' }, idempotency_key: 'add-gone' };
    const first = await call('add_notification', node);
    await call('remove_notification', { form_id: 3, notification: first.uuid });
    const again = await runs(() => call('add_notification', node));
    expect(again.ran).toBe(0);
    expect(again.value.uuid).toBeUndefined();
    expect(again.value.idempotency).toMatchObject({ outcome: 'not_created', created: false });
    expect(again.value.idempotency.note).toMatch(/removed/);
  });

  it('a form removed since is not handed back: duplicate_form creates a new copy', async () => {
    const first = await call('duplicate_form', { form_id: 3, name: 'Removed' });
    store.forms.delete(Number(first.id));
    const again = await runs(() => call('duplicate_form', { form_id: 3, name: 'Removed' }));
    expect(again.ran).toBe(1);
    expect(again.value.id).not.toBe(first.id);
    expect(again.value.idempotency).toMatchObject({ outcome: 'created', created: true });
  });

  it('duplicate_notification under the same key after the copy was removed creates nothing', async () => {
    const first = await call('duplicate_notification', duplicate('copy-removed'));
    store.notifications.delete(String(first.uuid));
    const again = await runs(() => call('duplicate_notification', duplicate('copy-removed')));
    expect(again.ran).toBe(0);
    expect(again.value.idempotency).toMatchObject({ outcome: 'not_created', created: false });
  });

  it('an expired export is not handed back', async () => {
    const first = await call('export_submissions', { form_id: 9 });
    store.exports.set(Number(first.export_id), 'expired');
    const again = await runs(() => call('export_submissions', { form_id: 9 }));
    expect(again.ran).toBe(1);
    expect(again.value.export_id).not.toBe(first.export_id);
  });
});

describe('a draft command that adds something', () => {
  it('repeated with the same revision says it is a replay and adds nothing', async () => {
    const add = { draft_id: 5, expected_draft_revision: 7, section_id: 2, type: 'text' };
    const first = await call('draft_add_field', add);
    expect(first.idempotency).toEqual({ outcome: 'created', created: true });
    const again = await runs(() => call('draft_add_field', add));
    expect(again.ran).toBe(0);
    expect(again.value.field_id).toBe(first.field_id);
    expect(again.value.idempotency).toMatchObject({ outcome: 'replayed', created: false });
    expect(again.value.idempotency.to_create_another).toMatch(/expected_draft_revision/);
  });
});
