/**
 * The upload service for a PHCT site's /submit/ page: a signed-in submitter
 * sends one screenshot or PDF deck, and this service checks it and writes it
 * straight into the deployment's private uploads repository, then answers with
 * the `upload:` reference the page puts in the issue body. It stores nothing
 * itself. See docs/submit-uploads-plan.md.
 *
 *   OPTIONS /api/upload   CORS preflight for the allowed site origins
 *   POST    /api/upload   raw file body → 201 {ref, sha256, bytes, ext}
 *   DELETE  /api/upload?ref=upload:<set>/<sha256>.<ext>   → 204
 *
 * POST, in order: configuration → method → an allowed Origin → the bearer
 * token names a GitHub user (one `GET /user`) → account age → upload headers
 * → size (4 MiB, read with a hard cap) → magic bytes → sha256 → per-user caps
 * (3 drafts, 9 files each; an identical file already stored is answered
 * without writing) → blob, tree, parentless commit, branch → the caps again,
 * removing this file's branch if a parallel upload pushed it over one.
 *
 * Every handler takes a WHATWG Request and returns a Response; `fetch` and the
 * clock are injectable, so the tests never touch the network.
 */

import { createHash } from 'node:crypto';

import { parseAllowedOrigins, readConfig } from './config.mjs';
import {
  GitHubError,
  TOKEN_PATTERN,
  clearInstallationTokenCache,
  getUser,
  installationToken,
} from './github.mjs';
import { SET_ID_RE, formatUploadRef, parseUploadRef } from './refs.mjs';
import { detectExtension } from './sniff.mjs';
import { deleteUpload, listUserFiles, writeUpload } from './store.mjs';

/** 4 MiB, for images and PDFs alike: under Vercel's 4.5 MB request body limit. */
export const MAX_BYTES = 4 * 1024 * 1024;
/** Drafts (upload sets) one user may have files in at once. */
export const MAX_SETS = 3;
/** Files one draft may hold. */
export const MAX_FILES_PER_SET = 9;
/** Longest display name the page may send. */
export const MAX_NAME_LENGTH = 200;
/** What a per-user cap 429 suggests: files clear when the user removes them. */
export const CAP_RETRY_AFTER = 3600;

export const ALLOWED_METHODS = 'POST, DELETE';
export const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Upload-Set, X-Upload-Kind, X-Upload-Name';
export const PREFLIGHT_MAX_AGE = '600';

const KINDS = new Set(['image', 'pdf']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every error this service answers with: HTTP status and a sentence a submitter can act on. */
export const ERRORS = {
  not_configured: [
    500,
    'File uploads are not set up on this server yet. Submit your answers, then add your files on GitHub instead.',
  ],
  method_not_allowed: [405, 'This address only accepts file uploads and removals.'],
  origin_not_allowed: [403, 'This upload service does not accept files from this website.'],
  unauthorized: [
    401,
    'Your GitHub sign-in has expired or is not valid. Sign in again, then add the file again.',
  ],
  account_too_new: [
    403,
    'Your GitHub account is too new to upload files here. Submit your answers, then add your files on GitHub instead.',
  ],
  bad_set: [400, 'The page sent this file without a valid draft id. Reload the page and try again.'],
  bad_kind: [
    400,
    'The page did not say whether this file is an image or a PDF. Reload the page and try again.',
  ],
  bad_name: [400, 'The file name is too long. Rename the file to something shorter and try again.'],
  bad_length: [400, 'The page sent this file with a broken size. Reload the page and try again.'],
  bad_ref: [400, 'That file reference is not valid. Reload the page and try again.'],
  empty_file: [400, 'This file is empty. Choose the file again.'],
  interrupted: [400, 'The upload was interrupted before the whole file arrived. Try again.'],
  wrong_content_type: [
    415,
    'The page sent this file in a form this service does not accept. Reload the page and try again.',
  ],
  too_large: [
    413,
    'This file is larger than 4 MB. Make it smaller (for slides, export a PDF at the smallest size) and try again.',
  ],
  not_an_image: [
    415,
    'This file is not a PNG, JPEG or WebP image. Save it in one of those formats and try again.',
  ],
  not_a_pdf: [415, 'This file is not a PDF. Export or save it as a PDF and try again.'],
  too_many_drafts: [
    429,
    'You already have files saved for three other drafts. Finish or remove the files in an earlier draft, then try again.',
  ],
  too_many_files: [429, 'This draft already has 9 files, the most it can hold. Remove one to add another.'],
  rate_limited: [429, 'GitHub is receiving a lot of files right now. Wait a minute and try again.'],
  github_unavailable: [503, 'GitHub could not save the file just now. Try again in a minute.'],
};

/** Headers on every response: nothing here may be cached or leak a referrer. */
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Origin',
};

/**
 * @param {number} status
 * @param {unknown} body JSON body, or null for none
 * @param {string} corsOrigin the allowed origin to echo, '' for none
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function respond(status, body, corsOrigin, extra = {}) {
  const headers = new Headers({ ...BASE_HEADERS, ...extra });
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (body === null) return new Response(null, { status, headers });
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * @param {keyof typeof ERRORS} code
 * @param {string} corsOrigin
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
export function errorResponse(code, corsOrigin, extra) {
  const [status, message] = ERRORS[code];
  return respond(status, { error: code, message }, corsOrigin, extra);
}

/** @param {keyof typeof ERRORS} code @param {number} seconds @param {string} corsOrigin */
function rateLimited(code, seconds, corsOrigin) {
  return errorResponse(code, corsOrigin, { 'Retry-After': String(seconds) });
}

/**
 * The request's Origin, when ALLOWED_ORIGIN parses and lists it; '' otherwise.
 * Worked out apart from the rest of the configuration so that even a "not set
 * up" answer reaches the page readably.
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return '';
  const { origins } = parseAllowedOrigins(env?.ALLOWED_ORIGIN);
  return origins.includes(origin) ? origin : '';
}

/**
 * Map a failed GitHub call to an answer, logging only the kind and status.
 * @param {unknown} error
 * @param {string} step what was being done, for the log
 * @param {string} corsOrigin
 * @returns {Response}
 */
function githubFailure(error, step, corsOrigin) {
  if (!(error instanceof GitHubError)) {
    console.error(`uploads: ${step} failed (${error?.name || 'Error'}).`);
    return errorResponse('github_unavailable', corsOrigin);
  }
  console.error(`uploads: ${step} failed: GitHub ${error.kind}, HTTP ${error.status}.`);
  if (error.kind === 'rate_limited') return rateLimited('rate_limited', error.retryAfter, corsOrigin);
  if (error.kind === 'unauthorized') clearInstallationTokenCache();
  return errorResponse('github_unavailable', corsOrigin);
}

/**
 * Who is calling: the bearer token resolved to a GitHub user. The token is
 * used for this one call and nothing else.
 * @param {Request} request
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {string} corsOrigin
 * @returns {Promise<{user: import('./github.mjs').GitHubUser}|{response: Response}>}
 */
async function authenticate(request, deps, corsOrigin) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') || '');
  if (!match || !TOKEN_PATTERN.test(match[1])) return { response: errorResponse('unauthorized', corsOrigin) };
  try {
    return { user: await getUser(deps, match[1]) };
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'rate_limited') {
      return { response: rateLimited('rate_limited', error.retryAfter, corsOrigin) };
    }
    if (error instanceof GitHubError && (error.kind === 'unauthorized' || error.status === 403)) {
      return { response: errorResponse('unauthorized', corsOrigin) };
    }
    return { response: githubFailure(error, 'GET /user', corsOrigin) };
  }
}

/**
 * The App installation token, or the answer to give when it cannot be minted.
 * GitHub refusing the App itself (wrong key, wrong App ID, not installed on
 * UPLOADS_REPO) is a setup problem, not an outage.
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {import('./config.mjs').UploadsConfig} config
 * @param {string} corsOrigin
 * @returns {Promise<{token: string}|{response: Response}>}
 */
async function appToken(deps, config, corsOrigin) {
  try {
    return { token: await installationToken(deps, config) };
  } catch (error) {
    if (error instanceof GitHubError && (error.kind === 'not_found' || error.kind === 'unauthorized')) {
      console.error(
        `uploads: GitHub refused the uploads App (HTTP ${error.status}): check UPLOADS_APP_ID, UPLOADS_APP_PRIVATE_KEY and that the App is installed on UPLOADS_REPO.`
      );
      return { response: errorResponse('not_configured', corsOrigin) };
    }
    return { response: githubFailure(error, 'minting the installation token', corsOrigin) };
  }
}

/**
 * Read the body, giving up as soon as it passes `max` bytes.
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<Uint8Array|'too_large'|'interrupted'>}
 */
export async function readCapped(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        // The answer is already decided; a failed cancel only leaves the body unread.
        reader.cancel().catch(() => {});
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return 'interrupted';
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * OPTIONS /api/upload: the CORS preflight. It grants nothing by itself, so it
 * answers for an allowed origin even while the rest of the configuration is
 * broken; the real request then gets the readable "not set up" error.
 * @param {string} corsOrigin
 * @returns {Response}
 */
function preflight(corsOrigin) {
  if (!corsOrigin) return errorResponse('origin_not_allowed', '');
  return respond(204, null, corsOrigin, {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
  });
}

/**
 * POST /api/upload
 * @param {Request} request
 * @param {import('./config.mjs').UploadsConfig} config
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {string} cors
 * @returns {Promise<Response>}
 */
async function upload(request, config, deps, cors) {
  const auth = await authenticate(request, deps, cors);
  if ('response' in auth) return auth.response;
  const { user } = auth;

  if (config.minAccountAgeDays > 0 && deps.now() - user.createdAt < config.minAccountAgeDays * DAY_MS) {
    return errorResponse('account_too_new', cors);
  }

  const set = request.headers.get('x-upload-set') || '';
  if (!SET_ID_RE.test(set)) return errorResponse('bad_set', cors);
  const kind = request.headers.get('x-upload-kind') || '';
  if (!KINDS.has(kind)) return errorResponse('bad_kind', cors);
  const name = request.headers.get('x-upload-name');
  if (name !== null && name.length > MAX_NAME_LENGTH) return errorResponse('bad_name', cors);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') return errorResponse('wrong_content_type', cors);
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^[0-9]{1,16}$/.test(length.trim())) return errorResponse('bad_length', cors);
    if (Number(length) > MAX_BYTES) return errorResponse('too_large', cors);
  }

  const bytes = await readCapped(request, MAX_BYTES);
  if (bytes === 'too_large' || bytes === 'interrupted') return errorResponse(bytes, cors);
  if (bytes.length === 0) return errorResponse('empty_file', cors);

  const ext = detectExtension(bytes, kind);
  if (!ext) return errorResponse(kind === 'pdf' ? 'not_a_pdf' : 'not_an_image', cors);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const body = { ref: formatUploadRef({ set, sha256, ext }), sha256, bytes: bytes.length, ext };

  const app = await appToken(deps, config, cors);
  if ('response' in app) return app.response;

  let files;
  try {
    files = await listUserFiles(deps, config, app.token, user.id);
  } catch (error) {
    return githubFailure(error, 'listing the uploader’s files', cors);
  }
  if (files.some((file) => file.set === set && file.sha256 === sha256)) return respond(201, body, cors);
  const before = overCap(files, set, true);
  if (before) return rateLimited(before, CAP_RETRY_AFTER, cors);

  let created;
  try {
    created = await writeUpload(deps, config, app.token, user.id, { set, sha256, ext, bytes });
  } catch (error) {
    return githubFailure(error, 'storing the file', cors);
  }

  // The check above and the write are not atomic, so parallel uploads can all
  // pass it. Look again now that this file is stored: over a cap, remove the
  // branch THIS request created, before anyone has been told it exists, and
  // answer as the check would have. Only that branch is ever removed, so a
  // racer that was answered 201 for a file of its own keeps it: the worst a
  // race does is refuse every racer (each may retry), and since the last
  // writer sees all the others, the caps hold. A branch this request did not
  // create ("already exists") belongs to the request that did. One gap stays:
  // the SAME file sent twice at once shares one branch, so a twin answered
  // 201 from it can lose it to the creator's removal; that takes the same file
  // twice in one draft, at a cap, in the same moment, and the scaffolder then
  // warns that the file could not be found.
  if (!created) return respond(201, body, cors);
  let after;
  try {
    after = overCap(await listUserFiles(deps, config, app.token, user.id), set, false);
  } catch (error) {
    // The check before the write passed; a race on top of a failed re-read is
    // too unlikely to cost the submitter a file that is stored.
    console.error(`uploads: re-listing after a write failed (${error?.kind || error?.name || 'Error'}).`);
    return respond(201, body, cors);
  }
  if (!after) return respond(201, body, cors);
  try {
    await deleteUpload(deps, config, app.token, user.id, { set, sha256 });
  } catch (error) {
    return githubFailure(error, 'removing a file over the cap', cors);
  }
  return rateLimited(after, CAP_RETRY_AFTER, cors);
}

/**
 * Which per-user cap a listing breaks, if any. Before a write the new file
 * must still fit (`adding`); after it, the listing already holds it.
 * @param {Array<{set: string, sha256: string}>} files
 * @param {string} set the draft the file goes into
 * @param {boolean} adding whether the file is not in `files` yet
 * @returns {'too_many_drafts'|'too_many_files'|null}
 */
function overCap(files, set, adding) {
  const sets = new Set(files.map((file) => file.set));
  if (adding) sets.add(set);
  if (sets.size > MAX_SETS) return 'too_many_drafts';
  const inSet = files.filter((file) => file.set === set).length + (adding ? 1 : 0);
  if (inSet > MAX_FILES_PER_SET) return 'too_many_files';
  return null;
}

/**
 * DELETE /api/upload?ref=upload:<set>/<sha256>.<ext>. The branch is built from
 * the caller's own verified user id, so another user's file cannot be named.
 * @param {Request} request
 * @param {import('./config.mjs').UploadsConfig} config
 * @param {{fetch: typeof fetch, now: () => number}} deps
 * @param {string} cors
 * @returns {Promise<Response>}
 */
async function remove(request, config, deps, cors) {
  const auth = await authenticate(request, deps, cors);
  if ('response' in auth) return auth.response;

  const ref = parseUploadRef(new URL(request.url).searchParams.get('ref'));
  if (!ref) return errorResponse('bad_ref', cors);

  const app = await appToken(deps, config, cors);
  if ('response' in app) return app.response;
  try {
    await deleteUpload(deps, config, app.token, auth.user.id, ref);
  } catch (error) {
    return githubFailure(error, 'removing a file', cors);
  }
  return respond(204, null, cors);
}

/**
 * Every method of /api/upload.
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @param {{fetch?: typeof fetch, now?: () => number}} [deps]
 * @returns {Promise<Response>}
 */
export async function handleUpload(request, env, deps = {}) {
  const resolved = { fetch: deps.fetch ?? globalThis.fetch, now: deps.now ?? Date.now };
  const cors = allowedOrigin(request, env);
  if (request.method === 'OPTIONS') return preflight(cors);
  const config = readConfig(env);
  if (config.error) {
    console.error(`uploads: refusing every request: ${config.error}`);
    return errorResponse('not_configured', cors);
  }
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return errorResponse('method_not_allowed', cors, { Allow: `OPTIONS, ${ALLOWED_METHODS}` });
  }
  // A browser always sends Origin on these requests; anything without an
  // allowed one is not the catalog's submit page.
  if (!cors) return errorResponse('origin_not_allowed', '');
  if (request.method === 'POST') return upload(request, config, resolved, cors);
  return remove(request, config, resolved, cors);
}
