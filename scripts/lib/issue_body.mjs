/**
 * Parsing of a GitHub issue-form body into schema field values.
 *
 * GitHub renders an issue form as a flat markdown document:
 *
 *     ### <field label>
 *
 *     <value>
 *
 * where `<value>` is `_No response_` when the submitter left it blank, the
 * typed text of a single-line `input` (which is how select, multiselect and
 * boolean questions are asked — see `coerceChoice`), a comma-joined string in
 * issues from the older multi-select dropdown, `- [x] Option` lines when the
 * field was rendered as checkboxes, and a markdown link or image embed when the
 * field was an `upload`. Every function here is pure and
 * schema-driven — no field key is ever named. See test/scripts/issue_body.test.mjs.
 */

/** GitHub's placeholder for an unanswered optional field. */
export const NO_RESPONSE = '_no response_';

/**
 * Normalize a heading or a schema label so the two can be compared
 * (case, whitespace and a trailing "(optional)"/"(required)" are ignored).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLabel(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\((optional|required)\)\s*$/, '');
}

/**
 * Split an issue body into `normalized heading -> raw value`.
 *
 * A GitHub issue form renders its fields as `### <label>` sections in template
 * order, so the structure — not just the text — tells us where a section ends.
 * Three rules make the split un-spoofable by whatever the submitter typed:
 *
 *   1. Only headings the caller recognises start a section. A `###` the
 *      submitter invented is body text.
 *   2. The FIRST occurrence of a known heading wins. A later `### Organization`
 *      cannot overwrite the answer GitHub itself collected; it is reported as
 *      an ignored duplicate instead.
 *   3. `finalLabel` names the last field of the template — the free-form
 *      markdown write-up. Once its heading is seen, every remaining line
 *      belongs to it, `###` lines included. Nothing after the write-up can be
 *      re-read as a field answer.
 *
 * Pass an empty `knownLabels` to treat every `###` as a boundary (used by the
 * "paste a blank issue" fallback, where no template order exists).
 *
 * @param {string} body raw issue body (CRLF tolerated)
 * @param {Iterable<string>} [knownLabels] labels that may start a section
 * @param {string} [finalLabel] label of the trailing free-form field
 * @returns {{sections: Map<string, string>, warnings: string[]}}
 */
export function parseIssueForm(body, knownLabels = [], finalLabel = '') {
  const known = new Set(Array.from(knownLabels, normalizeLabel).filter(Boolean));
  const terminal = normalizeLabel(finalLabel);
  const sections = new Map();
  /** @type {string[]} */
  const warnings = [];
  const seen = new Set();
  const lines = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  let heading = null;
  let buffer = [];
  let sealed = false;
  const flush = () => {
    // First occurrence wins; a duplicate's body is discarded, not merged.
    if (heading !== null && !sections.has(heading)) sections.set(heading, buffer.join('\n').trim());
    buffer = [];
  };

  for (const line of lines) {
    const match = sealed ? null : /^###[ \t]+(.*)$/.exec(line);
    const candidate = match ? normalizeLabel(match[1]) : null;
    if (candidate !== null && (known.size === 0 || known.has(candidate))) {
      flush();
      if (seen.has(candidate)) warnings.push(`Duplicate section "${candidate}" ignored.`);
      seen.add(candidate);
      heading = candidate;
      if (terminal && candidate === terminal) sealed = true;
      continue;
    }
    if (heading !== null) buffer.push(line);
  }
  flush();
  return { sections, warnings };
}

/**
 * `parseIssueForm` when only the sections are wanted.
 * @param {string} body
 * @param {Iterable<string>} [knownLabels]
 * @param {string} [finalLabel]
 * @returns {Map<string, string>}
 */
export function parseSections(body, knownLabels = [], finalLabel = '') {
  return parseIssueForm(body, knownLabels, finalLabel).sections;
}

/**
 * Raw answer for a schema field: matched by label first, then by key.
 * Returns `''` for a missing section or GitHub's `_No response_`.
 * @param {Map<string, string>} sections
 * @param {{label?: string, key?: string, prompt?: string}} field
 * @returns {string}
 */
export function rawValue(sections, field) {
  const candidates = [field?.label, field?.key, field?.prompt].map(normalizeLabel).filter(Boolean);
  for (const candidate of candidates) {
    const value = sections.get(candidate);
    if (value === undefined) continue;
    return value.trim().toLowerCase() === NO_RESPONSE ? '' : value.trim();
  }
  return '';
}

/**
 * A choice answer reduced to what is compared: code-span backticks dropped,
 * whitespace collapsed, case folded. Both the typed text and the schema options
 * go through it, so a hand-typed `pilot` or `` `Pilot` `` finds `Pilot`.
 * @param {unknown} value
 * @returns {string}
 */
function choiceKey(value) {
  return String(value ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * One typed piece of a choice answer, tidied for comparison: list bullets,
 * wrapping quotes and a closing full stop are not part of the answer.
 * @param {string} piece
 * @returns {string}
 */
function tidyPiece(piece) {
  const text = choiceKey(piece)
    .replace(/^[-*]\s+/, '')
    .replace(/^["'“”‘’]+/, '');
  // Trailing quotes and periods by hand: an unanchored `[…]+$` retries at every position
  // and is quadratic on a long run of quotes.
  let end = text.length;
  while (end > 0 && (QUOTES.has(text[end - 1]) || text[end - 1] === '.')) end -= 1;
  return text.slice(0, end).trim();
}

const QUOTES = new Set(['"', "'", '“', '”', '‘', '’']);

/**
 * The canonical option a typed piece names, or undefined.
 * @param {Map<string, string>} byKey choiceKey(option) -> option
 * @param {string} piece
 * @returns {string|undefined}
 */
function optionFor(byKey, piece) {
  return byKey.get(choiceKey(piece)) ?? byKey.get(tidyPiece(piece));
}

/** What GitHub (or an old dropdown) writes for an unanswered question. */
const NO_ANSWER = new Set([NO_RESPONSE, 'none']);

/**
 * Split a multiselect answer into the options it names and the pieces that name
 * none. Accepted: comma- or semicolon-separated text (what /submit/ sends, and
 * what GitHub's multi-select dropdown wrote), one option per line, list bullets,
 * and `- [x] Option` checkbox lines (unticked ones are skipped).
 *
 * A separator may sit inside an option (`Finance, procurement & contracts`), so
 * the text is cut at every separator and, from each piece, the longest run of
 * consecutive pieces that rejoins into an option is taken; a piece that starts
 * no such run is unmatched. Matching is case- and spacing-insensitive and always
 * returns the schema's own spelling. With no options declared everything typed
 * is kept, in order.
 *
 * @param {string} raw
 * @param {unknown[]} options declared options (may be empty for free lists)
 * @returns {{selected: string[], unmatched: string[], all: string[]}} each
 *   de-duplicated; `all` is both, in the order they were typed
 */
function splitChoices(raw, options = []) {
  const byKey = new Map();
  for (const option of options.map(String)) if (option.trim()) byKey.set(choiceKey(option), option);
  // No run longer than the most separators any option holds can rejoin into
  // one, which keeps a hostile line of thousands of commas linear.
  const longestRun = Math.max(1, ...[...byKey.keys()].map((key) => key.split(/[,;]/).length));
  const selected = [];
  const unmatched = [];
  const all = [];

  for (const line of String(raw ?? '').split('\n')) {
    const checkbox = /^\s*[-*]\s*\[([xX ])\]\s*(.*)$/.exec(line);
    if (checkbox && checkbox[1].trim() === '') continue; // unticked
    const text = checkbox ? checkbox[2] : line.replace(/^\s*[-*]\s+/, '');
    // Pieces and the separators between them, so a rejoined run is exact.
    const parts = text.split(/([,;])/);
    const pieces = parts.filter((_, index) => index % 2 === 0);
    const seps = parts.filter((_, index) => index % 2 === 1);

    for (let start = 0; start < pieces.length;) {
      let taken = 0;
      if (byKey.size > 0) {
        for (let end = Math.min(pieces.length, start + longestRun); end > start; end -= 1) {
          let joined = pieces[start];
          for (let i = start + 1; i < end; i += 1) joined += seps[i - 1] + pieces[i];
          const option = optionFor(byKey, joined);
          if (option !== undefined) {
            selected.push(option);
            all.push(option);
            taken = end - start;
            break;
          }
        }
      }
      if (taken === 0) {
        const piece = pieces[start].replace(/`/g, '').trim();
        if (tidyPiece(piece)) {
          (byKey.size > 0 ? unmatched : selected).push(piece);
          all.push(piece);
        }
        taken = 1;
      }
      start += taken;
    }
  }
  const unique = (list) => [...new Set(list)];
  return { selected: unique(selected), unmatched: unique(unmatched), all: unique(all) };
}

/**
 * Selected values of a multiselect, tolerating every rendering GitHub or a
 * person can produce (see splitChoices), in the order they were typed. Options
 * come back in the schema's spelling; a piece that names no option is kept as
 * typed — `coerceChoice` is the strict reading the scaffolder uses.
 * @param {string} raw
 * @param {string[]} options declared options (may be empty for free lists)
 * @returns {string[]}
 */
export function parseMultiselect(raw, options = []) {
  return splitChoices(raw, options).all;
}

/**
 * Free-form list field: one item per line, or comma separated.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseList(raw) {
  return String(raw ?? '')
    .split(/[\n,]/)
    .map((item) => item.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

/** A boolean answer that means yes, after tidying (GitHub's checkbox `[x]` included). */
const YES = /^(true|yes|y|on|1|checked|x|\[x\])$/i;
/** …and one that means no. */
const NO = /^(false|no|n|off|0|unchecked|\[ \])$/i;

/**
 * Truthiness of a boolean answer ("Yes", "true", a ticked checkbox…).
 * @param {string} raw
 * @returns {boolean}
 */
export function parseBoolean(raw) {
  return readBoolean(raw).value;
}

/**
 * A boolean answer read strictly: yes, no, blank, or not recognised. A ticked
 * `- [x] …` checkbox line is yes and an unticked one no; anything that is
 * neither yes nor no reads as false and is reported back as `unmatched`.
 * @param {string} raw
 * @returns {{value: boolean, unmatched: string[]}}
 */
function readBoolean(raw) {
  const text = String(raw ?? '').trim();
  const checkbox = /^[-*]\s*\[([xX ])\]/.exec(text);
  if (checkbox) return { value: checkbox[1] !== ' ', unmatched: [] };
  const answer = tidyPiece(text);
  if (YES.test(answer)) return { value: true, unmatched: [] };
  if (!answer || NO.test(answer) || NO_ANSWER.has(answer)) return { value: false, unmatched: [] };
  return { value: false, unmatched: [text] };
}

/**
 * A `select`, `multiselect` or `boolean` answer as front matter, plus what in it
 * named no option.
 *
 * The issue form asks these questions as single-line text inputs — GitHub
 * prefills nothing else from /submit/'s link — so the answer is whatever was
 * typed. It is matched leniently (case, spacing, backticks, quotes, a closing
 * full stop) onto the schema's own spelling. An answer that matches no option is
 * left out of `value` and returned in `unmatched`, so the caller can tell the
 * reviewer rather than commit a value `npm run validate` rejects. Blank,
 * `_No response_` and `None` (a dropdown's empty choice, in issues the old form
 * rendered) are no answer at all, unless `None` really is an option.
 *
 * A field without options is free text: a select keeps what was typed, a
 * multiselect every piece.
 *
 * @param {{type?: string, options?: unknown[]}} field
 * @param {string} raw
 * @returns {{value: string|string[]|boolean, unmatched: string[]}}
 */
export function coerceChoice(field, raw) {
  const type = String(field?.type ?? '');
  const options = Array.isArray(field?.options) ? field.options : [];
  const text = String(raw ?? '').trim();
  if (type === 'boolean') return readBoolean(text);

  const byKey = new Map(
    options
      .map(String)
      .filter((o) => o.trim())
      .map((o) => [choiceKey(o), o])
  );
  const named = optionFor(byKey, text);
  const empty = !tidyPiece(text) || NO_ANSWER.has(choiceKey(text));
  if (type === 'multiselect') {
    if (named === undefined && empty) return { value: [], unmatched: [] };
    const { selected, unmatched } = splitChoices(text, options);
    return { value: selected, unmatched };
  }
  // select
  if (named !== undefined) return { value: named, unmatched: [] };
  if (empty) return { value: '', unmatched: [] };
  if (byKey.size === 0) return { value: text, unmatched: [] };
  return { value: '', unmatched: [text] };
}

/**
 * An http(s) URL the site can render: a lower-case scheme and nothing that
 * would break out of an HTML attribute. The same test as the page's `http_url`
 * filter (_plugins/theme_filters.rb) and the validator's `http_url?`
 * (scripts/check_front_matter.rb), so a value a script writes is one the page
 * renders and `npm run validate` accepts.
 */
export const SITE_HTTP_URL = /^https?:\/\/[^\s"'<>]+$/;

/**
 * The URL as the site wants it, or '' when it cannot be one. The scheme is
 * lower-cased first (a browser takes `HTTPS://`, the page's test does not);
 * anything else is left exactly as written.
 * @param {unknown} value
 * @returns {string}
 */
export function siteHttpUrl(value) {
  const url = String(value ?? '')
    .trim()
    .replace(/^https?:/i, (scheme) => scheme.toLowerCase());
  return SITE_HTTP_URL.test(url) ? url : '';
}

/**
 * `text` as a markdown code span for a pull request or issue comment, so a
 * submitter's value renders literally and an `@name` in it pings nobody.
 * Backticks become `'`: a code span cannot contain its own delimiter.
 * @param {unknown} text
 * @returns {string}
 */
export function codeSpan(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

/** @returns {boolean} true when the string is an http(s) URL. */
export function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value ?? '').trim());
}

/**
 * Host of a URL, used as the fallback label of a bare link.
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(String(url)).host.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

/**
 * Parse a `links` field. Accepted per line:
 *   `Label | URL`, `Label — URL`, `Label: URL`, `[Label](URL)`, or a bare URL
 *   (label falls back to the host). Non-http(s) lines are dropped.
 * @param {string} raw
 * @returns {Array<{label: string, url: string}>}
 */
export function parseLinks(raw) {
  const links = [];
  for (const line of String(raw ?? '').split('\n')) {
    const text = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!text) continue;

    let label = '';
    let url;

    const markdown = /^\[([^\]]*)\]\((\S+?)\)$/.exec(text);
    const separated = /^(.*?)\s*[|—–]\s*(\S+)$/.exec(text);
    const colon = /^(.+?):[ \t]+(\S+)$/.exec(text);

    if (markdown) {
      [, label, url] = markdown;
    } else if (separated) {
      [, label, url] = separated;
    } else if (colon && isHttpUrl(colon[2])) {
      [, label, url] = colon;
    } else {
      url = text;
    }

    url = url.trim();
    if (!isHttpUrl(url)) continue;
    links.push({ label: label.trim() || hostOf(url), url });
  }
  return links;
}

/**
 * The one attachment behind a `file`/`image` answer.
 *
 * GitHub's `upload` element renders its answer into the issue body as a
 * markdown link (`[deck.pdf](https://github.com/.../deck.pdf)`) for documents
 * and as an image embed (`![shot.png](…)`) for pictures, so both spellings are
 * accepted — as is a bare URL, which is what a hand-written or copy-pasted body
 * carries. Everything after the first attachment is ignored: the control holds
 * one file.
 *
 * @param {string} raw
 * @returns {{url: string, name: string}|null}
 */
export function parseAttachmentRef(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.toLowerCase() === NO_RESPONSE) return null;

  // The image form first — `![a](b)` also matches the plain-link pattern.
  const embedded = /!\[([^\]]*)\]\((\S+?)\)/.exec(text) ?? /\[([^\]]*)\]\((\S+?)\)/.exec(text);
  if (embedded && isHttpUrl(embedded[2])) return { url: embedded[2].trim(), name: embedded[1].trim() };

  const tag = /<img\b[^>]*>/i.exec(text);
  if (tag) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
    if (src && isHttpUrl(src[1])) return { url: src[1].trim(), name: '' };
  }

  for (const line of text.split('\n')) {
    const bare = line.replace(/^\s*[-*]\s+/, '').trim();
    if (isHttpUrl(bare)) return { url: bare, name: '' };
  }
  return null;
}

/**
 * Parse an `images` field into download candidates. Accepted per line:
 *   `![alt](url)`, `<img src="url" alt="…">`, `url | alt`, or a bare URL.
 * Duplicate URLs are collapsed, keeping the first alt text seen.
 * @param {string} raw
 * @returns {Array<{url: string, alt: string}>}
 */
export function parseImageRefs(raw) {
  const found = new Map();
  const add = (url, alt) => {
    const clean = String(url ?? '')
      .trim()
      .replace(/[).,]+$/, '');
    if (!isHttpUrl(clean) || found.has(clean)) return;
    found.set(clean, { url: clean, alt: String(alt ?? '').trim() });
  };

  const text = String(raw ?? '');
  for (const match of text.matchAll(/!\[([^\]]*)\]\((\S+?)\)/g)) add(match[2], match[1]);
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[0]);
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(match[0]);
    if (src) add(src[1], alt ? alt[1] : '');
  }
  for (const line of text.split('\n')) {
    const bare = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!bare || bare.startsWith('!') || bare.startsWith('<')) continue;
    const separated = /^(\S+)\s*\|\s*(.*)$/.exec(bare);
    if (separated) add(separated[1], separated[2]);
    else add(bare, '');
  }
  return [...found.values()];
}

// One slug rule, three call sites. The configurator's implementation is the
// canonical one — /submit/ shows the submitter the slug it produces, so the
// scaffolder that names the folder has to agree with it, or "Köln
// Gesundheitsamt" is previewed as `koln-…` and published as `k-ln-…`.
// scripts/lib/slugify.rb is the Ruby port; test/scripts/slugify_parity.test.mjs
// runs both over one fixture list.
export { slugify } from '../../assets/js/configurator/strings.js';

/**
 * Slug for a title that has nothing left after normalizing — a title written
 * entirely in a non-Latin script, or only in emoji. Deterministic on purpose:
 * a re-run of the same issue has to produce the same folder.
 *
 * Only the URL is affected; the title itself lives in the front matter.
 * @param {string|number} issueNumber
 * @returns {string}
 */
export function slugFallback(issueNumber) {
  const suffix = String(issueNumber ?? '').trim();
  return `entry-${/^\d+$/.test(suffix) ? suffix : Date.now().toString(36)}`;
}

/**
 * First free slug in the `base`, `base-2`, `base-3`… sequence.
 * @param {string} base
 * @param {(slug: string) => boolean} taken predicate, usually a directory check
 * @param {number} [limit] how many suffixes to try before giving up
 * @returns {string}
 */
export function uniqueSlug(base, taken, limit = 50) {
  if (!base) return '';
  if (!taken(base)) return base;
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return '';
}

/**
 * Coerce one raw answer to the front matter shape its schema type requires.
 * `markdown`, `images` and `file` are handled by the caller (they need the
 * entry folder), so they return `null` here.
 * @param {{type?: string, options?: string[]}} field
 * @param {string} raw
 * @returns {string|number|boolean|string[]|Array<object>|null}
 */
export function coerce(field, raw) {
  const type = String(field?.type ?? 'text');
  const text = String(raw ?? '').trim();

  switch (type) {
    case 'select':
    case 'multiselect':
    case 'boolean':
      return coerceChoice(field, text).value;
    case 'list':
      return text ? parseList(text) : [];
    case 'links':
      return text ? parseLinks(text) : [];
    case 'number': {
      if (!text) return '';
      const direct = Number(text.replace(/[\s,]/g, ''));
      if (Number.isFinite(direct)) return direct;
      const match = /[-+]?\d+(?:\.\d+)?/.exec(text);
      return match ? Number(match[0]) : '';
    }
    case 'date': {
      const match = /\d{4}-\d{2}-\d{2}/.exec(text);
      return match ? match[0] : '';
    }
    case 'markdown':
    case 'images':
    case 'file':
      return null;
    default:
      return text;
  }
}
