import { describe, expect, it } from 'vitest';
import { Confirmations } from '../src/mutate.js';

const soon = () => new Date(Date.now() + 60_000).toISOString();

describe('confirmations belong to one store', () => {
  it('does not let two sites share one approval for the same object id', () => {
    // Every store numbers its own drafts, so draft 42 exists on all of them.
    const c = new Confirmations();
    const id = c.remember('acme', 'publish', 'draft', 42, 'token-a', soon());
    expect(c.take(id, 'globex', 'publish', 'draft', 42)).toBeUndefined();
    expect(c.take(id, 'acme', 'publish', 'draft', 42)).toBe('token-a');
  });

  it('leaves the approval usable after a mismatched site tried it', () => {
    const c = new Confirmations();
    const id = c.remember('acme', 'reply', 'result', 7, 'token-b', soon());
    c.take(id, 'globex', 'reply', 'result', 7);
    expect(c.take(id, 'acme', 'reply', 'result', 7)).toBe('token-b');
  });

  it('still refuses a mismatched operation or object on the right site', () => {
    const c = new Confirmations();
    const id = c.remember('acme', 'publish', 'draft', 42, 'token-c', soon());
    expect(c.take(id, 'acme', 'reply', 'draft', 42)).toBeUndefined();
    expect(c.take(id, 'acme', 'publish', 'result', 42)).toBeUndefined();
    expect(c.take(id, 'acme', 'publish', 'draft', 43)).toBeUndefined();
  });

  it('gives the same token on the same site one id, and different sites different ids', () => {
    const c = new Confirmations();
    const first = c.remember('acme', 'publish', 'draft', 42, 'shared-token', soon());
    expect(c.remember('acme', 'publish', 'draft', 42, 'shared-token', soon())).toBe(first);
    expect(c.remember('globex', 'publish', 'draft', 42, 'shared-token', soon())).not.toBe(first);
  });

  it('hands a token back once and then forgets it', () => {
    const c = new Confirmations();
    const id = c.remember('acme', 'publish', 'draft', 42, 'token-d', soon());
    expect(c.take(id, 'acme', 'publish', 'draft', 42)).toBe('token-d');
    expect(c.take(id, 'acme', 'publish', 'draft', 42)).toBeUndefined();
  });

  it('refuses an approval whose moment has passed', () => {
    const c = new Confirmations();
    const id = c.remember('acme', 'publish', 'draft', 42, 'token-e', new Date(Date.now() - 1000).toISOString());
    expect(c.isExpired(id)).toBe(true);
    expect(c.take(id, 'acme', 'publish', 'draft', 42)).toBeUndefined();
  });
});

describe('a send that lost its answer', () => {
  it('counts as already approved only for the very call that was sent', async () => {
    const c = new Confirmations();
    const id = c.remember('acme', 'reply', 'result', 7, 'token-r', soon());
    expect(c.resent(id, 'acme', 'reply', 'result', 7, 'a')).toBe(false);
    await expect(c.redeem(id, Promise.reject(new Error('socket hang up')), 'a')).rejects.toThrow();
    expect(c.resent(id, 'acme', 'reply', 'result', 7, 'a')).toBe(true);
    expect(c.resent(id, 'acme', 'reply', 'result', 7, 'b')).toBe(false);
    expect(c.resent(id, 'acme', 'reply', 'result', 7, undefined)).toBe(false);
    expect(c.resent(id, 'globex', 'reply', 'result', 7, 'a')).toBe(false);
  });
});
