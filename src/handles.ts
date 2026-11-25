import type { HandlePath } from './manifest.js';
import type { SiteRegistry } from './registry.js';

/**
 * Every store numbers its own forms, drafts and submissions, so a bare 42 says nothing about which
 * store it came from. A shared process writes ids as "<site>:<number>" and requires them back in that
 * form: the qualifier proves which store an id belongs to, but it never chooses the store - that stays
 * the resolver's job, so no second, quieter way of picking a tenant appears.
 */
export const QUALIFIED = /^([a-z0-9][a-z0-9_-]{0,31}):([1-9][0-9]{0,15})$/;
const BARE_NUMBER = /^[1-9][0-9]{0,15}$/;

export class HandleMismatch extends Error {
  constructor(readonly expected: string, readonly got: string) {
    super(`SITE_HANDLE_MISMATCH: that id belongs to "${got}", but this call is addressed to "${expected}". Repeat it with site: "${got}", or use an id from "${expected}".`);
  }
}

export class HandleUnqualified extends Error {
  constructor(sites: string[], withSite = false) {
    super(`HANDLE_UNQUALIFIED: a bare number does not say which store it belongs to. Write ids as "<site>:<id>", e.g. "${sites[0] ?? 'site'}:42", exactly as they were returned.${withSite ? ' A bare id copied from a form document is taken when the call names its store with site.' : ''}`);
  }
}

export const qualifyValue = (siteKey: string, value: number): string => `${siteKey}:${value}`;

/**
 * What a caller wrote: a handle, or a field code. A colon string counts as a handle only when the part
 * before the colon names a store we actually have - otherwise a field legitimately coded "acme:42"
 * would be misread as an identifier.
 */
export const parseHandle = (raw: string | number, registry: Pick<SiteRegistry, 'get'>): { site?: string; id: number } | { code: string } => {
  if (typeof raw === 'number') return { id: raw };
  const match = QUALIFIED.exec(raw);
  if (match && registry.get(match[1])) return { site: match[1], id: Number(match[2]) };
  if (BARE_NUMBER.test(raw)) return { id: Number(raw) };
  return { code: raw };
};

interface Segment { key: string; array: boolean }

const segments = (path: string): Segment[] =>
  path.split('.').map((part) => (part.endsWith('[]') ? { key: part.slice(0, -2), array: true } : { key: part, array: false }));

/** Rebuilds the node with `leaf` applied wherever the path lands; an absent path changes nothing. */
const walk = (node: unknown, segs: Segment[], leaf: (v: unknown) => unknown): unknown => {
  if (node === null || typeof node !== 'object') return node;
  const [head, ...rest] = segs;
  const record = node as Record<string, unknown>;
  if (!(head.key in record)) return node;
  const child = record[head.key];
  if (head.array) {
    if (!Array.isArray(child)) return node;
    return { ...record, [head.key]: child.map((item) => (rest.length === 0 ? leaf(item) : walk(item, rest, leaf))) };
  }
  return { ...record, [head.key]: rest.length === 0 ? leaf(child) : walk(child, rest, leaf) };
};

const visit = (node: unknown, segs: Segment[], seen: (v: unknown) => void): void => {
  if (node === null || typeof node !== 'object') return;
  const [head, ...rest] = segs;
  const record = node as Record<string, unknown>;
  if (!(head.key in record)) return;
  const child = record[head.key];
  if (head.array) {
    if (!Array.isArray(child)) return;
    for (const item of child) rest.length === 0 ? seen(item) : visit(item, rest, seen);
    return;
  }
  if (rest.length === 0) seen(child);
  else visit(child, rest, seen);
};

export const qualifyPaths = (value: unknown, paths: HandlePath[], siteKey: string): unknown =>
  paths.reduce((acc, p) => walk(acc, segments(p.path), (v) => (typeof v === 'number' ? qualifyValue(siteKey, v) : v)), value);

const TARGET = /^(field|fieldset)_(.+)$/;

/** "acme:12", or "acme:12:first" for one part of a composite field as cr_map names it. */
const SETTING_REF = /^([a-z0-9][a-z0-9_-]{0,31}):([1-9][0-9]{0,15})(:[A-Za-z0-9_]{1,32})?$/;

const settingRef = (raw: string, siteKey: string, registry?: Pick<SiteRegistry, 'get'>): string | number => {
  const match = SETTING_REF.exec(raw);
  if (!match || !(registry ? registry.get(match[1]) : match[1] === siteKey)) return raw;
  if (match[1] !== siteKey) throw new HandleMismatch(siteKey, match[1]);
  return match[3] ? `${match[2]}${match[3]}` : Number(match[2]);
};

/**
 * Ids a model copied from answers into free-form settings or translations: values of `*_id` / `*_ids` keys,
 * every entry under `cr_map`, and object keys (translations are keyed by id). Other text is left alone, so a
 * label that happens to read "acme:4" is never rewritten.
 */
const dequalifySettings = (node: unknown, siteKey: string, registry?: Pick<SiteRegistry, 'get'>, idValue = false): unknown => {
  if (typeof node === 'string') return idValue ? settingRef(node, siteKey, registry) : node;
  if (Array.isArray(node)) return node.map((item) => dequalifySettings(item, siteKey, registry, idValue));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const bareKey = String(settingRef(key, siteKey, registry));
    out[bareKey] = dequalifySettings(value, siteKey, registry, idValue || key === 'cr_map' || /_ids?$/.test(key));
  }
  return out;
};

/** "field_acme:12" becomes "field_12" when acme is a store; anything else is left for the store to judge. */
const dequalifyTarget = (t: unknown, siteKey: string, registry?: Pick<SiteRegistry, 'get'>): unknown => {
  const target = typeof t === 'string' ? TARGET.exec(t) : null;
  const handle = target ? QUALIFIED.exec(target[2]) : null;
  if (!target || !handle || !(registry ? registry.get(handle[1]) : handle[1] === siteKey)) return t;
  if (handle[1] !== siteKey) throw new HandleMismatch(siteKey, handle[1]);
  return `${target[1]}_${handle[2]}`;
};

/**
 * Strips the qualifier so the store receives the bare number it knows - and so the journal hashes the
 * same body whichever spelling the caller used. A qualifier naming another store is refused here. On a
 * "ref" path a colon string is a handle only when its prefix names a store of `registry`; otherwise it is a code.
 */
export const dequalifyPaths = (value: unknown, paths: HandlePath[], siteKey: string, registry?: Pick<SiteRegistry, 'get'>): unknown =>
  paths.reduce((acc, p) => walk(acc, segments(p.path), (v) => {
    if (p.accepts === 'settings') return dequalifySettings(v, siteKey, registry);
    if (p.accepts === 'keys') return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [String(settingRef(k, siteKey, registry)), x]))
      : v;
    if (p.accepts === 'target') return Array.isArray(v) ? v.map((t) => dequalifyTarget(t, siteKey, registry)) : dequalifyTarget(v, siteKey, registry);
    if (typeof v !== 'string') return v;
    if (p.accepts === 'ref') {
      const parsed = parseHandle(v, registry ?? { get: (k: string) => (k === siteKey ? ({} as never) : undefined) });
      if (!('site' in parsed) || parsed.site === undefined) return v;
      if (parsed.site !== siteKey) throw new HandleMismatch(siteKey, parsed.site);
      return parsed.id;
    }
    const match = QUALIFIED.exec(v);
    if (!match) return v;
    if (match[1] !== siteKey) throw new HandleMismatch(siteKey, match[1]);
    return Number(match[2]);
  }), value);

const isBare = (v: unknown): boolean => typeof v === 'number' || (typeof v === 'string' && BARE_NUMBER.test(v));

/**
 * True when a bare number on an "either" path is all that ties the call to a store: no strict handle in the
 * same call (a qualified draft_id pins the store of a bare section id) and no site argument naming it.
 */
export const hasUnpinnedBareId = (value: unknown, paths: HandlePath[], namesSite: boolean): boolean => {
  if (namesSite || paths.some((p) => p.accepts === undefined)) return false;
  let bare = false;
  for (const p of paths) {
    if (p.accepts === 'either') visit(value, segments(p.path), (v) => { if (isBare(v)) bare = true; });
  }
  return bare;
};

/** True when a strict handle arrived as a bare number, which a shared process refuses. */
export const hasBareHandle = (value: unknown, paths: HandlePath[]): boolean => {
  let bare = false;
  for (const p of paths) {
    if (p.accepts !== undefined) continue;
    visit(value, segments(p.path), (v) => {
      if (typeof v === 'number' || (typeof v === 'string' && BARE_NUMBER.test(v))) bare = true;
    });
  }
  return bare;
};
