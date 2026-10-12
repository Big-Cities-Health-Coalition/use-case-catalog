/**
 * Which open pull request is a submission's draft.
 *
 * An intake workflow names its draft branch from the submission: new-entry
 * uses `entry/<slug>-<issue>`, and the slug comes from the title. So when a
 * submitter edits the title, the next run proposes a branch name nobody has
 * used, and opening a pull request on it gives the issue a second draft. The
 * first draft keeps the reviewer's commits and notes, and closing it later
 * read as a decline. One issue has one draft: the run finds the draft already
 * open for its issue and keeps that branch, whatever the new name would be.
 * The guard (scripts/branch_guard.mjs) then decides, on that branch, whether
 * the run may rebuild it or hands the edit to the reviewer.
 *
 * A draft is an open pull request from a branch of this repository, carrying
 * the intake label, whose body links the issue with "Closes #N" (the line
 * every intake workflow writes) and whose branch has the shape that workflow
 * gives it. The shape check keeps a run from ever pushing to a branch the
 * automation did not name, whatever a pull request's body says.
 *
 * `draftsForIssue` is pure; `findDraftBranch` reads the open pull requests
 * through github-script's Octokit. See test/scripts/drafts.test.mjs.
 */

import { linkedIssue } from './notify.mjs';

/** A slug: what `slugify` produces and the scaffolders re-check. */
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';

const quietCore = { info() {}, warning() {} };

/**
 * The shape of a draft branch for one issue.
 * @param {string} prefix e.g. `entry/`
 * @param {number|string} issue
 * @param {{numbered?: boolean}} [options] `numbered`: the name ends in `-<issue>`
 * @returns {RegExp}
 */
export function draftBranchPattern(prefix, issue, { numbered = false } = {}) {
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}${SLUG}${numbered ? `-${Number(issue)}` : ''}$`);
}

/**
 * The open drafts for an issue, oldest first.
 *
 * @param {object[]} pulls pull requests as the REST API lists them
 * @param {object} options
 * @param {number|string} options.issue the submission issue
 * @param {string} options.repository "owner/repo": a pull request from a fork is never a draft
 * @param {string} options.label the intake label, e.g. `content:new-entry`
 * @param {string} [options.prefix] the branch prefix; omit to accept any branch
 * @param {boolean} [options.numbered] the branch name ends in `-<issue>`
 * @param {number} [options.exclude] a pull request to leave out (the one being closed)
 * @returns {object[]}
 */
export function draftsForIssue(
  pulls,
  { issue, repository, label, prefix = '', numbered = false, exclude } = {}
) {
  const wanted = Number(issue);
  const pattern = prefix ? draftBranchPattern(prefix, wanted, { numbered }) : null;
  return (Array.isArray(pulls) ? pulls : [])
    .filter(
      (pull) =>
        pull &&
        (pull.state ?? 'open') === 'open' &&
        pull.number !== exclude &&
        pull.head?.repo?.full_name === repository &&
        (pull.labels ?? []).some((item) => (typeof item === 'string' ? item : item?.name) === label) &&
        linkedIssue(pull.body) === wanted &&
        (!pattern || pattern.test(String(pull.head?.ref ?? '')))
    )
    .sort((a, b) => a.number - b.number);
}

/**
 * The branch an intake run should build: the open draft's, when the issue has
 * one, otherwise the name the scaffolder proposed.
 *
 * @param {object} options
 * @param {object} options.github Octokit from github-script
 * @param {object} options.context github-script's context (an `issues` event)
 * @param {object} [options.core]
 * @param {string} options.proposed the branch name the scaffolder derived
 * @param {string} options.label the intake label
 * @param {string} options.prefix the branch prefix the scaffolder uses
 * @param {boolean} [options.numbered] the scaffolder ends the name in `-<issue>`
 * @returns {Promise<{branch: string, pull: number|null}>}
 */
export async function findDraftBranch({
  github,
  context,
  core = quietCore,
  proposed,
  label,
  prefix,
  numbered = false,
}) {
  const { owner, repo } = context.repo;
  const issue = Number(context.issue.number);
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  const drafts = draftsForIssue(pulls, { issue, repository: `${owner}/${repo}`, label, prefix, numbered });
  const draft = drafts[0];
  if (!draft) {
    core.info(`#${issue} has no open draft yet, so ${proposed} is built.`);
    return { branch: String(proposed ?? ''), pull: null };
  }
  if (drafts.length > 1) {
    const others = drafts.slice(1).map((pull) => `#${pull.number}`);
    core.warning(
      `#${issue} has more than one open draft (#${draft.number}, ${others.join(', ')}); the oldest, #${draft.number}, is the one kept up to date. Close the others.`
    );
  }
  const branch = String(draft.head.ref);
  if (branch !== proposed) {
    core.info(
      `#${issue} already has a draft, #${draft.number} on ${branch}, so the edit goes there instead of to a new ${proposed}.`
    );
  }
  return { branch, pull: draft.number };
}
