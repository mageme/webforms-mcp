import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The shared process over two stores: the store the profile names in WEBFORMS_MCP_E2E_PROFILES (comma
 * separated; the first is the one that is read) and a local stand-in that counts every request it gets.
 * Both stores are served, identifiers carry the store that issued them, and an identifier from one store is
 * refused against the other. Without WEBFORMS_MCP_E2E_PROFILES the test is skipped: it never reads
 * "all profiles" of a machine. The process gets a home directory of its own that holds copies of the named
 * profiles only, so no other store of the machine can be reached.
 */
const profiles = (process.env.WEBFORMS_MCP_E2E_PROFILES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
const enabled = process.env.WEBFORMS_MCP_E2E === '1' && profiles.length > 0;
const STUB = 'e2e-stub';

describe.skipIf(!enabled)('a shared process over two stores', () => {
  let home = '';
  let stub: Server;
  let stubHits = 0;
  let client: Client;

  beforeAll(async () => {
    expect(profiles, 'the stand-in keeps its own key').not.toContain(STUB);
    stub = createServer((req, res) => {
      stubHits++;
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"stand-in"}');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;

    home = mkdtempSync(join(tmpdir(), 'webforms-mcp-shared-'));
    const source = process.env.WEBFORMS_MCP_HOME ?? join(homedir(), '.webforms-mcp');
    for (const name of profiles) copyFileSync(join(source, `credentials.${name}.json`), join(home, `credentials.${name}.json`));
    writeFileSync(join(home, `credentials.${STUB}.json`), JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}`,
      consumerKey: 'stub', consumerSecret: 'stub', accessToken: 'stub', accessTokenSecret: 'stub',
      journalKey: 'c3R1Yi1qb3VybmFsLWtleS1zdHViLWpvdXJuYWwta2V5',
    }), { mode: 0o600 });

    const env = { ...process.env, WEBFORMS_MCP_HOME: home } as Record<string, string>;
    delete env.WEBFORMS_MCP_CREDENTIALS_FILE;
    delete env.WEBFORMS_MCP_PROFILE;
    client = new Client({ name: 'e2e-shared', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], env, stderr: 'pipe' }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('serves both stores, qualifies what it hands out, and refuses a stranger id without a request to either', async () => {
    const primary = profiles[0];
    const sites = (await client.callTool({ name: 'list_sites', arguments: {} })).structuredContent as any;
    expect(sites.mode).toBe('shared');
    const keys = sites.sites.map((s: any) => s.key);
    expect(keys.sort()).toEqual([...profiles, STUB].sort());

    // Nothing selects a store yet, so a call that names none is refused rather than guessed at.
    const guessed = await client.callTool({ name: 'list_forms', arguments: { page_size: 1 } });
    expect(guessed.isError).toBe(true);
    expect(JSON.stringify(guessed.content)).toMatch(/SITE_REQUIRED/);

    const listed = (await client.callTool({ name: 'list_forms', arguments: { site: primary, page_size: 1 } })).structuredContent as any;
    const id = listed.items[0].id as string;
    expect(id, 'a shared process hands out identifiers carrying their store').toMatch(new RegExp(`^${primary}:\\d+$`));

    // The stand-in counts: a request that does reach it is seen, so an unchanged count below means something.
    const reached = stubHits;
    await client.callTool({ name: 'get_capabilities', arguments: { site: STUB } });
    expect(stubHits, 'a read addressed at the stand-in reaches it').toBeGreaterThan(reached);

    // From here on every refusal is decided before a request is made: the stand-in must see none.
    const hitsBefore = stubHits;

    // The same identifier addressed at the other store is refused, not quietly applied to its own 42.
    const crossed = await client.callTool({ name: 'get_form', arguments: { site: STUB, form_id: id } });
    expect(crossed.isError).toBe(true);
    expect(JSON.stringify(crossed.content)).toMatch(/SITE_HANDLE_MISMATCH/);

    // A bare number is refused too: it says nothing about where it belongs.
    const bare = await client.callTool({ name: 'get_form', arguments: { site: STUB, form_id: 1 } });
    expect(bare.isError).toBe(true);
    expect(JSON.stringify(bare.content)).toMatch(/HANDLE_UNQUALIFIED/);

    // After selecting a store, a write that names a different one is refused rather than guessed at.
    // The form id does not exist anywhere: nothing is at stake even if the refusal were missing.
    await client.callTool({ name: 'use_site', arguments: { site: primary } });
    const conflict = await client.callTool({ name: 'deactivate_form', arguments: { site: STUB, form_id: `${STUB}:999999999`, confirmed_by_user: true } });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toMatch(/SITE_CONFLICT/);
    expect(stubHits, 'a refusal made before any request').toBe(hitsBefore);

    // With one selected, the argument can be dropped and the answer still says where it came from.
    const implicit = await client.callTool({ name: 'get_capabilities', arguments: {} });
    expect((implicit.structuredContent as any)._site.key).toBe(primary);
  }, 60_000);
});
