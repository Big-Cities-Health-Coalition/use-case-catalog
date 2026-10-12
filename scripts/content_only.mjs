#!/usr/bin/env node
/**
 * Is this pull request content-only? Run by .github/workflows/content-only.yml,
 * the one job every pull-request check workflow uses to decide whether its
 * code jobs run. The rule itself is scripts/lib/content_only.mjs.
 *
 * Input (env):  BASE_REF   what the change is measured against: the pull
 *                          request's base SHA, or origin/<default branch> for a
 *                          dispatched run on a bot branch
 * Output:       $GITHUB_OUTPUT  content_only=true|false
 *               $GITHUB_STEP_SUMMARY  the answer and the files that decided it
 *
 * The change set is `git diff <base>...HEAD`: what the branch changes since it
 * left the base, which is what merging it would change. `--no-renames` lists a
 * move as a deletion plus an addition, so moving a script into an entry folder
 * still shows the script's path. Fails safe: if git cannot answer, the answer
 * is false and every check runs.
 */

import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { setOutput } from './lib/actions_output.mjs';
import { isContentOnly } from './lib/content_only.mjs';
import { readSchema } from './lib/setup-io.mjs';

const root = process.cwd();
const base = String(process.env.BASE_REF ?? '').trim();

/** The changed paths, or null when git cannot say. */
function changedFiles() {
  if (!base) return null;
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stderr.trim());
    return null;
  }
  return result.stdout.split('\0').filter((file) => file !== '');
}

const files = changedFiles();
const contentOnly = files !== null && isContentOnly(files, readSchema(root));

let reason;
if (!base) reason = 'Not a pull request or a dispatched run, so every check runs.';
else if (files === null) reason = `Could not diff against \`${base}\`, so every check runs.`;
else if (files.length === 0) reason = 'No changed files, so every check runs.';
else if (contentOnly)
  reason = `All ${files.length} changed file(s) are entry content: only the content check runs.`;
else reason = `${files.length} changed file(s), not all of them entry content: every check runs.`;

console.log(reason);
for (const file of files ?? []) console.log(`  ${file}`);
setOutput('content_only', String(contentOnly));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Content-only check\n\n${reason}\n`);
}
