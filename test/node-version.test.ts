import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_NODE, nodeVersionProblem } from '../src/node-version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string }; bin: Record<string, string> };

describe('Node.js version check', () => {
  it('names the version it needs and the one it found', () => {
    expect(nodeVersionProblem('20.11.1')).toBe(`webforms-mcp needs Node.js ${MIN_NODE} or newer; this is Node.js 20.11.1. Install a current Node.js LTS from https://nodejs.org and start it again.`);
    expect(nodeVersionProblem('22.18.0')).toContain('this is Node.js 22.18.0');
  });

  it('lets the minimum and anything newer through', () => {
    for (const v of ['22.19.0', '22.23.0', '23.0.0', '24.1.0']) expect(nodeVersionProblem(v), v).toBeUndefined();
  });

  it('checks what package.json promises, from the entry the package starts', () => {
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
    expect(pkg.bin['webforms-mcp']).toBe('dist/start.js');
  });
});
