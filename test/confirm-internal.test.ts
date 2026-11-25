import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The store records a confirmed write that failed with 500 INTERNAL as INDETERMINATE (RequestIdempotency): it may have
 * sent the email. The answer says so, instead of "retry later", which after a new prepare would send a second email.
 */
let http: Server;
const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
beforeAll(async () => {
  http = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('capabilities')) return send(res, 200, { api_version: '1' });
      if (url.endsWith('/prepare-reply')) return send(res, 200, { confirmation_token: 'tok-1', expires_at: '2099-01-01 00:00:00', impact_json: JSON.stringify({ recipient: 'j***@x.com', body: 'hi', result_revision: 4 }) });
      if (url.endsWith('/commands/reply')) return send(res, 500, { message: 'Internal error', parameters: { code: 'INTERNAL', details_json: JSON.stringify({ correlation_id: 'c1' }) } });
      send(res, 404, { message: 'no' });
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});
afterAll(() => { http.close(); });

it('a confirmed send_reply answered 500 INTERNAL is reported as possibly applied', async () => {
  const server = buildServer({ baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-internal-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'p', version: '0' });
  await client.connect(b);
  const prep = (await client.callTool({ name: 'prepare_reply', arguments: { result_id: 7, body_text: 'hi' } })) as { structuredContent: { confirmation_id: string } };
  const r = (await client.callTool({ name: 'send_reply', arguments: { result_id: 7, body_text: 'hi', expected_result_revision: 4, confirmation_id: prep.structuredContent.confirmation_id, confirmed_by_user: true } })) as { content: Array<{ text: string }> };
  expect(r.content[0].text).toContain('INDETERMINATE');
  expect(r.content[0].text).toMatch(/may or may not/);
  expect(r.content[0].text).not.toMatch(/retry later/);
});
