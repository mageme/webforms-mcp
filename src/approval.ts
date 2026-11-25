import { CONTROL } from './untrusted.js';

/**
 * What a person reads before approving: the store's own description of the change, as plain lines. The text
 * is remote data shown to a human, so it is cut short and stripped of control characters, never interpreted.
 */
const MAX_SUMMARY = 2000;
const MAX_VALUE = 200;

/** A value is one line: a line break inside a store's text could otherwise forge lines of the summary. */
const BREAK = /[\r\n\u0085\u2028\u2029]+/g;
/**
 * Format characters (zero-width marks, direction overrides, soft hyphens, tags), C1 controls, variation
 * selectors and blank fillers: they can hide or reverse what a line seems to say. Applied after BREAK.
 */
const INVISIBLE = /[\p{Cf}\u0080-\u009F\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F]/gu;
/** One line of remote or model text, safe to put in front of a person. */
const line = (text: string): string => text.replace(CONTROL, '').replace(BREAK, ' ').replace(INVISIBLE, '');
const BASE = 'https://base.invalid/';
/** Schemes whose link runs or renders what the value itself carries; the shown text may hide the scheme behind a break. */
const RUNS = new Set(['javascript:', 'data:', 'vbscript:']);
/**
 * Where a value would take a browser, named whole beside a value that may be cut: a long user-name part could push
 * the host out of sight. Parsed from the raw text as a browser parses it (spaces trimmed, tabs and breaks dropped,
 * protocol-relative and backslash forms), so cleaning the text for display cannot hide it.
 */
const hostOf = (raw: string): string => {
  try {
    const url = new URL(raw, BASE);
    // a sentence such as "Data: kept 30 days" parses as data: too; javascript: runs even with a space after it
    if (RUNS.has(url.protocol) && (url.protocol === 'javascript:' || !/^[^:]*:\s/.test(raw.trim()))) return ` (a browser opens this as a ${url.protocol} link)`;
    if (url.hostname === '' || url.href.startsWith(BASE)) return '';
    return ` (goes to ${line(url.hostname)}${url.username !== '' || url.password !== '' ? '; the text before "@" is only a user name' : ''})`;
  } catch {
    return '';
  }
};
const cut = (v: unknown, max: number): string => {
  const text = line(typeof v === 'string' ? v : JSON.stringify(v) ?? 'null');
  return `${text.length > max ? `${text.slice(0, max)}…` : text}${typeof v === 'string' ? hostOf(v) : ''}`;
};
/** One argument only: it is passed straight to map(). */
const clean = (v: unknown): string => cut(v, MAX_VALUE);
/** A value the model wrote, as JSON, so it reads as a value and never as a line or a second value of the question. */
export const quoted = (v: unknown, max = MAX_VALUE): string => (typeof v === 'string' ? JSON.stringify(cut(v, max)) : cut(v, max));
/** Text this server put together from remote or model parts: its own line breaks stay, nothing else that moves or hides text. */
export const question = (text: string): string => text.split('\n').map(line).join('\n');
/** Lines of a question cut to fit, saying how many of what did not. */
export const capped = (lines: string[], noun = 'change'): string => cap(lines, noun);
const cap = (lines: string[], noun = 'change'): string => {
  const kept: string[] = [];
  let size = 0;
  const all = lines.filter((l) => l !== '');
  for (const l of all) {
    if (size + l.length > MAX_SUMMARY && kept.length > 0) break;
    kept.push(l.length > MAX_SUMMARY ? `${l.slice(0, MAX_SUMMARY)}…` : l);
    size += l.length + 1;
  }
  const hidden = all.length - kept.length;
  return hidden > 0 ? `${kept.join('\n')}\n… and ${hidden} more ${noun}${hidden === 1 ? '' : 's'} not shown` : kept.join('\n');
};
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const beforeAfter = (label: string, v: unknown): string => {
  const pair = record(v);
  // a reply-to can carry a fixed address, and an address is never cut
  const show = label === 'reply_to' ? (x: unknown) => line(typeof x === 'string' ? x : JSON.stringify(x) ?? 'null').slice(0, 1000) : clean;
  return 'before' in pair || 'after' in pair ? `${label}: ${show(pair.before)} → ${show(pair.after)}` : '';
};

/** An address is never shortened: a cut one could hide exactly the recipient the person must see. */
const address = (v: unknown): string => line(typeof v === 'string' ? v : JSON.stringify(v) ?? '?').slice(0, 320);
const recipient = (r: unknown): string => {
  const one = record(r);
  return `${clean(one.role ?? '?')} ${address(one.address ?? one.dynamic ?? one.source ?? '?')}`;
};
const keyOf = (r: unknown): string => JSON.stringify(r);
/** Who is added and who is dropped between two recipient lists, plus the full list after. */
const recipientLines = (label: string, before: unknown[], after: unknown[], full = true): string[] => {
  const was = new Set(before.map(keyOf));
  const now = new Set(after.map(keyOf));
  const added = after.filter((r) => !was.has(keyOf(r)));
  const removed = before.filter((r) => !now.has(keyOf(r)));
  return [
    added.length ? `${label} added: ${added.map(recipient).join(', ')}` : '',
    removed.length ? `${label} removed: ${removed.map(recipient).join(', ')}` : '',
    full ? `${label} after: ${after.map(recipient).join(', ') || 'none'}` : '',
  ];
};
/** Per-store-view delivery ({storeId: {recipients, reply_to, enabled}}), one line per change, addresses whole. */
const storeLines = (stores: unknown): string[] => {
  const pair = record(stores);
  const before = record(pair.before);
  const after = record(pair.after);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((store) => {
    const b = record(before[store]);
    const a = record(after[store]);
    return [
      ...recipientLines(`Store view ${clean(store)} recipients`, list(b.recipients), list(a.recipients), false),
      JSON.stringify(b.reply_to) !== JSON.stringify(a.reply_to) ? `Store view ${clean(store)} reply-to: ${address(b.reply_to ?? 'none')} → ${address(a.reply_to ?? 'none')}` : '',
      b.enabled !== a.enabled ? `Store view ${clean(store)} sends: ${clean(b.enabled ?? 'inherited')} → ${clean(a.enabled ?? 'inherited')}` : '',
    ];
  });
};
/** Recipient lines are kept whole; only the rest is cut to fit. */
const withRecipients = (head: string[], rest: string[]): string => {
  const first = head.filter(Boolean).join('\n');
  const tail = cap(rest);
  return [first, tail].filter(Boolean).join('\n');
};
const links = (v: unknown): string => {
  const l = record(v);
  const added = list(l.added).map(clean);
  const removed = list(l.removed).map(clean);
  return [added.length ? `links added: ${added.join(', ')}` : '', removed.length ? `links removed: ${removed.join(', ')}` : ''].filter(Boolean).join('; ');
};
const length = (v: unknown): string => {
  const l = record(v);
  return 'before' in l || 'after' in l ? `length ${clean(l.before)} → ${clean(l.after)}` : '';
};

/** `changes` of a notification command (recipients, delivery keys, content, conditions). */
export const notificationChanges = (changes: unknown): string => {
  const c = record(changes);
  const recipients = record(c.recipients);
  const head = 'before' in recipients || 'after' in recipients ? recipientLines('Recipients', list(recipients.before), list(recipients.after)) : [];
  head.push(...storeLines(c.stores));
  const lines: string[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (key === 'recipients' || key === 'stores' || key === 'content' || key === 'conditions') continue;
    lines.push(beforeAfter(key, value));
  }
  const content = record(c.content);
  if (content.changed === true) {
    lines.push(['Content changed', beforeAfter('subject', content.subjects), links(content.links), length(content.length)].filter(Boolean).join('; '));
  }
  const conditions = record(c.conditions);
  if (conditions.changed === true) lines.push(beforeAfter('Conditions', conditions) || 'Conditions changed');
  return withRecipients(head, lines) || 'No change the store could describe.';
};

/**
 * The form settings the store's write list puts in the confirm class (FormSettingWrite::CONFIRM): their effect
 * reaches beyond the form's page. Those that reach outside the store or lose data come first, so a summary
 * cut to fit never hides them.
 */
const FIRST = ['on_load_script', 'after_submission_script', 'redirect_url', 'is_publish_results', 'publish_title_field_id', 'publish_title_field_code', 'is_submissions_not_stored',
  'is_cleanup_enabled', 'cleanup_period', 'is_files_cleanup_enabled', 'files_cleanup_period', 'is_frontend_download_allowed',
  'cr_is_registered_on_submission', 'cr_is_registered_on_approval', 'url_key', 'success_text'];
const LIVE_KEYS = [...FIRST.slice(2), 'is_url_parameters_accepted', 'captcha_mode', 'is_customer_access_limited', 'access_groups',
  'is_customer_dashboard_enabled', 'dashboard_groups', 'customer_result_permissions', 'cr_is_customer_email_unique',
  'cr_is_default_notification_enabled', 'cr_map', 'cr_is_billing_address_enabled', 'cr_is_shipping_address_enabled',
  'cr_is_shipping_same_as_billing', 'cr_is_existing_customer_group_updated',
  // the names an exported document uses for the same settings
  'access_group_codes', 'dashboard_group_codes'];
const SCRIPTS = FIRST.slice(0, 2);
const rank = (e: Record<string, unknown>): number => {
  const at = FIRST.indexOf(String(e.key));
  return at >= 0 ? at : e.write === 'script' ? 0 : FIRST.length;
};
/** The store's test of a set value (FormWrite::liveSettings). */
const isSet = (v: unknown): boolean => !(v === null || v === undefined || v === '' || v === 0 || v === '0' || v === false || v === '[]' || v === 'default'
  || (typeof v === 'object' && Object.keys(v as object).length === 0));

/**
 * The settings of a form document that act beyond the form's page once it is on, with their values, at the
 * default scope and per store view: the keys the store lists in live_settings, read the way the store reads them.
 */
export const liveSettings = (document: unknown): string => {
  const doc = record(document);
  const scopes: Array<[string, Record<string, unknown>]> = [['', doc], ...Object.entries(record(doc.store_data)).map(([code, v]) => [`store view ${clean(code)}: `, record(v)] as [string, Record<string, unknown>])];
  const entries = scopes.flatMap(([scope, values]) => [
    ...SCRIPTS.filter((key) => isSet(values[key])).map((key) => ({ key, text: `${scope}${key}: a script of ${String(values[key]).length} characters that runs on the storefront` })),
    ...LIVE_KEYS.filter((key) => isSet(values[key])).map((key) => ({ key, text: `${scope}${key}: ${clean(values[key])}` })),
  ]);
  // ranked across every scope, so a long value of one store view never hides another view's redirect
  // a long text carries no outside effect of its own: it goes last here, after every setting that does
  const live = (e: { key: string }) => (e.key === 'success_text' ? FIRST.length + 1 : rank(e));
  const lines = entries.sort((a, b) => live(a) - live(b)).map((e) => e.text);
  if (lines.length === 0) return 'None of the settings that act beyond the form\'s page (redirect, captcha, published results, cleanup, customer registration, access) is set.';
  return `Settings that act beyond the form's page and work from the moment it is on:\n${cap(lines, 'setting')}`;
};

/**
 * `changes` of update-form: [{key, label, write, before, after}]; scripts and long texts only say that they change.
 * A recipients_change (the submitter's address field) comes first and is never cut.
 */
export const formChanges = (changes: unknown): string => {
  const entries = list(changes).map(record);
  const head = entries.filter((e) => e.kind === 'recipients_change').flatMap(recipientChange);
  const rest = entries.filter((e) => e.kind !== 'recipients_change').sort((a, b) => rank(a) - rank(b)).map((e) => {
    const name = clean(e.label ?? e.key);
    const reset = e.reset_to_default === true ? ' (back to the default)' : '';
    // scripts and long texts: the store says only that they change, and their lengths
    if (e.changed === true) return `${name}: changed, ${length(e.length)}${reset}`;
    return `${name}: ${clean(e.before)} → ${clean(e.after)}${reset}`;
  });
  return withRecipients(head, rest) || 'No change the store could describe.';
};

/**
 * impact of a status change (C23): whether customers get an email and which mails (the status's own template and
 * switched-on status_changed notifications). `count` is the number of submissions, so it never says how many people
 * get mail; one submission names its masked `recipient`, several name the first 10 masked `recipients` of a notification.
 */
export const statusImpact = (impact: unknown, several = false): string => {
  const i = record(impact);
  const status = record(i.status);
  const target = `status "${clean(status.label ?? status.code ?? '?')}"`;
  const customer = several ? 'the customers' : 'the customer';
  // the gate is reached only because the store said this emails: a missing description is not "no email"
  if (i.notifies_customer === undefined) return `Moves to ${target}; the store says this emails ${customer} but did not describe the email.`;
  if (i.notifies_customer !== true) return `Moves to ${target}; no email to ${customer}.`;
  const masks = list(i.recipients).slice(0, 10).map(address);
  const who = several || i.recipient === undefined || i.recipient === null ? customer : `${customer} (${address(i.recipient)})`;
  const names = list(i.notifications).map((n) => `"${clean(record(n).name ?? record(n).id)}"`);
  const mails = [
    i.email_template === undefined || i.email_template === null || i.email_template === '' ? ''
      : /^\d+$/.test(String(i.email_template)) ? `the email template #${clean(i.email_template)}` : `the template "${clean(i.email_template)}"`,
    names.length ? `the notification${names.length === 1 ? '' : 's'} ${names.join(', ')}` : '',
  ].filter(Boolean);
  const line = mails.length ? `Moves to ${target} and emails ${who} with ${mails.join(' and ')}.` : `Moves to ${target} and emails ${who}; the store did not say which email.`;
  if (!several) return line;
  if (masks.length === 0) return names.length ? `${line} The store shows no address that gets a notification.` : line;
  return `${line} ${masks.length === 10 ? 'Masked addresses (the store shows at most 10)' : 'Masked addresses'}: ${masks.join(', ')}.`;
};

/** impact of an approval verdict: the emails it sends the submitter and whether it registers a customer account. */
export const approvalImpact = (impact: unknown): string => {
  const i = record(impact);
  const verdict = record(i.approval);
  const move = `Approval ${clean(verdict.from ?? '?')} → ${clean(verdict.to ?? '?')}`;
  if (i.notifies_customer === undefined) return `${move}; the store says this emails the customer but did not describe the email.`;
  if (i.notifies_customer !== true) return `${move}; no email to the customer.`;
  const mails = list(i.notifications).map((n) => `"${clean(record(n).name ?? record(n).id)}"`);
  const to = i.recipient === undefined || i.recipient === null ? '' : ` (${clean(i.recipient)})`;
  const registers = i.registers_customer === true ? 'registers a customer account' : '';
  if (mails.length === 0) return `${move}; ${registers || 'the store says this reaches the customer but did not describe how'}.`;
  return `${move}; emails the customer${to}: ${mails.join(', ')}${registers ? `; ${registers}` : ''}.`;
};

/** changes of a confirmation's success message: the text itself is not shown, only that and how it changes. */
export const confirmationChanges = (changes: unknown): string => {
  const c = record(record(changes).changes ?? changes);
  return ['The success message visitors see changes', length(c.length), links(c.links)].filter(Boolean).join('; ') + '.';
};

/** A reply: who gets it and how it begins. */
export const replyPreview = (recipientMasked: unknown, body: unknown): string =>
  cap([`To: ${clean(recipientMasked)}`, (typeof body === 'string' ? body.replace(CONTROL, '').replace(INVISIBLE, '') : '').slice(0, 600)]);

/** A field id of a recipients_change: a live field's id, or null for a field the draft adds. */
const fieldRef = (v: unknown): string => (v === null ? 'a field the draft adds' : `#${clean(v)}`);

/**
 * One source of a recipients_change. contact: the addresses its options carry; field: {field_id} of the e-mail
 * field or null; submitter: {named, field_ids} — the address field the form names, or every active e-mail field.
 */
const recipientSource = (r: Record<string, unknown>): string => {
  const side = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? v.map(address).join(', ') : 'nobody';
    if (!v || typeof v !== 'object') return 'none';
    const one = record(v);
    if ('field_ids' in one) {
      const ids = list(one.field_ids).map(fieldRef).join(', ');
      if (one.named === true) return ids ? `the address field the form names (${ids})` : 'the address field the form names, which is switched off: nobody';
      return ids ? `every active e-mail field (${ids})` : 'no active e-mail field';
    }
    return one.field_id === null || one.field_id === undefined ? fieldRef(null) : `field ${fieldRef(one.field_id)}`;
  };
  const store = Number(r.store_id ?? 0) === 0 ? 'default scope' : `store view ${clean(r.store_id)}`;
  const source = r.source === 'submitter' ? 'the submitter\'s address'
    : r.source === 'field' ? `e-mail field "${clean(r.field_code ?? '?')}"`
      : `${clean(r.source ?? '?')} "${clean(r.field_code ?? '?')}"`;
  return `  ${clean(r.role ?? '?')} from ${source} (${store}): ${side(r.before)} → ${side(r.after)}`;
};

/** A recipients_change of a publish plan or of update-form: the notification, then every source before and after. */
const recipientChange = (item: Record<string, unknown>): string[] => {
  const subject = record(item.subject);
  return [`Recipients of the switched-on notification "${clean(subject.name ?? subject.id)}" change:`, ...list(record(item.detail).recipients).map((r) => recipientSource(record(r)))];
};

/** A publish plan: who a switched-on notification will email after it, in full, then counts and the first other entries. */
export const publishPlan = (impact: Array<Record<string, unknown>>): string => {
  const changes = impact.filter((item) => item.kind === 'recipients_change');
  const head = changes.flatMap(recipientChange);
  const rest = impact.filter((item) => item.kind !== 'recipients_change');
  return withRecipients(head, [
    impact.length === 0 ? 'No impact reported.' : `${impact.length} item${impact.length === 1 ? '' : 's'} in the publish plan${changes.length ? ` (${changes.length} recipient change${changes.length === 1 ? '' : 's'} above)` : ''}:`,
    // what loses data or reaches outside comes first, so a long plan never hides it past the cut
    ...[...rest].sort((a, b) => Number(b.severity === 'destructive' || b.severity === 'external') - Number(a.severity === 'destructive' || a.severity === 'external')).slice(0, 12).map(planItem),
    rest.length > 12 ? `- and ${rest.length - 12} more` : '',
  ]);
};

const count = (n: unknown, one: string): string => `${clean(n ?? 0)} ${one}${Number(n) === 1 ? '' : 's'}`;

/** How much stored data an item touches: detail {results, answers, files}. */
const data = (detail: Record<string, unknown>): string => {
  const files = Number(detail.files ?? 0) > 0 ? `, ${count(detail.files, 'file')}` : '';
  return Number(detail.answers ?? 0) > 0 || files ? `${count(detail.answers, 'answer')} in ${count(detail.results, 'submission')}${files}` : 'no answers or files';
};

/** One ImpactPlanner item {kind, severity, subject, detail}; a kind this release does not know shows the store's subject and detail as they are. */
const planItem = (item: Record<string, unknown>): string => {
  const subject = record(item.subject);
  const detail = record(item.detail);
  const severity = clean(item.severity ?? '?');
  const field = (withType: boolean) => `the field "${clean(subject.name ?? subject.id)}" (${clean(subject.code ?? '?')}${withType ? `, ${clean(subject.type ?? '?')}` : ''})`;
  switch (item.kind) {
    case 'field_delete': {
      const touched = data(detail);
      return `- ${severity}: removes ${field(true)}: ${touched}${touched === 'no answers or files' ? '' : Number(detail.answers ?? 0) === 1 && !Number(detail.files ?? 0) ? ' is lost' : ' are lost'}`;
    }
    case 'field_type_change':
      return `- ${severity}: changes the type of ${field(false)} from ${clean(detail.from ?? '?')} to ${clean(detail.to ?? '?')}: ${data(detail)}`;
    case 'option_remove': {
      const column = detail.column === undefined ? '' : ` in the column ${clean(detail.column)}`;
      return `- ${severity}: removes the option${list(detail.removed).length === 1 ? '' : 's'} ${list(detail.removed).map(clean).join(', ')}${column} of ${field(true)}: ${data(detail)}`;
    }
    case 'logic_change':
      return `- ${severity}: logic rules: ${clean(detail.added ?? 0)} added, ${clean(detail.removed ?? 0)} removed, ${clean(detail.changed ?? 0)} changed`;
    case 'setting_change': {
      const set = (v: unknown) => (v === true ? 'set' : 'not set');
      return `- ${severity}: the setting ${clean(subject.key ?? '?')}: ${set(detail.from_set)} → ${set(detail.to_set)}`;
    }
    default:
      return `- ${severity} ${clean(item.kind ?? '?')}: ${clean(item.subject ?? null)} ${clean(item.detail ?? null)}`;
  }
};

/**
 * What a new description of a change says that the approved one did not (+) and what it no longer says (-),
 * line by line, so a person approving again sees what moved since their first answer.
 */
export const approvalDiff = (approved: string, now: string): string => {
  const was = approved.split('\n');
  const is = now.split('\n');
  const lines = [...is.filter((l) => !was.includes(l)).map((l) => `+ ${l.trim()}`), ...was.filter((l) => !is.includes(l)).map((l) => `- ${l.trim()}`)];
  return lines.length ? lines.join('\n') : NO_DIFFERENCE;
};
/** approvalDiff when the descriptions read the same. */
export const NO_DIFFERENCE = 'The store describes the change as before; what it checks (for example a revision) moved without showing in that description, or the earlier approval was used already and the change may be applied.';

/** An activation diff (recipients added/removed, per-store delivery, sender and envelope before/after, template and wrapper, links, the submission data the email carries). */
export const activationDiff = (diff: Record<string, unknown>): string => {
  const recipients = record(diff.recipients);
  const head = [
    ...list(recipients.added).length ? [`Recipients added: ${list(recipients.added).map(recipient).join(', ')}`] : [],
    ...list(recipients.removed).length ? [`Recipients removed: ${list(recipients.removed).map(recipient).join(', ')}`] : [],
    ...storeLines(diff.stores),
  ];
  const rest: string[] = [diff.first_activation === true ? 'First activation.' : ''];
  for (const key of ['audience', 'envelope', 'senders', 'reply_to', 'attachments', 'content_mode']) {
    const pair = record(diff[key]);
    if (JSON.stringify(pair.before) !== JSON.stringify(pair.after)) rest.push(beforeAfter(key, pair));
  }
  for (const [key, label] of [['legacy_ref', 'Email template'], ['wrapper_ref', 'Email wrapper']] as const) {
    const pair = record(diff[key]);
    if (JSON.stringify(pair.before) !== JSON.stringify(pair.after)) rest.push(`${label}: ${clean(pair.before ?? 'none')} → ${clean(pair.after ?? 'none')}`);
  }
  // the store's hash covers every saved version, including the subject, text and sending conditions it does not list here
  const hash = record(diff.hash);
  if (diff.first_activation !== true && hash.before !== hash.after) rest.push('The email was saved again since it was last switched on; the store does not list changes to its subject, text or sending conditions.');
  rest.push(links(diff.links));
  // which submission data the email carries ({{var}} names): a password field or an IP joining the mail is a change the person approves
  const variables = record(diff.variables);
  if (list(variables.added).length) rest.push(`Submission data the email adds: ${list(variables.added).map(clean).join(', ')}`);
  if (list(variables.removed).length) rest.push(`Submission data the email no longer carries: ${list(variables.removed).map(clean).join(', ')}`);
  return withRecipients(head, rest) || 'No change the store could describe.';
};
