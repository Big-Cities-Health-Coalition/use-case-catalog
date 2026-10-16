/**
 * "Sign in with GitHub" for a PHCT site's /submit/ page: the two steps of a
 * GitHub App's web flow that cannot run in a browser.
 *
 * GitHub's token endpoint sends no CORS headers and needs the app's client
 * secret, so a static GitHub Pages site cannot finish the sign-in itself. This
 * service does exactly that and nothing more:
 *
 *   GET /api/login     picks a random `state` and a PKCE verifier, keeps both
 *                      in a short-lived HttpOnly cookie on this service's own
 *                      domain, and sends the browser to GitHub's authorize page.
 *   GET /api/callback  checks `state` against the cookie, trades the code (plus
 *                      the client secret and the verifier) for a user access
 *                      token, and answers with a tiny page that hands the token
 *                      to the /submit/ tab that opened this window, through
 *                      `postMessage` aimed at that site's exact origin, then
 *                      closes.
 *
 * The token never appears in a URL, a cookie or a log line, and the refresh
 * token GitHub returns is dropped here: the browser gets a token that lasts
 * eight hours at most (when the app keeps "Expire user authorization tokens"
 * on) and signs in again after that.
 *
 * Every handler takes a WHATWG Request and returns a Response, so the tests
 * call them directly with a stubbed `fetch`. Zero runtime dependencies.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** The message types the /submit/ page listens for (assets/js/submit/direct.js). */
export const TOKEN_MESSAGE = 'phct-github-token';
export const ERROR_MESSAGE = 'phct-github-error';

/**
 * `__Host-` pins the cookie to this exact host, over HTTPS, at path `/`: no
 * sibling subdomain can set or read it.
 */
export const COOKIE_NAME = '__Host-phct-signin';

/** Ten minutes to finish signing in on GitHub before the state expires. */
export const COOKIE_MAX_AGE = 600;

/** How long to wait for GitHub's token endpoint. */
export const TOKEN_TIMEOUT_MS = 10000;

const REQUIRED_ENV = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ALLOWED_ORIGIN'];

/** A GitHub App client ID (`Iv23li…`); OAuth app IDs (`Ov23li…`) share the shape. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
/** What GitHub hands back as `code`; generous, but no room for markup or spaces. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
/** `state` and the PKCE verifier are 32 random bytes in base64url: 43 characters. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** User access tokens are `ghu_…`; accept any opaque token of that alphabet. */
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,512}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The site origins allowed to receive a token: a comma-separated list, each an
 * exact origin (`https://example.github.io`, no path and no trailing slash).
 * HTTPS only, except a loopback address for local testing.
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
 * Read and check the configuration. Fails closed: anything missing or malformed
 * is an error, and the handlers then refuse every request.
 * @param {Record<string, string|undefined>} env
 * @returns {{clientId: string, clientSecret: string, origins: string[], error: string}}
 */
export function readConfig(env) {
  const source = env ?? {};
  const missing = REQUIRED_ENV.filter((name) => !String(source[name] ?? '').trim());
  const empty = { clientId: '', clientSecret: '', origins: [] };
  if (missing.length > 0) {
    return {
      ...empty,
      error: `Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    };
  }
  const clientId = String(source.GITHUB_CLIENT_ID).trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return { ...empty, error: 'GITHUB_CLIENT_ID is not a GitHub App client ID.' };
  }
  const { origins, error } = parseAllowedOrigins(source.ALLOWED_ORIGIN);
  if (error) return { ...empty, error };
  return { clientId, clientSecret: String(source.GITHUB_CLIENT_SECRET).trim(), origins, error: '' };
}

/** @returns {string} 32 random bytes, base64url (43 characters) */
function nonce() {
  return randomBytes(32).toString('base64url');
}

/**
 * The PKCE S256 challenge for a verifier.
 * @param {string} verifier
 * @returns {string}
 */
export function codeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Compare two secrets without leaking where they differ.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * The callback address GitHub sends the browser back to: this deployment's own
 * `/api/callback`. It has to be one of the app's registered callback URLs, and
 * the token exchange repeats it exactly.
 * @param {Request} request
 * @returns {string}
 */
export function callbackUrl(request) {
  return new URL('/api/callback', request.url).href;
}

/**
 * @param {{state: string, verifier: string, origin: string}} value
 * @returns {string}
 */
function encodeCookie(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Read the sign-in cookie from a request. Anything unexpected reads as absent.
 * @param {Request} request
 * @returns {{state: string, verifier: string, origin: string}|null}
 */
export function readCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1 || part.slice(0, at).trim() !== COOKIE_NAME) continue;
    try {
      const value = JSON.parse(Buffer.from(part.slice(at + 1).trim(), 'base64url').toString('utf8'));
      if (
        value &&
        typeof value.state === 'string' &&
        NONCE_PATTERN.test(value.state) &&
        typeof value.verifier === 'string' &&
        NONCE_PATTERN.test(value.verifier) &&
        typeof value.origin === 'string'
      ) {
        return { state: value.state, verifier: value.verifier, origin: value.origin };
      }
    } catch {
      // A cookie that is not ours, or was tampered with, is no cookie at all.
    }
    return null;
  }
  return null;
}

/**
 * @param {string} value '' clears the cookie
 * @returns {string} a Set-Cookie header value
 */
function cookieHeader(value) {
  const age = value ? COOKIE_MAX_AGE : 0;
  return `${COOKIE_NAME}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Headers on every response: nothing here may be cached or leak a referrer. */
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * @param {string} text
 * @returns {string} text safe inside HTML element content
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {unknown} value
 * @returns {string} JSON that cannot close the <script> element it sits in
 */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The page the sign-in window ends on. With a target origin it posts `message`
 * to the window that opened it — only if that window is still showing the
 * allowed site, which `postMessage`'s target origin enforces — and closes.
 * Without one (the configuration is broken, or the request names no allowed
 * site) it only shows the text.
 *
 * @param {{status: number, text: string, message?: object, targetOrigin?: string, clearCookie?: boolean}} options
 * @returns {Response}
 */
export function page({ status, text, message, targetOrigin, clearCookie = false }) {
  const scriptNonce = nonce();
  const script =
    message && targetOrigin
      ? `<script nonce="${scriptNonce}">(function () {
  var message = ${scriptJson(message)};
  var target = ${scriptJson(targetOrigin)};
  try { if (window.opener) window.opener.postMessage(message, target); } catch (error) {}
  window.close();
})();</script>`
      : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in with GitHub</title>
</head>
<body>
<p>${escapeHtml(text)}</p>
${script}
</body>
</html>
`;
  const headers = new Headers({
    ...BASE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    // Only the one inline script above may run; nothing may load or frame it.
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  if (clearCookie) headers.append('Set-Cookie', cookieHeader(''));
  return new Response(html, { status, headers });
}

/** @param {Request} request @returns {Response|null} a 405 for anything but GET/HEAD */
function onlyGet(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  return page({ status: 405, text: 'This address only answers GET requests.' });
}

/**
 * GET /api/login[?origin=<site origin>]
 *
 * `origin` names which allowed site is signing in (the /submit/ page sends its
 * own `location.origin`); it may be left out when ALLOWED_ORIGIN lists one.
 *
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<Response>}
 */
export async function handleLogin(request, env) {
  const config = readConfig(env);
  if (config.error) {
    console.error(`github-signin: refusing to sign anyone in: ${config.error}`);
    return page({
      status: 500,
      text: 'Sign-in is not set up on this server yet. Close this window and use the other way of sending your answers.',
    });
  }
  const refused = onlyGet(request);
  if (refused) return refused;

  const url = new URL(request.url);
  const requested = url.searchParams.get('origin');
  let origin = '';
  if (requested !== null) {
    origin = config.origins.find((allowed) => allowed === requested) || '';
  } else if (config.origins.length === 1) {
    origin = config.origins[0];
  }
  if (!origin) {
    return page({
      status: 400,
      text: 'This sign-in server does not serve the site that sent you here. Close this window.',
    });
  }

  const state = nonce();
  const verifier = nonce();
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', callbackUrl(request));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', codeChallenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');

  const headers = new Headers({ ...BASE_HEADERS, Location: authorize.href });
  headers.append('Set-Cookie', cookieHeader(encodeCookie({ state, verifier, origin })));
  return new Response(null, { status: 302, headers });
}

/** What GitHub's token endpoint errors mean to a submitter. */
const TOKEN_ERRORS = {
  bad_verification_code:
    'GitHub said the sign-in code had expired or was already used. Try signing in again.',
  incorrect_client_credentials: 'The sign-in server is misconfigured (GitHub rejected its client secret).',
  redirect_uri_mismatch:
    'The sign-in server is misconfigured (its callback URL is not registered with the GitHub App).',
  unverified_user_email: 'GitHub needs you to verify your email address before you can sign in here.',
};

/**
 * GET /api/callback?code=…&state=…  (or ?error=… when the user said no)
 *
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @param {{fetch?: typeof fetch}} [deps] `fetch` is injectable for tests
 * @returns {Promise<Response>}
 */
export async function handleCallback(request, env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const config = readConfig(env);
  if (config.error) {
    console.error(`github-signin: refusing to finish a sign-in: ${config.error}`);
    return page({
      status: 500,
      text: 'Sign-in is not set up on this server yet. Close this window and use the other way of sending your answers.',
      clearCookie: true,
    });
  }
  const refused = onlyGet(request);
  if (refused) return refused;

  const saved = readCookie(request);
  // Where an error can be reported: the site this sign-in started from, when
  // the cookie still says so and that site is still allowed; otherwise the
  // only allowed site, when there is just one.
  const savedOrigin = saved && config.origins.includes(saved.origin) ? saved.origin : '';
  const target = savedOrigin || (config.origins.length === 1 ? config.origins[0] : '');
  const fail = (status, text) =>
    page({
      status,
      text: `${text} You can close this window.`,
      message: { type: ERROR_MESSAGE, message: text },
      targetOrigin: target,
      clearCookie: true,
    });

  const url = new URL(request.url);
  const githubError = url.searchParams.get('error');
  if (githubError !== null) {
    return fail(
      400,
      githubError === 'access_denied'
        ? 'Sign-in was cancelled on GitHub.'
        : 'GitHub did not complete the sign-in.'
    );
  }
  if (!saved || !savedOrigin) {
    return fail(400, 'This sign-in took too long or was started in another browser. Try signing in again.');
  }
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!CODE_PATTERN.test(code) || !NONCE_PATTERN.test(state)) {
    return fail(400, 'GitHub sent back an incomplete sign-in. Try signing in again.');
  }
  if (!safeEqual(state, saved.state)) {
    return fail(400, 'This sign-in did not start here, so it was refused. Try signing in again.');
  }

  let payload;
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl(request),
        code_verifier: saved.verifier,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`github-signin: GitHub's token endpoint answered HTTP ${response.status}.`);
      return fail(502, 'GitHub could not finish the sign-in just now. Try again in a minute.');
    }
    payload = await response.json();
  } catch (error) {
    console.error(`github-signin: the token exchange failed (${error?.name || 'Error'}).`);
    return fail(502, 'GitHub could not be reached to finish the sign-in. Try again in a minute.');
  }

  if (payload && typeof payload.error === 'string') {
    // The error code only: GitHub's description can echo request details.
    console.error(`github-signin: GitHub refused the token exchange: ${payload.error.slice(0, 64)}.`);
    return fail(400, TOKEN_ERRORS[payload.error] || 'GitHub refused the sign-in. Try signing in again.');
  }
  const token = payload?.access_token;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    console.error('github-signin: GitHub answered the token exchange without a usable token.');
    return fail(502, 'GitHub did not return a usable sign-in. Try signing in again.');
  }
  const message = { type: TOKEN_MESSAGE, token };
  // Present only when the app keeps "Expire user authorization tokens" on.
  if (Number.isInteger(payload.expires_in) && payload.expires_in > 0) message.expires_in = payload.expires_in;

  return page({
    status: 200,
    text: 'Signed in. This window closes by itself; if it does not, close it and return to the form.',
    message,
    targetOrigin: savedOrigin,
    clearCookie: true,
  });
}
