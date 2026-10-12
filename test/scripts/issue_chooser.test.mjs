import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  isRepositoryIdentity,
  optionalFormChanges,
  optionalFormFiles,
  renderIssueChooser,
  setupFormsEnabled,
} from '../../assets/js/configurator/issue-chooser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the checked-in issue chooser matches the canonical generator', () => {
  const site = YAML.parse(fs.readFileSync(path.join(ROOT, '_data/site.yml'), 'utf8'));
  const expected = renderIssueChooser(site.github.repository, site.github.branch, {
    setup: setupFormsEnabled(site),
  });
  const actual = fs.readFileSync(path.join(ROOT, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');
  assert.equal(actual, expected);
});

test('the canonical chooser migrates safety structure while preserving downstream identity', () => {
  const chooser = YAML.parse(renderIssueChooser('example/community-catalog', 'release/catalog-v2'));
  assert.equal(chooser.blank_issues_enabled, false);
  assert.deepEqual(
    chooser.contact_links.map((link) => link.url),
    [
      'https://github.com/example/community-catalog/security/advisories/new',
      'https://github.com/example/community-catalog/blob/release/catalog-v2/SECURITY.md',
      'https://github.com/example/community-catalog/blob/release/catalog-v2/docs/admin-guide.md',
    ]
  );
});

test('the Launch checklist link is offered only while setup is in progress', () => {
  const finished = YAML.parse(renderIssueChooser('example/community-catalog', 'main'));
  assert.equal(
    finished.contact_links.some((link) => link.name === 'Launch checklist'),
    false,
    'a finished site does not send reporters to the maintainers-only launch guide'
  );
  const setup = YAML.parse(renderIssueChooser('example/community-catalog', 'main', { setup: true }));
  assert.deepEqual(setup.contact_links.at(-1), {
    name: 'Launch checklist',
    url: 'https://github.com/example/community-catalog/blob/main/docs/launch.md',
    about:
      'Setting this catalog up for the first time — settings, the /setup/ wizard, and clearing the demo content.',
  });
  // Everything a finished site still needs is the same either way.
  assert.deepEqual(setup.contact_links.slice(0, -1), finished.contact_links);
});

test('setup forms follow demo unless github.setup_forms says otherwise', () => {
  assert.equal(setupFormsEnabled({ demo: true }), true);
  assert.equal(setupFormsEnabled({ demo: false }), false);
  assert.equal(setupFormsEnabled({}), false, 'a missing demo is the same as false');
  assert.equal(setupFormsEnabled({ demo: true, github: { setup_forms: false } }), false);
  assert.equal(setupFormsEnabled({ demo: false, github: { setup_forms: true } }), true);
  assert.equal(
    setupFormsEnabled({ demo: true, github: { setup_forms: '' } }),
    true,
    'only a boolean overrides'
  );
});

test('the canonical chooser rejects malformed repository identity', () => {
  assert.equal(isRepositoryIdentity(' example/community-catalog '), true);
  assert.equal(isRepositoryIdentity(''), false);
  assert.equal(isRepositoryIdentity('not-a-repository'), false);
  assert.throws(() => renderIssueChooser('not-a-repository'), /owner\/repository/u);
});

test('the canonical chooser defaults a missing branch and URL-encodes branch segments', () => {
  assert.match(renderIssueChooser('example/community-catalog', ''), /blob\/main\/SECURITY\.md/u);
  assert.match(
    renderIssueChooser('example/community-catalog', 'release/catalog#2'),
    /blob\/release\/catalog%232\/SECURITY\.md/u
  );
});

test('optionalFormChanges lists only what a change adds and retires', () => {
  const sources = Object.fromEntries(
    ['apply-setup.yml', 'new-year.yml', 'schedule.yml', 'new-event.yml', 'update-event-attachments.yml'].map(
      (file) => [file, `name: ${file}\n`]
    )
  );
  const finished = { demo: false, modules: { cohorts: false } };
  const cohorts = { demo: false, modules: { cohorts: true } };

  assert.deepEqual(optionalFormChanges(finished, finished, sources), { add: {}, remove: {} });
  assert.deepEqual(optionalFormChanges(cohorts, cohorts, sources), { add: {}, remove: {} });

  const on = optionalFormChanges(finished, cohorts, sources);
  assert.deepEqual(Object.keys(on.add), [
    '.github/ISSUE_TEMPLATE/new-year.yml',
    '.github/ISSUE_TEMPLATE/schedule.yml',
    '.github/ISSUE_TEMPLATE/new-event.yml',
    '.github/ISSUE_TEMPLATE/update-event-attachments.yml',
  ]);
  assert.equal(
    on.add['.github/ISSUE_TEMPLATE/new-year.yml'],
    optionalFormFiles(cohorts, sources).write['.github/ISSUE_TEMPLATE/new-year.yml']
  );
  assert.deepEqual(on.add['.github/ISSUE_TEMPLATE/new-year.yml'].split('\n').slice(-2), [
    'name: new-year.yml',
    '',
  ]);
  assert.deepEqual(on.remove, {});

  const off = optionalFormChanges({ ...cohorts, demo: true }, finished, sources);
  assert.deepEqual(off.add, {});
  assert.deepEqual(Object.keys(off.remove), [
    '.github/ISSUE_TEMPLATE/apply-setup.yml',
    '.github/ISSUE_TEMPLATE/new-year.yml',
    '.github/ISSUE_TEMPLATE/schedule.yml',
    '.github/ISSUE_TEMPLATE/new-event.yml',
    '.github/ISSUE_TEMPLATE/update-event-attachments.yml',
  ]);
  assert.equal(off.remove['.github/ISSUE_TEMPLATE/new-year.yml'], 'modules.cohorts');
});

test('optionalFormFiles refuses to render a form whose source is missing', () => {
  assert.throws(
    () => optionalFormFiles({ modules: { cohorts: true } }, {}),
    /Missing scripts\/issue-forms\/new-year\.yml/u
  );
  // A form that is off needs no source.
  assert.deepEqual(optionalFormFiles({ modules: { cohorts: false } }, {}).write, {});
});
