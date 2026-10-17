/**
 * Reading `upload:` references out of the private uploads repository
 * (scripts/lib/uploads.mjs). Every request goes to a stub; no network.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { uploadBranch } from '../../scripts/lib/upload_refs.mjs';
import { notConfiguredWarning, notFoundWarning, uploadResolver } from '../../scripts/lib/uploads.mjs';

const TOKEN = 'ghs_uploadsTokenThatMustNeverLeak0123456789';
const REPO = 'example-org/catalog-uploads';
const AUTHOR = '123';
const ENV = { UPLOADS_TOKEN: TOKEN, UPLOADS_REPO: REPO, ISSUE_AUTHOR_ID: AUTHOR };
const SET = 'abcdefghijklmnopqrstuvwxyz';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const REF = { set: SET, sha256: sha256(PNG), ext: 'png' };

const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const BLOB = 'e'.repeat(40);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function bytesResponse(bytes, { stream = false } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...(stream
      ? {
          body: (async function* chunks() {
            for (let i = 0; i < bytes.length; i += 4) yield bytes.slice(i, i + 4);
          })(),
        }
      : {}),
  };
}

/**
 * A stand-in for the GitHub REST API's git database holding one file on one
 * branch. `overrides` replaces the answer to a step (`ref`, `commit`, `tree`,
 * `blob`) with a status or a response.
 */
function fakeGitHub({
  branch = uploadBranch(AUTHOR, REF),
  file = PNG,
  entry = {},
  overrides = {},
  stream,
} = {}) {
  const calls = [];
  const base = `https://api.github.com/repos/${REPO}/git/`;
  const answer = (step, make) => {
    const override = overrides[step];
    if (typeof override === 'number') return jsonResponse({ message: 'x' }, override);
    if (override) return override;
    return make();
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = url.startsWith(base) ? url.slice(base.length) : '';
    if (route === `ref/heads/${branch}` || (route.startsWith('ref/heads/') && overrides.ref)) {
      return answer('ref', () => jsonResponse({ object: { type: 'commit', sha: COMMIT } }));
    }
    if (route === `commits/${COMMIT}`) return answer('commit', () => jsonResponse({ tree: { sha: TREE } }));
    if (route === `trees/${TREE}`) {
      return answer('tree', () =>
        jsonResponse({
          tree: [{ path: `${REF.sha256}.png`, type: 'blob', sha: BLOB, size: file.length, ...entry }],
        })
      );
    }
    if (route === `blobs/${BLOB}`) return answer('blob', () => bytesResponse(file, { stream }));
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  return { calls, fetchImpl };
}

const resolverFor = (github, env = ENV) => {
  const resolver = uploadResolver(env, { fetchImpl: github.fetchImpl });
  assert.equal(resolver.ok, true, resolver.problem);
  return resolver;
};

test('a reference resolves ref → commit → tree → blob, re-hashed, with the documented headers', async () => {
  const github = fakeGitHub();
  const bytes = await resolverFor(github).resolve(REF, { maxBytes: 1024, field: 'Screenshots' });
  assert.deepEqual([...bytes], [...PNG]);

  const base = `https://api.github.com/repos/${REPO}/git/`;
  assert.deepEqual(
    github.calls.map((call) => call.url),
    [
      `${base}ref/heads/u/${AUTHOR}/${SET}/${REF.sha256}`,
      `${base}commits/${COMMIT}`,
      `${base}trees/${TREE}`,
      `${base}blobs/${BLOB}`,
    ]
  );
  for (const [index, { init }] of github.calls.entries()) {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['x-github-api-version'], '2022-11-28');
    assert.equal(
      init.headers.accept,
      index === 3 ? 'application/vnd.github.raw+json' : 'application/vnd.github+json'
    );
  }
});

test('the ref is built from ISSUE_AUTHOR_ID alone, so another user’s upload is never found', async () => {
  // The file exists, but under user 999. The issue author is 123, and nothing
  // in the reference can name a user, so the request goes to 123's ref.
  const github = fakeGitHub({ branch: uploadBranch('999', REF) });
  const result = await resolverFor(github).resolve(REF, { maxBytes: 1024, field: 'Screenshots' });
  assert.deepEqual(result, { warning: notFoundWarning('Screenshots', REF) });
  assert.equal(github.calls.length, 1);
  assert.ok(github.calls[0].url.includes(`/ref/heads/u/${AUTHOR}/`), github.calls[0].url);
  assert.ok(!github.calls[0].url.includes('/u/999/'));
});

test('the size cap is judged from the tree entry before the blob is fetched', async () => {
  const github = fakeGitHub({ entry: { size: 5000 } });
  await assert.rejects(resolverFor(github).resolve(REF, { maxBytes: 1024 }), /larger than the .* size cap/);
  assert.ok(!github.calls.some((call) => call.url.includes('/blobs/')), 'the blob was never requested');
});

test('the size cap is enforced again while the blob streams', async () => {
  // The tree claims a small file; the blob is bigger than it said.
  const big = new Uint8Array(64).fill(7);
  const github = fakeGitHub({ file: big, entry: { size: 8 }, stream: true });
  await assert.rejects(resolverFor(github).resolve(REF, { maxBytes: 16 }), /larger than the .* size cap/);
});

test('bytes that do not hash to the reference are rejected', async () => {
  const tampered = PNG.slice();
  tampered[11] = 0xff;
  const github = fakeGitHub({ file: tampered });
  await assert.rejects(
    resolverFor(github).resolve(REF, { maxBytes: 1024 }),
    /does not match its upload reference/
  );
});

test('a tree entry that is not a blob is rejected without fetching it', async () => {
  const github = fakeGitHub({ entry: { type: 'tree' } });
  await assert.rejects(resolverFor(github).resolve(REF, { maxBytes: 1024 }), /not a single file/);
  assert.ok(!github.calls.some((call) => call.url.includes('/blobs/')));
});

test('a 404 at any step, or a tree without the file, is “not found”, never a throw', async () => {
  for (const step of ['ref', 'commit', 'tree', 'blob']) {
    const github = fakeGitHub({ overrides: { [step]: 404 } });
    const result = await resolverFor(github).resolve(REF, { maxBytes: 1024, field: 'Deck' });
    assert.deepEqual(result, { warning: notFoundWarning('Deck', REF) }, step);
  }
  const missing = fakeGitHub({ entry: { path: 'other.png' } });
  const result = await resolverFor(missing).resolve(REF, { maxBytes: 1024, field: 'Deck' });
  assert.deepEqual(result, { warning: notFoundWarning('Deck', REF) });
});

test('any other GitHub error is a throw that names the status', async () => {
  const github = fakeGitHub({ overrides: { commit: 500 } });
  await assert.rejects(resolverFor(github).resolve(REF, { maxBytes: 1024 }), /GitHub answered HTTP 500/);
});

test('the token goes to api.github.com only and never into an error or a warning', async () => {
  const hosts = new Set();
  const leaky = async (url) => {
    hosts.add(new URL(url).host);
    throw new Error(`connect failed with Bearer ${TOKEN}`);
  };
  const resolver = uploadResolver(ENV, { fetchImpl: leaky });
  await assert.rejects(resolver.resolve(REF, { maxBytes: 1024 }), (error) => {
    assert.ok(!error.message.includes(TOKEN), error.message);
    assert.match(error.message, /\*\*\*/);
    return true;
  });
  assert.deepEqual([...hosts], ['api.github.com']);

  const github = fakeGitHub({ overrides: { ref: 404 } });
  const { warning } = await resolverFor(github).resolve(REF, { maxBytes: 1024, field: 'Screenshots' });
  assert.ok(!warning.includes(TOKEN));
  assert.ok(github.calls.every((call) => new URL(call.url).origin === 'https://api.github.com'));
});

test('missing or malformed settings mean “not set up”, and the problem never carries the token', () => {
  for (const env of [
    {},
    { ...ENV, UPLOADS_TOKEN: ' ' },
    { ...ENV, UPLOADS_REPO: '' },
    { ...ENV, ISSUE_AUTHOR_ID: '' },
    { ...ENV, UPLOADS_REPO: 'no-slash' },
    { ...ENV, UPLOADS_REPO: 'owner/../x' },
    { ...ENV, UPLOADS_REPO: 'owner/..' },
    { ...ENV, UPLOADS_REPO: 'https://github.com/owner/name' },
    { ...ENV, ISSUE_AUTHOR_ID: 'octocat' },
    { ...ENV, ISSUE_AUTHOR_ID: '0' },
  ]) {
    const resolver = uploadResolver(env, { fetchImpl: () => assert.fail('no request without settings') });
    assert.equal(resolver.ok, false, JSON.stringify(env));
    assert.ok(!resolver.problem.includes(TOKEN));
  }
});

test('the warnings speak to the submitter, in the singular and the plural', () => {
  assert.equal(
    notConfiguredWarning('Slide deck', 1),
    'A file attached on the submit page for “Slide deck” could not be collected, because file uploads are not set up on this catalog. To include it, edit this issue and drag the file into the “Slide deck” answer, in place of the line that starts with `upload:`.'
  );
  assert.match(
    notConfiguredWarning('Screenshots', 2),
    /^2 files attached .* drag the files .* lines that start with/
  );
  assert.match(notFoundWarning('Screenshots', REF), /could not be found — .* may have expired/);
  assert.ok(notFoundWarning('Screenshots', REF).includes(`upload:${SET}/${REF.sha256}.png`));
});
