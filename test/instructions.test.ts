import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

const connect = async () => {
  const server = buildServer(
    { baseUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', insecureTls: false, journalKey: 'jk' },
    () => undefined,
    join(mkdtempSync(join(tmpdir(), 'wfmcp-instructions-')), 'journal.jsonl'),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'instructions-test', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
};

describe('server instructions', () => {
  it('names every confirmation argument a tool takes, and none that no tool takes', async () => {
    const client = await connect();
    const text = client.getInstructions() ?? '';
    const taken = new Set<string>();
    for (const tool of (await client.listTools()).tools) {
      for (const arg of Object.keys(tool.inputSchema.properties ?? {})) {
        if (/^confirm(ation_id|ed_)|_shown_to_user$/.test(arg)) taken.add(arg);
      }
    }
    expect([...taken].sort()).toEqual(['confirmation_id', 'confirmed_by_user', 'confirmed_digest', 'warning_shown_to_user']);
    for (const arg of taken) expect(text, arg).toContain(`${arg}`);
    expect(text).toContain('four arguments');
  });
});
