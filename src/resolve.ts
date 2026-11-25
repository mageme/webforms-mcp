import type { SiteEntry, SiteRegistry } from './registry.js';

export type ResolveError =
  | { code: 'SITE_REQUIRED' | 'SITE_UNKNOWN'; sites: { key: string; host: string }[] }
  | { code: 'SITE_AMBIGUOUS'; candidates: string[] }
  | { code: 'SITE_ISOLATED'; key: string }
  | { code: 'SITE_CONFLICT'; active: string; requested: string };

export type Resolution = { ok: true; entry: SiteEntry } | { ok: false; error: ResolveError };

const roster = (registry: SiteRegistry): { key: string; host: string }[] =>
  registry.keys().map((key) => ({ key, host: registry.get(key)!.host }));

/**
 * Which store a call acts on: what it named, else what the conversation selected, else the only one
 * there is. A roster that failed to load in full disables that last step - a site left standing because
 * three others could not be read is not "the only site".
 */
export const resolveSite = (
  registry: SiteRegistry,
  explicit: string | undefined,
  active: string | undefined,
  isMutation: boolean,
): Resolution => {
  if (explicit !== undefined && explicit.trim() !== '') {
    const found = registry.find(explicit);
    if (!found.ok) {
      if (found.reason === 'ISOLATED') return { ok: false, error: { code: 'SITE_ISOLATED', key: explicit.trim() } };
      if (found.reason === 'AMBIGUOUS') return { ok: false, error: { code: 'SITE_AMBIGUOUS', candidates: found.candidates ?? [] } };
      return { ok: false, error: { code: 'SITE_UNKNOWN', sites: roster(registry) } };
    }
    if (isMutation && active !== undefined && active !== found.entry.key) {
      return { ok: false, error: { code: 'SITE_CONFLICT', active, requested: found.entry.key } };
    }
    return { ok: true, entry: found.entry };
  }
  if (active !== undefined) {
    const entry = registry.get(active);
    if (entry) return { ok: true, entry };
  }
  if (registry.size === 1 && registry.complete) {
    return { ok: true, entry: registry.get(registry.keys()[0])! };
  }
  return { ok: false, error: { code: 'SITE_REQUIRED', sites: roster(registry) } };
};

export const describeResolveError = (error: ResolveError): string => {
  switch (error.code) {
    case 'SITE_ISOLATED':
      return `SITE_ISOLATED: "${error.key}" is configured for a dedicated process; start it with --profile ${error.key}.`;
    case 'SITE_AMBIGUOUS':
      return `SITE_AMBIGUOUS: that host belongs to several sites (${error.candidates.join(', ')}); name one of them instead.`;
    case 'SITE_CONFLICT':
      return `SITE_CONFLICT: the active site is "${error.active}" but this write names "${error.requested}". Switch with use_site first, or drop the site argument.`;
    default: {
      const list = error.sites.map((s) => `${s.key} (${s.host})`).join(', ');
      const lead = error.code === 'SITE_UNKNOWN' ? 'SITE_UNKNOWN: no such site.' : 'SITE_REQUIRED: name the store to act on.';
      return `${lead} Available: ${list || 'none - every configured profile is isolated or unreadable'}. Call list_sites for detail.`;
    }
  }
};
