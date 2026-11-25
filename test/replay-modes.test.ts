import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { acceptingClient } from './accepting-client.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { Journal, type Replay } from '../src/journal.js';

/**
 * Which journal rule each write tool runs under, as the tool really passes it: true replays a fresh success,
 * false reuses only a pending request, 'value' reuses a pending one nothing has overtaken. A new write tool, or a
 * changed mode, fails here until this table says so.
 */
const MODES: Record<string, Record<string, Replay>> = {
  create_form: { create_form: true },
  create_form_from_template: { create_form_from_template: true },
  duplicate_form: { duplicate_form: true },
  activate_form: { activate_form: 'value' },
  deactivate_form: { activate_form: 'value' },
  prepare_import: { prepare_import: false, import_chunk: false, import_finalize: false },
  commit_import: { commit_import: false },
  cancel_import: { cancel_import: false },
  update_appearance: { update_appearance: 'value' },
  open_draft: { open_draft: false },
  restore_version: { restore_version: false },
  draft_discard: { draft_discard: true },
  draft_update_form: { 'draft:update-form': true },
  draft_add_section: { 'draft:add-fieldset': true },
  draft_update_section: { 'draft:update-fieldset': true },
  draft_remove_section: { 'draft:remove-fieldset': true },
  draft_reorder: { 'draft:reorder': true },
  draft_add_field: { 'draft:add-field': true },
  draft_update_field: { 'draft:update-field': true },
  draft_turn_field_into: { 'draft:turn-into': true },
  draft_duplicate_field: { 'draft:duplicate-field': true },
  draft_remove_field: { 'draft:remove-field': true },
  draft_restore_field: { 'draft:restore-field': true },
  draft_set_logic: { 'draft:set-logic': true },
  draft_add_logic: { 'draft:add-logic': true },
  draft_remove_logic: { 'draft:remove-logic': true },
  draft_set_translations: { 'draft:set-translations': true },
  draft_replace_document: { 'draft:replace-document': true },
  draft_prepare_publish: { draft_prepare_publish: true },
  draft_publish: { draft_publish: true },
  add_notification: { 'notification:add': true },
  update_notification: { 'notification:update': 'value' },
  set_notification_content: { 'notification:set-content': 'value' },
  set_notification_store_settings: { 'notification:set-store-settings': 'value' },
  set_notification_conditions: { 'notification:set-conditions': 'value' },
  duplicate_notification: { 'notification:duplicate': true },
  remove_notification: { 'notification:remove': true },
  activate_notification: { 'activate_notification:prepare': true, 'activate_notification:confirm': true },
  deactivate_notification: { deactivate_notification: 'value' },
  set_confirmation_content: { 'confirmation:set-content': 'value' },
  update_submission_values: { 'result:update-values': true },
  set_submission_status: { 'result:set-status': true },
  set_submission_approval: { set_submission_approval: true },
  assign_submission: { 'result:assign': true },
  mark_submission: { 'result:mark-read': true },
  add_submission_note: { 'result:add-note': true },
  link_submission_order: { 'result:link-order': 'value' },
  unlink_submission_order: { 'result:unlink-order': 'value' },
  mass_status: { mass_status: 'value' },
  mass_assign: { mass_assign: true },
  mass_read: { mass_read: true },
  prepare_reply: { prepare_reply: true },
  send_reply: { prepare_reply: true, send_reply: true },
  request_pii_grant: { request_pii_grant: false },
  revoke_pii_grant: { revoke_pii_grant: true },
  export_submissions: { export_submissions: true },
};

/** Tools that create a new object: they take idempotency_key and answer with idempotency.outcome. */
const CREATIONS = ['add_notification', 'add_submission_note', 'create_form', 'create_form_from_template', 'duplicate_form', 'duplicate_notification', 'export_submissions'];

/** Draft commands that add something: the draft revision plays the key's part, so no key, but the same status. */
const DRAFT_CREATIONS = ['draft_add_field', 'draft_add_logic', 'draft_add_section', 'draft_duplicate_field'];

/** Tools that only read: they never enter the journal. */
const READS = new Set([
  'list_sites', 'use_site', 'get_capabilities', 'get_appearance', 'get_import_status', 'list_forms', 'get_form', 'get_form_document', 'list_form_versions',
  'get_form_version_document', 'get_translations', 'get_confirmation_content', 'list_templates', 'get_schema', 'list_statuses',
  'list_quick_responses', 'get_form_stats', 'list_submission_changes', 'search_submissions', 'get_submission', 'list_submission_notes',
  'list_submission_attachments', 'get_draft', 'get_draft_document', 'draft_list_trash', 'draft_validate', 'get_submission_full', 'get_export_status',
]);

const UUID = '33333333-3333-4333-8333-333333333333';
const future = () => new Date(Date.now() + 600_000).toISOString();
const answer = (path: string): unknown => {
  if (path.endsWith('/commands/discard') || path.endsWith('/revoke') || path.endsWith('/activation/confirm')) return true;
  if (path.endsWith('/prepare-reply')) return { confirmation_token: 'reply-tok', expires_at: future(), impact_json: JSON.stringify({ recipient: 'j***@example.com', body: 'hi', result_revision: 1 }) };
  if (path.endsWith('/prepare-publish')) return { confirmation_token: 'pub-tok', expires_at: future(), impact_json: '[]', requires_confirmation: false };
  if (path.endsWith('/activation/prepare')) return { confirmation_token: 'act-tok', expires_at: future(), diff_json: '{}', first_activation: true };
  if (path.endsWith('/pii-grants')) return { grant_id: 1, expires_at: future() };
  return { id: 1, form_id: 3, changed: true, payload_json: '{}', state: 'validated', rows_total: 0 };
};

const begun: Array<{ operation: string; replay: Replay }> = [];
let http: Server;
let client: Client;
let importRoot: string;

beforeAll(async () => {
  importRoot = mkdtempSync(join(tmpdir(), 'wfmcp-modes-import-'));
  writeFileSync(join(importRoot, 'rows.jsonl'), '{"a":1}\n');
  process.env.WEBFORMS_MCP_IMPORT_ROOT = importRoot;
  const claim = Journal.prototype.claim;
  vi.spyOn(Journal.prototype, 'claim').mockImplementation(function (this: Journal, operation: string, args: unknown, replay: Replay = true, ...rest: unknown[]) {
    begun.push({ operation, replay });
    return (claim as (...a: unknown[]) => ReturnType<Journal['claim']>).call(this, operation, args, replay, ...rest);
  });
  http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer(path)));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const server = buildServer({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-modes-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = acceptingClient('replay-modes-test');
  await client.connect(b);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
  http.close();
  rmSync(importRoot, { recursive: true, force: true });
  delete process.env.WEBFORMS_MCP_IMPORT_ROOT;
});

const draft = { draft_id: 5, expected_draft_revision: 1 };
const result = { result_id: 4, expected_result_revision: 1 };
const items = [{ result_id: 4, expected_result_revision: 1 }];
const yes = { confirmed_by_user: true };
/** One valid call per write tool; a tool with two steps lists both. */
const CALLS: Record<string, () => Promise<Array<Record<string, unknown>>>> = {
  create_form: async () => [{ document: { name: 'A' } }],
  create_form_from_template: async () => [{ template_code: 'contact', name: 'A' }],
  duplicate_form: async () => [{ form_id: 3 }],
  activate_form: async () => [{ form_id: 3, ...yes }],
  deactivate_form: async () => [{ form_id: 3, ...yes }],
  prepare_import: async () => {
    const first = await structured('prepare_import', { form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl' });
    return [{ form_id: 3, source_system: 'wf3', file_path: 'rows.jsonl', confirmed_digest: (first.file as { sha256: string }).sha256 }];
  },
  commit_import: async () => [{ import_id: 2, ...yes }],
  cancel_import: async () => [{ import_id: 2, ...yes }],
  update_appearance: async () => [{ tokens: { 'button-radius': 4 }, ...yes }],
  open_draft: async () => [{ form_id: 3 }],
  restore_version: async () => [{ form_id: 3, version_id: 2, expected_live_revision: 1 }],
  draft_discard: async () => [{ ...draft, ...yes }],
  draft_update_form: async () => [{ ...draft, settings: { name: 'A' } }],
  draft_add_section: async () => [{ ...draft }],
  draft_update_section: async () => [{ ...draft, section_id: 2, settings: { name: 'A' } }],
  draft_remove_section: async () => [{ ...draft, section_id: 2 }],
  draft_reorder: async () => [{ ...draft, positions: { sections: [{ id: 2, position: 0 }] } }],
  draft_add_field: async () => [{ ...draft, section_id: 2, type: 'text' }],
  draft_update_field: async () => [{ ...draft, field_id: 'email', settings: { name: 'A' } }],
  draft_turn_field_into: async () => [{ ...draft, field_id: 'email', target_type: 'textarea' }],
  draft_duplicate_field: async () => [{ ...draft, field_id: 'email' }],
  draft_remove_field: async () => [{ ...draft, field_id: 'email' }],
  draft_restore_field: async () => [{ ...draft, trash_ref: 'draft:7' }],
  draft_set_logic: async () => [{ ...draft, rules: [] }],
  draft_add_logic: async () => [{ ...draft, rules: [{ field_id: 1, logic_condition: 'equal', action: 'show', value: 'x', target: 'submit' }] }],
  draft_remove_logic: async () => [{ ...draft, logic_id: 3 }],
  draft_set_translations: async () => [{ ...draft, store_code: 'de', translations: {} }],
  draft_replace_document: async () => [{ ...draft, document: { name: 'A' }, ...yes }],
  draft_prepare_publish: async () => [{ ...draft, expected_live_revision: 1 }],
  draft_publish: async () => [{ ...draft, expected_live_revision: 1, ...yes }],
  add_notification: async () => [{ form_id: 3, notification: { name: 'A' } }],
  update_notification: async () => [{ form_id: 3, notification: UUID, patch: { name: 'A' } }],
  set_notification_content: async () => [{ form_id: 3, notification: UUID, content: { subject: 'A' } }],
  set_notification_store_settings: async () => [{ form_id: 3, notification: UUID, store_code: 'de', settings: { enabled: false } }],
  set_notification_conditions: async () => [{ form_id: 3, notification: UUID, conditions: [] }],
  duplicate_notification: async () => [{ form_id: 3, notification: UUID }],
  remove_notification: async () => [{ form_id: 3, notification: UUID, ...yes }],
  activate_notification: async () => {
    const prepared = await structured('activate_notification', { notification_id: 9 });
    return [{ notification_id: 9, confirmation_id: prepared.confirmation_id, ...yes }];
  },
  deactivate_notification: async () => [{ notification_id: 9, ...yes }],
  set_confirmation_content: async () => [{ form_id: 3, confirmation: UUID, store_code: 'de', message: 'Thanks' }],
  update_submission_values: async () => [{ ...result, values: { email: 'a' }, ...yes }],
  set_submission_status: async () => [{ ...result, status_code: 'done' }],
  set_submission_approval: async () => [{ ...result, approval: 'approved', ...yes }],
  assign_submission: async () => [{ ...result, admin_user_id: 1 }],
  mark_submission: async () => [{ ...result, state: 'read' }],
  add_submission_note: async () => [{ result_id: 4, text: 'note' }],
  link_submission_order: async () => [{ result_id: 4, order_id: 12 }],
  unlink_submission_order: async () => [{ result_id: 4, order_id: 12 }],
  mass_status: async () => [{ items, status_code: 'done' }],
  mass_assign: async () => [{ items, admin_user_id: 1 }],
  mass_read: async () => [{ items, state: 'read' }],
  prepare_reply: async () => [{ result_id: 4, body_text: 'hi' }],
  send_reply: async () => {
    const prepared = await structured('prepare_reply', { result_id: 4, body_text: 'hi' });
    return [{ result_id: 4, body_text: 'hi', expected_result_revision: 1, confirmation_id: prepared.confirmation_id, ...yes }];
  },
  request_pii_grant: async () => [{ form_id: 3, fields: ['email'], max_results: 1, purpose: 'reply to the customer' }],
  revoke_pii_grant: async () => [{ grant_id: 1 }],
  export_submissions: async () => [{ form_id: 3 }],
};

const structured = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, `${name}: ${JSON.stringify(res.content)}`).toBe(false);
  return (res.structuredContent ?? {}) as Record<string, unknown>;
};

describe('journal mode of every write tool', () => {
  it('every tool is either a read or listed with its modes', async () => {
    const { tools } = await client.listTools();
    const unlisted = tools.map((t) => t.name).filter((name) => !READS.has(name) && !(name in MODES));
    expect(unlisted, 'a new write tool needs its journal modes in MODES').toEqual([]);
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(MODES).sort());
    const keyed = tools.filter((t) => 'idempotency_key' in ((t.inputSchema.properties ?? {}) as object)).map((t) => t.name).sort();
    expect(keyed, 'the creation tools, and only they, take idempotency_key').toEqual(CREATIONS);
  });

  for (const [tool, modes] of Object.entries(MODES)) {
    it(tool, async () => {
      begun.length = 0;
      const calls = await CALLS[tool]();
      for (const args of calls) await structured(tool, args);
      expect(Object.fromEntries(begun.map((b) => [b.operation, b.replay]))).toEqual(modes);
    });
    if (DRAFT_CREATIONS.includes(tool)) {
      it(`${tool} answers how what it added came about`, async () => {
        const calls = await CALLS[tool]();
        const answer = await structured(tool, { ...calls[calls.length - 1], expected_draft_revision: 900 + DRAFT_CREATIONS.indexOf(tool) });
        expect((answer.idempotency as { outcome?: unknown } | undefined)?.outcome).toBe('created');
      });
    }
    if (CREATIONS.includes(tool)) {
      it(`${tool} answers how the object came about`, async () => {
        const calls = await CALLS[tool]();
        const answer = await structured(tool, { ...calls[calls.length - 1], idempotency_key: `modes-${tool}` });
        expect((answer.idempotency as { outcome?: unknown } | undefined)?.outcome).toBe('created');
      });
    }
  }
});
