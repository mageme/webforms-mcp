import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A call budget too short for any request to be sent.
vi.mock('../src/client.js', async (original) => ({ ...(await original<typeof import('../src/client.js')>()), CALL_BUDGET_MS: 400 }));
const { buildServer } = await import('../src/server.js');

/** A call whose time ran out before its request left says nothing was sent, and does not blame the connection. */
let http: Server;
let calls: string[] = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').replace(/^\/rest\/all/, '')}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 3, name: 'x', is_active: true, api_version: '1', has_executable_markup: false }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});
afterAll(() => { http.close(); });

it('does not blame the connection when the time ran out before anything was sent', async () => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-budget-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'budget-test', version: '0' });
  await client.connect(b);
  const text = JSON.stringify((await client.callTool({ name: 'get_form', arguments: { form_id: 3 } })).content);
  expect(text).toContain('Nothing was sent');
  expect(text).not.toContain('connectivity');
});
