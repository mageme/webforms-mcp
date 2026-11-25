import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `confirmed_by_user` is the model's word that a person agreed - the model is the one thing that
 * cannot certify that about itself. When the client can carry a question to the person, the server
 * asks them and their answer decides. This holds both halves of that: the person's "no" stops an
 * action the model claimed was approved, and the person's "yes" is enough on its own.
 */
let http: Server;
let calls: string[] = [];
let asked: string[] = [];
let answer: 'accept' | 'decline' = 'accept';

const connect = async () => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-elicit-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'elicitation-test', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(request.params.message);
    return answer === 'accept' ? { action: 'accept', content: { proceed: true } } : { action: 'decline' };
  });
  await client.connect(b);
  return client;
};

beforeAll(async () => {
  http = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').replace(/^\/rest\/all/, '')}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 3, name: 'x', is_active: true }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(() => { http.close(); });

describe('a client that can reach a person is asked instead of trusted', () => {
  it('stops an action the person declines, however the model filled the argument', async () => {
    answer = 'decline';
    calls = [];
    asked = [];
    const client = await connect();
    const result = await client.callTool({ name: 'activate_form', arguments: { form_id: 3, confirmed_by_user: true } });
    expect(asked.length, 'the person was asked').toBe(1);
    expect(asked[0]).toContain('Switching a form on makes it public immediately');
    expect(result.isError, 'and the refusal is the tool result').toBe(true);
    // the form's settings are read to show them in the question; nothing is written
    expect(calls.filter((c) => !c.startsWith('GET ')), 'nothing was written to the store').toEqual([]);
    await client.close();
  });

  it("takes the person's yes on its own, without the model asserting anything", async () => {
    answer = 'accept';
    calls = [];
    asked = [];
    const client = await connect();
    const result = await client.callTool({ name: 'deactivate_form', arguments: { form_id: 3 } });
    expect(asked.length).toBe(1);
    expect(result.isError).toBeFalsy();
    expect(calls.some((c) => c.includes('/commands/activate')), 'the call went through').toBe(true);
    await client.close();
  });
});
