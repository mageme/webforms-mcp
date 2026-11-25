import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiClient } from '../src/client.js';
import type { Config } from '../src/config.js';

const config = (baseUrl: string): Config => ({
  baseUrl,
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
  insecureTls: false,
  journalKey: 'jk',
});

let server: Server | undefined;

/** A server that answers after `delayMs`, so a deadline shorter than that must fire. */
const slowServer = async (delayMs: number): Promise<string> => {
  server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('ApiClient.get deadline', () => {
  it('gives up on a store that answers slower than the deadline allows', async () => {
    const base = await slowServer(400);
    const client = new ApiClient(config(base));
    await expect(client.get('/V1/webforms/capabilities', undefined, { timeoutMs: 40 }))
      .rejects.toThrow(/did not answer GET \/V1\/webforms\/capabilities in time.*Nothing was changed/);
  }, 20_000);

  it('still answers when the deadline is generous enough', async () => {
    const base = await slowServer(10);
    const client = new ApiClient(config(base));
    await expect(client.get('/V1/webforms/capabilities', undefined, { timeoutMs: 5000 }))
      .resolves.toEqual({ ok: true });
  });

  it('works without a deadline argument, as every existing caller passes it today', async () => {
    const base = await slowServer(10);
    const client = new ApiClient(config(base));
    await expect(client.get('/V1/webforms/capabilities')).resolves.toEqual({ ok: true });
  });
});
