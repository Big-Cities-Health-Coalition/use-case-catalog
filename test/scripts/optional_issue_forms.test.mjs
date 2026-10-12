/**
 * The issue chooser follows the configuration: the cohort forms exist only
 * while `modules.cohorts` is on, Apply setup and the Launch checklist link only
 * while setup is in progress (`github.setup_forms`, or `demo`). GitHub has no
 * way to hide a form, so `npm run generate` writes and deletes the files — and
 * has to keep doing so through every PHCT update, which reconciles the
 * template-owned tree before it regenerates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as jsYaml from 'js-yaml';

import { OPTIONAL_FORM_SOURCES } from '../../assets/js/configurator/defaults.generated.js';
import { OPTIONAL_ISSUE_FORMS, optionalFormChanges } from '../../assets/js/configurator/issue-chooser.js';
import { issueFormProblems } from '../../assets/js/configurator/issue-form-limits.js';
import { renderFiles } from '../../assets/js/configurator/render-files.js';
import { applyUpdate } from '../../scripts/apply_phct_update.mjs';
import {
  optionalFormPath,
  optionalFormSource,
  renderOptionalForm,
} from '../../scripts/lib/optional_issue_forms.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COHORT_FORMS = ['new-year.yml', 'schedule.yml', 'new-event.yml', 'update-event-attachments.yml'];
const CHOOSER = '.github/ISSUE_TEMPLATE/config.yml';

/** A throwaway copy of what generate.mjs reads, sharing this checkout's node_modules. */
function scratchRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-issue-forms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['_data', '_includes', 'scripts', 'assets/js/configurator', '.github/ISSUE_TEMPLATE']) {
    fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  }
  for (const file of ['_config.yml', '.gitattributes']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  // No trailing slash: the entry is a symlink, which `node_modules/` would miss.
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  return root;
}

/** Rewrite the scratch copy's site.yml toggles in place, comments and all. */
function configure(root, { cohorts, demo, setupForms }) {
  const file = path.join(root, '_data/site.yml');
  let text = fs.readFileSync(file, 'utf8');
  const swap = (pattern, replacement) => {
    assert.match(text, pattern);
    text = text.replace(pattern, replacement);
  };
  if (cohorts !== undefined) swap(/^ {2}cohorts: (?:true|false)/mu, `  cohorts: ${cohorts}`);
  if (demo !== undefined) swap(/^demo: (?:true|false)/mu, `demo: ${demo}`);
  if (setupForms !== undefined) {
    text = text.replace(/^ {2}setup_forms: (?:true|false)\n/mu, '');
    swap(/^( {2}branch: .*\n)/mu, `$1  setup_forms: ${setupForms}\n`);
  }
  fs.writeFileSync(file, text);
}

function generate(root, ...args) {
  return spawnSync(process.execPath, ['scripts/generate.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

function generateOk(root, ...args) {
  const result = generate(root, ...args);
  assert.equal(result.status, 0, `generate ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result;
}

const exists = (root, relative) => fs.existsSync(path.join(root, relative));
const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const chooserLinks = (root) => jsYaml.load(read(root, CHOOSER)).contact_links.map((link) => link.name);

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** What the update commit would contain under .github/ISSUE_TEMPLATE/ (the workflow runs `git add -A`). */
function chooserChanges(root) {
  git(root, 'add', '--all');
  return git(root, 'diff', '--cached', '--name-status', '--', '.github/ISSUE_TEMPLATE')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\s+/gu, ' '))
    .sort();
}

function commitAll(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '--no-verify', '-m', message);
}

test('the checked-in template has exactly the optional forms its own site.yml asks for', () => {
  const site = jsYaml.load(read(ROOT, '_data/site.yml'));
  for (const form of OPTIONAL_ISSUE_FORMS) {
    const relative = optionalFormPath(form.file);
    if (form.enabled(site)) {
      assert.equal(
        read(ROOT, relative),
        renderOptionalForm(form, read(ROOT, optionalFormSource(form.file))),
        `${relative} is not the generated copy of its source`
      );
    } else {
      assert.equal(exists(ROOT, relative), false, `${relative} is checked in while ${form.when} is off`);
    }
  }
});

test('every optional form source is a valid issue form, on or off', () => {
  for (const form of OPTIONAL_ISSUE_FORMS) {
    const source = optionalFormSource(form.file);
    assert.deepEqual(issueFormProblems(jsYaml.load(read(ROOT, source))), [], source);
  }
});

test('a finished site with cohorts off has none of the optional forms and no Launch checklist link', (t) => {
  const root = scratchRepository(t);
  configure(root, { cohorts: false, demo: false });
  generateOk(root);

  for (const form of OPTIONAL_ISSUE_FORMS) {
    assert.equal(exists(root, optionalFormPath(form.file)), false, `${form.file} is still offered`);
  }
  assert.equal(chooserLinks(root).includes('Launch checklist'), false);
  assert.deepEqual(chooserLinks(root), [
    'Report a security vulnerability privately',
    'Security reporting help',
    'Maintainer guide',
  ]);
  // Hand-written forms every site needs are untouched.
  for (const file of ['bug.yml', 'site-problem.yml', 'edit-entry.yml', 'new-entry.yml']) {
    assert.ok(exists(root, `.github/ISSUE_TEMPLATE/${file}`), `${file} went missing`);
  }
  assert.match(generateOk(root, '--check').stdout, /in sync/);
});

test('a site with cohorts on gets every cohort form, each a valid issue form its workflow listens for', (t) => {
  const root = scratchRepository(t);
  configure(root, { cohorts: true, demo: false });
  generateOk(root);

  const workflows = fs
    .readdirSync(path.join(ROOT, '.github/workflows'))
    .map((name) => read(ROOT, `.github/workflows/${name}`));
  for (const file of COHORT_FORMS) {
    const relative = optionalFormPath(file);
    assert.ok(exists(root, relative), `${relative} was not written`);
    const form = jsYaml.load(read(root, relative));
    assert.deepEqual(issueFormProblems(form), [], relative);
    assert.match(read(root, relative), /^# Generated by scripts\/generate\.mjs from scripts\/issue-forms\//u);
    for (const label of form.labels) {
      assert.ok(
        workflows.some((source) => source.includes(`contains(github.event.issue.labels.*.name, '${label}')`)),
        `no workflow triggers on ${relative}'s "${label}" label`
      );
    }
  }
  assert.equal(exists(root, optionalFormPath('apply-setup.yml')), false, 'setup is finished');
  assert.match(generateOk(root, '--check').stdout, /in sync/);
});

test('setup forms follow demo, and github.setup_forms overrides it', (t) => {
  const root = scratchRepository(t);
  const applySetup = optionalFormPath('apply-setup.yml');

  configure(root, { demo: true });
  generateOk(root);
  assert.ok(exists(root, applySetup));
  assert.ok(chooserLinks(root).includes('Launch checklist'));

  // A deployment that keeps the demo banner up for provisional content.
  configure(root, { demo: true, setupForms: false });
  generateOk(root);
  assert.equal(exists(root, applySetup), false);
  assert.equal(chooserLinks(root).includes('Launch checklist'), false);

  configure(root, { demo: false, setupForms: true });
  generateOk(root);
  assert.ok(exists(root, applySetup));
  assert.ok(chooserLinks(root).includes('Launch checklist'));
});

test('generate --check fails when an optional form is missing and when one should be gone', (t) => {
  const root = scratchRepository(t);
  configure(root, { cohorts: true, demo: true });
  generateOk(root);
  generateOk(root, '--check');

  fs.rmSync(path.join(root, optionalFormPath('new-year.yml')));
  let result = generate(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.github\/ISSUE_TEMPLATE\/new-year\.yml/u);
  assert.equal(exists(root, optionalFormPath('new-year.yml')), false, '--check writes nothing');
  generateOk(root);

  configure(root, { cohorts: false, demo: false });
  result = generate(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schedule\.yml \(should not exist: modules\.cohorts is off\)/u);
  assert.match(result.stderr, /apply-setup\.yml \(should not exist: setup .* is off\)/u);
  assert.match(result.stderr, /config\.yml/u, 'the Launch checklist link is stale too');
  assert.ok(exists(root, optionalFormPath('schedule.yml')), '--check removes nothing');
});

test('a broken optional form source stops generate even while its module is off', (t) => {
  const root = scratchRepository(t);
  configure(root, { cohorts: false });
  const source = path.join(root, optionalFormSource('new-year.yml'));
  const form = jsYaml.load(fs.readFileSync(source, 'utf8'));
  form.description = 'Too long. '.repeat(25);
  fs.writeFileSync(source, jsYaml.dump(form));

  const result = generate(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/issue-forms\/new-year\.yml\n {2}• description is 250 characters/u);
});

test('both configurators render the same chooser generate writes', (t) => {
  const root = scratchRepository(t);
  for (const demo of [true, false]) {
    configure(root, { demo });
    generateOk(root);
    const site = jsYaml.load(read(root, '_data/site.yml'));
    assert.equal(renderFiles({ site, theme: {}, schema: {} })[CHOOSER], read(root, CHOOSER), `demo: ${demo}`);
  }
});

/**
 * Three PHCT releases in one repository, and a deployment cut from the first as
 * an unrelated history (a GitHub template copy). v1.0.0 ships all five forms in
 * .github/ISSUE_TEMPLATE/ (as every release before this change did); v1.1.0
 * ships the template's own set — Apply setup only, because the template has
 * cohorts off and demo on — and rewords a cohort form; v1.2.0 changes nothing
 * that matters here.
 */
function releases(t) {
  const root = scratchRepository(t);
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'PHCT test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');

  configure(root, { cohorts: true, demo: true });
  generateOk(root);
  commitAll(root, 'parent v1.0.0');
  git(root, 'tag', 'v1.0.0');
  const baseline = git(root, 'rev-parse', 'v1.0.0^{tree}');

  configure(root, { cohorts: false, demo: true });
  fs.appendFileSync(path.join(root, optionalFormSource('new-year.yml')), '# reworded in v1.1.0\n');
  generateOk(root);
  commitAll(root, 'parent v1.1.0');
  git(root, 'tag', 'v1.1.0');

  fs.appendFileSync(path.join(root, 'RELEASE-NOTE.txt'), 'v1.2.0\n');
  commitAll(root, 'parent v1.2.0');
  git(root, 'tag', 'v1.2.0');

  return { root, baseline };
}

/** Cut a deployment from v1.0.0, configure it, and commit — as the update workflow finds it. */
function deployment(root, baseline, settings) {
  git(
    root,
    'checkout',
    '--quiet',
    '-B',
    'downstream',
    git(root, 'commit-tree', baseline, '-m', 'template copy')
  );
  configure(root, settings);
  commitAll(root, 'configure the deployment');
}

/** What update-phct.yml does: reconcile the template-owned tree, then regenerate. */
function update(root, from, to) {
  applyUpdate({ root, from, to });
  generateOk(root);
  generateOk(root, '--check');
}

test('an update leaves a finished, cohorts-off deployment without the forms, and keeps it that way', (t) => {
  const { root, baseline } = releases(t);
  deployment(root, baseline, { cohorts: false, demo: false });
  // Before this change every deployment carried all five.
  for (const form of OPTIONAL_ISSUE_FORMS) assert.ok(exists(root, optionalFormPath(form.file)));

  update(root, 'v1.0.0', 'v1.1.0');
  for (const form of OPTIONAL_ISSUE_FORMS) {
    assert.equal(exists(root, optionalFormPath(form.file)), false, `the update left ${form.file} behind`);
  }
  assert.equal(chooserLinks(root).includes('Launch checklist'), false);
  assert.deepEqual(chooserChanges(root), [
    'D .github/ISSUE_TEMPLATE/apply-setup.yml',
    'D .github/ISSUE_TEMPLATE/new-event.yml',
    'D .github/ISSUE_TEMPLATE/new-year.yml',
    'D .github/ISSUE_TEMPLATE/schedule.yml',
    'D .github/ISSUE_TEMPLATE/update-event-attachments.yml',
    'M .github/ISSUE_TEMPLATE/config.yml',
  ]);
  commitAll(root, 'chore: update PHCT to v1.1.0');

  // v1.2.0 still ships apply-setup.yml (the template is mid-setup itself); the
  // reconciliation restores it and generate removes it again, so the update
  // pull request does not touch the chooser at all.
  update(root, 'v1.1.0', 'v1.2.0');
  assert.deepEqual(chooserChanges(root), []);
});

test("an update keeps a cohorts-on deployment's forms and delivers their new wording", (t) => {
  const { root, baseline } = releases(t);
  deployment(root, baseline, { cohorts: true, demo: false });

  // v1.1.0's tree has no cohort forms in .github/ISSUE_TEMPLATE/ (the template
  // has the module off), so the reconciliation deletes them; generate restores
  // them from the release's sources.
  update(root, 'v1.0.0', 'v1.1.0');
  for (const file of COHORT_FORMS) assert.ok(exists(root, optionalFormPath(file)), `${file} was lost`);
  assert.match(read(root, optionalFormPath('new-year.yml')), /# reworded in v1\.1\.0\n$/u);
  assert.equal(exists(root, optionalFormPath('apply-setup.yml')), false);
  assert.deepEqual(chooserChanges(root), [
    'D .github/ISSUE_TEMPLATE/apply-setup.yml',
    'M .github/ISSUE_TEMPLATE/config.yml',
    'M .github/ISSUE_TEMPLATE/new-year.yml',
  ]);
});

/** Every file in the scratch copy's .github/ISSUE_TEMPLATE/, name → contents. */
function issueTemplates(root) {
  const dir = path.join(root, '.github/ISSUE_TEMPLATE');
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')])
  );
}

/** Assert two issueTemplates() snapshots match, naming the files that differ rather than dumping both. */
function assertSameTemplates(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: a different set of files`);
  for (const name of Object.keys(expected))
    assert.equal(actual[name], expected[name], `${label}: ${name} differs`);
}

/**
 * Do what /setup/'s review step tells a maintainer without a terminal to do in
 * GitHub's web editor, starting from the site the page was built from: commit
 * every renderFiles() file, create each optional form it lists (rendered from
 * the sources compiled into defaults.generated.js, as the page has them) and
 * delete each one it retires.
 */
function commitFromBrowser(root, next, current) {
  for (const [relative, content] of Object.entries(renderFiles(next, { url: '', baseurl: '' }))) {
    fs.writeFileSync(path.join(root, relative), content);
  }
  const forms = optionalFormChanges(current, next.site, OPTIONAL_FORM_SOURCES);
  for (const [relative, content] of Object.entries(forms.add)) {
    assert.equal(exists(root, relative), false, `/setup/ offers to create ${relative}, which exists`);
    fs.writeFileSync(path.join(root, relative), content);
  }
  for (const relative of Object.keys(forms.remove)) {
    assert.ok(exists(root, relative), `/setup/ offers to delete ${relative}, which does not exist`);
    fs.rmSync(path.join(root, relative));
  }
  return forms;
}

/** A finished site's configuration as /setup/ starts from it, with `change` applied to site.yml. */
function browserConfig(root, change) {
  const site = jsYaml.load(read(root, '_data/site.yml'));
  change(site);
  return {
    site,
    theme: jsYaml.load(read(root, '_data/theme.yml')),
    schema: jsYaml.load(read(root, '_data/schema.yml')),
  };
}

test('what /setup/ tells a finished site to commit leaves the issue forms generate would write', (t) => {
  const root = scratchRepository(t);
  configure(root, { cohorts: false, demo: false });
  generateOk(root);

  const cohortPaths = COHORT_FORMS.map(optionalFormPath);
  for (const cohorts of [true, false]) {
    const current = jsYaml.load(read(root, '_data/site.yml'));
    const forms = commitFromBrowser(
      root,
      browserConfig(root, (site) => {
        site.modules.cohorts = cohorts;
      }),
      current
    );
    assert.deepEqual(Object.keys(cohorts ? forms.add : forms.remove), cohortPaths);
    assert.deepEqual(Object.keys(cohorts ? forms.remove : forms.add), []);
    const committed = issueTemplates(root);
    generateOk(root);
    assertSameTemplates(issueTemplates(root), committed, `cohorts ${cohorts ? 'on' : 'off'}`);
  }

  for (const setupForms of [true, false]) {
    const current = jsYaml.load(read(root, '_data/site.yml'));
    const forms = commitFromBrowser(
      root,
      browserConfig(root, (site) => {
        site.github.setup_forms = setupForms;
      }),
      current
    );
    assert.deepEqual(Object.keys(setupForms ? forms.add : forms.remove), [
      optionalFormPath('apply-setup.yml'),
    ]);
    const committed = issueTemplates(root);
    generateOk(root);
    assertSameTemplates(issueTemplates(root), committed, `setup_forms: ${setupForms}`);
  }
});

/** `npm run setup -- --preset <preset> --yes --dry-run` in the scratch copy. */
function setupDryRun(root, preset) {
  const result = spawnSync(
    process.execPath,
    ['scripts/setup.mjs', '--preset', preset, '--yes', '--dry-run'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

test('npm run setup --dry-run lists the issue forms generate would add and remove, and writes nothing', (t) => {
  const root = scratchRepository(t);
  // Its own starting point, not this repository's data (a deployment may have
  // cohorts on, or have already removed its samples and left demo mode): a
  // demo site with cohorts off and one sample entry, so setup offers to remove
  // the demo content and Apply setup exists to be retired.
  configure(root, { cohorts: false, demo: true });
  generateOk(root);
  const entryPath = jsYaml.load(read(root, '_data/schema.yml')).entry?.path || 'catalog';
  fs.mkdirSync(path.join(root, entryPath, 'fixture-sample'), { recursive: true });
  fs.writeFileSync(
    path.join(root, entryPath, 'fixture-sample', 'index.md'),
    '---\ntitle: "Fixture sample"\nslug: fixture-sample\nsample: true\n---\n'
  );
  const untouched = () => ({ templates: issueTemplates(root), site: read(root, '_data/site.yml') });

  // Cohorts are off: the cohort portal preset turns them on.
  let before = untouched();
  let output = setupDryRun(root, 'cohort-portal');
  assert.match(output, /Then `npm run generate` will change:/u);
  for (const file of COHORT_FORMS) {
    assert.match(output, new RegExp(`${escape(optionalFormPath(file))}\\s+new file`, 'u'));
  }
  assert.match(output, /assets\/js\/configurator\/defaults\.generated\.js\s+\+\d+ -\d+ lines/u);
  // The preset changes the schema, so --yes accepts removing the demo content,
  // which turns `demo` off and retires the Apply setup form.
  assert.match(output, new RegExp(`${escape(optionalFormPath('apply-setup.yml'))}\\s+delete`, 'u'));
  assert.match(
    output,
    /Then `npm run generate` will change:[\s\S]*\.github\/ISSUE_TEMPLATE\/config\.yml\s+\+\d+ -\d+ lines/u
  );
  assert.match(output, /Dry run — nothing was written/u);
  assert.deepEqual(untouched().site, before.site, 'the dry run wrote _data/site.yml');
  assertSameTemplates(untouched().templates, before.templates, 'the dry run');

  // A site with cohorts on: the blank preset turns them off.
  configure(root, { cohorts: true });
  generateOk(root);
  before = untouched();
  output = setupDryRun(root, 'blank');
  for (const file of COHORT_FORMS) {
    assert.match(
      output,
      new RegExp(`${escape(optionalFormPath(file))}\\s+delete \\(modules\\.cohorts is off\\)`, 'u')
    );
  }
  assert.deepEqual(untouched().site, before.site, 'the dry run wrote _data/site.yml');
  assertSameTemplates(untouched().templates, before.templates, 'the dry run');
});
