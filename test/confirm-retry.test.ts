import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/**
 * A confirmed send whose connection drops may already have reached the person's inbox. The retry with the same
 * confirmation_id must go out under the same request id, so the store replays instead of sending again.
 */
let stub: Server;
let client: Client;
let home = '';
let drop = 0;
const replies: string[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const reply = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (path.endsWith('/commands/prepare-reply')) return reply({ confirmation_token: 'tok-1', expires_at: '2099-01-01 00:00:00', impact_json: '{}' });
      if (path.endsWith('/commands/reply')) {
        replies.push(JSON.parse(body).request.request_id);
        if (drop > 0) { drop--; req.socket.destroy(); return; }
        return reply({ id: 5, revision: 3 });
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no route"}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;
  home = mkdtempSync(join(tmpdir(), 'wf-mcp-confirm-retry-'));
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, journalKey: 'k'.repeat(64) } as never, () => undefined, join(home, 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'retry', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((r) => stub.close(() => r()));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('send_reply after a lost connection', () => {
  it('retries with the same confirmation_id under the same request id', async () => {
    const prepared: any = await client.callTool({ name: 'prepare_reply', arguments: { result_id: 5, body_text: 'Hello' } });
    const confirmationId = prepared.structuredContent.confirmation_id;
    expect(confirmationId).toMatch(/^[0-9a-f]{16}$/);

    drop = 3; // every attempt the client makes inside the first call
    const args = { result_id: 5, body_text: 'Hello', expected_result_revision: 2, confirmation_id: confirmationId, confirmed_by_user: true };
    const first: any = await client.callTool({ name: 'send_reply', arguments: args });
    expect(first.isError).toBe(true);
    expect(replies.length).toBe(3);

    const second: any = await client.callTool({ name: 'send_reply', arguments: args });
    expect(second.isError, JSON.stringify(second.content)).toBeFalsy();
    expect(new Set(replies).size).toBe(1);

    // a final answer spends the approval
    const third: any = await client.callTool({ name: 'send_reply', arguments: args });
    expect(JSON.stringify(third.content)).toMatch(/Unknown or expired confirmation_id/);
  }, 20_000);
});
