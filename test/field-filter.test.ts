import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { FIELD_FILTER_OPS, fieldFilterJson } from '../src/tools/read.js';

/** Path to the WebForms module's FilterAst.php; when set, the offered operators are checked against the server's list. */
const FILTER_AST = process.env.WEBFORMS_FILTER_AST;

let lastBody: Record<string, unknown> = {};
let http: Server;
let client: Client;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], total_count: 0 }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'wfmcp-ff-'));
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined, join(dir, 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'field-filter-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
});

afterAll(() => { http.close(); });

describe('field filter operators', () => {
  it('offers only operators the server knows, with contains standing for like', () => {
    const offered = FIELD_FILTER_OPS.map((op) => (op === 'contains' ? 'like' : op));
    expect(FIELD_FILTER_OPS).not.toContain('is_not_empty');
    if (!FILTER_AST || !existsSync(FILTER_AST)) return;
    const match = /const OPS = \[([^\]]+)\]/.exec(readFileSync(FILTER_AST, 'utf8'));
    const server = [...(match?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(server.length).toBeGreaterThan(0);
    for (const op of offered) expect(server).toContain(op);
  });

  it('sends contains to the server as like and leaves the others alone', () => {
    expect(JSON.parse(fieldFilterJson([{ op: 'contains', field: 'a', value: 'x' }, { op: 'is_empty', field: 'b' }]) ?? '')).toEqual([
      { op: 'like', field: 'a', value: 'x' }, { op: 'is_empty', field: 'b' },
    ]);
    expect(fieldFilterJson(undefined)).toBeNull();
  });

  it('search_submissions delivers the translated operator', async () => {
    await client.callTool({ name: 'search_submissions', arguments: { form_id: 3, field_filter: [{ field: 'note', op: 'contains', value: 'sofa' }] } });
    const request = lastBody.request as Record<string, unknown>;
    expect(JSON.parse(String(request.field_filter_json))).toEqual([{ field: 'note', op: 'like', value: 'sofa' }]);
  });

  it('search_submissions refuses is_not_empty before the server is called', async () => {
    const res = await client.callTool({ name: 'search_submissions', arguments: { form_id: 3, field_filter: [{ field: 'note', op: 'is_not_empty' }] } });
    expect(res.isError).toBe(true);
  });
});
