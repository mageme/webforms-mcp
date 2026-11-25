import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/** A description is an instruction to the model: it must not send it to an argument or a mode that does not exist. */
const tools = async () => {
  const server = buildServer({ baseUrl: 'https://store.example', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'descriptions', version: '0' });
  await client.connect(b);
  const { tools: list } = await client.listTools();
  await client.close();
  return list;
};

describe('tool descriptions promise only what exists', () => {
  it('every argument a description tells the model to pass is in that tool\'s schema', async () => {
    const wrong: string[] = [];
    for (const tool of await tools()) {
      const args = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const named of ['confirmed_by_user', 'confirmation_id', 'confirmed_digest', 'grant_id', 'projection', 'warning_shown_to_user']) {
        if (new RegExp(`pass(ing)? ${named}\\b`).test(tool.description ?? '') && !args.includes(named)) wrong.push(`${tool.name}: ${named}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('names the tools that really take a grant, and no mode the server lacks', async () => {
    const list = await tools();
    const text = (name: string) => list.find((t) => t.name === name)?.description ?? '';
    expect(text('request_pii_grant')).not.toMatch(/projection/);
    expect(text('request_pii_grant')).toMatch(/search_submissions/);
    expect(text('request_pii_grant')).toMatch(/get_submission_full/);
    expect(text('search_submissions')).not.toMatch(/read-only mode/);
    expect(text('prepare_import')).not.toMatch(/Irreversible|without writing anything/);
    expect(text('get_form_stats')).not.toMatch(/by status/);
    expect(text('set_confirmation_content')).toMatch(/redirect_url, which draft_update_form changes once a person approves it/);
  });

  it('the tools that write form texts say which directives need no permission and what needs Edit Form Scripts (C26)', async () => {
    const list = await tools();
    for (const name of ['create_form', 'draft_update_form', 'draft_replace_document', 'draft_set_translations']) {
      const d = list.find((t) => t.name === name)?.description ?? '';
      expect(d, name).toMatch(/description, success_text and below_text.*\{\{var\}\}.*\{\{if\}\}.*\{\{else\}\}.*\{\{depend\}\}.*\{\{trans\}\}.*without the Edit Form Scripts permission.*any other directive.*script.*need/s);
    }
  });

  it('get_form says what has_executable_markup means', async () => {
    const list = await tools();
    expect(list.find((t) => t.name === 'get_form')?.description ?? '').toMatch(/has_executable_markup.*Edit Form Scripts/s);
    expect(list.find((t) => t.name === 'list_forms')?.description ?? '').toMatch(/has_executable_markup is not in this list; read it with get_form/);
    for (const name of ['activate_form', 'duplicate_form']) expect(list.find((t) => t.name === name)?.description ?? '', name).toMatch(/has_executable_markup.*Edit Form Scripts.*ACTOR_NOT_ALLOWED/s);
  });

  it('publishing and switching on a field or section say when Edit Form Scripts is needed (C29, C30)', async () => {
    const list = await tools();
    const text = (name: string) => list.find((t) => t.name === name)?.description ?? '';
    expect(text('draft_publish')).toMatch(/Edit Form Scripts.*brings in or changes markup that runs code.*ACTOR_NOT_ALLOWED.*nothing is published.*leaves as it was/s);
    for (const name of ['draft_update_field', 'draft_update_section', 'draft_replace_document', 'restore_version', 'draft_publish', 'draft_restore_field', 'draft_reorder', 'draft_turn_field_into']) {
      expect(text(name), name).toMatch(/switched off runs nothing.*switching (it|one) on.*Edit Form Scripts.*ACTOR_NOT_ALLOWED/s);
    }
    for (const name of ['get_form', 'deactivate_form']) expect(text(name), name).toMatch(/switched-on HTML field in a switched-on section/);
  });

  it('deactivate_form warns that a form with executable markup does not come back on through the API without Edit Form Scripts', async () => {
    const list = await tools();
    const text = (name: string) => list.find((t) => t.name === name)?.description ?? '';
    expect(text('deactivate_form')).toMatch(/markup that runs code on the storefront.*switched off by an integration without the Edit Form Scripts permission, but not back on.*admin/s);
  });
});
