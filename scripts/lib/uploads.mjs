/**
 * Read a file a submitter attached on /submit/ through the optional upload
 * service (services/uploads/, docs/submit-uploads-plan.md) out of the
 * deployment's PRIVATE uploads repository, so the scaffolder can check and save
 * it exactly as it saves a GitHub attachment.
 *
 * This is the only code that ever sees `UPLOADS_TOKEN`, a read-only GitHub App
 * installation token for that one repository. It is sent to api.github.com and
 * nowhere else — the generic fetchers in images.mjs and attachments.mjs attach
 * their `token` to any GitHub host a submitter names, so this token must never
 * reach them — and it never appears in a log line, an error or a warning.
 *
 * The ref is built here, from the ISSUE AUTHOR's numeric id and the reference
 * (`uploadBranch`, scripts/lib/upload_refs.mjs), never from anything else in
 * the issue: a reference copied into someone else's issue resolves to nothing,
 * and no reference can name another repository.
 *
 * Nothing here deletes or writes. Every edit of the issue rebuilds the draft
 * branch and resolves the references again, so the files must still be there;
 * clean-up is uploads-cleanup.yml's job, with a token of its own.
 */

import crypto from 'node:crypto';
import process from 'node:process';

import { TIMEOUT_MS, readCapped, sizeCapMessage } from './images.mjs';
import { formatUploadRef, uploadBranch, uploadFilename } from './upload_refs.mjs';

const API = 'https://api.github.com';

/** `owner/name`, in GitHub's own character rules. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** A git object id, SHA-1 or SHA-256, as the API returns it. */
const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A numeric GitHub user id, the same rule `uploadBranch` applies. */
const USER_ID_RE = /^[1-9][0-9]*$/;

/** Default cap when a caller names none: GitHub's own document upload ceiling. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The warning for `upload:` lines in an issue on a catalog that has no upload
 * service configured. Written for the submitter, who never saw a setting.
 * @param {string} field the question's label, as the submitter saw it
 * @param {number} count how many references that answer held
 * @returns {string}
 */
export function notConfiguredWarning(field, count) {
  const many = count > 1;
  return (
    `${many ? `${count} files` : 'A file'} attached on the submit page for “${field}” could not be collected, ` +
    'because file uploads are not set up on this catalog. ' +
    `To include ${many ? 'them' : 'it'}, edit this issue and drag the ${many ? 'files' : 'file'} into the “${field}” answer, ` +
    `in place of the ${many ? 'lines that start' : 'line that starts'} with \`upload:\`.`
  );
}

/**
 * The warning for a reference the uploads repository does not hold (expired,
 * removed, or never uploaded by this issue's author).
 * @param {string} field
 * @param {import('./upload_refs.mjs').UploadRef} ref
 * @returns {string}
 */
export function notFoundWarning(field, ref) {
  return (
    `A file attached on the submit page for “${field}” could not be found — uploads are kept for a limited time, so it may have expired. ` +
    `To include it, edit this issue and drag the file into the “${field}” answer, in place of the line \`${formatUploadRef(ref)}\`.`
  );
}

/** A 404 (or 409, an empty repository) at any step: there is no such file. */
class NotFound extends Error {}

/**
 * Build the resolver from the environment the workflow sets when the feature
 * is on. Any of the three blank or malformed means "not set up": the caller
 * skips `upload:` lines with `notConfiguredWarning`.
 *
 * @param {Record<string, string|undefined>} [env] `UPLOADS_TOKEN`, `UPLOADS_REPO` (`owner/name`), `ISSUE_AUTHOR_ID`
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injected for tests
 * @param {number} [options.timeoutMs] covers every request of one resolve, body included
 * @returns {{ok: true, resolve: (ref: import('./upload_refs.mjs').UploadRef, opts: {maxBytes?: number, field?: string}) => Promise<Uint8Array|{warning: string}>}
 *   | {ok: false, problem: string}}
 *   `problem` names the setting (never its value) for the job log.
 */
export function uploadResolver(
  env = process.env,
  { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}
) {
  const token = String(env?.UPLOADS_TOKEN ?? '').trim();
  const repo = String(env?.UPLOADS_REPO ?? '').trim();
  const authorId = String(env?.ISSUE_AUTHOR_ID ?? '').trim();

  if (!token || !repo || !authorId) {
    const missing = [
      !token && 'UPLOADS_TOKEN',
      !repo && 'UPLOADS_REPO',
      !authorId && 'ISSUE_AUTHOR_ID',
    ].filter(Boolean);
    return { ok: false, problem: `uploads are not configured (${missing.join(', ')} not set)` };
  }
  if (!REPO_RE.test(repo)) return { ok: false, problem: 'UPLOADS_REPO is not in owner/name form' };
  if (!USER_ID_RE.test(authorId))
    return { ok: false, problem: 'ISSUE_AUTHOR_ID is not a numeric GitHub user id' };

  /** Never let the token out in a message, whatever produced it. */
  const scrub = (text) =>
    String(text ?? '')
      .split(token)
      .join('***');

  /**
   * One GET against the uploads repository's git database.
   * @param {string} route path under /repos/<repo>/git/
   * @param {AbortSignal} signal
   * @param {string} [accept]
   */
  const get = async (route, signal, accept = 'application/vnd.github+json') => {
    const response = await fetchImpl(`${API}/repos/${repo}/git/${route}`, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'phct-scaffolder',
      },
    });
    if (!response) throw new Error('no response from GitHub');
    const status = Number(response.status);
    if (status === 404 || status === 409) throw new NotFound();
    if (!response.ok) throw new Error(`GitHub answered HTTP ${status}`);
    return response;
  };

  const sha = (value) => {
    const text = String(value ?? '');
    if (!GIT_SHA_RE.test(text)) throw new Error('GitHub returned an unexpected object id');
    return text;
  };

  return {
    ok: true,
    async resolve(ref, { maxBytes = DEFAULT_MAX_BYTES, field = '' } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const { signal } = controller;
      try {
        const branch = uploadBranch(authorId, ref);

        const head = await (await get(`ref/heads/${branch}`, signal)).json();
        if (head?.object?.type !== 'commit') throw new Error('the upload ref does not point at a commit');
        const commit = await (await get(`commits/${sha(head.object.sha)}`, signal)).json();
        const tree = await (await get(`trees/${sha(commit?.tree?.sha)}`, signal)).json();

        const name = uploadFilename(ref);
        const entry = (Array.isArray(tree?.tree) ? tree.tree : []).find((item) => item?.path === name);
        if (!entry) throw new NotFound();
        if (entry.type !== 'blob') throw new Error('the upload is not a single file');
        // Judged before a byte of the file moves.
        if (!(Number(entry.size) <= maxBytes)) throw new Error(sizeCapMessage(maxBytes));

        const response = await get(`blobs/${sha(entry.sha)}`, signal, 'application/vnd.github.raw+json');
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error(sizeCapMessage(maxBytes));
        const streamed = typeof response.body?.[Symbol.asyncIterator] === 'function';
        const bytes = streamed
          ? await readCapped(response.body, maxBytes, () => controller.abort())
          : new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(sizeCapMessage(maxBytes));

        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== ref.sha256) throw new Error('the file does not match its upload reference');
        return bytes;
      } catch (error) {
        if (error instanceof NotFound) return { warning: notFoundWarning(field, ref) };
        // No `cause`: the original error is dropped on purpose, so nothing that
        // might carry the token travels on with the message.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(scrub(error?.message || 'the upload could not be read'));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
