import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * A client whose person approves every question: for tests about routes and the journal, not about approval.
 * `approves` lets one test have the person decline.
 */
export const acceptingClient = (name: string, approves: () => boolean = () => true): Client => {
  const client = new Client({ name, version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => (approves() ? { action: 'accept', content: { proceed: true } } : { action: 'decline' }));
  return client;
};
