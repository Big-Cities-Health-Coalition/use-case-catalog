#!/usr/bin/env node
/**
 * Decide whether an intake workflow may rebuild (force-push) a draft branch.
 *
 * Input (env):  BRANCH     the draft branch, e.g. entry/<slug>-<issue>
 *               BASE_REF   what the branch is compared against (default HEAD:
 *                          the default-branch commit the workflow checked out)
 * Output:       $GITHUB_OUTPUT  held=true|false, reason, foreign (count)
 *               $GITHUB_STEP_SUMMARY  the reason, for the run page
 *
 * Reads only refs the checkout already fetched (`fetch-depth: 0` brings every
 * branch as refs/remotes/origin/*), so it needs no credentials.
 *
 * What a reviewer's push is protected by, per workflow:
 *   - new-entry, new-event, new-year, also-deployed-by, refresh-entry and
 *     apply-setup push the draft branch themselves with `--force-with-lease`,
 *     whose lease is that same remote-tracking ref. A reviewer commit already
 *     on the branch holds it here; one pushed after the checkout fetched makes
 *     the push fail rather than vanish. No window.
 *   - update-schedule and update-event-attachments go through
 *     peter-evans/create-pull-request, which re-fetches the branch and
 *     force-pushes against its own fetch, so it would overwrite a push made
 *     between this check and that fetch. Their branch names carry a timestamp
 *     (scripts/update_schedule_from_issue.rb,
 *     scripts/update_event_attachments_from_issue.mjs), so every run builds a
 *     branch that did not exist before and there is no reviewer work on it to
 *     lose; this check always finds the branch new there. Giving either a
 *     stable branch name means moving it to the self-push pattern first
 *     (test/scripts/notify_workflows.test.mjs enforces this).
 *
 * Fails safe. If git cannot answer, the branch is reported as held: a missed
 * rebuild costs a reviewer one manual edit, an unwanted one costs their work.
 * See scripts/lib/branch_guard.mjs for the rule.
 */

import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { setOutput } from './lib/actions_output.mjs';
import { LOG_FORMAT, parseLog, verdict } from './lib/branch_guard.mjs';

/**
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * @param {boolean} held
 * @param {string} reason
 * @param {number} foreign
 */
function report(held, reason, foreign = 0) {
  console.log(reason);
  setOutput('held', held ? 'true' : 'false');
  setOutput('reason', reason);
  setOutput('foreign', String(foreign));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Draft branch\n\n${reason}\n`);
  }
}

const branch = String(process.env.BRANCH ?? '').trim();
const base = String(process.env.BASE_REF ?? '').trim() || 'HEAD';

if (!branch || !git(['check-ref-format', '--branch', branch]).ok) {
  report(true, `"${branch}" is not a usable branch name, so nothing is rebuilt.`);
  process.exit(0);
}

const remote = `refs/remotes/origin/${branch}`;
if (!git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]).ok) {
  report(false, `There is no ${branch} branch yet, so it is built fresh.`);
  process.exit(0);
}

const log = git(['log', `--format=${LOG_FORMAT}`, `${base}..${remote}`]);
if (!log.ok) {
  report(
    true,
    `Could not read the history of ${branch} (${log.stderr.trim() || 'git log failed'}), so it is not rebuilt.`
  );
  process.exit(0);
}

const result = verdict(parseLog(log.stdout));
report(result.held, result.reason, result.foreign.length);
