import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { MANIFEST, specOf, type HandlePath } from '../src/manifest.js';

/**
 * The tools a built server actually offers. Checking the manifest against itself would never notice a
 * tool nobody declared, so the list comes from the server over a real client connection.
 */
const registeredNames = async (): Promise<string[]> => {
  const server = buildServer(
    { baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', insecureTls: false, journalKey: 'jk' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-manifest-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'manifest-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return (await client.listTools()).tools.map((t) => t.name);
};

/** Tools that create an entity out of nothing, so they carry no incoming handle to bind to a site. */
const CREATES_FROM_NOTHING = new Set(['create_form', 'create_form_from_template', 'update_appearance']);

const PATH_SHAPE = /^[a-z_]+(\[\])?(\.[a-z_]+(\[\])?)*$/;

describe('manifest', () => {
  it('covers every registered tool and invents none', async () => {
    const registered = (await registeredNames()).sort();
    expect(Object.keys(MANIFEST).sort()).toEqual(registered);
  });

  it('keeps the two site tools out of ordinary resolution', () => {
    const byClass = (c: string) => Object.values(MANIFEST).filter((s) => s.dispatchClass === c).map((s) => s.name);
    expect(byClass('site-neutral')).toEqual(['list_sites']);
    expect(byClass('site-selection')).toEqual(['use_site']);
  });

  it('splits reads from mutations the way the tool modules do', () => {
    const specs = Object.values(MANIFEST).filter((s) => s.dispatchClass === 'site-bound');
    expect(specs.filter((s) => s.isMutation).length + specs.filter((s) => !s.isMutation).length).toBe(specs.length);
    expect(MANIFEST.get_form.isMutation).toBe(false);
    expect(MANIFEST.draft_validate.isMutation).toBe(false);
    expect(MANIFEST.get_submission_full.isMutation).toBe(false);
    expect(MANIFEST.draft_publish.isMutation).toBe(true);
    expect(MANIFEST.mass_read.isMutation).toBe(true);
  });

  it('gives every mutation an incoming handle to bind to a site', () => {
    for (const spec of Object.values(MANIFEST)) {
      if (!spec.isMutation || CREATES_FROM_NOTHING.has(spec.name)) continue;
      expect(spec.handlesIn.length, `${spec.name} declares no input handle`).toBeGreaterThan(0);
    }
  });

  it('writes every handle path in a shape the walker can follow', () => {
    const all: HandlePath[] = Object.values(MANIFEST).flatMap((s) => [...s.handlesIn, ...s.handlesOut]);
    expect(all.length).toBeGreaterThan(0);
    for (const h of all) {
      expect(h.path, `${h.path} is not a walkable path`).toMatch(PATH_SHAPE);
    }
  });

  it('refuses to answer for a tool nobody declared', () => {
    expect(() => specOf('no_such_tool')).toThrow(/No manifest entry/);
  });
});
