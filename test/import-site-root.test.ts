import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeImportFile, openImportFile } from '../src/import.js';

const saved = process.env.WEBFORMS_MCP_IMPORT_ROOT;
afterEach(() => {
  if (saved === undefined) delete process.env.WEBFORMS_MCP_IMPORT_ROOT;
  else process.env.WEBFORMS_MCP_IMPORT_ROOT = saved;
});

const stage = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'wfmcp-site-root-'));
  mkdirSync(join(root, 'acme'));
  process.env.WEBFORMS_MCP_IMPORT_ROOT = root;
  return root;
};

describe('a store\'s own import directory', () => {
  it('names what is wrong with the file found there instead of looking for it in the shared root', async () => {
    const root = stage();
    writeFileSync(join(root, 'acme', 'empty.jsonl'), '');
    await expect(openImportFile('empty.jsonl', 'acme')).rejects.toThrow(`${join(root, 'acme', 'empty.jsonl')} is empty.`);
  });

  it('still falls back to the shared root when the store has no such file', async () => {
    const root = stage();
    writeFileSync(join(root, 'rows.jsonl'), '{"a":1}\n');
    const file = await openImportFile('rows.jsonl', 'acme');
    expect(file.size).toBe(8);
    await closeImportFile(file);
  });
});
