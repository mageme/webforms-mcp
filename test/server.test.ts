import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const config: Config = {
  baseUrl: 'https://stage.example',
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
  insecureTls: false,
  journalKey: 'jk',
  label: 'Acme Stage',
};

const connect = async (siteKey?: string) => {
  const server = buildServer(config, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-srv-')), 'journal.jsonl'), siteKey);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
};

const text = (res: unknown): string => ((res as { content: { text: string }[] }).content[0]?.text ?? '');

describe('buildServer site identity', () => {
  it('stamps the profile it was actually started with, not "default"', async () => {
    const client = await connect('stage');
    const res = await client.callTool({ name: 'get_form', arguments: { form_id: 1 } });
    // The store is unreachable here, so the call fails - but it fails having resolved to the right site.
    expect(text(res)).toMatch(/stage\.example/);
  });

  it('accepts that profile by name and refuses another', async () => {
    const client = await connect('stage');
    const wrong = await client.callTool({ name: 'get_form', arguments: { site: 'default', form_id: 1 } });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toMatch(/SITE_UNKNOWN/);
    expect(text(wrong)).toMatch(/stage \(stage\.example\)/);
  });

  it('names the store in the approval a confirmable tool demands', async () => {
    const client = await connect('stage');
    const res = await client.callTool({ name: 'activate_form', arguments: { form_id: 1 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Acme Stage \(stage\.example\)/);
    expect(text(res)).toMatch(/confirmed_by_user/);
    // stamped once, not once per layer
    expect(text(res).match(/Acme Stage/g)).toHaveLength(1);
  });

  it('falls back to the default key when none is given', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'get_form', arguments: { site: 'default', form_id: 1 } });
    expect(text(res)).not.toMatch(/SITE_UNKNOWN/);
  });
});
