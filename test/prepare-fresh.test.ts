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
 * The store keeps the answer of a request id that is not flagged secret and hands it back for the same id
 * (RequestIdempotency). prepare-remove-field is such a prepare: asked twice under one id, it answers with the
 * first list of references and the first token, which the removal then refuses. Every prepare must therefore
 * ask the store anew each time.
 */
let stub: Server;
let home = '';
let references = [{ kind: 'notification', id: 9, name: 'Sales Inquiry' }];
let issued = 0;
const stored = new Map<string, unknown>();
const prepareIds: string[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'wf-mcp-prepare-fresh-'));
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const request = (() => { try { return (JSON.parse(body) as { request?: Record<string, unknown> }).request ?? {}; } catch { return {}; } })();
      const send = (status: number, answer: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      if (path.endsWith('/capabilities')) return send(200, { api_version: '1.0' });
      if (path.endsWith('/drafts/8/commands/prepare-remove-field')) {
        const id = String(request.request_id ?? '');
        prepareIds.push(id);
        if (!stored.has(id)) {
          issued++;
          stored.set(id, { draft_id: 8, draft_revision: 2, changed: false, payload_json: JSON.stringify({ requires_confirmation: true, confirmation_token: `tok-${issued}`, expires_at: '2099-01-01 00:00:00', references }) });
        }
        return send(200, stored.get(id));
      }
      return send(404, { message: 'no route' });
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  if (home) rmSync(home, { recursive: true, force: true });
});

const client = async (): Promise<Client> => {
  const port = (stub.address() as AddressInfo).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, journalKey: 'k'.repeat(64) } as never, () => undefined, join(mkdtempSync(join(home, 'j-')), 'journal.jsonl'));
  const c = new Client({ name: 'prepare-fresh', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
};

describe('a prepare asks the store anew', () => {
  it('draft_remove_field shows the references as they are now, not the answer of an earlier identical call', async () => {
    const c = await client();
    const args = { draft_id: 8, expected_draft_revision: 2, field_id: 'email' };
    const first: any = await c.callTool({ name: 'draft_remove_field', arguments: args });
    expect(first.structuredContent.references_count).toBe(1);
    references = [...references, { kind: 'pdf', id: 3, name: 'Invoice' }];
    const second: any = await c.callTool({ name: 'draft_remove_field', arguments: args });
    expect(second.structuredContent.references_count).toBe(2);
    expect(new Set(prepareIds).size).toBe(prepareIds.length);
    expect(issued).toBe(2);
    await c.close();
  }, 30_000);
});
