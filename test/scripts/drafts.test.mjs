/**
 * Which open pull request is a submission's draft (scripts/lib/drafts.mjs):
 * one issue keeps one draft, so an edit that renames the proposed branch goes
 * to the draft already open, and nothing outside the automation's branch
 * shape is ever picked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { draftBranchPattern, draftsForIssue, findDraftBranch } from '../../scripts/lib/drafts.mjs';

const REPOSITORY = 'acme/catalog';
const LABEL = 'content:new-entry';

/** A pull request as the REST API lists it. */
function pull(number, ref, { issue = 41, label = LABEL, fork = false, state = 'open', body } = {}) {
  return {
    number,
    state,
    body: body ?? `Scaffolded from issue #${issue}.\n\nCloses #${issue}\n\n### The entry\n\nCloses #999`,
    labels: [{ name: label }],
    html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
    head: { ref, repo: { full_name: fork ? 'someone/catalog' : REPOSITORY } },
  };
}

test('draftBranchPattern accepts only the branch shape the scaffolder writes', () => {
  const entry = draftBranchPattern('entry/', 41, { numbered: true });
  assert.ok(entry.test('entry/water-routing-41'));
  assert.ok(entry.test('entry/x-41'));
  for (const name of [
    'entry/water-routing-141',
    'entry/water-routing-4',
    'entry/water-routing',
    'entry/Water-41',
    'entry/../main-41',
    'entry/a/b-41',
    'main',
    'event/water-41',
  ]) {
    assert.ok(!entry.test(name), name);
  }
  const event = draftBranchPattern('event/', 41);
  assert.ok(event.test('event/2026-kickoff'));
  assert.ok(!event.test('event/2026-kickoff/x'));
  assert.ok(!event.test('entry/2026-kickoff'));
});

test('draftsForIssue keeps open drafts of this issue from this repository, oldest first', () => {
  const pulls = [
    pull(70, 'entry/new-title-41'),
    pull(50, 'entry/old-title-41'),
    pull(51, 'entry/other-42', { issue: 42 }),
    pull(52, 'entry/forked-41', { fork: true }),
    pull(53, 'entry/closed-41', { state: 'closed' }),
    pull(54, 'entry/unlabelled-41', { label: 'documentation' }),
    pull(55, 'main', {}),
    pull(56, 'entry/no-link-41', { body: 'Refs #41' }),
  ];
  const options = { issue: 41, repository: REPOSITORY, label: LABEL, prefix: 'entry/', numbered: true };
  assert.deepEqual(
    draftsForIssue(pulls, options).map((p) => p.number),
    [50, 70]
  );
  assert.deepEqual(
    draftsForIssue(pulls, { ...options, exclude: 50 }).map((p) => p.number),
    [70]
  );
  // Without a prefix any branch counts (the decline check asks "is any other draft open?").
  assert.deepEqual(
    draftsForIssue(pulls, { issue: 41, repository: REPOSITORY, label: LABEL }).map((p) => p.number),
    [50, 55, 70]
  );
  assert.deepEqual(draftsForIssue(undefined, options), []);
});

/** github-script's slice of Octokit: an open pull request list. */
function fakeGitHub(pulls) {
  const listed = [];
  return {
    listed,
    rest: { pulls: { list: async (params) => (listed.push(params), { data: pulls }) } },
    paginate: async (method, params) => (await method(params)).data,
  };
}

const context = { repo: { owner: 'acme', repo: 'catalog' }, issue: { number: 41 } };

function recordingCore() {
  const lines = { info: [], warning: [] };
  return { lines, info: (m) => lines.info.push(m), warning: (m) => lines.warning.push(m) };
}

test('findDraftBranch keeps the open draft when an edited title proposes a new branch', async () => {
  const github = fakeGitHub([pull(50, 'entry/old-title-41')]);
  const core = recordingCore();
  const found = await findDraftBranch({
    github,
    context,
    core,
    proposed: 'entry/new-title-41',
    label: LABEL,
    prefix: 'entry/',
    numbered: true,
  });
  assert.deepEqual(found, { branch: 'entry/old-title-41', pull: 50 });
  assert.equal(github.listed[0].state, 'open');
  assert.match(core.lines.info[0], /already has a draft, #50 on entry\/old-title-41/);
});

test('findDraftBranch builds the proposed branch when the issue has no open draft', async () => {
  const github = fakeGitHub([
    pull(50, 'entry/old-title-41', { state: 'closed' }),
    pull(51, 'entry/x-42', { issue: 42 }),
  ]);
  const found = await findDraftBranch({
    github,
    context,
    proposed: 'entry/new-title-41',
    label: LABEL,
    prefix: 'entry/',
    numbered: true,
  });
  assert.deepEqual(found, { branch: 'entry/new-title-41', pull: null });
});

test('findDraftBranch picks the oldest of two drafts and says so', async () => {
  const github = fakeGitHub([pull(70, 'entry/new-title-41'), pull(50, 'entry/old-title-41')]);
  const core = recordingCore();
  const found = await findDraftBranch({
    github,
    context,
    core,
    proposed: 'entry/new-title-41',
    label: LABEL,
    prefix: 'entry/',
    numbered: true,
  });
  assert.equal(found.branch, 'entry/old-title-41');
  assert.match(core.lines.warning[0], /more than one open draft \(#50, #70\)/);
});
