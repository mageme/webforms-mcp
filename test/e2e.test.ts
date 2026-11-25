import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ApiClient } from '../src/client.js';
import { activeFlag, apiClient, connectDedicated, e2eEnabled, fieldIdsByCode, runId, switchOffAndReport } from './e2e-support.js';

/**
 * Write-path e2e against a real store over stdio (WEBFORMS_MCP_E2E=1, WEBFORMS_MCP_CREDENTIALS_FILE).
 * Everything the run writes goes into a form and a submission of its own (mcp-e2e-<run id>): create the
 * form, edit it through a draft, translate, publish, switch it on, submit, then work that submission
 * (note, read state, reply preview, order link). The API cannot delete, so afterwards the form is switched
 * off and the ids left behind are reported (WEBFORMS_MCP_E2E_LEFTOVERS names a file to collect them).
 */
const NAME = `mcp-e2e-${runId()}`;
const NOTE = `mcp e2e note ${NAME}`;

describe.skipIf(!e2eEnabled)('write flow against a store', () => {
  let client: Client;
  let api: ApiClient;
  let formId = 0;
  let resultId = 0;
  let draftId: unknown;
  let published = false;
  let noteAdded = false;
  let orderLinked: number | undefined;

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError ?? false, `${name}: ${JSON.stringify(r.content)}`).toBe(false);
    return r;
  };
  const data = async (name: string, args: Record<string, unknown>) => (await call(name, args)).structuredContent as any;
  const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

  beforeAll(async () => {
    // A single-store write flow belongs in a dedicated process: identifiers stay bare and the store is
    // not in question. The shared process is exercised separately, in shared.test.ts.
    client = await connectDedicated('e2e');
    api = await apiClient();
  });

  afterAll(async () => {
    try {
      if (formId) {
        // publishing keeps the replaced content as a version, which is a form row of its own
        let versions = '';
        try {
          const listed = await client.callTool({ name: 'list_form_versions', arguments: { form_id: formId } });
          versions = ((listed.structuredContent as any)?.items ?? []).map((v: { id: number }) => v.id).join(',');
        } catch { /* the versions are only named in the report */ }
        await switchOffAndReport(
          formId,
          `"${NAME}"${versions ? `; version rows ${versions}` : ''}${draftId !== undefined && !published ? `; draft ${String(draftId)} STILL OPEN` : ''}${resultId ? `; submission ${resultId}` : ''}${noteAdded ? '; 1 note' : ''}${orderLinked !== undefined ? `; order ${orderLinked} STILL LINKED` : ''}`,
          async () => {
            const off = await client.callTool({ name: 'deactivate_form', arguments: { form_id: formId, confirmed_by_user: true } });
            if (off.isError) throw new Error(JSON.stringify(off.content));
          },
          async () => activeFlag((await client.callTool({ name: 'get_form', arguments: { form_id: formId } })).structuredContent as any),
        );
      }
    } finally {
      await client.close();
    }
  });

  it('creates, edits, translates, publishes and switches on a form of its own', async () => {
    const created = await data('create_form', { document: { name: NAME, code: NAME, fieldsets: [{ name: 'Main', fields: [{ type: 'text', name: 'Seed', code: 'seed' }, { type: 'email', name: 'Email', code: 'email' }] }] } });
    formId = created.id;
    expect(created).toMatchObject({ name: NAME, is_active: false });
    const draft = await data('open_draft', { form_id: formId });
    draftId = draft.draft_id;
    let revision = draft.draft_revision;
    const section = await data('draft_add_section', { draft_id: draft.draft_id, expected_draft_revision: revision, settings: { name: 'E2E section' } });
    revision = section.draft_revision;
    const sectionId = JSON.parse(section.payload ? JSON.stringify(section.payload) : '{}').section_id ?? section.section_id ?? section.payload?.id;
    const field = await data('draft_add_field', { draft_id: draft.draft_id, expected_draft_revision: revision, section_id: sectionId, type: 'text', name: 'E2E field', code: 'e2e_field' });
    revision = field.draft_revision;
    const tr = await data('draft_set_translations', { draft_id: draft.draft_id, expected_draft_revision: revision, store_code: 'default', translations: { fields: { [String(field.payload.field_id ?? field.payload.id)]: { name: 'E2E Feld' } } } });
    revision = tr.draft_revision;
    const validation = await data('draft_validate', { draft_id: draft.draft_id });
    expect(validation.errors ?? [], JSON.stringify(validation)).toEqual([]);
    const prep = await data('draft_prepare_publish', { draft_id: draft.draft_id, expected_draft_revision: revision, expected_live_revision: created.revision });
    const live = await data('draft_publish', { draft_id: draft.draft_id, expected_draft_revision: revision, expected_live_revision: created.revision, confirmation_id: prep.confirmation_id, confirmed_by_user: true });
    published = true;
    expect(live.id).toBe(formId);
    const doc = await data('get_form_document', { form_id: formId });
    expect(JSON.stringify(doc.document)).toContain('e2e_field');
    await call('activate_form', { form_id: formId, confirmed_by_user: true });
  }, 120_000);

  it('works a submission of its own', async () => {
    const doc = await data('get_form_document', { form_id: formId });
    const ids = fieldIdsByCode(doc.document);
    expect(ids.seed, JSON.stringify(Object.keys(ids))).toBeGreaterThan(0);
    // FormRepository::submitById reads {field: {<id>: value}} from the body; resource MageMe_WebForms::api_submission
    await api.request<any>('POST', `/V1/webforms/form/${formId}/submit`, { body: { field: { [ids.seed]: 'e2e seed', [ids.email]: 'mcp-e2e@example.com' } } });
    const subs = await data('search_submissions', { form_id: formId, page_size: 5 });
    expect(subs.items, 'the submission this run just made').toHaveLength(1);
    const sub = subs.items[0];
    resultId = sub.id;

    const before = (await api.get<{ items: unknown[] }>(`/V1/webforms/results/${resultId}/notes`)).items.length;
    const noted = await data('add_submission_note', { result_id: resultId, text: NOTE });
    noteAdded = true;
    expect(noted.id).toBe(resultId);
    const after = (await api.get<{ items: unknown[] }>(`/V1/webforms/results/${resultId}/notes`)).items.length;
    expect(after - before, 'the note this run added').toBe(1);

    const marked = await data('mark_submission', { result_id: resultId, expected_result_revision: noted.result_revision, state: 'read' });
    expect(marked.result_revision).toBeGreaterThanOrEqual(noted.result_revision);

    const preview = await call('prepare_reply', { result_id: resultId, body_text: 'Preview only' });
    expect((preview.structuredContent as any).recipient_masked).toMatch(/\*\*\*/);
    expect(JSON.stringify(preview.content)).not.toMatch(/confirmation_token/);
  }, 120_000);

  it('links an order to its submission, reads, searches by its number and unlinks', async (ctx) => {
    expect(resultId, 'the submission of the previous step').toBeGreaterThan(0);
    const wanted = process.env.WEBFORMS_MCP_E2E_ORDER;
    const query: Record<string, string> = { 'searchCriteria[pageSize]': '1' };
    if (wanted) Object.assign(query, { 'searchCriteria[filterGroups][0][filters][0][field]': 'increment_id', 'searchCriteria[filterGroups][0][filters][0][value]': wanted });
    let order: { entity_id: number; increment_id: string } | undefined;
    try {
      order = (await api.get<{ items: { entity_id: number; increment_id: string }[] }>('/V1/orders', query)).items[0];
    } catch (e) {
      ctx.skip(`orders cannot be read through this integration (${(e as Error).message}); set up the Sales order view permission`);
    }
    if (!order) ctx.skip(wanted ? `order ${wanted} is not in the store` : 'the store has no order to link');
    const number = order!.increment_id;
    // A submission made through the REST API has no store view, so the order is named by id: a number is looked up in the submission's store view.
    try {
      const linked = await call('link_submission_order', { result_id: resultId, order_id: order!.entity_id });
      orderLinked = order!.entity_id;
      expect(text(linked)).toContain(number);
      expect(text(await call('get_submission', { result_id: resultId }))).toMatch(new RegExp(`linked orders[\\s\\S]*${number}`));
      const found = await data('search_submissions', { form_id: formId, filter: { linked_order_number: number } });
      expect((found.items as { id: number }[]).map((i) => i.id)).toContain(resultId);
    } finally {
      if (orderLinked !== undefined) {
        const unlinked = await client.callTool({ name: 'unlink_submission_order', arguments: { result_id: resultId, order_id: orderLinked } });
        if (!unlinked.isError) {
          expect(text(unlinked)).not.toContain(number);
          orderLinked = undefined;
        }
      }
    }
  }, 120_000);
});
