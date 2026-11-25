import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fsp } from 'node:fs';
import { Journal, MAX_JOURNAL_BYTES, type JournalEntry, type Replay } from '../src/journal.js';
import { create, mutate } from '../src/mutate.js';
import { ApiError } from '../src/errors.js';

const KEY = 'k'.repeat(64);
const dir = (name: string) => mkdtempSync(join(tmpdir(), `wfmcp-${name}-`));
const at = (age: number) => new Date(Date.now() - age).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const write = (path: string, entries: object[]) =>
  writeFileSync(path, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600, flag: 'a' });
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
const holdLock = (path: string, pid: number, extra: object = {}, file = `${path}.lock`) =>
  writeFileSync(file, JSON.stringify({ pid, host: hostname(), token: 'held', ...extra }), { mode: 0o600 });
/** A live process on this host other than this one. */
const LIVE = process.ppid;
const age = (file: string, ms: number) => {
  const old = new Date(Date.now() - ms);
  utimesSync(file, old, old);
};
const startOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop()?.trim().split(' ')[19]);
/** Resolves with the claim, or rejects once it has waited `ms`; the lock is removed afterwards either way so no claim hangs on. */
const settles = async (path: string, claim: Promise<unknown>, ms = 3000) => {
  try {
    return await Promise.race([claim, sleep(ms).then(() => { throw new Error('still waiting for the lock'); })]);
  } finally {
    rmSync(`${path}.lock`, { force: true });
    rmSync(`${path}.lock.break`, { force: true });
    await claim.catch(() => undefined);
  }
};

describe('two journals on one file', () => {
  it('run one key once, with the same arguments and with others', async () => {
    for (let round = 0; round < 20; round++) {
      const path = join(dir('race'), 'journal.jsonl');
      const [a, b] = [new Journal(KEY, path, 'scope'), new Journal(KEY, path, 'scope')];
      const same = await Promise.all([a.claim('form:create', { name: 'A' }, true, [], 'K'), b.claim('form:create', { name: 'A' }, true, [], 'K')]);
      expect(same[0].requestId, `round ${round}`).toBe(same[1].requestId);
      expect(same.filter((c) => c.reused === undefined), `round ${round}: one of them creates`).toHaveLength(1);

      const other = await Promise.allSettled([a.claim('form:create', { name: 'A' }, true, [], 'K2'), b.claim('form:create', { name: 'B' }, true, [], 'K2')]);
      expect(other.filter((r) => r.status === 'fulfilled'), `round ${round}`).toHaveLength(1);
      const refused = other.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
  });

  it('in two processes run each key once', async () => {
    const base = dir('procs');
    const path = join(base, 'journal.jsonl');
    const go = join(base, 'go');
    const child = (n: number) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'journal-claim-child.ts'), path, join(base, `ready${n}`), go, '40'], { cwd: join(import.meta.dirname, '..') });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err += d; });
      return new Promise<string[]>((resolve, reject) => proc.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)))));
    };
    const runs = [child(1), child(2)];
    while (!existsSync(join(base, 'ready1')) || !existsSync(join(base, 'ready2'))) await sleep(10);
    writeFileSync(go, '');
    const [first, second] = await Promise.all(runs);
    expect(second).toEqual(first);
    const begun = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEntry);
    expect(begun.filter((e) => e.state === 'pending')).toHaveLength(40);
  }, 30_000);
});

describe('the journal lock', () => {
  it('waits while another process holds it', async () => {
    const path = join(dir('held'), 'journal.jsonl');
    holdLock(path, LIVE);
    let done = false;
    const claim = new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }).then(() => { done = true; });
    await sleep(300);
    expect(done).toBe(false);
    rmSync(`${path}.lock`);
    await claim;
    expect(done).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('is waited for by an outcome too, so a compaction never drops it', async () => {
    const path = join(dir('held2'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    const id = await journal.begin('form:create', { name: 'A' });
    holdLock(path, LIVE);
    const finished = journal.finish('form:create', { name: 'A' }, id, 'succeeded');
    await sleep(300);
    expect((await journal.entries()).map((e) => e.state)).toEqual(['pending']);
    rmSync(`${path}.lock`);
    await finished;
    expect((await journal.entries()).map((e) => e.state)).toEqual(['pending', 'succeeded']);
  });

  it('is taken over from a holder that died, and only once among many waiters', async () => {
    const path = join(dir('dead'), 'journal.jsonl');
    holdLock(path, deadPid());
    const journals = Array.from({ length: 8 }, () => new Journal(KEY, path, 'scope'));
    const claims = await Promise.all(journals.map((j) => j.claim('form:create', { name: 'A' }, true, [], 'K')));
    expect(new Set(claims.map((c) => c.requestId)).size).toBe(1);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('is never taken over from a live holder on this host, however long it holds it', async () => {
    const path = join(dir('hung'), 'journal.jsonl');
    holdLock(path, LIVE);
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, old, old);
    let done = false;
    const claim = new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }).then(() => { done = true; });
    await sleep(500);
    expect(done).toBe(false);
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).token).toBe('held');
    rmSync(`${path}.lock`);
    await claim;
  });

  it('naming this process with a token it does not hold is taken over, as after a restart under the same pid', async () => {
    const path = join(dir('self'), 'journal.jsonl');
    holdLock(path, process.pid);
    age(`${path}.lock`, 120_000);
    await settles(path, new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }));
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(await new Journal(KEY, path, 'scope').entries()).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'linux')('is taken over when its pid now belongs to a process started at another time', async () => {
    const path = join(dir('reused'), 'journal.jsonl');
    holdLock(path, LIVE, { start: startOf(LIVE) + 1 });
    await settles(path, new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }));
    expect(await new Journal(KEY, path, 'scope').entries()).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'linux')('is kept while its pid still belongs to the process that took it', async () => {
    const path = join(dir('same-start'), 'journal.jsonl');
    holdLock(path, LIVE, { start: startOf(LIVE) });
    await expect(settles(path, new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }), 500)).rejects.toThrow(/still waiting/);
  });

  it('naming no valid pid is judged by its age', async () => {
    for (const pid of [0, -1, 1.5]) {
      const path = join(dir('badpid'), 'journal.jsonl');
      holdLock(path, pid);
      age(`${path}.lock`, 120_000);
      await settles(path, new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }));
      expect(await new Journal(KEY, path, 'scope').entries(), `pid ${pid}`).toHaveLength(1);
    }
  });

  it('is not broken while a live process holds the breaker, however old the breaker is', async () => {
    const path = join(dir('breaker'), 'journal.jsonl');
    holdLock(path, deadPid());
    holdLock(path, LIVE, {}, `${path}.lock.break`);
    age(`${path}.lock.break`, 120_000);
    await expect(settles(path, new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' }), 500)).rejects.toThrow(/still waiting/);
  });

  it('is released though its temporary file cannot be removed', async () => {
    const path = join(dir('tmp-rm'), 'journal.jsonl');
    const rm = fsp.rm;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation((p, o) => (String(p).includes('.lock.') && String(p).endsWith('.tmp') ? Promise.reject(new Error('EBUSY')) : rm(p, o)));
    try {
      await new Journal(KEY, path, 'scope').claim('form:create', { name: 'A' });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('lost while an outcome is recorded ends it with an error and records nothing', async () => {
    const path = join(dir('taken-finish'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    const id = await journal.begin('form:create', { name: 'A' });
    const internals = journal as unknown as { acquire: () => Promise<string> };
    const acquire = internals.acquire.bind(journal);
    internals.acquire = async () => {
      const token = await acquire();
      holdLock(path, LIVE);
      return token;
    };
    await expect(journal.finish('form:create', { name: 'A' }, id, 'succeeded')).rejects.toThrow(/taken over/);
    expect((await new Journal(KEY, path, 'scope').entries()).map((e) => e.state)).toEqual(['pending']);
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).token).toBe('held');
  });

  it('lost while a compaction runs leaves the file as it was', async () => {
    const path = join(dir('taken-compact'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    write(path, [{ ts: at(40 * DAY), operation: 'form:create', args_hash: 'h', request_id: 'old', state: 'succeeded' }]);
    const before = { ino: statSync(path).ino, raw: readFileSync(path, 'utf8') };
    const internals = journal as unknown as { read: () => Promise<unknown> };
    const read = internals.read.bind(journal);
    internals.read = async () => {
      const seen = await read();
      holdLock(path, LIVE);
      return seen;
    };
    await expect(journal.compact()).rejects.toThrow(/taken over/);
    expect({ ino: statSync(path).ino, raw: readFileSync(path, 'utf8') }).toEqual(before);
  });

  it('lost while a claim runs ends the claim with an error and records nothing', async () => {
    const path = join(dir('taken'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    await journal.begin('form:create', { name: 'A' });
    const internals = journal as unknown as { read: () => Promise<unknown> };
    const read = internals.read.bind(journal);
    internals.read = async () => {
      const seen = await read();
      holdLock(path, process.pid);
      return seen;
    };
    await expect(journal.claim('form:create', { name: 'B' })).rejects.toThrow(/taken over/);
    expect((await new Journal(KEY, path, 'scope').entries())).toHaveLength(1);
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).token, 'the new holder keeps its lock').toBe('held');
  });
});

describe('an outcome that cannot be recorded', () => {
  const lost = { claim: async () => ({ requestId: 'r' }), finish: async () => { throw new Error('taken over'); } } as unknown as Journal;
  const refused = async () => { throw new ApiError(422, 'VALIDATION_FAILED', 'bad'); };

  it('leaves the error of the call itself to the caller', async () => {
    const logged: string[] = [];
    await expect(mutate(lost, 'op', {}, refused, (l) => logged.push(l))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(create(lost, 'op', {}, refused, { log: (l) => logged.push(l) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(logged).toHaveLength(2);
  });
});

describe('a full journal', () => {
  const filler = (journal: Journal, count: number) =>
    Array.from({ length: count }, (_, i) => [
      { ts: at(40 * DAY), operation: 'form:create', args_hash: journal.hashArgs({ name: `old${i}` }), request_id: `filler-${i}`, state: 'pending', key: journal.hashArgs({ idempotency_key: `old${i}` }) },
      { ts: at(40 * DAY), operation: 'form:create', args_hash: journal.hashArgs({ name: `old${i}` }), request_id: `filler-${i}`, state: 'succeeded' },
    ]).flat();

  it('is compacted: a key inside its term still answers with its first request, and pending requests stay', async () => {
    const path = join(dir('full'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    const args = { name: 'kept' };
    const first = at(5 * DAY);
    write(path, [
      { ts: first, operation: 'form:create', args_hash: journal.hashArgs(args), request_id: 'kept', state: 'pending', key: journal.hashArgs({ idempotency_key: 'K' }) },
      { ts: first, operation: 'form:create', args_hash: journal.hashArgs(args), request_id: 'kept', state: 'succeeded' },
      { ts: at(40 * DAY), operation: 'draft:open', args_hash: journal.hashArgs({ form: 1 }), request_id: 'lost', state: 'pending' },
      { ts: at(40 * DAY), operation: 'form:publish', args_hash: journal.hashArgs({ form: 2 }), request_id: 'unknown', state: 'indeterminate', code: 'INDETERMINATE' },
    ]);
    write(path, filler(journal, 20_000));
    expect(statSync(path).size).toBeGreaterThan(MAX_JOURNAL_BYTES);

    expect(await journal.claim('form:create', args, true, [], 'K')).toEqual({ requestId: 'kept', reused: { state: 'succeeded', firstCallAt: first } });
    expect(statSync(path).size).toBeLessThan(MAX_JOURNAL_BYTES / 4);
    expect(await journal.begin('draft:open', { form: 1 }, false)).toBe('lost');
    expect((await journal.entries()).map((e) => e.request_id)).toContain('unknown');
    expect(await journal.claim('form:create', { name: 'old1' }, true, [], 'old1'), 'an expired key is a new request').not.toHaveProperty('reused');
  });

  it('that holds only live requests is read and left as it is', async () => {
    const path = join(dir('live'), 'journal.jsonl');
    const journal = new Journal(KEY, path, 'scope');
    write(path, filler(journal, 20_000).map((e) => ({ ...e, ts: at(DAY) })));
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(MAX_JOURNAL_BYTES);
    await expect(journal.claim('form:create', { name: 'old7' }, true, [], 'old7')).resolves.toMatchObject({ requestId: 'filler-7' });
    await expect(journal.claim('form:create', { name: 'old8' }, true, [], 'old8')).resolves.toMatchObject({ requestId: 'filler-8' });
    expect(statSync(path).size).toBe(size);
  });

  it('answers every call after compaction as it did before', async () => {
    const original = join(dir('equiv'), 'journal.jsonl');
    const a = new Journal(KEY, original, 'A');
    const b = new Journal('other-key', original, 'B');
    const rec = (j: Journal, age: number, operation: string, args: object, id: string, state: string, extra: object = {}) =>
      ({ ts: at(age), operation, args_hash: j.hashArgs(args), request_id: id, state, ...extra });
    const keyOf = (j: Journal, k: string) => ({ key: j.hashArgs({ idempotency_key: k }) });
    const valuesOf = (j: Journal, ...v: string[]) => ({ values: v.map((x) => j.hashArgs(x)) });
    write(original, [
      rec(a, 5 * DAY, 'form:create', { n: 1 }, 'a-key-live', 'pending', keyOf(a, 'K1')), rec(a, 5 * DAY, 'form:create', { n: 1 }, 'a-key-live', 'succeeded'),
      rec(b, 5 * DAY, 'form:create', { n: 1 }, 'b-key-live', 'pending', keyOf(b, 'K1')), rec(b, 5 * DAY, 'form:create', { n: 1 }, 'b-key-live', 'indeterminate', { code: 'INDETERMINATE' }),
      rec(a, 31 * DAY, 'form:create', { n: 2 }, 'a-key-old', 'pending', keyOf(a, 'K2')), rec(a, 31 * DAY, 'form:create', { n: 2 }, 'a-key-old', 'succeeded'),
      rec(a, 2 * DAY, 'form:create', { n: 3 }, 'a-key-freed', 'pending', keyOf(a, 'K3')), rec(a, 2 * DAY, 'form:create', { n: 3 }, 'a-key-freed', 'failed', { code: 'VALIDATION_FAILED', released: true }),
      rec(a, 40 * DAY, 'draft:open', { f: 1 }, 'a-open-pending', 'pending'),
      rec(a, 40 * DAY, 'notification:activate', { id: 9 }, 'a-act-pending', 'pending', valuesOf(a, 'notification-active:9')),
      rec(a, 39 * DAY, 'notification:deactivate', { id: 9 }, 'a-deact', 'pending', valuesOf(a, 'notification-active:9')), rec(a, 39 * DAY, 'notification:deactivate', { id: 9 }, 'a-deact', 'succeeded'),
      rec(a, 40 * DAY, 'form:publish', { d: 1 }, 'a-pub-pending', 'pending'),
      rec(a, 39 * DAY, 'form:publish', { d: 2 }, 'a-pub-other', 'pending'), rec(a, 39 * DAY, 'form:publish', { d: 2 }, 'a-pub-other', 'failed', { code: 'X' }),
      rec(a, 40 * DAY, 'form:publish', { d: 3 }, 'a-indet', 'pending'), rec(a, 40 * DAY, 'form:publish', { d: 3 }, 'a-indet', 'indeterminate'),
      rec(a, 20 * 60_000, 'form:create', { n: 4 }, 'a-past-window', 'pending'), rec(a, 20 * 60_000, 'form:create', { n: 4 }, 'a-past-window', 'succeeded'),
      rec(a, 2 * 60_000, 'form:create', { n: 5 }, 'a-fresh', 'pending'), rec(a, 2 * 60_000, 'form:create', { n: 5 }, 'a-fresh', 'succeeded'),
      rec(a, 3 * 60_000, 'notification:update', { u: 1 }, 'a-val-pending', 'pending'),
      rec(a, 2 * 60_000, 'notification:update', { u: 2 }, 'a-val-other', 'pending'), rec(a, 2 * 60_000, 'notification:update', { u: 2 }, 'a-val-other', 'succeeded'),
    ]);
    const compacted = join(dir('equiv2'), 'journal.jsonl');
    copyFileSync(original, compacted);
    await new Journal(KEY, compacted, 'A').compact();
    expect(statSync(compacted).size).toBeLessThan(statSync(original).size);

    const probes: [string, object, Replay, string[], string?][] = [
      ['form:create', { n: 1 }, true, [], 'K1'], ['form:create', { n: 9 }, true, [], 'K1'], ['form:create', { n: 2 }, true, [], 'K2'],
      ['form:create', { n: 9 }, true, [], 'K2'], ['form:create', { n: 9 }, true, [], 'K3'], ['form:create', { n: 3 }, true, [], 'K3'],
      ['draft:open', { f: 1 }, false, []], ['draft:open', { f: 1 }, 'value', []], ['draft:open', { f: 1 }, true, []],
      ['notification:activate', { id: 9 }, true, ['notification-active:9']], ['notification:activate', { id: 9 }, false, ['notification-active:9']],
      ['notification:activate', { id: 9 }, false, []], ['form:publish', { d: 1 }, true, []], ['form:publish', { d: 1 }, 'value', []],
      ['form:publish', { d: 3 }, true, []], ['form:create', { n: 4 }, true, []], ['form:create', { n: 5 }, true, []], ['form:create', { n: 5 }, false, []],
      ['form:create', { n: 1 }, true, []], ['notification:update', { u: 1 }, 'value', []], ['notification:update', { u: 1 }, true, []],
      ['notification:update', { u: 2 }, true, []],
    ];
    const outcome = async (path: string, scope: 'A' | 'B', [operation, args, replay, values, key]: (typeof probes)[number]) => {
      const copy = join(dir('probe'), 'journal.jsonl');
      copyFileSync(path, copy);
      const j = scope === 'A' ? new Journal(KEY, copy, 'A') : new Journal('other-key', copy, 'B');
      return j.claim(operation, args, replay, values, key).then(
        (c) => (c.reused ? { id: c.requestId, reused: c.reused } : { id: 'new' }),
        (e: { code?: string }) => ({ error: e.code }),
      );
    };
    for (const scope of ['A', 'B'] as const) {
      for (const probe of probes) {
        expect(await outcome(compacted, scope, probe), `${scope} ${JSON.stringify(probe)}`).toEqual(await outcome(original, scope, probe));
      }
    }
  });
});

