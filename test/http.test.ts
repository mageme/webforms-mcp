import { describe, expect, it } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import { loadConfig } from '../src/config.js';
import { authorizationHeader } from '../src/oauth.js';

/**
 * H: the deployed HTTP boundary against the dev store (WEBFORMS_MCP_E2E=1) — OAuth 1.0a edge cases,
 * redirects, content negotiation, oversized bodies, method override, CORS and cache headers.
 */
const enabled = process.env.WEBFORMS_MCP_E2E === '1';

describe.skipIf(!enabled)('HTTP boundary against the dev store', () => {
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  // Lazily, so a skipped run never rejects a promise nobody awaits.
  let cfgP: ReturnType<typeof loadConfig> | undefined;
  const config = () => (cfgP ??= loadConfig(process.env.WEBFORMS_MCP_CREDENTIALS_FILE));

  const call = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string; creds?: Partial<Record<'consumerKey' | 'consumerSecret' | 'accessToken' | 'accessTokenSecret', string>>; nonce?: string; timestamp?: string; signUrl?: string; base?: string; query?: Record<string, string> } = {}) => {
    const cfg = await config();
    const base = init.base ?? cfg.baseUrl;
    const url = `${base}/rest/all${path}`;
    const creds = { ...cfg, ...(init.creds ?? {}) };
    const auth = authorizationHeader(creds, { method, url: init.signUrl ?? url, query: init.query, nonce: init.nonce, timestamp: init.timestamp });
    const full = init.query ? `${url}?${new URLSearchParams(init.query).toString()}` : url;
    const res = await undiciFetch(full, { method, headers: { Accept: 'application/json', Authorization: auth, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) }, body: init.body, redirect: 'manual', dispatcher: agent });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };

  it('H1: every OAuth defect is a 401 JSON error, never a 500 or a pass', async () => {
    const ok = await call('GET', '/V1/webforms/capabilities');
    expect(ok.status).toBe(200);
    // the clock is read right before each request: the cases run one after another, and a timestamp taken
    // once would drift back into the store's +600 s window by the time its request goes out
    const now = () => Math.floor(Date.now() / 1000);
    const otherUrl = (await config()).baseUrl + '/rest/all/V1/webforms/forms';
    const cases: Array<[string, () => Parameters<typeof call>[2]]> = [
      ['wrong consumer key', () => ({ creds: { consumerKey: 'nope' } })],
      ['wrong consumer secret', () => ({ creds: { consumerSecret: 'nope' } })],
      ['wrong token', () => ({ creds: { accessToken: 'nope' } })],
      ['wrong token secret', () => ({ creds: { accessTokenSecret: 'nope' } })],
      ['timestamp 601 s in the future', () => ({ timestamp: String(now() + 601) })],
      ['non-numeric timestamp', () => ({ timestamp: 'yesterday' })],
      ['signature over another URL', () => ({ signUrl: otherUrl })],
    ];
    for (const [label, init] of cases) {
      const r = await call('GET', '/V1/webforms/capabilities', init());
      // Magento answers 401 for signature/timestamp problems and 400 for an unknown token; both refuse
      expect([400, 401], label).toContain(r.status);
      expect(r.json?.message, label).toBeTypeOf('string');
      expect(r.text, label).not.toMatch(/oauth_consumer_secret|oauth_token_secret/);
    }
    const past = await call('GET', '/V1/webforms/capabilities', { timestamp: String(now() - 86400) });
    expect(past.status, 'Magento accepts past timestamps (replay is prevented by the nonce store), refuses > +600 s').toBe(200);
  });

  it('H1: a nonce cannot be replayed', async () => {
    const nonce = 'replay-' + Math.random().toString(36).slice(2);
    const ts = String(Math.floor(Date.now() / 1000));
    const first = await call('GET', '/V1/webforms/capabilities', { nonce, timestamp: ts });
    expect(first.status).toBe(200);
    const second = await call('GET', '/V1/webforms/capabilities', { nonce, timestamp: ts });
    expect(second.status).toBe(401);
  });

  it('H1: bearer and anonymous callers are refused on v1 routes', async () => {
    const cfg = await config();
    const anon = await undiciFetch(`${cfg.baseUrl}/rest/all/V1/webforms/forms`, { headers: { Accept: 'application/json' }, dispatcher: agent });
    expect(anon.status).toBe(401);
    const bearer = await undiciFetch(`${cfg.baseUrl}/rest/all/V1/webforms/forms`, { headers: { Accept: 'application/json', Authorization: 'Bearer not-a-real-token' }, dispatcher: agent });
    expect(bearer.status).toBe(401);
  });

  it('H2: plain http is redirected and the signed request is not served over it', async () => {
    const cfg = await config();
    const r = await call('GET', '/V1/webforms/capabilities', { base: cfg.baseUrl.replace('https://', 'http://') });
    expect([301, 302, 307, 308]).toContain(r.status);
    expect(r.headers.get('location')).toMatch(/^https:/);
    expect(r.text).not.toContain('api_version');
  });

  it('H3: content negotiation', async () => {
    const cfg = await config();
    const body = JSON.stringify({ request: { request_id: 'http-' + Date.now(), form_id: 1 } });
    const charset = await call('POST', '/V1/webforms/results/search', { body, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect([200, 404]).toContain(charset.status);
    const wrong = await call('POST', '/V1/webforms/results/search', { body, headers: { 'Content-Type': 'text/plain' } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    const xml = await call('GET', '/V1/webforms/capabilities', { headers: { Accept: 'application/xml' } });
    expect([200, 406]).toContain(xml.status);
    expect(cfg.baseUrl).toBeTruthy();
  });

  it('H4: a JSON member above the 2 MiB cap is refused by the API layer with INVALID_JSON', async () => {
    const forms = await call('GET', '/V1/webforms/forms', { query: { 'searchCriteria[pageSize]': '1' } });
    expect(forms.status, forms.text.slice(0, 300)).toBe(200);
    const formId = forms.json.items[0].id;
    const huge = JSON.stringify({ request: { request_id: 'http-big-' + Date.now(), form_id: formId, filter_json: '{"k":"' + 'x'.repeat(2 * 1024 * 1024 + 10) + '"}' } });
    const r = await call('POST', '/V1/webforms/results/search', { body: huge });
    expect([400, 413], `status ${r.status}: ${r.text.slice(0, 200)}`).toContain(r.status);
    if (r.status === 400) {
      expect(r.json.parameters.code).toBe('INVALID_JSON');
      expect(JSON.parse(r.json.parameters.details_json)).toEqual({ field: 'filter_json' });
    }
  });

  it('H8: a method override header does not change the route', async () => {
    const r = await call('GET', '/V1/webforms/capabilities', { headers: { 'X-HTTP-Method-Override': 'POST', 'X-Method-Override': 'DELETE' } });
    expect(r.status).toBe(200);
    expect(r.json.api_version).toBe('1');
  });

  it('H9/H10: no CORS grant for arbitrary origins, no caching of API JSON', async () => {
    const r = await call('GET', '/V1/webforms/capabilities', { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    const cache = (r.headers.get('cache-control') ?? '').toLowerCase();
    expect(cache).toMatch(/no-store|no-cache|private/);
    const search = await call('POST', '/V1/webforms/results/search', { body: JSON.stringify({ request: { request_id: 'http-c-' + Date.now(), form_id: 1 } }) });
    expect((search.headers.get('cache-control') ?? '').toLowerCase()).toMatch(/no-store|no-cache|private/);
  });

  it('H5: every documented error family serialises as the Magento envelope with typed parameters', async () => {
    const r = await call('GET', '/V1/webforms/forms/987654321');
    expect(r.status).toBe(404);
    expect(r.json.parameters.code).toBe('NOT_FOUND');
    expect(r.json.parameters.details_schema_version).toBe('1');
    expect(JSON.parse(r.json.parameters.details_json)).toEqual({});
    const bad = await call('POST', '/V1/webforms/results/search', { body: JSON.stringify({ request: { request_id: 'http-e-' + Date.now(), form_id: 1, filter_json: '{oops' } }) });
    expect([400, 404]).toContain(bad.status);
    expect(['INVALID_JSON', 'NOT_FOUND']).toContain(bad.json.parameters.code);
  });
});
