/**
 * Which answers a submitter changed when they edited their issue.
 *
 * When a reviewer has already committed to a submission's draft, an edit to
 * the issue no longer rebuilds the branch (that would erase the reviewer's
 * work). The reviewer is shown this summary instead and applies it by hand.
 *
 * For an entry, the answers are read through the schema exactly as the
 * scaffolder reads them, so the summary names fields by their schema labels
 * and never by a key spelled out here. Every other form is compared section by
 * section, by its own `### ` headings.
 *
 * Pure: the issue bodies come from the `issues: edited` payload
 * (`changes.body.from` is the text before the edit). See
 * test/scripts/answer_changes.test.mjs.
 */

import { NO_RESPONSE, codeSpan, normalizeLabel, parseIssueForm, rawValue } from './issue_body.mjs';

/** Longest a value may be in the summary before it is cut. */
export const MAX_VALUE_CHARS = 200;

/**
 * One answer, on one line, short enough to read in a comment. Flattening
 * matters for more than looks: no part of the submitter's text may stand on a
 * line of its own in a bot comment (see `hasMarker` in notify.mjs).
 * @param {string} value
 * @returns {string}
 */
function shown(value) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '*(blank)*';
  const cut = flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS - 1)}…` : flat;
  return codeSpan(cut);
}

/** `_No response_` and an absent section read the same: blank. */
function answer(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.toLowerCase() === NO_RESPONSE ? '' : trimmed;
}

/**
 * Original-case `### ` headings of a body, keyed by their normalised form.
 * @param {string} body
 * @returns {Map<string, string>}
 */
function headingsOf(body) {
  const out = new Map();
  for (const match of String(body ?? '').matchAll(/^###[ \t]+(.*)$/gm)) {
    const heading = match[1].trim();
    const key = normalizeLabel(heading);
    if (key && !out.has(key)) out.set(key, heading);
  }
  return out;
}

/**
 * @param {string} before the issue body before the edit
 * @param {string} after the issue body now
 * @param {{fields?: object[]|null}} [options] schema fields, for an entry
 * @returns {{label: string, before: string, after: string}[]} in form order
 */
export function answerChanges(before, after, { fields = null } = {}) {
  const changes = [];
  if (Array.isArray(fields) && fields.length > 0) {
    const known = [];
    for (const field of fields) {
      for (const name of [field?.label, field?.key, field?.prompt]) if (name) known.push(name);
    }
    // The write-up is the form's last section and swallows every line after
    // its heading, exactly as new_entry_from_issue.mjs reads it.
    const writeUp = [...fields].reverse().find((field) => field?.type === 'markdown');
    const finalLabel = writeUp ? writeUp.label || writeUp.key || '' : '';
    const old = parseIssueForm(before, known, finalLabel).sections;
    const now = parseIssueForm(after, known, finalLabel).sections;
    for (const field of fields) {
      if (!field?.key || field.form === false) continue;
      const was = rawValue(old, field);
      const is = rawValue(now, field);
      if (was !== is) changes.push({ label: String(field.label || field.key), before: was, after: is });
    }
    return changes;
  }

  const old = parseIssueForm(before, []).sections;
  const now = parseIssueForm(after, []).sections;
  const names = new Map([...headingsOf(before), ...headingsOf(after)]);
  const order = [...now.keys(), ...[...old.keys()].filter((key) => !now.has(key))];
  for (const key of order) {
    const was = answer(old.get(key));
    const is = answer(now.get(key));
    if (was !== is) changes.push({ label: names.get(key) || key, before: was, after: is });
  }
  return changes;
}

/**
 * The summary as a markdown list: one line per changed answer.
 * @param {{label: string, before: string, after: string}[]} changes
 * @returns {string}
 */
export function formatChanges(changes) {
  return changes
    .map(({ label, before, after }) => {
      const name = String(label)
        .replace(/\s+/g, ' ')
        .replace(/[*_`[\]<>@]/g, '')
        .trim();
      return `- **${name}**: ${shown(before)} → ${shown(after)}`;
    })
    .join('\n');
}
