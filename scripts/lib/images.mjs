/**
 * Download the images a submitter attached to a GitHub issue into the entry
 * folder, so the published page never hot-links someone else's host.
 *
 * Rules (docs/content-model.md, `images` field type):
 *   - at most `maxFiles` files and `maxTotalBytes` in total;
 *   - PNG, JPEG, GIF or WebP only, verified by BOTH the response content-type
 *     and the file's magic bytes;
 *   - one request per URL, `timeoutMs` each (covering the body, not just the
 *     headers), redirects followed by hand so every hop can be re-checked;
 *   - the host of every hop must resolve to a public address — see
 *     `assertPublicHost`. The URLs come from an issue anyone can open and the
 *     runner sits inside a network with a metadata service on it, so a link to
 *     169.254.169.254 or 10.0.0.5 must never turn into a request;
 *   - a failure is a warning, never a fatal error: the URL is left out of the
 *     front matter (so the page never shows a broken image) and named in the
 *     pull request so a maintainer can re-add it.
 */

import dnsPromises from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { formatUploadRef } from './upload_refs.mjs';

/** Allowed content types mapped to the extension we save them under. */
const TYPE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** Default cap on how many images one entry may attach. */
export const MAX_FILES = 8;
/** Default cap on the combined size, in bytes, of all of an entry's images. */
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
/** Default per-request timeout, in milliseconds, covering the whole body read. */
export const TIMEOUT_MS = 30_000;
/** Redirect hops followed before giving up (each one is re-checked). */
export const MAX_REDIRECTS = 5;

/** Host suffixes that only ever name something on the runner's own network. */
const PRIVATE_SUFFIXES = ['.internal', '.local', '.localhost', 'localhost'];

/**
 * Is this literal IP address one we refuse to talk to? Covers loopback,
 * link-local (including the cloud metadata address), the RFC1918 ranges,
 * carrier-grade NAT, the unspecified address, multicast and reserved space,
 * plus the IPv6 equivalents and IPv4-mapped IPv6.
 * @param {string} address
 * @returns {boolean}
 */
export function isBlockedAddress(address) {
  const value = String(address ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!value) return true;

  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; //                         0.0.0.0/8 "this network"
    if (a === 10) return true; //                        10/8 private
    if (a === 127) return true; //                       127/8 loopback
    if (a === 169 && b === 254) return true; //          169.254/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; //          192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 192 && b === 0) return true; //            192.0.0/24 + 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true; //                        multicast + reserved + broadcast
    return false;
  }
  if (version !== 6) return true; // not an IP at all — caller must resolve first

  // Decide on the numeric groups, never on the text: the WHATWG URL parser
  // rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]` before a
  // hostname reaches this function, so a dotted-quad regex sees nothing.
  const g = ipv6Groups(value);
  if (!g) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:0:0/96 (IPv4-mapped), ::/96 (IPv4-compatible, incl. :: and ::1) and
  // 64:ff9b::/96 (NAT64) all deliver to an IPv4 destination — judge them by the
  // IPv4 rules above.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedAddress(v4(g[6], g[7]));
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedAddress(v4(g[6], g[7]));
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

/**
 * Expand an IPv6 literal (any textual form net.isIP accepts) into its eight
 * 16-bit groups. Returns null when the text is not an IPv6 address.
 * @param {string} value
 * @returns {number[]|null}
 */
export function ipv6Groups(value) {
  if (net.isIP(value) !== 6) return null;
  let text = value.replace(/%.*$/, ''); // drop a zone id (fe80::1%eth0)
  // A trailing dotted quad (::ffff:1.2.3.4) is the last two groups in decimal.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, dotted.index + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  if (tail === undefined && left.length !== 8) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right].map((x) => parseInt(x, 16));
  return groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

/**
 * Throw unless every address `url`'s host resolves to is publicly routable.
 * IP-literal URLs skip DNS but go through exactly the same address rules.
 * @param {string} url
 * @param {{lookup: Function}} [dnsImpl] injected for tests
 * @returns {Promise<void>}
 */
export async function assertPublicHost(url, dnsImpl = dnsPromises) {
  const hostname = new URL(url).hostname;
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix))) {
    throw new Error(`${hostname} is a private hostname`);
  }

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`${hostname} is a private or reserved address`);
    return;
  }

  const resolved = await dnsImpl.lookup(host, { all: true });
  const addresses = (Array.isArray(resolved) ? resolved : [resolved]).map((item) => item?.address ?? item);
  if (addresses.length === 0) throw new Error(`${hostname} does not resolve`);
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) throw new Error(`${hostname} resolves to the private address ${blocked}`);
}

/**
 * Extension for a `Content-Type` header, or `''` when the type is not allowed.
 * @param {string|null|undefined} contentType
 * @returns {string}
 */
export function extensionForContentType(contentType) {
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return TYPE_EXTENSIONS.get(type) ?? '';
}

/**
 * Identify an image by its magic bytes. Returns `'png' | 'jpg' | 'gif' |
 * 'webp'`, or `''` when the bytes are not one of those formats.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sniffImageType(bytes) {
  const b = bytes ?? new Uint8Array();
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'webp';
  return '';
}

/** @returns {boolean} true when the URL is a plain http(s) URL we may fetch. */
function fetchable(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The size-cap message, phrased the same wherever the cap is hit. */
export function sizeCapMessage(limit) {
  return `it is larger than the ${Math.round(limit / (1024 * 1024))} MB size cap`;
}

/**
 * Read a response body stream, giving up the moment it crosses `limit` bytes.
 *
 * Buffering the whole body and checking afterwards is not a cap: `Content-Length`
 * is optional (chunked transfer-encoding is a streaming server's default), so a
 * hostile URL that answers without one could stream for the whole timeout and
 * OOM the runner before anything looked at the size.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @param {number} limit bytes this file may occupy
 * @param {() => void} onOverflow called before throwing, to abort the socket
 * @returns {Promise<Uint8Array>}
 */
export async function readCapped(body, limit, onOverflow) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    received += bytes.byteLength;
    if (received > limit) {
      onOverflow();
      throw new Error(sizeCapMessage(limit));
    }
    chunks.push(bytes);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * One guarded download: every redirect hop is followed by hand so its host can
 * be re-checked, and the abort timer stays armed until the body has been read
 * (clearing it after the headers arrive would let a server dribble bytes for
 * ever and hang the job).
 *
 * @param {string} url
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {{lookup: Function}} options.dnsImpl
 * @param {number} options.timeoutMs
 * @param {number} options.maxBytes budget left for this file
 * @param {string} options.token
 * @returns {Promise<{response: Response, bytes: Uint8Array|null}>}
 */
async function fetchImage(url, { fetchImpl, dnsImpl, timeoutMs, maxBytes, token }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(current, dnsImpl);

      const headers = { accept: 'image/*' };
      // Re-decided per hop, so a redirect off github.com does not leak the token.
      if (token && /(^|\.)github(usercontent)?\.com$/i.test(new URL(current).hostname)) {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers,
      });
      if (!response) throw new Error('no response');

      const status = Number(response.status);
      const location = response.headers?.get?.('location');
      if (status >= 300 && status < 400 && location) {
        const next = new URL(location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`it redirects to a ${next.protocol} URL`);
        }
        current = next.toString();
        continue;
      }

      if (!response.ok) return { response, bytes: null };

      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(sizeCapMessage(maxBytes));
      }

      // Streams are read incrementally against the cap; `arrayBuffer` is the
      // fallback for a response that has no body stream (every test double).
      const streamed = typeof response.body?.[Symbol.asyncIterator] === 'function';
      const bytes = streamed
        ? await readCapped(response.body, maxBytes, () => controller.abort())
        : new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(sizeCapMessage(maxBytes));
      return { response, bytes };
    }
    throw new Error(`it redirects more than ${MAX_REDIRECTS} times`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {object} ImageSource one candidate image, however its bytes arrive
 * @property {string} label how warnings name it (the URL, for a URL)
 * @property {string} [alt]
 * @property {string} [skip] a warning that rules it out before any budget is spent
 * @property {(maxBytes: number) => Promise<{bytes: Uint8Array, declared: string}|{warning: string}>} [load]
 *   fetch at most `maxBytes`; `declared` is the extension the source claims
 *   (`''` when that is not an allowed image type), `warning` a complete
 *   sentence for a miss. A throw is reported as "Could not download <label>".
 */

/**
 * Check and store images, whichever way their bytes arrive: the count cap, the
 * shared size budget (each load is capped at what is left of it), the declared
 * type, the magic bytes, the file naming and the write. The URL path
 * (`downloadImages`) and the upload path (scripts/lib/uploads.mjs, through
 * `downloadImages`' `resolveUpload`) both come through here, so there is one
 * copy of these rules.
 *
 * @param {ImageSource[]} sources
 * @param {object} options
 * @param {string} options.destDir absolute folder the files are written to
 * @param {string} options.publicPrefix site-absolute prefix for `src`
 * @param {string} [options.altFallback]
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxTotalBytes]
 * @param {{mkdirSync: Function, writeFileSync: Function}} [options.fsImpl] injected for tests
 * @returns {Promise<{items: Array<{src: string, alt: string}>, warnings: string[]}>}
 */
export async function saveImages(sources, options) {
  const {
    destDir,
    publicPrefix,
    altFallback = '',
    maxFiles = MAX_FILES,
    maxTotalBytes = MAX_TOTAL_BYTES,
    fsImpl = fs,
  } = options ?? {};

  /** @type {Array<{src: string, alt: string}>} */
  const items = [];
  /** @type {string[]} */
  const warnings = [];
  const candidates = Array.isArray(sources) ? sources : [];

  if (candidates.length === 0) return { items, warnings };
  if (candidates.length > maxFiles) {
    warnings.push(
      `Only the first ${maxFiles} images were saved; ${candidates.length - maxFiles} were ignored.`
    );
  }

  let total = 0;
  let saved = 0;

  for (const source of candidates.slice(0, maxFiles)) {
    const label = String(source?.label ?? '');
    const alt = String(source?.alt ?? '').trim();

    if (source?.skip) {
      warnings.push(source.skip);
      continue;
    }

    // What is left of the shared budget, so eight files can never move eight
    // times the cap across the wire before the total is checked.
    const remaining = maxTotalBytes - total;
    if (remaining <= 0) {
      warnings.push(
        `Skipped ${label} — the images add up to more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB.`
      );
      continue;
    }

    try {
      const loaded = await source.load(remaining);
      if ('warning' in loaded) {
        warnings.push(loaded.warning);
        continue;
      }
      const { bytes, declared } = loaded;

      if (!declared) {
        warnings.push(`Skipped ${label} — its content type is not PNG, JPEG, GIF or WebP.`);
        continue;
      }

      const sniffed = sniffImageType(bytes);
      if (!sniffed) {
        warnings.push(`Skipped ${label} — the file does not look like a PNG, JPEG, GIF or WebP image.`);
        continue;
      }
      if (total + bytes.length > maxTotalBytes) {
        warnings.push(
          `Skipped ${label} — the images add up to more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB.`
        );
        continue;
      }

      saved += 1;
      total += bytes.length;
      const name = `${String(saved).padStart(2, '0')}.${sniffed}`;
      fsImpl.mkdirSync(destDir, { recursive: true });
      fsImpl.writeFileSync(path.join(destDir, name), bytes);
      items.push({ src: `${publicPrefix}/${name}`, alt: alt || altFallback });
    } catch (error) {
      warnings.push(
        `Could not download ${label} (${error.message}). Left it out — re-add it in this pull request if it should be included.`
      );
    }
  }

  return { items, warnings };
}

/**
 * Fetch, verify and store image references.
 *
 * A URL reference is fetched here, under every rule at the top of this file.
 * An `upload:` reference (`{ upload }`, scripts/lib/issue_body.mjs) is read
 * through `resolveUpload` — scripts/lib/uploads.mjs, which holds its own
 * credential; `token` is never used for it, and nothing from `resolveUpload`
 * reaches the URL fetcher. Both then go through the same checks (`saveImages`).
 *
 * @param {Array<{url: string, alt?: string}|{upload: import('./upload_refs.mjs').UploadRef, alt?: string}>} refs
 *   parsed image references
 * @param {object} options
 * @param {string} options.destDir absolute folder the files are written to
 * @param {string} options.publicPrefix site-absolute prefix for `src`
 *   (e.g. `/catalog/my-entry/screenshots`)
 * @param {string} [options.altFallback] alt text used when the submitter gave none
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.token] GitHub token, sent to github.com hosts only
 * @param {(ref: import('./upload_refs.mjs').UploadRef, opts: {maxBytes: number}) => Promise<Uint8Array|{warning: string}>} [options.resolveUpload]
 *   reads an `upload:` reference's bytes, capped at `maxBytes`
 * @param {typeof fetch} [options.fetchImpl] injected for tests
 * @param {{lookup: Function}} [options.dnsImpl] injected for tests
 * @param {{mkdirSync: Function, writeFileSync: Function}} [options.fsImpl] injected for tests
 * @returns {Promise<{items: Array<{src: string, alt: string}>, warnings: string[]}>}
 */
export async function downloadImages(refs, options) {
  const {
    timeoutMs = TIMEOUT_MS,
    token = '',
    resolveUpload = undefined,
    fetchImpl = globalThis.fetch,
    dnsImpl = dnsPromises,
  } = options ?? {};

  const sources = (Array.isArray(refs) ? refs : []).map((ref) => {
    const alt = ref?.alt;
    if (ref?.upload) return uploadSource(ref.upload, alt, resolveUpload);

    const url = String(ref?.url ?? '');
    if (!fetchable(url)) {
      return { label: url, alt, skip: `Skipped \`${url}\` — only http(s) image URLs can be downloaded.` };
    }
    return {
      label: url,
      alt,
      load: async (maxBytes) => {
        const { response, bytes } = await fetchImage(url, { fetchImpl, dnsImpl, timeoutMs, maxBytes, token });
        if (!bytes) {
          return {
            warning: `Could not download ${url} (HTTP ${response.status}). Left it out — re-add it in this pull request if it should be included.`,
          };
        }
        return { bytes, declared: extensionForContentType(response.headers?.get?.('content-type')) };
      },
    };
  });

  return saveImages(sources, options);
}

/**
 * How a warning names an `upload:` reference (images and attachments alike).
 * @param {import('./upload_refs.mjs').UploadRef} upload
 * @returns {string}
 */
export function uploadLabel(upload) {
  return `the uploaded file \`${formatUploadRef(upload)}\``;
}

/** Image extensions an `upload:` reference may carry, as `saveImages` declares them. */
const IMAGE_UPLOAD_EXTENSIONS = new Set(TYPE_EXTENSIONS.values());

/**
 * The `ImageSource` for one `upload:` reference. Its declared type is the
 * reference's own extension, standing where a URL's Content-Type does.
 * @param {import('./upload_refs.mjs').UploadRef} upload
 * @param {string|undefined} alt
 * @param {Function|undefined} resolveUpload
 * @returns {ImageSource}
 */
function uploadSource(upload, alt, resolveUpload) {
  const label = uploadLabel(upload);
  if (typeof resolveUpload !== 'function') {
    return { label, alt, skip: `Skipped ${label} — uploaded files cannot be collected here.` };
  }
  const declared = IMAGE_UPLOAD_EXTENSIONS.has(upload.ext) ? upload.ext : '';
  return {
    label,
    alt,
    load: async (maxBytes) => {
      const result = await resolveUpload(upload, { maxBytes });
      return result instanceof Uint8Array ? { bytes: result, declared } : result;
    },
  };
}
