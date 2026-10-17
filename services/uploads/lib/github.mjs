/**
 * The GitHub REST calls the upload service makes, and the uploads GitHub App's
 * authentication, with no dependencies.
 *
 * Two kinds of token pass through here and they never mix:
 *
 * - the **submitter's** user token, used for exactly one call, `GET /user`, to
 *   learn who is uploading;
 * - the **App installation** token, minted from the App's private key (an
 *   RS256 JWT signed with node:crypto), scoped to the uploads repository with
 *   `contents: write`, and kept in module scope until five minutes before it
 *   expires, so a warm instance mints one about once an hour.
 *
 * Neither token is ever logged; log lines carry HTTP statuses only.
 */

import { sign } from 'node:crypto';

export const API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'phct-uploads';

/** How long to wait for any one GitHub call. */
export const GITHUB_TIMEOUT_MS = 10000;

/** Refresh the installation token this long before GitHub says it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** When GitHub rate-limits us without saying for how long. */
const DEFAULT_RETRY_AFTER = 60;
const MAX_RETRY_AFTER = 3600;

/** GitHub user and installation tokens: an opaque `gh?_…`/`github_pat_…` string. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,512}$/;

/**
 * A GitHub call that did not succeed.
 * - `unauthorized`: 401, the token is not (or no longer) valid
 * - `rate_limited`: a primary or secondary rate limit; `retryAfter` seconds
 * - `not_found`: 404
 * - `unprocessable`: 422; `message` holds GitHub's own message
 * - `failed`: anything else, including a network failure or a timeout
 */
export class GitHubError extends Error {
  /**
   * @param {'unauthorized'|'rate_limited'|'not_found'|'unprocessable'|'failed'} kind
   * @param {number} status 0 when GitHub was not reached
   * @param {{retryAfter?: number, message?: string}} [extra]
   */
  constructor(kind, status, { retryAfter = 0, message = '' } = {}) {
    super(`GitHub ${kind} (HTTP ${status})`);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.githubMessage = message;
  }
}

/**
 * How many seconds GitHub asks us to wait, when a 403/429 is a rate limit;
 * 0 when it is not one. GitHub signals a secondary limit with `retry-after`
 * or with "secondary rate limit" in the message, and a primary limit with
 * `x-ratelimit-remaining: 0` and `x-ratelimit-reset`.
 * @param {Response} response
 * @param {string} message GitHub's error message, '' if none
 * @param {number} nowMs
 * @returns {number}
 */
export function rateLimitRetryAfter(response, message, nowMs) {
  if (response.status !== 403 && response.status !== 429) return 0;
  const clamp = (seconds) => Math.min(MAX_RETRY_AFTER, Math.max(1, Math.ceil(seconds)));
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^\s*[0-9]+\s*$/.test(retryAfter)) return clamp(Number(retryAfter));
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (exhausted && Number.isFinite(reset) && reset > 0) return clamp(reset - nowMs / 1000);
  if (exhausted || response.status === 429 || /rate limit/i.test(message)) return DEFAULT_RETRY_AFTER;
  return 0;
}

/**
 * One GitHub REST call. Resolves to the parsed JSON body (or null for an empty
 * one); rejects with a GitHubError.
 *
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {string} method
 * @param {string} path starting with `/`
 * @param {{token: string, body?: unknown}} options
 * @returns {Promise<any>}
 */
export async function githubRequest(deps, method, path, { token, body }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  let text;
  try {
    response = await deps.fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new GitHubError('failed', 0, { message: error?.name || 'Error' });
  }
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (response.ok) return json;
  const message = typeof json?.message === 'string' ? json.message.slice(0, 200) : '';
  const retryAfter = rateLimitRetryAfter(response, message, deps.now());
  if (retryAfter > 0) throw new GitHubError('rate_limited', response.status, { retryAfter, message });
  if (response.status === 401) throw new GitHubError('unauthorized', 401, { message });
  if (response.status === 404) throw new GitHubError('not_found', 404, { message });
  if (response.status === 422) throw new GitHubError('unprocessable', 422, { message });
  throw new GitHubError('failed', response.status, { message });
}

/**
 * @typedef {{id: number, login: string, createdAt: number}} GitHubUser
 */

/**
 * Who owns this user token: `GET /user`, the only call the submitter's token
 * is ever used for.
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {string} userToken
 * @returns {Promise<GitHubUser>}
 */
export async function getUser(deps, userToken) {
  const user = await githubRequest(deps, 'GET', '/user', { token: userToken });
  const createdAt = Date.parse(user?.created_at ?? '');
  if (
    !Number.isSafeInteger(user?.id) ||
    user.id <= 0 ||
    typeof user.login !== 'string' ||
    !Number.isFinite(createdAt)
  ) {
    throw new GitHubError('failed', 200, {
      message: 'GET /user answered without an id, login or created_at',
    });
  }
  return { id: user.id, login: user.login, createdAt };
}

/**
 * The JSON Web Token that authenticates as the App itself, for the two calls
 * that mint an installation token. Backdated a minute for clock drift and
 * valid for nine, inside GitHub's ten-minute ceiling.
 * @param {string} appId
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {number} nowMs
 * @returns {string}
 */
export function createAppJwt(appId, privateKey, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: Number(appId) })}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned, 'utf8'), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** @type {{key: string, token: string, expiresAt: number}|null} */
let cachedToken = null;

/** Forget the cached installation token (tests; and after GitHub rejects it). */
export function clearInstallationTokenCache() {
  cachedToken = null;
}

/**
 * An installation token for the uploads repository with `contents: write`,
 * reused from module scope while it has more than five minutes left.
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {import('./config.mjs').UploadsConfig} config
 * @returns {Promise<string>}
 */
export async function installationToken(deps, config) {
  const key = `${config.appId}:${config.owner}/${config.repo}`;
  if (
    cachedToken &&
    cachedToken.key === key &&
    deps.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.token;
  }
  cachedToken = null;
  const jwt = createAppJwt(config.appId, config.privateKey, deps.now());
  const installation = await githubRequest(
    deps,
    'GET',
    `/repos/${config.owner}/${config.repo}/installation`,
    {
      token: jwt,
    }
  );
  if (!Number.isSafeInteger(installation?.id) || installation.id <= 0) {
    throw new GitHubError('failed', 200, { message: 'installation lookup answered without an id' });
  }
  const minted = await githubRequest(deps, 'POST', `/app/installations/${installation.id}/access_tokens`, {
    token: jwt,
    body: { repositories: [config.repo], permissions: { contents: 'write' } },
  });
  const expiresAt = Date.parse(minted?.expires_at ?? '');
  if (typeof minted?.token !== 'string' || !TOKEN_PATTERN.test(minted.token) || !Number.isFinite(expiresAt)) {
    throw new GitHubError('failed', 201, { message: 'token endpoint answered without a usable token' });
  }
  cachedToken = { key, token: minted.token, expiresAt };
  return minted.token;
}
