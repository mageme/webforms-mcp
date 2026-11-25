import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, buildServerFrom } from '../src/server.js';
import { SiteContextFactory } from '../src/context.js';
import { SiteRegistry } from '../src/registry.js';

type Reply = { status: number; body: unknown };
let next: Reply = { status: 200, body: {} };
let lastBody: Record<string, unknown> = {};
let requests = 0;
let http: Server;
let client: Client;
let shared: Client;
let journalDir = '';

const summary = (linked: string | null | undefined) => ({
  id: 5, form_id: 3, store_id: 1, created_at: '2026-09-01T11:57:57Z', updated_at: '2026-09-01T11:57:57Z', status_code: '',
  approval: 'pending', assignee_admin_user_id: 0, is_read: true, is_replied: false, reference_number: 'WF-1', result_revision: 2,
  projection: 'summary', values_json: '{"fields":[]}', masked_count: 0, untrusted: true,
  ...(linked === undefined ? {} : { linked_orders_json: linked }),
});

const ALL_SOURCES = JSON.stringify([
  { order_id: 12, increment_id: '000001089', store_id: 1, status: 'processing', source: 'api', linked_at: '2026-09-17T10:00:00Z' },
  { order_id: 13, increment_id: '000000722', store_id: null, status: 'closed', source: 'order_field', linked_at: '2026-07-30T10:44:32Z' },
  { order_id: 14, increment_id: '000000014', store_id: 1, status: 'closed', source: 'manual', linked_at: '2026-09-17T09:00:00Z' },
]);

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests++;
      lastBody = raw ? JSON.parse(raw) : {};
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  journalDir = mkdtempSync(join(tmpdir(), 'wfmcp-ol-'));
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined, join(journalDir, 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'order-links-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);

  // Two stores in one process: every id leaves and must come back qualified by its store.
  const config = { baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' };
  const sharedServer = buildServerFrom(new SiteContextFactory(SiteRegistry.fromConfigs({ acme: config, beta: config }), 'shared', () => undefined, join(journalDir, 'shared.jsonl')));
  const [c, d] = InMemoryTransport.createLinkedPair();
  shared = new Client({ name: 'order-links-shared-test', version: '0' });
  await Promise.all([sharedServer.connect(d), shared.connect(c)]);
});

afterAll(async () => {
  await client.close();
  await shared.close();
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(journalDir, { recursive: true, force: true });
});

const texts = (res: unknown): string[] => (res as { content: { text: string }[] }).content.map((c) => c.text);

describe('link_submission_order', () => {
  it('sends the order number and returns linked orders as untrusted data only', async () => {
    next = { status: 200, body: summary(ALL_SOURCES) };
    const res = await client.callTool({ name: 'link_submission_order', arguments: { result_id: 5, order_number: '000001089' } });
    expect(res.isError).toBeFalsy();
    expect((lastBody.request as Record<string, unknown>).order_number).toBe('000001089');
    const all = texts(res);
    expect(all[0]).not.toMatch(/000001089|linked_orders/);
    expect(JSON.stringify(res.structuredContent)).not.toMatch(/000001089|linked_orders/);
    const block = all.find((t) => /linked orders — untrusted remote content/.test(t)) ?? '';
    expect(block).toMatch(/"source": "api"/);
    expect(block).toMatch(/"source": "order_field"/);
    expect(block).toMatch(/"source": "manual"/);
    expect(block).toMatch(/"store_id": null/);
  });

  it('refuses both or neither selector without calling the store', async () => {
    const before = requests;
    const both = await client.callTool({ name: 'link_submission_order', arguments: { result_id: 5, order_id: 12, order_number: '1' } });
    const neither = await client.callTool({ name: 'link_submission_order', arguments: { result_id: 5 } });
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(requests).toBe(before);
  });

  it('turns an ambiguous number into a question with the candidates', async () => {
    next = { status: 400, body: { message: 'More than one order', parameters: { code: 'AMBIGUOUS_REF', details_json: '{"entity":"order","ref":"000001089","candidate_ids":[12,34]}' } } };
    const res = await client.callTool({ name: 'link_submission_order', arguments: { result_id: 5, order_number: '000001089' } });
    expect(res.isError).toBe(true);
    expect(texts(res).join('\n')).toMatch(/12, 34/);
    expect(texts(res).join('\n')).toMatch(/order_id/);
  });

  it('explains an older store that has no such command', async () => {
    next = { status: 404, body: { message: 'Unknown command "link-order".', parameters: { code: 'NOT_FOUND' } } };
    const res = await client.callTool({ name: 'link_submission_order', arguments: { result_id: 5, order_id: 12 } });
    expect(texts(res).join('\n')).toMatch(/does not support linking orders/);
  });
});

describe('linked orders in submission reads', () => {
  it('omits the block when the store sends null', async () => {
    next = { status: 200, body: summary(null) };
    const res = await client.callTool({ name: 'get_submission', arguments: { result_id: 5 } });
    expect(res.isError).toBeFalsy();
    expect(texts(res).join('\n')).not.toMatch(/linked[ _]orders/);
  });

  it('omits the block when an older store sends no field at all', async () => {
    next = { status: 200, body: summary(undefined) };
    const res = await client.callTool({ name: 'get_submission', arguments: { result_id: 5 } });
    expect(res.isError).toBeFalsy();
    expect(texts(res).join('\n')).not.toMatch(/linked[ _]orders/);
  });

  it('shows an empty list as an empty untrusted block in search results', async () => {
    next = { status: 200, body: { items: [summary('[]')], total_count: 1 } };
    const res = await client.callTool({ name: 'search_submissions', arguments: { form_id: 3 } });
    expect(texts(res).some((t) => /linked orders — untrusted remote content[^\]]*\]\n\[\]/.test(t))).toBe(true);
  });

  it('puts linked orders of a disclosed read in an untrusted block', async () => {
    next = { status: 200, body: summary(ALL_SOURCES) };
    const res = await client.callTool({ name: 'get_submission_full', arguments: { result_id: 5, grant_id: 4 } });
    expect(res.isError).toBeFalsy();
    expect(texts(res)[0]).not.toMatch(/000001089/);
    expect(texts(res).some((t) => /linked orders — untrusted remote content/.test(t) && /000001089/.test(t))).toBe(true);
  });

  it('keeps linked orders out of trusted text in other submission commands', async () => {
    next = { status: 200, body: summary(ALL_SOURCES) };
    const res = await client.callTool({ name: 'add_submission_note', arguments: { result_id: 5, text: 'called' } });
    expect(texts(res)[0]).not.toMatch(/000001089/);
  });

  it('passes linked_order_number through search_submissions', async () => {
    next = { status: 200, body: { items: [], total_count: 0 } };
    await client.callTool({ name: 'search_submissions', arguments: { form_id: 3, filter: { linked_order_number: '000001089' } } });
    expect(JSON.parse(String((lastBody.request as Record<string, unknown>).filter_json))).toEqual({ linked_order_number: '000001089' });
  });

  it('unlink sends the order id', async () => {
    next = { status: 200, body: summary('[]') };
    const res = await client.callTool({ name: 'unlink_submission_order', arguments: { result_id: 5, order_id: 12 } });
    expect(res.isError).toBeFalsy();
    expect((lastBody.request as Record<string, unknown>).order_id).toBe('12');
  });
});

describe('order ids with several stores', () => {
  it('refuses a bare order id without calling the store', async () => {
    const before = requests;
    const res = await shared.callTool({ name: 'unlink_submission_order', arguments: { site: 'acme', result_id: 'acme:5', order_id: 12 } });
    expect(res.isError).toBe(true);
    expect(texts(res).join('\n')).toMatch(/HANDLE_UNQUALIFIED/);
    expect(requests).toBe(before);
  });

  it('refuses an order id of another store', async () => {
    const before = requests;
    const res = await shared.callTool({ name: 'link_submission_order', arguments: { site: 'acme', result_id: 'acme:5', order_id: 'beta:12' } });
    expect(res.isError).toBe(true);
    expect(requests).toBe(before);
  });

  it('sends a qualified order id as the store\'s own number and returns linked orders qualified', async () => {
    next = { status: 200, body: summary(ALL_SOURCES) };
    const res = await shared.callTool({ name: 'link_submission_order', arguments: { site: 'acme', result_id: 'acme:5', order_id: 'acme:12' } });
    expect(res.isError).toBeFalsy();
    expect((lastBody.request as Record<string, unknown>).order_id).toBe('12');
    const block = texts(res).find((t) => /linked orders — untrusted remote content/.test(t)) ?? '';
    expect(block).toMatch(/"order_id": "acme:12"/);
    expect(block).not.toMatch(/"order_id": 12/);
  });

  it('qualifies linked orders in reads and the candidates of an ambiguous number', async () => {
    next = { status: 200, body: summary(ALL_SOURCES) };
    const read = await shared.callTool({ name: 'get_submission', arguments: { site: 'acme', result_id: 'acme:5' } });
    expect(texts(read).some((t) => /"order_id": "acme:13"/.test(t))).toBe(true);

    next = { status: 400, body: { message: 'More than one order', parameters: { code: 'AMBIGUOUS_REF', details_json: '{"entity":"order","ref":"000001089","candidate_ids":[12,34]}' } } };
    const ambiguous = await shared.callTool({ name: 'link_submission_order', arguments: { site: 'acme', result_id: 'acme:5', order_number: '000001089' } });
    expect(texts(ambiguous).join('\n')).toMatch(/acme:12, acme:34/);
  });
});
