/**
 * Edit requests: the "Suggest an edit" issue form
 * (.github/ISSUE_TEMPLATE/edit-entry.yml), the acknowledgement its workflow
 * posts (.github/workflows/edit-request.yml, run as written against an
 * in-memory Octokit), and the slug check behind it (scripts/lib/edit_request.mjs).
 * Nothing in this flow edits an entry: a maintainer does that on a pull request
 * (docs/edit-requests.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { issueFormProblems } from '../../assets/js/configurator/issue-form-limits.js';
import {
  FIELD,
  acknowledgeEditRequest,
  entryExists,
  readEditRequestSlug,
} from '../../scripts/lib/edit_request.mjs';
import {
  EDIT_REQUEST_LABEL,
  INTAKE_LABELS,
  STATUS,
  hasMarker,
  render,
  resolveSettings,
} from '../../scripts/lib/notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORM_FILE = path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'edit-entry.yml');
const WORKFLOW_FILE = path.join(ROOT, '.github', 'workflows', 'edit-request.yml');

// A workspace of its own: a schema whose entries live under `projects/`, not
// the default `catalog/`, so the slug check has to read `entry.path`.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-request-'));
fs.mkdirSync(path.join(WORKSPACE, '_data'));
fs.writeFileSync(
  path.join(WORKSPACE, '_data', 'schema.yml'),
  'entry:\n  path: projects\nfields:\n  - key: title\n    label: Title\n    type: text\n'
);
fs.mkdirSync(path.join(WORKSPACE, 'projects', 'water-routing'), { recursive: true });
fs.writeFileSync(
  path.join(WORKSPACE, 'projects', 'water-routing', 'index.md'),
  '---\ntitle: Water routing\n---\n'
);
const writeSite = (text) => fs.writeFileSync(path.join(WORKSPACE, '_data', 'site.yml'), text);
writeSite('name: Acme\n');
test.after(() => fs.rmSync(WORKSPACE, { recursive: true, force: true }));

const form = () => YAML.parse(fs.readFileSync(FORM_FILE, 'utf8'));
const inputs = () => form().body.filter((element) => element.type !== 'markdown');

/** The issue body GitHub renders from the form. */
const issueBody = ({ slug = 'water-routing', relationship = 'I submitted this entry' } = {}) =>
  [
    `### ${FIELD.slug}\n\n${slug}`,
    `### ${FIELD.relationship}\n\n${relationship}`,
    `### ${FIELD.change}\n\nThe stage is now "In production".`,
    `### ${FIELD.contactName}\n\n_No response_`,
    `### ${FIELD.contactEmail}\n\n_No response_`,
  ].join('\n\n');

test('the edit form is labelled content:edit-request, titled "Edit:", and asks the four questions', () => {
  const parsed = form();
  assert.deepEqual(parsed.labels, [EDIT_REQUEST_LABEL]);
  assert.equal(EDIT_REQUEST_LABEL, 'content:edit-request');
  assert.match(parsed.title, /^Edit: /);
  assert.deepEqual(
    inputs().map((element) => [element.type, element.id, element.validations?.required === true]),
    [
      ['input', 'slug', true],
      ['dropdown', 'relationship', true],
      ['textarea', 'change', true],
      ['input', 'contact_name', false],
      ['input', 'contact_email', false],
    ]
  );
  assert.deepEqual(inputs()[1].attributes.options, [
    'I submitted this entry',
    'I work on this project or at the organization behind it',
    'Someone else (a reader or partner)',
  ]);
});

test("the edit form is within GitHub's limits, and its labels are the ones the workflow reads", () => {
  assert.deepEqual(issueFormProblems(form()), []);
  const reserved = ['title', 'body', 'labels', 'assignees', 'milestone', 'projects', 'template'];
  for (const element of inputs()) {
    assert.ok(!reserved.includes(element.id), `${element.id} is a query parameter GitHub keeps for itself`);
  }
  assert.deepEqual(
    inputs().map((element) => element.attributes.label),
    Object.values(FIELD),
    'scripts/lib/edit_request.mjs reads the answers by these labels'
  );
  const text = fs.readFileSync(FORM_FILE, 'utf8');
  assert.doesNotMatch(text, /—/, 'no em dashes in copy written for non-coders');
  assert.match(text, /public/i, 'the form says the issue is public before asking for an email address');
});

test('readEditRequestSlug reads the slug box, a pasted page address, or nothing', () => {
  assert.equal(readEditRequestSlug(issueBody()), 'water-routing');
  assert.equal(readEditRequestSlug(issueBody({ slug: '  Water-Routing  ' })), 'water-routing');
  assert.equal(
    readEditRequestSlug(
      issueBody({ slug: 'https://acme.github.io/catalog/projects/water-routing/#contact' })
    ),
    'water-routing'
  );
  assert.equal(readEditRequestSlug(issueBody({ slug: '`water-routing`' })), 'water-routing');
  assert.equal(readEditRequestSlug(issueBody({ slug: '_No response_' })), '');
  assert.equal(readEditRequestSlug(''), '');
  // A heading typed into a later answer cannot replace the slug GitHub collected.
  assert.equal(readEditRequestSlug(`${issueBody()}\n\n### ${FIELD.slug}\n\nsomething-else`), 'water-routing');
});

test('entryExists reads entry.path and refuses anything that is not a slug', () => {
  assert.equal(entryExists(WORKSPACE, 'water-routing'), true);
  assert.equal(entryExists(WORKSPACE, 'no-such-entry'), false);
  for (const hostile of ['', '..', '../_data', 'water-routing/../../etc', 'Water Routing', '.']) {
    assert.equal(entryExists(WORKSPACE, hostile), false, JSON.stringify(hostile));
  }
});

test('the acknowledgement gives the number, the status link and the review promise', () => {
  const settings = resolveSettings({ site: { name: 'Acme' }, repository: 'acme/catalog' });
  const body = render('edit_request', { number: 12 }, settings);
  assert.match(body, /Thank you for suggesting an edit/);
  assert.match(body, /\*\*#12\*\*/);
  assert.match(body, /A maintainer will review your request/);
  assert.match(body, /may contact you/);
  assert.match(body, /https:\/\/acme\.github\.io\/catalog\/status\/\?n=12/);
  assert.doesNotMatch(body, /\{/, 'no placeholder left unfilled');
  assert.doesNotMatch(body, /could not find/, 'the unknown-entry paragraph drops out when it is empty');
});

/** A minimal Octokit stand-in: issues, comments and labels in memory. */
function fakeGitHub(issue = {}) {
  const state = { labels: [...(issue.labels ?? [])], comments: [...(issue.comments ?? [])] };
  const calls = [];
  const rest = {
    issues: {
      get: async () => ({ data: { labels: state.labels.map((name) => ({ name })) } }),
      listComments: async () => ({ data: state.comments }),
      createComment: async ({ body }) => {
        calls.push(['comment', body]);
        state.comments.push({ user: { type: 'Bot' }, body });
        return { data: {} };
      },
      createLabel: async () => {
        throw Object.assign(new Error('exists'), { status: 422 });
      },
      addLabels: async ({ labels }) => {
        calls.push(['addLabels', labels]);
        for (const name of labels) if (!state.labels.includes(name)) state.labels.push(name);
        return { data: {} };
      },
      removeLabel: async ({ name }) => {
        calls.push(['removeLabel', name]);
        state.labels = state.labels.filter((label) => label !== name);
        return { data: {} };
      },
    },
  };
  return {
    rest,
    paginate: async (method, params) => (await method(params)).data,
    calls,
    state,
    comments: () => calls.filter((call) => call[0] === 'comment').map((call) => call[1]),
  };
}

/**
 * Run edit-request.yml's github-script step as written, with its `env:`.
 * `labels` is the event payload's copy; `liveLabels` (default: the same) is what
 * the API returns now, for a run that waited in the queue while the issue moved on.
 * @param {{body: string, labels?: string[], liveLabels?: string[], comments?: object[], action?: string}} issue
 */
async function runWorkflow({
  body,
  labels = [EDIT_REQUEST_LABEL],
  liveLabels = labels,
  comments = [],
  action = 'opened',
}) {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
  const [job] = Object.values(workflow.jobs);
  const step = job.steps.find((s) => /github-script/.test(s.uses ?? ''));
  assert.equal(step.env.ISSUE_BODY, '${{ github.event.issue.body }}');
  const github = fakeGitHub({ labels: liveLabels, comments });
  const context = {
    repo: { owner: 'acme', repo: 'catalog' },
    issue: { number: 41 },
    runId: 1000,
    serverUrl: 'https://github.com',
    payload: { action, issue: { number: 41, labels: labels.map((name) => ({ name })) } },
  };
  const core = { info() {}, warning() {}, notice() {}, setFailed: (m) => assert.fail(m) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('github', 'context', 'core', 'require', 'process', step.with.script);
  // The import path comes from the step's `process` (this repository); the
  // module reads the site, the schema and the entries from GITHUB_WORKSPACE.
  const saved = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = WORKSPACE;
  try {
    await run(github, context, core, createRequire(import.meta.url), {
      env: { ...process.env, GITHUB_WORKSPACE: ROOT, ISSUE_BODY: body },
    });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = saved;
  }
  return github;
}

test('edit-request.yml: a request for a known entry is acknowledged once and marked received', async () => {
  const github = await runWorkflow({ body: issueBody() });
  const [comment, ...more] = github.comments();
  assert.equal(more.length, 0);
  assert.match(comment, /Thank you for suggesting an edit/);
  assert.match(comment, /\*\*#41\*\*/);
  assert.match(comment, /A maintainer will review your request/);
  assert.doesNotMatch(comment, /could not find/);
  assert.ok(
    hasMarker(comment, 'edit_request'),
    'once-only marker, so an edit to the issue does not repeat it'
  );
  assert.deepEqual(github.state.labels.sort(), [EDIT_REQUEST_LABEL, STATUS.received].sort());
});

test('edit-request.yml: an unknown slug is named back politely with a request for the page address', async () => {
  const github = await runWorkflow({ body: issueBody({ slug: 'water-rooting' }) });
  const [comment] = github.comments();
  assert.match(comment, /We could not find `water-rooting` on the site/);
  assert.match(comment, /web address of the page/);
  assert.match(comment, /A maintainer will review your request/);
  assert.ok(github.state.labels.includes(STATUS.received));
});

test('edit-request.yml: a slug that is not a slug is never echoed into the comment', async () => {
  const github = await runWorkflow({ body: issueBody({ slug: '<img src=x onerror=alert(1)> `rm -rf`' }) });
  const [comment] = github.comments();
  assert.match(comment, /We could not find the entry you named on the site/);
  assert.doesNotMatch(comment, /img|rm -rf/);

  const long = await runWorkflow({ body: issueBody({ slug: 'a'.repeat(101) }) });
  assert.match(long.comments()[0], /the entry you named/, 'an overlong slug is described, not quoted');
});

test('edit-request.yml: an edit to the issue neither repeats the comment nor drags the status back', async () => {
  const first = await runWorkflow({ body: issueBody() });
  const again = await runWorkflow({
    body: issueBody(),
    action: 'edited',
    labels: [EDIT_REQUEST_LABEL, STATUS.published],
    comments: first.state.comments,
  });
  assert.deepEqual(again.comments(), []);
  assert.deepEqual(again.calls, [], 'a published request keeps status:published');
});

test('edit-request.yml: a queued edit reads the live labels, not the payload, before marking received', async () => {
  // The `edited` run waited in the per-issue queue; meanwhile the request was
  // published. The payload still shows no status label, the issue has one.
  const first = await runWorkflow({ body: issueBody() });
  const stale = await runWorkflow({
    body: issueBody(),
    action: 'edited',
    labels: [EDIT_REQUEST_LABEL],
    liveLabels: [EDIT_REQUEST_LABEL, STATUS.published],
    comments: first.state.comments,
  });
  assert.deepEqual(stale.calls, [], 'nothing is added next to status:published');
  assert.deepEqual(stale.state.labels, [EDIT_REQUEST_LABEL, STATUS.published]);

  // Not yet acknowledged either: the comment still goes out, the status stays.
  const unacknowledged = await runWorkflow({
    body: issueBody(),
    action: 'edited',
    labels: [EDIT_REQUEST_LABEL],
    liveLabels: [EDIT_REQUEST_LABEL, STATUS.declined],
  });
  assert.equal(unacknowledged.comments().length, 1);
  assert.deepEqual(
    unacknowledged.calls.filter((call) => call[0] !== 'comment'),
    [],
    'a declined request keeps status:declined'
  );
});

test('acknowledgeEditRequest: when the labels cannot be re-read, it still replies and leaves the status alone', async () => {
  const github = fakeGitHub({ labels: [EDIT_REQUEST_LABEL] });
  github.rest.issues.get = async () => {
    throw Object.assign(new Error('Bad gateway'), { status: 502 });
  };
  const warnings = [];
  const result = await acknowledgeEditRequest({
    github,
    context: {
      repo: { owner: 'acme', repo: 'catalog' },
      issue: { number: 41 },
      runId: 1000,
      payload: { action: 'edited', issue: { number: 41, labels: [{ name: EDIT_REQUEST_LABEL }] } },
    },
    core: { info() {}, notice() {}, warning: (message) => warnings.push(message) },
    body: issueBody(),
    root: WORKSPACE,
  });
  assert.equal(result.posted, true);
  assert.equal(github.comments().length, 1);
  assert.deepEqual(github.state.labels, [EDIT_REQUEST_LABEL], 'no status from a stale payload');
  assert.ok(warnings.some((message) => /re-read #41/.test(message)));
});

test('edit-request.yml: the wording can be replaced under notifications.messages', async () => {
  writeSite(
    'name: Acme\nnotifications:\n  messages:\n    edit_request: "Got it, {number}.\\n\\n{entry_note}"\n    edit_request_unknown_entry: "No page for {entry}."\n'
  );
  try {
    const known = await runWorkflow({ body: issueBody() });
    assert.equal(known.comments()[0].split('\n\n')[0], 'Got it, #41.');
    const unknown = await runWorkflow({ body: issueBody({ slug: 'nope' }) });
    assert.match(unknown.comments()[0], /^Got it, #41\.\n\nNo page for `nope`\./);
  } finally {
    writeSite('name: Acme\n');
  }
});

test('edit-request.yml keeps issue text out of the shell and can only comment and label', () => {
  const text = fs.readFileSync(WORKFLOW_FILE, 'utf8');
  const workflow = YAML.parse(text);
  assert.deepEqual(Object.keys(workflow.on), ['issues']);
  assert.deepEqual(workflow.on.issues.types, ['opened', 'edited']);
  assert.equal(Object.keys(workflow.permissions).length, 0, 'no workflow-wide permissions');
  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.match(job.if, /github\.event\.issue\.state == 'open'/);
  assert.match(job.if, /contains\(github\.event\.issue\.labels\.\*\.name, 'content:edit-request'\)/);
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
  for (const step of job.steps) {
    assert.doesNotMatch(String(step.run ?? ''), /\$\{\{/, `"${step.name}" puts an expression in a shell`);
  }
  const checkout = job.steps.find((step) => /actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(
    job.steps.some((step) => /npm ci/.test(step.run ?? '')),
    'installs before importing'
  );
  assert.doesNotMatch(text, /gh pr create|git push|pull-requests: write/, 'nothing here edits an entry');
  assert.ok(INTAKE_LABELS.includes(EDIT_REQUEST_LABEL), 'its pull request is tracked like any intake draft');
});
