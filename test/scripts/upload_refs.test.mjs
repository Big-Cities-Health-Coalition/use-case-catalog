/**
 * The `upload:` reference contract (scripts/lib/upload_refs.mjs) that the
 * submit page writes, the upload service stores under, and the scaffolder and
 * the cleanup workflow resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatUploadRef,
  parseUploadRef,
  uploadBranch,
  uploadFilename,
  UPLOAD_EXTENSIONS,
} from '../../scripts/lib/upload_refs.mjs';

const SET = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20) + '234567';
const SHA = 'a'.repeat(64);

test('a well-formed reference round-trips', () => {
  for (const ext of Object.keys(UPLOAD_EXTENSIONS)) {
    const text = `upload:${SET}/${SHA}.${ext}`;
    const ref = parseUploadRef(`  ${text}  `);
    assert.deepEqual(ref, { set: SET, sha256: SHA, ext });
    assert.equal(formatUploadRef(ref), text);
  }
});

test('anything else is not a reference', () => {
  for (const text of [
    '',
    null,
    `upload:${SET}/${SHA}.gif`,
    `upload:${SET}/${SHA}.PNG`,
    `upload:${SET.toUpperCase()}/${SHA}.png`,
    `upload:${SET}/${SHA.slice(1)}.png`,
    `upload:${SET}1/${SHA}.png`,
    `upload:../${SHA}.png`,
    `upload:${SET}/${SHA}.png | alt text`,
    `https://example.org/upload:${SET}/${SHA}.png`,
    `upload:${SET}/${SHA}.png\nupload:${SET}/${SHA}.png`,
  ]) {
    assert.equal(parseUploadRef(text), null, JSON.stringify(text));
  }
});

test('the branch is built from the user id, never from the reference', () => {
  const ref = parseUploadRef(`upload:${SET}/${SHA}.pdf`);
  assert.equal(uploadBranch(583231, ref), `u/583231/${SET}/${SHA}`);
  assert.equal(uploadBranch('583231', ref), `u/583231/${SET}/${SHA}`);
  assert.equal(uploadFilename(ref), `${SHA}.pdf`);
  for (const bad of ['', '0', '-1', '12a', 'octocat', '1/2', undefined]) {
    assert.throws(() => uploadBranch(bad, ref), /not a GitHub user id/, String(bad));
  }
  assert.throws(() => uploadBranch(1, { set: '../x', sha256: SHA }), /not an upload reference/);
});
