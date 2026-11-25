import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

// A field code is stored as a letter, then letters, digits, "_", "-" or ":", up to 255 characters,
// and codes carried over from 3.x already look like that.
const CODE_255 = `billing-address:${'x'.repeat(255 - 'billing-address:'.length)}`;
const CODE_256 = `${CODE_255}x`;

/** Every input that names a field by its code, as a JSON-schema path inside the tool's inputSchema. */
const FIELD_CODE_INPUTS: [string, string][] = [
  ['draft_add_field', 'properties/code'],
  ['draft_add_field', 'properties/after_field_id/anyOf/1'],
  ['draft_update_field', 'properties/field_id/anyOf/1'],
  ['draft_turn_field_into', 'properties/field_id/anyOf/1'],
  ['draft_duplicate_field', 'properties/field_id/anyOf/1'],
  ['draft_remove_field', 'properties/field_id/anyOf/1'],
  ['draft_set_logic', 'properties/rules/items/properties/field_id/anyOf/1'],
  ['draft_add_logic', 'properties/rules/items/properties/field_id/anyOf/1'],
  ['export_submissions', 'properties/field_filter/items/properties/field/anyOf/1'],
  ['search_submissions', 'properties/field_filter/items/properties/field/anyOf/0'],
  ['request_pii_grant', 'properties/fields/items/anyOf/1'],
  ['update_submission_values', 'properties/values/propertyNames'],
];

let lastBody: Record<string, unknown> = {};
let http: Server;
let client: Client;

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastBody = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], total_count: 0 }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'wfmcp-fc-'));
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' },
    () => undefined, join(dir, 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'field-code-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
});

afterAll(() => { http.close(); });

const at = (node: unknown, path: string): Record<string, unknown> =>
  path.split('/').reduce<unknown>((n, key) => (n as Record<string, unknown> | undefined)?.[key], node) as Record<string, unknown>;

const text = (res: unknown): string => ((res as { content: { text: string }[] }).content[0]?.text ?? '');

describe('field code rule', () => {
  it('lets every field-code input take the stored length of 255', async () => {
    const { tools } = await client.listTools();
    for (const [name, path] of FIELD_CODE_INPUTS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const node = at(tool?.inputSchema, path);
      expect(node?.type, `${name} ${path}`).toBe('string');
      expect(node?.maxLength, `${name} ${path}`).toBe(255);
    }
  });

  it('sends a 255-character code with a hyphen and a colon to the store', async () => {
    lastBody = {};
    await client.callTool({ name: 'search_submissions', arguments: { form_id: 3, field_filter: [{ field: CODE_255, op: 'eq', value: 'x' }] } });
    expect(JSON.stringify(lastBody)).toContain(CODE_255);

    lastBody = {};
    await client.callTool({ name: 'draft_add_field', arguments: { draft_id: 4, expected_draft_revision: 1, type: 'text', code: CODE_255, after_field_id: CODE_255 } });
    expect(JSON.stringify(lastBody)).toContain(CODE_255);
  });

  it('refuses a 256-character code before calling the store', async () => {
    for (const [name, args] of [
      ['search_submissions', { form_id: 3, field_filter: [{ field: CODE_256, op: 'eq', value: 'x' }] }],
      ['draft_add_field', { draft_id: 4, expected_draft_revision: 1, type: 'text', code: CODE_256 }],
      ['draft_update_field', { draft_id: 4, expected_draft_revision: 1, field_id: CODE_256, settings: {} }],
      ['request_pii_grant', { form_id: 3, fields: [CODE_256], max_results: 1, purpose: 'audit', confirmed_by_user: true }],
    ] as [string, Record<string, unknown>][]) {
      lastBody = {};
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toMatch(/validation/i);
      expect(lastBody, name).toEqual({});
    }
  });
});
