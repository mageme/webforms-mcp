## 1.0.0

+ New: first public release, installed with `npx -y @mageme/webforms-mcp@1`; works with WebForms 4.x and its Management API
+ New: forms: list, read, create from scratch or from a template, duplicate, and switch a live form on or off
+ New: drafts: open, edit sections, fields, logic and translations, validate, publish after a preview, discard, and restore an earlier version
+ New: notifications: add, edit, duplicate, remove, switch on and off, set their conditions and content
+ New: the store-wide appearance every form inherits, and import of historical submissions from a file, validated before anything is written
+ New: submissions: search, read, edit values, set status and approval, assign, mark, add notes, link to orders, reply after a preview, export
+ New: several stores served by one process, each tool taking a store argument; a store can also run in its own process
+ New: personal data in submissions is masked by the store; full values only through a time-limited disclosure grant or the Disclose Personal Data permission
+ New: irreversible actions ask the person through the host when it supports it, and every change is journalled so a retried call never runs twice
+ New: `setup` probes the store before saving the connection and prints the exact Claude Code and Claude Desktop registration
