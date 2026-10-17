/**
 * The upload service's configuration, read from the environment on every
 * request. It fails closed: anything missing or malformed is an error, and the
 * handlers then refuse every upload and every delete.
 *
 *   UPLOADS_APP_ID           the uploads GitHub App's numeric App ID
 *   UPLOADS_APP_PRIVATE_KEY  that App's private key (PEM). Literal `\n`
 *                            escapes are accepted, as Vercel stores them.
 *   UPLOADS_REPO             the private uploads repository, `owner/name`
 *   ALLOWED_ORIGIN           the catalog site origin(s), as for the sign-in
 *                            service
 *   MIN_ACCOUNT_AGE_DAYS     optional; GitHub accounts younger than this many
 *                            days may not upload (default 0: any account)
 */

import { createPrivateKey } from 'node:crypto';

const REQUIRED_ENV = ['UPLOADS_APP_ID', 'UPLOADS_APP_PRIVATE_KEY', 'UPLOADS_REPO', 'ALLOWED_ORIGIN'];

/** A GitHub App ID is a positive integer. */
const APP_ID_PATTERN = /^[1-9][0-9]{0,11}$/;
/** GitHub account names: letters, digits and single hyphens, at most 39 characters. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** Repository names: letters, digits, `.`, `_`, `-`, at most 100 characters. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
/** Up to ten years, in whole days. */
const DAYS_PATTERN = /^[0-9]{1,4}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The site origins allowed to call this service: a comma-separated list, each
 * an exact origin (`https://example.github.io`, no path and no trailing slash).
 * HTTPS only, except a loopback address for local testing. The same rules as
 * services/github-signin/lib/signin.mjs, copied because each service deploys
 * from its own directory.
 * @param {unknown} value
 * @returns {{origins: string[], error: string}}
 */
export function parseAllowedOrigins(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return { origins: [], error: 'ALLOWED_ORIGIN is empty.' };
  const origins = [];
  for (const entry of entries) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      return { origins: [], error: `ALLOWED_ORIGIN entry "${entry}" is not a URL.` };
    }
    if (url.origin !== entry) {
      return {
        origins: [],
        error: `ALLOWED_ORIGIN entry "${entry}" must be an origin only, like ${url.origin}: no path, query or trailing slash.`,
      };
    }
    const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !local) {
      return { origins: [], error: `ALLOWED_ORIGIN entry "${entry}" must use https://.` };
    }
    origins.push(entry);
  }
  return { origins, error: '' };
}

/**
 * Turn the stored private key back into PEM text: Vercel (and many copy-paste
 * paths) keep it on one line with literal `\n` sequences.
 * @param {string} value
 * @returns {string}
 */
export function normalizePem(value) {
  return String(value).replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
}

/**
 * @typedef {object} UploadsConfig
 * @property {string} appId
 * @property {import('node:crypto').KeyObject|null} privateKey
 * @property {string} owner
 * @property {string} repo
 * @property {string[]} origins
 * @property {number} minAccountAgeDays
 * @property {string} error '' when the configuration is usable
 */

/**
 * Read and check the configuration.
 * @param {Record<string, string|undefined>} env
 * @returns {UploadsConfig}
 */
export function readConfig(env) {
  const source = env ?? {};
  const empty = { appId: '', privateKey: null, owner: '', repo: '', origins: [], minAccountAgeDays: 0 };
  const missing = REQUIRED_ENV.filter((name) => !String(source[name] ?? '').trim());
  if (missing.length > 0) {
    return {
      ...empty,
      error: `Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    };
  }

  const appId = String(source.UPLOADS_APP_ID).trim();
  if (!APP_ID_PATTERN.test(appId)) {
    return { ...empty, error: 'UPLOADS_APP_ID is not a GitHub App ID (a number).' };
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(normalizePem(source.UPLOADS_APP_PRIVATE_KEY));
  } catch {
    // Never echo any part of the key.
    return { ...empty, error: 'UPLOADS_APP_PRIVATE_KEY is not a PEM private key.' };
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    return { ...empty, error: 'UPLOADS_APP_PRIVATE_KEY is not an RSA key (GitHub App keys are RSA).' };
  }

  const [owner, repo, extra] = String(source.UPLOADS_REPO).trim().split('/');
  if (
    extra !== undefined ||
    !OWNER_PATTERN.test(owner ?? '') ||
    !REPO_NAME_PATTERN.test(repo ?? '') ||
    repo === '.' ||
    repo === '..'
  ) {
    return { ...empty, error: 'UPLOADS_REPO must be owner/name, like example/catalog-uploads.' };
  }

  const { origins, error } = parseAllowedOrigins(source.ALLOWED_ORIGIN);
  if (error) return { ...empty, error };

  const days = String(source.MIN_ACCOUNT_AGE_DAYS ?? '').trim();
  if (days !== '' && !DAYS_PATTERN.test(days)) {
    return { ...empty, error: 'MIN_ACCOUNT_AGE_DAYS must be a whole number of days, or blank.' };
  }

  return { appId, privateKey, owner, repo, origins, minAccountAgeDays: Number(days || 0), error: '' };
}
