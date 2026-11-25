import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formAccess, type SiteContextFactory } from '../context.js';
import { registerUnbound, siteName, type ToolResult } from '../dispatch.js';
import { describeResolveError, resolveSite } from '../resolve.js';

const PROBE_CONCURRENCY = 4;

const ok = (structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
  structuredContent: structured,
});

const refuse = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Runs the thunks a few at a time, so twenty stores do not all get probed at once. */
const pooled = async <T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> => {
  const out: T[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await items[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

export const registerSiteTools = (server: McpServer, factory: SiteContextFactory): void => {
  registerUnbound(server, factory, 'list_sites', {
    title: 'List Sites',
    description: 'The stores this server can talk to, with the active one marked. Answers from local configuration; pass probe: true to also report each store\'s API version and form access, which contacts them.',
    inputSchema: { probe: z.boolean().default(false) },
  }, async ({ probe }) => {
    const { registry } = factory;
    const rows = registry.keys().map((key) => {
      const entry = registry.get(key)!;
      // false: this store's irreversible actions run without asking a person (development hosts only).
      return { key, host: entry.host, label: entry.label, active: factory.activeKey() === key, confirm_actions: entry.config.confirmActions !== false };
    });
    const sites = probe
      ? await pooled(rows.map((row) => async () => {
          try {
            const caps = await factory.for(registry.get(row.key)!).capabilities(true);
            return { ...row, api_version: caps.api_version, document_schema_version: caps.document_schema_version, form_access: formAccess(caps.features_json) };
          } catch (e) {
            return { ...row, error: (e as Error).message };
          }
        }), PROBE_CONCURRENCY)
      : rows;
    return ok({
      mode: factory.mode,
      sites,
      isolated: registry.isolatedKeys.map((key) => ({ key, note: `configured for a dedicated process; start it with --profile ${key}` })),
      diagnostics: registry.diagnostics,
      roster_complete: registry.complete,
    });
  });

  registerUnbound(server, factory, 'use_site', {
    title: 'Use Site',
    description: 'Selects the store the following calls act on, so the site argument can be omitted. Call it without a site to see what is selected now.',
    inputSchema: { site: z.string().min(1).max(255).optional() },
  }, async ({ site }) => {
    const { registry } = factory;
    if (site === undefined) {
      const key = factory.activeKey();
      const entry = key === undefined ? undefined : registry.get(key);
      return ok(entry ? { active: entry.key, host: entry.host, label: entry.label } : { active: null });
    }
    const resolution = resolveSite(registry, site, undefined, false);
    if (!resolution.ok) return refuse(describeResolveError(resolution.error));

    // The ticket is taken before anything is awaited, so a later switch cannot lose to an earlier slow one.
    const attempt = factory.beginSwitch(resolution.entry.key);
    const ctx = factory.for(resolution.entry);
    let caps;
    try {
      caps = await ctx.capabilities();
    } catch (e) {
      return refuse(`Cannot reach ${siteName(ctx)}: ${(e as Error).message}. The active site is unchanged.`);
    }
    if (!attempt.commit()) {
      const active = factory.activeKey();
      return refuse(`A newer use_site call superseded this one; the active site is ${active ?? 'unchanged'}.`);
    }
    return ok({ key: ctx.key, host: ctx.host, label: ctx.label, api_version: caps.api_version, active: ctx.key });
  });
};
