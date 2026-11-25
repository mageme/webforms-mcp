import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

/**
 * Shared pieces of the tests that talk to a real store (WEBFORMS_MCP_E2E=1).
 *
 *   WEBFORMS_MCP_E2E=1                  switches the real-store tests on
 *   WEBFORMS_MCP_CREDENTIALS_FILE       the store they talk to; without it they are skipped
 *   WEBFORMS_MCP_E2E_ORDER              an existing order number to link (optional; otherwise any order the API shows)
 *   WEBFORMS_MCP_E2E_CONCURRENCY        parallel requests in load.test.ts (default 5)
 *   WEBFORMS_MCP_E2E_LEFTOVERS          a file that receives one line per record a run leaves in the store (optional)
 *   WEBFORMS_MCP_E2E_PROFILES           comma-separated profile names for shared.test.ts; without it that test is skipped
 *
 * The API cannot delete a form, a submission or a note. A run therefore writes only into a form of its own
 * (mcp-e2e-<run id>), switches that form off at the end and reports what it leaves behind, by id.
 */
export const e2eEnabled = process.env.WEBFORMS_MCP_E2E === '1' && Boolean(process.env.WEBFORMS_MCP_CREDENTIALS_FILE);

export const credentialsFile = (): string => process.env.WEBFORMS_MCP_CREDENTIALS_FILE as string;

/** Time plus randomness: two runs, even at the same second, never share a name. */
export const runId = (): string => `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;

export const concurrency = (): number => {
  const n = Number(process.env.WEBFORMS_MCP_E2E_CONCURRENCY ?? 5);
  return Number.isInteger(n) && n > 0 ? n : 5;
};

export const apiClient = async (): Promise<ApiClient> => new ApiClient(await loadConfig(credentialsFile()));

/** A server process for one store, spawned over stdio exactly as a host would. */
export const connectDedicated = async (name: string): Promise<Client> => {
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], env: { ...process.env } as Record<string, string>, stderr: 'pipe' });
  const client = new Client({ name, version: '0' });
  await client.connect(transport);
  return client;
};

/** What a run leaves in the store, said out loud and, when asked, appended to a file. */
export const reportLeft = (line: string): void => {
  console.log(`E2E-LEFT ${line}`);
  const file = process.env.WEBFORMS_MCP_E2E_LEFTOVERS;
  if (file) appendFileSync(file, `${line}\n`);
};

/**
 * Switches a form off, reads its state back and reports what the run leaves behind: the report is made
 * whether or not the switch-off worked, and says so when the form is still on.
 */
export const switchOffAndReport = async (formId: number, left: string, off: () => Promise<unknown>, isActive: () => Promise<boolean>): Promise<void> => {
  let state: string;
  try {
    await off();
    state = (await isActive()) ? 'STILL ACTIVE' : 'switched off';
  } catch (e) {
    state = `STILL ACTIVE (switching off failed: ${(e as Error).message.slice(0, 200)})`;
  }
  reportLeft(`form ${formId}: ${state}; ${left}`);
};

/** Reads a form's is_active flag; a form that does not say is an error, never "off". */
export const activeFlag = (form: { is_active?: unknown } | undefined): boolean => {
  if (form?.is_active === undefined || form.is_active === null) throw new Error('the form does not report is_active');
  return form.is_active === true || form.is_active === 1 || form.is_active === '1';
};

/** Runs at most `limit` calls at a time. */
export const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** Field ids of a live form by field code, from its document. */
export const fieldIdsByCode = (document: { fieldsets?: { fields?: { code?: string; field_id?: number | string }[] }[] }): Record<string, number> => {
  const ids: Record<string, number> = {};
  for (const fieldset of document.fieldsets ?? []) {
    for (const field of fieldset.fields ?? []) {
      if (field.code && field.field_id !== undefined) ids[field.code] = Number(field.field_id);
    }
  }
  return ids;
};
