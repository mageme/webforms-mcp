import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSiteTools } from '../src/tools/sites.js';
import { registerReadTools } from '../src/tools/read.js';
import { SiteContextFactory } from '../src/context.js';
import { SiteRegistry, type Diagnostic } from '../src/registry.js';
import type { Config } from '../src/config.js';

const config = (key: string, label?: string): Config => ({
  baseUrl: `https://${key}.example`,
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
  insecureTls: false,
  journalKey: 'jk',
  label,
});

/** A registry with the parts discovery would have filled in, so the tools can be driven directly. */
const registryWith = (keys: string[], extra: { isolated?: string[]; diagnostics?: Diagnostic[] } = {}): SiteRegistry => {
  const base = SiteRegistry.fromConfigs(Object.fromEntries(keys.map((k) => [k, config(k, k === 'acme' ? 'Acme' : undefined)])));
  return Object.create(base, {
    isolatedKeys: { value: extra.isolated ?? [] },
    diagnostics: { value: extra.diagnostics ?? [] },
    complete: { value: (extra.diagnostics ?? []).length === 0 },
  }) as SiteRegistry;
};

const harness = async (registry: SiteRegistry) => {
  const factory = new SiteContextFactory(registry, 'shared', () => undefined);
  const server = new McpServer({ name: 'test', version: '0' });
  registerSiteTools(server, factory);
  registerReadTools(server, factory);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sites-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, factory };
};

const caps = { api_version: '1.4', document_schema_version: '2', field_types: [] };
const structured = (res: unknown) => (res as { structuredContent: Record<string, never> }).structuredContent;
const text = (res: unknown): string => ((res as { content: { text: string }[] }).content[0]?.text ?? '');

describe('list_sites', () => {
  it('answers from the roster without touching the network', async () => {
    const registry = registryWith(['acme', 'globex']);
    const { client, factory } = await harness(registry);
    const spy = vi.spyOn(factory.for(registry.get('acme')!).api, 'get');
    const res = structured(await client.callTool({ name: 'list_sites', arguments: {} }));
    expect((res.sites as { key: string }[]).map((s) => s.key)).toEqual(['acme', 'globex']);
    expect(res.mode).toBe('shared');
    expect(spy).not.toHaveBeenCalled();
  });

  it('carries the label and marks the active store', async () => {
    const { client, factory } = await harness(registryWith(['acme', 'globex']));
    factory.beginSwitch('globex').commit();
    const res = structured(await client.callTool({ name: 'list_sites', arguments: {} }));
    const sites = res.sites as { key: string; label: string; host: string; active: boolean }[];
    expect(sites[0]).toMatchObject({ key: 'acme', label: 'Acme', host: 'acme.example', active: false });
    expect(sites[1]).toMatchObject({ key: 'globex', label: 'globex.example', active: true });
  });

  it('reports isolated keys, diagnostics and an incomplete roster', async () => {
    const registry = registryWith(['acme'], { isolated: ['big'], diagnostics: [{ file: 'credentials.old.json', reason: 'INVALID' }] });
    const { client } = await harness(registry);
    const res = structured(await client.callTool({ name: 'list_sites', arguments: {} }));
    expect(res.isolated).toEqual([{ key: 'big', note: expect.stringContaining('--profile big') }]);
    expect(res.diagnostics).toEqual([{ file: 'credentials.old.json', reason: 'INVALID' }]);
    expect(res.roster_complete).toBe(false);
  });

  it('keeps a probe failure inside the store it belongs to', async () => {
    const registry = registryWith(['acme', 'globex']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue(caps);
    vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockRejectedValue(new Error('store is down'));
    const res = structured(await client.callTool({ name: 'list_sites', arguments: { probe: true } }));
    const sites = res.sites as { key: string; api_version?: string; error?: string }[];
    expect(sites[0]).toMatchObject({ key: 'acme', api_version: '1.4' });
    expect(sites[1].error).toMatch(/store is down/);
    expect(sites[1].api_version).toBeUndefined();
  });

  it('reports the form access each probed store grants', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue({ ...caps, features_json: JSON.stringify({ form_scope: 'selected' }) });
    const res = structured(await client.callTool({ name: 'list_sites', arguments: { probe: true } }));
    expect((res.sites as Record<string, unknown>[])[0]).toMatchObject({ key: 'acme', form_access: 'Selected forms' });
  });

  it('asks the store afresh on a probe, so a changed scope is not hidden by the cache', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    const ctx = factory.for(registry.get('acme')!);
    const get = vi.spyOn(ctx.api, 'get').mockResolvedValue({ ...caps, features_json: JSON.stringify({ form_scope: 'all' }) });
    await ctx.capabilities();
    get.mockResolvedValue({ ...caps, features_json: JSON.stringify({ form_scope: 'none' }) });
    const res = structured(await client.callTool({ name: 'list_sites', arguments: { probe: true } }));
    expect((res.sites as Record<string, unknown>[])[0].form_access).toBe('No forms');
  });

  it('reports form access as null for a store older than the scope', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue({ ...caps, features_json: JSON.stringify({ pii_grants: true }) });
    const res = structured(await client.callTool({ name: 'list_sites', arguments: { probe: true } }));
    expect((res.sites as Record<string, unknown>[])[0]).toMatchObject({ key: 'acme', form_access: null });
  });
});

describe('get_capabilities', () => {
  it('adds the form access label next to the expanded features', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue({ ...caps, features_json: JSON.stringify({ form_scope: 'all' }) });
    const res = structured(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    expect(res).toMatchObject({ api_version: '1.4', features: { form_scope: 'all' }, form_access: 'All Forms' });
  });

  it('gives null form access for an older store', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue(caps);
    expect(structured(await client.callTool({ name: 'get_capabilities', arguments: {} })).form_access).toBeNull();
  });
});

describe('use_site', () => {
  it('reports that nothing is selected yet', async () => {
    const { client } = await harness(registryWith(['acme', 'globex']));
    expect(structured(await client.callTool({ name: 'use_site', arguments: {} })).active).toBe(null);
  });

  it('switches, reports the store, and admits it as active', async () => {
    const registry = registryWith(['acme', 'globex']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockResolvedValue(caps);
    const res = structured(await client.callTool({ name: 'use_site', arguments: { site: 'globex' } }));
    expect(res).toMatchObject({ key: 'globex', host: 'globex.example', api_version: '1.4', active: 'globex' });
    expect(factory.activeKey()).toBe('globex');
  });

  it('accepts an unambiguous host as the name of the store', async () => {
    const registry = registryWith(['acme', 'globex']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue(caps);
    await client.callTool({ name: 'use_site', arguments: { site: 'acme.example' } });
    expect(factory.activeKey()).toBe('acme');
  });

  it('leaves the selection alone when the store cannot be reached', async () => {
    const registry = registryWith(['acme', 'globex']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue(caps);
    vi.spyOn(factory.for(registry.get('globex')!).api, 'get').mockRejectedValue(new Error('unreachable'));
    await client.callTool({ name: 'use_site', arguments: { site: 'acme' } });
    const res = await client.callTool({ name: 'use_site', arguments: { site: 'globex' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unreachable/);
    expect(text(res)).toMatch(/unchanged/);
    expect(factory.activeKey()).toBe('acme');
  });

  it('explains how to reach an isolated store instead of pretending it is unknown', async () => {
    const { client } = await harness(registryWith(['acme'], { isolated: ['big'] }));
    const res = await client.callTool({ name: 'use_site', arguments: { site: 'big' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/SITE_ISOLATED/);
    expect(text(res)).toMatch(/--profile big/);
  });

  it('lists the stores when asked for one that does not exist', async () => {
    const { client } = await harness(registryWith(['acme', 'globex']));
    const res = await client.callTool({ name: 'use_site', arguments: { site: 'nope' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/acme \(acme\.example\)/);
  });

  it('takes no site argument as a question, not as a request to clear the selection', async () => {
    const registry = registryWith(['acme']);
    const { client, factory } = await harness(registry);
    vi.spyOn(factory.for(registry.get('acme')!).api, 'get').mockResolvedValue(caps);
    await client.callTool({ name: 'use_site', arguments: { site: 'acme' } });
    const res = structured(await client.callTool({ name: 'use_site', arguments: {} }));
    expect(res).toMatchObject({ active: 'acme', host: 'acme.example' });
    expect(factory.activeKey()).toBe('acme');
  });
});
