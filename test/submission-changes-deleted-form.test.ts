import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A deleted form's change feed says so: form_deleted reaches the agent, so it knows to drop the form at the end. */
let http: Server;
let reply: Record<string, unknown> = {};

const connect = async () => {
  const server = buildServer(
    { baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-changes-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'changes-test', version: '0' });
  await client.connect(b);
  return client;
};

beforeAll(async () => {
  http = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(() => { http.close(); });

const page = { items: [{ result_id: 7, updated_at: '2026-10-20T10:00:00Z', kind: 'deleted' }], next_cursor: 'c', high_water_mark: '2026-10-20T10:00:05Z', has_more: false };

describe('list_submission_changes', () => {
  it('passes form_deleted on for a deleted form', async () => {
    reply = { ...page, form_deleted: true };
    const result = await (await connect()).callTool({ name: 'list_submission_changes', arguments: { form_id: 3 } });
    expect(JSON.parse((result.content as { text: string }[])[0].text).form_deleted).toBe(true);
  });

  it('says false for a live form, and for a store that does not send the field yet', async () => {
    reply = { ...page };
    const result = await (await connect()).callTool({ name: 'list_submission_changes', arguments: { form_id: 3 } });
    expect(JSON.parse((result.content as { text: string }[])[0].text).form_deleted).toBe(false);
  });
});
