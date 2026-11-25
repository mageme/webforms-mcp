import { describe, expect, it } from 'vitest';
import { hostSetup, runsFromPackage } from '../src/setup.js';
import { PACKAGE_SPEC, VERSION } from '../src/package.js';

const NPX_POSIX = '/home/u/.npm/_npx/3f2a/node_modules/@mageme/webforms-mcp/dist/index.js';
const NPX_WIN = 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\3f2a\\node_modules\\@mageme\\webforms-mcp\\dist\\index.js';
const CLONE = '/opt/webforms-mcp/dist/index.js';

describe('host setup', () => {
  it('pins the package to the major it was released under', () => {
    expect(PACKAGE_SPEC).toBe(`@mageme/webforms-mcp@${VERSION.split('.')[0]}`);
  });

  it('tells a package run from a clone on any path separator', () => {
    expect(runsFromPackage(NPX_POSIX)).toBe(true);
    expect(runsFromPackage(NPX_WIN)).toBe(true);
    expect(runsFromPackage('/usr/lib/node_modules/@mageme/webforms-mcp/dist/index.js')).toBe(true);
    expect(runsFromPackage(CLONE)).toBe(false);
  });

  it('names the package, never the npx cache path', () => {
    const setup = hostSetup(NPX_POSIX, undefined, false, 'linux');
    expect(setup.cli).toBe(`claude mcp add webforms --scope user -- npx -y ${PACKAGE_SPEC}`);
    expect(JSON.parse(setup.desktop)).toEqual({
      mcpServers: { webforms: { command: 'npx', args: ['-y', PACKAGE_SPEC] } },
    });
    expect(setup.cli + setup.desktop).not.toContain('_npx');
  });

  it('runs npx through cmd /c on native Windows, for Claude Code and Claude Desktop alike', () => {
    const setup = hostSetup(NPX_WIN, undefined, false, 'win32');
    expect(setup.cli).toBe(`claude mcp add webforms --scope user -- cmd /c npx -y ${PACKAGE_SPEC}`);
    expect(JSON.parse(setup.desktop)).toEqual({
      mcpServers: { webforms: { command: 'cmd', args: ['/c', 'npx', '-y', PACKAGE_SPEC] } },
    });
  });

  it('keeps the dedicated server name and profile for an isolated store', () => {
    const setup = hostSetup(NPX_POSIX, 'bigclient', true, 'darwin');
    expect(setup.server).toBe('webforms-bigclient');
    expect(setup.cli).toBe(`claude mcp add webforms-bigclient --scope user -- npx -y ${PACKAGE_SPEC} --profile bigclient`);
  });

  it('registers a shared store under the one shared server, without a profile', () => {
    const setup = hostSetup(NPX_POSIX, 'acme', false, 'linux');
    expect(setup.server).toBe('webforms');
    expect(setup.cli).not.toContain('--profile');
  });

  it('never writes the insecure-TLS allowance into the registration: that stays a decision a person makes', () => {
    const setup = hostSetup(NPX_POSIX, undefined, false, 'linux');
    expect(setup.cli).toBe(`claude mcp add webforms --scope user -- npx -y ${PACKAGE_SPEC}`);
    expect(JSON.parse(setup.desktop).mcpServers.webforms.env).toBeUndefined();
  });

  it('names the built file when run from a clone, quoting a path with spaces', () => {
    const setup = hostSetup(CLONE, undefined, false, 'linux');
    expect(setup.cli).toBe(`claude mcp add webforms --scope user -- node ${CLONE}`);
    expect(JSON.parse(setup.desktop).mcpServers.webforms).toEqual({ command: 'node', args: [CLONE] });
    expect(hostSetup('/opt/my tools/dist/index.js', undefined, false, 'linux').cli).toBe(
      "claude mcp add webforms --scope user -- node '/opt/my tools/dist/index.js'",
    );
  });
});
