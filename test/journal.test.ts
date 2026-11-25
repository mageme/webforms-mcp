import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, KEY_RELEASING_CODES, KEY_TTL_MS, REPLAY_WINDOW_MS, canonical } from '../src/journal.js';
import { Confirmations, create, mutate } from '../src/mutate.js';
import { ApiError } from '../src/errors.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { GUIDANCE, sanitize } from '../src/errors.js';
import { untrustedBlock } from '../src/untrusted.js';

describe('journal', () => {
  it('canonicalizes key order', () => {
    expect(canonical({ b: 1, a: [{ d: null, c: 'x' }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
  it('reuses a pending request id and mints a new one after a terminal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const j = new Journal('k', join(dir, 'journal.jsonl'));
    const first = await j.begin('publish', { draft_id: 5 });
    expect(await j.begin('publish', { draft_id: 5 })).toBe(first);
    expect(await j.begin('publish', { draft_id: 6 })).not.toBe(first);
    await j.finish('publish', { draft_id: 5 }, first, 'failed', 'VALIDATION_FAILED');
    expect(await j.begin('publish', { draft_id: 5 })).not.toBe(first);
    const raw = JSON.stringify(await j.entries());
    expect(raw).not.toContain('draft_id');
  });
  it('does not reuse an indeterminate request id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const j = new Journal('k', join(dir, 'journal.jsonl'));
    const id = await j.begin('reply', { r: 1 });
    await j.finish('reply', { r: 1 }, id, 'indeterminate', 'INDETERMINATE');
    expect(await j.begin('reply', { r: 1 })).not.toBe(id);
  });
});

describe('sanitize', () => {
  it('strips control characters and caps length', () => {
    expect(sanitize('a' + String.fromCharCode(27) + '[31mb' + String.fromCharCode(7), 3)).toBe('a[3…');
    expect(untrustedBlock('x', { k: String.fromCharCode(0) + 'v' }).text).not.toContain(String.fromCharCode(0));
  });
  it('replays a fresh success and survives a torn record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const path = join(dir, 'journal.jsonl');
    const j = new Journal('k', path);
    const id = await j.begin('assign', { r: 1 });
    await j.finish('assign', { r: 1 }, id, 'succeeded');
    expect(await j.begin('assign', { r: 1 }), 'a just-succeeded call is replayed with its request id').toBe(id);
    appendFileSync(path, '{"ts":"x","operation":"assign"');
    const other = await j.begin('assign', { r: 2 });
    expect(readFileSync(path, 'utf8').split('\n').filter((l) => l.includes(other))).toHaveLength(1);
    expect(await j.begin('assign', { r: 1 })).toBe(id);
  });

  it('scopes identity by target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const a = new Journal('k', join(dir, 'j.jsonl'), 'store-a');
    const b = new Journal('k', join(dir, 'j.jsonl'), 'store-b');
    const id = await a.begin('x', { v: 1 });
    expect(await b.begin('x', { v: 1 })).not.toBe(id);
  });
});

describe('mutate', () => {
  it('keeps the entry pending on a network failure and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const j = new Journal('k', join(dir, 'j.jsonl'));
    const seen: string[] = [];
    await expect(mutate(j, 'op', { a: 1 }, async (rid) => { seen.push(rid); throw new ApiError(0, 'NETWORK', 'down'); })).rejects.toThrow();
    await mutate(j, 'op', { a: 1 }, async (rid) => { seen.push(rid); return 'ok'; });
    expect(seen[0]).toBe(seen[1]);
  });
  it('mints a fresh request id after REPLAY_UNAVAILABLE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-'));
    const j = new Journal('k', join(dir, 'j.jsonl'));
    const seen: string[] = [];
    const r = await mutate(j, 'op', { a: 1 }, async (rid) => { seen.push(rid); if (seen.length === 1) throw new ApiError(409, 'REPLAY_UNAVAILABLE', 'gone'); return 'ok'; });
    expect(r).toBe('ok');
    expect(new Set(seen).size).toBe(2);
  });
});

describe('confirmations', () => {
  it('keeps an approval on a mismatched take, dedupes by token and parses server expiries', () => {
    const c = new Confirmations();
    const id = c.remember('default', 'publish', 'draft', 5, 'tok', '2099-01-01 00:00:00');
    expect(c.remember('default', 'publish', 'draft', 5, 'tok', '2099-01-01 00:00:00')).toBe(id);
    expect(c.take(id, 'default', 'publish', 'draft', 6)).toBeUndefined();
    expect(c.take(id, 'default', 'publish', 'draft', 5)).toBe('tok');
    expect(c.take(id, 'default', 'publish', 'draft', 5)).toBeUndefined();
    expect(Confirmations.parseExpiry('2026-01-01 00:00:00')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(Confirmations.parseExpiry('2026-01-01T00:00:00+02:00')).toBe(Date.parse('2026-01-01T00:00:00+02:00'));
    const old = c.remember('default', 'reply', 'result', 1, 'old', '2000-01-01 00:00:00');
    expect(c.take(old, 'default', 'reply', 'result', 1)).toBeUndefined();
  });
});

describe('replaying a succeeded call', () => {
  it('is refused for operations whose answer describes live state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-replay-'));
    const journal = new Journal('k'.repeat(64), join(dir, 'journal.jsonl'), 'scope');

    const first = await journal.begin('open_draft', { form_id: 7 }, false);
    await journal.finish('open_draft', { form_id: 7 }, first, 'succeeded');
    const second = await journal.begin('open_draft', { form_id: 7 }, false);
    expect(second).not.toBe(first);

    // The default still shields a repeated irreversible call within the window.
    const note = await journal.begin('add_submission_note', { result_id: 3, text: 'hi' });
    await journal.finish('add_submission_note', { result_id: 3, text: 'hi' }, note, 'succeeded');
    expect(await journal.begin('add_submission_note', { result_id: 3, text: 'hi' })).toBe(note);
  });

  it('still reuses a pending entry, where the first call\'s fate is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfmcp-replay2-'));
    const journal = new Journal('k'.repeat(64), join(dir, 'journal.jsonl'), 'scope');

    const first = await journal.begin('open_draft', { form_id: 9 }, false);
    expect(await journal.begin('open_draft', { form_id: 9 }, false)).toBe(first);
  });

  it('runs a value set again after a lost answer anew once another value was set by the same operation', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-replay3-')), 'journal.jsonl'), 'scope');
    const op = 'notification:set-conditions';

    const lost = await journal.begin(op, { value: 'A' }, 'value');
    const b = await journal.begin(op, { value: 'B' }, 'value');
    await journal.finish(op, { value: 'B' }, b, 'succeeded');

    expect(await journal.begin(op, { value: 'A' }, 'value'), 'the server would replay A while the store holds B').not.toBe(lost);
  });

  it('does not reuse a pending entry older than the replay window', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-replay4-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const args = { value: 'A' };
    const old = new Date(Date.now() - REPLAY_WINDOW_MS - 1000).toISOString();
    appendFileSync(path, JSON.stringify({ ts: old, operation: 'notification:update', args_hash: journal.hashArgs(args), request_id: 'stale', state: 'pending' }) + '\n', { mode: 0o600 });

    expect(await journal.begin('notification:update', args, 'value')).not.toBe('stale');
  });

  it('retries a lost answer with its request id inside the window, whatever other operations ran meanwhile', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-replay5-')), 'journal.jsonl'), 'scope');

    const lost = await journal.begin('notification:update', { value: 'A' }, 'value');
    const other = await journal.begin('notification:set-conditions', { value: 'B' }, 'value');
    await journal.finish('notification:set-conditions', { value: 'B' }, other, 'succeeded');

    expect(await journal.begin('notification:update', { value: 'A' }, 'value')).toBe(lost);
  });

  it('retries a lost value with its request id when the other values were set before it', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-replay7-')), 'journal.jsonl'), 'scope');
    const op = 'notification:set-conditions';

    const b = await journal.begin(op, { value: 'B' }, 'value');
    await journal.finish(op, { value: 'B' }, b, 'succeeded');
    const lost = await journal.begin(op, { value: 'A' }, 'value');

    expect(await journal.begin(op, { value: 'A' }, 'value')).toBe(lost);
  });

  it('keeps reusing a pending entry of a live-state operation however old and whatever ran after it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-replay8-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const args = { form_id: 3, source_system: 'wf3', digest: 'd' };
    const old = new Date(Date.now() - REPLAY_WINDOW_MS - 1000).toISOString();
    appendFileSync(path, JSON.stringify({ ts: old, operation: 'prepare_import', args_hash: journal.hashArgs(args), request_id: 'lost', state: 'pending' }) + '\n', { mode: 0o600 });
    const other = await journal.begin('prepare_import', { ...args, digest: 'e' }, false);
    await journal.finish('prepare_import', { ...args, digest: 'e' }, other, 'succeeded');

    expect(await journal.begin('prepare_import', args, false), 'only the first request id reaches the import it opened').toBe('lost');
  });

  it('lets another operation that sets the same value overtake a pending entry, and writes only hashes of the values', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-replay9-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const active = ['notification-active:9'];

    const lost = await journal.begin('deactivate_notification', { notification_id: 9 }, 'value', active);
    const other = await journal.begin('deactivate_notification', { notification_id: 10 }, 'value', ['notification-active:10']);
    expect(await journal.begin('deactivate_notification', { notification_id: 9 }, 'value', active), 'another notification does not overtake it').toBe(lost);
    await journal.finish('deactivate_notification', { notification_id: 10 }, other, 'succeeded');
    const on = await journal.begin('activate_notification:confirm', { notification_id: 9, token: 't' }, true, active);
    await journal.finish('activate_notification:confirm', { notification_id: 9, token: 't' }, on, 'succeeded');

    expect(await journal.begin('deactivate_notification', { notification_id: 9 }, 'value', active)).not.toBe(lost);
    expect(readFileSync(path, 'utf8')).not.toContain('notification-active');
  });

  it('remembers an idempotency key past the replay window, and refuses it for other arguments', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-key-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const args = { formId: 3, fields: { notification_ref: 'u' } };
    const old = new Date(Date.now() - REPLAY_WINDOW_MS - 60_000).toISOString();
    const key = journal.hashArgs({ idempotency_key: 'copy-old' });
    appendFileSync(path, [
      { ts: old, operation: 'notification:duplicate', args_hash: journal.hashArgs(args), request_id: 'old-request', state: 'pending', key },
      { ts: old, operation: 'notification:duplicate', args_hash: journal.hashArgs(args), request_id: 'old-request', state: 'succeeded' },
    ].map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });

    expect(await journal.claim('notification:duplicate', args, true, [], 'copy-old')).toEqual({ requestId: 'old-request', reused: { state: 'succeeded', firstCallAt: old } });
    expect((await journal.claim('notification:duplicate', args)).requestId, 'without the key the old call is past the window').not.toBe('old-request');
    await expect(journal.claim('notification:duplicate', { ...args, fields: { notification_ref: 'v' } }, true, [], 'copy-old')).rejects.toThrow(/already used/);
    await expect(journal.claim('notification:add', args, true, [], 'copy-old')).rejects.toThrow(/already used/);
    await journal.claim('notification:add', args, true, [], 'copy-new');
    expect(readFileSync(path, 'utf8')).toContain(journal.hashArgs({ idempotency_key: 'copy-new' }));
    expect(readFileSync(path, 'utf8')).not.toContain('copy-new');
  });

  it('keeps retrying a lost creation with its request id after other creations, so the retry makes no duplicate', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-replay6-')), 'journal.jsonl'), 'scope');

    const lost = await journal.begin('notification:add', { name: 'A' });
    const b = await journal.begin('notification:add', { name: 'B' });
    await journal.finish('notification:add', { name: 'B' }, b, 'succeeded');

    expect(await journal.begin('notification:add', { name: 'A' })).toBe(lost);
  });

  it('frees a key only after a refusal that ran nothing, and keeps it bound after any other outcome', async () => {
    expect([...KEY_RELEASING_CODES]).toEqual(['VALIDATION_FAILED', 'ACTOR_NOT_ALLOWED']);
    for (const code of [...Object.keys(GUIDANCE), 'HTTP_500', 'HTTP_400', 'SOMETHING_NEW']) {
      const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-release-')), 'journal.jsonl'), 'scope');
      await create(journal, 'notification:add', { name: 'A' }, async () => { throw Object.assign(new ApiError(400, code, 'refused'), { attempt: 1 }); }, { key: 'K' }).catch(() => undefined);
      const fixed = journal.claim('notification:add', { name: 'B' }, true, [], 'K');
      if (KEY_RELEASING_CODES.includes(code as never)) expect((await fixed).reused, code).toBeUndefined();
      else await expect(fixed, code).rejects.toThrow(/already used/);
    }
  });

  it('binds a freed key to the call that used it next', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-release2-')), 'journal.jsonl'), 'scope');
    const refuse = async (): Promise<never> => { throw Object.assign(new ApiError(400, 'VALIDATION_FAILED', 'invalid'), { attempt: 1 }); };
    await create(journal, 'notification:add', { name: 'A' }, refuse, { key: 'K' }).catch(() => undefined);
    const made = await create(journal, 'notification:add', { name: 'B' }, async () => ({ uuid: 'u' }), { key: 'K' });
    expect(made.status.outcome).toBe('created');
    await expect(journal.claim('notification:add', { name: 'A' }, true, [], 'K')).rejects.toThrow(/already used/);
  });

  it('keeps a key bound when its request was sent before and is refused on the retry', async () => {
    const journal = new Journal('k'.repeat(64), join(mkdtempSync(join(tmpdir(), 'wfmcp-release3-')), 'journal.jsonl'), 'scope');
    await create(journal, 'notification:add', { name: 'A' }, async () => { throw new ApiError(0, 'NETWORK', 'lost'); }, { key: 'K' }).catch(() => undefined);
    await create(journal, 'notification:add', { name: 'A' }, async () => { throw Object.assign(new ApiError(400, 'VALIDATION_FAILED', 'invalid'), { attempt: 1 }); }, { key: 'K' }).catch(() => undefined);
    await expect(journal.claim('notification:add', { name: 'B' }, true, [], 'K'), 'the first send may have created').rejects.toThrow(/already used/);
  });

  it('holds a key for 30 days, after which the same key is a new request whatever its arguments', async () => {
    expect(KEY_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-ttl-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const args = { name: 'A' };
    const at = (age: number) => new Date(Date.now() - age).toISOString();
    const keyed = (id: string, key: string, age: number) => [
      { ts: at(age), operation: 'notification:add', args_hash: journal.hashArgs(args), request_id: id, state: 'pending', key: journal.hashArgs({ idempotency_key: key }) },
      { ts: at(age), operation: 'notification:add', args_hash: journal.hashArgs(args), request_id: id, state: 'succeeded' },
    ];
    appendFileSync(path, [...keyed('inside', 'K1', KEY_TTL_MS - 60_000), ...keyed('past', 'K2', KEY_TTL_MS)].map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });

    expect((await journal.claim('notification:add', args, true, [], 'K1')).requestId, 'inside the term the key replays').toBe('inside');
    const renewed = await journal.claim('notification:add', args, true, [], 'K2');
    expect(renewed.requestId, 'past the term the key is a new request').not.toBe('past');
    expect(renewed.reused).toBeUndefined();
    expect((await journal.claim('notification:add', args, true, [], 'K2')).requestId, 'and is bound to it from then on').toBe(renewed.requestId);
  });

  it('does not refuse a key past its term for other arguments', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wfmcp-ttl2-')), 'journal.jsonl');
    const journal = new Journal('k'.repeat(64), path, 'scope');
    const old = new Date(Date.now() - KEY_TTL_MS - 1000).toISOString();
    appendFileSync(path, JSON.stringify({ ts: old, operation: 'notification:add', args_hash: journal.hashArgs({ name: 'A' }), request_id: 'old', state: 'succeeded', key: journal.hashArgs({ idempotency_key: 'K' }) }) + '\n', { mode: 0o600 });

    await expect(journal.claim('notification:add', { name: 'B' }, true, [], 'K')).resolves.toMatchObject({ requestId: expect.any(String) });
  });
});
