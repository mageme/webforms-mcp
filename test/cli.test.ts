import { describe, expect, it } from 'vitest';
import { formatSites } from '../src/cli.js';
import { SiteRegistry } from '../src/registry.js';
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

const registry = (keys: Record<string, string | undefined>, extra: Partial<SiteRegistry> = {}): SiteRegistry =>
  Object.create(
    SiteRegistry.fromConfigs(Object.fromEntries(Object.entries(keys).map(([k, l]) => [k, config(k, l)]))),
    Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])),
  ) as SiteRegistry;

describe('the roster as a person reads it', () => {
  it('lists the stores a shared process serves, with a label only when it adds something', () => {
    const out = formatSites(registry({ acme: 'Acme Production', dev: undefined }), 'shared');
    expect(out).toMatch(/Shared process: 2 stores/);
    expect(out).toMatch(/acme\s+acme\.example\s+Acme Production/);
    expect(out).toMatch(/dev\s+dev\.example\n/);
  });

  it('names a dedicated process as one store', () => {
    expect(formatSites(registry({ only: undefined }), 'dedicated')).toMatch(/Dedicated process: one store/);
  });

  it('points at setup when nothing is configured', () => {
    expect(formatSites(registry({}), 'shared')).toMatch(/npx -y @mageme\/webforms-mcp@1 setup/);
  });

  it('separates the stores kept out of the shared process and says how to reach them', () => {
    const out = formatSites(registry({ acme: undefined }, { isolatedKeys: ['big'] }), 'shared');
    expect(out).toMatch(/Kept out of the shared process/);
    expect(out).toMatch(/--profile <name>/);
    expect(out).toMatch(/\n  big/);
  });

  it('reports what it could not read and why that matters', () => {
    const out = formatSites(registry({ acme: undefined }, { diagnostics: [{ file: 'credentials.old.json', reason: 'INVALID' }] }), 'shared');
    expect(out).toMatch(/Not read:/);
    expect(out).toMatch(/credentials\.old\.json\s+INVALID/);
    expect(out).toMatch(/must name its store/);
  });

  it('with every file unreadable, points at the files rather than at setup', () => {
    const out = formatSites(registry({}, { diagnostics: [{ file: 'credentials.json', reason: 'UNREADABLE' }] }), 'shared');
    expect(out).not.toMatch(/run: .*setup/);
    expect(out).toMatch(/none readable: fix the files under "Not read"/);
  });
});
