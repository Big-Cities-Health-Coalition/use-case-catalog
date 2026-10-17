/**
 * The upload service (services/uploads/) deploys from its own directory, so it
 * keeps a copy of the `upload:` reference rules in services/uploads/lib/refs.mjs
 * instead of importing scripts/lib/upload_refs.mjs. This test fails the moment
 * the two disagree on anything the submit page, the service, the scaffolder or
 * the cleanup workflow depend on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as original from '../../scripts/lib/upload_refs.mjs';
import * as copy from '../../services/uploads/lib/refs.mjs';

const SET = 'abcdefghijklmnopqrstuvwx23';
const SHA = '0123456789abcdef'.repeat(4);

test('both copies export the same names', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort());
});

test('the same extension map and the same regexes', () => {
  assert.deepEqual(copy.UPLOAD_EXTENSIONS, original.UPLOAD_EXTENSIONS);
  assert.equal(Object.isFrozen(copy.UPLOAD_EXTENSIONS), Object.isFrozen(original.UPLOAD_EXTENSIONS));
  for (const name of ['SET_ID_RE', 'SHA256_RE']) {
    assert.equal(copy[name].source, original[name].source, name);
    assert.equal(copy[name].flags, original[name].flags, name);
  }
});

test('the same answers for valid and invalid references', () => {
  const inputs = [
    ...Object.keys(original.UPLOAD_EXTENSIONS).map((ext) => `upload:${SET}/${SHA}.${ext}`),
    `  upload:${SET}/${SHA}.png\n`,
    '',
    null,
    undefined,
    42,
    `upload:${SET}/${SHA}.gif`,
    `upload:${SET}/${SHA}.PNG`,
    `upload:${SET}/${SHA}.jpeg`,
    `upload:${SET.toUpperCase()}/${SHA}.png`,
    `upload:${SET.slice(1)}/${SHA}.png`,
    `upload:${SET}1/${SHA}.png`,
    `upload:${SET}/${SHA.slice(1)}.png`,
    `upload:${SET}/${SHA.toUpperCase()}.png`,
    `upload:../${SHA}.png`,
    `upload:4242/${SET}/${SHA}.png`,
    `upload:${SET}/${SHA}.png | alt text`,
    `upload:${SET}/${SHA}.png/../x`,
    `UPLOAD:${SET}/${SHA}.png`,
    `https://example.org/upload:${SET}/${SHA}.png`,
  ];
  for (const input of inputs) {
    assert.deepEqual(copy.parseUploadRef(input), original.parseUploadRef(input), JSON.stringify(input));
  }
  // The table really does hold both kinds.
  assert.equal(inputs.filter((input) => original.parseUploadRef(input)).length, 5);
});

test('the same reference text, file names and branch names', () => {
  for (const ext of Object.keys(original.UPLOAD_EXTENSIONS)) {
    const ref = { set: SET, sha256: SHA, ext };
    assert.equal(copy.formatUploadRef(ref), original.formatUploadRef(ref));
    assert.equal(copy.uploadFilename(ref), original.uploadFilename(ref));
    for (const id of [1, 4242, '4242', ' 99 ']) {
      assert.equal(copy.uploadBranch(id, ref), original.uploadBranch(id, ref));
    }
  }
  assert.equal(copy.uploadBranch(4242, { set: SET, sha256: SHA }), `u/4242/${SET}/${SHA}`);
});

test('both refuse the same bad user ids and references when naming a branch', () => {
  const good = { set: SET, sha256: SHA };
  const cases = [
    [0, good],
    [-1, good],
    ['01', good],
    ['42/../7', good],
    ['', good],
    [null, good],
    [1.5, good],
    [4242, { set: SET.toUpperCase(), sha256: SHA }],
    [4242, { set: '../..', sha256: SHA }],
    [4242, { set: SET, sha256: 'nothex' }],
    [4242, { set: SET, sha256: `${SHA}/x` }],
  ];
  for (const [id, ref] of cases) {
    const outcome = (impl) => {
      try {
        return `ok ${impl.uploadBranch(id, ref)}`;
      } catch (error) {
        return `threw ${error.message}`;
      }
    };
    const expected = outcome(original);
    assert.match(expected, /^threw /, JSON.stringify([id, ref]));
    assert.equal(outcome(copy), expected, JSON.stringify([id, ref]));
  }
});
