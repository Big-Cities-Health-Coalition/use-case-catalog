/**
 * The rule that keeps an issue edit from erasing a reviewer's commits
 * (scripts/lib/branch_guard.mjs), and the CLI the intake workflows run,
 * against a real throwaway git repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AUTOMATION_EMAIL,
  FIELD,
  RECORD,
  foreignCommits,
  parseLog,
  verdict,
} from '../../scripts/lib/branch_guard.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'branch_guard.mjs'
);

const commit = (overrides = {}) => ({
  sha: 'a',
  parents: ['p'],
  authorName: 'Jane',
  authorEmail: 'jane@example.org',
  committerName: 'github-actions[bot]',
  committerEmail: AUTOMATION_EMAIL,
  subject: 's',
  ...overrides,
});

test('parseLog reads the format the CLI asks git for', () => {
  const out =
    ['abc', 'p1 p2', 'Jane', 'j@x', 'GitHub', 'noreply@github.com', 'Merge main'].join(FIELD) + RECORD + '\n';
  assert.deepEqual(parseLog(out), [
    {
      sha: 'abc',
      parents: ['p1', 'p2'],
      authorName: 'Jane',
      authorEmail: 'j@x',
      committerName: 'GitHub',
      committerEmail: 'noreply@github.com',
      subject: 'Merge main',
    },
  ]);
  assert.deepEqual(parseLog(''), []);
});

test('only the automation committing (whoever is the author) leaves the branch to be rebuilt', () => {
  assert.equal(verdict([commit(), commit({ committerEmail: AUTOMATION_EMAIL.toUpperCase() })]).held, false);
  assert.equal(verdict([]).held, false);
});

test("a person's commit or any merge commit holds the branch", () => {
  const person = commit({ committerName: 'Rev', committerEmail: 'rev@example.org', authorName: 'Rev' });
  const merge = commit({ parents: ['p1', 'p2'] });
  assert.deepEqual(foreignCommits([commit(), person, merge]), [person, merge]);
  const result = verdict([commit(), person, merge]);
  assert.equal(result.held, true);
  assert.match(result.reason, /commits by Rev and 1 merge commit \(for example from "Update branch"\)/);
});

/** Run git in `cwd` with a fixed identity, failing the test on error. */
function git(cwd, args, identity = {}) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identity.name ?? 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: identity.email ?? AUTOMATION_EMAIL,
    GIT_COMMITTER_NAME: identity.name ?? 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: identity.email ?? AUTOMATION_EMAIL,
  };
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Read the heredoc pairs setOutput writes. */
function outputs(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const match of text.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) out[match[1]] = match[3];
  return out;
}

function guard(cwd, branch) {
  const file = path.join(cwd, '..', `out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, '');
  const result = spawnSync(process.execPath, [CLI], {
    cwd,
    env: { ...process.env, BRANCH: branch, GITHUB_OUTPUT: file, GITHUB_STEP_SUMMARY: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return outputs(file);
}

test('the CLI on a real repository: fresh, bot-only, reviewer commit, Update branch', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-guard-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'main'], { name: 'Maintainer', email: 'm@example.org' });

  assert.equal(guard(repo, 'entry/new-41').held, 'false', 'no branch yet: built fresh');

  // The automation's draft, as refs/remotes/origin/<branch> after a fetch.
  git(repo, ['checkout', '-q', '-b', 'draft']);
  fs.writeFileSync(path.join(repo, 'entry.md'), 'draft\n');
  git(repo, ['add', 'entry.md']);
  git(repo, ['commit', '-q', '-m', 'Add entry']);
  git(repo, ['update-ref', 'refs/remotes/origin/entry/new-41', 'HEAD']);
  git(repo, ['checkout', '-q', 'main']);
  assert.deepEqual(guard(repo, 'entry/new-41'), {
    held: 'false',
    reason: 'Only the automation has committed to this branch, so it is rebuilt.',
    foreign: '0',
  });

  // A reviewer commits to it.
  git(repo, ['checkout', '-q', 'draft']);
  fs.writeFileSync(path.join(repo, 'entry.md'), 'reviewed\n');
  git(repo, ['commit', '-q', '-am', 'Tidy'], { name: 'Reviewer', email: 'r@example.org' });
  git(repo, ['update-ref', 'refs/remotes/origin/entry/new-41', 'HEAD']);
  git(repo, ['checkout', '-q', 'main']);
  const held = guard(repo, 'entry/new-41');
  assert.equal(held.held, 'true');
  assert.equal(held.foreign, '1');
  assert.match(held.reason, /commits by Reviewer/);

  // "Update branch": a merge of main into a bot-only branch.
  git(repo, ['checkout', '-q', '-b', 'draft2', 'main']);
  fs.writeFileSync(path.join(repo, 'b.md'), 'draft\n');
  git(repo, ['add', 'b.md']);
  git(repo, ['commit', '-q', '-m', 'Add entry']);
  git(repo, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(repo, ['commit', '-q', '-am', 'main moves'], { name: 'Maintainer', email: 'm@example.org' });
  git(repo, ['checkout', '-q', 'draft2']);
  git(repo, ['merge', '-q', '--no-ff', '--no-edit', 'main'], { name: 'GitHub', email: 'noreply@github.com' });
  git(repo, ['update-ref', 'refs/remotes/origin/entry/other-42', 'HEAD']);
  git(repo, ['checkout', '-q', 'main']);
  const merged = guard(repo, 'entry/other-42');
  assert.equal(merged.held, 'true');
  assert.match(merged.reason, /merge commit/);

  // A name git would refuse is held, never acted on.
  assert.equal(guard(repo, 'bad..name').held, 'true');
});
