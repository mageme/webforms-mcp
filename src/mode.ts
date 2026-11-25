import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ConfigError, configDir, credentialsPath, readFlag } from './config.js';

/**
 * Which shape this process runs in. It cannot be inferred from the credentials that end up loaded:
 * a shared process holding one site and a dedicated `--profile default` read the same file, but differ
 * in discovery, identifier form and resource URIs.
 */
export type RuntimeMode = { kind: 'shared' } | { kind: 'dedicated'; credentialsPath: string };

/** Where setup --isolated keeps a store: a directory the shared process never opens. */
export const isolatedCredentialsPath = (profile?: string): string =>
  join(configDir(), 'isolated', basename(sharedCredentialsPath(profile)));

/** The same name in both places is two stores claiming one key; the shared registry refuses it too. */
export const profileConflict = (profile: string): ConfigError =>
  new ConfigError(`SITE_KEY_CONFLICT: "${profile}" exists both at the top level and under isolated/; remove one.`);

/** `default` (or no profile at all) names credentials.json, not credentials.default.json. */
export const sharedCredentialsPath = (profile?: string): string =>
  profile === undefined || profile === 'default' ? credentialsPath() : credentialsPath(profile);

/** A profile is read from the shared directory, or from isolated/ when setup --isolated wrote it there. */
const pathForProfile = (profile: string): string => {
  const shared = sharedCredentialsPath(profile);
  const isolated = isolatedCredentialsPath(profile);
  if (existsSync(shared) && existsSync(isolated)) throw profileConflict(profile);
  return existsSync(isolated) ? isolated : shared;
};

export const resolveMode = (argv: string[] = []): RuntimeMode => {
  const flag = readFlag(argv, '--profile');
  if (flag !== undefined) {
    if (flag === '') throw new ConfigError('--profile needs a name, e.g. --profile stage.');
    return { kind: 'dedicated', credentialsPath: pathForProfile(flag) };
  }
  if (process.env.WEBFORMS_MCP_CREDENTIALS_FILE) {
    return { kind: 'dedicated', credentialsPath: process.env.WEBFORMS_MCP_CREDENTIALS_FILE };
  }
  if (process.env.WEBFORMS_MCP_PROFILE) {
    return { kind: 'dedicated', credentialsPath: pathForProfile(process.env.WEBFORMS_MCP_PROFILE) };
  }
  return { kind: 'shared' };
};
