import { CONTROL, untrustedBlock, type UntrustedBlock } from './untrusted.js';
import { RUN } from './package.js';

export interface ErrorEnvelope {
  message?: string;
  parameters?: { code?: string; details_schema_version?: string; details_json?: string; resources?: string; [name: string]: unknown } | unknown[];
}

export const MAX_REMOTE_TEXT = 500;
export const MAX_DETAILS_BYTES = 4096;

/** Control characters (incl. ANSI escapes) never reach the terminal or the model. */
export const sanitize = (value: unknown, max = MAX_REMOTE_TEXT): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const clean = text.replace(CONTROL, '');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
};

export class ApiError extends Error {
  constructor(
    public readonly http: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(sanitize(message));
  }

  /** The HTTP attempt the store answered with this error, set by the client; earlier attempts of the same request may have run. */
  attempt?: number;

  /** Set by the client when the call's time ran out before the request left: the store was never contacted. */
  unsent?: true;
  /** Set by the client when what it knows about the store says more than the code's own guidance does. */
  hint?: string;
}

export const NO_API_HINT = 'This store answers no WebForms API at all (its /capabilities is missing too): ask the store owner to install and enable the WebForms API module, or check the base URL. Re-listing will not help.';

/** What the model should do next, per error code; keep it operational, no server internals. */
export const GUIDANCE: Record<string, string> = {
  NOT_FOUND: 'The object does not exist or the integration cannot see it. Re-list and pick an existing id.',
  ACTOR_NOT_ALLOWED: 'The store refused this caller. If the message names a permission, ask the store owner to tick it on the integration\'s API tab in System > Extensions > Integrations; otherwise the message says what the store expects.',
  INVALID_JSON: 'A *_json argument is not valid JSON or exceeds the size limit.',
  VALIDATION_FAILED: 'The request is well-formed but the content is invalid; fix the listed errors.',
  INVALID_FILTER: 'The submission filter is malformed or uses an unsupported field/operator.',
  AMBIGUOUS_REF: 'The reference matches several objects; address it by id (details.candidate_ids).',
  DRAFT_EXISTS: 'A draft already exists; open it instead of creating another.',
  DRAFT_REVISION_MISMATCH: 'The draft changed since you read it; re-read and retry with the current revision.',
  LIVE_REVISION_MISMATCH: 'The live form changed since you read it; re-read and retry.',
  RESULT_REVISION_MISMATCH: 'The submission changed since you read it; re-read and retry with the current revision.',
  CONFIRMATION_REQUIRED: 'This operation needs a confirmation token: call the prepare step, show the preview to the user and confirm only after they agree.',
  CONFIRMATION_INVALID: 'The confirmation token is expired, used or does not match the current state; prepare again and ask the user again.',
  PII_GRANT_REQUIRED: 'Personal data needs a disclosure grant scoped to these fields: ask the user before requesting one with request_pii_grant, which needs "MageMe Extensions > WebForms > API > Request Temporary Disclosure" (MageMe_WebForms::api_v1_results_pii_read). An integration holding "MageMe Extensions > WebForms > API > Disclose Personal Data" (MageMe_WebForms::api_v1_results_pii_direct) reads personal data without a grant. Pass the grant\'s grant_id to the call that needs it (search_submissions, get_submission_full, list_submission_notes, list_submission_attachments). Exports never filter by personal data, whatever the permissions or grants: drop the personal filter instead of requesting a grant.',
  GRANT_EXPIRED: 'The disclosure grant expired or was revoked; request a new one with the user\'s approval.',
  GRANT_EXHAUSTED: 'The disclosure grant quota is used up; request a new one with the user\'s approval.',
  QUOTA_EXCEEDED: 'Rate limit reached; wait before retrying.',
  LIMIT_EXCEEDED: 'Too many items in one request; split it.',
  REQUEST_ID_REUSED: 'Internal: a request id was reused with different arguments. Retry once with fresh arguments.',
  CONFLICT: 'The same request is still being processed; wait and retry.',
  REPLAY_UNAVAILABLE: 'The earlier outcome cannot be replayed; inspect the current state before repeating the operation.',
  INDETERMINATE: 'A previous attempt may or may not have applied; inspect the current state before repeating the operation.',
  INTERNAL: 'The server failed; retry later and report details.correlation_id if it persists. A creation repeated with the same idempotency_key answers this same error: check whether the object exists first, and only then call again with a new key.',
  UNAUTHORIZED: 'Authentication failed: check the system clock, whether the integration was revoked, or the tokens. Run: ' + RUN + ' setup --overwrite --from, with the --profile that store was set up with',
  NETWORK: 'The store could not be reached; check connectivity and the base URL.',
  BAD_RESPONSE: 'The base URL does not lead to the Magento REST API: check it (scheme, host, no path after the store root) and that the store is not in maintenance mode.',
  HTTP_500: 'The store failed with an error of its own; the store owner finds the cause in the store\'s error log. If the call was meant to change something, check the current state before repeating it.',
  API_VERSION_UNSUPPORTED: 'This release of webforms-mcp and the store speak different API versions; follow the message to update one of them.',
  REDIRECT: 'The base URL points at a redirecting address; configure the final https origin.',
  RESPONSE_TOO_LARGE: 'Narrow the request (smaller page, fewer fields).',
};

const KNOWN_CODE = /^[A-Z_]{3,40}$/;
const ACL_RESOURCE = /^[A-Za-z0-9_]{1,64}::[A-Za-z0-9_]{1,64}$/;
const ACL_RESOURCE_IN_TEXT = /[A-Za-z0-9_]{1,64}::[A-Za-z0-9_]{1,64}/g;

/**
 * Every permission the API names by id: its title in acl.xml and its path in the tree on the integration's API tab.
 */
export const ACL_TITLES: Readonly<Record<string, { title: string; path: string }>> = {
  'MageMe_WebForms::api_v1_forms_view': { title: 'View Forms and Schema', path: 'MageMe Extensions > WebForms > API > View Forms and Schema' },
  'MageMe_WebForms::api_v1_forms_create': { title: 'Create Forms', path: 'MageMe Extensions > WebForms > API > Create Forms' },
  'MageMe_WebForms::api_v1_forms_edit': { title: 'Edit and Publish Forms', path: 'MageMe Extensions > WebForms > API > Edit and Publish Forms' },
  'MageMe_WebForms::api_v1_forms_scripts': { title: 'Edit Form Scripts', path: 'MageMe Extensions > WebForms > API > Edit Form Scripts' },
  'MageMe_WebForms::api_v1_results_view': { title: 'View Submissions (Masked)', path: 'MageMe Extensions > WebForms > API > View Submissions (Masked)' },
  'MageMe_WebForms::api_v1_results_pii_read': { title: 'Request Temporary Disclosure', path: 'MageMe Extensions > WebForms > API > Request Temporary Disclosure' },
  'MageMe_WebForms::api_v1_results_pii_direct': { title: 'Disclose Personal Data', path: 'MageMe Extensions > WebForms > API > Disclose Personal Data' },
  'MageMe_WebForms::api_v1_results_edit': { title: 'Edit Submissions', path: 'MageMe Extensions > WebForms > API > Edit Submissions' },
  'MageMe_WebForms::api_v1_results_reply': { title: 'Reply to Submissions', path: 'MageMe Extensions > WebForms > API > Reply to Submissions' },
  'MageMe_WebForms::api_v1_results_export': { title: 'Export Submissions', path: 'MageMe Extensions > WebForms > API > Export Submissions' },
  'MageMe_WebForms::api_v1_attachments_read': { title: 'Download Attachments', path: 'MageMe Extensions > WebForms > API > Download Attachments' },
  'MageMe_WebForms::api_v1_results_import': { title: 'Import Submissions', path: 'MageMe Extensions > WebForms > API > Import Submissions' },
  'MageMe_WebForms::approve_result': { title: 'Approve Results', path: 'MageMe Extensions > WebForms > Manage Forms > Approve Results' },
  'Magento_Sales::actions_view': { title: 'View', path: 'Sales > Operations > Orders > Actions > View' },
};

const isKnown = (id: string): boolean => Object.prototype.hasOwnProperty.call(ACL_TITLES, id);

/** Titles come from ACL_TITLES only, so no text of the server's reaches the agent under this key. */
const withTitles = (details: Record<string, unknown>, ids: string[]): Record<string, unknown> => {
  const { titles: _server, ...rest } = details;
  const titles = Object.fromEntries(ids.filter(isKnown).map((id) => [id, ACL_TITLES[id].path]));
  return Object.keys(titles).length ? { ...rest, titles } : rest;
};

/**
 * Magento's own phrase placeholders: %name for a named parameter, %1, %2… for a list; one with no value stays as it is.
 * %resources is filled in only from checked permission ids (see parseError).
 */
const fillIn = (message: string, parameters: ErrorEnvelope['parameters']): string => {
  if (!parameters) return message;
  const value = (name: string): unknown => (Array.isArray(parameters) ? (/^\d+$/.test(name) ? parameters[Number(name) - 1] : undefined) : name === 'resources' ? undefined : parameters[name]);
  return message.replace(/%(\w+)/g, (placeholder, name: string) => {
    const v = value(name);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : placeholder;
  });
};

export const parseError = (http: number, body: unknown): ApiError => {
  const env = (body ?? {}) as ErrorEnvelope;
  const params = env.parameters && !Array.isArray(env.parameters) ? env.parameters : undefined;
  const rawCode = typeof params?.code === 'string' && KNOWN_CODE.test(params.code) ? params.code : undefined;
  // Magento refuses a route whose ACL resources the caller lacks with 401 and the resources as a message parameter
  const resources = http === 401 && !rawCode && typeof params?.resources === 'string' ? params.resources.split(',').map((r) => r.trim()).filter((r) => ACL_RESOURCE.test(r)) : [];
  if (resources.length) {
    const text = typeof env.message === 'string' ? env.message.replace('%resources', resources.join(', ')) : `HTTP ${http}`;
    return new ApiError(http, 'ACTOR_NOT_ALLOWED', text, withTitles({ resources }, resources));
  }
  const code = rawCode ?? (http === 401 ? 'UNAUTHORIZED' : http === 404 ? 'NOT_FOUND' : http === 403 ? 'ACTOR_NOT_ALLOWED' : 'HTTP_' + http);
  let details: Record<string, unknown> = {};
  if (typeof params?.details_json === 'string' && params.details_json.length <= MAX_DETAILS_BYTES) {
    try {
      const parsed = JSON.parse(params.details_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
    } catch {
      details = {};
    }
  }
  // a WebForms API error (it carries a code) comes with its text already written out
  const message = typeof env.message === 'string' ? (rawCode ? env.message : fillIn(env.message, env.parameters)) : `HTTP ${http}`;
  if (code === 'ACTOR_NOT_ALLOWED') details = withTitles(details, message.match(ACL_RESOURCE_IN_TEXT) ?? []);
  return new ApiError(http, code, message, details);
};

/** Magento answers a route refusal the same way for an inactive integration and for a request whose Authorization header never reached it. */
const ROUTE_REFUSAL_NOTE = (count: number): string => ` If ${count > 1 ? 'they are' : 'that is'} already ticked, the integration may be inactive or the store may not receive the Authorization header: ask the store owner to check the integration in System > Extensions > Integrations; reauthorizing it issues new tokens, after which run: ${RUN} setup --overwrite --from, with the --profile that store was set up with.`;

/** The permissions an ACTOR_NOT_ALLOWED refusal names, when every one of them is in ACL_TITLES; otherwise none. */
const namedIds = (error: ApiError): string[] => {
  if (error.code !== 'ACTOR_NOT_ALLOWED') return [];
  const ids = Array.isArray(error.details.resources) ? (error.details.resources as string[]) : (error.message.match(ACL_RESOURCE_IN_TEXT) ?? []);
  return ids.every(isKnown) ? ids : [];
};

export const describe = (error: ApiError, shown: Record<string, unknown> = error.details): string => {
  const ids = namedIds(error);
  const routeNote = error.code === 'ACTOR_NOT_ALLOWED' && Array.isArray(error.details.resources) ? ROUTE_REFUSAL_NOTE(error.details.resources.length) : '';
  if (!ids.length) {
    const hint = (error.unsent ? '' : error.hint ?? GUIDANCE[error.code] ?? '') + routeNote;
    const details = Object.keys(shown).length ? `\ndetails: ${sanitize(shown, MAX_DETAILS_BYTES)}` : '';
    return `${error.code} (HTTP ${error.http}): ${error.message}${hint ? `\n${hint}` : ''}${details}`;
  }
  // Named from ACL_TITLES only; the store's own sentence stays available in details.message.
  const named = ids.map((id) => `"${ACL_TITLES[id].path}" (${id})`).join(', ');
  const line = `The integration lacks ${ids.length > 1 ? 'at least one of ' : ''}${named}.`;
  const hint = `Ask the store owner to tick ${ids.length > 1 ? 'every permission named above' : 'this permission'} on the integration's API tab in System > Extensions > Integrations.` + routeNote;
  return `${error.code} (HTTP ${error.http}): ${line}\n${hint}\ndetails: ${sanitize({ message: error.message, ...shown }, MAX_DETAILS_BYTES)}`;
};

const SCRIPTS = 'MageMe_WebForms::api_v1_forms_scripts';

/**
 * A write refused because it puts markup that runs code into a text the storefront shows as HTML ({key, store_id,
 * parts}). The key and the parts are what the author wrote, and the store's sentence quotes them, so all three
 * travel as untrusted data; the answer itself names only the store view and the way out.
 */
export const markupRefusal = (error: ApiError): { text: string; blocks: UntrustedBlock[] } | null => {
  const { key, store_id: storeId, parts } = error.details;
  if (error.code !== 'ACTOR_NOT_ALLOWED' || typeof key !== 'string' || !Array.isArray(parts)) return null;
  const scope = Number.isInteger(storeId) ? (storeId === 0 ? 'the default scope' : `store view ${String(storeId)}`) : 'a store view the store did not name';
  const text = `${error.code} (HTTP ${error.http}): Nothing was changed. A form text in ${scope} holds markup that runs code on the storefront `
    + '(scripts, event handlers, directives and the like): either this change puts it there or makes a field that holds it run (switching it or its section on, restoring it, moving it '
    + 'out of a switched-off section; a publish counts what the draft brings in or changes), or, when switching a form on or copying it, a switched-on HTML field already holds it. '
    + 'Which text and which markup is in the block below. Either remove that markup from the text, '
    + `ask the store owner to tick "${ACL_TITLES[SCRIPTS].path}" (${SCRIPTS}) on the integration's API tab in System > Extensions > Integrations, `
    + 'or, to switch on or copy a form whose HTML field an admin wrote, have an admin do it in the admin panel. Until one of these is done the store refuses the same request again.';
  return { text, blocks: [untrustedBlock('refused markup', { key, store_id: storeId, parts, message: error.message })] };
};
