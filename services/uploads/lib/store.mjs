/**
 * The private uploads repository as a file store: one parentless commit and
 * one branch per file, so a write never races another and deleting the branch
 * is the whole cleanup.
 *
 *   refs/heads/u/<user-id>/<set>/<sha256>  →  commit  →  tree { <sha256>.<ext> }
 *
 * Every call here uses the App installation token. Branch names come only from
 * lib/refs.mjs `uploadBranch`, from the caller's verified numeric user id.
 */

import { githubRequest, GitHubError } from './github.mjs';
import { SET_ID_RE, SHA256_RE, uploadBranch, uploadFilename } from './refs.mjs';

/**
 * @typedef {{fetch: typeof fetch, now: () => number}} Deps
 * @typedef {{owner: string, repo: string}} Repo
 */

/** @param {Repo} repo */
const base = (repo) => `/repos/${repo.owner}/${repo.repo}/git`;

/**
 * Every file one user has stored, as `{ set, sha256 }`. Refs under the user's
 * prefix that do not have exactly the expected shape are ignored.
 * @param {Deps} deps
 * @param {Repo} repo
 * @param {string} token installation token
 * @param {number} userId
 * @returns {Promise<Array<{set: string, sha256: string}>>}
 */
export async function listUserFiles(deps, repo, token, userId) {
  const prefix = `refs/heads/u/${userId}/`;
  const refs = await githubRequest(deps, 'GET', `${base(repo)}/matching-refs/heads/u/${userId}/`, { token });
  if (!Array.isArray(refs))
    throw new GitHubError('failed', 200, { message: 'matching-refs answered without a list' });
  const files = [];
  for (const entry of refs) {
    const name = typeof entry?.ref === 'string' ? entry.ref : '';
    if (!name.startsWith(prefix)) continue;
    const [set, sha256, extra] = name.slice(prefix.length).split('/');
    if (extra === undefined && SET_ID_RE.test(set ?? '') && SHA256_RE.test(sha256 ?? ''))
      files.push({ set, sha256 });
  }
  return files;
}

/**
 * Store one file: blob → tree → parentless commit → branch. A branch that
 * already exists (two tabs uploading the same file at once) is success: its
 * name is the file's hash, so it holds these same bytes. Resolves to whether
 * THIS call created the branch, the only case in which the caller may remove
 * it again.
 * @param {Deps} deps
 * @param {Repo} repo
 * @param {string} token installation token
 * @param {number} userId
 * @param {{set: string, sha256: string, ext: string, bytes: Uint8Array}} file
 * @returns {Promise<boolean>} true when this call created the branch
 */
export async function writeUpload(deps, repo, token, userId, { set, sha256, ext, bytes }) {
  const ref = `refs/heads/${uploadBranch(userId, { set, sha256 })}`;
  const blob = await githubRequest(deps, 'POST', `${base(repo)}/blobs`, {
    token,
    body: { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' },
  });
  const tree = await githubRequest(deps, 'POST', `${base(repo)}/trees`, {
    token,
    body: { tree: [{ path: uploadFilename({ sha256, ext }), mode: '100644', type: 'blob', sha: sha(blob) }] },
  });
  const commit = await githubRequest(deps, 'POST', `${base(repo)}/commits`, {
    token,
    body: { message: `upload ${ext} for user ${userId}`, tree: sha(tree), parents: [] },
  });
  try {
    await githubRequest(deps, 'POST', `${base(repo)}/refs`, { token, body: { ref, sha: sha(commit) } });
  } catch (error) {
    if (
      error instanceof GitHubError &&
      error.kind === 'unprocessable' &&
      /already exists/i.test(error.githubMessage)
    ) {
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Delete one of the caller's files. Already gone is fine.
 * @param {Deps} deps
 * @param {Repo} repo
 * @param {string} token installation token
 * @param {number} userId
 * @param {{set: string, sha256: string}} file
 * @returns {Promise<void>}
 */
export async function deleteUpload(deps, repo, token, userId, { set, sha256 }) {
  const branch = uploadBranch(userId, { set, sha256 });
  try {
    await githubRequest(deps, 'DELETE', `${base(repo)}/refs/heads/${branch}`, { token });
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'not_found') return;
    if (
      error instanceof GitHubError &&
      error.kind === 'unprocessable' &&
      /does not exist/i.test(error.githubMessage)
    ) {
      return;
    }
    throw error;
  }
}

/** @param {any} object @returns {string} the `sha` GitHub answered with */
function sha(object) {
  if (typeof object?.sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(object.sha)) {
    throw new GitHubError('failed', 201, { message: 'GitHub answered a write without a sha' });
  }
  return object.sha;
}
