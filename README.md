# webforms-mcp

MCP server (stdio) for the MageMe WebForms management API on Magento 2: forms, drafts, translations,
notifications, appearance, imports, publishing and submission handling with server-side personal-data
masking. It runs on your own computer, next to Claude Code or Claude Desktop, and talks to your store
over its REST API.

## Requirements

- WebForms 4.0.0 or later with the Management API module (`MageMe_WebFormsApi`) on the store.
  webforms-mcp 1.x works with WebForms 4.x; the person's approval of held-back changes relies on the store's confirmations, which every 4.x release has.
- Node.js 22.19 or later on the computer that runs Claude.

## 1. On the store: create the connection

From the Magento root, as the user that runs Magento commands:

```
php bin/magento webforms:api:connect --preset=editor        # reader | editor | support | full
```

It creates (or, with `--reissue`, refreshes) a Magento Integration named "WebForms MCP", grants exactly
that preset out of the `WebForms > API` block of the ACL tree, activates it, and prints one connection
string carrying the store URL and all four OAuth values. `--permissions=a,b,c` **replaces** the preset with
an explicit list; `--name` runs several side by side; `--raw` prints the string alone, for scripts.
Linking submissions to orders needs the Sales order view permission too: list the permissions you need
plus `sales_orders_view` in `--permissions` (no preset includes it). `--reissue` invalidates the tokens
the integration had, so every client using it must run `setup --overwrite --from` again, with the same
`--profile` the store was set up with (without one, `setup` writes the default store).

**Form access.** By default the integration reaches **All Forms**, including forms created later.
`--forms=selected` limits it to the forms ticked on the integration in System > Extensions > Integrations
(none until you tick some); a `--reissue` keeps the current choice unless `--forms` is given, and keeps
the ticked forms. `setup` and `probe` print it as `Form access: All Forms`, `Selected forms` or `No forms`;
`get_capabilities` and `list_sites` (with `probe: true`, which always asks the store afresh) carry the same label as
`form_access`. Servers older than this version do not report a scope: `setup` then prints `Form access: not reported`
and the tools return `form_access: null`. A form outside the scope, and everything that
belongs to it, answers `NOT_FOUND` exactly like an id that does not exist: the object does not exist or
the integration cannot see it.

## 2. On your computer: set up and register

Paste the connection string when `setup` asks for it:

```
npx -y @mageme/webforms-mcp@1 setup --from
```

Or pipe it straight from the store, so it never reaches your shell history or `ps` output:

```
ssh store 'cd /path/to/magento && php bin/magento webforms:api:connect --preset=editor --raw' | npx -y @mageme/webforms-mcp@1 setup --from-stdin
```

The store is probed before anything is written, so a refused credential set never costs you a working
profile. After a successful setup, `setup` prints the exact commands to register the server. They are:

**Claude Code**

```
claude mcp add webforms --scope user -- npx -y @mageme/webforms-mcp@1
```

On Windows (not WSL), npx has to run through `cmd /c`:

```
claude mcp add webforms --scope user -- cmd /c npx -y @mageme/webforms-mcp@1
```

**Claude Desktop** (Settings > Developer > Edit Config), macOS:

```json
{ "mcpServers": { "webforms": { "command": "npx", "args": ["-y", "@mageme/webforms-mcp@1"] } } }
```

Windows:

```json
{ "mcpServers": { "webforms": { "command": "cmd", "args": ["/c", "npx", "-y", "@mageme/webforms-mcp@1"] } } }
```

`@1` keeps you on the 1.x line: fixes arrive by themselves, a new major version only when you change it.
To stay on one release until you decide to move, write the exact version instead, for example
`@mageme/webforms-mcp@1.0.0`.

Check the connection at any time with `npx -y @mageme/webforms-mcp@1 probe`: it lists every Management
API permission the store reports as granted, so a missing one shows up before it interrupts real work.

`setup` without `--from` asks for the base URL and the four OAuth values one by one, which is the path
when the integration was made by hand in the admin. `--from=<string>` also works but leaves the
credentials in argv, so `setup` warns about it. Other flags: `--allow-insecure` (plain http to a
non-localhost host), `--insecure-tls` (skip certificate verification, development instances only),
`--overwrite` (replace a profile that already exists; without it a second `setup` of the same profile stops
before asking for anything), `--profile <name>`, `--from-stdin`. `setup --help` lists them.

`--insecure-tls` and `--allow-insecure` are for development stores. For a host other than `localhost`,
`*.local`, `*.test` or `*.localhost`, `setup` refuses them unless `WEBFORMS_MCP_ALLOW_INSECURE_TLS=1` is set
in its own environment. The server likewise refuses a store with `insecureTls` or plain http (`allowInsecure`) on such a host at start
unless the same variable is set in the server's environment. The registration command `setup` prints never contains that variable: add it yourself
(`claude mcp add … -e WEBFORMS_MCP_ALLOW_INSECURE_TLS=1 -- …`), and only for a development store.

Other commands: `sites` lists the configured stores without contacting them, `probe` checks each one
(connection, API version, permissions), `--help` and `--version`. This release speaks WebForms API v1 and
refuses a store that reports another major version or a version it cannot read.

### Environment variables

| Variable | What it does |
|---|---|
| `WEBFORMS_MCP_HOME` | Where credentials, the journal and the import directory live; default `~/.webforms-mcp`. |
| `WEBFORMS_MCP_PROFILE` | Serve only this profile (a dedicated process), as `--profile` does. |
| `WEBFORMS_MCP_CREDENTIALS_FILE` | Serve only this credentials file. Its name must be `credentials.<key>.json` (or `credentials.json`), because the store key is read from it. |
| `WEBFORMS_MCP_IMPORT_ROOT` | Where import files are read from; default `<WEBFORMS_MCP_HOME>/import`. |
| `WEBFORMS_MCP_ALLOW_INSECURE_TLS` | `1` lets a store with `insecureTls` or plain http (`allowInsecure`) on a non-local host be loaded (development stores only). |

The keys themselves are never passed through the environment: they stay in the credentials file (mode 600).

**Troubleshooting.** If Claude Desktop cannot start the server on macOS with Node installed through nvm,
the app does not see your shell's PATH, and `npx` cannot find `node` either. Give the server entry the
PATH of your Node version: `"env": { "PATH": "<output of: dirname $(which node)>:/usr/bin:/bin" }`.
The first start through `npx` downloads the package; running `setup` once beforehand warms the cache, so the
host does not time out waiting for it. If the server says a credentials file was skipped, the line names the
reason (permissions, owner, content); fix that file rather than running `setup` again.

### Several stores

One process serves them all. Every `credentials.<name>.json` in `~/.webforms-mcp` is a store, and the
server picks all of them up:

```
npx -y @mageme/webforms-mcp@1 setup --profile acme --from     # adds a store
npx -y @mageme/webforms-mcp@1 sites                           # what this process serves, without contacting anyone
claude mcp add webforms --scope user -- npx -y @mageme/webforms-mcp@1
```

One host entry, however many stores. Each tool takes a `site` argument naming the store — its key or its
host — and `use_site` fixes one for the conversation so the argument can be dropped. `list_sites` shows
them with the selected one marked.

With more than one store configured, a write that names a different store than the selected one is
refused rather than guessed at, and identifiers are written **qualified by their store**:

```
list_forms(site: "acme")   →   { "items": [ { "id": "acme:42", … } ] }
get_form(form_id: "acme:42")
```

Pass identifiers back exactly as they came. Every store numbers its own forms and submissions, so a bare
`42` says nothing about where it belongs; a shared process refuses it. Identifiers inside a form
document, a schema or a translation set stay bare — that block belongs to one store as a whole. A bare
`notification_id` copied from a form document is taken by `activate_notification` / `deactivate_notification`
only when the call names its store with `site`.

### One store on its own

A client that must not share a process gets its own. Put its credentials under `isolated/`, where the
shared process never looks:

```
npx -y @mageme/webforms-mcp@1 setup --profile bigclient --isolated --from
claude mcp add webforms-bigclient --scope user -- npx -y @mageme/webforms-mcp@1 --profile bigclient
```

A dedicated process serves exactly that store, keeps identifiers bare, and still answers the resource
URIs it always did. `WEBFORMS_MCP_PROFILE` and `WEBFORMS_MCP_CREDENTIALS_FILE` select one the same way;
an explicit `--profile` wins over both.

**What the shared process is, and is not.** It is a convenience: one process, one host entry, a visible
list of stores, and identifiers that cannot be confused between them. It is **not** a boundary between
clients. It holds the credentials of every store it serves, so anything that can name a store can reach
it — including text arriving from a store, which is why submission content is marked untrusted. A client
that needs isolation runs its own process, and better still its own OS user or container.

The server signs every request with OAuth 1.0a HMAC-SHA256 and never follows redirects.

## Tools (read-only)

`get_capabilities`, `list_forms`, `get_form`, `get_form_document`, `list_form_versions`,
`get_form_version_document`, `get_translations`, `get_confirmation_content`, `list_templates`, `get_schema`, `list_statuses`,
`list_quick_responses`, `get_form_stats`, `search_submissions`, `get_submission`,
`list_submission_notes`, `list_submission_attachments`, `list_submission_changes`, `get_appearance`,
`get_import_status`.

## Tools (write)

Forms: `create_form`, `create_form_from_template`, `duplicate_form`, `activate_form`, `deactivate_form`. Store-wide appearance:
`update_appearance`. Historical submissions import: `prepare_import`, `commit_import`, `cancel_import`. Notifications:
`add_notification`, `update_notification`, `duplicate_notification`, `remove_notification`,
`activate_notification`, `deactivate_notification`, `set_notification_conditions`,
`set_notification_content`, `set_notification_store_settings`. Confirmations: `set_confirmation_content`. Drafts: `open_draft`, `get_draft`,
`get_draft_document`, `draft_update_form`, `draft_add_section`, `draft_update_section`,
`draft_remove_section`, `draft_reorder`, `draft_add_field`, `draft_update_field`, `draft_turn_field_into`,
`draft_duplicate_field`, `draft_remove_field`, `draft_list_trash`, `draft_restore_field`, `draft_set_logic`, `draft_add_logic`, `draft_remove_logic`,
`draft_set_translations`,
`draft_replace_document`, `draft_validate`, `draft_prepare_publish`, `draft_publish`, `draft_discard`,
`restore_version`. Submissions: `update_submission_values`, `set_submission_status`, `assign_submission`,
`mark_submission`, `set_submission_approval`, `add_submission_note`, `link_submission_order`, `unlink_submission_order`, `mass_status`, `mass_assign`, `mass_read`, `prepare_reply`,
`send_reply`, `request_pii_grant`, `revoke_pii_grant`, `get_submission_full`, `export_submissions`,
`get_export_status`.

The API does not delete forms or submissions; that is a deliberate precaution. `remove_notification`,
`draft_remove_*` and `draft_discard` act on notifications and on the draft only. To take a form off the
storefront, switch it off with `deactivate_form`.

**Importing historical submissions.** Put the JSONL file in the store's import directory,
`~/.webforms-mcp/import/<site key>/` (`<site key>` is the profile name, `default` for `credentials.json`;
`WEBFORMS_MCP_IMPORT_ROOT` moves the parent directory; the parent itself is read only by a process serving one store). `prepare_import` reads it from there only, shows the
file's size and sha256 for the user to confirm, uploads and validates it without writing a submission;
`commit_import` writes the rows, `cancel_import` stops an import.

Two-step actions (`draft_prepare_publish` → `draft_publish`, `prepare_reply` → `send_reply`,
`activate_notification`) return a preview and an opaque `confirmation_id`; the server-issued token stays in
process memory and is never shown to the model.

Some changes the store itself holds back until a person approves them: a change to a switched-on
notification (`update_notification`, `set_notification_content`, `set_notification_store_settings`,
`set_notification_conditions`), form settings with a side effect or a script (`draft_update_form`; among them the
submitter's address field when it changes whom a switched-on notification emails), a status set to notify the
customer, which emails them with its own template (if it has one) and through any switched-on notifications sent on
a status change (`set_submission_status`; `mass_status` shows up to 10 masked addresses), an approval verdict that emails the
submitter (`set_submission_approval`) and a shown success message (`set_confirmation_content`). The first call changes nothing and answers with the store's description of the
change (recipients before and after, which settings change, who gets an email) and a `confirmation_id`; the same
call with that `confirmation_id` applies it. Anything else goes through at once. If the store turns the approval
down because the change is no longer what was approved (it would email someone else, a notification was switched
on in between), nothing is applied: the answer describes the change anew, with what differs, under a new
`confirmation_id`, and the person is asked again. A publish that changes whom a switched-on notification emails
(contact options, an e-mail field, the submitter's address field) lists every address before and after in the
question. Markup that runs code on the storefront (scripts, event handlers, directives) in a form text or an HTML
field needs the integration's "Edit Form Scripts" permission; without it the store refuses the write, and the
answer names the store view and carries the text's key and the markup as untrusted data.

**Who approves.** Irreversible tools require `confirmed_by_user: true`, which the model may set only after the
user approved — and because that is the model's word about itself, a client advertising the `elicitation`
capability is asked instead: the server puts the question to the person, with what they approve in it (the new
recipients, the settings, the publish plan, the start of the reply), and their answer decides, whatever the
argument said. If that question fails or times out, nothing is done; it never falls back to the argument. A
client without elicitation keeps the argument-only contract, so with such a client the model's word is what
stands between it and an irreversible action; its refusal carries what the user approves, as an untrusted block
to show them. Switching off a form whose text runs code on the storefront
(`deactivate_form`; without the "Edit Form Scripts" permission the integration cannot switch it back on) asks
such a client for more: the first call is refused with that warning and switches nothing off, even with
`confirmed_by_user`; the form goes off only on a call with both `confirmed_by_user: true` and
`warning_shown_to_user: true`, set after the user saw the warning. A personal-data disclosure grant (`request_pii_grant`) is the
exception: it is issued only after a person confirms it in the client, and a client without elicitation is
refused.

A development store can skip the questions with `"confirmActions": false` in its credentials file; the server
refuses to load that for any host other than localhost, `*.local`, `*.test` or `*.localhost`, says so in its
startup log, and `list_sites` shows `confirm_actions: false` for that store. The store's own confirmations and
the two-step `confirmation_id` still apply. A confirmed call whose answer was lost can be repeated with the same
`confirmation_id`: it goes out under the same request id, and the person, who approved that very call, is not asked
again. A `confirmation_id` answers for the arguments of the
call it was first used with; the same id with other arguments is refused. Every mutation carries a `request_id` from the journal,
so retries and crashes replay on the server instead of re-executing.

Sites: `list_sites`, `use_site`.

Resources are per store: `webforms://{site}/schema/field-types`, `webforms://{site}/schema/document`,
`webforms://{site}/guide/field-types`, `webforms://{site}/form/{id}/document`. A dedicated process also
answers the un-prefixed URIs it always did.

Submission values and other visitor-typed text are returned as separate content blocks marked
untrusted (provenance `remote`, length-capped). So are the store's warnings about an import, a created
or duplicated form, or a draft whose document was replaced: the answer itself says only how many there are (`warning_count`). Personal data is masked server-side; disclosure
grants are not requested by the read-only tools. The text of submission notes, attachment file names and the
values a submission command answers with come the same way.

## Development

From a clone: `npm install && npm run build`, then use `node dist/start.js` wherever the commands above
say `npx -y @mageme/webforms-mcp@1`; `setup` run from a clone prints the registration with that path (hints in error messages
still name the npx command). A dev store
with a self-signed certificate on a host other than `localhost`, `*.local`, `*.test` or `*.localhost`
needs `WEBFORMS_MCP_ALLOW_INSECURE_TLS=1` for the tests below too.

```
npm test                                   # unit + contract tests against a mock built from test/fixtures/openapi.json
WEBFORMS_FILTER_AST=<WebForms module>/Model/Service/Submission/FilterAst.php npm test -- test/field-filter.test.ts   # filter operators against the module's own list
cp <WebForms module>/etc/acl.xml test/fixtures/acl.xml && npm test -- test/route-acl-errors.test.ts   # permission titles against the module's ACL, after it changes
WEBFORMS_MCP_E2E=1 WEBFORMS_MCP_CREDENTIALS_FILE=~/.webforms-mcp/credentials.<profile>.json npm test -- test/harness.test.ts test/e2e.test.ts test/load.test.ts   # against a dev store
WEBFORMS_MCP_E2E=1 WEBFORMS_MCP_E2E_PROFILES=<profile> npm test -- test/shared.test.ts   # shared process over that profile and a local stand-in store
```

The store tests write only into a form of their own (`mcp-e2e-<run id>`), switch it off at the end and print the
ids they leave behind (`E2E-LEFT ...`; `WEBFORMS_MCP_E2E_LEFTOVERS=<file>` collects them), because the API cannot delete.
Optional: `WEBFORMS_MCP_E2E_ORDER` (an existing order number to link), `WEBFORMS_MCP_E2E_CONCURRENCY` (parallel requests in
load.test.ts, default 5). Without `WEBFORMS_MCP_CREDENTIALS_FILE` or `WEBFORMS_MCP_E2E_PROFILES` those tests are skipped.

The journal (`~/.webforms-mcp/journal.jsonl`) records `operation, request_id, keyed hash of the
arguments, state` for mutations so a crashed call is retried with the same request id — never payloads.
It also keeps keyed hashes of the values a call sets and of an agent's `idempotency_key`, never the values
or the key. Server processes that share the journal take turns through a lock file beside it, which is taken over
only from a process on the same machine that has exited. The journal belongs to one machine: do not share
`~/.webforms-mcp` between machines over a network folder, nor mount it as a volume into containers that have
different hostnames or that share a hostname but not their process ids; there a lock left by a crashed server is
never taken over and has to be deleted by hand. Past 8 MiB it is
compacted to the requests still pending or undecided, the keys inside their 30 days and the last ten minutes.
Creation tools take an optional `idempotency_key` (for 30 days the same key creates nothing again: it
repeats the first call's answer while the store keeps it, later answers not_created; a new key makes another copy;
a key whose first send the store refused as invalid or not permitted is free again, except for exports) and answer with `idempotency.outcome`: created, retried, replayed or not_created.
