#!/usr/bin/env node
import { nodeVersionProblem } from './node-version.js';

// The server's own modules are loaded only after the check: on an older Node.js they may not even parse.
const problem = nodeVersionProblem(process.versions.node);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
await import('./index.js');
