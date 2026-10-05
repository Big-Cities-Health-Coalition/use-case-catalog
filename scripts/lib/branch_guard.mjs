/**
 * Whether a submission's draft branch is still the automation's to rebuild.
 *
 * An edit to a submission issue re-runs its intake workflow, which rebuilds
 * the draft branch from the default branch and force-pushes it. That is right
 * while only the automation has touched the branch, and destroys work once a
 * reviewer has committed to it (or pressed "Update branch", which merges the
 * default branch in). This module decides which of the two a branch is in.
 *
 * "The automation" is the committer identity every intake workflow uses:
 * github-actions[bot]. The committer, not the author, because
 * peter-evans/create-pull-request records the person who triggered the run as
 * the author of its commit. A reviewer's commit made on github.com is
 * committed by GitHub itself, and one pushed from a laptop by the reviewer,
 * so either reads as "not the automation". A merge commit always does.
 *
 * Pure; scripts/branch_guard.mjs runs git and reports. See
 * test/scripts/branch_guard.test.mjs.
 */

/** The committer email of every commit the intake workflows make. */
export const AUTOMATION_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/** Field and record separators for the `git log` format below. */
export const FIELD = '\x1f';
export const RECORD = '\x1e';

/** `git log --format` producing what `parseLog` reads. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%cn', '%ce', '%s'].join('%x1f') + '%x1e';

/**
 * @typedef {{sha: string, parents: string[], authorName: string, authorEmail: string,
 *   committerName: string, committerEmail: string, subject: string}} Commit
 */

/**
 * @param {string} output `git log --format=LOG_FORMAT` output
 * @returns {Commit[]}
 */
export function parseLog(output) {
  return String(output ?? '')
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [
        sha = '',
        parents = '',
        authorName = '',
        authorEmail = '',
        committerName = '',
        committerEmail = '',
        subject = '',
      ] = record.split(FIELD);
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        subject: subject.trim(),
      };
    });
}

/**
 * The commits on the branch that someone other than the automation made.
 * @param {Commit[]} commits the commits on the branch and not on its base
 * @param {{automationEmail?: string}} [options]
 * @returns {Commit[]}
 */
export function foreignCommits(commits, { automationEmail = AUTOMATION_EMAIL } = {}) {
  const bot = automationEmail.toLowerCase();
  return (Array.isArray(commits) ? commits : []).filter(
    (commit) => commit.parents.length > 1 || String(commit.committerEmail).toLowerCase() !== bot
  );
}

/**
 * The verdict, with a sentence for the run summary.
 * @param {Commit[]} commits
 * @param {{automationEmail?: string}} [options]
 * @returns {{held: boolean, reason: string, foreign: Commit[]}}
 */
export function verdict(commits, options) {
  const foreign = foreignCommits(commits, options);
  if (foreign.length === 0) {
    return {
      held: false,
      reason: 'Only the automation has committed to this branch, so it is rebuilt.',
      foreign,
    };
  }
  const merges = foreign.filter((commit) => commit.parents.length > 1).length;
  const people = [
    ...new Set(foreign.filter((c) => c.parents.length <= 1).map((c) => c.authorName || c.committerName)),
  ];
  const parts = [];
  if (people.length > 0) parts.push(`commits by ${people.join(', ')}`);
  if (merges > 0)
    parts.push(`${merges} merge commit${merges === 1 ? '' : 's'} (for example from "Update branch")`);
  return {
    held: true,
    reason: `The branch has ${parts.join(' and ')}, so it is not rebuilt; the reviewer applies the edit by hand.`,
    foreign,
  };
}
