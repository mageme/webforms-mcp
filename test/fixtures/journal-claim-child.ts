// Child process for test/journal-lock.test.ts: claims `count` keys on a shared journal once both processes are ready.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Journal } from '../../src/journal.js';

const [path, ready, go, count] = process.argv.slice(2);
const journal = new Journal('k'.repeat(64), path, 'scope');
writeFileSync(ready, '');
while (!existsSync(go)) await sleep(5);
const ids: string[] = [];
for (let i = 0; i < Number(count); i++) {
  ids.push((await journal.claim('form:create', { name: `F${i}` }, true, [], `key-${i}`)).requestId);
}
process.stdout.write(JSON.stringify(ids));
