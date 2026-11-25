import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/**
 * A store that refuses the import route answers prepare_import the way it answers every other tool: the code,
 * the HTTP status, the permission by the title the store owner sees, and where it is granted.
 */
const IMPORT_DENIAL = { message: "The consumer isn't authorized to access %resources.", parameters: { resources: 'MageMe_WebForms::api_v1_results_import' } };

let http: Server;
const refuseAll = (): [number, unknown] => [401, IMPORT_DENIAL];
let answer: (url: string) => [number, unknown] = refuseAll;
let client: Client;
let importRoot: string;

beforeAll(async () => {
  importRoot = mkdtempSync(join(tmpdir(), 'wfmcp-import-refusal-'));
  writeFileSync(join(importRoot, 'rows.jsonl'), '{"a":1}\n');
  process.env.WEBFORMS_MCP_IMPORT_ROOT = importRoot;
  http = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [status, payload] = answer(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-import-refusal-j-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'import-refusal-test', version: '0' });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  http.close();
  rmSync(importRoot, { recursive: true, force: true });
  delete process.env.WEBFORMS_MCP_IMPORT_ROOT;
});

type Answer = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>): Promise<Answer> =>
  (await client.callTool({ name, arguments: args })) as Answer;

describe('prepare_import refused by the store', () => {
  it('reads as every other route refusal: code, HTTP status, the permission title and where to grant it', async () => {
    const preview = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl' });
    const digest = (preview.structuredContent?.file as { sha256: string }).sha256;
    const res = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl', confirmed_digest: digest });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text.split('\n')[0]).toMatch(/^[^ ]+ ACTOR_NOT_ALLOWED \(HTTP 401\): The integration lacks "MageMe Extensions > WebForms > API > Import Submissions" \(MageMe_WebForms::api_v1_results_import\)\.$/);
    expect(text).toContain('"titles":{"MageMe_WebForms::api_v1_results_import":"MageMe Extensions > WebForms > API > Import Submissions"}');
    expect(text).toContain('System > Extensions > Integrations');
  });

  it('says the same as get_import_status does for that refusal', async () => {
    const preview = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl' });
    const digest = (preview.structuredContent?.file as { sha256: string }).sha256;
    const prepare = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl', confirmed_digest: digest });
    const status = await call('get_import_status', { import_id: 2 });
    expect(prepare.content[0].text).toBe(status.content[0].text);
  });
});

describe('prepare_import refused half way through the upload', () => {
  afterAll(() => { answer = refuseAll; });

  it('says which import it cancelled, then the refusal as every other tool reads it', async () => {
    const lacks = { message: 'The integration lacks the "MageMe_WebForms::api_v1_results_import" permission.', parameters: { code: 'ACTOR_NOT_ALLOWED', details_schema_version: '1', details_json: '{}' } };
    answer = (url) => (url.endsWith('/chunk') ? [403, lacks] : [200, { id: 7, form_id: 3, state: 'open' }]);
    const preview = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl' });
    const digest = (preview.structuredContent?.file as { sha256: string }).sha256;
    const res = await call('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl', confirmed_digest: digest });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('Import 7 was cancelled after the upload failed.\nACTOR_NOT_ALLOWED (HTTP 403): The integration lacks "MageMe Extensions > WebForms > API > Import Submissions" (MageMe_WebForms::api_v1_results_import).');
    expect(text).toContain('"titles":{"MageMe_WebForms::api_v1_results_import":"MageMe Extensions > WebForms > API > Import Submissions"}');
  });

  it('does not claim a cancellation that failed: it names the open import and the tool to close it', async () => {
    const lacks = { message: 'The integration lacks the "MageMe_WebForms::api_v1_results_import" permission.', parameters: { code: 'ACTOR_NOT_ALLOWED', details_schema_version: '1', details_json: '{}' } };
    answer = (url) => (url.endsWith('/chunk') ? [403, lacks] : url.endsWith('/commands/cancel') ? [500, { message: 'boom', parameters: { code: 'INTERNAL' } }] : [200, { id: 8, form_id: 3, state: 'open' }]);
    const preview = await call('prepare_import', { form_id: 4, source_system: 'wf3', file_path: 'rows.jsonl' });
    const digest = (preview.structuredContent?.file as { sha256: string }).sha256;
    const res = await call('prepare_import', { form_id: 4, source_system: 'wf3', file_path: 'rows.jsonl', confirmed_digest: digest });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).not.toContain('was cancelled');
    expect(text).toMatch(/cancelling it failed too .*import 8 is still open .*Run cancel_import with import_id 8/);
    expect(text).toContain('ACTOR_NOT_ALLOWED (HTTP 403)');
  });
});
