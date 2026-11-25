/**
 * Compact field-type guide, generated from the store's live catalogue so it can never drift from the
 * code. One line per setting, only what a model needs to pick a type and fill it in; the verbose
 * catalogue stays at webforms://schema/field-types.
 */

interface Setting {
  type?: string;
  required?: boolean;
  translatable?: boolean;
  structured?: boolean;
  enum?: string[];
}

interface Catalog {
  field_types: Record<string, { settings?: Record<string, Setting> }>;
  form?: { settings?: Record<string, Setting> };
  fieldset?: { settings?: Record<string, Setting> };
}

/** Cosmetic keys every type shares; listing them 51 times would drown the signal. */
const COMMON = new Set([
  'code', 'name', 'is_active', 'is_required', 'is_label_hidden', 'comment', 'comment_position', 'tooltip',
  'result_label', 'display_in_result', 'custom_attributes', 'customer_data', 'pii_class',
  'css_container_class', 'css_input_class', 'css_input_style',
  'width_proportion_lg', 'width_proportion_md', 'width_proportion_sm',
  'is_displayed_in_new_row_lg', 'is_displayed_in_new_row_md', 'is_displayed_in_new_row_sm',
  'validation_required_message', 'min_length', 'max_length', 'min_length_validation_message',
  'max_length_validation_message', 'regex_validation_pattern', 'regex_validation_message',
  'is_unique', 'unique_validation_message', 'browser_autocomplete', 'placeholder',
]);

const settingLine = (key: string, s: Setting): string => {
  const kind = s.enum ? `enum(${s.enum.filter((v) => v !== '').slice(0, 12).join('|')}${(s.enum.length > 13 ? '|…' : '')})` : s.structured ? 'structured' : (s.type ?? 'string');
  return `${key}: ${kind}${s.translatable ? ' [translatable]' : ''}`;
};

export const buildGuide = (catalog: Catalog): string => {
  const out: string[] = [
    '# WebForms field-type guide (generated from this store\'s catalogue)',
    '',
    'Every type also accepts the common settings: label/name, code, is_required, placeholder, comment,',
    'tooltip, pii_class (plain|pii), validation (min/max length, regex, messages),',
    'grid: width_proportion_lg|md|sm (1-1, 1-2, 1-3, …) + is_displayed_in_new_row_lg|md|sm on the first',
    'element of each row, css_* classes. Only type-specific settings are listed below.',
    '',
    'Layout: elements land at the end of their section unless `position` is given; elements outside any',
    'section can sit above or below the sections (is_displayed_below_sections). Field references',
    '(country_field_id, password_match_value_field_id, email_match_value_field_id) take a field id from',
    'this draft; on publish they are remapped to the live ids automatically.',
    '',
    'Choosing between swatches and gallery: tiles showing pictures — finishes, fabrics, materials,',
    'product shots — are always `gallery`, never `swatches`. A swatch choice does accept an image, so',
    'the wrong type looks buildable; `swatches` is for colour chips and short text options. `gallery`',
    'is the type built for pictures: an image library per field, thumbnail and preview sizes, tags,',
    'letter navigation, multi-select and an "+N more" picker popup.',
    '',
  ];
  for (const [type, def] of Object.entries(catalog.field_types).sort(([a], [b]) => a.localeCompare(b))) {
    const own = Object.entries(def.settings ?? {})
      .filter(([key]) => !COMMON.has(key))
      .map(([key, s]) => settingLine(key, s));
    out.push(`## ${type}`);
    if (own.length) out.push(...own.map((line) => `- ${line}`));
    out.push('');
  }
  const formSettings = Object.entries(catalog.form?.settings ?? {}).filter(([k]) =>
    ['success_text', 'submit_button_text', 'captcha_mode', 'is_multistep', 'progress_indicator', 'is_enable_pre_submit_review', 'redirect_url', 'is_customer_dashboard_enabled'].includes(k));
  if (formSettings.length) {
    out.push('## form (selected settings)');
    out.push(...formSettings.map(([key, s]) => `- ${settingLine(key, s)}`));
    out.push('');
    out.push('Multistep: is_multistep=true turns each SECTION into a step (order = section order);');
    out.push('progress_indicator picks the header style, is_enable_pre_submit_review adds a review step');
    out.push('before submit. Step colors: per-form appearance_step_accent/done/rail, or the global');
    out.push('step_* appearance tokens (update_appearance).');
    out.push('');
  }
  // Behavior settings grouped by concern, generated from the same catalog so nothing here can name a
  // key the server would refuse. Side-effect settings reach outside the form — change them only on
  // the user's explicit say-so.
  const groups: [string, string, (k: string) => boolean][] = [
    ['access', 'who may open the form and see own submissions', (k) => /^(is_customer_access_limited|access_groups|is_customer_dashboard_enabled|dashboard_groups|customer_result_permissions)$/.test(k)],
    ['registration', 'create a customer account from a submission; cr_map maps field ids to customer attributes', (k) => k.startsWith('cr_')],
    ['approval', 'submissions wait for admin approval; templates per outcome', (k) => k.startsWith('approval_') || k === 'is_approval_controls_enabled' || k === 'is_approval_notification_enabled'],
    ['notifications', 'who is emailed on submission and how', (k) => /notification|sender|reply_to|bcc/.test(k) && !k.startsWith('approval_') && k !== 'is_approval_notification_enabled' && !k.startsWith('cr_')],
    ['reference number', 'the number every submission gets; inherit follows the store, off issues none, custom uses the form\'s own type/length/prefix/suffix (type: alphanumeric=4 hexadecimal=0 numeric=1 timestamp=2 sequential=3; a sequential number draws from one installation-wide counter)', (k) => k.startsWith('reference_number_') || k === 'is_reference_number_added_to_email' || k === 'is_reference_number_added_to_pdf_name'],
    ['retention', 'what is stored and for how long', (k) => /^(is_submissions_not_stored|is_cleanup_enabled|cleanup_period|is_files_cleanup_enabled|files_cleanup_period|is_url_parameters_accepted|is_frontend_download_allowed)$/.test(k)],
  ];
  const seen = new Set(formSettings.map(([k]) => k));
  out.push('## form behavior (fine-tuning; side-effect settings need the user\'s explicit approval)');
  for (const [name, hint, match] of groups) {
    const keys = Object.entries(catalog.form?.settings ?? {}).filter(([k]) => !seen.has(k) && match(k));
    if (!keys.length) continue;
    keys.forEach(([k]) => seen.add(k));
    out.push(`### ${name} — ${hint}`);
    out.push(...keys.map(([key, s]) => `- ${settingLine(key, s)}`));
  }
  out.push('');
  out.push('## translating');
  out.push('An empty [translatable] text is not blank on the storefront: the store view shows the phrase given');
  out.push('beside it in `defaults` (language in `defaults_locale`). To translate it, set the translation of that');
  out.push('phrase for the store view; a value equal to the phrase is not stored, so leave it out when it already');
  out.push('reads right. Keep placeholders such as %1; a %N the phrase does not have is refused.');
  out.push('');
  out.push('## fieldset (section)');
  out.push(...Object.entries(catalog.fieldset?.settings ?? {}).map(([key, s]) => `- ${settingLine(key, s)}`));
  return out.join('\n');
};
