import { describe, expect, it } from 'vitest';
import {
  HandleMismatch,
  dequalifyPaths,
  hasBareHandle,
  parseHandle,
  qualifyPaths,
  qualifyValue,
} from '../src/handles.js';
import type { SiteRegistry } from '../src/registry.js';
import type { HandlePath } from '../src/manifest.js';

const registry = { get: (k: string) => (['acme', 'dev'].includes(k) ? { key: k } : undefined) } as unknown as SiteRegistry;

const at = (path: string): HandlePath[] => [{ path, kind: 'form' }];

describe('qualified handles', () => {
  it('qualifies a value and reads it back', () => {
    expect(qualifyValue('acme', 42)).toBe('acme:42');
    expect(parseHandle('acme:42', registry)).toEqual({ site: 'acme', id: 42 });
    expect(parseHandle(42, registry)).toEqual({ id: 42 });
    expect(parseHandle('42', registry)).toEqual({ id: 42 });
  });

  it('treats a colon string as a field code unless the prefix names a store we have', () => {
    // A field code is free text; only a known site key turns it into a handle.
    expect(parseHandle('other:42', registry)).toEqual({ code: 'other:42' });
    expect(parseHandle('phone', registry)).toEqual({ code: 'phone' });
    expect(parseHandle('acme:notanumber', registry)).toEqual({ code: 'acme:notanumber' });
  });

  it('walks plain, nested and array paths', () => {
    expect(qualifyPaths({ form_id: 1 }, at('form_id'), 'acme')).toEqual({ form_id: 'acme:1' });
    expect(qualifyPaths({ payload: { form_id: 1 } }, at('payload.form_id'), 'acme')).toEqual({ payload: { form_id: 'acme:1' } });
    expect(qualifyPaths({ items: [{ id: 1 }, { id: 2 }] }, at('items[].id'), 'acme'))
      .toEqual({ items: [{ id: 'acme:1' }, { id: 'acme:2' }] });
  });

  it('leaves a path that is not there alone rather than inventing a field', () => {
    expect(qualifyPaths({ a: 1 }, at('form_id'), 'acme')).toEqual({ a: 1 });
    expect(qualifyPaths({ items: 'not an array' }, at('items[].id'), 'acme')).toEqual({ items: 'not an array' });
    expect(qualifyPaths(null, at('form_id'), 'acme')).toBeNull();
  });

  it('leaves a value that is not a number alone', () => {
    expect(qualifyPaths({ form_id: null }, at('form_id'), 'acme')).toEqual({ form_id: null });
    expect(qualifyPaths({ form_id: 'already:1' }, at('form_id'), 'acme')).toEqual({ form_id: 'already:1' });
  });

  it('strips the qualifier down to the bare number the store expects', () => {
    expect(dequalifyPaths({ form_id: 'acme:7' }, at('form_id'), 'acme')).toEqual({ form_id: 7 });
    expect(dequalifyPaths({ items: [{ id: 'acme:1' }] }, at('items[].id'), 'acme')).toEqual({ items: [{ id: 1 }] });
  });

  it('refuses a handle that belongs to another store', () => {
    expect(() => dequalifyPaths({ form_id: 'dev:7' }, at('form_id'), 'acme')).toThrow(HandleMismatch);
    expect(() => dequalifyPaths({ form_id: 'dev:7' }, at('form_id'), 'acme')).toThrow(/dev/);
  });

  it('does not mistake a field code for a handle when stripping', () => {
    expect(dequalifyPaths({ form_id: 'phone' }, at('form_id'), 'acme')).toEqual({ form_id: 'phone' });
  });

  it('spots a bare number where a qualified handle was required', () => {
    expect(hasBareHandle({ form_id: 7 }, at('form_id'))).toBe(true);
    expect(hasBareHandle({ form_id: 'acme:7' }, at('form_id'))).toBe(false);
    expect(hasBareHandle({ items: [{ id: 'acme:1' }, { id: 2 }] }, at('items[].id'))).toBe(true);
    expect(hasBareHandle({ a: 1 }, at('form_id'))).toBe(false);
  });
});
