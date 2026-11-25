import { describe, expect, it } from 'vitest';
import { describeResolveError, resolveSite } from '../src/resolve.js';
import type { SiteRegistry } from '../src/registry.js';

/** A registry double carrying only what resolveSite touches. */
const fake = (keys: string[], complete = true, isolated: string[] = []): SiteRegistry => ({
  size: keys.length,
  complete,
  isolatedKeys: isolated,
  diagnostics: [],
  keys: () => keys,
  get: (k: string) => (keys.includes(k) ? { key: k, host: `${k}.example`, label: k, config: {} } : undefined),
  find: (n: string) => {
    if (keys.includes(n)) return { ok: true, entry: { key: n, host: `${n}.example`, label: n, config: {} } };
    if (isolated.includes(n)) return { ok: false, reason: 'ISOLATED' };
    return { ok: false, reason: 'UNKNOWN' };
  },
}) as unknown as SiteRegistry;

describe('resolveSite', () => {
  it('uses the only site when the roster is complete', () => {
    expect(resolveSite(fake(['a']), undefined, undefined, true)).toMatchObject({ ok: true, entry: { key: 'a' } });
  });

  it('refuses the single-site fallback when the roster is incomplete', () => {
    expect(resolveSite(fake(['a'], false), undefined, undefined, false))
      .toMatchObject({ ok: false, error: { code: 'SITE_REQUIRED' } });
  });

  it('demands a site once there are two and nothing is selected', () => {
    expect(resolveSite(fake(['a', 'b']), undefined, undefined, false))
      .toMatchObject({ ok: false, error: { code: 'SITE_REQUIRED' } });
  });

  it('falls back to the active site', () => {
    expect(resolveSite(fake(['a', 'b']), undefined, 'a', true)).toMatchObject({ ok: true, entry: { key: 'a' } });
  });

  it('lets a read address another site while one is active', () => {
    expect(resolveSite(fake(['a', 'b']), 'b', 'a', false)).toMatchObject({ ok: true, entry: { key: 'b' } });
  });

  it('refuses a mutation that contradicts the active site', () => {
    expect(resolveSite(fake(['a', 'b']), 'b', 'a', true))
      .toMatchObject({ ok: false, error: { code: 'SITE_CONFLICT', active: 'a', requested: 'b' } });
  });

  it('allows a mutation that names the active site', () => {
    expect(resolveSite(fake(['a', 'b']), 'a', 'a', true)).toMatchObject({ ok: true, entry: { key: 'a' } });
  });

  it('names isolation as the reason rather than pretending the site is unknown', () => {
    expect(resolveSite(fake(['a'], true, ['big']), 'big', undefined, false))
      .toMatchObject({ ok: false, error: { code: 'SITE_ISOLATED', key: 'big' } });
  });

  it('ignores an active site that has vanished from the roster', () => {
    expect(resolveSite(fake(['a', 'b']), undefined, 'gone', false))
      .toMatchObject({ ok: false, error: { code: 'SITE_REQUIRED' } });
  });

  it('treats a blank site argument as no argument at all', () => {
    expect(resolveSite(fake(['a']), '   ', undefined, false)).toMatchObject({ ok: true, entry: { key: 'a' } });
  });

  it('lists the sites in every refusal a caller can act on', () => {
    const r = resolveSite(fake(['a', 'b']), 'nope', undefined, false);
    expect(r).toMatchObject({ ok: false, error: { code: 'SITE_UNKNOWN' } });
    expect((r as { error: { sites: unknown[] } }).error.sites).toHaveLength(2);
  });
});

describe('describeResolveError', () => {
  it('tells the caller how to reach an isolated site', () => {
    expect(describeResolveError({ code: 'SITE_ISOLATED', key: 'big' })).toMatch(/--profile big/);
  });

  it('names both sides of a conflict', () => {
    expect(describeResolveError({ code: 'SITE_CONFLICT', active: 'a', requested: 'b' })).toMatch(/"a".*"b"/);
  });

  it('enumerates the sites so the model can fix itself in one turn', () => {
    const text = describeResolveError({ code: 'SITE_REQUIRED', sites: [{ key: 'a', host: 'a.example' }] });
    expect(text).toMatch(/a \(a\.example\)/);
    expect(text).toMatch(/list_sites/);
  });

  it('says something usable even when no site is addressable', () => {
    expect(describeResolveError({ code: 'SITE_REQUIRED', sites: [] })).toMatch(/isolated or unreadable/);
  });
});
