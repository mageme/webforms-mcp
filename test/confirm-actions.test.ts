import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A development store with confirmActions: false runs irreversible actions without asking anyone. */
let http: Server;
let calls: string[] = [];
let asked = 0;

const connect = async (confirmActions?: boolean) => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k', confirmActions },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-confirm-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'confirm-actions-test', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    asked++;
    return { action: 'decline' };
  });
  await client.connect(b);
  return client;
};

beforeAll(async () => {
  http = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').replace(/^\/rest\/all/, '')}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 3, name: 'x', is_active: true }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(() => { http.close(); });

describe('confirmActions', () => {
  it('false: the action runs with no question and no confirmed_by_user', async () => {
    calls = [];
    asked = 0;
    const client = await connect(false);
    const result = await client.callTool({ name: 'deactivate_form', arguments: { form_id: 3 } });
    expect(asked, 'nobody was asked').toBe(0);
    expect(result.isError).toBeFalsy();
    expect(calls.some((c) => c.includes('/commands/activate')), 'the call went through').toBe(true);
    await client.close();
  });

  it('absent: the person is still asked', async () => {
    calls = [];
    asked = 0;
    const client = await connect();
    const result = await client.callTool({ name: 'deactivate_form', arguments: { form_id: 3, confirmed_by_user: true } });
    expect(asked).toBe(1);
    expect(result.isError).toBe(true);
    // before the question only reads go out (whether the form can be switched back on); nothing is written
    expect(calls.filter((c) => !c.startsWith('GET /V1/webforms/capabilities'))).toEqual(['GET /V1/webforms/forms/3']);
    await client.close();
  });
});
