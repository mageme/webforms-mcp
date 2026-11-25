import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResources } from '../src/resources.js';
import { SiteContextFactory } from '../src/context.js';
import { SiteRegistry } from '../src/registry.js';
import type { Config } from '../src/config.js';
import type { RuntimeMode } from '../src/mode.js';

const config = (key: string): Config => ({
  baseUrl: `https://${key}.example`,
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
  insecureTls: false,
  journalKey: 'jk',
});

const harness = async (keys: string[], mode: RuntimeMode['kind']) => {
  const registry = SiteRegistry.fromConfigs(Object.fromEntries(keys.map((k) => [k, config(k)])));
  const factory = new SiteContextFactory(registry, mode, () => undefined);
  const server = new McpServer({ name: 'test', version: '0' });
  registerResources(server, factory);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'resources-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, factory, registry };
};

const uris = async (client: Client): Promise<string[]> =>
  (await client.listResources()).resources.map((r) => r.uri).sort();

describe('resources are per site', () => {
  it('gives every store its own set of URIs', async () => {
    const { client } = await harness(['acme', 'globex'], 'shared');
    const list = await uris(client);
    expect(list).toContain('webforms://acme/schema/document');
    expect(list).toContain('webforms://globex/schema/document');
    expect(list).toContain('webforms://acme/schema/field-types');
    expect(list).toContain('webforms://globex/guide/field-types');
  });

  it('does not offer the un-prefixed URIs in a shared process', async () => {
    const { client } = await harness(['acme', 'globex'], 'shared');
    expect(await uris(client)).not.toContain('webforms://schema/document');
  });

  it('keeps the un-prefixed URIs in a dedicated process, for what already reads them', async () => {
    const { client } = await harness(['only'], 'dedicated');
    const list = await uris(client);
    expect(list).toContain('webforms://schema/document');
    expect(list).toContain('webforms://only/schema/document');
  });

  it('reads a store through that store, not through whichever was registered first', async () => {
    const { client, factory, registry } = await harness(['acme', 'globex'], 'shared');
    const acme = vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue({ schema_json: '{"from":"acme"}' });
    const globex = vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockResolvedValue({ schema_json: '{"from":"globex"}' });
    const res = await client.readResource({ uri: 'webforms://globex/schema/document' });
    expect(JSON.parse(res.contents[0].text as string)).toEqual({ from: 'globex' });
    expect(globex).toHaveBeenCalledTimes(1);
    expect(acme).not.toHaveBeenCalled();
  });

  it('takes an id in the form the tools hand out, and refuses another store\'s', async () => {
    const { client, factory, registry } = await harness(['acme', 'globex'], 'shared');
    vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockResolvedValue({ document_json: '{"id":42}' });
    const res = await client.readResource({ uri: 'webforms://globex/form/globex:42/document' });
    expect(JSON.parse(res.contents[0].text as string)).toEqual({ id: 42 });
    await expect(client.readResource({ uri: 'webforms://globex/form/acme:42/document' })).rejects.toThrow(/belongs to "acme"/);
  });

  it('reads one form document from the store its URI names', async () => {
    const { client, factory, registry } = await harness(['acme', 'globex'], 'shared');
    const globex = vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockResolvedValue({ document_json: '{"id":42}' });
    const res = await client.readResource({ uri: 'webforms://globex/form/42/document' });
    expect(JSON.parse(res.contents[0].text as string)).toEqual({ id: 42 });
    expect(globex).toHaveBeenCalledWith('/V1/webforms/forms/42/document');
  });
});
