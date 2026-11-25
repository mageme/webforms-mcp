import { describe, expect, it } from 'vitest';
import { authorizationHeader, rfc3986, signatureBase } from '../src/oauth.js';

// Fixture computed independently with Python's hmac/urllib (HMAC-SHA256, key "cs&ts").
const creds = { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'tok', accessTokenSecret: 'ts' };
const input = { method: 'GET', url: 'https://shop.example/rest/all/V1/webforms/forms', query: { 'searchCriteria[pageSize]': '2', x: 'a b' }, nonce: 'n0nce', timestamp: '1700000000' };

describe('oauth 1.0a', () => {
  it('encodes per RFC 3986', () => {
    expect(rfc3986("a b!*'()~")).toBe('a%20b%21%2A%27%28%29~');
  });
  it('builds the cross-checked base string', () => {
    const base = signatureBase(input, { oauth_consumer_key: 'ck', oauth_nonce: 'n0nce', oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: '1700000000', oauth_token: 'tok', oauth_version: '1.0' });
    expect(base).toBe('GET&https%3A%2F%2Fshop.example%2Frest%2Fall%2FV1%2Fwebforms%2Fforms&oauth_consumer_key%3Dck%26oauth_nonce%3Dn0nce%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1700000000%26oauth_token%3Dtok%26oauth_version%3D1.0%26searchCriteria%255BpageSize%255D%3D2%26x%3Da%2520b');
  });
  it('signs with HMAC-SHA256 and emits a header', () => {
    const header = authorizationHeader(creds, input);
    expect(header).toContain('oauth_signature="esxRctEFnYVt4xxcTWCCyCd1sDgTE5xOeQZKSPuKgEA%3D"');
    expect(header.startsWith('OAuth oauth_consumer_key="ck"')).toBe(true);
  });
  it('keeps duplicate query parameters and orders by name then value', () => {
    const base = signatureBase({ method: 'GET', url: 'https://s.example/x', query: [['b', '2'], ['a', 'z'], ['b', '1']] }, { oauth_nonce: 'n' });
    expect(base).toBe('GET&https%3A%2F%2Fs.example%2Fx&a%3Dz%26b%3D1%26b%3D2%26oauth_nonce%3Dn');
  });
});
