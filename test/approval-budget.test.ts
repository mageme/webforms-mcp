import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A call budget short enough that a person's answer outlasts it.
vi.mock('../src/client.js', async (original) => ({ ...(await original<typeof import('../src/client.js')>()), CALL_BUDGET_MS: 1500 }));
const { buildServer } = await import('../src/server.js');

/** The time a person spends reading the question is theirs, not the call's: after "yes" the action still goes out. */
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

it('sends the approved action when the person answers after the call budget', async () => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-budget-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'budget-test', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    await new Promise((r) => setTimeout(r, 1800));
    return { action: 'accept', content: { proceed: true } };
  });
  await client.connect(b);
  calls = [];
  const result = await client.callTool({ name: 'activate_form', arguments: { form_id: 3 } });
  expect(JSON.stringify(result.content)).not.toContain('ran out');
  expect(calls.some((c) => c.startsWith('POST') && c.includes('activate'))).toBe(true);
});

