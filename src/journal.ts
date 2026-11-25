import { constants as fsConstants, promises as fs, readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { configDir, openPrivateFile } from './config.js';
import { ApiError } from './errors.js';

export type JournalState = 'pending' | 'succeeded' | 'failed' | 'indeterminate';

export interface JournalEntry {
  ts: string;
  operation: string;
  args_hash: string;
  request_id: string;
  state: JournalState;
  code?: string;
  /** keyed hashes of the values the call sets (see Journal.begin); absent on older entries */
  values?: string[];
  /** keyed hash of the caller's idempotency key */
  key?: string;
  /** on a terminal record: the server refused the request before running it, so its key is free again */
  released?: true;
}

/** What claim found: a request id it reuses, the state of that request and when it was first made. */
export interface Claim {
  requestId: string;
  reused?: { state: JournalState; firstCallAt: string };
}

/** Past this size a claim compacts the journal (see retained). */
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
/** A journal larger than this is not read: compaction keeps it smaller unless its live requests alone outgrow it. */
export const JOURNAL_READ_LIMIT = 8 * MAX_JOURNAL_BYTES;
/**
 * A lock of a process on this host is taken over only once that process is gone; one of another host never (the
 * journal belongs to one machine). A lock file that names no valid owner ends after this.
 */
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 60_000;
/** A succeeded entry younger than this is replayed (same request_id) when the host asks again; the server keeps outcomes for 24 h. */
export const REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** true replays a fresh succeeded call; false only a pending one; 'value' a pending one that nothing has overtaken. */
export type Replay = boolean | 'value';
/** How long a caller's idempotency key holds its request; well inside the 90 days after which the server forgets the request itself. */
export const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refusals the server gives before it runs anything; a key whose first send ended in one is free again. */
export const KEY_RELEASING_CODES = ['VALIDATION_FAILED', 'ACTOR_NOT_ALLOWED'] as const;

/**
 * Append-only JSONL journal: operation + keyed hash of canonical args → request_id. A crashed or
 * retried mutation reuses its request_id so the server replays instead of re-executing. Entries are
 * fsync'd before the caller may dispatch; no payloads or responses are stored. A transport failure
 * leaves the entry pending so the retry reuses the request_id (the server replays a committed outcome);
 * an `indeterminate` outcome is never reused because the server refuses its replay. Every read-check-append runs
 * under a lock file next to the journal, so server processes sharing it claim one key once.
 */
export class Journal {
  private chain: Promise<unknown> = Promise.resolve();
  private token = '';

  /** @param scope stable id of the API target + principal, so entries never cross stores or credentials */
  constructor(private readonly key: string, private readonly path = join(configDir(), 'journal.jsonl'), private readonly scope = '') {}

  hashArgs(args: unknown): string {
    return createHmac('sha256', this.key).update(this.scope + '\n' + canonical(args)).digest('hex');
  }

  async entries(): Promise<JournalEntry[]> {
    return (await this.read()).entries;
  }

  /** Rewrites the journal with only the entries a claim can still act on (see retained). */
  compact(): Promise<void> {
    return this.serialized(async () => {
      await this.rewrite(retained((await this.read()).entries));
    });
  }

  private async read(): Promise<{ entries: JournalEntry[]; size: number }> {
    let handle;
    try {
      handle = await openPrivateFile(this.path, fsConstants.O_RDONLY);
    } catch {
      return { entries: [], size: 0 };
    }
    try {
      const { size } = await handle.stat();
      if (size > JOURNAL_READ_LIMIT) {
        throw new Error(`${this.path} exceeds ${JOURNAL_READ_LIMIT} bytes with requests still inside their term; it is left as it is so that no idempotency key is lost.`);
      }
      const raw = (await handle.readFile()).toString('utf8');
      const entries: JournalEntry[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          entries.push(JSON.parse(line) as JournalEntry);
        } catch {
          // a torn final record from a crash mid-append is ignored; everything before it is intact
        }
      }
      return { entries, size };
    } finally {
      await handle.close();
    }
  }

  /** The entries, compacted first once the file outgrows MAX_JOURNAL_BYTES and compaction at least halves it. */
  private async compacted(): Promise<JournalEntry[]> {
    const { entries, size } = await this.read();
    if (size <= MAX_JOURNAL_BYTES) return entries;
    const kept = retained(entries);
    if (kept.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0) > size / 2) return entries;
    await this.rewrite(kept);
    return kept;
  }

  private async rewrite(entries: JournalEntry[]): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await openPrivateFile(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
      try {
        await handle.write(entries.map((e) => JSON.stringify(e) + '\n').join(''));
        await handle.datasync();
      } finally {
        await handle.close();
      }
      await this.assertOwned();
      await fs.rename(tmp, this.path);
      await syncDir(dirname(this.path));
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /**
   * Reuses the request_id of a still-pending entry for the same operation+args, else mints one. Serialized per process.
   *
   * @param replay false for operations whose answer describes live state (opening a draft reports its
   *   current revisions): calling one again is a new intent, not a retry, and replaying a ten-minute-old
   *   answer would hand back stale revisions. A pending entry is still reused, because there the first
   *   call's fate is unknown. 'value' for operations that set a value, which running again does no harm:
   *   no succeeded call is replayed either, and a pending one only inside the replay window and while no
   *   later call of the same operation with other arguments was made, after which the server's replay
   *   would report an outcome the store no longer holds.
   * @param values the values the call sets, each named with its entity (`notification-active:9`): a call of
   *   another operation that sets one of them, such as activate after deactivate, overtakes a pending entry
   *   too, and with values named it overtakes in every mode, a succeeded entry as well (mass_status after
   *   set_submission_status). Only their keyed hashes are written.
   */
  begin(operation: string, args: unknown, replay: Replay = true, values: string[] = []): Promise<string> {
    return this.claim(operation, args, replay, values).then((c) => c.requestId);
  }

  /**
   * begin() that also says what it reused. With a caller's idempotency key the key alone decides: the request made
   * under it is reused whatever became of it for KEY_TTL_MS, so the server answers with that request's outcome and
   * one key never makes a second object; a key already used for another operation or other arguments is refused
   * before anything is sent. Only a request whose first send the server refused before running anything frees its
   * key (see KEY_RELEASING_CODES). A call without a key never reuses a request made under one.
   */
  claim(operation: string, args: unknown, replay: Replay = true, values: string[] = [], key?: string): Promise<Claim> {
    return this.serialized(async () => {
      const hash = this.hashArgs(args);
      const entries = await this.compacted();
      const reuse = (requestId: string, state: JournalState): Claim =>
        ({ requestId, reused: { state, firstCallAt: entries.find((e) => e.request_id === requestId)?.ts ?? '' } });
      const keyHash = key === undefined ? undefined : this.hashArgs({ idempotency_key: key });
      const mine = values.map((v) => this.hashArgs(v));
      if (keyHash !== undefined) {
        const released = new Set(entries.filter((e) => e.released).map((e) => e.request_id));
        let last: JournalEntry | undefined;
        for (const e of entries) {
          if (e.key !== keyHash || released.has(e.request_id) || Date.now() - Date.parse(e.ts) >= KEY_TTL_MS) continue;
          if (e.operation !== operation || e.args_hash !== hash) {
            throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', `This idempotency_key was already used at ${e.ts} for a different call; nothing was done. Use a new key for a new call, or repeat the first call exactly.`);
          }
          last = e;
        }
        if (last) return reuse(last.request_id, [...entries].reverse().find((e) => e.request_id === last.request_id)?.state ?? 'pending');
      } else {
        const keyed = new Set(entries.filter((e) => e.key !== undefined).map((e) => e.request_id));
        const latest = new Map<string, { entry: JournalEntry; at: number }>();
        let lastOther = -1;
        entries.forEach((e, at) => {
          const same = e.operation === operation && e.args_hash === hash && !keyed.has(e.request_id);
          if (same) latest.set(e.request_id, { entry: e, at });
          // a terminal record names no values; with values only a call that sets one of them overtakes
          else if (mine.length > 0 ? (e.values ? e.values.some((v) => mine.includes(v)) : e.state === 'pending' && e.operation === operation) : e.operation === operation) lastOther = at;
        });
        for (const { entry: e, at } of latest.values()) {
          const fresh = Date.now() - Date.parse(e.ts) < REPLAY_WINDOW_MS;
          const overtaken = at < lastOther && (replay === 'value' || mine.length > 0);
          if (e.state === 'pending' && !overtaken && (replay !== 'value' || fresh)) return reuse(e.request_id, 'pending');
          if (e.state === 'succeeded' && replay === true && fresh && !overtaken) return reuse(e.request_id, 'succeeded');
        }
      }
      const requestId = randomUUID();
      await this.append({ ts: new Date().toISOString(), operation, args_hash: hash, request_id: requestId, state: 'pending', ...(mine.length > 0 ? { values: mine } : {}), ...(keyHash !== undefined ? { key: keyHash } : {}) });
      return { requestId };
    });
  }

  /** @param released the server refused the request before running it: a key the request was made under is free again */
  finish(operation: string, args: unknown, requestId: string, state: Exclude<JournalState, 'pending'>, code?: string, released = false): Promise<void> {
    return this.serialized(() =>
      this.append({ ts: new Date().toISOString(), operation, args_hash: this.hashArgs(args), request_id: requestId, state, ...(code ? { code } : {}), ...(released ? { released: true as const } : {}) }),
    );
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      this.token = await this.acquire();
      try {
        return await work();
      } finally {
        try {
          if ((await readLock(this.lockPath))?.token === this.token) await fs.rm(this.lockPath, { force: true });
        } finally {
          held.delete(this.token);
        }
      }
    };
    const next = this.chain.then(locked, locked);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  private async acquire(): Promise<string> {
    const token = randomUUID();
    // held before the file names it, so another journal of this process never sees it unclaimed
    held.add(token);
    try {
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (!(await createExclusive(this.lockPath, owner(token)))) {
        await this.breakIfStale(token);
        if (Date.now() > deadline) {
          const holder = await readLock(this.lockPath);
          throw new Error(`${this.lockPath} has been held for over ${LOCK_WAIT_MS / 1000} s by process ${holder?.pid ?? '?'} on ${holder?.host ?? '?'}; nothing was recorded. Delete the file only if that process is no webforms-mcp server.`);
        }
        await sleep(5 + Math.random() * 20);
      }
      return token;
    } catch (e) {
      held.delete(token);
      throw e;
    }
  }

  /** Removes a stale lock; a second lock file, owned like the lock, lets one waiter at a time do it, so a fresh lock is never removed. */
  private async breakIfStale(token: string): Promise<void> {
    const seen = await readLock(this.lockPath);
    if (!seen || !isStale(seen)) return;
    const breaker = `${this.lockPath}.break`;
    if (!(await createExclusive(breaker, owner(token)))) {
      const other = await readLock(breaker);
      if (other && isStale(other)) await fs.rm(breaker, { force: true });
      return;
    }
    try {
      const now = await readLock(this.lockPath);
      if (now && now.ino === seen.ino && now.raw === seen.raw && isStale(now)) await fs.rm(this.lockPath, { force: true });
    } finally {
      await fs.rm(breaker, { force: true });
    }
  }

  /** Throws when another process took the lock over meanwhile, so nothing is written on a stale view of the journal. */
  private async assertOwned(): Promise<void> {
    if ((await readLock(this.lockPath))?.token !== this.token) {
      throw new Error(`${this.lockPath} was taken over by another process; nothing was recorded.`);
    }
  }

  private async append(entry: JournalEntry): Promise<void> {
    await this.assertOwned();
    const handle = await openPrivateFile(this.path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT);
    try {
      const { size } = await handle.stat();
      let prefix = '';
      if (size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        if (tail.toString('utf8') !== '\n') prefix = '\n';
      }
      await handle.write(prefix + JSON.stringify(entry) + '\n');
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }
}

interface LockInfo {
  raw: string;
  token?: string;
  pid?: number;
  host?: string;
  /** when the owner started, where the platform tells (see startOf) */
  start?: number;
  ino: number;
  mtimeMs: number;
}

/** Tokens of the locks this process holds or is taking, across every Journal of it. */
const held = new Set<string>();

/** Start time of a process in clock ticks since boot, from /proc on Linux; undefined elsewhere or when unreadable. */
const startOf = (pid: number): number | undefined => {
  if (process.platform !== 'linux') return undefined;
  try {
    // fields after the command name, which may itself hold spaces and parentheses; starttime is field 22
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(start) ? start : undefined;
  } catch {
    return undefined;
  }
};

const ownStart = startOf(process.pid);

const owner = (token: string): string => JSON.stringify({ pid: process.pid, host: hostname(), token, ...(ownStart !== undefined ? { start: ownStart } : {}) });

const readLock = async (path: string): Promise<LockInfo | undefined> => {
  let handle;
  try {
    handle = await openPrivateFile(path, fsConstants.O_RDONLY);
  } catch {
    return undefined;
  }
  try {
    const { ino, mtimeMs } = await handle.stat();
    const raw = (await handle.readFile()).toString('utf8');
    let named: { token?: string; pid?: number; host?: string; start?: number } = {};
    try {
      named = JSON.parse(raw) as typeof named;
    } catch {
      // judged by its age alone
    }
    return { raw, ino, mtimeMs, token: named.token, pid: named.pid, host: named.host, start: named.start };
  } finally {
    await handle.close();
  }
};

const isStale = (lock: LockInfo): boolean => {
  if (lock.token === undefined) return Date.now() - lock.mtimeMs > LOCK_STALE_MS;
  if (lock.host !== hostname()) return false;
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) return Date.now() - lock.mtimeMs > LOCK_STALE_MS;
  // this process under a token it does not hold: an earlier process that had the same pid, as after a container restart
  if (lock.pid === process.pid) return !held.has(lock.token);
  if (typeof lock.start === 'number') {
    const start = startOf(lock.pid);
    if (start !== undefined && start !== lock.start) return true;
  }
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

/** Creates `path` with `content` only if it does not exist, never showing it half-written. */
const createExclusive = async (path: string, content: string): Promise<boolean> => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await openPrivateFile(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
    try {
      await handle.write(content);
    } finally {
      await handle.close();
    }
    await fs.link(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
};

const syncDir = async (dir: string): Promise<void> => {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * The entries a claim can still act on, in their order: every record of a request that is pending or indeterminate,
 * holds a key inside its term or was written inside the replay window, and of the last request after each kept
 * unkeyed one that would overtake it in claim(). Decided on the records alone, so entries of every scope that shares
 * the file are kept alike.
 */
export const retained = (entries: JournalEntry[], now = Date.now()): JournalEntry[] => {
  const records = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const at = records.get(e.request_id);
    if (at) at.push(i);
    else records.set(e.request_id, [i]);
  });
  const age = (e: JournalEntry) => now - Date.parse(e.ts);
  const keyed = new Set(entries.filter((e) => e.key !== undefined).map((e) => e.request_id));
  const keep = new Set<string>();
  for (const [id, at] of records) {
    const own = at.map((i) => entries[i]);
    const state = own[own.length - 1].state;
    if (state === 'pending' || state === 'indeterminate' || own.some((e) => age(e) < REPLAY_WINDOW_MS || (e.key !== undefined && age(e) < KEY_TTL_MS))) keep.add(id);
  }
  for (const id of [...keep]) {
    const at = records.get(id) as number[];
    const last = entries[at[at.length - 1]];
    if (keyed.has(id) || (last.state !== 'pending' && last.state !== 'succeeded')) continue;
    const { operation, args_hash: hash, values: mine = [] } = entries[at[0]];
    const overtakes = (e: JournalEntry, values: string[]) =>
      values.length > 0 ? (e.values ? e.values.some((v) => values.includes(v)) : e.state === 'pending' && e.operation === operation) : e.operation === operation;
    for (const values of mine.length > 0 ? [mine, []] : [[]]) {
      for (let i = entries.length - 1; i > at[at.length - 1]; i--) {
        const e = entries[i];
        if (e.operation === operation && e.args_hash === hash && !keyed.has(e.request_id)) continue;
        if (overtakes(e, values)) {
          keep.add(e.request_id);
          break;
        }
      }
    }
  }
  return entries.filter((e) => keep.has(e.request_id));
};

/** Deterministic JSON: sorted object keys at every level. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
