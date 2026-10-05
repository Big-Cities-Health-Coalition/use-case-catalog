/**
 * The workflow wiring around the submitter notifications: every rebuild of a
 * draft branch waits on the branch guard, the stage workflow listens for the
 * labels notify.mjs acts on and runs only default-branch code, Bootstrap labels
 * creates the same status labels the notifier does, and every step that
 * imports the notifier has installed it first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  ENTRY_LABEL,
  INTAKE_LABELS,
  MAINTAINER_ASSOCIATIONS,
  NOTIFY_LABELS,
  REVIEW_LABELS,
} from '../../scripts/lib/notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, '.github', 'workflows');
const source = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const parse = (name) => YAML.parse(source(name));

/** Workflows that build a submission's draft branch from an issue. */
const INTAKE = [
  'also-deployed-by.yml',
  'apply-setup.yml',
  'new-entry.yml',
  'new-event.yml',
  'new-year.yml',
  'refresh-entry.yml',
  'update-event-attachments.yml',
  'update-schedule.yml',
];

const writesBranch = (step) =>
  /peter-evans\/create-pull-request@/.test(step.uses ?? '') || /\bgit push\b/.test(step.run ?? '');

test('every intake workflow checks the draft branch before it rebuilds it, on the same branch', () => {
  for (const name of INTAKE) {
    for (const [jobName, job] of Object.entries(parse(name).jobs)) {
      const steps = job.steps ?? [];
      const writers = steps.filter(writesBranch);
      if (writers.length === 0) continue;
      const guardIndex = steps.findIndex((step) => step.id === 'guard');
      assert.ok(guardIndex >= 0, `${name} ${jobName} has no guard step`);
      const guard = steps[guardIndex];
      assert.equal(guard.run, 'node scripts/branch_guard.mjs', `${name} guard`);
      const checkout = steps.find((step) => /actions\/checkout@/.test(step.uses ?? ''));
      assert.equal(
        checkout?.with?.['fetch-depth'],
        0,
        `${name} ${jobName}: the guard reads every remote branch`
      );
      for (const writer of writers) {
        const index = steps.indexOf(writer);
        assert.ok(index > guardIndex, `${name} "${writer.name}" runs before the guard`);
        assert.match(
          String(writer.if ?? ''),
          /steps\.guard\.outputs\.held != 'true'/,
          `${name} "${writer.name}" ignores the guard`
        );
        const branch = writer.with?.branch ?? writer.env?.BRANCH;
        assert.equal(
          branch,
          guard.env?.BRANCH,
          `${name} "${writer.name}" checks one branch and writes another`
        );
        if (/\bgit push\b/.test(writer.run ?? '')) {
          assert.match(writer.run, /git push --force-with-lease origin /, `${name} pushes without a lease`);
        }
      }
      const handOver = steps.find((step) => /notify\.holdEdit\(/.test(step.with?.script ?? ''));
      assert.ok(handOver, `${name} ${jobName} never hands a held edit to the reviewer`);
      assert.match(String(handOver.if), /steps\.guard\.outputs\.held == 'true'/);
    }
  }
});

test('every intake workflow marks the submission received when it opens', () => {
  for (const name of INTAKE) {
    assert.match(source(name), /status: notify\.STATUS\.received/, `${name} never sets status:received`);
  }
});

test('every step that imports the notifier has checked out and installed the repository first', () => {
  const names = fs.readdirSync(DIR).filter((file) => file.endsWith('.yml'));
  let seen = 0;
  for (const name of names) {
    for (const [jobName, job] of Object.entries(parse(name).jobs ?? {})) {
      const steps = job.steps ?? [];
      steps.forEach((step, index) => {
        if (!/notify_github\.mjs/.test(step.with?.script ?? '')) return;
        seen += 1;
        const before = steps.slice(0, index);
        assert.ok(
          before.some((s) => /actions\/checkout@/.test(s.uses ?? '')),
          `${name} ${jobName}: no checkout before "${step.name}"`
        );
        assert.ok(
          before.some((s) => /npm ci/.test(s.run ?? '')),
          `${name} ${jobName}: no npm ci before "${step.name}"`
        );
        assert.equal(job.permissions?.issues, 'write', `${name} ${jobName} cannot comment`);
      });
    }
  }
  assert.ok(seen >= INTAKE.length + 3, `only ${seen} notifier steps found`);
});

test('submission-status.yml listens for exactly the review labels notify.mjs acts on', () => {
  const workflow = parse('submission-status.yml');
  const labels = JSON.parse(/fromJSON\('(\[[^']*\])'\)/.exec(workflow.jobs.notify.if)[1]);
  assert.deepEqual(labels.sort(), Object.values(REVIEW_LABELS).sort());
});

/** The `content:*` label a workflow's job `if` requires on the issue. */
const formLabel = (name) => {
  const labels = Object.values(parse(name).jobs).flatMap((job) => [
    ...String(job.if ?? '').matchAll(
      /contains\(github\.event\.issue\.labels\.\*\.name, '(content:[a-z-]+)'\)/g
    ),
  ]);
  return [...new Set(labels.map((m) => m[1]))];
};

/** The labels a workflow puts on the pull request it opens or reuses. */
const draftLabels = (name) =>
  Object.values(parse(name).jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => {
      if (/peter-evans\/create-pull-request@/.test(step.uses ?? '')) return [String(step.with?.labels ?? '')];
      const run = String(step.run ?? '');
      if (!/\bgh pr (create|edit)\b/.test(run)) return [];
      return [...run.matchAll(/--(?:add-)?label (content:[a-z-]+)/g)].map((m) => m[1]);
    })
  );

test('every intake workflow labels its draft with its form label, and INTAKE_LABELS lists exactly those', () => {
  const seen = [];
  for (const name of INTAKE) {
    const [form, ...others] = formLabel(name);
    assert.ok(form && others.length === 0, `${name} runs for ${others.length + (form ? 1 : 0)} form labels`);
    const onDraft = draftLabels(name);
    assert.ok(onDraft.length > 0, `${name} opens its draft without a label`);
    for (const label of onDraft) assert.equal(label, form, `${name} labels its draft ${label}, not ${form}`);
    seen.push(form);
  }
  assert.deepEqual([...seen].sort(), [...INTAKE_LABELS].sort());
  assert.ok(INTAKE_LABELS.includes(ENTRY_LABEL));
  const bootstrapped = [...source('bootstrap-labels.yml').matchAll(/^\s*create "(content:[a-z-]+)"/gm)].map(
    (m) => m[1]
  );
  assert.deepEqual(
    bootstrapped.sort(),
    [...INTAKE_LABELS].sort(),
    'bootstrap-labels.yml creates another set'
  );
});

test('submission-status.yml lets a close through for every intake label, and review events for entries only', () => {
  const condition = parse('submission-status.yml').jobs.notify.if;
  // The pre-filter is the `content:` prefix; stageDecision checks the exact list.
  for (const label of INTAKE_LABELS) assert.ok(label.startsWith('content:'), label);
  assert.match(
    condition,
    /\(github\.event\.action == 'closed'\s*&& contains\(join\(github\.event\.pull_request\.labels\.\*\.name, ' '\), 'content:'\)\)/
  );
  assert.match(
    condition,
    new RegExp(
      `\\|\\| \\(contains\\(github\\.event\\.pull_request\\.labels\\.\\*\\.name, '${ENTRY_LABEL}'\\)\\s*&& \\(\\(github\\.event_name == 'pull_request'`
    ),
    'label and review events need the entry label'
  );
});

test('submission-status.yml runs only default-branch code, for pull requests from this repository', () => {
  const workflow = parse('submission-status.yml');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'pull_request_review']);
  assert.equal(
    workflow.permissions && Object.keys(workflow.permissions).length,
    0,
    'no workflow-wide permissions'
  );
  const job = workflow.jobs.notify;
  assert.match(job.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write', 'pull-requests': 'read' });
  const checkout = job.steps.find((step) => /actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  for (const step of job.steps) {
    assert.doesNotMatch(
      String(step.run ?? ''),
      /\$\{\{\s*github\.event/,
      `"${step.name}" puts event text in a shell`
    );
  }
  for (const name of fs.readdirSync(DIR).filter((file) => file.endsWith('.yml'))) {
    assert.ok(
      !Object.hasOwn(parse(name).on ?? {}, 'pull_request_target'),
      `${name} uses pull_request_target`
    );
  }
});

test('Bootstrap labels creates the status and triage labels exactly as the notifier would', () => {
  const created = [
    ...source('bootstrap-labels.yml').matchAll(/^\s*create "([^"]+)"\s+"([0-9A-Fa-f]{6})"\s+"([^"]*)"/gm),
  ].map(([, name, color, description]) => ({ name, color, description }));
  for (const label of NOTIFY_LABELS) {
    assert.deepEqual(
      created.find((c) => c.name === label.name),
      label,
      `${label.name} differs between bootstrap-labels.yml and scripts/lib/notify.mjs`
    );
  }
  for (const label of created)
    assert.ok(label.description.length <= 100, `${label.name}: over GitHub's 100-character limit`);
});

test('submission-status.yml queues runs per pull request on the job, so skipped runs never take a place', () => {
  const workflow = parse('submission-status.yml');
  assert.equal(
    workflow.concurrency,
    undefined,
    'a workflow-level group lets filtered runs cancel the pending one'
  );
  const job = workflow.jobs.notify;
  assert.equal(job.concurrency.group, 'submission-status-${{ github.event.pull_request.number }}');
  assert.equal(job.concurrency['cancel-in-progress'], false);
});

test('submission-status.yml acts on a review only from the associations notify.mjs trusts', () => {
  const condition = parse('submission-status.yml').jobs.notify.if;
  const named = [...condition.matchAll(/github\.event\.review\.author_association == '([A-Z_]+)'/g)].map(
    (m) => m[1]
  );
  assert.deepEqual(named.sort(), [...MAINTAINER_ASSOCIATIONS].sort());
  assert.match(
    condition,
    /github\.event\.review\.state == 'changes_requested'\s*&& \(github\.event\.review\.author_association/
  );
});

/** Intake workflows whose branch name comes from answers a submitter can edit. */
const EDITABLE_BRANCH = {
  'new-entry.yml': { label: 'content:new-entry', prefix: 'entry/', numbered: true },
  'new-event.yml': { label: 'content:new-event', prefix: 'event/', numbered: false },
  'also-deployed-by.yml': { label: 'content:also-deployed-by', prefix: 'also-deployed/', numbered: true },
  'refresh-entry.yml': { label: 'content:refresh', prefix: 'refresh/', numbered: true },
};

test('an edit that renames the proposed branch goes to the draft already open for the issue', () => {
  for (const [name, expected] of Object.entries(EDITABLE_BRANCH)) {
    const workflow = parse(name);
    const [job] = Object.values(workflow.jobs).filter((j) =>
      (j.steps ?? []).some((step) => step.id === 'guard')
    );
    const steps = job.steps;
    const draftIndex = steps.findIndex((step) => step.id === 'draft');
    assert.ok(draftIndex >= 0, `${name} has no draft lookup`);
    const draft = steps[draftIndex];
    const script = draft.with?.script ?? '';
    assert.match(script, /scripts\/lib\/drafts\.mjs/, name);
    assert.match(script, /findDraftBranch\(/, name);
    assert.match(script, new RegExp(`label: '${expected.label}'`), `${name} looks for the wrong label`);
    assert.match(script, new RegExp(`prefix: '${expected.prefix.replace('/', '\\/')}'`), `${name} prefix`);
    assert.equal(/numbered: true/.test(script), expected.numbered, `${name} numbered`);
    assert.match(String(job.if), new RegExp(`'${expected.label}'`), `${name} runs for another label`);
    assert.match(script, /core\.setOutput\('branch', branch\)/, name);

    const proposed = draft.env?.PROPOSED;
    assert.match(String(proposed), /^\$\{\{ steps\.\w+\.outputs\.branch \}\}$/, `${name} proposes nothing`);
    const guardIndex = steps.findIndex((step) => step.id === 'guard');
    assert.ok(draftIndex < guardIndex, `${name} looks for the draft after the guard`);
    const branchSteps = steps.filter(
      (step) => step.env?.BRANCH !== undefined || step.with?.branch !== undefined
    );
    assert.ok(branchSteps.length >= 3, `${name}: only ${branchSteps.length} steps name a branch`);
    for (const step of branchSteps) {
      assert.equal(
        step.env?.BRANCH ?? step.with?.branch,
        '${{ steps.draft.outputs.branch }}',
        `${name} "${step.name}" uses the proposed name, not the draft's`
      );
      const index = steps.indexOf(step);
      assert.ok(index > draftIndex, `${name} "${step.name}" runs before the draft lookup`);
    }
  }
});

test('create-pull-request only builds branches that are new on every run', () => {
  const usesCpr = INTAKE.filter((name) =>
    Object.values(parse(name).jobs).some((job) =>
      (job.steps ?? []).some((step) => /peter-evans\/create-pull-request@/.test(step.uses ?? ''))
    )
  );
  assert.deepEqual(usesCpr.sort(), ['update-event-attachments.yml', 'update-schedule.yml']);
  const timestamped = {
    'update-schedule.yml': ['scripts/update_schedule_from_issue.rb', /branch = "schedule\/[^"\n]*Time\.now/],
    'update-event-attachments.yml': [
      'scripts/update_event_attachments_from_issue.mjs',
      /setOutput\('branch', `event-attachments\/[^`]*\$\{Date\.now\(\)\}`\)/,
    ],
  };
  for (const name of usesCpr) {
    const [script, pattern] = timestamped[name];
    assert.match(
      fs.readFileSync(path.join(ROOT, script), 'utf8'),
      pattern,
      `${script} must name a new branch every run`
    );
  }
});
