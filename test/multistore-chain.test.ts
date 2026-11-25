import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServerFrom } from '../src/server.js';
import { SiteRegistry } from '../src/registry.js';
import { SiteContextFactory } from '../src/context.js';

/**
 * Two stores in one process: every id an answer hands out must be accepted back by the next call, the store
 * must receive the bare number, and an id of the other store must be refused before any request leaves.
 */
interface Seen { method: string; path: string; body: string }
const seen: Record<string, Seen[]> = { acme: [], beta: [] };

const stub = (key: string): Server => createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '');
    const u = new URL(req.url ?? '/', 'http://x');
    seen[key].push({ method: req.method ?? '', path: path + u.search, body });
    const reply = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (path.endsWith('/draft') && req.method === 'POST') return reply({ draft_id: 11, live_id: 3, draft_revision: 1, live_revision: 1 });
    const cmd = /\/drafts\/(\d+)\/commands\/(.+)$/.exec(path);
    if (cmd) {
      const payload: Record<string, unknown> = { 'add-fieldset': { fieldset_id: 5 }, 'add-field': { field_id: 12 }, 'duplicate-field': { field_id: 13 }, 'add-logic': { logic_id: 7 } }[cmd[2]] ?? {};
      return reply({ draft_id: Number(cmd[1]), draft_revision: 2, changed: true, payload_json: JSON.stringify(payload) });
    }
    if (/\/pii-grants$/.test(path)) return reply({ grant_id: 9, form_id: 3, expires_at: '2099-01-01 00:00:00' });
    if (path.endsWith('/results/6')) return reply({ id: 6, form_id: 3, values: { name: 'Ann' } });
    if (path.endsWith('/results/6/notes')) return reply({ items: [{ id: 1, author: 'a', text: 'hello' }], total_count: 1 });
    if (path.endsWith('/results/6/attachments')) return reply({ items: [{ attachment_id: 2, field_id: 3, name: 'cv.pdf' }], total_count: 1 });
    if (/\/(notes|attachments)$/.test(path)) return reply({ items: [], total_count: 0 });
    if (/\/results\/search$/.test(path) || /\/results\/export$/.test(path)) return reply({ items: [], total_count: 0, export_id: 4 });
    return reply({ items: [], total_count: 0 });
  });
});

let servers: Server[] = [];
let client: Client;
let home = '';

const cfg = (port: number) => ({ baseUrl: `http://127.0.0.1:${port}`, consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd', insecureTls: false, allowInsecure: true, journalKey: 'k'.repeat(64) });

beforeAll(async () => {
  servers = [stub('acme'), stub('beta')];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  const [pa, pb] = servers.map((s) => (s.address() as AddressInfo).port);
  home = mkdtempSync(join(tmpdir(), 'wf-mcp-chain-'));
  const registry = SiteRegistry.fromConfigs({ acme: cfg(pa), beta: cfg(pb) } as never);
  const factory = new SiteContextFactory(registry, 'shared', () => undefined, join(home, 'journal.jsonl'));
  const server = buildServerFrom(factory);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'chain', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client?.close();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (home) rmSync(home, { recursive: true, force: true });
});

const text = (r: any): string => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');
const call = async (name: string, args: Record<string, unknown>) => {
  const before = { acme: seen.acme.length, beta: seen.beta.length };
  const r: any = await client.callTool({ name, arguments: args });
  return { r, out: text(r), acme: seen.acme.slice(before.acme), beta: seen.beta.slice(before.beta) };
};
const sent = (reqs: Seen[]) => reqs.map((q) => `${q.method} ${q.path} ${q.body}`).join('\n');

describe('ids handed out by one call are accepted by the next (two stores)', () => {
  it('builds a form section by section, copying each id from the previous answer', async () => {
    const draft = await call('open_draft', { site: 'acme', form_id: 'acme:3' });
    const draftId = (draft.r.structuredContent as any).draft_id;
    expect(draftId).toBe('acme:11');
    const section = await call('draft_add_section', { site: 'acme', draft_id: draftId, expected_draft_revision: 1, name: 'S' });
    const sectionId = (section.r.structuredContent as any).section_id;
    expect(sectionId).toBe('acme:5');
    const field = await call('draft_add_field', { site: 'acme', draft_id: draftId, expected_draft_revision: 2, section_id: sectionId, type: 'text' });
    expect(field.r.isError, field.out).toBeFalsy();
    expect(sent(field.acme)).toContain('"fieldset_ref":"5"');
    const fieldId = (field.r.structuredContent as any).field_id;
    expect(fieldId).toBe('acme:12');
    const logic = await call('draft_add_logic', { site: 'acme', draft_id: draftId, expected_draft_revision: 3, rules: [{ field_id: fieldId, logic_condition: 'equal', action: 'show', value: 'x', target: 'submit' }] });
    expect(logic.r.isError, logic.out).toBeFalsy();
    const logicId = (logic.r.structuredContent as any).logic_id;
    expect(logicId).toBe('acme:7');
    const removed = await call('draft_remove_logic', { site: 'acme', draft_id: draftId, expected_draft_revision: 4, logic_id: logicId });
    expect(removed.r.isError, removed.out).toBeFalsy();
    expect(sent(removed.acme)).toContain('"logic_ref":"7"');
  });

  // Each row: tool, arguments as a model copies them from earlier answers, and what the store must see.
  const rows: Array<[string, Record<string, unknown>, string[]]> = [
    ['draft_add_field', { draft_id: 'acme:11', expected_draft_revision: 1, section_id: 'acme:5', type: 'text', after_field_id: 'acme:12' }, ['"fieldset_ref":"5"', '"after_field_ref":"12"']],
    ['draft_update_section', { draft_id: 'acme:11', expected_draft_revision: 1, section_id: 'acme:5', settings: { name: 'x' } }, ['"fieldset_ref":"5"']],
    ['draft_remove_section', { draft_id: 'acme:11', expected_draft_revision: 1, section_id: 'acme:5' }, ['"fieldset_ref":"5"']],
    ['draft_reorder', { draft_id: 'acme:11', expected_draft_revision: 1, positions: { sections: [{ id: 'acme:5', position: 0 }], fields: [{ id: 'acme:12', section_id: 'acme:5', position: 1 }] } }, ['\\"id\\":5', '\\"id\\":12', '\\"fieldset_id\\":5']],
    ['draft_update_field', { draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'acme:12', settings: { label: 'x' } }, ['"field_ref":"12"']],
    ['draft_turn_field_into', { draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'acme:12', target_type: 'textarea' }, ['"field_ref":"12"']],
    ['draft_duplicate_field', { draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'acme:12' }, ['"field_ref":"12"']],
    ['draft_remove_field', { draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'acme:12' }, ['"field_ref":"12"']],
    ['draft_set_logic', { draft_id: 'acme:11', expected_draft_revision: 1, rules: [{ logic_id: 'acme:7', field_id: 'acme:12', logic_condition: 'equal', action: 'show', value: 'x', target: 'submit' }] }, ['\\"logic_id\\":7', '\\"field_id\\":12']],
    ['draft_add_logic', { draft_id: 'acme:11', expected_draft_revision: 1, rules: [{ field_id: 'acme:12', logic_condition: 'equal', action: 'show', value: 'x', target: 'submit' }] }, ['\\"field_id\\":12']],
    ['draft_add_logic', { draft_id: 'acme:11', expected_draft_revision: 1, rules: [{ field_id: 'acme:12', logic_condition: 'equal', action: 'show', value: 'x', target: ['field_acme:13', 'fieldset_acme:5'] }] }, ['\\"field_13\\"', '\\"fieldset_5\\"']],
    ['draft_set_logic', { draft_id: 'acme:11', expected_draft_revision: 1, rules: [{ logic_id: 'acme:7', field_id: 12, logic_condition: 'equal', action: 'show', value: 'x', target: 'field_acme:13' }] }, ['\\"target\\":\\"field_13\\"']],
    ['draft_remove_logic', { draft_id: 'acme:11', expected_draft_revision: 1, logic_id: 'acme:7' }, ['"logic_ref":"7"']],
    ['list_submission_notes', { result_id: 'acme:5', grant_id: 'acme:9' }, ['grantId=9']],
    ['list_submission_attachments', { result_id: 'acme:5', grant_id: 'acme:9' }, ['grantId=9']],
    ['activate_notification', { notification_id: 'acme:9' }, ['/notifications/9/activation/prepare']],
    ['deactivate_notification', { notification_id: 'acme:9', confirmed_by_user: true }, ['/notifications/9/deactivate']],
    ['draft_update_form', { draft_id: 'acme:11', expected_draft_revision: 1, settings: { submitter_email_field_id: 'acme:12', cr_map: { customer: { email: 'acme:12', firstname: 'acme:13:first' } }, success_text: 'acme:4 stays text' } }, ['\\"submitter_email_field_id\\":12', '\\"email\\":12', '\\"firstname\\":\\"13:first\\"', 'acme:4 stays text']],
    ['draft_update_field', { draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'acme:12', settings: { password_match_value_field_id: 'acme:13' } }, ['\\"password_match_value_field_id\\":13']],
    ['draft_set_translations', { draft_id: 'acme:11', expected_draft_revision: 1, store_code: 'de', translations: { fields: { 'acme:12': { label: 'Name' } }, logic: { 'acme:7': { value: 'x' } } } }, ['\\"12\\":{', '\\"7\\":{']],
    ['get_schema', { kind: 'section' }, ['GET /V1/webforms/schema/fieldset']],
    ['search_submissions', { form_id: 'acme:3', field_filter: [{ field: 'acme:12', op: 'eq', value: 'x' }] }, ['\\"field\\":12']],
    ['export_submissions', { form_id: 'acme:3', field_filter: [{ field: 'acme:12', op: 'eq', value: 'x' }] }, ['\\"field\\":12']],
    ['update_submission_values', { result_id: 'acme:6', expected_result_revision: 1, values: { 'acme:12': 'new' }, confirmed_by_user: true }, ['12']],
    ['update_notification', { form_id: 'acme:3', notification: '00000000-0000-0000-0000-000000000001', patch: { recipient_field_id: 'acme:12' }, confirmed_by_user: true }, ['12']],
    ['add_notification', { form_id: 'acme:3', notification: { name: 'n', recipient_field_id: 'acme:12' } }, ['12']],
  ];

  it.each(rows)('%s takes the qualified ids and sends the store bare numbers', async (name, args, expected) => {
    const { r, out, acme, beta } = await call(name, { site: 'acme', ...args });
    expect(out).not.toMatch(/Input validation error|expected number|HANDLE_UNQUALIFIED|SITE_HANDLE_MISMATCH/);
    expect(beta).toHaveLength(0);
    const wire = sent(acme) + '\n' + acme.map((q) => decodeURIComponent(q.path)).join('\n');
    expect(wire.replace('acme:4 stays text', ''), `${name}: ${out}`).not.toContain('acme:');
    for (const fragment of expected) expect(wire + acme.map((q) => q.path).join(''), `${name} → ${wire}`).toContain(fragment);
    void r;
  });

  it.each(rows)('%s refuses an id of the other store before anything is sent', async (name, args) => {
    const foreign = JSON.parse(JSON.stringify(args).replace(/"acme:(\d+)"/g, (_m, n, offset, all) =>
      // keep draft_id / form_id / result_id of the addressed store; swap only the inner ids
      /"(draft_id|form_id|result_id)":$/.test(all.slice(0, offset)) ? `"acme:${n}"` : `"beta:${n}"`));
    if (JSON.stringify(foreign) === JSON.stringify(args)) return;
    const { out, acme, beta } = await call(name, { site: 'acme', ...foreign });
    expect(out).toMatch(/SITE_HANDLE_MISMATCH/);
    expect(acme).toHaveLength(0);
    expect(beta).toHaveLength(0);
  });

  it('still takes bare numbers where the form document hands them out bare', async () => {
    const { out, acme } = await call('draft_reorder', { site: 'acme', draft_id: 'acme:11', expected_draft_revision: 1, positions: { sections: [{ id: 5, position: 0 }], fields: [{ id: 12, section_id: 5, position: 1 }] } });
    expect(out).not.toMatch(/HANDLE_UNQUALIFIED|validation/);
    expect(acme.length).toBeGreaterThan(0);
    const section = await call('draft_update_section', { site: 'acme', draft_id: 'acme:11', expected_draft_revision: 1, section_id: 5, settings: {} });
    expect(section.out).not.toMatch(/HANDLE_UNQUALIFIED|validation/);
  });

  it('a notification id copied bare from the form document is accepted', async () => {
    const { out, acme } = await call('activate_notification', { site: 'acme', notification_id: 9 });
    expect(out).not.toMatch(/HANDLE_UNQUALIFIED|validation/);
    expect(acme.map((q) => q.path).join(' ')).toContain('/notifications/9/activation/prepare');
  });

  it('keeps a field code that merely looks like "word:number" when no store has that key', async () => {
    const { acme } = await call('draft_update_field', { site: 'acme', draft_id: 'acme:11', expected_draft_revision: 1, field_id: 'colour:2', settings: {} });
    expect(sent(acme)).toContain('"field_ref":"colour:2"');
  });

  it('refuses a logic target naming the other store', async () => {
    const { out, acme } = await call('draft_add_logic', { site: 'acme', draft_id: 'acme:11', expected_draft_revision: 1, rules: [{ field_id: 'acme:12', logic_condition: 'equal', action: 'show', value: 'x', target: ['field_beta:13'] }] });
    expect(out).toMatch(/SITE_HANDLE_MISMATCH/);
    expect(acme).toHaveLength(0);
  });

  it('labels untrusted note and file-name blocks with the ids the structured answer uses', async () => {
    const notes = await call('list_submission_notes', { site: 'acme', result_id: 'acme:6' });
    expect(notes.r.structuredContent.items[0].id).toBe('acme:1');
    expect(notes.out).toContain('[note acme:1 text');
    const files = await call('list_submission_attachments', { site: 'acme', result_id: 'acme:6' });
    expect(files.r.structuredContent.items[0].attachment_id).toBe('acme:2');
    expect(files.out).toContain('"acme:2": "cv.pdf"');
  });

  it('labels the untrusted values block of a submission with its qualified id', async () => {
    const one = await call('get_submission', { site: 'acme', result_id: 'acme:6' });
    expect(one.r.structuredContent.items[0].id).toBe('acme:6');
    expect(one.out).toContain('[submission acme:6 values');
    const full = await call('get_submission_full', { site: 'acme', result_id: 'acme:6', grant_id: 'acme:9' });
    expect(full.out).toContain('[submission acme:6 values (disclosed)');
  });

  it('leaves visitor values that look like ids as they are', async () => {
    const { out, acme } = await call('update_submission_values', { site: 'acme', result_id: 'acme:6', expected_result_revision: 1, values: { order_id: 'acme:123', 'acme:12': 'beta:5' }, confirmed_by_user: true });
    expect(out).not.toMatch(/SITE_HANDLE_MISMATCH/);
    const wire = sent(acme);
    expect(wire).toContain('acme:123');
    expect(wire).toContain('beta:5');
  });

  it('a grant id is store-bound like the submission it discloses: a bare one is refused', async () => {
    const { out, acme } = await call('list_submission_notes', { site: 'acme', result_id: 'acme:5', grant_id: 9 });
    expect(out).toMatch(/HANDLE_UNQUALIFIED/);
    expect(acme).toHaveLength(0);
  });
});

describe('a bare id on a call no other handle pins to a store (N6)', () => {
  it('with an active store but no site, a bare notification id is refused before any request', async () => {
    await call('use_site', { site: 'acme' });
    for (const name of ['activate_notification', 'deactivate_notification']) {
      const { out, acme, beta } = await call(name, { notification_id: 9, confirmed_by_user: true });
      expect(out).toMatch(/HANDLE_UNQUALIFIED/);
      expect(out).toMatch(/site/);
      expect(acme).toHaveLength(0);
      expect(beta).toHaveLength(0);
    }
  });
  it('the qualified id still works with only the active store', async () => {
    const { out, acme } = await call('activate_notification', { notification_id: 'acme:9' });
    expect(out).not.toMatch(/HANDLE_UNQUALIFIED|validation/);
    expect(acme.map((q) => q.path).join(' ')).toContain('/notifications/9/activation/prepare');
  });
  it('a bare section id inside a draft call stays accepted: the qualified draft id pins the store', async () => {
    const { out } = await call('draft_remove_section', { draft_id: 'acme:11', expected_draft_revision: 1, section_id: 5 });
    expect(out).not.toMatch(/HANDLE_UNQUALIFIED/);
  });
});

describe('the shared import directory in a process serving two stores (#11)', () => {
  it('prepare_import does not read a file left in the shared root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-mcp-chain-import-'));
    writeFileSync(join(root, 'rows.jsonl'), '{"a":1}\n');
    const before = process.env.WEBFORMS_MCP_IMPORT_ROOT;
    process.env.WEBFORMS_MCP_IMPORT_ROOT = root;
    try {
      const { out, acme } = await call('prepare_import', { site: 'acme', form_id: 'acme:3', source_system: 'legacy', file_path: 'rows.jsonl' });
      expect(out).toMatch(/several stores/);
      expect(acme).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.WEBFORMS_MCP_IMPORT_ROOT; else process.env.WEBFORMS_MCP_IMPORT_ROOT = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
