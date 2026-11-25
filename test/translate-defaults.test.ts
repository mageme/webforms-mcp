import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { buildGuide } from '../src/guide.js';

/**
 * A translatable text left empty is not blank on the storefront: the store shows its own default phrase there
 * (a File field's dropzone reads "Add files or drop here"). An agent translating a form reads null for such a key,
 * so what it is given to read has to tell it that the key still carries visible text for the store view.
 */
const catalog = {
  field_types: {
    file: { settings: { is_dropzone: { type: 'boolean' }, dropzone_text: { type: 'string', translatable: true } } },
  },
};

const mentionsEmptyDefaults = (text: string): boolean =>
  /(empty|null|blank|left out)[^.]*(default|storefront)[^.]*(store view|translat)/i.test(text)
  || /(default|storefront)[^.]*(empty|null|blank)[^.]*(store view|translat)/i.test(text);

let setTranslations = '';

beforeAll(async () => {
  const server = buildServer({ baseUrl: 'http://127.0.0.1:9', consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', insecureTls: false, journalKey: 'k' }, () => undefined, join(mkdtempSync(join(tmpdir(), 'wfmcp-')), 'journal.jsonl'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'translate-defaults-test', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  setTranslations = tools.find((t) => t.name === 'draft_set_translations')?.description ?? '';
});

describe('a translatable text left empty shows a default on the storefront', () => {
  it('the guide or draft_set_translations tells the agent to set it for the store view', () => {
    expect(setTranslations).not.toBe('');
    const guide = buildGuide(catalog);
    expect(mentionsEmptyDefaults(guide) || mentionsEmptyDefaults(setTranslations)).toBe(true);
  });
});
