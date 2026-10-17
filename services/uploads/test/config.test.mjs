/**
 * The upload service's configuration: every variable is checked, and while
 * any is missing or malformed every upload and delete is refused before
 * GitHub is called.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { normalizePem, parseAllowedOrigins, readConfig } from '../lib/config.mjs';
import { handleUpload } from '../lib/upload.mjs';
import { ENV, NOW, PRIVATE_PEM, SITE, fakeGitHub, png, request } from './helpers.mjs';

let logged = [];
const realError = console.error;
test.beforeEach(() => {
  logged = [];
  console.error = (...args) => logged.push(args.join(' '));
});
test.afterEach(() => {
  console.error = realError;
});

const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

/** Every broken configuration, and what its error names. */
const BROKEN = [
  [{}, /UPLOADS_APP_ID, UPLOADS_APP_PRIVATE_KEY, UPLOADS_REPO, ALLOWED_ORIGIN/],
  [{ ...ENV, UPLOADS_APP_ID: '' }, /Missing environment variable: UPLOADS_APP_ID/],
  [{ ...ENV, UPLOADS_APP_PRIVATE_KEY: ' ' }, /UPLOADS_APP_PRIVATE_KEY/],
  [{ ...ENV, UPLOADS_REPO: undefined }, /UPLOADS_REPO/],
  [{ ...ENV, ALLOWED_ORIGIN: '' }, /ALLOWED_ORIGIN/],
  [{ ...ENV, UPLOADS_APP_ID: 'Iv23liClient' }, /App ID/],
  [{ ...ENV, UPLOADS_APP_ID: '0' }, /App ID/],
  [{ ...ENV, UPLOADS_APP_PRIVATE_KEY: 'not a key' }, /not a PEM private key/],
  [{ ...ENV, UPLOADS_APP_PRIVATE_KEY: EC_PEM }, /not an RSA key/],
  [{ ...ENV, UPLOADS_REPO: 'catalog-uploads' }, /owner\/name/],
  [{ ...ENV, UPLOADS_REPO: 'acme/catalog/uploads' }, /owner\/name/],
  [{ ...ENV, UPLOADS_REPO: 'acme/..' }, /owner\/name/],
  [{ ...ENV, UPLOADS_REPO: '-acme/uploads' }, /owner\/name/],
  [{ ...ENV, UPLOADS_REPO: 'acme/up loads' }, /owner\/name/],
  [{ ...ENV, ALLOWED_ORIGIN: `${SITE}/` }, /origin only/],
  [{ ...ENV, ALLOWED_ORIGIN: 'http://acme.github.io' }, /https/],
  [{ ...ENV, ALLOWED_ORIGIN: 'acme.github.io' }, /not a URL/],
  [{ ...ENV, MIN_ACCOUNT_AGE_DAYS: 'thirty' }, /MIN_ACCOUNT_AGE_DAYS/],
  [{ ...ENV, MIN_ACCOUNT_AGE_DAYS: '-1' }, /MIN_ACCOUNT_AGE_DAYS/],
  [{ ...ENV, MIN_ACCOUNT_AGE_DAYS: '1.5' }, /MIN_ACCOUNT_AGE_DAYS/],
];

test('readConfig fails closed on every missing or malformed setting, without echoing the key', () => {
  for (const [env, pattern] of BROKEN) {
    const config = readConfig(env);
    assert.match(config.error, pattern, JSON.stringify(Object.keys(env)));
    assert.equal(config.privateKey, null);
    assert.doesNotMatch(config.error, /BEGIN|PRIVATE KEY-----/);
  }
});

test('readConfig accepts a good configuration, a one-line key with \\n escapes, and a blank account age', () => {
  const config = readConfig(ENV);
  assert.equal(config.error, '');
  assert.equal(config.appId, '123456');
  assert.equal(config.owner, 'acme');
  assert.equal(config.repo, 'catalog-uploads');
  assert.deepEqual(config.origins, [SITE]);
  assert.equal(config.minAccountAgeDays, 0);

  const oneLine = PRIVATE_PEM.trim().replace(/\n/g, '\\n');
  assert.ok(!oneLine.includes('\n'));
  assert.equal(normalizePem(oneLine), PRIVATE_PEM.trim());
  const escaped = readConfig({ ...ENV, UPLOADS_APP_PRIVATE_KEY: oneLine, MIN_ACCOUNT_AGE_DAYS: ' ' });
  assert.equal(escaped.error, '');
  assert.equal(escaped.minAccountAgeDays, 0);
  assert.equal(readConfig({ ...ENV, MIN_ACCOUNT_AGE_DAYS: '30' }).minAccountAgeDays, 30);
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

test('a broken configuration refuses every upload and delete before GitHub is called', async () => {
  for (const [env] of BROKEN) {
    for (const method of ['POST', 'DELETE']) {
      const github = fakeGitHub();
      const response = await handleUpload(
        request(method, { body: method === 'POST' ? png() : undefined, query: '?ref=x' }),
        env,
        { fetch: github, now: () => NOW }
      );
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error, 'not_configured');
      assert.match(body.message, /not set up/);
      assert.equal(github.calls.length, 0);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      // The page still gets to read the answer when ALLOWED_ORIGIN itself is fine.
      const originOk = parseAllowedOrigins(env.ALLOWED_ORIGIN).origins.includes(SITE);
      assert.equal(response.headers.get('access-control-allow-origin'), originOk ? SITE : null);
    }
  }
  assert.ok(logged.every((line) => line.startsWith('uploads: refusing every request:')));
  assert.doesNotMatch(logged.join('\n'), /PRIVATE KEY/);
});
