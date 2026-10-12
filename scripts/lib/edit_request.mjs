/**
 * Edit requests: the answer to the "Suggest an edit" link on every entry page.
 *
 * The link opens .github/ISSUE_TEMPLATE/edit-entry.yml with the entry's slug
 * filled in, and the issue arrives labelled `content:edit-request`. Nothing
 * here edits the entry. A maintainer, or a coding agent they assign, makes the
 * change on a pull request that says `Closes #N` (docs/edit-requests.md), and a
 * person merges it. This module only answers the requester: one comment with
 * the issue number and the /status/ link, `status:received` on the issue, and,
 * when the slug names no entry, a polite request for the page address.
 *
 * Called from .github/workflows/edit-request.yml. Anyone can open the issue, so
 * the slug is pattern-checked before it becomes a path, the resolved path is
 * re-checked against the entry directory, and the slug is only written back
 * into the comment when it is a plain slug. See test/scripts/edit_request.test.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseIssueForm, rawValue } from './issue_body.mjs';
import { DEFAULT_MESSAGES, STATUS, currentStatus, fill } from './notify.mjs';
import { loadSettings, notifyIssue } from './notify_github.mjs';
import { entryPathFrom, readSchema } from './setup-io.mjs';

/** A slug is a folder name under the entry path (scripts/refresh_entry_from_issue.mjs uses the same shape). */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A slug short enough to write back into a comment; anything else is described, not quoted. */
const echoable = (slug) => SLUG_PATTERN.test(String(slug ?? '')) && String(slug).length <= 100;

/** The form's field labels, in template order: the issue body's `### ` headings. */
export const FIELD = Object.freeze({
  slug: 'Entry slug',
  relationship: 'How are you connected to this entry?',
  change: 'What should change?',
  contactName: 'Your name (optional)',
  contactEmail: 'Your email (optional)',
});

/**
 * The entry the request is about, as typed in the slug box. A pasted page
 * address is reduced to its last path segment, since that is the slug.
 * @param {unknown} body raw issue body
 * @returns {string} lowercased; '' when the box is empty
 */
export function readEditRequestSlug(body) {
  const { sections } = parseIssueForm(String(body ?? '').replace(/\r\n?/g, '\n'), Object.values(FIELD));
  const typed = rawValue(sections, { label: FIELD.slug })
    .replace(/`/g, '')
    .replace(/[?#].*$/s, '')
    .trim();
  return (typed.split('/').filter(Boolean).at(-1) ?? '').toLowerCase();
}

/**
 * Whether `<entry path>/<slug>/index.md` exists, the entry path read from
 * `_data/schema.yml`.
 * @param {string} root repository root
 * @param {string} slug
 * @returns {boolean}
 */
export function entryExists(root, slug) {
  if (!SLUG_PATTERN.test(String(slug ?? ''))) return false;
  const base = path.resolve(root, entryPathFrom(readSchema(root)));
  const dir = path.resolve(base, slug);
  if (!dir.startsWith(`${base}${path.sep}`)) return false;
  return fs.existsSync(path.join(dir, 'index.md'));
}

/**
 * The paragraph that asks for the page address, '' when the entry was found.
 * @param {{messages?: Record<string, string>}} settings from `loadSettings`
 * @param {{slug: string, found: boolean}} lookup
 * @returns {string}
 */
export function unknownEntryNote(settings, { slug, found }) {
  if (found) return '';
  const template =
    settings?.messages?.edit_request_unknown_entry ?? DEFAULT_MESSAGES.edit_request_unknown_entry;
  return fill(template, { entry: echoable(slug) ? `\`${slug}\`` : 'the entry you named' });
}

/** @param {Array<string|{name?: string}>} labels @returns {string[]} */
const labelNames = (labels) =>
  (labels ?? []).map((label) => (typeof label === 'string' ? label : String(label?.name ?? '')));

/**
 * The issue's labels as they are now. The event payload is a snapshot: an
 * `edited` run can wait in the per-issue queue while the request is published
 * or declined, and its copy would then show no status at all.
 * @returns {Promise<string[]|null>} null when the issue could not be re-read
 */
async function liveLabels(github, core, { owner, repo, issue_number }) {
  try {
    const { data } = await github.rest.issues.get({ owner, repo, issue_number });
    return labelNames(data.labels);
  } catch (error) {
    core?.warning?.(
      `Could not re-read #${issue_number}'s labels (${error?.status ?? error?.message}); leaving its status alone.`
    );
    return null;
  }
}

/**
 * Acknowledge the event's edit request, once, and mark it received unless it
 * currently has a status (an edit to an issue that has moved on leaves it be).
 * The labels are re-read from the API, not taken from the event payload; when
 * that read fails the comment still goes out and the status is left alone.
 *
 * @param {object} options
 * @param {object} options.github Octokit from github-script
 * @param {object} options.context github-script's context
 * @param {object} [options.core]
 * @param {string} [options.body] the issue body, from the step's `env:`
 * @param {string} [options.root] the default-branch checkout
 * @returns {Promise<{slug: string, found: boolean, posted: boolean}>}
 */
export async function acknowledgeEditRequest({
  github,
  context,
  core,
  body = '',
  root = process.env.GITHUB_WORKSPACE || process.cwd(),
}) {
  const { owner, repo } = context.repo;
  const slug = readEditRequestSlug(body);
  const found = entryExists(root, slug);
  const labels = await liveLabels(github, core, { owner, repo, issue_number: Number(context.issue.number) });
  const settings = await loadSettings({ root, repository: `${owner}/${repo}`, core });
  const { posted } = await notifyIssue({
    github,
    context,
    core,
    kind: 'edit_request',
    once: true,
    status: labels && !currentStatus(labels) ? STATUS.received : '',
    vars: { entry_note: unknownEntryNote(settings, { slug, found }) },
    settings,
    labels: labels ?? undefined,
  });
  return { slug, found, posted };
}
