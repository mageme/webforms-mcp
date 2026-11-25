import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, configDir, loadConfig, siteKeyFromPath, type Config } from './config.js';
import type { RuntimeMode } from './mode.js';
import { sanitize } from './errors.js';

export interface SiteEntry { key: string; host: string; label: string; config: Config }
export type DiagnosticReason = 'UNREADABLE' | 'INVALID' | 'TOO_LARGE' | 'KEY_RESERVED' | 'VANISHED';
/** `detail` is the loader's own sentence (what is wrong and how to fix it); it never carries file contents. */
export interface Diagnostic { file: string; reason: DiagnosticReason; detail?: string }
export type FindResult =
  | { ok: true; entry: SiteEntry }
  | { ok: false; reason: 'UNKNOWN' | 'AMBIGUOUS' | 'ISOLATED'; candidates?: string[] };

const CREDENTIALS_NAME = /^credentials(\.[^.]+)?\.json$/;

/** Which diagnostic a failed load deserves. The messages are ours, so matching them is safe. */
const reasonFor = (e: unknown): DiagnosticReason => {
  const message = e instanceof Error ? e.message : '';
  if (/No credentials at|ENOENT/.test(message)) return 'VANISHED';
  if (/refusing to parse/.test(message)) return 'TOO_LARGE';
  if (/not valid JSON|lacks "|Base URL/.test(message)) return 'INVALID';
  return 'UNREADABLE';
};

const entryFor = (key: string, config: Config): SiteEntry => {
  const host = new URL(config.baseUrl).host;
  return { key, host, label: config.label ?? host, config };
};

/**
 * The stores this process can talk to. A shared process discovers them; a dedicated one holds exactly
 * the profile it was started with. Files under isolated/ are named but never opened: that is the whole
 * point of putting a client there.
 */
export class SiteRegistry {
  private constructor(
    private readonly entries: Map<string, SiteEntry>,
    readonly complete: boolean,
    readonly diagnostics: Diagnostic[],
    readonly isolatedKeys: string[],
  ) {}

  /** A registry over credentials already in hand: the seam tests and the single-store path build on. */
  static fromConfigs(configs: Record<string, Config>): SiteRegistry {
    const entries = new Map<string, SiteEntry>();
    for (const [key, config] of Object.entries(configs)) {
      entries.set(key, entryFor(key, config));
    }
    return new SiteRegistry(entries, true, [], []);
  }

  static async discover(mode: RuntimeMode): Promise<SiteRegistry> {
    if (mode.kind === 'dedicated') {
      const key = siteKeyFromPath(mode.credentialsPath);
      const config = await loadConfig(mode.credentialsPath);
      return new SiteRegistry(new Map([[key, entryFor(key, config)]]), true, [], []);
    }
    const dir = configDir();
    const isolated = await SiteRegistry.isolatedNames(dir);
    const entries = new Map<string, SiteEntry>();
    const diagnostics: Diagnostic[] = [];
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return new SiteRegistry(entries, true, diagnostics, isolated);
    }
    for (const name of names.sort()) {
      if (!CREDENTIALS_NAME.test(name)) continue;
      let key: string;
      try {
        key = siteKeyFromPath(name);
      } catch {
        diagnostics.push({ file: name, reason: 'KEY_RESERVED' });
        continue;
      }
      if (isolated.includes(key)) {
        throw new ConfigError(`SITE_KEY_CONFLICT: "${key}" exists both at the top level and under isolated/; remove one.`);
      }
      try {
        entries.set(key, entryFor(key, await loadConfig(join(dir, name))));
      } catch (e) {
        diagnostics.push({ file: name, reason: reasonFor(e), ...(e instanceof ConfigError ? { detail: sanitize(e.message, 300) } : {}) });
      }
    }
    return new SiteRegistry(entries, diagnostics.length === 0, diagnostics, isolated);
  }

  /** Names only: the shared process must never open what is meant for a dedicated one. */
  private static async isolatedNames(dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(join(dir, 'isolated'));
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const name of names.sort()) {
      try {
        keys.push(siteKeyFromPath(name));
      } catch {
        // a file under isolated/ that names no key is simply not addressable
      }
    }
    return keys;
  }

  get size(): number { return this.entries.size; }
  keys(): string[] { return [...this.entries.keys()]; }
  get(key: string): SiteEntry | undefined { return this.entries.get(key); }

  find(needle: string): FindResult {
    const trimmed = needle.trim();
    const direct = this.entries.get(trimmed);
    if (direct) return { ok: true, entry: direct };
    if (this.isolatedKeys.includes(trimmed)) return { ok: false, reason: 'ISOLATED' };
    const host = trimmed.toLowerCase();
    const matches = [...this.entries.values()].filter((e) => e.host.toLowerCase() === host);
    if (matches.length === 1) return { ok: true, entry: matches[0] };
    if (matches.length > 1) return { ok: false, reason: 'AMBIGUOUS', candidates: matches.map((m) => m.key) };
    return { ok: false, reason: 'UNKNOWN' };
  }
}
