import { afterAll, describe, expect, it } from 'vitest';
import { activeFlag, apiClient, concurrency, e2eEnabled, fieldIdsByCode, mapLimit, runId, switchOffAndReport } from './e2e-support.js';
import type { ApiClient } from '../src/client.js';

/**
 * Idempotency under concurrency and a latency sample against a real store (WEBFORMS_MCP_E2E=1,
 * WEBFORMS_MCP_CREDENTIALS_FILE). The mutation runs on a form and a submission of its own
 * (mcp-e2e-load-<run id>); the API cannot delete, so afterwards the form is switched off and its ids are
 * reported. WEBFORMS_MCP_E2E_CONCURRENCY sets how many requests run at once (default 5). The latency
 * sample only reads.
 */
const NAME = `mcp-e2e-load-${runId()}`;

const quantile = (xs: number[], q: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

describe.skipIf(!e2eEnabled)('load against a store', () => {
  let formId = 0;
  let resultId = 0;
  let api: ApiClient;

  afterAll(async () => {
    if (!formId) return;
    await switchOffAndReport(
      formId,
      `"${NAME}"${resultId ? `; submission ${resultId}; notes from the concurrent calls` : ''}`,
      () => api.post(`/V1/webforms/forms/${formId}/commands/activate`, { request: { request_id: `load-off-${runId()}`, activate: false } }),
      async () => activeFlag(await api.get<any>(`/V1/webforms/forms/${formId}`)),
    );
  });

  it('executes a mutation exactly once under concurrent identical requests', async () => {
    api = await apiClient();
    // A submission needs the form to be on; it is switched off again in afterAll.
    const document = { name: NAME, code: NAME, fieldsets: [{ name: 'Main', fields: [{ type: 'text', name: 'Seed', code: 'seed' }] }] };
    const created = await api.post<any>('/V1/webforms/forms', { request: { request_id: `load-form-${runId()}`, document_json: JSON.stringify(document), activate: true } });
    formId = Number(created.id ?? created.form_id);
    expect(formId, JSON.stringify(created)).toBeGreaterThan(0);
    const live = await api.get<{ document_json: string }>(`/V1/webforms/forms/${formId}/document`);
    const fieldId = fieldIdsByCode(JSON.parse(live.document_json)).seed;
    expect(fieldId).toBeGreaterThan(0);
    // FormRepository::submitById reads {field: {<id>: value}} from the body; resource MageMe_WebForms::api_submission
    await api.request<any>('POST', `/V1/webforms/form/${formId}/submit`, { body: { field: { [fieldId]: 'load seed' } } });
    const found = await api.post<any>('/V1/webforms/results/search', { request: { request_id: `load-find-${runId()}`, form_id: formId, max_results: 5 } });
    expect(found.items, JSON.stringify(found)).toHaveLength(1);
    resultId = Number(found.items[0].id ?? found.items[0].result_id);
    expect(resultId).toBeGreaterThan(0);

    const before = (await api.get<any>(`/V1/webforms/results/${resultId}/notes`)).items.length;
    const requestId = `load-${runId()}`;
    const outcomes = await Promise.all(Array.from({ length: concurrency() }, () =>
      api.post<any>(`/V1/webforms/results/${resultId}/commands/add-note`, { request: { request_id: requestId, text: 'load probe' } }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, code: e.code }))));
    const after = (await api.get<any>(`/V1/webforms/results/${resultId}/notes`)).items.length;
    expect(after - before, JSON.stringify(outcomes.map((o: any) => o.ok ? 'ok' : o.code))).toBe(1);
    for (const o of outcomes as any[]) expect(o.ok || ['CONFLICT', 'INDETERMINATE'].includes(o.code), JSON.stringify(o)).toBe(true);
    expect(outcomes.filter((o: any) => o.ok).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('samples latencies of the hot read paths', async () => {
    api = await apiClient();
    const forms = await api.get<any>('/V1/webforms/forms', { 'searchCriteria[pageSize]': '50' });
    const stats = await mapLimit<any, { id: number; total: number }>(forms.items, concurrency(), (f) => api.get<any>(`/V1/webforms/forms/${f.id}/stats`).then((s) => ({ id: f.id, total: Number(s.results_total ?? 0) })).catch(() => ({ id: f.id, total: 0 })));
    const busiest = stats.sort((a, b) => b.total - a.total)[0];
    const time = async (label: string, fn: () => Promise<unknown>, n = 15) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
      return `| ${label} | ${n} | ${quantile(ms, 0.5).toFixed(0)} | ${quantile(ms, 0.95).toFixed(0)} |`;
    };
    const rows = [
      await time('GET /capabilities', () => api.get('/V1/webforms/capabilities')),
      await time('GET /forms (page 20)', () => api.get('/V1/webforms/forms', { 'searchCriteria[pageSize]': '20' })),
      await time(`GET /forms/${busiest.id}/document`, () => api.get(`/V1/webforms/forms/${busiest.id}/document`)),
      await time(`POST /results/search form ${busiest.id} (${busiest.total} results), page 20`, () => api.post('/V1/webforms/results/search', { request: { request_id: 'perf-' + Math.random(), form_id: busiest.id, max_results: 20 } })),
      await time(`POST /results/search + field predicate (contains)`, () => api.post('/V1/webforms/results/search', { request: { request_id: 'perf-' + Math.random(), form_id: busiest.id, max_results: 20, field_filter_json: JSON.stringify([{ field: 'rating', op: 'is_empty' }]) } }).catch(() => null)),
      await time('GET /schema/field-types', () => api.get('/V1/webforms/schema/field-types'), 5),
    ];
    const report = ['# Latency sample', '', `Date: ${new Date().toISOString().slice(0, 10)}. Busiest form: #${busiest.id} (${busiest.total} submissions).`, '', '| Call | n | p50 ms | p95 ms |', '|---|---|---|---|', ...rows, ''].join('\n');
    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    writeFileSync(process.env.WEBFORMS_MCP_PERF_REPORT ?? join(tmpdir(), 'webforms-mcp-perf.md'), report);
    expect(rows).toHaveLength(6);
  }, 180_000);
});
