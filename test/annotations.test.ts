import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { MANIFEST } from '../src/manifest.js';

const listed = async () => {
  const server = buildServer(
    { baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', insecureTls: false, journalKey: 'jk' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-annotations-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotations-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return (await client.listTools()).tools;
};

describe('tool annotations', () => {
  it('gives every tool all four hints', async () => {
    for (const tool of await listed()) {
      const a = tool.annotations ?? {};
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof a[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(a.title, `${tool.name} title`).toBe(tool.title);
    }
  });

  it('never calls a writing tool read-only', async () => {
    for (const tool of await listed()) {
      if (MANIFEST[tool.name].isMutation) expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
    }
  });

  it('does not call read-only what spends a grant or moves the session', async () => {
    const tools = Object.fromEntries((await listed()).map((t) => [t.name, t]));
    expect(tools.get_submission_full.annotations?.readOnlyHint).toBe(false);
    expect(tools.use_site.annotations?.readOnlyHint).toBe(false);
    expect(tools.list_submission_notes.annotations?.readOnlyHint).toBe(false);
    expect(tools.list_submission_attachments.annotations?.readOnlyHint).toBe(false);
    expect(tools.get_form.annotations?.readOnlyHint).toBe(true);
    expect(tools.get_form.annotations?.destructiveHint).toBe(false);
  });

  it('does not call read-only or idempotent any tool that takes a disclosure grant', async () => {
    const tools = Object.fromEntries((await listed()).map((t) => [t.name, t]));
    const takingGrant = Object.values(MANIFEST).filter((spec) => spec.handlesIn.some((h) => h.kind === 'grant')).map((spec) => spec.name);
    expect(takingGrant).toContain('search_submissions');
    for (const name of takingGrant) {
      expect(tools[name].annotations?.readOnlyHint, name).toBe(false);
      if (!MANIFEST[name].isMutation) expect(tools[name].annotations?.idempotentHint, name).toBe(false);
    }
  });

  it('marks what removes or overwrites as destructive, and what sends mail as reaching outside the store', async () => {
    const tools = Object.fromEntries((await listed()).map((t) => [t.name, t]));
    for (const name of ['draft_discard', 'draft_remove_field', 'remove_notification', 'draft_publish', 'update_submission_values']) {
      expect(tools[name].annotations?.destructiveHint, name).toBe(true);
    }
    for (const name of ['create_form', 'add_submission_note', 'open_draft']) {
      expect(tools[name].annotations?.destructiveHint, name).toBe(false);
    }
    expect(tools.send_reply.annotations?.openWorldHint).toBe(true);
    expect(tools.send_reply.annotations?.idempotentHint).toBe(false);
    expect(tools.set_submission_status.annotations?.idempotentHint).toBe(true);
    expect(Object.values(tools).filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort()).toEqual(['mass_status', 'send_reply', 'set_submission_approval', 'set_submission_status']);
  });
});
