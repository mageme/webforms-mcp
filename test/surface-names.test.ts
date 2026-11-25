import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

/** The names 1.x freezes: one word for one thing, as agreed before 1.0 (sections, field_id, logic_id, the activate pair, list_*). */
const listTools = async () => {
  const server = buildServer({ baseUrl: 'https://store.example', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'surface', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
};
const props = (t: { inputSchema: unknown }) => Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});

describe('the tool surface uses one name per thing', () => {
  it('has the renamed tools and none of the old names', async () => {
    const names = (await listTools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_form_versions', 'activate_form', 'deactivate_form']));
    expect(names).not.toContain('get_form_versions');
  });

  it('arguments say section, field_id and logic_id', async () => {
    const tools = await listTools();
    const of = (n: string) => props(tools.find((t) => t.name === n)!);
    for (const n of ['draft_update_field', 'draft_turn_field_into', 'draft_duplicate_field', 'draft_remove_field']) {
      expect(of(n)).toContain('field_id');
      expect(of(n)).not.toContain('field');
    }
    expect(of('draft_add_field')).toContain('after_field_id');
    expect(of('draft_remove_logic')).toEqual(expect.arrayContaining(['logic_id']));
    expect(of('draft_remove_logic')).not.toContain('rule');
    expect(of('activate_form')).not.toContain('active');
    const reorder = JSON.stringify(tools.find((t) => t.name === 'draft_reorder')!.inputSchema);
    expect(reorder).toContain('"sections"');
    expect(reorder).toContain('"section_id"');
    expect(reorder).not.toMatch(/fieldset/);
    const schema = JSON.stringify(tools.find((t) => t.name === 'get_schema')!.inputSchema);
    expect(schema).toContain('"section"');
    expect(schema).not.toContain('"fieldset"');
  });
});
