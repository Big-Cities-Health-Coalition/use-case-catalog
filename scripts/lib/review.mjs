/**
 * What a scaffolded pull request tells its reviewer.
 *
 * Two pure functions the entry scaffolder (scripts/new_entry_from_issue.mjs)
 * calls after it has coerced the issue answers:
 *
 *   - `escalations()` — which answers ask for closer review, read from the
 *     schema's per-field `escalate_on` lists (a boolean's `false`, a select or
 *     multiselect option). The workflow labels the pull request
 *     `review:data-governance` when the list is not empty.
 *   - `reviewChecklist()` — the maintainer checklist as markdown: the review
 *     criteria (from `_data/governance.yml` when the site publishes them, so
 *     the pull request and the governance page carry the same list; a generic
 *     five otherwise), the review-status flip the schema asks for, and the
 *     mechanics.
 *
 * Nothing here names a field key: every key, label and value comes from the
 * schema and the answers, so the checklist follows the content model.
 */

import { codeSpan } from './issue_body.mjs';

/** Longest a reported answer is shown before it is cut. */
const UNMATCHED_MAX_CHARS = 120;

/**
 * A submitter's answer as one short, inert code span for a markdown bullet.
 * @param {unknown} value
 * @returns {string}
 */
function shownAnswer(value) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return codeSpan(flat.length > UNMATCHED_MAX_CHARS ? `${flat.slice(0, UNMATCHED_MAX_CHARS - 1)}…` : flat);
}

/**
 * The criteria a pull request checklist falls back to when the site has no
 * `_data/governance.yml` `review.criteria` list. Deliberately generic — a
 * preset with its own governance page overrides them by publishing it.
 * @type {{name: string, body: string}[]}
 */
export const DEFAULT_CRITERIA = [
  { name: 'Completeness', body: 'Every required field is filled in, honestly.' },
  { name: 'Accuracy', body: 'The technology, licensing, open-source and portability claims are correct.' },
  {
    name: 'Data governance',
    body: 'No personal or protected health information in the resource or its documentation; the sensitivity notes are honest and complete.',
  },
  {
    name: 'Reuse readiness',
    body: 'Enough documentation, links and contact detail that another organization could realistically evaluate or adopt it.',
  },
  { name: 'Category fit', body: 'Correctly placed in one of the catalog’s categories.' },
];

/**
 * A field's `escalate_on` list, normalised to an array (empty when absent).
 * @param {object} field schema field
 * @returns {unknown[]}
 */
function escalateOn(field) {
  const list = field?.escalate_on;
  return Array.isArray(list) ? list : [];
}

/**
 * The answers that call for closer review.
 *
 * @param {object[]} fields schema fields (each may carry `escalate_on`)
 * @param {Map<string, unknown>|Record<string, unknown>} values coerced front
 *   matter values by field key
 * @returns {{key: string, label: string, value: string, reason: string}[]}
 *   one item per matching field, in schema order; `reason` is a markdown
 *   line for the pull request body.
 */
export function escalations(fields, values) {
  const get = (key) => (values instanceof Map ? values.get(key) : values?.[key]);
  const out = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = String(field?.key ?? '');
    const on = escalateOn(field);
    if (!key || on.length === 0) continue;
    const label = String(field.label ?? key);
    const value = get(key);
    const type = String(field.type ?? 'text');

    if (type === 'boolean') {
      // A missing answer coerces to false, and false is the honest reading of
      // "not confirmed" — the reviewer should look either way.
      const actual = value === true;
      if (!on.includes(actual)) continue;
      const shown = actual ? 'Yes' : 'not confirmed';
      out.push({ key, label, value: shown, reason: `**${label}**: ${shown}` });
      continue;
    }

    const wanted = new Set(on.map((v) => String(v)));
    const present = (Array.isArray(value) ? value : [value])
      .map((v) => String(v ?? '').trim())
      .filter((v) => v !== '' && wanted.has(v));
    if (present.length === 0) continue;
    const shown = present.join(', ');
    out.push({ key, label, value: shown, reason: `**${label}**: ${shown}` });
  }
  return out;
}

/**
 * The maintainer checklist for a scaffolded pull request, as markdown.
 *
 * @param {object} options
 * @param {{name: string, body?: string}[]} [options.criteria] the review
 *   criteria; `DEFAULT_CRITERIA` when empty or absent
 * @param {{key?: string, start?: string, approved?: string}} [options.status]
 *   the schema's status field (`entry.status_key`), what the scaffold wrote
 *   (`status_scaffold_value`) and what approval means (`status_approved_value`)
 * @param {{reason: string}[]} [options.escalations] from `escalations()`
 * @param {{key: string, label?: string, values: string[]}[]} [options.unmatched]
 *   choice answers that named no option (`coerceChoice` in issue_body.mjs), so
 *   the scaffold left them out of the front matter
 * @param {string} [options.entryDir] e.g. `catalog/service-request-routing`
 * @returns {string} markdown, starting with a `### Closer review` block when
 *   there is anything to escalate, then a `### Answers to fix` block when an
 *   answer matched no option, then `### Maintainer checklist`.
 */
export function reviewChecklist({
  criteria,
  status = {},
  escalations: flagged = [],
  unmatched = [],
  entryDir = '',
} = {}) {
  const list = Array.isArray(criteria) && criteria.length > 0 ? criteria : DEFAULT_CRITERIA;
  const lines = [];

  if (flagged.length > 0) {
    lines.push(
      '### Closer review',
      '',
      'These answers call for a closer look before this is published — the schema flags them for it (`escalate_on`):',
      '',
      ...flagged.map((item) => `- ${item.reason}`),
      ''
    );
  }

  const toFix = (Array.isArray(unmatched) ? unmatched : []).filter(
    (item) => item?.key && Array.isArray(item.values) && item.values.length > 0
  );
  if (toFix.length > 0) {
    lines.push(
      '### Answers to fix',
      '',
      'These answers are not among the field’s options, so they were left out of the front matter. Set each field to one of its options in `_data/schema.yml` before merging — **Validate Content** fails a required field left empty:',
      '',
      ...toFix.map(
        (item) =>
          `- [ ] **${item.label || item.key}** (\`${item.key}\`): ${item.values.map(shownAnswer).join(', ')}`
      ),
      ''
    );
  }

  lines.push('### Maintainer checklist', '', 'Review criteria:', '');
  for (const criterion of list) {
    const name = String(criterion?.name ?? '').trim();
    if (!name) continue;
    const body = String(criterion?.body ?? '').trim();
    lines.push(`- [ ] **${name}**${body ? ` — ${body}` : ''}`);
  }

  lines.push('', 'Before merging:', '');
  lines.push('- [ ] The summary reads clearly to someone outside the submitting team');
  lines.push('- [ ] Front matter values match the schema options and nothing is missing');
  lines.push(
    '- [ ] Screenshots opened at full size — no names, addresses, record numbers or email addresses visible'
  );
  if (entryDir) lines.push(`- [ ] Any PDF or extra file is uploaded into \`${entryDir}/\``);
  lines.push(
    '- [ ] **Validate Content** is green on the *latest* commit (re-check after any bot thumbnail commit)'
  );
  const statusKey = String(status?.key ?? '');
  const approved = String(status?.approved ?? '');
  if (statusKey && approved) {
    const start = String(status?.start ?? '');
    lines.push(
      `- [ ] \`${statusKey}\` set to **${approved}**${start ? ` (the scaffold wrote *${start}*)` : ''} — or the pull request left open with \`review:revisions-requested\` and a comment saying what to change`
    );
  }
  lines.push('- [ ] Merge to publish');
  return lines.join('\n');
}
