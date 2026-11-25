/** The oldest Node.js this build runs on; test/node-version.test.ts keeps it equal to package.json "engines". */
export const MIN_NODE = '22.19';

/** Why this Node.js cannot run the server, or undefined when it can. */
export const nodeVersionProblem = (running: string): string | undefined => {
  const [major = 0, minor = 0] = running.split('.').map(Number);
  const [needMajor, needMinor] = MIN_NODE.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return undefined;
  return `webforms-mcp needs Node.js ${MIN_NODE} or newer; this is Node.js ${running}. Install a current Node.js LTS from https://nodejs.org and start it again.`;
};
