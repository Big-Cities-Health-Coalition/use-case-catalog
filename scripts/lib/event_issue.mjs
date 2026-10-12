/**
 * Shared reading of the cohort/event issue forms.
 *
 * The four event scripts (new_event_from_issue, update_event_attachments_from_issue,
 * extract_event_fields, list_events_for_year) each used to carry their own
 * `### heading` splitter. They disagreed with each other and were all
 * last-occurrence-wins, so a heading typed inside a free-text answer replaced
 * the answer GitHub itself collected. They now share this module, which parses
 * through `parseIssueForm` (first occurrence wins, only known headings start a
 * section, everything after the trailing free-text field is prose).
 *
 * The labels below are the ones the cohort forms in scripts/issue-forms/ emit
 * (copied into .github/ISSUE_TEMPLATE/ while the cohorts module is on). Every form's labels are known to every script: a heading has to be
 * recognised to end the previous section, otherwise an unrelated field would be
 * swallowed into the answer above it.
 *
 * Pure: no filesystem beyond path arithmetic, no environment.
 * See test/scripts/event_scripts.test.mjs.
 */

import path from 'node:path';

import { NO_RESPONSE, normalizeLabel, parseIssueForm } from './issue_body.mjs';

/** A cohort year is a directory name under `cohorts/`. */
export const YEAR_PATTERN = /^\d{4}$/;

/** An event id is a directory name under `cohorts/<year>/events/`. */
export const EVENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Headings that answer each logical field, in the order they are tried.
 * `normalizeLabel` already ignores case, spacing and a trailing
 * "(optional)"/"(required)", so only genuinely different wordings are listed.
 */
export const FIELD = {
  year: ['Cohort Year'],
  title: ['Event Title'],
  eventId: ['Event ID'],
  date: ['Event Date'],
  time: ['Event Time'],
  location: ['Event Location'],
  summary: ['Event Summary'],
  attachments: ['Attachments'],
  mode: ['Update Mode', 'Mode'],
  details: ['Event Details (Markdown, optional)', 'Event Details', 'Details'],
  intro: ['Intro Paragraph', 'Intro'],
  notableEvents: ['Notable Events'],
  scheduleEntries: ['Schedule entries (YAML)', 'Schedule Entries'],
  changelog: ['Notes for reviewers'],
};

/** Every heading the event forms can produce; anything else is body text. */
export const EVENT_FORM_LABELS = Object.values(FIELD).flat();

/**
 * The trailing free-form field of each form. Once its heading is seen, the rest
 * of the body is that answer — a `###` inside it is never read as a field.
 */
export const FINAL_LABEL = {
  newEvent: FIELD.details[0],
  attachments: FIELD.attachments[0],
  newYear: FIELD.notableEvents[0],
};

/**
 * Parse an event issue-form body.
 * @param {string} body raw issue body (CRLF tolerated)
 * @param {string} [finalLabel] trailing free-form field, see FINAL_LABEL
 * @returns {{value: (...labels: string[]) => string, sections: Map<string, string>, warnings: string[]}}
 *   `value(...labels)` returns the first answered heading, `''` when the field
 *   is absent or GitHub's `_No response_`.
 */
export function readEventForm(body, finalLabel = '') {
  const { sections, warnings } = parseIssueForm(body, EVENT_FORM_LABELS, finalLabel);
  const value = (...labels) => {
    for (const label of labels) {
      const raw = sections.get(normalizeLabel(label));
      if (raw === undefined) continue;
      const text = raw.trim();
      return text.toLowerCase() === NO_RESPONSE ? '' : text;
    }
    return '';
  };
  return { value, sections, warnings };
}

/**
 * Resolve the folder of one event, refusing anything that is not a plain year
 * and event id and re-checking that the resolved path really is under
 * `cohorts/<year>/events/`.
 *
 * Both halves come from an issue anyone can open, and the jobs that use them
 * run with `contents: write`, so the pattern check and the containment check
 * are deliberately redundant.
 *
 * @param {string} root repository root (usually process.cwd())
 * @param {string} year
 * @param {string} eventId
 * @returns {{dir: string, relative: string, error: string}} `error` is `''` on success
 */
export function resolveEventDir(root, year, eventId) {
  const reject = (error) => ({ dir: '', relative: '', error });
  if (!YEAR_PATTERN.test(year)) {
    return reject(`Refusing to use ${JSON.stringify(year)} as a cohort year; expected four digits.`);
  }
  if (!EVENT_ID_PATTERN.test(eventId)) {
    return reject(`Refusing to use ${JSON.stringify(eventId)} as an event id; expected a lowercase slug.`);
  }

  const base = path.resolve(root, 'cohorts', year, 'events');
  const dir = path.resolve(base, eventId);
  if (!dir.startsWith(`${base}${path.sep}`)) {
    return reject(`Refusing to write outside cohorts/${year}/events/ (${dir}).`);
  }
  return { dir, relative: `cohorts/${year}/events/${eventId}`, error: '' };
}
