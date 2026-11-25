import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from './client.js';
import type { SiteContextFactory } from './context.js';
import { buildGuide } from './guide.js';
import { QUALIFIED } from './handles.js';

export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;

const json = (uri: string, value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESOURCE_BYTES) {
    throw new Error(`Resource ${uri} exceeds ${MAX_RESOURCE_BYTES} bytes.`);
  }
  return { contents: [{ uri, mimeType: 'application/json', text, _meta: { provenance: 'remote' } }] };
};

/**
 * The URI already names the store, so a bare number is unambiguous here - but the tools hand out
 * qualified ids, and pasting one into the URI must work rather than look like a typo. A qualifier
 * naming a different store is refused.
 */
const canonicalId = (value: unknown, siteKey: string): number => {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') throw new Error('Resource id must be a positive integer.');
  const qualified = QUALIFIED.exec(text);
  if (qualified) {
    if (qualified[1] !== siteKey) {
      throw new Error(`That id belongs to "${qualified[1]}", but this resource is addressed to "${siteKey}".`);
    }
    return Number(qualified[2]);
  }
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error('Resource id must be a positive integer.');
  }
  return Number(text);
};

/**
 * One set per store. Stores may run different WebForms versions, so their schemas and documents are
 * genuinely different resources rather than one resource read through different credentials.
 */
export const registerResources = (server: McpServer, factory: SiteContextFactory): void => {
  for (const key of factory.registry.keys()) {
    const api = (): ApiClient => factory.for(factory.registry.get(key)!).api;
    // A dedicated process is one store by definition; the un-prefixed URIs stay valid there for
    // whatever already reads them.
    const prefixes = factory.mode === 'dedicated' ? [`${key}/`, ''] : [`${key}/`];
    for (const prefix of prefixes) {
      const suffix = prefix === '' ? '@legacy' : `@${key}`;

      server.registerResource(`field-types${suffix}`, `webforms://${prefix}schema/field-types`, { title: 'Field Type Catalog', mimeType: 'application/json' }, async (uri) => {
        const res = await api().get<{ schema_json: string }>('/V1/webforms/schema/field-types');
        return json(uri.href, res.schema_json);
      });

      server.registerResource(`field-type-guide${suffix}`, `webforms://${prefix}guide/field-types`, { title: 'Field Type Guide (compact, generated)', mimeType: 'text/markdown' }, async (uri) => {
        const [types, form, fieldset] = await Promise.all(
          ['field-types', 'form', 'fieldset'].map((kind) => api().get<{ schema_json: string }>(`/V1/webforms/schema/${kind}`)),
        );
        const guide = buildGuide({
          field_types: JSON.parse(types.schema_json),
          form: { settings: JSON.parse(form.schema_json).settings ?? JSON.parse(form.schema_json) },
          fieldset: { settings: JSON.parse(fieldset.schema_json).settings ?? JSON.parse(fieldset.schema_json) },
        });
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide, _meta: { provenance: 'remote' } }] };
      });

      server.registerResource(`document-schema${suffix}`, `webforms://${prefix}schema/document`, { title: 'Form Document JSON Schema', mimeType: 'application/json' }, async (uri) => {
        const res = await api().get<{ schema_json: string }>('/V1/webforms/schema/document');
        return json(uri.href, res.schema_json);
      });

      server.registerResource(`form-document${suffix}`, new ResourceTemplate(`webforms://${prefix}form/{id}/document`, { list: undefined }), { title: 'Live Form Document', mimeType: 'application/json' }, async (uri, { id }) => {
        const res = await api().get<{ document_json: string }>(`/V1/webforms/forms/${canonicalId(id, key)}/document`);
        return json(uri.href, res.document_json);
      });
    }
  }
};
