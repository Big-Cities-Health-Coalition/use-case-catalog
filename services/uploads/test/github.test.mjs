/**
 * The uploads App's authentication (RS256 JWT, installation token and its
 * cache) and how GitHub's answers are read, with a stubbed `fetch`.
 */
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import test from 'node:test';

import { readConfig } from '../lib/config.mjs';
import {
  API_VERSION,
  GitHubError,
  USER_AGENT,
  clearInstallationTokenCache,
  createAppJwt,
  getUser,
  githubRequest,
  installationToken,
  rateLimitRetryAfter,
} from '../lib/github.mjs';
import {
  ENV,
  INSTALLATION_ID,
  INSTALL_TOKEN,
  NOW,
  PUBLIC_KEY,
  USER_TOKEN,
  fakeGitHub,
  json,
} from './helpers.mjs';

const CONFIG = readConfig(ENV);

test.beforeEach(() => clearInstallationTokenCache());

/** @param {string} jwt */
function decode(jwt) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

test('the App JWT is RS256 with iat now-60, exp now+540, iss the App ID, and verifies with the public key', () => {
  const jwt = createAppJwt(CONFIG.appId, CONFIG.privateKey, NOW + 999);
  const { header, payload, signed, signature } = decode(jwt);
  const now = Math.floor(NOW / 1000);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(payload, { iat: now - 60, exp: now + 540, iss: 123456 });
  assert.equal(verify('RSA-SHA256', Buffer.from(signed), PUBLIC_KEY, signature), true);
  assert.equal(verify('RSA-SHA256', Buffer.from(signed + 'x'), PUBLIC_KEY, signature), false);
});

test('installationToken looks up the installation with the JWT and asks for contents:write on the one repository', async () => {
  const github = fakeGitHub();
  const token = await installationToken({ fetch: github, now: () => NOW }, CONFIG);
  assert.equal(token, INSTALL_TOKEN);
  assert.deepEqual(
    github.calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET /repos/acme/catalog-uploads/installation',
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
    ]
  );
  for (const call of github.calls) {
    const jwt = call.auth.replace(/^Bearer /, '');
    assert.equal(decode(jwt).payload.iss, 123456);
    assert.equal(call.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(call.headers['User-Agent'], USER_AGENT);
  }
  assert.deepEqual(github.calls[1].body, {
    repositories: ['catalog-uploads'],
    permissions: { contents: 'write' },
  });
});

test('the installation token is reused until five minutes before it expires, then minted again', async () => {
  let now = NOW;
  const github = fakeGitHub({ now: () => now });
  const deps = { fetch: github, now: () => now };
  await installationToken(deps, CONFIG);
  now += 54 * 60 * 1000; // 6 minutes left
  await installationToken(deps, CONFIG);
  assert.equal(github.calls.length, 2, 'reused');
  now += 2 * 60 * 1000; // 4 minutes left
  await installationToken(deps, CONFIG);
  assert.equal(github.calls.length, 4, 'refreshed');

  // A different App never gets the cached token.
  await installationToken(deps, { ...CONFIG, appId: '999' });
  assert.equal(github.calls.length, 6);

  clearInstallationTokenCache();
  await installationToken(deps, CONFIG);
  assert.equal(github.calls.length, 8);
});

test('installationToken refuses an answer without a usable token', async () => {
  const github = fakeGitHub({
    routes: { [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: () => json(201, { token: 'x' }) },
  });
  await assert.rejects(installationToken({ fetch: github, now: () => NOW }, CONFIG), (error) => {
    return error instanceof GitHubError && error.kind === 'failed';
  });
  const noId = fakeGitHub({
    routes: { 'GET /repos/acme/catalog-uploads/installation': () => json(200, {}) },
  });
  await assert.rejects(installationToken({ fetch: noId, now: () => NOW }, CONFIG), GitHubError);
});

test('rateLimitRetryAfter reads retry-after, the primary-limit reset, and secondary-limit wording', () => {
  const at = (status, headers = {}) => new Response(null, { status, headers });
  assert.equal(rateLimitRetryAfter(at(403, { 'retry-after': '30' }), '', NOW), 30);
  assert.equal(rateLimitRetryAfter(at(429, { 'retry-after': '0' }), '', NOW), 1);
  assert.equal(rateLimitRetryAfter(at(429, { 'retry-after': '99999' }), '', NOW), 3600);
  const reset = String(Math.floor(NOW / 1000) + 120);
  assert.equal(
    rateLimitRetryAfter(at(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), '', NOW),
    120
  );
  assert.equal(rateLimitRetryAfter(at(403), 'You have exceeded a secondary rate limit.', NOW), 60);
  assert.equal(rateLimitRetryAfter(at(429), '', NOW), 60);
  assert.equal(rateLimitRetryAfter(at(403), 'Resource not accessible by integration', NOW), 0);
  assert.equal(rateLimitRetryAfter(at(500, { 'retry-after': '30' }), '', NOW), 0);
});

test('githubRequest maps statuses to kinds and turns a network failure into "failed"', async () => {
  const deps = (answer) => ({ fetch: async () => answer(), now: () => NOW });
  const kind = async (answer) => {
    try {
      await githubRequest(deps(answer), 'GET', '/x', { token: 't' });
      return 'ok';
    } catch (error) {
      return error.kind;
    }
  };
  assert.equal(await kind(() => json(401, { message: 'Bad credentials' })), 'unauthorized');
  assert.equal(await kind(() => json(404, { message: 'Not Found' })), 'not_found');
  assert.equal(await kind(() => json(422, { message: 'Reference already exists' })), 'unprocessable');
  assert.equal(await kind(() => new Response('<html>', { status: 502 })), 'failed');
  assert.equal(
    await kind(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }),
    'failed'
  );
  assert.equal(await kind(() => new Response(null, { status: 204 })), 'ok');
});

test('getUser returns the numeric id, login and creation time, and refuses a malformed answer', async () => {
  const github = fakeGitHub();
  const user = await getUser({ fetch: github, now: () => NOW }, USER_TOKEN);
  assert.deepEqual(user, { id: 4242, login: 'octo', createdAt: Date.parse('2015-01-01T00:00:00Z') });
  for (const bad of [
    { id: '4242', login: 'octo', created_at: '2015-01-01T00:00:00Z' },
    { id: 1, login: 'x' },
    null,
  ]) {
    const broken = fakeGitHub({ routes: { 'GET /user': () => json(200, bad) } });
    await assert.rejects(getUser({ fetch: broken, now: () => NOW }, USER_TOKEN), GitHubError);
  }
});
