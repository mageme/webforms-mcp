import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from './config.js';
import { authorizationHeader } from './oauth.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, NO_API_HINT, parseError, sanitize } from './errors.js';

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** false: one attempt only. */
  retry?: boolean;
}

const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Thin HTTP client: signs every request, never follows redirects, retries on 408/429/5xx/network
 * errors only when the call is idempotent (GET, or a POST whose body carries a request_id the server
 * replays), caps response size and keeps the deadline active while the body is read. Log lines carry
 * method, path and status only.
 */
export class ApiClient {
  private readonly dispatcher: Agent;
  private compatible = false;
  private checking: Promise<void> | undefined;
  private nextCheckAt = 0;
  /** The store answered /capabilities with 404: a 404 of its then means no WebForms API, not a missing object. */
  private noApi = false;

  constructor(private readonly config: Config, private readonly log: (line: string) => void = () => undefined, private readonly budgetMs = CALL_BUDGET_MS) {
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !config.insecureTls } });
    if (config.insecureTls) log('TLS certificate verification is DISABLED for this store (development only)');
  }

  get<T>(path: string, query?: Record<string, string>, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>('GET', path, { query, timeoutMs: options.timeoutMs });
  }

  post<T>(path: string, body: { request: { request_id: string } & Record<string, unknown> }): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body: { request: { request_id: string } & Record<string, unknown> }): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    if (path !== CAPABILITIES_PATH && !this.compatible && Date.now() >= this.nextCheckAt) await (this.checking ??= this.checkCompatible().finally(() => { this.checking = undefined; }));
    const url = `${this.config.baseUrl}/rest/all${path}`;
    const search = options.query ? new URLSearchParams(options.query) : undefined;
    const full = search && search.size > 0 ? `${url}?${search.toString()}` : url;
    const idempotent = options.retry !== false && (method === 'GET' || hasRequestId(options.body));
    const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
    const scope = callSignal.getStore();
    const cancel = scope?.signal;
    const deadline = Math.min(Date.now() + this.budgetMs, scope?.deadline ?? Infinity);
    let attempt = 0;
    let lastFailure: unknown;
    let lastRefusal: ApiError | undefined;
    for (;;) {
      attempt++;
      const remaining = deadline - Date.now();
      // An attempt with no time to be answered is not sent at all.
      if (remaining < 1000) {
        if (lastRefusal) throw lastRefusal;
        if (attempt === 1) {
          const unsent = new ApiError(0, 'NETWORK', `The time for this call ran out before ${method} ${path} was sent. Nothing was sent; repeating the call is safe.`);
          unsent.unsent = true;
          throw unsent;
        }
        throw networkError(lastFailure, { method, path, attempt: attempt - 1, timedOut: true, cancelled: false, replayable: hasRequestId(options.body) });
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: authorizationHeader(this.config, { method, url, query: options.query }),
      };
      if (serialized !== undefined) headers['Content-Type'] = 'application/json';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? ATTEMPT_TIMEOUT_MS, remaining));
      const signal = cancel ? AbortSignal.any([controller.signal, cancel]) : controller.signal;
      /** A lost connection, timeout or cancellation: retried while it is safe and time is left, otherwise explained. */
      const unreachable = async (e: unknown): Promise<void> => {
        lastFailure = e;
        lastRefusal = undefined;
        if (cancel?.aborted !== true && idempotent && attempt < MAX_ATTEMPTS && deadline - Date.now() > 1000) {
          await backoff(attempt, this.log, `network error on ${method} ${path}`, undefined, deadline);
          return;
        }
        throw networkError(e, { method, path, attempt, timedOut: controller.signal.aborted, cancelled: cancel?.aborted === true, replayable: hasRequestId(options.body) });
      };
      try {
        let response;
        try {
          response = await undiciFetch(full, { method, headers, body: serialized, redirect: 'manual', signal, dispatcher: this.dispatcher });
        } catch (e) {
          await unreachable(e);
          continue;
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new ApiError(response.status, 'REDIRECT', `The server redirected ${method} ${path}; redirects are not followed. Check the base URL (scheme and host).`);
        }
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_RESPONSE_BYTES) {
          await response.body?.cancel();
          throw new ApiError(response.status, 'RESPONSE_TOO_LARGE', `Response of ${declared} bytes exceeds the ${MAX_RESPONSE_BYTES}-byte limit.`);
        }
        let text: string;
        try {
          text = await readCapped(response.body as unknown as ReadableStream<Uint8Array> | null, MAX_RESPONSE_BYTES);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          await unreachable(e);
          continue;
        }
        let parsed: unknown = null;
        let json = text === '';
        if (text !== '') {
          try {
            parsed = JSON.parse(text);
            json = true;
          } catch {
            parsed = null;
          }
        }
        if (response.ok) {
          // Every read answers a document; an empty one is a proxy or a half-broken store, not an answer.
          if (!json || (text === '' && response.status !== 204)) {
            throw new ApiError(response.status, 'BAD_RESPONSE', `The store answered ${method} ${path} with HTTP ${response.status} but not with the API's JSON (${describeBody(response.headers.get('content-type'), text)}). The base URL probably points at a page, a proxy or a maintenance screen rather than the Magento REST API.${hasRequestId(options.body) ? REPLAY_SAFE : ''}`);
          }
          if (path === CAPABILITIES_PATH) {
            assertApiVersion(parsed);
            this.compatible = true;
            this.noApi = false;
          }
          return parsed as T;
        }
        const wait = retryAfterMs(response.headers.get('retry-after'));
        // A wait the store asked for that does not fit the budget is not shortened: the store's answer stands.
        if (idempotent && RETRY_STATUS.has(response.status) && attempt < MAX_ATTEMPTS && deadline - Date.now() > 1000 + (wait ?? 0)) {
          lastRefusal = parseError(response.status, parsed);
          lastRefusal.attempt = attempt;
          await backoff(attempt, this.log, `HTTP ${response.status} on ${method} ${path}`, wait, deadline);
          continue;
        }
        const error = parseError(response.status, parsed);
        error.attempt = attempt;
        // Only Magento's own route miss: a 404 that carries a WebForms code is the store's answer about an object.
        if (this.noApi && error.http === 404 && (parsed as { parameters?: { code?: unknown } } | null)?.parameters?.code === undefined) error.hint = NO_API_HINT;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Asks the store once which API it speaks, before the first other request: a store on an API this release
   * was not written for is refused instead of being talked to in the wrong dialect. A store that cannot answer
   * is asked again a minute later; the request itself then reports what is wrong.
   */
  private async checkCompatible(): Promise<void> {
    try {
      // Shared by concurrent calls, so it must not die with the first caller's cancellation.
      await callSignal.run({}, () => this.request('GET', CAPABILITIES_PATH, { timeoutMs: 5000, retry: false }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'API_VERSION_UNSUPPORTED') throw e;
      if (e instanceof ApiError && e.http === 404) this.noApi = true;
      this.nextCheckAt = Date.now() + 60_000;
    }
  }
}

/** The API major version this release speaks; capabilities.api_version must match it. */
export const SUPPORTED_API_MAJOR = 1;
export const CAPABILITIES_PATH = '/V1/webforms/capabilities';

/**
 * Refuses a store whose API major version is not this release's, or that names a version no number can be read
 * from; a store that does not name one is let through, its answers then show what it is.
 */
export const assertApiVersion = (caps: unknown): void => {
  const raw = caps !== null && typeof caps === 'object' ? (caps as { api_version?: unknown }).api_version : undefined;
  if (raw === undefined || raw === null || raw === '') return;
  const major = typeof raw === 'string' || typeof raw === 'number' ? Number(String(raw).replace(/^v/i, '').split('.')[0]) : Number.NaN;
  if (major === SUPPORTED_API_MAJOR) return;
  if (!Number.isInteger(major)) {
    throw new ApiError(0, 'API_VERSION_UNSUPPORTED', `The store's API version "${sanitize(String(raw), 20)}" does not name a version this release understands (it speaks WebForms API v${SUPPORTED_API_MAJOR}). Update the WebForms module on the store, or webforms-mcp.`);
  }
  const action = major > SUPPORTED_API_MAJOR ? 'Update webforms-mcp to a release for that API.' : 'Update the WebForms module on the store.';
  throw new ApiError(0, 'API_VERSION_UNSUPPORTED', `This webforms-mcp speaks WebForms API v${SUPPORTED_API_MAJOR}; the store answers with API v${sanitize(String(raw).replace(/^v/i, ''), 20)}. ${action}`);
};

/** Set for one tool call: the client's cancellation of it, and the deadline every request of the call shares. */
export const callSignal = new AsyncLocalStorage<{ signal?: AbortSignal; deadline?: number }>();

/** One tool call's budget, all its requests together and without the time a person takes to answer: below the MCP SDK's 60-second request timeout, so the model hears this client's explanation, not a bare timeout. */
export const CALL_BUDGET_MS = 45_000;

/** Waits for a person's answer outside the call's budget: the call's deadline moves on by the time the person took. */
export const awaitingPerson = async <T>(wait: () => Promise<T>): Promise<T> => {
  const scope = callSignal.getStore();
  const startedAt = Date.now();
  try {
    return await wait();
  } finally {
    if (scope?.deadline !== undefined) scope.deadline += Date.now() - startedAt;
  }
};
const ATTEMPT_TIMEOUT_MS = 30_000;

const REPLAY_SAFE = ' The change may have been applied. Repeating this call with the same arguments is safe: it goes out under the same request id, and the store answers with the first outcome instead of acting twice.';

const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID']);

const causeCode = (e: unknown): string | undefined => {
  for (let c: unknown = e, depth = 0; c && typeof c === 'object' && depth < 4; c = (c as { cause?: unknown }).cause, depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)) return code;
  }
  return undefined;
};

/** What went wrong on the way to the store, and whether a write may already have happened. */
export const networkError = (e: unknown, at: { method: string; path: string; attempt: number; timedOut: boolean; cancelled: boolean; replayable: boolean }): ApiError => {
  const code = causeCode(e);
  const where = `${at.method} ${at.path}`;
  let what: string;
  if (at.cancelled) what = `The call was cancelled by the client during ${where}.`;
  else if (at.timedOut) what = `The store did not answer ${where} in time (${at.attempt} attempt${at.attempt === 1 ? '' : 's'}).`;
  else if (code && TLS_CODES.has(code)) what = `The store's TLS certificate was not accepted (${code}). A development store with a self-signed certificate can be set up with --insecure-tls; a live store needs a valid certificate.`;
  else what = `Could not reach the store for ${where}${code ? ` (${code})` : ''}.`;
  const outcome = at.method === 'GET' ? ' Nothing was changed.' : at.replayable ? REPLAY_SAFE : ' The change may have been applied; check the current state before repeating it.';
  return new ApiError(0, 'NETWORK', what + outcome, code ? { cause: code } : {});
};

const describeBody = (contentType: string | null, text: string): string => {
  const type = contentType ? sanitize(contentType.split(';')[0], 60) : 'no content type';
  return `${type}, ${Buffer.byteLength(text, 'utf8')} bytes`;
};

const hasRequestId = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && typeof (body as { request?: { request_id?: unknown } }).request?.request_id === 'string'
  && ((body as { request: { request_id: string } }).request.request_id.length > 0);

const readCapped = async (body: ReadableStream<Uint8Array> | null, cap: number): Promise<string> => {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new ApiError(200, 'RESPONSE_TOO_LARGE', `Response exceeds the ${cap}-byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const retryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now())) : undefined;
};

const backoff = async (attempt: number, log: (l: string) => void, why: string, retryAfter?: number, deadline = Infinity): Promise<void> => {
  const ms = Math.min(Math.max(retryAfter ?? 0, 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200)), Math.max(0, deadline - Date.now() - 1000));
  log(`retry ${attempt} after ${ms}ms: ${why}`);
  await new Promise((r) => setTimeout(r, ms));
};
