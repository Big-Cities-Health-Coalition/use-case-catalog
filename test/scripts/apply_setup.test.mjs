/**
 * The "Apply setup" issue is the only path into this repository that rewrites
 * the site's own configuration, so these tests hold the two ends of it
 * together: the section labels in `scripts/issue-forms/apply-setup.yml`
 * against the ones `scripts/apply_setup_from_issue.mjs` looks for (a form and a
 * parser that disagree fail silently, with an empty pull request), and the
 * refusals — bad YAML, an invalid schema, an unreadable palette — which have to
 * come back as a sentence on the issue rather than as a red X three steps
 * later.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import {
  EJECT_LABEL,
  SECTION_LABELS,
  configErrors,
  filesFor,
  parseSetupIssue,
  parseYamlSection,
  stripFence,
} from '../../scripts/apply_setup_from_issue.mjs';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The source: npm run generate copies it into .github/ISSUE_TEMPLATE/ only while
// setup forms are on (test/scripts/optional_issue_forms.test.mjs).
const FORM_PATH = 'scripts/issue-forms/apply-setup.yml';
const form = yaml.load(fs.readFileSync(path.join(ROOT, FORM_PATH), 'utf8'));
const shipped = defaultConfig();

/** An issue body the way GitHub renders the form, with `render: yaml` fences. */
function issueBody({ site = '', theme = '', schema = '', eject = false } = {}) {
  const block = (label, text) => `### ${label}\n\n\`\`\`yaml\n${text}\n\`\`\`\n\n`;
  return (
    block(SECTION_LABELS.site, site) +
    block(SECTION_LABELS.theme, theme) +
    block(SECTION_LABELS.schema, schema) +
    `### ${SECTION_LABELS.options}\n\n- [${eject ? 'x' : ' '}] ${EJECT_LABEL} — the sample entries, events, cohort and resources — and turn the demo banner off\n`
  );
}

test('every section the parser looks for is a control on the form', () => {
  const labels = new Set(
    form.body.filter((item) => item.attributes?.label).map((item) => item.attributes.label)
  );
  for (const [key, label] of Object.entries(SECTION_LABELS)) {
    assert.ok(labels.has(label), `${FORM_PATH} has no control labelled "${label}" (${key})`);
  }
});

test('the eject checkbox on the form still starts with the label the parser matches', () => {
  const options = form.body.find((item) => item.id === 'options');
  assert.ok(options, 'the form has an options checkbox group');
  assert.ok(
    options.attributes.options.some((option) => String(option.label).startsWith(EJECT_LABEL)),
    `no checkbox starts with "${EJECT_LABEL}"`
  );
});

test('the form is labelled so apply-setup.yml can trigger on it', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/apply-setup.yml'), 'utf8'));
  const guard = workflow.jobs.apply.if;
  for (const label of form.labels) {
    assert.ok(guard.includes(label), `the workflow does not check for the "${label}" label`);
  }
  assert.match(guard, /author_association/, 'the workflow is maintainers only');
  assert.match(guard, /state == 'open'/, "a closed issue's branch must not be force-pushed again");
});

test('stripFence unwraps whatever the maintainer pasted', () => {
  assert.equal(stripFence('```yaml\nname: "A"\n```'), 'name: "A"');
  assert.equal(stripFence('~~~\nname: "A"\n~~~'), 'name: "A"');
  assert.equal(stripFence('name: "A"'), 'name: "A"', 'a plain paste needs no fence');
  assert.equal(stripFence(''), '');
  assert.equal(stripFence('a: 1\n```\nb: 2'), 'a: 1\n```\nb: 2', 'a stray fence is not a wrapper');
});

test('the three files and the checkbox come out of the issue body', () => {
  const parsed = parseSetupIssue(
    issueBody({ site: 'name: "Mine"', theme: 'colors: {}', schema: 'fields: []', eject: true })
  );
  assert.equal(parsed.site, 'name: "Mine"');
  assert.equal(parsed.theme, 'colors: {}');
  assert.equal(parsed.schema, 'fields: []');
  assert.equal(parsed.eject, true);
});

test('an unchecked box is not an eject', () => {
  assert.equal(parseSetupIssue(issueBody({ site: 'name: "Mine"' })).eject, false);
});

test('a heading the maintainer typed inside the YAML cannot forge a section', () => {
  // Only the four known labels start a section, so a `###` line in a pasted
  // comment stays part of the file it was pasted into.
  const parsed = parseSetupIssue(issueBody({ site: '# ### Notes\nname: "Mine"', schema: 'fields: []' }));
  assert.match(parsed.site, /### Notes/);
  assert.equal(parsed.schema, 'fields: []');
});

test('an empty theme box is empty, not the literal fence', () => {
  assert.equal(parseSetupIssue(issueBody({ site: 'name: "Mine"' })).theme, '');
});

test('parseYamlSection refuses anything that is not a mapping', () => {
  assert.equal(parseYamlSection('', '_data/theme.yml'), null);
  assert.deepEqual(parseYamlSection('name: "A"', '_data/site.yml'), { name: 'A' });
  assert.throws(() => parseYamlSection('- one\n- two', '_data/site.yml'), /must be a mapping/);
  assert.throws(() => parseYamlSection('name: "A"\n  bad', '_data/site.yml'), /not valid YAML/);
});

test('the shipped configuration applies cleanly', () => {
  assert.deepEqual(configErrors(shipped), []);
});

test('a missing repository or name is named in the error, not discovered later', () => {
  const errors = configErrors({ ...shipped, site: { ...shipped.site, name: '', github: {} } });
  assert.ok(
    errors.some((line) => line.includes('`name` is required')),
    errors.join('\n')
  );
  assert.ok(
    errors.some((line) => line.includes('`github.repository` is required')),
    errors.join('\n')
  );

  const malformed = configErrors({
    ...shipped,
    site: { ...shipped.site, github: { repository: 'not-a-repository' } },
  });
  assert.ok(
    malformed.some((line) => line.includes('form "owner/repo"')),
    malformed.join('\n')
  );
});

test('an invalid schema is refused with the field named', () => {
  const broken = { ...shipped, schema: { ...shipped.schema, fields: [] } };
  const errors = configErrors(broken);
  assert.ok(errors.length > 0);
  assert.ok(
    errors.every((line) => line.startsWith('_data/')),
    'every error says which file to fix'
  );
});

test('a palette that fails contrast is refused here, not on the pull request', () => {
  const errors = configErrors({
    ...shipped,
    theme: { ...shipped.theme, colors: { ...shipped.theme.colors, primary: '#EEEEEE' } },
  });
  assert.ok(
    errors.some((line) => line.startsWith('_data/theme.yml') && /needs \d/.test(line)),
    errors.join('\n')
  );
});

test('exactly the seven configurator-owned files are written, and no others', () => {
  const files = filesFor(ROOT, shipped);
  assert.deepEqual(Object.keys(files).sort(), [
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/new-entry.yml',
    '_config.yml',
    '_data/navigation.yml',
    '_data/schema.yml',
    '_data/site.yml',
    '_data/theme.yml',
  ]);
  for (const relative of Object.keys(files)) {
    assert.ok(
      !path.isAbsolute(relative) && !relative.includes('..'),
      `${relative} stays inside the repository`
    );
  }
});

test('_config.yml is patched, not replaced', () => {
  const files = filesFor(ROOT, shipped);
  const current = fs.readFileSync(path.join(ROOT, '_config.yml'), 'utf8');
  const kept = current
    .split('\n')
    .filter((line) => line.startsWith('plugins:') || line.startsWith('exclude:'));
  assert.ok(kept.length > 0, '_config.yml has build mechanics the wizard does not manage');
  for (const line of kept) assert.ok(files['_config.yml'].includes(line), `${line} survived`);
});

test('the derived files come out of the pasted ones, so they cannot drift', () => {
  const renamed = {
    ...shipped,
    site: {
      ...shipped.site,
      name: 'Rewritten Catalog',
      github: { repository: 'example/community-catalog', branch: 'release/catalog-v2' },
    },
  };
  const files = filesFor(ROOT, renamed);
  assert.match(files['_data/site.yml'], /Rewritten Catalog/);
  assert.match(files['_config.yml'], /Rewritten Catalog/, '_config.yml follows site.yml');
  const chooser = yaml.load(files['.github/ISSUE_TEMPLATE/config.yml']);
  assert.ok(
    chooser.contact_links.some(
      (link) => link.url === 'https://github.com/example/community-catalog/security/advisories/new'
    ),
    'the issue chooser follows site.yml repository identity'
  );
  assert.ok(
    chooser.contact_links.some(
      (link) =>
        link.url === 'https://github.com/example/community-catalog/blob/release/catalog-v2/SECURITY.md'
    ),
    'the issue chooser follows site.yml branch identity'
  );
});
