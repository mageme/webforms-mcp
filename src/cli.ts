import type { SiteRegistry } from './registry.js';
import type { RuntimeMode } from './mode.js';
import { RUN } from './package.js';

const pad = (value: string, width: number): string => value + ' '.repeat(Math.max(0, width - value.length));

/**
 * The roster as a person reads it, outside any model: which stores this process serves, which are kept
 * out of it, and what it could not read. Answers from local configuration; it contacts no store.
 */
export const formatSites = (registry: SiteRegistry, mode: RuntimeMode['kind']): string => {
  const lines: string[] = [];
  const keys = registry.keys();
  lines.push(mode === 'shared'
    ? `Shared process: ${keys.length} store${keys.length === 1 ? '' : 's'}.`
    : 'Dedicated process: one store.');
  if (keys.length === 0 && registry.diagnostics.length > 0) {
    lines.push('  (none readable: fix the files under "Not read" below)');
  } else if (keys.length === 0) {
    lines.push(`  (none configured — run: ${RUN} setup)`);
  } else {
    const width = Math.max(...keys.map((k) => k.length));
    for (const key of keys) {
      const entry = registry.get(key)!;
      const label = entry.label === entry.host ? '' : `  ${entry.label}`;
      lines.push(`  ${pad(key, width)}  ${entry.host}${label}`);
    }
  }
  if (registry.isolatedKeys.length > 0) {
    lines.push('', 'Kept out of the shared process (start each with --profile <name>):');
    for (const key of registry.isolatedKeys) lines.push(`  ${key}`);
  }
  if (registry.diagnostics.length > 0) {
    lines.push('', 'Not read:');
    for (const { file, reason, detail } of registry.diagnostics) lines.push(`  ${file}  ${reason}${detail ? `: ${detail}` : ''}`);
    lines.push('', 'While anything is unread, a call must name its store: a survivor of a failed scan is not "the only store".');
  }
  return lines.join('\n') + '\n';
};
