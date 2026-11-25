import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/**
 * The store's phrases for empty translatable texts reach the agent as the store sent them: `defaults` beside the
 * texts and `defaults_locale` on the document and on a store view's translations. The bodies are the answers of
 * the WebForms API as captured from it (MCPTR6), wrapped the way the REST layer wraps them.
 */
const draftDocument = {
  defaults: { submit_button_text: 'Submit' },
  defaults_locale: 'en_US',
  fields: [
    { type: 'file', name: 'File 2', dropzone_text: null, field_id: 2000572262, defaults: { dropzone_text: 'Add files or drop here' } },
    { type: 'text', name: 'Text 4', min_length_validation_message: null, field_id: 2000572263, defaults: { min_length_validation_message: 'Please enter more or equal than %1 symbols.' } },
  ],
};
const liveDocument = {
  defaults_locale: 'en_US',
  confirmations: [{ uuid: 'a1f91df8-0f57-4513-a342-bebe03301642', name: 'Default confirmation', type: 'message', is_default: true, defaults: { message: 'Thank you! Your submission has been received.' } }],
};
const translations = { form: [], fieldsets: [], fields: [], logic: [], defaults: { form: { submit_button_text: 'Submit' } }, defaults_locale: 'en_US' };

const contents = {
  confirmations: [{ uuid: 'a1f91df8-0f57-4513-a342-bebe03301642', name: 'Default confirmation', type: 'message', is_default: true, message: null }],
  defaults: { 'a1f91df8-0f57-4513-a342-bebe03301642': { message: 'Thank you! Your submission has been received.' } },
  defaults_locale: 'en_US',
};
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

const BODIES: Record<string, unknown> = {
  '/V1/webforms/forms/3/confirmations/content/default': { store_code: 'default', contents_json: JSON.stringify(contents) },
  '/V1/webforms/forms/3/confirmations/commands/set-content': { form_id: 3, changed: true, payload_json: JSON.stringify({ confirmation_ref: 'a1f91df8-0f57-4513-a342-bebe03301642', store_code: 'default', message: null }) },
  '/V1/webforms/forms/3/notifications/commands/set-content': { form_id: 3, changed: true, payload_json: JSON.stringify({ notification_ref: '11111111-1111-4111-8111-111111111111' }) },
  '/V1/webforms/forms/3/document': { schema_version: '4.0', schema_digest: 'd', revision: 1, document_json: JSON.stringify(liveDocument) },
  '/V1/webforms/drafts/5/document': { schema_version: '4.0', schema_digest: 'd', revision: 2, document_json: JSON.stringify(draftDocument) },
  '/V1/webforms/forms/3/translations/default': { store_code: 'default', translations_json: JSON.stringify(translations) },
};

let http: Server;
let client: Client;

beforeAll(async () => {
  http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    const body = BODIES[path];
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST') posted.push({ path, body: JSON.parse(raw) as Record<string, unknown> });
    });
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { message: 'no route', parameters: { code: 'NOT_FOUND' } }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'phrase-defaults-test', version: '0' });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  http.close();
});

const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  return result.structuredContent as Record<string, unknown>;
};

describe('the storefront phrases reach the agent', () => {
  it('get_draft_document keeps defaults beside the form and each field, and their locale', async () => {
    const out = await call('get_draft_document', { draft_id: 5 });
    expect(out.document).toEqual(draftDocument);
  });

  it('get_form_document keeps the success message phrase of a confirmation', async () => {
    const out = await call('get_form_document', { form_id: 3 });
    expect(out.document).toEqual(liveDocument);
  });

  it('get_translations keeps the top-level defaults and their locale', async () => {
    const out = await call('get_translations', { form_id: 3, store_code: 'default' });
    expect(out.translations).toEqual(translations);
  });

  it('get_confirmation_content keeps each confirmation\'s own message and the phrases beside them', async () => {
    const out = await call('get_confirmation_content', { form_id: 3, store_code: 'default' });
    expect(out.contents).toEqual(contents);
  });

  it('set_confirmation_content sends the message for the store view, and null to give it back to the default', async () => {
    const uuid = 'a1f91df8-0f57-4513-a342-bebe03301642';
    await call('set_confirmation_content', { form_id: 3, confirmation: uuid, store_code: 'default', message: '<p>Danke!</p>' });
    const out = await call('set_confirmation_content', { form_id: 3, confirmation: uuid, store_code: 'default', message: null });
    expect(out.message).toBeNull();
    const sent = posted.filter((p) => p.path === '/V1/webforms/forms/3/confirmations/commands/set-content').map((p) => p.body.request as Record<string, unknown>);
    expect(sent.map(({ confirmation_ref, store_code, confirmation_json }) => ({ confirmation_ref, store_code, confirmation_json }))).toEqual([
      { confirmation_ref: uuid, store_code: 'default', confirmation_json: '{"message":"<p>Danke!</p>"}' },
      { confirmation_ref: uuid, store_code: 'default', confirmation_json: '{"message":null}' },
    ]);
    expect(new Set(sent.map((r) => r.request_id)).size).toBe(2);
  });

  it('set_confirmation_content sends a message set again after another as a new request', async () => {
    const uuid = 'a1f91df8-0f57-4513-a342-bebe03301642';
    const before = posted.length;
    for (const message of ['A', 'B', 'A']) await call('set_confirmation_content', { form_id: 3, confirmation: uuid, store_code: 'default', message });
    const ids = posted.slice(before).map((p) => (p.body.request as Record<string, unknown>).request_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size, 'the third call is not answered by the first one\'s replay').toBe(3);
  });

  it('set_notification_content sends a content set again after another as a new request', async () => {
    const before = posted.length;
    for (const subject of ['A', 'B', 'A']) await call('set_notification_content', { form_id: 3, notification: '11111111-1111-4111-8111-111111111111', store_code: 'default', content: { subject } });
    const ids = posted.slice(before).map((p) => (p.body.request as Record<string, unknown>).request_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size, 'the third call is not answered by the first one\'s replay').toBe(3);
  });

  it('the read tools and draft_set_translations name defaults and defaults_locale to the agent', async () => {
    const { tools } = await client.listTools();
    const described = (name: string): string => tools.find((t) => t.name === name)?.description ?? '';
    for (const name of ['get_form_document', 'get_draft_document', 'get_translations']) {
      expect(described(name), name).toMatch(/`defaults`/);
      expect(described(name), name).toMatch(/defaults_locale/);
    }
    const write = described('draft_set_translations');
    expect(write).toMatch(/equal to the phrase/i);
    expect(write).toMatch(/%1/);
  });
});
