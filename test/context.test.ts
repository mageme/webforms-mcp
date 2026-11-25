import { describe, expect, it, vi } from 'vitest';
import { formAccess, SiteContextFactory } from '../src/context.js';
import type { SiteEntry, SiteRegistry } from '../src/registry.js';

const entry = (key: string): SiteEntry => ({
  key,
  host: `${key}.example`,
  label: key === 'a' ? 'Acme' : key,
  config: {
    baseUrl: `https://${key}.example`,
    consumerKey: 'ck',
    consumerSecret: 'cs',
    accessToken: 'at',
    accessTokenSecret: 'ats',
    insecureTls: false,
    journalKey: 'jk',
  },
});

const registry = {
  size: 3,
  complete: true,
  isolatedKeys: [],
  diagnostics: [],
  keys: () => ['a', 'b', 'c'],
  get: (k: string) => (['a', 'b', 'c'].includes(k) ? entry(k) : undefined),
  find: () => ({ ok: false, reason: 'UNKNOWN' }),
} as unknown as SiteRegistry;

const factory = () => new SiteContextFactory(registry, 'shared', () => undefined);

const caps = { api_version: '1.0', document_schema_version: '1', field_types: [] };

describe('site context factory', () => {
  it('builds one client per site and reuses it', () => {
    const f = factory();
    expect(f.for(entry('a')).api).toBe(f.for(entry('a')).api);
    expect(f.for(entry('a')).api).not.toBe(f.for(entry('b')).api);
  });

  it('carries the site identity and the runtime mode onto the context', () => {
    const ctx = factory().for(entry('a'));
    expect([ctx.key, ctx.host, ctx.label, ctx.mode]).toEqual(['a', 'a.example', 'Acme', 'shared']);
  });

  it('gives each site its own journal', () => {
    const f = factory();
    expect(f.for(entry('a')).journal).not.toBe(f.for(entry('b')).journal);
  });

  it('starts with no active site and can be cleared back to none', () => {
    const f = factory();
    expect(f.activeKey()).toBeUndefined();
    f.beginSwitch('a').commit();
    expect(f.activeKey()).toBe('a');
    f.clearActive();
    expect(f.activeKey()).toBeUndefined();
  });

  it('lets the newest switch win even when an older one finishes later', () => {
    const f = factory();
    const toB = f.beginSwitch('b');
    const toC = f.beginSwitch('c');
    expect(toC.commit()).toBe(true);
    expect(toB.commit()).toBe(false);
    expect(f.activeKey()).toBe('c');
  });

  it('refuses an older switch even when the newer one never committed', () => {
    // The newer attempt failed its probe and told the caller the selection was unchanged; an older
    // attempt finishing afterwards must not quietly change it anyway.
    const f = factory();
    f.beginSwitch('a').commit();
    const toB = f.beginSwitch('b');
    f.beginSwitch('c');            // newer, and it never commits - its probe failed
    expect(toB.commit()).toBe(false);
    expect(f.activeKey()).toBe('a');
  });

  it('caches capabilities per site so a second look costs no request', async () => {
    const f = factory();
    const a = f.for(entry('a'));
    const b = f.for(entry('b'));
    const getA = vi.spyOn(a.api, 'get').mockResolvedValue(caps);
    const getB = vi.spyOn(b.api, 'get').mockResolvedValue(caps);
    await a.capabilities();
    await a.capabilities();
    await b.capabilities();
    expect(getA).toHaveBeenCalledTimes(1);
    expect(getB).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure too, so an unreachable store is not retried on every call', async () => {
    const f = factory();
    const ctx = f.for(entry('a'));
    const get = vi.spyOn(ctx.api, 'get').mockRejectedValue(new Error('down'));
    await expect(ctx.capabilities()).rejects.toThrow(/down/);
    await expect(ctx.capabilities()).rejects.toThrow(/down/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('asks capabilities with a short deadline rather than the default one', async () => {
    const ctx = factory().for(entry('a'));
    const get = vi.spyOn(ctx.api, 'get').mockResolvedValue(caps);
    await ctx.capabilities();
    expect(get).toHaveBeenCalledWith('/V1/webforms/capabilities', undefined, { timeoutMs: expect.any(Number) });
    expect((get.mock.calls[0][2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(5000);
  });
});

describe('formAccess', () => {
  it('names each form scope a store reports', () => {
    expect(formAccess(JSON.stringify({ form_scope: 'all' }))).toBe('All Forms');
    expect(formAccess(JSON.stringify({ form_scope: 'selected' }))).toBe('Selected forms');
    expect(formAccess(JSON.stringify({ form_scope: 'none' }))).toBe('No forms');
  });

  it('gives null for a store that does not report a scope, or reports one it does not know', () => {
    expect(formAccess(undefined)).toBeNull();
    expect(formAccess(JSON.stringify({ pii_grants: true }))).toBeNull();
    expect(formAccess(JSON.stringify({ form_scope: 'toString' }))).toBeNull();
    expect(formAccess('not json')).toBeNull();
  });
});
