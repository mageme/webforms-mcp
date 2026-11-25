import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A model is shown what the credential is allowed to see — the same as every other form builder's MCP
 * server does — so the store owner decides by choosing which integration the server runs as. What these
 * tools do owe is precision: the projection is named rather than left to a default that could change,
 * and a pass, where one is named, is what carries the request.
 */
let http: Server;
let calls: string[] = [];

const connect = async () => {
  const server = buildServer(
    {
      baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
      consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as',
      insecureTls: false, journalKey: 'k',
    },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-egress-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'pii-egress-test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return client;
};

beforeAll(async () => {
  http = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').replace(/^\/rest\/all/, '')}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], total_count: 0, id: 3, values_json: '{"fields":[]}' }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(() => { http.close(); });

const urlFor = (fragment: string) => calls.find((c) => c.includes(fragment)) ?? '';

describe('what leaves for the model', () => {
  it('a named pass travels with the request', async () => {
    calls = [];
    const client = await connect();
    await client.callTool({ name: 'list_submission_notes', arguments: { result_id: 7, grant_id: 42 } });
    await client.callTool({ name: 'list_submission_notes', arguments: { result_id: 8 } });

    expect(urlFor('/results/7/notes'), 'the pass is what authorizes it').toContain('grantId=42');
    expect(urlFor('/results/8/notes'), 'and without one nothing is invented').not.toContain('grantId');
    await client.close();
  });

  it('the summary projection is named, not left to the server', async () => {
    calls = [];
    const client = await connect();
    await client.callTool({ name: 'get_submission', arguments: { result_id: 7 } });

    expect(urlFor('/V1/webforms/results/7'), 'the projection is spelled out').toContain('projection=summary');
    await client.close();
  });
});
