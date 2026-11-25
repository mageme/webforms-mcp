/**
 * What the dispatcher needs to know about each tool: which store it acts on, whether it changes
 * anything, and where identifiers sit in its input and its answer.
 *
 * The inventory is not frozen here - the plugin gains tools as it is developed. A test compares this
 * table against the tools a built server actually registers, so a new tool without an entry fails the
 * build rather than silently bypassing site resolution.
 */
export type DispatchClass = 'site-neutral' | 'site-selection' | 'site-bound';

export type HandleKind =
  | 'form' | 'draft' | 'result' | 'import' | 'export' | 'grant'
  | 'version' | 'field' | 'fieldset' | 'logic' | 'notification'
  | 'status' | 'quick_response' | 'note' | 'attachment' | 'order';

/**
 * A dotted path into an argument object or a structured answer; `[]` walks every array element.
 * `accepts` widens an input path: "either" takes the bare number too, because the form document hands
 * that id out bare; "ref" is an id or a field code, so a string is a handle only when it names a store;
 * "target" is a logic target ("field_<id>", "fieldset_<id>", "submit", or a list of them); "settings" is a free-form
 * object whose `*_id(s)` values, `cr_map` entries and object keys may carry ids (see dequalifySettings); "keys" is an
 * object keyed by id whose values are visitor data and stay as they are.
 */
export interface HandlePath { path: string; kind: HandleKind; accepts?: 'either' | 'ref' | 'target' | 'settings' | 'keys' }

export interface ToolSpec {
  name: string;
  dispatchClass: DispatchClass;
  isMutation: boolean;
  handlesIn: HandlePath[];
  handlesOut: HandlePath[];
}

const SPECS: ToolSpec[] = [
  { name: 'list_sites', dispatchClass: 'site-neutral', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'use_site', dispatchClass: 'site-selection', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'get_capabilities', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'get_appearance', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'get_import_status', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'import_id', kind: 'import' }], handlesOut: [{ path: 'import_id', kind: 'import' }, { path: 'id', kind: 'import' }, { path: 'form_id', kind: 'form' }] },
  { name: 'list_forms', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [{ path: 'items[].id', kind: 'form' }] },
  { name: 'get_form', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'id', kind: 'form' }] },
  { name: 'get_form_document', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [] },
  { name: 'list_form_versions', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'items[].id', kind: 'version' }, { path: 'items[].form_id', kind: 'form' }] },
  { name: 'get_form_version_document', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'version_id', kind: 'version' }], handlesOut: [] },
  { name: 'get_translations', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [] },
  { name: 'get_confirmation_content', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [] },
  { name: 'list_templates', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'get_schema', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [] },
  { name: 'list_statuses', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [{ path: 'items[].id', kind: 'status' }] },
  { name: 'list_quick_responses', dispatchClass: 'site-bound', isMutation: false, handlesIn: [], handlesOut: [{ path: 'items[].id', kind: 'quick_response' }] },
  { name: 'get_form_stats', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }] },
  { name: 'list_submission_changes', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'items[].result_id', kind: 'result' }] },
  { name: 'search_submissions', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'field_filter[].field', kind: 'field', accepts: 'ref' }, { path: 'grant_id', kind: 'grant' }], handlesOut: [{ path: 'items[].id', kind: 'result' }, { path: 'items[].form_id', kind: 'form' }] },
  { name: 'get_submission', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'form_id', kind: 'form' }, { path: 'items[].id', kind: 'result' }, { path: 'items[].form_id', kind: 'form' }] },
  { name: 'list_submission_notes', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'grant_id', kind: 'grant' }], handlesOut: [{ path: 'items[].id', kind: 'note' }] },
  { name: 'list_submission_attachments', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'grant_id', kind: 'grant' }], handlesOut: [{ path: 'items[].attachment_id', kind: 'attachment' }, { path: 'items[].field_id', kind: 'field' }] },
  { name: 'create_form', dispatchClass: 'site-bound', isMutation: true, handlesIn: [], handlesOut: [{ path: 'id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'create_form_from_template', dispatchClass: 'site-bound', isMutation: true, handlesIn: [], handlesOut: [{ path: 'id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'activate_form', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'deactivate_form', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'prepare_import', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'import_id', kind: 'import' }, { path: 'id', kind: 'import' }, { path: 'form_id', kind: 'form' }] },
  { name: 'commit_import', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'import_id', kind: 'import' }], handlesOut: [{ path: 'import_id', kind: 'import' }, { path: 'id', kind: 'import' }, { path: 'form_id', kind: 'form' }] },
  { name: 'cancel_import', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'import_id', kind: 'import' }], handlesOut: [{ path: 'import_id', kind: 'import' }, { path: 'id', kind: 'import' }, { path: 'form_id', kind: 'form' }] },
  { name: 'update_appearance', dispatchClass: 'site-bound', isMutation: true, handlesIn: [], handlesOut: [] },
  { name: 'duplicate_form', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'open_draft', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'live_id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'get_draft', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'live_id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'get_draft_document', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [] },
  { name: 'draft_discard', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'restore_version', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'version_id', kind: 'version' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'live_id', kind: 'form' }, { path: 'form_id', kind: 'form' }] },
  { name: 'draft_update_form', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_add_section', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'section_id', kind: 'fieldset' }] },
  { name: 'draft_update_section', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'section_id', kind: 'fieldset', accepts: 'either' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_remove_section', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'section_id', kind: 'fieldset', accepts: 'either' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_reorder', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'positions.sections[].id', kind: 'fieldset', accepts: 'either' }, { path: 'positions.fields[].id', kind: 'field', accepts: 'either' }, { path: 'positions.fields[].section_id', kind: 'fieldset', accepts: 'either' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_add_field', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'section_id', kind: 'fieldset', accepts: 'either' }, { path: 'after_field_id', kind: 'field', accepts: 'ref' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field' }] },
  { name: 'draft_update_field', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field', accepts: 'ref' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_turn_field_into', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field', accepts: 'ref' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_duplicate_field', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field', accepts: 'ref' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field' }] },
  { name: 'draft_list_trash', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'items[].field_id', kind: 'field' }] },
  { name: 'draft_restore_field', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field' }, { path: 'section_id', kind: 'fieldset' }, { path: 'before_field_id', kind: 'field' }, { path: 'after_field_id', kind: 'field' }] },
  { name: 'draft_remove_field', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'field_id', kind: 'field', accepts: 'ref' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_set_logic', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'rules[].logic_id', kind: 'logic', accepts: 'either' }, { path: 'rules[].field_id', kind: 'field', accepts: 'ref' }, { path: 'rules[].target', kind: 'field', accepts: 'target' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_add_logic', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'rules[].field_id', kind: 'field', accepts: 'ref' }, { path: 'rules[].target', kind: 'field', accepts: 'target' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }, { path: 'logic_id', kind: 'logic' }] },
  { name: 'draft_remove_logic', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'logic_id', kind: 'logic', accepts: 'either' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_set_translations', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }, { path: 'translations', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_replace_document', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_validate', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_prepare_publish', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'draft_id', kind: 'draft' }] },
  { name: 'draft_publish', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'draft_id', kind: 'draft' }], handlesOut: [{ path: 'form_id', kind: 'form' }] },
  { name: 'add_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'notification', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'update_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'patch', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'set_notification_content', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'set_notification_store_settings', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'settings', kind: 'field', accepts: 'settings' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'set_confirmation_content', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }] },
  { name: 'set_notification_conditions', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'duplicate_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }, { path: 'notification_id', kind: 'notification' }] },
  { name: 'remove_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }], handlesOut: [{ path: 'form_id', kind: 'form' }] },
  { name: 'activate_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'notification_id', kind: 'notification', accepts: 'either' }], handlesOut: [] },
  { name: 'deactivate_notification', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'notification_id', kind: 'notification', accepts: 'either' }], handlesOut: [] },
  { name: 'update_submission_values', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'values', kind: 'field', accepts: 'keys' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'set_submission_status', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'set_submission_approval', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'assign_submission', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'mark_submission', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'add_submission_note', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'link_submission_order', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'order_id', kind: 'order' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'unlink_submission_order', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'order_id', kind: 'order' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'prepare_reply', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'send_reply', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'result_id', kind: 'result' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'result_id', kind: 'result' }, { path: 'form_id', kind: 'form' }] },
  { name: 'request_pii_grant', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'fields[]', kind: 'field', accepts: 'ref' }], handlesOut: [{ path: 'grant_id', kind: 'grant' }, { path: 'form_id', kind: 'form' }] },
  { name: 'revoke_pii_grant', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'grant_id', kind: 'grant' }], handlesOut: [{ path: 'grant_id', kind: 'grant' }, { path: 'form_id', kind: 'form' }] },
  { name: 'get_submission_full', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'result_id', kind: 'result' }, { path: 'grant_id', kind: 'grant' }], handlesOut: [{ path: 'id', kind: 'result' }, { path: 'form_id', kind: 'form' }, { path: 'items[].id', kind: 'result' }, { path: 'items[].form_id', kind: 'form' }] },
  { name: 'export_submissions', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'form_id', kind: 'form' }, { path: 'field_filter[].field', kind: 'field', accepts: 'ref' }], handlesOut: [{ path: 'export_id', kind: 'export' }] },
  { name: 'get_export_status', dispatchClass: 'site-bound', isMutation: false, handlesIn: [{ path: 'export_id', kind: 'export' }], handlesOut: [{ path: 'export_id', kind: 'export' }] },
  { name: 'mass_status', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'items[].result_id', kind: 'result' }], handlesOut: [] },
  { name: 'mass_assign', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'items[].result_id', kind: 'result' }], handlesOut: [] },
  { name: 'mass_read', dispatchClass: 'site-bound', isMutation: true, handlesIn: [{ path: 'items[].result_id', kind: 'result' }], handlesOut: [] },
];

export const MANIFEST: Record<string, ToolSpec> = Object.fromEntries(SPECS.map((s) => [s.name, s]));

export const specOf = (name: string): ToolSpec => {
  const spec = MANIFEST[name];
  if (!spec) {
    throw new Error(`No manifest entry for tool "${name}"; add one in src/manifest.ts before registering it.`);
  }
  return spec;
};

/** The MCP tool hints a host shows or acts on; one table, so no registration can leave them out. */
export interface ToolHints { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }

/** Not mutations, yet not read-only: use_site moves the session to a store; the others can spend a disclosure grant's quota and write the store's disclosure log. */
const NOT_READ_ONLY = new Set(['use_site', 'search_submissions', 'get_submission_full', 'list_submission_notes', 'list_submission_attachments']);

/** Writes that remove, overwrite or switch off something that existed; every other write only adds. */
const DESTRUCTIVE = new Set([
  'deactivate_form', 'cancel_import', 'commit_import', 'update_appearance', 'draft_discard', 'restore_version',
  'draft_update_form', 'draft_update_section', 'draft_remove_section', 'draft_update_field', 'draft_turn_field_into',
  'draft_remove_field', 'draft_set_logic', 'draft_remove_logic', 'draft_set_translations', 'draft_replace_document',
  'draft_publish', 'update_notification', 'set_notification_content', 'set_notification_store_settings',
  'set_confirmation_content', 'set_notification_conditions', 'remove_notification', 'deactivate_notification',
  'update_submission_values', 'set_submission_status', 'set_submission_approval', 'assign_submission',
  'unlink_submission_order', 'revoke_pii_grant', 'mass_status', 'mass_assign',
]);

/** Writes whose repeat with the same arguments leaves the store as the first call left it. */
const IDEMPOTENT = new Set([
  'activate_form', 'deactivate_form', 'cancel_import', 'update_appearance', 'draft_discard', 'draft_update_form',
  'draft_update_section', 'draft_reorder', 'draft_update_field', 'draft_set_logic', 'draft_set_translations',
  'draft_replace_document', 'update_notification', 'set_notification_content', 'set_notification_store_settings',
  'set_confirmation_content', 'set_notification_conditions', 'activate_notification', 'deactivate_notification',
  'update_submission_values', 'set_submission_status', 'set_submission_approval', 'assign_submission',
  'mark_submission', 'link_submission_order', 'unlink_submission_order', 'revoke_pii_grant', 'mass_status',
  'mass_assign', 'mass_read', 'use_site',
]);

/** Writes that email someone outside the store at the moment they run. */
const OPEN_WORLD = new Set(['set_submission_status', 'set_submission_approval', 'send_reply', 'mass_status']);

export const hintsOf = (name: string): ToolHints => {
  const spec = specOf(name);
  const readOnly = !spec.isMutation && !NOT_READ_ONLY.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE.has(name),
    idempotentHint: readOnly || IDEMPOTENT.has(name),
    openWorldHint: OPEN_WORLD.has(name),
  };
};
