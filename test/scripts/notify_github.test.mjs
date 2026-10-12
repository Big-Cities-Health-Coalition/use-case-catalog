/**
 * The GitHub side of the submitter notifications (scripts/lib/notify_github.mjs),
 * against an in-memory stand-in for github-script's Octokit: comments at most
 * once, one status label at a time, the draft mention, closing a declined
 * submission, the held-edit hand-over, the "now live" announcement, and the
 * missing-label workflow's script run as written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  addTriageLabel,
  announcePublished,
  handleStageEvent,
  holdEdit,
  notifyIssue,
  submitter,
} from '../../scripts/lib/notify_github.mjs';
import { ENTRY_LABEL, REVIEW_LABELS, STATUS, hasMarker, marker } from '../../scripts/lib/notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = 'acme';
const REPO = 'catalog';

// The settings files the module reads, kept out of this repository's own
// _data/ so the wording under test is the default.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-github-'));
fs.mkdirSync(path.join(WORKSPACE, '_data'));
fs.writeFileSync(path.join(WORKSPACE, '_data', 'site.yml'), 'name: Acme\nstatus:\n  enabled: true\n');
fs.writeFileSync(
  path.join(WORKSPACE, '_data', 'schema.yml'),
  'fields:\n  - key: title\n    label: Title\n    type: text\n  - key: summary\n    label: Summary\n    type: textarea\n'
);
const savedWorkspace = process.env.GITHUB_WORKSPACE;
process.env.GITHUB_WORKSPACE = WORKSPACE;
test.after(() => {
  if (savedWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
  else process.env.GITHUB_WORKSPACE = savedWorkspace;
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/**
 * An in-memory repository behind the slice of Octokit the module uses.
 * @param {{issues?: Record<number, object>, labels?: string[], pulls?: object[],
 *   files?: Record<number, object[]>, associated?: object[]}} [seed]
 */
function fakeGitHub(seed = {}) {
  const issues = structuredClone(seed.issues ?? {});
  for (const issue of Object.values(issues)) {
    issue.labels = (issue.labels ?? []).map((name) => ({ name }));
    issue.state ??= 'open';
    issue.comments ??= [];
  }
  const repoLabels = new Set(seed.labels ?? []);
  const calls = [];
  const find = (number) => {
    if (!issues[number]) throw httpError(404);
    return issues[number];
  };
  const rest = {
    issues: {
      get: async ({ issue_number }) => ({ data: find(issue_number) }),
      listComments: async ({ issue_number }) => ({ data: find(issue_number).comments }),
      createComment: async ({ issue_number, body }) => {
        calls.push(['comment', issue_number, body]);
        find(issue_number).comments.push({ user: { type: 'Bot' }, body });
        return { data: {} };
      },
      createLabel: async ({ name }) => {
        if (repoLabels.has(name)) throw httpError(422);
        calls.push(['createLabel', name]);
        repoLabels.add(name);
        return { data: {} };
      },
      addLabels: async ({ issue_number, labels }) => {
        calls.push(['addLabels', issue_number, labels]);
        const issue = find(issue_number);
        for (const name of labels)
          if (!issue.labels.some((l) => l.name === name)) issue.labels.push({ name });
        return { data: {} };
      },
      removeLabel: async ({ issue_number, name }) => {
        const issue = find(issue_number);
        if (!issue.labels.some((l) => l.name === name)) throw httpError(404);
        calls.push(['removeLabel', issue_number, name]);
        issue.labels = issue.labels.filter((l) => l.name !== name);
        return { data: {} };
      },
      update: async ({ issue_number, state, state_reason }) => {
        calls.push(['update', issue_number, state, state_reason]);
        Object.assign(find(issue_number), { state, state_reason });
        return { data: {} };
      },
    },
    pulls: {
      // `head` is a branch name in the older seeds and a REST-shaped object in
      // the draft seeds; without `head`, every pull request in `state`.
      list: async ({ head, state }) => ({
        data: (seed.pulls ?? []).filter((pull) =>
          head
            ? `${OWNER}:${typeof pull.head === 'string' ? pull.head : pull.head?.ref}` === head
            : !state || (pull.state ?? 'open') === state
        ),
      }),
      get: async ({ pull_number }) => {
        const found = (seed.pulls ?? []).find((pull) => pull.number === pull_number);
        if (!found) throw httpError(404);
        calls.push(['getPull', pull_number]);
        return { data: found };
      },
      listFiles: async ({ pull_number }) => ({ data: seed.files?.[pull_number] ?? [] }),
    },
    repos: {
      listPullRequestsAssociatedWithCommit: async () => ({ data: seed.associated ?? [] }),
      getCollaboratorPermissionLevel: async ({ username }) => {
        if (!Object.hasOwn(seed.roles ?? {}, username)) throw httpError(403);
        return { data: { role_name: seed.roles[username] } };
      },
    },
  };
  return {
    rest,
    paginate: async (method, params) => (await method(params)).data,
    calls,
    issues,
    labelsOf: (number) => issues[number].labels.map((l) => l.name),
    commentsOn: (number) =>
      calls.filter((call) => call[0] === 'comment' && call[1] === number).map((call) => call[2]),
  };
}

const context = (overrides = {}) => ({
  repo: { owner: OWNER, repo: REPO },
  issue: { number: 41 },
  runId: 1000,
  serverUrl: 'https://github.com',
  payload: {},
  ...overrides,
});
const logs = () => {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(['info', m]),
    warning: (m) => lines.push(['warning', m]),
    notice() {},
  };
};

test('a message is posted with its marker, and only once per run', async () => {
  const github = fakeGitHub({ issues: { 41: {} } });
  const first = await notifyIssue({ github, context: context(), kind: 'triage_ack' });
  const again = await notifyIssue({ github, context: context(), kind: 'triage_ack' });
  assert.deepEqual([first.posted, again.posted], [true, false]);
  const [body] = github.commentsOn(41);
  assert.ok(hasMarker(body, 'triage_ack:1000'));
  assert.match(body, /\*\*#41\*\*/);
  assert.match(body, /https:\/\/acme\.github\.io\/catalog\/status\/\?n=41/);

  // A later run posts its own copy of a per-run message...
  await notifyIssue({ github, context: context({ runId: 1001 }), kind: 'triage_ack' });
  assert.equal(github.commentsOn(41).length, 2);
});

test('a once-only message is posted once ever, and a marker typed by a person does not count', async () => {
  const github = fakeGitHub({ issues: { 41: {} } });
  github.issues[41].comments.push({ user: { type: 'User' }, body: marker('paused') });
  await notifyIssue({ github, context: context(), kind: 'paused', once: true });
  await notifyIssue({ github, context: context({ runId: 2 }), kind: 'paused', once: true });
  assert.equal(github.commentsOn(41).length, 1);
});

test('the status moves to exactly one label, creating it when the repository lacks it', async () => {
  const github = fakeGitHub({
    issues: { 41: { labels: ['content:new-entry', STATUS.received] } },
    labels: [STATUS.received],
  });
  const result = await notifyIssue({ github, context: context(), status: STATUS.inReview });
  assert.deepEqual(result, { posted: false, changed: true });
  assert.deepEqual(github.labelsOf(41), ['content:new-entry', STATUS.inReview]);
  assert.ok(github.calls.some((call) => call[0] === 'createLabel' && call[1] === STATUS.inReview));
  assert.equal(github.commentsOn(41).length, 0, 'no kind, no comment');
});

test('a label that cannot be set is a warning, and the reply still goes out', async () => {
  const github = fakeGitHub({ issues: { 41: {} } });
  github.rest.issues.addLabels = async () => {
    throw httpError(403);
  };
  const core = logs();
  const result = await notifyIssue({
    github,
    context: context(),
    core,
    kind: 'triage_ack',
    status: STATUS.received,
  });
  assert.equal(result.posted, true);
  assert.ok(
    core.lines.some(
      ([level, m]) => level === 'warning' && /Could not set status:received on #41 \(403\)/.test(m)
    )
  );
});

test('onlyOnStatusChange: a second request for the same changes sends no second email', async () => {
  const github = fakeGitHub({ issues: { 41: { labels: [STATUS.inReview] } } });
  const options = {
    kind: 'changes_requested',
    status: STATUS.changesRequested,
    onlyOnStatusChange: true,
    vars: { notes_url: 'https://n' },
  };
  const first = await notifyIssue({ github, context: context(), ...options });
  const second = await notifyIssue({ github, context: context({ runId: 2 }), ...options });
  assert.deepEqual([first.posted, second.posted], [true, false]);
  assert.match(github.commentsOn(41)[0], /\*\*Where to find their notes:\*\* https:\/\/n/);
});

test('close shuts an open issue as not planned, and leaves a closed one alone', async () => {
  const github = fakeGitHub({ issues: { 41: {}, 42: { state: 'closed' } } });
  await notifyIssue({
    github,
    context: context(),
    kind: 'declined',
    close: true,
    vars: { pr_url: 'https://github.com/acme/catalog/pull/50' },
  });
  await notifyIssue({ github, context: context(), issueNumber: 42, status: STATUS.declined, close: true });
  assert.deepEqual(
    github.calls.filter((call) => call[0] === 'update'),
    [['update', 41, 'closed', 'not_planned']]
  );
  assert.match(github.commentsOn(41)[0], /\*\*If you disagree:\*\*/);
});

test('the submitter is mentioned on the draft once, never on a rebuild', async () => {
  const github = fakeGitHub({ issues: { 41: {}, 50: {} } });
  const prUrl = 'https://github.com/acme/catalog/pull/50';
  await notifyIssue({
    github,
    context: context(),
    kind: 'draft_ready',
    status: STATUS.inReview,
    prUrl,
    mention: 'jane-doe',
  });
  await notifyIssue({
    github,
    context: context({ runId: 2 }),
    kind: 'draft_updated',
    status: STATUS.inReview,
    prUrl,
    mention: 'jane-doe',
  });
  const onDraft = github.commentsOn(50);
  assert.equal(onDraft.length, 1);
  assert.match(onDraft[0], /^@jane-doe this is the draft of your submission \*\*#41\*\*/);
  assert.equal(github.commentsOn(41).length, 2);

  // No mention for a login that is not one.
  const other = fakeGitHub({ issues: { 41: {}, 50: {} } });
  await notifyIssue({
    github: other,
    context: context(),
    kind: 'draft_ready',
    prUrl,
    mention: 'not a login',
  });
  assert.equal(other.commentsOn(50).length, 0);
});

test('submitter() is the issue author, unless a bot opened it', () => {
  assert.equal(submitter({ payload: { issue: { user: { login: 'jane', type: 'User' } } } }), 'jane');
  assert.equal(submitter({ payload: { issue: { user: { login: 'app[bot]', type: 'Bot' } } } }), '');
  assert.equal(submitter({}), '');
});

test('addTriageLabel creates needs-triage when missing and adds it', async () => {
  const github = fakeGitHub({ issues: { 41: {} } });
  await addTriageLabel({ github, context: context() });
  assert.deepEqual(github.labelsOf(41), ['needs-triage']);
});

/** A draft pull request event for submission-status.yml. */
function stageContext({ eventName = 'pull_request', action, label, merged = false, state = 'open', review }) {
  return context({
    eventName,
    payload: {
      action,
      label: label ? { name: label } : undefined,
      review,
      sender: { type: 'User' },
      repository: { full_name: `${OWNER}/${REPO}` },
      pull_request: {
        body: 'Draft of the submission.\n\nCloses #41',
        html_url: 'https://github.com/acme/catalog/pull/50',
        merged,
        state,
        labels: [{ name: ENTRY_LABEL }],
        head: { repo: { full_name: `${OWNER}/${REPO}` } },
      },
    },
  });
}

test('handleStageEvent: changes requested, then back in review, then declined and closed', async () => {
  const github = fakeGitHub({ issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } } });
  await handleStageEvent({
    github,
    context: stageContext({ action: 'labeled', label: REVIEW_LABELS.revisions }),
  });
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.changesRequested]);
  assert.match(github.commentsOn(41)[0], /Your reviewer has a few requests before \*\*#41\*\*/);

  // The review that asked for the same changes arrives with the label: one email.
  await handleStageEvent({
    github,
    context: stageContext({
      eventName: 'pull_request_review',
      action: 'submitted',
      review: { state: 'changes_requested', html_url: 'https://r', author_association: 'MEMBER' },
    }),
  });
  assert.equal(github.commentsOn(41).length, 1);

  await handleStageEvent({
    github,
    context: stageContext({ action: 'unlabeled', label: REVIEW_LABELS.revisions }),
  });
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.inReview]);
  assert.equal(github.commentsOn(41).length, 1, 'moving back to review is silent');

  await handleStageEvent({ github, context: stageContext({ action: 'closed', state: 'closed' }) });
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.declined]);
  assert.equal(github.issues[41].state, 'closed');
  assert.equal(github.issues[41].state_reason, 'not_planned');
  assert.match(github.commentsOn(41)[1], /we are not able to publish it/);
});

test('handleStageEvent: a merge marks the issue published, silently; nothing pulls it back', async () => {
  const github = fakeGitHub({ issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } } });
  await handleStageEvent({
    github,
    context: stageContext({ action: 'closed', state: 'closed', merged: true }),
  });
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.published]);
  assert.equal(github.commentsOn(41).length, 0, 'pages.yml says "now live" once it deploys');

  const decision = await handleStageEvent({
    github,
    context: stageContext({ action: 'labeled', label: REVIEW_LABELS.committee }),
  });
  assert.match(decision.skip, /already status:published/);
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.published]);
});

test('handleStageEvent never closes or relabels an issue that is not a submission', async () => {
  const github = fakeGitHub({ issues: { 41: { labels: ['bug'] } } });
  const decision = await handleStageEvent({
    github,
    context: stageContext({ action: 'labeled', label: REVIEW_LABELS.declined }),
  });
  assert.match(decision.skip, /not a submission issue/);
  assert.deepEqual(github.calls, []);

  const pr = fakeGitHub({ issues: { 41: { labels: [ENTRY_LABEL], pull_request: {} } } });
  assert.match(
    (await handleStageEvent({ github: pr, context: stageContext({ action: 'closed', state: 'closed' }) }))
      .skip,
    /not a submission/
  );
});

test('holdEdit tells the reviewer what changed and the submitter that the edit arrived', async () => {
  const github = fakeGitHub({
    issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] }, 50: {} },
    pulls: [{ number: 50, head: 'entry/water-routing', html_url: 'https://github.com/acme/catalog/pull/50' }],
  });
  const ctx = context({
    payload: {
      issue: {
        number: 41,
        title: '[Entry] Water routing v2',
        body: '### Title\n\nWater routing v2\n\n### Summary\n\nNew summary',
      },
      changes: {
        body: { from: '### Title\n\nWater routing\n\n### Summary\n\nOld summary' },
        title: { from: '[Entry] Water routing' },
      },
    },
  });
  const result = await holdEdit({
    github,
    context: ctx,
    branch: 'entry/water-routing',
    schema: true,
    root: WORKSPACE,
  });
  assert.deepEqual(result, { changes: 3, pr: 50 });
  const [summary] = github.commentsOn(50);
  assert.match(summary, /did not rebuild the branch/);
  assert.match(summary, /Summary/);
  assert.match(summary, /Old summary/);
  assert.match(summary, /New summary/);
  assert.match(summary, /Issue title/);
  assert.match(github.commentsOn(41)[0], /Your reviewer had already made edits to the draft/);
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.inReview]);
});

test('holdEdit says nothing when the edit changed no answer', async () => {
  const github = fakeGitHub({ issues: { 41: {} } });
  const body = '### Title\n\nSame';
  const ctx = context({
    payload: { issue: { number: 41, title: 'T', body }, changes: { body: { from: body } } },
  });
  assert.deepEqual(await holdEdit({ github, context: ctx, branch: 'b', root: WORKSPACE }), {
    changes: 0,
    pr: null,
  });
  assert.deepEqual(github.calls, []);
});

test('announcePublished: the entry page, once, and only for submissions', async () => {
  const merged = (number, body) => ({ number, body, merged_at: '2026-10-01T00:00:00Z' });
  const github = fakeGitHub({
    issues: {
      41: { labels: [ENTRY_LABEL, STATUS.inReview] },
      42: { labels: ['bug'] },
      43: { labels: [STATUS.inReview] },
    },
    associated: [
      merged(50, 'Closes #41'),
      merged(51, 'Fixes #42'),
      merged(52, 'Closes #43'),
      { number: 53, body: 'Closes #41', merged_at: null },
    ],
    files: {
      50: [{ filename: 'catalog/water-routing/index.md', status: 'added' }],
      51: [{ filename: 'docs/readme.md', status: 'modified' }],
      52: [{ filename: '_data/events.yml', status: 'modified' }],
    },
  });
  const ctx = context({ sha: 'abc' });
  const told = await announcePublished({
    github,
    context: ctx,
    pageUrl: 'https://acme.github.io/catalog/',
    entryPath: 'catalog',
  });
  assert.deepEqual(told, [41, 43]);
  assert.equal(github.commentsOn(41).length, 1);
  assert.match(
    github.commentsOn(41)[0],
    /^Your entry is now live at https:\/\/acme\.github\.io\/catalog\/catalog\/water-routing\//
  );
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.published]);
  assert.deepEqual(
    github.labelsOf(42),
    ['bug'],
    'a maintainer pull request closing a bug is not a submission'
  );
  assert.deepEqual(github.labelsOf(43), [STATUS.published]);
  assert.equal(github.commentsOn(43).length, 0, 'no page, no "now live" comment');

  await announcePublished({
    github,
    context: ctx,
    pageUrl: 'https://acme.github.io/catalog',
    entryPath: 'catalog',
  });
  assert.equal(github.commentsOn(41).length, 1, 'a re-run deploy does not announce twice');
});

/**
 * Run missing-label.yml's github-script step as written, with its `env:`.
 * @param {{title: string, body?: string, association?: string}} issue
 */
async function runMissingLabel({ title, body = '', association = 'NONE' }) {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(ROOT, '.github/workflows/missing-label.yml'), 'utf8')
  );
  const step = workflow.jobs.explain.steps.find((s) => /github-script/.test(s.uses ?? ''));
  const github = fakeGitHub({ issues: { 41: {} } });
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: ROOT,
    ISSUE_TITLE: title,
    ISSUE_BODY: body,
    AUTHOR_ASSOCIATION: association,
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('github', 'context', 'core', 'require', 'process', step.with.script);
  // The real module reads site.yml from GITHUB_WORKSPACE at call time.
  const saved = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = WORKSPACE;
  try {
    await run(github, context(), logs(), createRequire(import.meta.url), { env });
  } finally {
    process.env.GITHUB_WORKSPACE = saved;
  }
  return github;
}

test("missing-label: an outsider's form submission without its label gets the rescue message, received and needs-triage", async () => {
  const github = await runMissingLabel({
    title: '[Use case] Water routing',
    body: '### Title\n\nWater routing',
  });
  const [comment] = github.commentsOn(41);
  assert.match(comment, /It looks like a \*\*New entry\*\* submission/);
  assert.match(comment, /add the `content:new-entry` label/);
  assert.match(comment, /\*\*#41\*\*/);
  assert.deepEqual(github.labelsOf(41).sort(), ['needs-triage', STATUS.received]);
});

test("missing-label: a maintainer's form submission gets the message but no status or triage label", async () => {
  const github = await runMissingLabel({ title: 'Event: Kickoff', association: 'OWNER' });
  assert.match(github.commentsOn(41)[0], /\*\*Add event details\*\*/);
  assert.deepEqual(github.labelsOf(41), []);
});

test('missing-label: an edit request whose label was dropped gets the rescue message; a plain "Edit:" issue does not', async () => {
  const github = await runMissingLabel({
    title: 'Edit: Water routing',
    body: '### Entry slug\n\nwater-routing\n\n### What should change?\n\nThe stage.',
  });
  const [comment] = github.commentsOn(41);
  assert.match(comment, /It looks like a \*\*Suggest an edit\*\* submission/);
  assert.match(comment, /add the `content:edit-request` label/);
  assert.deepEqual(github.labelsOf(41).sort(), ['needs-triage', STATUS.received]);

  const hand = await runMissingLabel({ title: 'Edit: the home page has a typo', body: 'Plain text' });
  assert.match(hand.commentsOn(41)[0], /Thank you for getting in touch!/, 'no form body, no form');
});

test('missing-label: any other outsider issue is acknowledged with no status or status link', async () => {
  const question = await runMissingLabel({ title: 'How do I submit?' });
  assert.match(question.commentsOn(41)[0], /Thank you for getting in touch!/);
  assert.doesNotMatch(
    question.commentsOn(41)[0],
    /status\/\?n=/,
    'the status page only knows content:* issues, so no link'
  );
  assert.deepEqual(question.labelsOf(41), ['needs-triage']);

  const bug = await runMissingLabel({ title: '[Bug] Search is broken' });
  assert.doesNotMatch(bug.commentsOn(41)[0], /status\/\?n=/);
  assert.deepEqual(bug.labelsOf(41), ['needs-triage']);

  const hand = await runMissingLabel({ title: '[RFC] Rename the site', body: 'Plain text' });
  assert.match(
    hand.commentsOn(41)[0],
    /Thank you for getting in touch!/,
    'a bracketed title without a form body is not a form'
  );
});

test('missing-label: a site-problem report is acknowledged and left for triage, never taken for a submission', async () => {
  const form = YAML.parse(
    fs.readFileSync(path.join(ROOT, '.github/ISSUE_TEMPLATE/site-problem.yml'), 'utf8')
  );
  // The issue as GitHub renders the form: its title prefix, one heading per question.
  const title = `${form.title}the search box does nothing`;
  const body = form.body
    .filter((element) => element.type !== 'markdown')
    .map((element) => `### ${element.attributes.label}\n\n_No response_`)
    .join('\n\n');

  const outsider = await runMissingLabel({ title, body });
  const [comment] = outsider.commentsOn(41);
  assert.match(comment, /Thank you for getting in touch!/);
  assert.doesNotMatch(comment, /It looks like a/, 'no form claims it, so no "label missing" message');
  assert.doesNotMatch(comment, /status\/\?n=/);
  assert.deepEqual(outsider.labelsOf(41), ['needs-triage']);

  const maintainer = await runMissingLabel({ title, body, association: 'COLLABORATOR' });
  assert.deepEqual(maintainer.calls, []);
});

test("missing-label: a maintainer's own issue gets no comment at all", async () => {
  const github = await runMissingLabel({ title: 'Plan the next release', association: 'MEMBER' });
  assert.deepEqual(github.calls, []);
});

/** A draft as the REST API returns it, for the tests that read the pull request again. */
function draftPull(
  number,
  { ref = `entry/water-routing-41`, labels = [ENTRY_LABEL], state = 'open', merged = false } = {}
) {
  return {
    number,
    state,
    merged,
    body: 'Scaffolded from issue #41.\n\nCloses #41',
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    labels: labels.map((name) => ({ name })),
    head: { ref, repo: { full_name: `${OWNER}/${REPO}` } },
  };
}

/** stageContext for pull request #50, sent by `login`. */
function stageContextFor(options, { number = 50, login = 'maintainer', labels } = {}) {
  const built = stageContext(options);
  built.payload.pull_request.number = number;
  built.payload.sender.login = login;
  if (labels) built.payload.pull_request.labels = labels.map((name) => ({ name }));
  return built;
}

test('handleStageEvent: a review from outside the project changes nothing and emails nobody', async () => {
  const github = fakeGitHub({ issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } } });
  const decision = await handleStageEvent({
    github,
    context: stageContext({
      eventName: 'pull_request_review',
      action: 'submitted',
      review: { state: 'changes_requested', html_url: 'https://evil.example', author_association: 'NONE' },
    }),
  });
  assert.match(decision.skip, /not a maintainer/);
  assert.deepEqual(github.calls, []);
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.inReview]);
});

test('handleStageEvent: a read-only sender moves nothing; an unreadable role is left to GitHub', async () => {
  const seed = { issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } }, roles: { stranger: 'read' } };
  const github = fakeGitHub(seed);
  const decision = await handleStageEvent({
    github,
    context: stageContextFor({ action: 'labeled', label: REVIEW_LABELS.declined }, { login: 'stranger' }),
  });
  assert.match(decision.skip, /stranger cannot label or close/);
  assert.equal(github.issues[41].state, 'open');
  assert.equal(github.commentsOn(41).length, 0);

  // The permission API refused (403): GitHub already required triage to add
  // the label, so the update goes ahead, with a warning in the log.
  const trusted = fakeGitHub(seed);
  const core = logs();
  await handleStageEvent({
    github: trusted,
    core,
    context: stageContextFor({ action: 'labeled', label: REVIEW_LABELS.declined }, { login: 'triager' }),
  });
  assert.deepEqual(trusted.labelsOf(41), [ENTRY_LABEL, STATUS.declined]);
  assert.ok(core.lines.some(([level, m]) => level === 'warning' && /Could not read triager's role/.test(m)));
});

test('handleStageEvent: closing a duplicate draft while another is open is not a decline', async () => {
  const seed = {
    issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } },
    roles: { maintainer: 'write' },
    pulls: [
      draftPull(50, { ref: 'entry/old-title-41', state: 'closed' }),
      draftPull(61, { ref: 'entry/new-title-41' }),
    ],
  };
  const github = fakeGitHub(seed);
  const decision = await handleStageEvent({
    github,
    context: stageContextFor({ action: 'closed', state: 'closed' }),
  });
  assert.match(decision.skip, /still has an open draft, #61/);
  assert.equal(github.issues[41].state, 'open');
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.inReview]);
  assert.equal(github.commentsOn(41).length, 0);

  // review:declined on the closed draft is a decision, whatever else is open.
  const declined = fakeGitHub({
    ...seed,
    pulls: [
      draftPull(50, {
        ref: 'entry/old-title-41',
        state: 'closed',
        labels: [ENTRY_LABEL, REVIEW_LABELS.declined],
      }),
      draftPull(61, { ref: 'entry/new-title-41' }),
    ],
  });
  await handleStageEvent({
    github: declined,
    context: stageContextFor({ action: 'closed', state: 'closed' }),
  });
  assert.deepEqual(declined.labelsOf(41), [ENTRY_LABEL, STATUS.declined]);
  assert.equal(declined.issues[41].state, 'closed');

  // The last open draft closed without a merge is still a decline.
  const last = fakeGitHub({ ...seed, pulls: [draftPull(50, { state: 'closed' })] });
  await handleStageEvent({ github: last, context: stageContextFor({ action: 'closed', state: 'closed' }) });
  assert.deepEqual(last.labelsOf(41), [ENTRY_LABEL, STATUS.declined]);
  assert.match(last.commentsOn(41)[0], /we are not able to publish it/);
});

test('handleStageEvent: a draft from any intake form closed unmerged declines its issue, unless another carries on', async () => {
  const label = 'content:new-event';
  const seed = {
    issues: { 41: { labels: [label, STATUS.inReview] } },
    roles: { maintainer: 'write' },
    pulls: [draftPull(50, { ref: 'event/2026-kickoff', labels: [label], state: 'closed' })],
  };
  const github = fakeGitHub(seed);
  const decision = await handleStageEvent({
    github,
    context: stageContextFor({ action: 'closed', state: 'closed' }, { labels: [label] }),
  });
  assert.equal(decision.status, STATUS.declined);
  assert.deepEqual(github.labelsOf(41), [label, STATUS.declined]);
  assert.equal(github.issues[41].state, 'closed');
  assert.equal(github.issues[41].state_reason, 'not_planned');
  assert.equal(github.commentsOn(41).length, 1);
  assert.match(github.commentsOn(41)[0], /we are not able to publish it/);

  // A re-run does not post the decline twice.
  await handleStageEvent({
    github,
    context: stageContextFor({ action: 'closed', state: 'closed' }, { labels: [label] }),
  });
  assert.equal(github.commentsOn(41).length, 1);

  // A schedule edit opens a new timestamped draft; closing the old one while
  // the new one is open is housekeeping. Only drafts of the same form count.
  const schedule = 'content:schedule';
  const superseded = fakeGitHub({
    issues: { 41: { labels: [schedule, STATUS.inReview] } },
    roles: { maintainer: 'write' },
    pulls: [
      draftPull(50, { ref: 'schedule/2026-20261001000000', labels: [schedule], state: 'closed' }),
      draftPull(60, { ref: 'entry/water-routing-41', labels: [ENTRY_LABEL] }),
      draftPull(61, { ref: 'schedule/2026-20261002000000', labels: [schedule] }),
    ],
  });
  const skipped = await handleStageEvent({
    github: superseded,
    context: stageContextFor({ action: 'closed', state: 'closed' }, { labels: [schedule] }),
  });
  assert.match(skipped.skip, /still has an open draft, #61/);
  assert.deepEqual(superseded.labelsOf(41), [schedule, STATUS.inReview]);
  assert.equal(superseded.commentsOn(41).length, 0);

  // A merge is published, silently (pages.yml's announce job covers the rest).
  const merged = fakeGitHub({
    ...seed,
    pulls: [draftPull(50, { ref: 'event/2026-kickoff', labels: [label], state: 'closed', merged: true })],
  });
  await handleStageEvent({
    github: merged,
    context: stageContextFor({ action: 'closed', state: 'closed', merged: true }, { labels: [label] }),
  });
  assert.deepEqual(merged.labelsOf(41), [label, STATUS.published]);
  assert.equal(merged.commentsOn(41).length, 0);
});

test('handleStageEvent: an intake draft only decides an issue of its own form', async () => {
  const label = 'content:site-config';
  const closedDraft = [draftPull(50, { ref: 'setup/apply-41', labels: [label], state: 'closed' })];
  const close = () => stageContextFor({ action: 'closed', state: 'closed' }, { labels: [label] });
  for (const issueLabels of [
    ['bug'],
    // Another form's submission: the draft's "Closes #N" points at the wrong issue.
    [ENTRY_LABEL, STATUS.inReview],
    ['content:new-event', STATUS.inReview],
  ]) {
    const github = fakeGitHub({
      issues: { 41: { labels: issueLabels } },
      roles: { maintainer: 'write' },
      pulls: closedDraft,
    });
    const decision = await handleStageEvent({ github, context: close() });
    assert.match(decision.skip ?? '', /not a .*submission/, JSON.stringify(issueLabels));
    assert.deepEqual(github.labelsOf(41), issueLabels);
    assert.equal(github.issues[41].state, 'open');
    assert.equal(github.commentsOn(41).length, 0);
  }

  // A status label alone (the form label was removed by hand) still counts.
  const relabelled = fakeGitHub({
    issues: { 41: { labels: [STATUS.inReview] } },
    roles: { maintainer: 'write' },
    pulls: closedDraft,
  });
  await handleStageEvent({ github: relabelled, context: close() });
  assert.deepEqual(relabelled.labelsOf(41), [STATUS.declined]);

  // Review labels on a non-entry draft change nothing.
  const reviewed = fakeGitHub({
    issues: { 41: { labels: [label, STATUS.inReview] } },
    roles: { maintainer: 'write' },
    pulls: [draftPull(50, { ref: 'setup/apply-41', labels: [label, REVIEW_LABELS.declined] })],
  });
  const ignored = await handleStageEvent({
    github: reviewed,
    context: stageContextFor(
      { action: 'labeled', label: REVIEW_LABELS.declined },
      { labels: [label, REVIEW_LABELS.declined] }
    ),
  });
  assert.match(ignored.skip, /only closing/);
  assert.deepEqual(reviewed.labelsOf(41), [label, STATUS.inReview]);
  assert.equal(reviewed.commentsOn(41).length, 0);
});

test('handleStageEvent: a run that waited reads the labels as they are now, one comment per transition', async () => {
  // Committee and revisions labels went on together; this is the committee
  // label's run, and the revisions run never got its own.
  const seed = {
    issues: { 41: { labels: [ENTRY_LABEL, STATUS.inReview] } },
    roles: { maintainer: 'triage' },
    pulls: [draftPull(50, { labels: [ENTRY_LABEL, REVIEW_LABELS.committee, REVIEW_LABELS.revisions] })],
  };
  const github = fakeGitHub(seed);
  await handleStageEvent({
    github,
    context: stageContextFor({ action: 'labeled', label: REVIEW_LABELS.committee }),
  });
  assert.ok(
    github.calls.some((call) => call[0] === 'getPull' && call[1] === 50),
    'the pull request is read again'
  );
  assert.deepEqual(github.labelsOf(41), [ENTRY_LABEL, STATUS.changesRequested]);
  const comments = github.commentsOn(41);
  assert.equal(comments.length, 2);
  assert.match(comments[0], /Your reviewer has a few requests/);
  assert.match(comments[1], /now with the review committee/);

  // The revisions label comes off once the changes land: back in review,
  // silently, and the committee note is not repeated.
  const pulls = [draftPull(50, { labels: [ENTRY_LABEL, REVIEW_LABELS.committee] })];
  const later = fakeGitHub({ ...seed, pulls });
  later.issues[41] = github.issues[41];
  await handleStageEvent({
    github: later,
    context: stageContextFor({ action: 'unlabeled', label: REVIEW_LABELS.revisions }),
  });
  assert.deepEqual(later.labelsOf(41), [ENTRY_LABEL, STATUS.inReview]);
  assert.equal(
    later.commentsOn(41).length,
    0,
    'no second committee note, no comment for going back to review'
  );
});
