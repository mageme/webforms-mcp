import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiClient, callSignal, networkError } from '../src/client.js';
import { ApiError, describe as describeError } from '../src/errors.js';
import type { Config } from '../src/config.js';

const config = (baseUrl: string): Config => ({ baseUrl, consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', insecureTls: false, journalKey: 'jk' });

let server: Server | undefined;
let paths: string[] = [];
const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
  paths = [];
  server = createServer((req, res) => {
    paths.push(`${req.method} ${new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/rest\/all/, '')}`);
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};
const isCaps = (req: IncomingMessage) => (req.url ?? '').endsWith('/V1/webforms/capabilities');
const json = (res: ServerResponse, o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const rejection = async (p: Promise<unknown>): Promise<ApiError> => {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected a rejection');
};

describe('an answer that is not the API', () => {
  it('a 200 with an HTML page is an error, not a success with null', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Maintenance</html>')));
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e.code).toBe('BAD_RESPONSE');
    expect(e.message).toMatch(/text\/html/);
  });

  it('a read answered 200 with an empty body is an error, not a success with null', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : res.writeHead(200, { 'content-type': 'application/json' }).end('')));
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e.code).toBe('BAD_RESPONSE');
    expect(e.message).toMatch(/application\/json, 0 bytes/);
  });

  it('for a write it says the change may have applied and that the same call is safe to repeat', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : res.writeHead(200, { 'content-type': 'text/html' }).end('<html/>')));
    const e = await rejection(new ApiClient(config(base)).post('/V1/webforms/x', { request: { request_id: 'r1' } }));
    expect(e.code).toBe('BAD_RESPONSE');
    expect(e.message).toMatch(/may have been applied.*same request id/);
  });

  it('a 200 with an empty body is an error, not a success with null', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : res.writeHead(200, { 'content-type': 'application/json' }).end('')));
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e.code).toBe('BAD_RESPONSE');
    expect(e.message).toMatch(/0 bytes/);
  });
});

describe('a connection that breaks while the body is read', () => {
  it('is retried for a read and then reported as NETWORK, not as a raw TypeError', async () => {
    const base = await serve((req, res) => {
      if (isCaps(req)) return json(res, { api_version: '1' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"items":[');
      setTimeout(() => res.destroy(), 10);
    });
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('NETWORK');
    expect(e.message).toMatch(/Nothing was changed/);
    expect(paths.filter((p) => p.endsWith('/forms'))).toHaveLength(3);
  }, 15_000);
});

describe('deadlines and cancellation', () => {
  it('one call never takes longer than its budget, retries included', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : undefined));
    const client = new ApiClient(config(base), () => undefined, 1500);
    await client.get('/V1/webforms/capabilities');
    const started = Date.now();
    const e = await rejection(client.post('/V1/webforms/x', { request: { request_id: 'r1' } }));
    expect(Date.now() - started).toBeLessThan(10_000); // far below 3 x 30 s; the full suite can delay timers by seconds
    expect(e.code).toBe('NETWORK');
    expect(e.message).toMatch(/did not answer POST \/V1\/webforms\/x in time.*same request id/);
  }, 20_000);

  it('every request of one tool call shares its deadline', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : undefined));
    const client = new ApiClient(config(base));
    await client.get('/V1/webforms/capabilities');
    const started = Date.now();
    const e = await rejection(callSignal.run({ deadline: Date.now() + 1500 }, () => client.get('/V1/webforms/forms')));
    expect(Date.now() - started).toBeLessThan(10_000); // far below 3 x 30 s; the full suite can delay timers by seconds
    expect(e.code).toBe('NETWORK');
  }, 20_000);

  it('a request whose call has no time left is not sent, and says so', async () => {
    const base = await serve((req, res) => json(res, { api_version: '1' }));
    const client = new ApiClient(config(base));
    await client.get('/V1/webforms/capabilities');
    const e = await rejection(callSignal.run({ deadline: Date.now() + 200 }, () => client.post('/V1/webforms/x', { request: { request_id: 'r1' } })));
    expect(e.message).toMatch(/Nothing was sent; repeating the call is safe/);
    expect(paths.filter((p) => p.endsWith('/x'))).toHaveLength(0);
  });

  it('a Retry-After that does not fit the budget is not shortened: the store\'s answer stands', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }).end('{"message":"busy"}')));
    const started = Date.now();
    const e = await rejection(new ApiClient(config(base), () => undefined, 5000).post('/V1/webforms/x', { request: { request_id: 'r1' } }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e.code).toBe('HTTP_503');
    expect(paths.filter((p) => p.endsWith('/x'))).toHaveLength(1);
  }, 20_000);

  it('a call the MCP client cancelled stops its request and says so', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : undefined));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const e = await rejection(callSignal.run({ signal: controller.signal }, () => new ApiClient(config(base)).get('/V1/webforms/forms')));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e.message).toMatch(/cancelled by the client/);
  });

  it('names the cause of a failed connection, and a certificate problem as such', () => {
    const tls = networkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), { method: 'GET', path: '/p', attempt: 1, timedOut: false, cancelled: false, replayable: false });
    expect(tls.message).toMatch(/TLS certificate was not accepted \(DEPTH_ZERO_SELF_SIGNED_CERT\).*--insecure-tls/);
    const refused = networkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), { method: 'POST', path: '/p', attempt: 3, timedOut: false, cancelled: false, replayable: false });
    expect(refused.message).toMatch(/\(ECONNREFUSED\).*check the current state/);
  });
});

describe('the API version', () => {
  it('a store on another major version is refused before anything else is sent', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '2' }) : json(res, { items: [] })));
    const e = await rejection(new ApiClient(config(base)).post('/V1/webforms/x', { request: { request_id: 'r1' } }));
    expect(e.code).toBe('API_VERSION_UNSUPPORTED');
    expect(e.message).toMatch(/Update webforms-mcp/);
    expect(paths).toEqual(['GET /V1/webforms/capabilities']);
  });

  it('a store on v1 is asked once', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: '1' }) : json(res, { items: [] })));
    const client = new ApiClient(config(base));
    await client.get('/V1/webforms/forms');
    await client.get('/V1/webforms/forms');
    expect(paths).toEqual(['GET /V1/webforms/capabilities', 'GET /V1/webforms/forms', 'GET /V1/webforms/forms']);
  });

  it('a version that is not a number is refused, not taken for v1', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: 'v2' }) : json(res, { items: [] })));
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e.code).toBe('API_VERSION_UNSUPPORTED');
    expect(e.message).toMatch(/API v2\b.*Update webforms-mcp/);
    expect(paths).toEqual(['GET /V1/webforms/capabilities']);
  });

  it('a version that names no number is refused as unknown', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: 'beta' }) : json(res, { items: [] })));
    const e2 = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e2.code).toBe('API_VERSION_UNSUPPORTED');
    expect(e2.message).toMatch(/does not name a version this release understands/);
    expect(paths).toEqual(['GET /V1/webforms/capabilities']);
  });

  it('a "v1" is v1', async () => {
    const base = await serve((req, res) => (isCaps(req) ? json(res, { api_version: 'v1' }) : json(res, { items: [] })));
    await new ApiClient(config(base)).get('/V1/webforms/forms');
    expect(paths).toEqual(['GET /V1/webforms/capabilities', 'GET /V1/webforms/forms']);
  });

  it('a store without the WebForms API says so instead of "the object does not exist"', async () => {
    const base = await serve((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Request does not match any route.' })));
    const e = await rejection(new ApiClient(config(base)).get('/V1/webforms/forms'));
    expect(e.code).toBe('NOT_FOUND');
    expect(describeError(e)).toMatch(/answers no WebForms API at all/);
    expect(describeError(e)).not.toMatch(/Re-list and pick/);
    expect(paths).toEqual(['GET /V1/webforms/capabilities', 'GET /V1/webforms/forms']);
  });
});

describe('a store that had no API', () => {
  it('loses the "no API" hint once capabilities answers, and never puts it on a WebForms NOT_FOUND', async () => {
    let up = false;
    const base = await serve((req, res) => {
      if (isCaps(req)) return up ? json(res, { api_version: '1' }) : res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Request does not match any route."}');
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Form not found.', parameters: { code: 'NOT_FOUND' } }));
    });
    const client = new ApiClient(config(base));
    const coded = await rejection(client.get('/V1/webforms/forms/9'));
    expect(describeError(coded)).toMatch(/Re-list and pick/);
    up = true;
    (client as unknown as { nextCheckAt: number }).nextCheckAt = 0;
    await rejection(client.get('/V1/webforms/forms/9'));
    expect((client as unknown as { noApi: boolean }).noApi).toBe(false);
  });
});

describe('what the model is told', () => {
  it('a bare 500 carries a next step', () => {
    expect(describeError(new ApiError(500, 'HTTP_500', 'x'))).toMatch(/error log.*check the current state/);
  });
});
