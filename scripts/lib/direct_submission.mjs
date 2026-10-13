/**
 * Entry submissions that arrive without their label.
 *
 * Every content workflow starts from a `content:*` label, and the entry form
 * puts `content:new-entry` on the issue for anyone. An issue created through
 * GitHub's REST API does not get it: GitHub silently drops the labels of a
 * request from someone without push access to the repository. That is how
 * "Sign in with GitHub, submit directly" (assets/js/submit/direct.js) files a
 * submission — as the submitter, through the API — so its issues open bare.
 *
 * new-entry.yml's `claim` job recognises such an issue by its shape — the
 * entry form's title prefix and every question's `### <Label>` heading, the
 * body GitHub's own form would have written — and labels it, and the scaffold
 * job then runs for it in the same workflow run (a label added with the
 * workflow's token starts no new run). missing-label.yml leaves the same issues
 * alone, so a submission is never told its label is missing while it is being
 * claimed. An issue that only looks like a submission is no risk: anyone can
 * open the real form, and either way the result is a draft pull request a
 * maintainer has to merge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

import { groupedFormFields } from '../../assets/js/configurator/issue-template.js';
import { ENTRY_LABEL, STATUS } from './notify.mjs';
import { normalizeLabel, parseSections } from './issue_body.mjs';
import { addTriageLabel, notifyIssue } from './notify_github.mjs';

const quietCore = { info() {}, warning() {}, notice() {} };

/**
 * What an entry submission looks like for this schema.
 * @param {object} schema parsed _data/schema.yml
 * @returns {{prefix: string, labels: string[], finalLabel: string}} `prefix` lower-cased,
 *   `labels` the question headings in form order
 */
export function entryIssueShape(schema) {
  const singular = String(schema?.entry?.singular ?? 'Entry').trim() || 'Entry';
  const fields = groupedFormFields(schema).flatMap((section) => section.fields);
  const labels = fields.map((field) => String(field.label ?? '').trim()).filter(Boolean);
  // The generator adds a Title question of its own when the schema has none.
  if (!fields.some((field) => field.key === 'title')) labels.unshift('Title');
  // Seal the parser at the write-up only when it really is the form's last
  // question; sealing earlier would hide every question after it.
  const last = fields[fields.length - 1];
  return {
    prefix: `[${singular}] `.toLowerCase(),
    labels,
    finalLabel: last?.type === 'markdown' ? String(last.label ?? '').trim() : '',
  };
}

/**
 * Whether an issue is an entry submission: the form's title prefix (in any
 * case — the page and the form capitalise the noun differently) and a heading
 * for every question.
 * @param {{title?: string, body?: string, schema: object}} issue
 * @returns {boolean}
 */
export function isEntrySubmission({ title, body, schema }) {
  const shape = entryIssueShape(schema);
  if (shape.labels.length === 0) return false;
  if (
    !String(title ?? '')
      .toLowerCase()
      .startsWith(shape.prefix)
  )
    return false;
  const sections = parseSections(String(body ?? ''), shape.labels, shape.finalLabel);
  return shape.labels.every((label) => sections.has(normalizeLabel(label)));
}

/**
 * @param {string} root the checkout
 * @returns {object} parsed _data/schema.yml, {} when missing or unreadable
 */
export function loadSchema(root) {
  try {
    return load(fs.readFileSync(path.join(root, '_data', 'schema.yml'), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * Whether someone took the entry label off this issue: a maintainer stopping
 * the automation, which an edit must not undo. When the history cannot be
 * read the answer is no — an unlabelled submission nobody picks up is the
 * worse outcome — with a warning.
 * @returns {Promise<boolean>}
 */
async function labelWasRemoved({ github, core, owner, repo, issue }) {
  try {
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    return events.some((event) => event?.event === 'unlabeled' && event?.label?.name === ENTRY_LABEL);
  } catch (error) {
    core.warning(
      `Could not read the label history of #${issue.number} (${error?.status ?? error?.message}).`
    );
    return false;
  }
}

/**
 * new-entry.yml `claim`: label an unlabelled entry submission so the scaffold
 * job takes it. It runs on `opened` and on `edited` — an edit straight after
 * submitting cancels the opened run, possibly before its claim — and is safe
 * to repeat: adding a label the issue has is a no-op, and the "label missing"
 * message is posted once. On an edit it leaves alone an issue whose label a
 * maintainer removed. When the label cannot be added — classically a fork that never
 * ran Bootstrap labels — the submitter and the maintainers get the same "label
 * missing" message missing-label.yml would have posted.
 * @param {{github: object, context: object, core?: object, root: string}} options
 * @returns {Promise<boolean>} whether the issue is now labelled for the scaffold job
 */
export async function claimEntrySubmission({ github, context, core = quietCore, root }) {
  const issue = context.payload?.issue ?? {};
  const schema = loadSchema(root);
  if (!isEntrySubmission({ title: issue.title, body: issue.body, schema })) {
    core.info(`#${issue.number} is not an entry submission; leaving it alone.`);
    return false;
  }
  const { owner, repo } = context.repo;
  if (context.payload?.action === 'edited' && (await labelWasRemoved({ github, core, owner, repo, issue }))) {
    core.info(`${ENTRY_LABEL} was removed from #${issue.number} by hand; leaving it alone.`);
    return false;
  }
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [ENTRY_LABEL] });
    core.info(`#${issue.number} is an entry submission without its label; added ${ENTRY_LABEL}.`);
    return true;
  } catch (error) {
    core.warning(`Could not add ${ENTRY_LABEL} to #${issue.number} (${error?.status ?? error?.message}).`);
  }
  const outsider = !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(issue.author_association ?? ''));
  await notifyIssue({
    github,
    context,
    core,
    kind: 'label_missing',
    once: true,
    status: outsider ? STATUS.received : '',
    vars: { form_name: 'New entry', form_label: ENTRY_LABEL },
  });
  if (outsider) await addTriageLabel({ github, context, core });
  return false;
}
