import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

let server: Server | undefined;

/** Records what the store was actually asked to do, so request ids can be compared. */
const recordingStore = async (bodies: Record<string, unknown>[]): Promise<string> => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (raw !== '') bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 7, result_revision: 4 }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const connect = async (baseUrl: string) => {
  const built = buildServer(
    { baseUrl, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', insecureTls: false, journalKey: 'jk' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-ident-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'identity-test', version: '0' });
  await Promise.all([built.connect(b), client.connect(a)]);
  return client;
};

const requestIds = (bodies: Record<string, unknown>[]): string[] =>
  bodies.map((b) => (b.request as { request_id: string }).request_id);

describe('journal identity covers what the request carries', () => {
  it('gives two approval verdicts on different revisions different request ids', async () => {
    // The revision travels in the body but used to be left out of the journal args, so the second call
    // replayed the first one's outcome instead of being sent.
    const bodies: Record<string, unknown>[] = [];
    const client = await connect(await recordingStore(bodies));
    const call = (expected_result_revision: number) => client.callTool({
      name: 'set_submission_approval',
      arguments: { result_id: 7, expected_result_revision, approval: 'approved', confirmed_by_user: true },
    });
    await call(3);
    await call(4);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].request).toMatchObject({ expected_result_revision: 4 });
    const [first, second] = requestIds(bodies);
    expect(second).not.toBe(first);
  });

  it('still replays the identical call rather than sending it twice', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = await connect(await recordingStore(bodies));
    const call = () => client.callTool({
      name: 'set_submission_approval',
      arguments: { result_id: 7, expected_result_revision: 3, approval: 'approved', confirmed_by_user: true },
    });
    await call();
    await call();
    const [first, second] = requestIds(bodies);
    expect(second).toBe(first);
  });
});
