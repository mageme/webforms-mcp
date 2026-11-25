import { createHmac, randomBytes } from 'node:crypto';

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encoding as OAuth 1.0a requires (encodeURIComponent plus !'()*). */
export const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export type Pair = readonly [string, string];

export interface SignInput {
  method: string;
  /** Absolute URL without the query string. */
  url: string;
  /** Query parameters (decoded); duplicates are preserved as separate pairs. */
  query?: Record<string, string> | Pair[];
  nonce?: string;
  timestamp?: string;
}

const pairsOf = (query: SignInput['query']): Pair[] => (Array.isArray(query) ? query : Object.entries(query ?? {}));

/** RFC 5849 §3.4.1.3.2: encode every pair, sort by name then value, join. */
export const signatureBase = (input: SignInput, oauthParams: Record<string, string>): string => {
  const encoded = [...Object.entries(oauthParams), ...pairsOf(input.query)]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as Pair)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const normalized = encoded.map(([k, v]) => `${k}=${v}`).join('&');
  return [input.method.toUpperCase(), rfc3986(input.url), rfc3986(normalized)].join('&');
};

export const authorizationHeader = (creds: OAuthCredentials, input: SignInput): string => {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: input.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessTokenSecret)}`;
  const signature = createHmac('sha256', key).update(signatureBase(input, oauthParams)).digest('base64');
  const header = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.entries(header).map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`).join(', ')}`;
};
