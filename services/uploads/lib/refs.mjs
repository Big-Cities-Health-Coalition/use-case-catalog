/**
 * The `upload:` reference rules, copied from scripts/lib/upload_refs.mjs (the
 * shared contract; read its header for the whole story). This service deploys
 * from its own directory, so it cannot import that file;
 * test/scripts/upload_refs_parity.test.mjs fails if the two copies drift.
 *
 *   upload:<set>/<sha256>.<ext>        what the submit page puts in the issue
 *   refs/heads/u/<user-id>/<set>/<sha256>   where the file lives in the
 *                                      private uploads repository
 */

/** Extension → the kind the upload service is asked for. */
export const UPLOAD_EXTENSIONS = Object.freeze({ png: 'image', jpg: 'image', webp: 'image', pdf: 'pdf' });

export const SET_ID_RE = /^[a-z2-7]{26}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

const REF_RE = /^upload:([a-z2-7]{26})\/([0-9a-f]{64})\.(png|jpg|webp|pdf)$/;

/**
 * @typedef {{ set: string, sha256: string, ext: 'png'|'jpg'|'webp'|'pdf' }} UploadRef
 */

/**
 * Parse one reference. Surrounding whitespace is ignored; anything else that is
 * not exactly the form above is not a reference.
 *
 * @param {unknown} text
 * @returns {UploadRef|null}
 */
export function parseUploadRef(text) {
  const match = REF_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  return { set: match[1], sha256: match[2], ext: /** @type {UploadRef['ext']} */ (match[3]) };
}

/**
 * @param {UploadRef} ref
 * @returns {string} `upload:<set>/<sha256>.<ext>`
 */
export function formatUploadRef({ set, sha256, ext }) {
  return `upload:${set}/${sha256}.${ext}`;
}

/**
 * The branch, without `refs/heads/`, that holds one uploaded file.
 *
 * @param {number|string} userId the uploader's (and so the issue author's) numeric GitHub id
 * @param {UploadRef} ref
 * @returns {string} `u/<user-id>/<set>/<sha256>`
 */
export function uploadBranch(userId, { set, sha256 }) {
  const id = String(userId ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`not a GitHub user id: ${JSON.stringify(userId)}`);
  if (!SET_ID_RE.test(set) || !SHA256_RE.test(sha256)) throw new Error('not an upload reference');
  return `u/${id}/${set}/${sha256}`;
}

/**
 * The file's name inside that branch's single-file tree.
 *
 * @param {UploadRef} ref
 * @returns {string} `<sha256>.<ext>`
 */
export function uploadFilename({ sha256, ext }) {
  return `${sha256}.${ext}`;
}
