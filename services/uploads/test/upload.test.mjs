/**
 * /api/upload end to end: the handler called directly with WHATWG Requests
 * and a fake GitHub — CORS, sign-in, account age, headers, size, magic bytes,
 * per-user caps, the exact write sequence, rate limits and deletes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import * as api from '../api/upload.mjs';
import { clearInstallationTokenCache } from '../lib/github.mjs';
import { ALLOWED_HEADERS, MAX_BYTES, handleUpload, readCapped } from '../lib/upload.mjs';
import {
  ENV,
  INSTALLATION_ID,
  INSTALL_TOKEN,
  NOW,
  SERVICE,
  SET,
  SITE,
  USER_ID,
  USER_TOKEN,
  branch,
  fakeGitHub,
  file,
  json,
  png,
  request,
} from './helpers.mjs';

// Keep what the handler logs, on every console channel, so the tests can
// prove no token is ever in it.
let logged = [];
const real = { error: console.error, warn: console.warn, log: console.log, info: console.info };
test.beforeEach(() => {
  logged = [];
  for (const name of Object.keys(real)) console[name] = (...args) => logged.push(args.map(String).join(' '));
  clearInstallationTokenCache();
});
test.afterEach(() => {
  Object.assign(console, real);
});

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Each call starts without a cached installation token unless `keepToken`, so
 * every call exercises the minting routes its fake GitHub defines.
 * @param {Request} req @param {object} [options]
 */
async function call(req, { github = fakeGitHub(), env = ENV, now = () => NOW, keepToken = false } = {}) {
  if (!keepToken) clearInstallationTokenCache();
  const response = await handleUpload(req, env, { fetch: github, now });
  const text = response.status === 204 ? '' : await response.text();
  return { response, status: response.status, body: text ? JSON.parse(text) : null, github };
}

const writes = (github) => github.calls.filter((c) => c.method === 'POST' && c.path.includes('/git/'));

/** The answer a fake GitHub gives for a secondary rate limit. */
const secondary = (headers = {}) =>
  json(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }, headers);

test('the API module routes every method to the handler, configured from process.env', async () => {
  const saved = { ...process.env };
  for (const name of [...Object.keys(ENV), 'MIN_ACCOUNT_AGE_DAYS']) delete process.env[name];
  process.env.ALLOWED_ORIGIN = SITE;
  try {
    const preflight = await api.OPTIONS(
      new Request(`${SERVICE}/api/upload`, { method: 'OPTIONS', headers: { Origin: SITE } })
    );
    assert.equal(preflight.status, 204);
    for (const method of ['POST', 'DELETE', 'GET', 'PUT', 'PATCH']) {
      const response = await api[method](request(method, { body: method === 'POST' ? png() : undefined }));
      assert.equal(response.status, 500, method);
      assert.equal((await response.json()).error, 'not_configured');
    }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test('preflight from an allowed origin echoes it with the methods, headers and max-age', async () => {
  const { status, response } = await call(
    new Request(`${SERVICE}/api/upload`, { method: 'OPTIONS', headers: { Origin: SITE } })
  );
  assert.equal(status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE');
  assert.equal(response.headers.get('access-control-allow-headers'), ALLOWED_HEADERS);
  assert.equal(ALLOWED_HEADERS, 'Authorization, Content-Type, X-Upload-Set, X-Upload-Kind, X-Upload-Name');
  assert.equal(response.headers.get('access-control-max-age'), '600');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('preflight from any other origin, or none, is refused without CORS headers', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, {}]) {
    const { status, body, response } = await call(
      new Request(`${SERVICE}/api/upload`, { method: 'OPTIONS', headers })
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'origin_not_allowed');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('a POST or DELETE without an allowed Origin is refused before GitHub is called', async () => {
  for (const origin of [null, 'https://evil.example', `${SITE}.evil.example`]) {
    for (const method of ['POST', 'DELETE']) {
      const { status, body, github, response } = await call(
        request(method, { body: method === 'POST' ? png() : undefined, headers: { Origin: origin } })
      );
      assert.equal(status, 403);
      assert.equal(body.error, 'origin_not_allowed');
      assert.equal(github.calls.length, 0);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
});

test('other methods get a JSON 405 with CORS headers', async () => {
  for (const method of ['GET', 'PUT', 'PATCH']) {
    const { status, body, response, github } = await call(
      request(method, { body: method === 'GET' ? undefined : png() })
    );
    assert.equal(status, 405);
    assert.equal(body.error, 'method_not_allowed');
    assert.equal(response.headers.get('allow'), 'OPTIONS, POST, DELETE');
    assert.equal(response.headers.get('access-control-allow-origin'), SITE);
    assert.equal(github.calls.length, 0);
  }
});

test('a missing or malformed token is 401 without calling GitHub; a token GitHub rejects is 401', async () => {
  for (const authorization of [
    null,
    '',
    'token ' + USER_TOKEN,
    'Bearer',
    'Bearer short',
    `Bearer ${USER_TOKEN} x`,
  ]) {
    const { status, body, github, response } = await call(
      request('POST', { body: png(), headers: { Authorization: authorization } })
    );
    assert.equal(status, 401, String(authorization));
    assert.equal(body.error, 'unauthorized');
    assert.match(body.message, /Sign in again/);
    assert.equal(github.calls.length, 0);
    assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  }
  const revoked = 'ghu_' + 'R'.repeat(36);
  for (const method of ['POST', 'DELETE']) {
    const { status, github } = await call(
      request(method, {
        body: method === 'POST' ? png() : undefined,
        headers: { Authorization: `Bearer ${revoked}` },
      })
    );
    assert.equal(status, 401);
    assert.deepEqual(
      github.calls.map((c) => c.path),
      ['/user'],
      'nothing after GET /user'
    );
  }
  const forbidden = fakeGitHub({ routes: { 'GET /user': () => json(403, { message: 'Forbidden' }) } });
  assert.equal((await call(request('POST', { body: png() }), { github: forbidden })).status, 401);
  assert.doesNotMatch(logged.join('\n'), /ghu_/);
});

test('the submitter token goes only to GET /user and never into a log, even when GitHub fails', async () => {
  const failing = fakeGitHub({
    routes: { 'POST /repos/acme/catalog-uploads/git/blobs': () => json(500, { message: 'boom' }) },
  });
  const { status } = await call(request('POST', { body: png() }), { github: failing });
  assert.equal(status, 503);
  const down = fakeGitHub({ routes: { 'GET /user': () => new Response('bad gateway', { status: 502 }) } });
  assert.equal((await call(request('POST', { body: png() }), { github: down })).status, 503);
  assert.ok(logged.length > 0, 'the failures were logged');
  const all = logged.join('\n');
  assert.doesNotMatch(all, new RegExp(USER_TOKEN));
  assert.doesNotMatch(all, new RegExp(INSTALL_TOKEN));

  const { github } = await call(request('POST', { body: png() }));
  for (const c of github.calls) {
    const carriesUserToken = JSON.stringify(c).includes(USER_TOKEN);
    assert.equal(carriesUserToken, c.path === '/user', `${c.method} ${c.path}`);
  }
});

test('GitHub rate-limiting GET /user is a 429 with Retry-After', async () => {
  const github = fakeGitHub({
    routes: { 'GET /user': () => json(429, { message: 'slow down' }, { 'retry-after': '17' }) },
  });
  const { status, body, response } = await call(request('POST', { body: png() }), { github });
  assert.equal(status, 429);
  assert.equal(body.error, 'rate_limited');
  assert.equal(response.headers.get('retry-after'), '17');
  assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
});

test('MIN_ACCOUNT_AGE_DAYS refuses accounts younger than that, and accepts older ones', async () => {
  const env = { ...ENV, MIN_ACCOUNT_AGE_DAYS: '30' };
  const day = 24 * 60 * 60 * 1000;
  const young = fakeGitHub({
    user: { id: USER_ID, login: 'new', created_at: new Date(NOW - 29 * day).toISOString() },
  });
  const refused = await call(request('POST', { body: png() }), { github: young, env });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'account_too_new');
  assert.deepEqual(
    young.calls.map((c) => c.path),
    ['/user']
  );

  const old = fakeGitHub({
    user: { id: USER_ID, login: 'old', created_at: new Date(NOW - 31 * day).toISOString() },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: old, env })).status, 201);
  // Default 0: a day-old account may upload.
  const fresh = fakeGitHub({
    user: { id: USER_ID, login: 'fresh', created_at: new Date(NOW - day).toISOString() },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: fresh })).status, 201);
});

test('each malformed upload header is refused before anything is written', async () => {
  const cases = [
    [{ 'X-Upload-Set': null }, 400, 'bad_set'],
    [{ 'X-Upload-Set': SET.toUpperCase() }, 400, 'bad_set'],
    [{ 'X-Upload-Set': SET.slice(1) }, 400, 'bad_set'],
    [{ 'X-Upload-Set': SET.slice(0, 25) + '1' }, 400, 'bad_set'],
    [{ 'X-Upload-Set': `../${SET}` }, 400, 'bad_set'],
    [{ 'X-Upload-Kind': null }, 400, 'bad_kind'],
    [{ 'X-Upload-Kind': 'gif' }, 400, 'bad_kind'],
    [{ 'X-Upload-Kind': 'IMAGE' }, 400, 'bad_kind'],
    [{ 'X-Upload-Name': 'a'.repeat(201) }, 400, 'bad_name'],
    [{ 'Content-Type': 'image/png' }, 415, 'wrong_content_type'],
    [{ 'Content-Type': null }, 415, 'wrong_content_type'],
    [{ 'Content-Length': 'abc' }, 400, 'bad_length'],
  ];
  for (const [headers, status, error] of cases) {
    const result = await call(request('POST', { body: png(), headers }));
    assert.equal(result.status, status, JSON.stringify(headers));
    assert.equal(result.body.error, error);
    assert.equal(typeof result.body.message, 'string');
    assert.deepEqual(writes(result.github), []);
  }
  const named = await call(
    request('POST', {
      body: png(),
      headers: {
        'X-Upload-Name': 'a'.repeat(200),
        'Content-Type': 'application/octet-stream; charset=binary',
      },
    })
  );
  assert.equal(named.status, 201);
});

test('4 MiB is accepted; one byte more is 413, whatever Content-Length claims', async () => {
  const exact = png(MAX_BYTES);
  assert.equal(MAX_BYTES, 4 * 1024 * 1024);
  const ok = await call(request('POST', { body: exact }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.bytes, MAX_BYTES);

  const over = png(MAX_BYTES + 1);
  const big = await call(request('POST', { body: over }));
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'too_large');
  assert.deepEqual(writes(big.github), []);

  const declared = await call(
    request('POST', { body: png(), headers: { 'Content-Length': String(MAX_BYTES + 1) } })
  );
  assert.equal(declared.status, 413);

  const lying = await call(request('POST', { body: over, headers: { 'Content-Length': '64' } }));
  assert.equal(lying.status, 413, 'a Content-Length that lies does not get past the read cap');
  assert.deepEqual(writes(lying.github), []);
});

test('the body is read with a hard cap: a stream is abandoned as soon as it passes the limit', async () => {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (pulled > 100) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await readCapped({ body: stream }, MAX_BYTES);
  assert.equal(result, 'too_large');
  assert.ok(pulled <= 6, `pulled ${pulled} MiB`);
  assert.equal(cancelled, true);

  const broken = new ReadableStream({
    pull(controller) {
      controller.error(new Error('connection reset'));
    },
  });
  assert.equal(await readCapped({ body: broken }, MAX_BYTES), 'interrupted');
  assert.equal((await readCapped({ body: null }, MAX_BYTES)).length, 0);
});

test('an empty body is refused', async () => {
  const { status, body } = await call(request('POST', { body: new Uint8Array(0) }));
  assert.equal(status, 400);
  assert.equal(body.error, 'empty_file');
});

test('the magic bytes decide the extension, and anything else is 415', async () => {
  const RIFF_WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const accepted = [
    ['image', png(), 'png'],
    ['image', file([0xff, 0xd8, 0xff, 0xe0]), 'jpg'],
    ['image', file(RIFF_WEBP), 'webp'],
    ['pdf', file('%PDF-1.7\n'), 'pdf'],
  ];
  for (const [kind, bytes, ext] of accepted) {
    const { status, body } = await call(request('POST', { body: bytes, headers: { 'X-Upload-Kind': kind } }));
    assert.equal(status, 201, ext);
    assert.equal(body.ext, ext);
    assert.equal(body.ref, `upload:${SET}/${sha(bytes)}.${ext}`);
  }
  const refused = [
    ['image', file('GIF89a'), 'not_an_image'],
    ['image', file('<svg xmlns="http://www.w3.org/2000/svg">'), 'not_an_image'],
    ['image', file('<!doctype html><script>'), 'not_an_image'],
    ['image', file('%PDF-1.7\n'), 'not_an_image'],
    ['image', file([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]), 'not_an_image'],
    ['image', file([0x89, 0x50, 0x4e, 0x47]), 'not_an_image'],
    ['pdf', png(), 'not_a_pdf'],
    ['pdf', file('%PDF'), 'not_a_pdf'],
    ['pdf', file(' %PDF-1.7'), 'not_a_pdf'],
    ['pdf', file('<html>%PDF-1.7'), 'not_a_pdf'],
  ];
  for (const [kind, bytes, error] of refused) {
    const result = await call(request('POST', { body: bytes, headers: { 'X-Upload-Kind': kind } }));
    assert.equal(result.status, 415, Buffer.from(bytes.slice(0, 12)).toString('latin1'));
    assert.equal(result.body.error, error);
    assert.deepEqual(writes(result.github), []);
  }
});

test('a successful upload makes exactly these GitHub calls, with these bodies', async () => {
  const bytes = png(1000);
  const hash = sha(bytes);
  const { status, body, github, response } = await call(
    request('POST', { body: bytes, headers: { 'X-Upload-Name': 'Landing page.png' } })
  );
  assert.equal(status, 201);
  assert.deepEqual(body, { ref: `upload:${SET}/${hash}.png`, sha256: hash, bytes: 1000, ext: 'png' });
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-type'), /^application\/json/);

  const base = '/repos/acme/catalog-uploads';
  assert.deepEqual(
    github.calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /user',
      `GET ${base}/installation`,
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      `GET ${base}/git/matching-refs/heads/u/${USER_ID}/`,
      `POST ${base}/git/blobs`,
      `POST ${base}/git/trees`,
      `POST ${base}/git/commits`,
      `POST ${base}/git/refs`,
      // The caps again, now that the file is stored (parallel uploads).
      `GET ${base}/git/matching-refs/heads/u/${USER_ID}/`,
    ]
  );
  const [blob, tree, commit, ref] = writes(github);
  assert.deepEqual(Object.keys(blob.body).sort(), ['content', 'encoding']);
  assert.equal(blob.body.encoding, 'base64');
  assert.deepEqual(new Uint8Array(Buffer.from(blob.body.content, 'base64')), bytes);
  assert.deepEqual(tree.body, {
    tree: [{ path: `${hash}.png`, mode: '100644', type: 'blob', sha: 'b'.repeat(40) }],
  });
  assert.deepEqual(commit.body, {
    message: `upload png for user ${USER_ID}`,
    tree: 'd'.repeat(40),
    parents: [],
  });
  assert.deepEqual(ref.body, { ref: `refs/heads/u/${USER_ID}/${SET}/${hash}`, sha: 'c'.repeat(40) });
  for (const c of github.calls.slice(3)) assert.equal(c.auth, `Bearer ${INSTALL_TOKEN}`);
  for (const c of github.calls) {
    assert.equal(c.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(typeof c.headers['User-Agent'], 'string');
  }
  assert.ok(
    !JSON.stringify(github.calls).includes('Landing page'),
    'the display name is never sent to GitHub'
  );
});

test('re-uploading a file that is already stored answers the same 201 without writing', async () => {
  const bytes = png(500);
  const github = fakeGitHub({ refs: [branch(sha(bytes))] });
  const first = await call(request('POST', { body: bytes }), { github });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {
    ref: `upload:${SET}/${sha(bytes)}.png`,
    sha256: sha(bytes),
    bytes: 500,
    ext: 'png',
  });
  assert.deepEqual(writes(github), []);
});

test('a fourth draft is refused with 429 and a plain message; an existing draft still takes files', async () => {
  const sets = ['a', 'b', 'c'].map((letter) => letter.repeat(26));
  const github = fakeGitHub({ refs: sets.map((set) => branch('1'.repeat(64), set)) });
  const refused = await call(request('POST', { body: png() }), { github });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'too_many_drafts');
  assert.match(refused.body.message, /earlier draft/);
  assert.ok(Number(refused.response.headers.get('retry-after')) > 0);
  assert.deepEqual(writes(github), []);

  const existing = await call(request('POST', { body: png(), headers: { 'X-Upload-Set': sets[0] } }), {
    github,
  });
  assert.equal(existing.status, 201);
});

test('a tenth file in one draft is refused with 429; other users and malformed refs do not count', async () => {
  const nine = Array.from({ length: 9 }, (_, i) => branch(String(i).repeat(64)));
  const github = fakeGitHub({
    refs: [
      ...nine.slice(0, 8),
      branch('e'.repeat(64), SET, USER_ID + 1),
      `refs/heads/u/${USER_ID}/${SET}/nothex`,
    ],
  });
  assert.equal(
    (await call(request('POST', { body: png(10) }), { github })).status,
    201,
    'the ninth file fits'
  );
  const full = fakeGitHub({ refs: nine });
  const refused = await call(request('POST', { body: png(11) }), { github: full });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'too_many_files');
  assert.ok(refused.response.headers.get('retry-after'));
  assert.deepEqual(writes(full), []);
  // The listing asked only about this user's prefix.
  assert.ok(full.calls.some((c) => c.path.endsWith(`/git/matching-refs/heads/u/${USER_ID}/`)));
});

const REFS_ROUTE = 'POST /repos/acme/catalog-uploads/git/refs';
const LIST_ROUTE = `GET /repos/acme/catalog-uploads/git/matching-refs/heads/u/${USER_ID}/`;
const deletes = (github) => github.calls.filter((c) => c.method === 'DELETE');

test('a parallel upload that lands a new draft first: this one removes only its own file and is 429', async () => {
  const sets = ['a', 'b'].map((letter) => letter.repeat(26));
  const racer = branch('7'.repeat(64), 'c'.repeat(26));
  const github = fakeGitHub({
    refs: sets.map((set) => branch('1'.repeat(64), set)),
    // Another tab's write into a third draft lands between this one's check and write.
    routes: { [REFS_ROUTE]: (_call, state) => void state.refs.add(racer) },
  });
  const bytes = png(600);
  const refused = await call(request('POST', { body: bytes }), { github });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'too_many_drafts');
  assert.ok(Number(refused.response.headers.get('retry-after')) > 0);
  assert.deepEqual(
    deletes(github).map((c) => c.path),
    [`/repos/acme/catalog-uploads/git/refs/heads/u/${USER_ID}/${SET}/${sha(bytes)}`]
  );
  assert.ok(github.state.refs.has(racer), 'the racer’s file is kept');
  assert.equal(github.state.refs.size, 3);
});

test('a parallel upload that fills the draft first: this one removes only its own file and is 429', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => branch(String(i).repeat(64)));
  const racer = branch('f'.repeat(64));
  const github = fakeGitHub({
    refs: eight,
    routes: { [REFS_ROUTE]: (_call, state) => void state.refs.add(racer) },
  });
  const bytes = png(601);
  const refused = await call(request('POST', { body: bytes }), { github });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'too_many_files');
  assert.equal(deletes(github).length, 1);
  assert.ok(deletes(github)[0].path.endsWith(`/${SET}/${sha(bytes)}`));
  assert.deepEqual([...github.state.refs].sort(), [...eight, racer].sort());
});

test('racing uploads never end over a cap, and every 201 file is still stored', async () => {
  const sets = ['a', 'b'].map((letter) => letter.repeat(26));
  const github = fakeGitHub({ refs: sets.map((set) => branch('1'.repeat(64), set)) });
  const racers = ['p', 'q', 'r'].map((letter, i) => ({ set: letter.repeat(26), bytes: png(700 + i) }));
  clearInstallationTokenCache();
  const answers = await Promise.all(
    racers.map(({ set, bytes }) =>
      handleUpload(request('POST', { body: bytes, headers: { 'X-Upload-Set': set } }), ENV, {
        fetch: github,
        now: () => NOW,
      })
    )
  );
  // More than one racer got past the check before any wrote: a real race.
  assert.ok(github.calls.filter((c) => `${c.method} ${c.path}` === REFS_ROUTE).length > 1);
  const stored = [...github.state.refs];
  assert.ok(new Set(stored.map((ref) => ref.split('/')[4])).size <= 3, stored.join('\n'));
  answers.forEach((answer, i) => {
    const ref = branch(sha(racers[i].bytes), racers[i].set);
    if (answer.status === 201) assert.ok(github.state.refs.has(ref), `201 but gone: ${ref}`);
    else {
      assert.equal(answer.status, 429);
      assert.ok(!github.state.refs.has(ref), `429 but kept: ${ref}`);
    }
  });
  // The files that were there before the race are never removed.
  for (const set of sets) assert.ok(github.state.refs.has(branch('1'.repeat(64), set)));
});

test('a branch this request did not create is never removed, even over a cap', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => branch(String(i).repeat(64)));
  const bytes = png(602);
  const github = fakeGitHub({
    refs: eight,
    routes: {
      [REFS_ROUTE]: (_call, state) => {
        state.refs.add(branch('f'.repeat(64)));
        state.refs.add(branch(sha(bytes)));
        return json(422, { message: 'Reference already exists' });
      },
    },
  });
  assert.equal((await call(request('POST', { body: bytes }), { github })).status, 201);
  assert.deepEqual(deletes(github), []);
});

test('after a write: a failed re-list still answers 201; a failed removal is 503', async () => {
  const sets = ['a', 'b'].map((letter) => letter.repeat(26));
  let lists = 0;
  const relistFails = fakeGitHub({
    routes: { [LIST_ROUTE]: () => (++lists === 2 ? json(500, {}) : undefined) },
  });
  const bytes = png(603);
  assert.equal((await call(request('POST', { body: bytes }), { github: relistFails })).status, 201);
  assert.ok(relistFails.state.refs.has(branch(sha(bytes))));
  assert.match(logged.join('\n'), /re-listing after a write failed/);

  const removalFails = fakeGitHub({
    refs: sets.map((set) => branch('1'.repeat(64), set)),
    routes: {
      [REFS_ROUTE]: (_call, state) => void state.refs.add(branch('7'.repeat(64), 'c'.repeat(26))),
      [`DELETE /repos/acme/catalog-uploads/git/refs/heads/u/${USER_ID}/${SET}/${sha(bytes)}`]: () =>
        json(500, {}),
    },
  });
  const failed = await call(request('POST', { body: bytes }), { github: removalFails });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'github_unavailable');
});

test('"Reference already exists" on the last write is a success (two tabs, same file)', async () => {
  const bytes = png(321);
  const github = fakeGitHub({
    routes: {
      'POST /repos/acme/catalog-uploads/git/refs': () => json(422, { message: 'Reference already exists' }),
    },
  });
  const { status, body } = await call(request('POST', { body: bytes }), { github });
  assert.equal(status, 201);
  assert.equal(body.sha256, sha(bytes));

  const other = fakeGitHub({
    routes: { 'POST /repos/acme/catalog-uploads/git/refs': () => json(422, { message: 'Invalid request' }) },
  });
  assert.equal((await call(request('POST', { body: bytes }), { github: other })).status, 503);
});

test('a secondary rate limit at any write step is a 429 with Retry-After', async () => {
  const steps = ['blobs', 'trees', 'commits', 'refs'];
  for (const step of steps) {
    const github = fakeGitHub({
      routes: { [`POST /repos/acme/catalog-uploads/git/${step}`]: () => secondary() },
    });
    const { status, body, response } = await call(request('POST', { body: png() }), { github });
    assert.equal(status, 429, step);
    assert.equal(body.error, 'rate_limited');
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  }
  const told = fakeGitHub({
    routes: { 'POST /repos/acme/catalog-uploads/git/blobs': () => secondary({ 'retry-after': '42' }) },
  });
  assert.equal(
    (await call(request('POST', { body: png() }), { github: told })).response.headers.get('retry-after'),
    '42'
  );
  const listing = fakeGitHub({
    routes: {
      [`GET /repos/acme/catalog-uploads/git/matching-refs/heads/u/${USER_ID}/`]: () => json(429, {}),
    },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: listing })).status, 429);
  const minting = fakeGitHub({
    routes: { [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: () => secondary() },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: minting })).status, 429);
});

test('GitHub failures are 503; an App GitHub refuses is a 500 "not set up"', async () => {
  const down = fakeGitHub({
    routes: { 'POST /repos/acme/catalog-uploads/git/commits': () => json(500, {}) },
  });
  const failed = await call(request('POST', { body: png() }), { github: down });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'github_unavailable');

  const badList = fakeGitHub({
    routes: {
      [`GET /repos/acme/catalog-uploads/git/matching-refs/heads/u/${USER_ID}/`]: () =>
        json(200, { not: 'a list' }),
    },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: badList })).status, 503);

  const noSha = fakeGitHub({ routes: { 'POST /repos/acme/catalog-uploads/git/blobs': () => json(201, {}) } });
  assert.equal((await call(request('POST', { body: png() }), { github: noSha })).status, 503);

  const thrown = fakeGitHub({
    routes: {
      'POST /repos/acme/catalog-uploads/git/blobs': () => {
        throw new TypeError('fetch failed');
      },
    },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: thrown })).status, 503);

  for (const status of [404, 401]) {
    const notInstalled = fakeGitHub({
      routes: { 'GET /repos/acme/catalog-uploads/installation': () => json(status, {}) },
    });
    const result = await call(request('POST', { body: png() }), { github: notInstalled });
    assert.equal(result.status, 500);
    assert.equal(result.body.error, 'not_configured');
  }
  const mintFails = fakeGitHub({
    routes: { [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: () => json(502, {}) },
  });
  assert.equal((await call(request('POST', { body: png() }), { github: mintFails })).status, 503);
  assert.match(logged.join('\n'), /installed on UPLOADS_REPO/);
});

test('uploads reuse the cached installation token, and a 401 on a write drops it', async () => {
  const github = fakeGitHub();
  await call(request('POST', { body: png(100) }), { github });
  await call(request('POST', { body: png(101) }), { github, keepToken: true });
  const mints = () => github.calls.filter((c) => c.path.endsWith('/access_tokens')).length;
  assert.equal(mints(), 1);

  let reject = true;
  const revoking = fakeGitHub({
    routes: {
      'POST /repos/acme/catalog-uploads/git/blobs': () =>
        reject ? json(401, { message: 'Bad credentials' }) : undefined,
    },
  });
  assert.equal((await call(request('POST', { body: png(102) }), { github: revoking })).status, 503);
  reject = false;
  assert.equal(
    (await call(request('POST', { body: png(103) }), { github: revoking, keepToken: true })).status,
    201
  );
  // Without the drop, the second upload would have reused the rejected token (one mint in all).
  assert.equal(
    revoking.calls.filter((c) => c.path.endsWith('/access_tokens')).length,
    2,
    'minted afresh after the 401'
  );
});

test('DELETE removes the ref under the caller’s own id only, and an already-gone file is still 204', async () => {
  const hash = '9'.repeat(64);
  const mine = branch(hash);
  const theirs = branch(hash, SET, USER_ID + 1);
  const github = fakeGitHub({ refs: [mine, theirs] });
  const ref = `upload:${SET}/${hash}.pdf`;
  const done = await call(request('DELETE', { query: `?ref=${encodeURIComponent(ref)}` }), { github });
  assert.equal(done.status, 204);
  assert.equal(done.response.headers.get('access-control-allow-origin'), SITE);
  const deletes = github.calls.filter((c) => c.method === 'DELETE');
  assert.deepEqual(
    deletes.map((c) => c.path),
    [`/repos/acme/catalog-uploads/git/refs/heads/u/${USER_ID}/${SET}/${hash}`]
  );
  assert.equal(deletes[0].auth, `Bearer ${INSTALL_TOKEN}`);
  assert.deepEqual([...github.state.refs], [theirs], 'the other user’s file is untouched');

  const again = await call(request('DELETE', { query: `?ref=${encodeURIComponent(ref)}` }), { github });
  assert.equal(again.status, 204, '422 "Reference does not exist" is gone');
  const notFound = fakeGitHub({
    routes: {
      [`DELETE /repos/acme/catalog-uploads/git/refs/heads/u/${USER_ID}/${SET}/${hash}`]: () => json(404, {}),
    },
  });
  assert.equal((await call(request('DELETE', { query: `?ref=${ref}` }), { github: notFound })).status, 204);
});

test('DELETE cannot express another user or path: every other ref shape is 400 with no delete', async () => {
  const hash = '9'.repeat(64);
  for (const ref of [
    null,
    '',
    `upload:${SET}/${hash}.gif`,
    `upload:${USER_ID + 1}/${SET}/${hash}.png`,
    `upload:../u/${USER_ID + 1}/${SET}/${hash}.png`,
    `upload:${SET}/${hash}.png/../../x`,
    `u/${USER_ID + 1}/${SET}/${hash}`,
    `refs/heads/u/${USER_ID + 1}/${SET}/${hash}`,
  ]) {
    const query = ref === null ? '' : `?ref=${encodeURIComponent(ref)}`;
    const { status, body, github } = await call(request('DELETE', { query }));
    assert.equal(status, 400, String(ref));
    assert.equal(body.error, 'bad_ref');
    assert.equal(github.calls.filter((c) => c.method === 'DELETE').length, 0);
  }
});

test('DELETE failures: a rate limit is 429, anything else 503', async () => {
  const hash = '9'.repeat(64);
  const path = `DELETE /repos/acme/catalog-uploads/git/refs/heads/u/${USER_ID}/${SET}/${hash}`;
  const query = `?ref=upload:${SET}/${hash}.png`;
  const limited = await call(request('DELETE', { query }), {
    github: fakeGitHub({ routes: { [path]: () => secondary() } }),
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '60');
  const broken = await call(request('DELETE', { query }), {
    github: fakeGitHub({ routes: { [path]: () => json(500, {}) } }),
  });
  assert.equal(broken.status, 503);
  const odd = await call(request('DELETE', { query }), {
    github: fakeGitHub({ routes: { [path]: () => json(422, { message: 'Something else' }) } }),
  });
  assert.equal(odd.status, 503);
});
