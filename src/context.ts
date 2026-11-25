import { createHash } from 'node:crypto';
import { ApiClient } from './client.js';
import { Journal } from './journal.js';
import type { RuntimeMode } from './mode.js';
import type { SiteEntry, SiteRegistry } from './registry.js';

export interface Capabilities {
  api_version: string;
  document_schema_version: string;
  field_types: string[];
  features_json?: string;
}

const FORM_ACCESS: Record<string, string> = { all: 'All Forms', selected: 'Selected forms', none: 'No forms' };

/**
 * The forms the integration reaches, as `features_json.form_scope` reports it; null when the store does not
 * report a scope (older servers) or reports one this client does not know.
 */
export const formAccess = (featuresJson?: string): string | null => {
  try {
    const scope = featuresJson ? (JSON.parse(featuresJson) as Record<string, unknown>).form_scope : undefined;
    return typeof scope === 'string' && Object.hasOwn(FORM_ACCESS, scope) ? FORM_ACCESS[scope] : null;
  } catch {
    return null;
  }
};

/** Everything one tool invocation needs to talk to one store. Immutable, built per call. */
export interface SiteContext {
  readonly key: string;
  readonly host: string;
  readonly label: string;
  /** false: irreversible actions run without asking a person (development stores only, enforced at load). */
  readonly confirmActions: boolean;
  readonly mode: RuntimeMode['kind'];
  readonly api: ApiClient;
  readonly journal: Journal;
  /** Cached for a few minutes; `fresh` asks the store again. */
  capabilities(fresh?: boolean): Promise<Capabilities>;
}

const OK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const CAPABILITIES_TIMEOUT_MS = 5000;

interface Cached { at: number; value?: Capabilities; error?: unknown }

export class SiteContextFactory {
  private readonly contexts = new Map<string, SiteContext>();
  private readonly caps = new Map<string, Cached>();
  private active: string | undefined;
  private issued = 0;

  constructor(
    readonly registry: SiteRegistry,
    readonly mode: RuntimeMode['kind'],
    private readonly log: (line: string) => void,
    private readonly journalPath?: string,
  ) {}

  /** Clients and journals are built on first use: twenty sites must not open twenty pools at boot. */
  for(entry: SiteEntry): SiteContext {
    const existing = this.contexts.get(entry.key);
    if (existing) return existing;
    const api = new ApiClient(entry.config, this.log);
    const scope = createHash('sha256').update(`${entry.config.baseUrl}\n${entry.config.consumerKey}`).digest('hex');
    const journal = new Journal(entry.config.journalKey, this.journalPath, scope);
    const context: SiteContext = {
      key: entry.key,
      host: entry.host,
      label: entry.label,
      confirmActions: entry.config.confirmActions !== false,
      mode: this.mode,
      api,
      journal,
      capabilities: (fresh = false) => this.capabilitiesOf(entry.key, api, fresh),
    };
    this.contexts.set(entry.key, context);
    return context;
  }

  private async capabilitiesOf(key: string, api: ApiClient, fresh: boolean): Promise<Capabilities> {
    const hit = fresh ? undefined : this.caps.get(key);
    if (hit && Date.now() - hit.at < (hit.error === undefined ? OK_TTL_MS : FAIL_TTL_MS)) {
      if (hit.error !== undefined) throw hit.error;
      return hit.value as Capabilities;
    }
    try {
      const value = await api.get<Capabilities>('/V1/webforms/capabilities', undefined, { timeoutMs: CAPABILITIES_TIMEOUT_MS });
      this.caps.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      this.caps.set(key, { at: Date.now(), error: e });
      throw e;
    }
  }

  /**
   * Identifiers carry their store only when there is another store to confuse them with. One store is
   * one store whichever mode found it, and the same reasoning already makes `site` optional there.
   */
  get qualifiesIds(): boolean { return this.registry.size > 1; }

  activeKey(): string | undefined { return this.active; }
  clearActive(): void { this.active = undefined; }

  /**
   * The ticket is taken synchronously, before the caller awaits anything, and only the newest attempt
   * may commit. Comparing against the last committed ticket would not be enough: a newer attempt that
   * fails never commits, and an older one finishing afterwards would then change the selection that
   * the newer one had already reported as unchanged.
   */
  beginSwitch(key: string): { commit: () => boolean; ticket: number } {
    const ticket = ++this.issued;
    return {
      ticket,
      commit: () => {
        if (ticket !== this.issued) return false;
        this.active = key;
        return true;
      },
    };
  }
}
