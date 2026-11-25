import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Protocol harness against a real store: spawns the server over stdio exactly as a host would.
 * Enabled with WEBFORMS_MCP_E2E=1 and WEBFORMS_MCP_CREDENTIALS_FILE pointing at dev credentials.
 */
const enabled = process.env.WEBFORMS_MCP_E2E === '1';

describe.skipIf(!enabled)('stdio harness against the dev store', () => {
  it('lists forms, reads a document and searches submissions through stdio', async () => {
    const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], env: { ...process.env } as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'harness', version: '0' });
    await client.connect(transport);
    try {
      const caps = await client.callTool({ name: 'get_capabilities', arguments: {} });
      expect((caps.structuredContent as any).api_version).toBe('1');
      const forms = await client.callTool({ name: 'list_forms', arguments: { page_size: 5 } });
      expect(forms.isError ?? false, JSON.stringify(forms.content)).toBe(false);
      const items = (forms.structuredContent as any).items as any[];
      expect(items.length).toBeGreaterThan(0);
      const formId = items[0].id;
      const doc = await client.readResource({ uri: `webforms://form/${formId}/document` });
      expect(JSON.parse(doc.contents[0].text as string)).toHaveProperty('fields');
      const search = await client.callTool({ name: 'search_submissions', arguments: { form_id: formId, page_size: 2 } });
      expect(search.isError ?? false, JSON.stringify(search.content)).toBe(false);
      const missing = await client.callTool({ name: 'get_form', arguments: { form_id: 999999999 } });
      expect(missing.isError).toBe(true);
      expect((missing.content as any[])[0].text).toContain('NOT_FOUND');
    } finally {
      await client.close();
    }
  }, 60_000);
});
