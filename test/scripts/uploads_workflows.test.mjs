/**
 * The workflow wiring around uploaded files: the scaffold step gets a
 * read-only token for the uploads repository (and nothing else does), the
 * cleanup workflow mints the only write token, and with UPLOADS_REPO unset
 * the feature is off with a clean summary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { evaluate, runs } from '../helpers/workflow_expr.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', '.github', 'workflows');
const load = (name) => YAML.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const entry = load('new-entry.yml');
const cleanup = load('uploads-cleanup.yml');
const step = (job, id) => job.steps.find((s) => s.id === id);
const TOKEN_ACTION = /^actions\/create-github-app-token@[0-9a-f]{40}$/;
const SHA_COMMENT = /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+/;

test('new-entry: the token step runs only when UPLOADS_REPO is set and is read-only', () => {
  const token = step(entry.jobs.scaffold, 'uploads-token');
  assert.equal(token.if, "vars.UPLOADS_REPO != ''");
  assert.match(token.uses, TOKEN_ACTION);
  assert.equal(token.with['permission-contents'], 'read');
  assert.equal(token.with['app-id'], '${{ secrets.UPLOADS_APP_ID }}');
  assert.equal(token.with['private-key'], '${{ secrets.UPLOADS_APP_PRIVATE_KEY }}');
  assert.ok(Object.keys(token.with).filter((k) => k.startsWith('permission-')).length === 1, 'only contents');
  assert.match(fs.readFileSync(path.join(DIR, 'new-entry.yml'), 'utf8'), SHA_COMMENT);
  const split = step(entry.jobs.scaffold, 'uploads-repo');
  for (const v of [true, false]) {
    assert.equal(runs(token, { vars: { UPLOADS_REPO: v ? 'o/r' : '' } }), v);
    assert.equal(runs(split, { vars: { UPLOADS_REPO: v ? 'o/r' : '' } }), v);
  }
});

test('new-entry: a failed token mint never fails the submission; the scaffolder runs with an empty token', () => {
  const steps = entry.jobs.scaffold.steps;
  for (const id of ['uploads-repo', 'uploads-token']) {
    assert.equal(step(entry.jobs.scaffold, id)['continue-on-error'], true, id);
  }
  // No condition of its own between the mint and the scaffolder: it runs, and
  // a failed mint's output is simply empty (scripts/lib/uploads.mjs warns).
  const scaffold = step(entry.jobs.scaffold, 'scaffold');
  assert.equal(scaffold.if, undefined);
  assert.equal(runs(scaffold, { vars: { UPLOADS_REPO: 'o/r' } }), true);
  const between = steps.slice(
    steps.indexOf(step(entry.jobs.scaffold, 'uploads-repo')),
    steps.indexOf(scaffold)
  );
  for (const s of between) assert.equal(s['continue-on-error'], true, s.id ?? s.name);
});

test('new-entry: UPLOADS_TOKEN reaches exactly one step, the scaffolder, just before it', () => {
  const steps = Object.values(entry.jobs).flatMap((j) => j.steps);
  const holders = steps.filter((s) => s.env && 'UPLOADS_TOKEN' in s.env);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].id, 'scaffold');
  assert.equal(holders[0].env.UPLOADS_TOKEN, '${{ steps.uploads-token.outputs.token }}');
  assert.equal(holders[0].env.UPLOADS_REPO, '${{ vars.UPLOADS_REPO }}');
  assert.equal(holders[0].env.ISSUE_AUTHOR_ID, '${{ github.event.issue.user.id }}');
  const text = fs.readFileSync(path.join(DIR, 'new-entry.yml'), 'utf8');
  assert.equal(text.match(/steps\.uploads-token\.outputs\.token/g).length, 1);
  const names = entry.jobs.scaffold.steps.map((s) => s.id ?? s.name);
  assert.equal(names.indexOf('uploads-token') + 1, names.indexOf('scaffold'));
});

test('cleanup: triggers, empty top-level permissions, concurrency', () => {
  assert.deepEqual(Object.keys(cleanup.on).sort(), [
    'issues',
    'pull_request',
    'schedule',
    'workflow_dispatch',
  ]);
  assert.deepEqual(cleanup.on.issues.types, ['closed']);
  assert.deepEqual(cleanup.on.pull_request.types, ['closed']);
  assert.equal(cleanup.on.schedule.length, 1);
  const [minute, hour] = cleanup.on.schedule[0].cron.split(' ');
  assert.notEqual(minute, '0');
  assert.match(hour, /^\d+$/);
  assert.deepEqual(cleanup.permissions, {});
});

test('cleanup: one concurrency group per closed issue or pull request, and one for sweeps', () => {
  // GitHub keeps one pending run per group, so a shared group would cancel
  // queued close runs; each close keys its own group.
  assert.equal(cleanup.concurrency['cancel-in-progress'], false);
  const m = /^uploads-cleanup-\$\{\{ (.+) \}\}$/.exec(cleanup.concurrency.group);
  assert.ok(m, cleanup.concurrency.group);
  const group = (event) => `uploads-cleanup-${evaluate(m[1], { github: { event } })}`;
  assert.equal(group({ issue: { number: 41 } }), 'uploads-cleanup-41');
  assert.equal(group({ pull_request: { number: 42 } }), 'uploads-cleanup-42');
  assert.equal(group({ schedule: '47 4 * * *' }), 'uploads-cleanup-sweep');
  assert.equal(group({ inputs: { dry_run: true } }), 'uploads-cleanup-sweep');
});

test('cleanup: the real job needs UPLOADS_REPO and, for a closed issue, the entry label', () => {
  const job = cleanup.jobs.cleanup;
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'read' });
  const labelled = { event: { issue: { labels: [{ name: 'content:new-entry' }] } } };
  const plain = { event: { issue: { labels: [{ name: 'bug' }] } } };
  const ctx = (base, event_name, repo) => ({ github: { event_name, ...base }, vars: { UPLOADS_REPO: repo } });
  assert.equal(runs(job, ctx(labelled, 'issues', 'o/r')), true);
  assert.equal(runs(job, ctx(plain, 'issues', 'o/r')), false);
  assert.equal(runs(job, ctx(plain, 'schedule', 'o/r')), true);
  assert.equal(runs(job, ctx(plain, 'workflow_dispatch', 'o/r')), true);
  assert.equal(runs(job, ctx(labelled, 'issues', '')), false);
  assert.equal(runs(job, ctx(plain, 'schedule', '')), false);
});

test('cleanup: the turned-off job runs exactly when the feature is off, and says why', () => {
  const off = cleanup.jobs['turned-off'];
  const ctx = (event_name, repo, name = 'content:new-entry') => ({
    github: { event_name, event: { issue: { labels: [{ name }] } } },
    vars: { UPLOADS_REPO: repo },
  });
  assert.equal(runs(off, ctx('schedule', '')), true);
  assert.equal(runs(off, ctx('issues', '')), true);
  assert.equal(runs(off, ctx('issues', '', 'bug')), false);
  assert.equal(runs(off, ctx('schedule', 'o/r')), false);
  assert.match(off.steps[0].run, /UPLOADS_REPO[\s\S]*GITHUB_STEP_SUMMARY/);
  assert.equal(off.permissions, undefined);
});

test('cleanup: the write token is minted here, scoped to contents write, and reaches only the script', () => {
  const job = cleanup.jobs.cleanup;
  const token = step(job, 'uploads-token');
  assert.match(token.uses, TOKEN_ACTION);
  assert.equal(token.with['permission-contents'], 'write');
  assert.match(fs.readFileSync(path.join(DIR, 'uploads-cleanup.yml'), 'utf8'), SHA_COMMENT);
  const holders = job.steps.filter((s) => s.env && 'UPLOADS_TOKEN' in s.env);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].run, 'node scripts/uploads_cleanup.mjs');
  assert.equal(
    holders[0].env.MODE,
    "${{ github.event_name == 'issues' && 'closed' || github.event_name == 'pull_request' && 'pr-closed' || 'sweep' }}"
  );
  // Issue text only ever reaches a step through env:.
  for (const s of job.steps) assert.ok(!/github\.event\.issue/.test(s.run ?? ''), s.name);
});

test('both workflows pin the app-token action to the same commit', () => {
  const pins = [entry.jobs.scaffold, cleanup.jobs.cleanup].map((j) => step(j, 'uploads-token').uses);
  assert.equal(pins[0], pins[1]);
});

test('cleanup: a closed draft pull request runs only for a labelled same-repo entry/ branch', () => {
  const job = cleanup.jobs.cleanup;
  const off = cleanup.jobs['turned-off'];
  const pr = ({ label = 'content:new-entry', head = 'org/catalog', ref = 'entry/water-41' } = {}) => ({
    github: {
      event_name: 'pull_request',
      repository: 'org/catalog',
      event: { pull_request: { labels: [{ name: label }], head: { ref, repo: { full_name: head } } } },
    },
    vars: { UPLOADS_REPO: 'o/r' },
  });
  assert.equal(runs(job, pr()), true);
  assert.equal(runs(job, pr({ label: 'bug' })), false);
  assert.equal(runs(job, pr({ head: 'stranger/catalog' })), false);
  assert.equal(runs(job, pr({ ref: 'feature/x' })), false);
  const unset = { ...pr(), vars: { UPLOADS_REPO: '' } };
  assert.equal(runs(job, unset), false);
  assert.equal(runs(off, unset), true);
  assert.equal(
    runs(off, { ...unset, github: { ...unset.github, event: pr({ head: 'x/y' }).github.event } }),
    false
  );
});

test('cleanup: the pull request branch reaches the script through env only', () => {
  const run = cleanup.jobs.cleanup.steps.find((s) => s.run === 'node scripts/uploads_cleanup.mjs');
  assert.equal(run.env.PR_BRANCH, '${{ github.event.pull_request.head.ref }}');
  assert.match(run.env.MODE, /pull_request' && 'pr-closed'/);
  for (const s of cleanup.jobs.cleanup.steps)
    assert.ok(!/github\.event\.pull_request/.test(s.run ?? ''), s.name);
  for (const s of cleanup.jobs.cleanup.steps)
    assert.ok(!/head\.(sha|ref)/.test(JSON.stringify(s.with ?? {})), s.name);
});
