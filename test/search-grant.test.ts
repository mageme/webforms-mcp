import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { GUIDANCE } from '../src/errors.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A search filtered by personal fields is let through by a grant (Submission.php reads request.grant_id); an export never is. */
let http: Server;
let bodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if ((req.url ?? '').includes('/results/search')) bodies.push((JSON.parse(body) as { request: Record<string, unknown> }).request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ api_version: '1', items: [], total_count: 0 }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});
afterAll(() => { http.close(); });

it('search_submissions passes grant_id to the store', async () => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-grant-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'grant-test', version: '0' });
  await client.connect(b);
  bodies = [];
  const r = await client.callTool({ name: 'search_submissions', arguments: { form_id: 3, field_filter: [{ field: 'email', op: 'eq', value: 'a@b.c' }], grant_id: 41 } });
  expect(r.isError).toBeFalsy();
  expect(bodies[0]?.grant_id).toBe(41);
});

it('the PII_GRANT_REQUIRED guidance says where a grant goes and that exports take none', () => {
  expect(GUIDANCE.PII_GRANT_REQUIRED).toMatch(/grant_id.*search_submissions/);
  expect(GUIDANCE.PII_GRANT_REQUIRED).toMatch(/[Ee]xports .*grant/);
});
