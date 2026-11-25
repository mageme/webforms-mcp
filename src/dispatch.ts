import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SiteContext, SiteContextFactory } from './context.js';
import { describeResolveError, resolveSite } from './resolve.js';
import { hintsOf, specOf, type HandlePath } from './manifest.js';
import { HandleUnqualified, QUALIFIED, dequalifyPaths, hasBareHandle, hasUnpinnedBareId, qualifyPaths } from './handles.js';
import { ApiError, describe, markupRefusal } from './errors.js';
import { untrustedBlock } from './untrusted.js';
import { CALL_BUDGET_MS, callSignal } from './client.js';
import { canonical } from './journal.js';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

type Content = { type: 'text'; text: string; _meta?: Record<string, unknown> };
export type ToolResult = { content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> };

export type Shape = Record<string, z.ZodTypeAny>;
/** What a handler receives: the tool's own arguments, typed by its schema. */
export type ArgsOf<S extends Shape> = z.infer<z.ZodObject<S>>;

export type DispatchedHandler<S extends Shape> = (ctx: SiteContext, args: ArgsOf<S>, extra: unknown) => Promise<ToolResult>;
export type UnboundHandler<S extends Shape> = (args: ArgsOf<S>, extra: unknown) => Promise<ToolResult>;

export interface ToolConfig<S extends Shape> {
  title: string;
  description: string;
  inputSchema: S;
}

export const SITE_ARG_DESCRIPTION =
  'Which store to talk to (site key or host); see list_sites. Not the Magento store view - that is store_code.';

const siteArg = z.string().min(1).max(255).optional().describe(SITE_ARG_DESCRIPTION);

const qualifiedId = z.string().regex(QUALIFIED, 'An id qualified by its store, e.g. "acme-prod:42"');

/**
 * A store-qualified id arrives as a string where the tool declares a number, and the SDK validates the
 * schema before this adapter is entered - so the declared handle fields have to admit both spellings.
 * Only top-level fields are widened here; a handle nested inside an array declares its own union in the
 * tool that owns it.
 */
const widenHandles = <S extends Shape>(shape: S, paths: HandlePath[]): S => {
  const widened: Record<string, z.ZodTypeAny> = { ...shape };
  for (const { path, accepts } of paths) {
    // An id-or-code input already takes any string; a settings object keeps its own shape.
    if (accepts === 'ref' || accepts === 'settings' || accepts === 'keys' || path.includes('.') || path.includes('[]')) continue;
    const original = widened[path];
    if (original !== undefined) widened[path] = z.union([original, qualifiedId]);
  }
  return widened as S;
};

const refusal = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * A confirmation_id answers for the call it was first used with. After a lost answer the id stays usable for a
 * retry; a retry with other arguments would carry the person's approval to a call they never saw.
 */
const firstUse = new Map<string, string>();
const MAX_FIRST_USE = 500;
/** The tool and the digest of the arguments of the call being handled, without the approval fields themselves. */
const currentCall = new AsyncLocalStorage<{ tool: string; digest: string }>();
const callDigest = (args: unknown): string => {
  const { confirmation_id: _id, confirmed_by_user: _said, warning_shown_to_user: _shown, ...call } = (args ?? {}) as Record<string, unknown>;
  return createHash('sha256').update(canonical(call)).digest('hex');
};
/** The tool and arguments of the call being handled, as one opaque key; undefined outside a dispatched call. */
export const thisCall = (): string | undefined => {
  const call = currentCall.getStore();
  return call ? `${call.tool}\0${call.digest}` : undefined;
};
/**
 * Called by a tool once a confirmation_id has been found valid for its object: binds it to this call's arguments
 * on first use; answers the refusal to return when a later call brings the same id with other arguments.
 */
export const otherArguments = (site: string, id: string | undefined): string | null => {
  const call = currentCall.getStore();
  if (!call || !id) return null;
  const key = `${site}\0${call.tool}\0${id}`;
  const digest = call.digest;
  const first = firstUse.get(key);
  if (first === undefined) {
    if (firstUse.size >= MAX_FIRST_USE) firstUse.delete(firstUse.keys().next().value as string);
    firstUse.set(key, digest);
    return null;
  }
  return first === digest ? null : `Nothing was sent: this confirmation_id was first used with other arguments, and the person's approval covers that call, not this one. Start over without it (for send_reply: prepare_reply again) and ask the user again.`;
};

/** A store refusal no handler caught: code and HTTP status; its details are the store's data, so they travel as an untrusted block, the store's warnings only counted. */
export const escaped = (e: unknown): ToolResult => {
  if (!(e instanceof ApiError)) return refusal((e as Error).message);
  const markup = markupRefusal(e);
  if (markup) return { content: [{ type: 'text', text: markup.text }, ...markup.blocks], isError: true };
  const { warnings, titles, ...theirs } = e.details;
  // titles are this server's names for the permissions (parseError puts them there); warning_count is counted here
  const ours: Record<string, unknown> = {
    ...(titles === undefined ? {} : { titles }),
    ...(warnings === undefined ? {} : { warning_count: Array.isArray(warnings) ? warnings.filter((w) => typeof w === 'string').length : 0 }),
  };
  const res = refusal(describe(e, ours));
  return Object.keys(theirs).length ? { ...res, content: [...res.content, untrustedBlock('store refusal details', theirs)] } : res;
};

/** How a store is named to a person: the label, with the host beside it when they differ. */
export const siteName = (ctx: Pick<SiteContext, 'label' | 'host'>): string =>
  ctx.label === ctx.host ? ctx.host : `${ctx.label} (${ctx.host})`;

/**
 * Provenance goes on last. The tool handlers merge the store's answer into their own object, so a field
 * arriving from a remote store would otherwise be able to overwrite the record of where the call landed.
 */
const stamp = (result: ToolResult, ctx: SiteContext): ToolResult => {
  const structuredContent = {
    ...(result.structuredContent ?? {}),
    _site: { key: ctx.key, host: ctx.host, label: ctx.label },
  };
  // The handlers serialize their structured answer into the first text block before returning, so the
  // block would otherwise carry the pre-stamp object - including any _site a remote store put there.
  const first = result.content[0];
  let content = result.content;
  if (result.structuredContent !== undefined && first?.type === 'text') {
    content = [{ ...first, text: JSON.stringify(structuredContent, null, 2) }, ...result.content.slice(1)];
  } else if (result.isError === true && first?.type === 'text') {
    // A refusal the tool produced itself says what went wrong but not where; a thrown one already does.
    content = [{ ...first, text: `${siteName(ctx)}: ${first.text}` }, ...result.content.slice(1)];
  }
  return { ...result, content, structuredContent };
};

/** Ids leave qualified, in the structured answer and in the text block that mirrors it. */
const qualifyResult = (result: ToolResult, paths: HandlePath[], ctx: SiteContext): ToolResult => {
  // A refusal carries no ids, and its first block is the reason, not a mirror of the structured answer.
  if (paths.length === 0 || result.structuredContent === undefined || result.isError === true) return result;
  const structuredContent = qualifyPaths(result.structuredContent, paths, ctx.key) as Record<string, unknown>;
  const first = result.content[0];
  const content = first?.type === 'text'
    ? [{ ...first, text: JSON.stringify(structuredContent, null, 2) }, ...result.content.slice(1)]
    : result.content;
  return { ...result, content, structuredContent };
};

/**
 * Registers a tool that acts on one store. The site is resolved synchronously, before the handler is
 * entered and before anything is awaited: a use_site arriving between awaits of a concurrent call must
 * not be able to move a call already under way.
 */
export const registerDispatched = <S extends Shape>(
  server: McpServer,
  factory: SiteContextFactory,
  name: string,
  config: ToolConfig<S>,
  handler: DispatchedHandler<S>,
): void => {
  const spec = specOf(name);
  if (spec.dispatchClass !== 'site-bound') {
    throw new Error(`Tool "${name}" is ${spec.dispatchClass}, not site-bound; register it with registerUnbound.`);
  }
  const callback = async (args: unknown, extra: unknown): Promise<ToolResult> => {
    const input = (args ?? {}) as ArgsOf<S> & { site?: string };
    const resolution = resolveSite(factory.registry, input.site, factory.activeKey(), spec.isMutation);
    if (!resolution.ok) return refusal(describeResolveError(resolution.error));
    const ctx = factory.for(resolution.entry);
    // `site` only chose the store; it must not reach the handler, because several mutations hash their
    // whole argument object into the journal - and then the same operation named by key, by host or not
    // at all would mint three different request ids, so a retry would execute instead of replaying.
    const { site: _routing, ...rest } = input;
    let forHandler: ArgsOf<S>;
    try {
      if (factory.qualifiesIds && hasBareHandle(rest, spec.handlesIn)) {
        return stamp(refusal(new HandleUnqualified(factory.registry.keys()).message), ctx);
      }
      if (factory.qualifiesIds && hasUnpinnedBareId(rest, spec.handlesIn, typeof input.site === 'string' && input.site.trim() !== '')) {
        return stamp(refusal(new HandleUnqualified(factory.registry.keys(), true).message), ctx);
      }
      // The qualifier proved which store the id came from; the store itself only knows the number, and
      // the journal must hash the same body whichever spelling arrived.
      forHandler = dequalifyPaths(rest, spec.handlesIn, ctx.key, factory.registry) as ArgsOf<S>;
    } catch (e) {
      return stamp(refusal((e as Error).message), ctx);
    }
    try {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const result = stamp(await callSignal.run({ signal, deadline: Date.now() + CALL_BUDGET_MS }, () => currentCall.run({ tool: name, digest: callDigest(forHandler) }, () => handler(ctx, forHandler, extra))), ctx);
      return factory.qualifiesIds ? qualifyResult(result, spec.handlesOut, ctx) : result;
    } catch (e) {
      return stamp(escaped(e), ctx);
    }
  };
  // The SDK infers its own argument type from the shape; the contract this adapter honours is proved by
  // test/dispatch.test.ts, which drives every path through a real client.
  server.registerTool(name, { ...config, annotations: { title: config.title, ...hintsOf(name) }, inputSchema: { ...widenHandles(config.inputSchema, spec.handlesIn), site: siteArg } }, callback as never);
};

/** Registers a tool that is about the set of stores rather than one of them: list_sites, use_site. */
export const registerUnbound = <S extends Shape>(
  server: McpServer,
  factory: SiteContextFactory,
  name: string,
  config: ToolConfig<S>,
  handler: UnboundHandler<S>,
): void => {
  const spec = specOf(name);
  if (spec.dispatchClass === 'site-bound') {
    throw new Error(`Tool "${name}" is site-bound; register it with registerDispatched.`);
  }
  const callback = async (args: unknown, extra: unknown): Promise<ToolResult> => handler((args ?? {}) as ArgsOf<S>, extra);
  server.registerTool(name, { ...config, annotations: { title: config.title, ...hintsOf(name) } }, callback as never);
};
