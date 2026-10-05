/**
 * The content-only rule: a pull request whose every changed file is entry
 * content runs the content check and nothing else, and every other pull
 * request runs every check as before. Covers the classifier itself, the CLI
 * the workflows call (against a real git repository), and the wiring — each
 * code job is gated on the classification, the content check never is, and
 * every required context still reports when its job is skipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { contentPaths, isContentOnly } from '../../scripts/lib/content_only.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, '.github', 'workflows');
const source = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const parse = (name) => YAML.parse(source(name));

const SCHEMA = { entry: { path: 'catalog' } };
const GATE = "needs.changes.outputs.content_only != 'true'";

test('a submission that only adds an entry, its media and their derivatives is content-only', () => {
  assert.equal(
    isContentOnly(
      [
        'catalog/new-tool/index.md',
        'catalog/new-tool/deck.pdf',
        'catalog/new-tool/thumb.jpg',
        'catalog/new-tool/screenshots/01.png',
        'catalog/new-tool/screenshots/01-800.avif',
        'catalog/new-tool/screenshots/01-800.webp',
        'catalog/new-tool/screenshots/02.GIF',
        '_data/derivatives.json',
      ],
      SCHEMA
    ),
    true
  );
  // Removing an entry is content too.
  assert.equal(isContentOnly(['catalog/old-tool/index.md'], SCHEMA), true);
});

test('any file outside the entry content makes the pull request run everything', () => {
  // Mixed: one code file is enough.
  assert.equal(
    isContentOnly(['catalog/new-tool/index.md', 'scripts/new_entry_from_issue.mjs'], SCHEMA),
    false
  );
  assert.equal(isContentOnly(['catalog/new-tool/index.md', '.github/workflows/validate.yml'], SCHEMA), false);
  assert.equal(isContentOnly(['catalog/new-tool/index.md', '_data/schema.yml'], SCHEMA), false);
  // Code-only.
  assert.equal(isContentOnly(['package.json', 'package-lock.json'], SCHEMA), false);
  // Only files inside an entry's own folder count: catalog/<slug>/...
  assert.equal(isContentOnly(['catalog/index.md'], SCHEMA), false);
  assert.equal(isContentOnly(['_data/site.yml'], SCHEMA), false);
  assert.equal(isContentOnly(['_data/derivatives.json.bak'], SCHEMA), false);
  // A look-alike folder is not the content folder.
  assert.equal(isContentOnly(['catalogue/x/index.md'], SCHEMA), false);
  assert.equal(isContentOnly(['catalog'], SCHEMA), false);
});

test('an empty or unreadable change list is never content-only', () => {
  assert.equal(isContentOnly([], SCHEMA), false);
  assert.equal(isContentOnly(undefined, SCHEMA), false);
  assert.equal(isContentOnly([''], SCHEMA), false);
});

test('only the file types a submission produces count as content inside the entry folder', () => {
  // Script, markup or data under catalog/ would skip ESLint and CodeQL.
  for (const file of [
    'catalog/x/payload.js',
    'catalog/x/page.html',
    'catalog/x/logo.svg',
    'catalog/x/data.json',
    'catalog/x/plugin.rb',
    'catalog/x/Makefile',
  ]) {
    assert.equal(isContentOnly([file], SCHEMA), false, file);
  }
});

test('the content folder follows the schema, and an unsafe entry.path makes nothing content-only', () => {
  assert.deepEqual(contentPaths({ entry: { path: '/projects/' } }).folders, ['projects/']);
  assert.deepEqual(contentPaths(null).folders, ['catalog/']);
  assert.equal(isContentOnly(['projects/x/index.md'], { entry: { path: 'projects' } }), true);
  assert.equal(isContentOnly(['catalog/x/index.md'], { entry: { path: 'projects' } }), false);
  for (const unsafe of ['.', '..', '../scripts', '.github', '_data', 'catalog/../scripts', 'a b']) {
    assert.deepEqual(contentPaths({ entry: { path: unsafe } }).folders, [], unsafe);
    assert.equal(isContentOnly(['_data/derivatives.json'], { entry: { path: unsafe } }), false, unsafe);
  }
});

/** A scratch repository with a `main` branch and a feature branch checked out. */
function scratchRepo(changes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-content-only-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('_data/schema.yml', 'entry:\n  path: "catalog"\n');
  write('scripts/tool.mjs', 'export const x = 1;\n');
  write('catalog/old/index.md', '---\ntitle: Old\n---\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  changes({ git, write });
  git('add', '-A');
  git('commit', '-qm', 'change');
  return dir;
}

function classify(dir, base = 'main') {
  const output = path.join(dir, '.github-output');
  fs.writeFileSync(output, '');
  const result = spawnSync('node', [path.join(ROOT, 'scripts', 'content_only.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BASE_REF: base, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const match = /content_only<<(\S+)\n(.*)\n\1/u.exec(fs.readFileSync(output, 'utf8'));
  assert.ok(match, 'content_only was not written to $GITHUB_OUTPUT');
  return match[2];
}

test('the CLI classifies the branch against its base', () => {
  const content = scratchRepo(({ write }) => write('catalog/new/index.md', '---\ntitle: New\n---\n'));
  assert.equal(classify(content), 'true');

  const mixed = scratchRepo(({ write }) => {
    write('catalog/new/index.md', '---\ntitle: New\n---\n');
    write('scripts/tool.mjs', 'export const x = 2;\n');
  });
  assert.equal(classify(mixed), 'false');
});

test('a code file moved into the entry folder still counts as a change to code', () => {
  // With rename detection a move lists only the destination, which would hide
  // the deletion of scripts/tool.mjs.
  const moved = scratchRepo(({ git }) => git('mv', 'scripts/tool.mjs', 'catalog/old/tool.md'));
  assert.equal(classify(moved), 'false');
});

test('the CLI fails safe: an unknown base or no changes runs everything', () => {
  const content = scratchRepo(({ write }) => write('catalog/new/index.md', 'x\n'));
  assert.equal(classify(content, 'origin/does-not-exist'), 'false');
  assert.equal(classify(content, 'HEAD'), 'false');
  // A push or a scheduled run passes no base at all.
  assert.equal(classify(content, ''), 'false');
});

/** Every check skipped on a content-only pull request: workflow → jobs. */
const GATED_JOBS = {
  'validate.yml': ['checks', 'build-matrix', 'coverage'],
  'quality.yml': ['audit'],
  'supply-chain.yml': ['audit'],
  'performance.yml': ['scale'],
  'lint-workflows.yml': ['lint'],
};
const CLASSIFIED = [...Object.keys(GATED_JOBS), 'codeql.yml'];

test('every pull-request check workflow classifies its change set with the one shared job', () => {
  for (const name of CLASSIFIED) {
    const changes = parse(name).jobs.changes;
    assert.ok(changes, `${name} has no changes job`);
    assert.equal(changes.uses, './.github/workflows/content-only.yml', name);
    assert.deepEqual(changes.permissions, { contents: 'read' }, name);
    // A path-filtered workflow never starts, and its required contexts wait
    // at "Expected" for ever; the skip has to happen inside the run.
    const on = parse(name).on;
    assert.equal(on.pull_request?.paths, undefined, `${name} is path-filtered`);
    assert.equal(on.pull_request?.['paths-ignore'], undefined, `${name} is path-filtered`);
  }
  const reusable = parse('content-only.yml');
  assert.ok(
    reusable.on.workflow_call.outputs.content_only,
    'content-only.yml exposes no content_only output'
  );
  const steps = reusable.jobs.classify.steps;
  assert.ok(
    steps.some((step) => step.run === 'node scripts/content_only.mjs'),
    'content-only.yml does not run the classifier'
  );
  const checkout = steps.find((step) => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0, 'the merge base needs history');
  assert.equal(checkout.with['persist-credentials'], false);
});

test('each code job is skipped on content-only changes but still runs if the classification fails', () => {
  for (const [name, jobs] of Object.entries(GATED_JOBS)) {
    for (const id of jobs) {
      const job = parse(name).jobs[id];
      const needs = [].concat(job.needs ?? []);
      assert.ok(needs.includes('changes'), `${name} ${id} does not need changes`);
      // `!cancelled()` overrides the implicit success(): a failed or skipped
      // classification must run the job, never skip it into a green check.
      assert.match(
        String(job.if),
        /!cancelled\(\)/u,
        `${name} ${id} would be skipped by a failed classification`
      );
      assert.ok(String(job.if).includes(GATE), `${name} ${id} is not gated on content_only`);
    }
  }
});

test('CodeQL skips by step so its matrix check names still expand and report', () => {
  // A job-level `if:` is evaluated before the matrix is applied, so a skipped
  // matrix job never reports "Analyze ruby" and the required context waits.
  const analyze = parse('codeql.yml').jobs.analyze;
  assert.deepEqual([].concat(analyze.needs), ['changes']);
  assert.equal(String(analyze.if), '${{ !cancelled() }}');
  const work = analyze.steps.filter((step) => !String(step.name).startsWith('Skip'));
  assert.ok(work.length >= 3);
  for (const step of work) {
    assert.ok(String(step.if).includes(GATE), `codeql ${step.name} runs on content-only changes`);
  }
});

test('the content check runs on every pull request and carries the front-matter validation', () => {
  const jobs = parse('validate.yml').jobs;
  const content = jobs.content;
  assert.ok(content, 'validate.yml has no content job');
  assert.match(content.name, /^Content:/u);
  assert.equal(content.if, undefined, 'the content check must never be skipped');
  assert.equal(content.needs, undefined, 'the content check must not depend on the classification');
  const runs = content.steps.map((step) => step.run).filter(Boolean);
  for (const command of [
    'npm run validate',
    'node scripts/derive_images.mjs --check',
    'npm run build:release',
    'npm run links:check',
  ]) {
    assert.ok(runs.includes(command), `content check does not run ${command}`);
  }
});

test('dispatched runs report skipped jobs as passed only for a content-only change', () => {
  for (const name of CLASSIFIED) {
    const status = parse(name).jobs.status;
    assert.ok([].concat(status.needs).includes('changes'), `${name} status cannot see the classification`);
    const script = status.steps.at(-1).with.script;
    assert.match(
      script,
      /const contentOnly = \$\{\{ toJSON\(needs\.changes\.outputs\.content_only\) \}\} === 'true';/u,
      name
    );
    assert.match(script, /contentOnly && result === 'skipped'/u, name);
  }
  // A bot pull request sees the content check as a commit status.
  const validate = parse('validate.yml');
  assert.match(
    validate.jobs.status.steps.at(-1).with.script,
    /\['content', 'Content: entries and site build'\]/u
  );
  assert.equal(validate.jobs.content.name, 'Content: entries and site build');
});
