import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { importRoot } from '../src/import.js';

/** The import directory lives in the server's own directory unless the operator names another. */
const KEYS = ['WEBFORMS_MCP_IMPORT_ROOT', 'WEBFORMS_MCP_HOME'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('importRoot', () => {
  it('follows WEBFORMS_MCP_HOME', () => {
    delete process.env.WEBFORMS_MCP_IMPORT_ROOT;
    process.env.WEBFORMS_MCP_HOME = '/srv/wfmcp';
    expect(importRoot()).toBe(resolve('/srv/wfmcp/import'));
  });

  it('WEBFORMS_MCP_IMPORT_ROOT wins over WEBFORMS_MCP_HOME', () => {
    process.env.WEBFORMS_MCP_IMPORT_ROOT = '/data/inbox';
    process.env.WEBFORMS_MCP_HOME = '/srv/wfmcp';
    expect(importRoot()).toBe(resolve('/data/inbox'));
  });

  it('without either it stays under ~/.webforms-mcp', () => {
    for (const k of KEYS) delete process.env[k];
    expect(importRoot()).toBe(resolve(join(homedir(), '.webforms-mcp', 'import')));
  });
});
