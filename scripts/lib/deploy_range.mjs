/**
 * Which commits a Pages deploy published for the first time.
 *
 * pages.yml's concurrency group cancels an in-progress deploy when a newer
 * push to main arrives, so after two quick merges only the second deploy
 * finishes, and it publishes both. Its announce job therefore needs every
 * commit since the last deploy that succeeded, not just the commit it was
 * started for. Called from scripts/lib/notify_github.mjs with
 * actions/github-script's `github`, `context` and `core`; needs `actions: read`.
 */

/** A range longer than this is not looked up commit by commit. */
export const MAX_RANGE = 100;

/**
 * The main line from `head` back to (not including) `base`: the commits a
 * first-parent walk visits, oldest first. A merge commit stands for the pull
 * request it merged, so the branch commits it brought in are left out.
 * @param {Array<{sha: string, parents?: Array<{sha: string}>}>} commits a compare's commits
 * @param {string} base
 * @param {string} head
 * @returns {string[]}
 */
export function mainLine(commits, base, head) {
  const bySha = new Map((commits ?? []).map((commit) => [commit.sha, commit]));
  const line = [];
  for (let sha = head; sha && sha !== base && bySha.has(sha); sha = bySha.get(sha).parents?.[0]?.sha) {
    line.push(sha);
  }
  return line.reverse();
}

/**
 * The commits on main this deploy published that no earlier successful push
 * deploy did, oldest first; `[context.sha]` alone when that cannot be worked
 * out (no earlier successful run, a range over MAX_RANGE commits, main
 * rewritten, or an API error, which is a warning). Never throws.
 * @param {{github: object, context: object, core: object}} options
 * @returns {Promise<string[]>}
 */
export async function commitsSinceLastDeploy({ github, context, core }) {
  const { owner, repo } = context.repo;
  const head = context.sha;
  const alone = (level, reason) => {
    core[level](`${reason}, so only this push (${head}) is announced.`);
    return [head];
  };
  try {
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: context.runId });
    const { data: runs } = await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: run.workflow_id,
      branch: run.head_branch,
      event: 'push',
      status: 'success',
      exclude_pull_requests: true,
      per_page: 10,
    });
    // A re-run keeps this run's id: never compare a deploy with itself.
    const previous = (runs.workflow_runs ?? []).find((candidate) => candidate.id !== context.runId);
    if (!previous?.head_sha) return alone('info', 'There is no earlier successful deploy of this branch');
    const base = previous.head_sha;

    const { data: range } = await github.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head,
      per_page: MAX_RANGE,
    });
    if (range.status !== 'ahead') {
      return alone(
        'info',
        `Compared with the last successful deploy (${base}), this push is ${range.status}`
      );
    }
    if (range.ahead_by > MAX_RANGE) {
      return alone(
        'info',
        `${range.ahead_by} commits landed since the last successful deploy (${base}), more than ${MAX_RANGE}`
      );
    }
    const line = mainLine(range.commits, base, head);
    if (line.at(-1) !== head) {
      return alone('warning', `Could not follow main from ${base} to this push`);
    }
    core.info(`Announcing the ${line.length} commit(s) on main since the last successful deploy (${base}).`);
    return line;
  } catch (error) {
    return alone(
      'warning',
      `Could not read the commits since the last successful deploy (${error?.status ?? error?.message})`
    );
  }
}
