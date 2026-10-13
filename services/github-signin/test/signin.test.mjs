/**
 * The sign-in service's two handlers, called directly with WHATWG Requests and
 * a stubbed `fetch` — no network, no Vercel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as login from '../api/login.mjs';
import * as callback from '../api/callback.mjs';
import {
  AUTHORIZE_URL,
  COOKIE_NAME,
  ERROR_MESSAGE,
  TOKEN_MESSAGE,
  TOKEN_URL,
  codeChallenge,
  handleCallback,
  handleLogin,
  parseAllowedOrigins,
  readConfig,
  safeEqual,
} from '../lib/signin.mjs';

const SERVICE = 'https://signin.example.app';
const SITE = 'https://acme.github.io';
const ENV = {
  GITHUB_CLIENT_ID: 'Iv23liExampleClient',
  GITHUB_CLIENT_SECRET: 'not-a-real-secret-0123456789abcdef',
  ALLOWED_ORIGIN: SITE,
};
const TOKEN = 'ghu_' + 'A'.repeat(36);

// The handlers log refusals with console.error; keep the test output clean,
// and keep what they logged so the tests can prove no secret is in it.
let logged = [];
const realError = console.error;
test.beforeEach(() => {
  logged = [];
  console.error = (...args) => logged.push(args.join(' '));
});
test.afterEach(() => {
  console.error = realError;
});

/** @param {string} path @param {RequestInit} [init] */
const request = (path, init) => new Request(SERVICE + path, init);

/**
 * Start a sign-in and return what the browser would carry to the callback.
 * @param {Record<string, string>} [env]
 * @param {string} [query]
 */
async function startLogin(env = ENV, query = '') {
  const response = await handleLogin(request('/api/login' + query), env);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie.split(';')[0];
  return { response, location, setCookie, cookie, state: location.searchParams.get('state') };
}

/**
 * A fake `fetch` for GitHub's token endpoint.
 * @param {object|Error|((url: string, init: RequestInit) => Response)} answer
 */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(url, init);
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

/** The message the callback page would post, and where to: read from its script. */
function postedMessage(html) {
  const match = html.match(/var message = (.*);\n\s*var target = (.*);/);
  if (!match) return null;
  return { message: JSON.parse(match[1]), target: JSON.parse(match[2]) };
}

test('readConfig fails closed on every missing or malformed setting', () => {
  assert.match(readConfig({}).error, /GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_ORIGIN/);
  assert.match(readConfig({ ...ENV, GITHUB_CLIENT_SECRET: '  ' }).error, /GITHUB_CLIENT_SECRET/);
  assert.match(readConfig({ ...ENV, GITHUB_CLIENT_ID: 'bad id<script>' }).error, /client ID/);
  assert.match(readConfig({ ...ENV, ALLOWED_ORIGIN: 'https://acme.github.io/' }).error, /origin only/);
  assert.match(readConfig({ ...ENV, ALLOWED_ORIGIN: 'http://acme.github.io' }).error, /https/);
  assert.match(readConfig({ ...ENV, ALLOWED_ORIGIN: 'acme.github.io' }).error, /not a URL/);
  assert.equal(readConfig(ENV).error, '');
  assert.deepEqual(readConfig({ ...ENV, ALLOWED_ORIGIN: ` ${SITE} , http://localhost:4000 ` }).origins, [
    SITE,
    'http://localhost:4000',
  ]);
});

test('parseAllowedOrigins allows plain http only for a loopback address', () => {
  assert.equal(parseAllowedOrigins('http://127.0.0.1:4000').error, '');
  assert.equal(parseAllowedOrigins('http://[::1]:4000').error, '');
  assert.match(parseAllowedOrigins('http://10.0.0.5').error, /https/);
  assert.match(parseAllowedOrigins(',').error, /empty/);
});

test('safeEqual compares exactly, and never matches empty strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
});

test('login redirects to GitHub with state, PKCE and the callback, and keeps both secrets in a __Host- cookie', async () => {
  const { response, location, setCookie, state } = await startLogin();
  assert.equal(location.origin + location.pathname, AUTHORIZE_URL);
  assert.equal(location.searchParams.get('client_id'), ENV.GITHUB_CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), `${SERVICE}/api/callback`);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(location.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(location.searchParams.has('client_secret'), false, 'the secret never reaches the browser');

  assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]+;`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
    assert.ok(setCookie.includes(flag), `cookie lacks ${flag}`);
  }
  const stored = JSON.parse(Buffer.from(setCookie.split(';')[0].split('=')[1], 'base64url').toString());
  assert.equal(stored.state, state);
  assert.equal(stored.origin, SITE);
  assert.equal(codeChallenge(stored.verifier), location.searchParams.get('code_challenge'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('every login gets a fresh state and verifier', async () => {
  const first = await startLogin();
  const second = await startLogin();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.cookie, second.cookie);
});

test('login takes ?origin= only when it is one of the allowed sites', async () => {
  const env = { ...ENV, ALLOWED_ORIGIN: `${SITE},https://catalog.example.org` };
  const chosen = await startLogin(env, '?origin=' + encodeURIComponent('https://catalog.example.org'));
  const stored = JSON.parse(Buffer.from(chosen.cookie.split('=')[1], 'base64url').toString());
  assert.equal(stored.origin, 'https://catalog.example.org');

  const foreign = await handleLogin(request('/api/login?origin=https%3A%2F%2Fevil.example'), env);
  assert.equal(foreign.status, 400);
  assert.equal(foreign.headers.get('set-cookie'), null);

  const ambiguous = await handleLogin(request('/api/login'), env);
  assert.equal(ambiguous.status, 400, 'with two sites allowed, the page must say which it is');
});

test('login and callback refuse to run with a broken configuration, and say so in a page', async () => {
  for (const handler of [handleLogin, handleCallback]) {
    const response = await handler(request('/api/login'), { ...ENV, GITHUB_CLIENT_SECRET: '' });
    assert.equal(response.status, 500);
    const html = await response.text();
    assert.match(html, /not set up/);
    assert.equal(postedMessage(html), null, 'no message without a trusted target');
    assert.match(logged.join('\n'), /GITHUB_CLIENT_SECRET/);
    assert.doesNotMatch(logged.join('\n'), new RegExp(ENV.GITHUB_CLIENT_ID));
  }
});

test('login and callback answer only GET (and HEAD)', async () => {
  const post = await handleLogin(request('/api/login', { method: 'POST' }), ENV);
  assert.equal(post.status, 405);
  const head = await handleLogin(request('/api/login', { method: 'HEAD' }), ENV);
  assert.equal(head.status, 302);
  const postBack = await handleCallback(request('/api/callback', { method: 'POST' }), ENV, {
    fetch: fakeFetch({}),
  });
  assert.equal(postBack.status, 405);
});

test('the Vercel entry points wire the handlers to process.env', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const started = await login.GET(request('/api/login'));
    assert.equal(started.status, 302);
    const finished = await callback.GET(request('/api/callback?error=access_denied'));
    assert.equal(finished.status, 400);
  } finally {
    for (const key of Object.keys(ENV)) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});

test('callback trades the code for a token and posts it to the allowed site only', async () => {
  const { cookie, state } = await startLogin();
  const fetchImpl = fakeFetch({
    access_token: TOKEN,
    expires_in: 28800,
    refresh_token: 'ghr_secret',
    token_type: 'bearer',
  });
  const response = await handleCallback(
    request(`/api/callback?code=abc123&state=${state}`, { headers: { cookie } }),
    ENV,
    { fetch: fetchImpl }
  );
  assert.equal(response.status, 200);

  // The exchange: the code, the secret, the same redirect_uri and the verifier.
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, TOKEN_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Accept, 'application/json');
  const sent = new URLSearchParams(init.body);
  assert.equal(sent.get('client_id'), ENV.GITHUB_CLIENT_ID);
  assert.equal(sent.get('client_secret'), ENV.GITHUB_CLIENT_SECRET);
  assert.equal(sent.get('code'), 'abc123');
  assert.equal(sent.get('redirect_uri'), `${SERVICE}/api/callback`);
  const stored = JSON.parse(Buffer.from(cookie.split('=')[1], 'base64url').toString());
  assert.equal(sent.get('code_verifier'), stored.verifier);

  const html = await response.text();
  const posted = postedMessage(html);
  assert.deepEqual(posted, {
    message: { type: TOKEN_MESSAGE, token: TOKEN, expires_in: 28800 },
    target: SITE,
  });
  assert.doesNotMatch(html, /ghr_secret/, 'the refresh token stays on the server');
  assert.match(html, /window\.close\(\)/);

  // Headers: no caching, no referrer, only the page's own script may run, cookie cleared.
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(response.headers.get('location'), null, 'the token never rides in a URL');
  assert.doesNotMatch(response.headers.get('set-cookie'), new RegExp(TOKEN), 'nor in a cookie');
  assert.doesNotMatch(logged.join('\n'), /ghu_/, 'nor in a log line');
});

test('callback leaves expires_in out when the app issues non-expiring tokens', async () => {
  const { cookie, state } = await startLogin();
  const response = await handleCallback(
    request(`/api/callback?code=abc&state=${state}`, { headers: { cookie } }),
    ENV,
    { fetch: fakeFetch({ access_token: TOKEN, token_type: 'bearer', scope: '' }) }
  );
  assert.deepEqual(postedMessage(await response.text()).message, { type: TOKEN_MESSAGE, token: TOKEN });
});

test('callback escapes everything it writes into the page', async () => {
  const { cookie, state } = await startLogin();
  const response = await handleCallback(
    request(`/api/callback?code=abc&state=${state}`, { headers: { cookie } }),
    ENV,
    { fetch: fakeFetch({ access_token: '</script><script>alert(1)</script>' }) }
  );
  const html = await response.text();
  assert.equal(response.status, 502, 'a token that is not token-shaped is refused');
  assert.doesNotMatch(html, /<script>alert/);
});

/**
 * Run the callback with the given query and cookie against a token endpoint
 * that must not be called, and return the posted error.
 */
async function refusedCallback(query, cookie) {
  const fetchImpl = fakeFetch(new Error('the token endpoint must not be called'));
  const headers = cookie ? { cookie } : {};
  const response = await handleCallback(request('/api/callback' + query, { headers }), ENV, {
    fetch: fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 0, `${query}: GitHub was asked for a token`);
  const html = await response.text();
  return { response, html, posted: postedMessage(html) };
}

test('callback refuses a state that does not match the cookie, without asking GitHub for a token', async () => {
  const { cookie } = await startLogin();
  const other = 'B'.repeat(43);
  const { response, posted } = await refusedCallback(`?code=abc&state=${other}`, cookie);
  assert.equal(response.status, 400);
  assert.equal(posted.message.type, ERROR_MESSAGE);
  assert.match(posted.message.message, /did not start here/);
  assert.equal(posted.target, SITE);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('callback refuses a missing cookie, a missing code and a malformed state', async () => {
  const { cookie, state } = await startLogin();
  const noCookie = await refusedCallback(`?code=abc&state=${state}`, '');
  assert.match(noCookie.posted.message.message, /took too long/);
  const tampered = await refusedCallback(`?code=abc&state=${state}`, `${COOKIE_NAME}=not-base64-json`);
  assert.match(tampered.posted.message.message, /took too long/);
  const noCode = await refusedCallback(`?state=${state}`, cookie);
  assert.match(noCode.posted.message.message, /incomplete/);
  const badCode = await refusedCallback(`?code=${encodeURIComponent('a b<')}&state=${state}`, cookie);
  assert.match(badCode.posted.message.message, /incomplete/);
  const shortState = await refusedCallback('?code=abc&state=short', cookie);
  assert.match(shortState.posted.message.message, /incomplete/);
});

test('callback reports a sign-in cancelled on GitHub', async () => {
  const { cookie } = await startLogin();
  const { response, posted } = await refusedCallback('?error=access_denied&state=x', cookie);
  assert.equal(response.status, 400);
  assert.deepEqual(posted, {
    message: { type: ERROR_MESSAGE, message: 'Sign-in was cancelled on GitHub.' },
    target: SITE,
  });
  const other = await refusedCallback('?error=server_error', cookie);
  assert.match(other.posted.message.message, /did not complete/);
});

test('callback posts errors only to an allowed site: the cookie origin, or the only one configured', async () => {
  const env = { ...ENV, ALLOWED_ORIGIN: `${SITE},https://catalog.example.org` };
  // Two sites and no cookie: nobody to tell, so the page only shows the text.
  const response = await handleCallback(request('/api/callback?code=abc&state=x'), env, {
    fetch: fakeFetch({}),
  });
  assert.equal(postedMessage(await response.text()), null);

  // A cookie naming a site that is no longer allowed is not trusted either.
  const started = await startLogin(env, '?origin=' + encodeURIComponent('https://catalog.example.org'));
  const narrowed = { ...ENV, ALLOWED_ORIGIN: SITE };
  const later = await handleCallback(
    request(`/api/callback?code=abc&state=${started.state}`, { headers: { cookie: started.cookie } }),
    narrowed,
    { fetch: fakeFetch(new Error('must not be called')) }
  );
  const posted = postedMessage(await later.text());
  assert.equal(posted.target, SITE, 'the error goes to the one allowed site');
  assert.equal(posted.message.type, ERROR_MESSAGE);
});

test('callback maps GitHub token errors to plain words and logs only the code', async () => {
  const { cookie, state } = await startLogin();
  const response = await handleCallback(
    request(`/api/callback?code=abc&state=${state}`, { headers: { cookie } }),
    ENV,
    {
      fetch: fakeFetch({
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      }),
    }
  );
  assert.equal(response.status, 400);
  const posted = postedMessage(await response.text());
  assert.match(posted.message.message, /expired or was already used/);
  assert.match(logged.join('\n'), /bad_verification_code/);
  assert.doesNotMatch(logged.join('\n'), /incorrect or expired/);

  const unknown = await handleCallback(
    request(`/api/callback?code=abc&state=${state}`, { headers: { cookie } }),
    ENV,
    { fetch: fakeFetch({ error: 'something_new' }) }
  );
  assert.match(postedMessage(await unknown.text()).message.message, /refused the sign-in/);
});

test('callback survives GitHub being down, slow or answering nonsense', async () => {
  const { cookie, state } = await startLogin();
  const call = (fetchImpl) =>
    handleCallback(request(`/api/callback?code=abc&state=${state}`, { headers: { cookie } }), ENV, {
      fetch: fetchImpl,
    });

  const down = await call(fakeFetch(() => new Response('oops', { status: 503 })));
  assert.equal(down.status, 502);
  assert.match(postedMessage(await down.text()).message.message, /could not finish/);

  const timeout = await call(fakeFetch(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  assert.equal(timeout.status, 502);
  assert.match(postedMessage(await timeout.text()).message.message, /could not be reached/);
  assert.match(logged.join('\n'), /TimeoutError/);

  const notJson = await call(fakeFetch(() => new Response('<html>', { status: 200 })));
  assert.equal(notJson.status, 502);

  const empty = await call(fakeFetch({}));
  assert.equal(empty.status, 502);
  assert.match(postedMessage(await empty.text()).message.message, /usable sign-in/);
});
