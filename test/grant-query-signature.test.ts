import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { rfc3986, signatureBase } from '../src/oauth.js';

/**
 * The store checks a request's signature against what arrived on the wire: the URL without its query as the
 * base URI, and every query parameter beside the oauth_* ones. A grant id must therefore travel as a query
 * parameter the client signs, or the store refuses the request as a bad signature.
 */
const SECRETS = { consumerSecret: 'cs', accessTokenSecret: 'ats' };
let http: Server;

const verified = (req: IncomingMessage): boolean => {
  const header = req.headers.authorization ?? '';
  const oauth = Object.fromEntries([...header.matchAll(/([a-z_]+)="([^"]*)"/g)].map((m) => [decodeURIComponent(m[1]), decodeURIComponent(m[2])]));
  const { oauth_signature: received, ...params } = oauth;
  const wire = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const base = signatureBase({ method: req.method ?? 'GET', url: `${wire.origin}${wire.pathname}`, query: [...wire.searchParams.entries()] }, params);
  const key = `${rfc3986(SECRETS.consumerSecret)}&${rfc3986(SECRETS.accessTokenSecret)}`;
  return received === createHmac('sha256', key).update(base).digest('base64');
};

const connect = async () => {
  const server = buildServer(
    {
      baseUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
      consumerKey: 'ck', consumerSecret: SECRETS.consumerSecret, accessToken: 'at', accessTokenSecret: SECRETS.accessTokenSecret,
      insecureTls: false, journalKey: 'k',
    },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-grantsig-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'grant-signature-test', version: '0' }, { capabilities: {} });
  await client.connect(b);
  return client;
};

beforeAll(async () => {
  http = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const ok = verified(req);
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { items: [], id: 7, values_json: '{"fields":[]}' } : { message: 'The signature is invalid. Verify and try again.' }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(() => { http.close(); });

type Answer = { isError?: boolean; content: Array<{ text: string }> };
const call = async (name: string, args: Record<string, unknown>): Promise<Answer> => {
  const client = await connect();
  try {
    return (await client.callTool({ name, arguments: args })) as Answer;
  } finally {
    await client.close();
  }
};

describe('a grant id is signed like every other query parameter', () => {
  it('the test store accepts a signed query: get_submission_full with a grant', async () => {
    const res = await call('get_submission_full', { result_id: 7, grant_id: 42 });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
  });

  it('notes without a grant are signed and accepted', async () => {
    const res = await call('list_submission_notes', { result_id: 7 });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
  });

  it.each(['list_submission_notes', 'list_submission_attachments'])('%s with a grant is signed and accepted', async (name) => {
    const res = await call(name, { result_id: 7, grant_id: 42 });
    expect(res.isError, res.content[0]?.text).toBeFalsy();
  });
});
