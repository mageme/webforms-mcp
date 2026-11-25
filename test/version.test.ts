import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/server.js';

describe('version', () => {
  it('reports the version the package is published under', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
