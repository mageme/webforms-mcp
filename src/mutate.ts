import { createHash, randomBytes } from 'node:crypto';
import { KEY_RELEASING_CODES, REPLAY_WINDOW_MS, type Claim, type Journal, type Replay } from './journal.js';
import { ApiError } from './errors.js';

/** A lost connection, a request still in flight, or an answer that was not the API's: the store may have acted. */
const mayHaveApplied = (code: string): boolean => code === 'NETWORK' || code === 'CONFLICT' || code === 'BAD_RESPONSE';

/**
 * Runs one mutation under the journal: the request_id is minted (or reused for a pending identical
 * call) and fsync'd before the request leaves, and the terminal state is recorded afterwards.
 * `values` names what the call sets, for the journal's 'value' rule (see Journal.begin).
 */
export const mutate = async <T>(journal: Journal, operation: string, args: unknown, call: (requestId: string) => Promise<T>, log: (line: string) => void = () => undefined, replay: Replay = true, values: string[] = []): Promise<T> =>
  (await mutateClaimed(journal, operation, args, call, log, replay, values)).result;

/** mutate() that also says whether the call reused an earlier request id (see Journal.claim). */
export const mutateClaimed = async <T>(journal: Journal, operation: string, args: unknown, call: (requestId: string) => Promise<T>, log: (line: string) => void = () => undefined, replay: Replay = true, values: string[] = []): Promise<{ result: T; reused: Claim['reused'] }> => {
  const claim = await journal.claim(operation, args, replay, values);
  let requestId = claim.requestId;
  let result: T;
  try {
    result = await call(requestId);
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'NETWORK';
    if (code === 'REPLAY_UNAVAILABLE') {
      await journal.finish(operation, args, requestId, 'succeeded', code);
      requestId = await journal.begin(operation, { ...(args as object), _retry: requestId });
      result = await call(requestId);
    } else {
      // The server may have committed; the entry stays pending so a retry replays it.
      if (!mayHaveApplied(code)) {
        try {
          await journal.finish(operation, args, requestId, code === 'INDETERMINATE' ? 'indeterminate' : 'failed', code);
        } catch (f) {
          log(`journal finalize failed for ${operation}: ${(f as Error).message}`);
        }
      }
      throw e;
    }
  }
  try {
    await journal.finish(operation, args, requestId, 'succeeded');
  } catch (e) {
    log(`journal finalize failed for ${operation}: ${(e as Error).message}`);
  }
  return { result, reused: requestId === claim.requestId ? claim.reused : undefined };
};

/** How a creation answer came about; every creation tool returns it as `idempotency`. */
export type CreationStatus =
  | { outcome: 'created'; created: true; note?: string }
  | { outcome: 'retried'; created: true; first_call_at: string; note: string }
  | { outcome: 'replayed' | 'not_created'; created: false; first_call_at: string; note: string; to_create_another: string };

const NEW_KEY = 'Call again with an idempotency_key not used before.';

/**
 * A creation under the journal. Without a key an identical call inside the replay window counts as a retry, as
 * before; with one, the key decides (see Journal.claim). A request id that was reused is checked with `exists`:
 * an object removed since is never handed back - without a key a new one is created, with a key nothing is.
 *
 * @param options.refusalFreesKey false for a creation the store can still refuse after its object was made
 * @returns result is undefined only when nothing was created (status not_created)
 */
export const create = async <T>(journal: Journal, operation: string, args: unknown, call: (requestId: string) => Promise<T>,
  options: { key?: string; exists?: (result: T) => Promise<boolean>; log?: (line: string) => void; refusalFreesKey?: boolean } = {}): Promise<{ result?: T; status: CreationStatus }> => {
  const { key, exists, log = () => undefined, refusalFreesKey = true } = options;
  const claim = await journal.claim(operation, args, true, [], key);
  const first = claim.reused?.firstCallAt ?? '';
  /** The object of a reused request was removed: with a key nothing is created, without one a new object is. */
  const gone = async (): Promise<{ result?: T; status: CreationStatus }> => {
    if (key !== undefined) {
      return { status: { outcome: 'not_created', created: false, first_call_at: first, note: `The object this key's call created at ${first} has been removed since. Nothing was created now.`, to_create_another: NEW_KEY } };
    }
    await journal.finish(operation, args, claim.requestId, 'failed', 'GONE');
    const again = await create(journal, operation, args, call, { exists, log });
    return again.status.outcome === 'created'
      ? { ...again, status: { ...again.status, note: `An identical call at ${first} had created an object that has been removed since; this call created a new one.` } }
      : again;
  };
  let result: T;
  try {
    result = await call(claim.requestId);
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'NETWORK';
    if (code === 'REPLAY_UNAVAILABLE' && key !== undefined) {
      await journal.finish(operation, args, claim.requestId, 'succeeded', code);
      return { status: { outcome: 'not_created', created: false, first_call_at: first, note: `The store no longer keeps the answer of this key's call made at ${first}, so its object cannot be named here. Nothing was created now.`, to_create_another: NEW_KEY } };
    }
    // the server re-reads what it answers with: a replay of a creation whose object is gone answers NOT_FOUND
    if (code === 'NOT_FOUND' && claim.reused?.state === 'succeeded') return gone();
    if (code === 'REPLAY_UNAVAILABLE') {
      await journal.finish(operation, args, claim.requestId, 'succeeded', code);
      return { result: await mutate(journal, operation, { ...(args as object), _retry: claim.requestId }, call, log), status: { outcome: 'created', created: true } };
    }
    if (!mayHaveApplied(code)) {
      // a request sent before, by an earlier call or by the client's own retry, may have created, so only a refusal of its first send frees the key
      const released = refusalFreesKey && key !== undefined && !claim.reused && e instanceof ApiError && e.attempt === 1 && (KEY_RELEASING_CODES as readonly string[]).includes(code);
      try {
        await journal.finish(operation, args, claim.requestId, code === 'INDETERMINATE' ? 'indeterminate' : 'failed', code, released);
      } catch (f) {
        log(`journal finalize failed for ${operation}: ${(f as Error).message}`);
      }
    }
    throw e;
  }
  try {
    await journal.finish(operation, args, claim.requestId, 'succeeded');
  } catch (e) {
    log(`journal finalize failed for ${operation}: ${(e as Error).message}`);
  }
  if (!claim.reused) return { result, status: { outcome: 'created', created: true } };
  if (exists && !(await exists(result))) return gone();
  return { result, status: creationStatus(claim.reused, NEW_KEY) };
};

/** The status of a creation's answer from what the journal reused; `toCreateAnother` is how the agent makes a second one. */
export const creationStatus = (reused: Claim['reused'], toCreateAnother: string): CreationStatus => {
  if (!reused) return { outcome: 'created', created: true };
  const first = reused.firstCallAt;
  return reused.state === 'succeeded'
    ? { outcome: 'replayed', created: false, first_call_at: first, note: `Nothing was created now: this is the object an identical call created at ${first}.`, to_create_another: toCreateAnother }
    : { outcome: 'retried', created: true, first_call_at: first, note: `The answer of the identical call made at ${first} was lost; this is the object that call created, not a second one.` };
};

interface Pending {
  site: string;
  token: string;
  operation: string;
  objectType: string;
  objectId: number;
  expiresAt: number;
  /** What the person approves, as the store described it when it issued the token. */
  summary?: string;
  /**
   * When a send with this token lost its answer. From then on the token's expiry no longer applies here: a retry
   * goes out under the same request id and the store answers with the first outcome before it looks at the token.
   */
  sentAt?: number;
  /** The tool and arguments of that send (see thisCall): the call the person approved. */
  sentCall?: string;
}

/**
 * Server-issued confirmation tokens stay in process memory; the model only ever sees an opaque
 * confirmation id, so a transcript never carries a usable token.
 */
export class Confirmations {
  private readonly pending = new Map<string, Pending>();
  private static readonly MAX = 100;

  /** Server timestamps are UTC without a zone designator; zoned ISO strings are taken as they are. */
  static parseExpiry(expiresAt: string): number {
    const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(expiresAt) ? expiresAt : expiresAt.replace(' ', 'T') + 'Z';
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : 0;
  }

  /** One opaque id per server token; remembering the same token again returns the existing id. */
  remember(site: string, operation: string, objectType: string, objectId: number, token: string, expiresAt: string, summary?: string): string {
    this.purge();
    for (const [id, entry] of this.pending) {
      // Two stores can legitimately hand out the same token string; only within one store is it the same approval.
      if (entry.token === token && entry.site === site) return id;
    }
    const id = randomBytes(8).toString('hex');
    this.pending.set(id, { site, token, operation, objectType, objectId, expiresAt: Confirmations.parseExpiry(expiresAt), summary });
    return id;
  }

  /** The description stored with the approval, for the question put to the person. */
  summaryOf(id: string | undefined, site: string, operation: string, objectType: string, objectId: number): string | undefined {
    return this.peek(id, site, operation, objectType, objectId) === undefined ? undefined : this.pending.get(id as string)?.summary;
  }

  isExpired(id: string): boolean {
    const entry = this.pending.get(id);
    return !entry || Confirmations.lapsed(entry, Date.now());
  }

  private static lapsed(entry: Pending, now: number): boolean {
    return entry.sentAt === undefined ? entry.expiresAt <= now : now - entry.sentAt >= REPLAY_WINDOW_MS;
  }

  /** Returns the token once and forgets it; a mismatched site/operation/object leaves the approval intact. */
  take(id: string | undefined, site: string, operation: string, objectType: string, objectId: number): string | undefined {
    const token = this.peek(id, site, operation, objectType, objectId);
    if (token !== undefined) this.pending.delete(id as string);
    return token;
  }

  /** The token, left in place until the store has answered (see redeem). */
  peek(id: string | undefined, site: string, operation: string, objectType: string, objectId: number): string | undefined {
    if (!id) return undefined;
    const entry = this.pending.get(id);
    if (!entry || entry.site !== site || entry.operation !== operation || entry.objectType !== objectType || entry.objectId !== objectId || Confirmations.lapsed(entry, Date.now())) {
      return undefined;
    }
    return entry.token;
  }

  /**
   * Whether this call repeats an approved send that lost its answer: same approval, same tool and arguments. The
   * person approved exactly that call, and its retry goes out under the same request id, so they are not asked again.
   */
  resent(id: string | undefined, site: string, operation: string, objectType: string, objectId: number, call: string | undefined): boolean {
    if (call === undefined || this.peek(id, site, operation, objectType, objectId) === undefined) return false;
    const entry = this.pending.get(id as string);
    return entry?.sentAt !== undefined && entry.sentCall === call;
  }

  /**
   * Runs the confirmed call and spends the approval only on a final answer. After a lost connection (NETWORK)
   * or CONFLICT the store may have acted, so the same confirmation_id stays usable: its retry carries the same
   * token, hence the same journal entry and request id, and the store replays instead of acting twice.
   * `call` names the call that was sent (see resent).
   */
  async redeem<T>(id: string | undefined, run: Promise<T>, call?: string): Promise<T> {
    try {
      const result = await run;
      if (id) this.pending.delete(id);
      return result;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      const entry = id ? this.pending.get(id) : undefined;
      if (entry && !mayHaveApplied(code)) this.pending.delete(id as string);
      else if (entry && entry.sentAt === undefined) {
        entry.sentAt = Date.now();
        entry.sentCall = call;
      }
      // the store records a confirmed write that failed this way as INDETERMINATE: it may have acted before failing
      if (e instanceof ApiError && code === 'INTERNAL') {
        throw new ApiError(e.http, 'INDETERMINATE', `${e.message} The store failed while carrying out the approved change, so it may or may not be applied.`, e.details);
      }
      throw e;
    }
  }

  private purge(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (Confirmations.lapsed(entry, now)) this.pending.delete(id);
    }
    while (this.pending.size >= Confirmations.MAX) {
      this.pending.delete(this.pending.keys().next().value as string);
    }
  }
}

/** Non-secret fingerprint of a token for journal identity. */
export const tokenFingerprint = (token: string | undefined): string | null => (token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null);
