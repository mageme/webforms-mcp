import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An approval whose first send lost its answer stays usable past the token's expiry: the retry goes out under the
 * same request id, and the store answers with the first outcome instead of the model being sent to prepare again.
 */
let http: Server; const calls: string[] = []; let dropReply = true;
const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
beforeAll(async () => {
  http = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const url = (req.url ?? '').replace(/^\/rest\/all/, '');
      const rid = (() => { try { return JSON.parse(body).request.request_id; } catch { return ''; } })();
      calls.push(`${req.method} ${url} ${rid}`);
      if (url.includes('capabilities')) return send(res, 200, { api_version: '1.0' });
      if (url.endsWith('/prepare-reply')) {
        const exp = new Date(Date.now() + 1500).toISOString().replace('T', ' ').slice(0, 19);
        return send(res, 200, { confirmation_token: 'tok-1', expires_at: exp, impact_json: JSON.stringify({ recipient: 'j***@x.com', body: 'hi', result_revision: 4 }) });
      }
      if (url.endsWith('/commands/reply')) {
        if (dropReply) { req.socket.destroy(); return; }
        return send(res, 200, { outbox_id: 1, state: 'sent', message_id: 'm', recipient_masked: 'j***@x.com' });
      }
      send(res, 404, { message: 'no' });
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});
afterAll(() => { http.close(); });

it('a lost send_reply retried after the token expiry is replayed by the store, not refused locally', async () => {
  const server = buildServer({ baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' } as never, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-expired-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'p', version: '0' });
  await client.connect(b);
  const prep = (await client.callTool({ name: 'prepare_reply', arguments: { result_id: 7, body_text: 'hi' } })) as { structuredContent: { confirmation_id: string } };
  const cid = prep.structuredContent.confirmation_id;
  const first = (await client.callTool({ name: 'send_reply', arguments: { result_id: 7, body_text: 'hi', expected_result_revision: 4, confirmation_id: cid, confirmed_by_user: true } })) as { content: Array<{ text: string }> };
  expect(first.content[0].text).toContain('NETWORK');
  const sentFirst = calls.filter((c) => c.includes('/commands/reply')).length;
  dropReply = false;
  await new Promise((r) => setTimeout(r, 1700));
  const second = (await client.callTool({ name: 'send_reply', arguments: { result_id: 7, body_text: 'hi', expected_result_revision: 4, confirmation_id: cid, confirmed_by_user: true } })) as { isError?: boolean; content: Array<{ text: string }> };
  const sends = calls.filter((c) => c.includes('/commands/reply'));
  expect(sends.length).toBeGreaterThan(sentFirst);
  expect(new Set(sends.map((c) => c.split(' ')[2])).size).toBe(1);
  expect(second.isError).toBeFalsy();
});
