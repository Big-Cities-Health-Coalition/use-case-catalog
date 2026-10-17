/**
 * Submit form — file uploads, the parts that need no page: the limits, the
 * decisions about an image's size and format, the shape of a stored record,
 * and the two things that touch the browser (re-encoding a picture, talking to
 * the upload service). assets/js/submit/uploads.js builds the pickers on top.
 *
 * Only loaded when `submit.uploads_url` is set (submit/index.md), just before
 * uploads.js. The rules here mirror scripts/lib/upload_refs.mjs (the shared
 * `upload:<set>/<sha256>.<ext>` reference) and services/uploads/ (the limits);
 * these scripts are classic `<script defer>` tags and cannot import it.
 *
 * Exposes: window.SubmitForm.uploadsCore
 */
(function (ns) {
  'use strict';

  /** The service refuses a request body over 4 MiB (Vercel's cap is 4.5 MB). */
  const MAX_BYTES = 4 * 1024 * 1024;
  /** The longest side of an uploaded picture, in pixels. */
  const MAX_EDGE = 2400;
  /** First try for a re-encoded picture, then these, as JPEG, until one fits. */
  const QUALITY = 0.9;
  const FALLBACK_QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
  /** Pictures per screenshots question, files per draft, bytes per draft. */
  const MAX_IMAGES = 8;
  const MAX_FILES = 9;
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  /** Alt text: "one sentence under about 125 characters" (docs/content-model.md). */
  const MAX_ALT = 125;
  const MAX_NAME = 200;
  /** How many times a busy answer (429) is retried before the message is shown. */
  const MAX_RETRIES = 3;
  const DEFAULT_RETRY_MS = 2000;
  const MAX_RETRY_MS = 60000;
  const REQUEST_TIMEOUT_MS = 120000;

  const SET_RE = /^[a-z2-7]{26}$/;
  const REF_RE = /^upload:([a-z2-7]{26})\/([0-9a-f]{64})\.(png|jpg|webp|pdf)$/;
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  /** The image types the picker takes: no GIF. */
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  /**
   * A new set id: 26 characters of lowercase base32, 130 random bits, picked
   * once per draft. 32 divides 256, so masking a random byte is unbiased.
   * @param {{getRandomValues: Function}} [source] defaults to window.crypto
   * @returns {string}
   * @throws {Error} when the browser has no secure random source
   */
  function newSetId(source) {
    const random = source || window.crypto;
    if (!random || typeof random.getRandomValues !== 'function') throw new Error('no secure random source');
    const bytes = random.getRandomValues(new Uint8Array(26));
    let id = '';
    for (let i = 0; i < bytes.length; i += 1) id += ALPHABET[bytes[i] & 31];
    return id;
  }

  /**
   * Scale a size down to fit a longest side, never up.
   * @param {number} width
   * @param {number} height
   * @param {number} [max]
   * @returns {{width: number, height: number}}
   */
  function fitWithin(width, height, max) {
    const limit = max || MAX_EDGE;
    const longest = Math.max(width, height);
    if (longest <= limit) return { width: width, height: height };
    const scale = limit / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /**
   * The type a picture is saved as: PNG stays PNG, JPEG and WebP stay as they
   * are. Anything else (GIF, SVG, HEIC) is not taken.
   * @param {string} type a File's MIME type
   * @returns {string} '' when the picker does not take it
   */
  function outputType(type) {
    return IMAGE_TYPES.indexOf(type) === -1 ? '' : type;
  }

  /**
   * Which kind of upload a picked file is, from its type or, failing that, its
   * extension.
   * @param {{name?: string, type?: string}} file
   * @returns {'image'|'pdf'|''}
   */
  function kindOf(file) {
    const type = String(file.type || '').toLowerCase();
    if (type === 'application/pdf') return 'pdf';
    if (IMAGE_TYPES.indexOf(type) !== -1) return 'image';
    if (type !== '') return '';
    const name = String(file.name || '').toLowerCase();
    if (/\.pdf$/.test(name)) return 'pdf';
    if (/\.(png|jpe?g|webp)$/.test(name)) return 'image';
    return '';
  }

  /**
   * Re-encode a picture so it fits the limit: first at the original format and
   * quality 0.9, then as JPEG at falling quality. `encode` is the canvas in
   * the browser and a stub in tests.
   *
   * @param {(type: string, quality: number) => Promise<Blob|null>} encode
   * @param {string} type the format to keep
   * @param {number} [limit] bytes
   * @returns {Promise<{blob: Blob, type: string}|null>} null when no quality fits
   */
  async function encodeUnderLimit(encode, type, limit) {
    const max = limit || MAX_BYTES;
    const first = await encode(type, QUALITY);
    if (first && first.size <= max) return { blob: first, type: first.type || type };
    for (const quality of FALLBACK_QUALITIES) {
      const blob = await encode('image/jpeg', quality);
      if (blob && blob.size <= max) return { blob: blob, type: blob.type || 'image/jpeg' };
    }
    return null;
  }

  /**
   * Re-encode a picked image in the browser: decode it, draw it at most
   * MAX_EDGE on its longest side, save it again. Nothing of the original
   * file's metadata (EXIF, GPS, camera) survives a canvas.
   *
   * @param {File} file
   * @returns {Promise<{blob: Blob, type: string}>}
   * @throws {Error} with `code` 'decode' (not a readable picture) or 'toolarge'
   */
  async function browserReencode(file) {
    const type = outputType(String(file.type || '').toLowerCase()) || 'image/png';
    let bitmap;
    try {
      bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (first) {
      try {
        bitmap = await window.createImageBitmap(file);
      } catch (second) {
        const error = new Error('decode');
        error.code = 'decode';
        throw error;
      }
    }
    const size = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    const encode = (as, quality) =>
      new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d');
        // JPEG has no transparency: a transparent PNG would turn black.
        if (as === 'image/jpeg') {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, size.width, size.height);
        }
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        canvas.toBlob(resolve, as, quality);
      });
    try {
      const out = await encodeUnderLimit(encode, type, MAX_BYTES);
      if (!out) {
        const error = new Error('toolarge');
        error.code = 'toolarge';
        throw error;
      }
      return out;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  /**
   * One request to the upload service, with upload progress.
   *
   * @param {{method: string, url: string, headers: Record<string, string>,
   *   body?: Blob|null, onProgress?: (fraction: number) => void}} request
   * @returns {Promise<{status: number, retryAfter: string|null, data: object|null}>}
   *   rejects on a network failure or timeout
   */
  function xhrSend(request) {
    return new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open(request.method, request.url);
      Object.keys(request.headers).forEach((name) => xhr.setRequestHeader(name, request.headers[name]));
      xhr.timeout = REQUEST_TIMEOUT_MS;
      if (xhr.upload && request.onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) request.onProgress(event.loaded / event.total);
        };
      }
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (error) {
          // 204, or an answer that is not ours: the status says enough.
        }
        resolve({ status: xhr.status, retryAfter: xhr.getResponseHeader('Retry-After'), data: data });
      };
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.send(request.body || null);
    });
  }

  /**
   * How long to wait after a 429: the service's `Retry-After` in seconds,
   * within reason.
   * @param {string|number|null|undefined} value
   * @returns {number} milliseconds
   */
  function retryDelay(value) {
    const seconds = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(seconds) || seconds < 0)
      return DEFAULT_RETRY_MS;
    return Math.min(Math.max(Math.round(seconds * 1000), 0), MAX_RETRY_MS);
  }

  /**
   * A header value the browser will accept: printable ASCII only, so a name
   * like "Résumé…" cannot make the request throw. The name is for display.
   * @param {string} name
   * @returns {string}
   */
  function headerName(name) {
    return String(name || 'file')
      .replace(/[^\x20-\x7e]/g, '_')
      .trim()
      .slice(0, MAX_NAME);
  }

  /** @param {number} bytes @returns {string} e.g. "1.4 MB" */
  function sizeText(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Take a stored `uploads` record (draft.js) back in, keeping only what is
   * well formed: a draft is user-editable storage.
   *
   * @param {unknown} record `{set, user: {id, login}, files: {<key>: [{ref, name, alt, bytes, kind}]}}`
   * @param {string[]} keys the field keys that take files
   * @returns {{set: string, user: {id: number, login: string}, files: Record<string, object[]>}|null}
   */
  function readRecord(record, keys) {
    if (!record || typeof record !== 'object' || !SET_RE.test(String(record.set))) return null;
    const user = record.user;
    if (!user || !Number.isInteger(user.id) || user.id < 1) return null;
    const files = {};
    let any = false;
    keys.forEach((key) => {
      const list = record.files && Array.isArray(record.files[key]) ? record.files[key] : [];
      files[key] = list
        .map((entry) => {
          const match = entry && typeof entry.ref === 'string' ? REF_RE.exec(entry.ref) : null;
          if (!match || match[1] !== record.set) return null;
          const kind = match[3] === 'pdf' ? 'pdf' : 'image';
          return {
            ref: entry.ref,
            name: typeof entry.name === 'string' ? entry.name.slice(0, MAX_NAME) : 'file',
            alt: typeof entry.alt === 'string' ? entry.alt.slice(0, MAX_ALT) : '',
            bytes: Number.isFinite(entry.bytes) && entry.bytes >= 0 ? entry.bytes : 0,
            kind: kind,
          };
        })
        .filter(Boolean);
      if (files[key].length > 0) any = true;
    });
    if (!any) return null;
    return {
      set: record.set,
      user: { id: user.id, login: typeof user.login === 'string' ? user.login.slice(0, 39) : '' },
      files: files,
    };
  }

  ns.uploadsCore = {
    MAX_BYTES: MAX_BYTES,
    MAX_EDGE: MAX_EDGE,
    QUALITY: QUALITY,
    FALLBACK_QUALITIES: FALLBACK_QUALITIES,
    MAX_IMAGES: MAX_IMAGES,
    MAX_FILES: MAX_FILES,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    MAX_ALT: MAX_ALT,
    MAX_RETRIES: MAX_RETRIES,
    SET_RE: SET_RE,
    REF_RE: REF_RE,
    IMAGE_TYPES: IMAGE_TYPES,
    newSetId: newSetId,
    fitWithin: fitWithin,
    outputType: outputType,
    kindOf: kindOf,
    encodeUnderLimit: encodeUnderLimit,
    browserReencode: browserReencode,
    xhrSend: xhrSend,
    retryDelay: retryDelay,
    headerName: headerName,
    sizeText: sizeText,
    readRecord: readRecord,
  };
})((window.SubmitForm = window.SubmitForm || {}));
