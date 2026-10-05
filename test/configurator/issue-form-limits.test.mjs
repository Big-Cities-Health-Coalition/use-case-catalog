/**
 * GitHub silently drops an issue form that breaks its limits, and every
 * `?template=` link to it then opens a blank issue. That is how a deployment's
 * submissions started arriving as plain text: six schema fields had help text
 * over 200 characters. These tests pin the generator's fitting (nothing over
 * the limit, nothing lost) and the gate generate.mjs and validate.mjs apply to
 * every form in .github/ISSUE_TEMPLATE/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as jsYaml from 'js-yaml';

import {
  DESCRIPTION_MAX,
  fitHelp,
  issueFormProblems,
  joinSentences,
} from '../../assets/js/configurator/issue-form-limits.js';
import { issueTemplateFromSchema } from '../../assets/js/configurator/issue-template.js';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';
import { presets } from '../../assets/js/configurator/presets.js';
import { renderFiles } from '../../assets/js/configurator/render-files.js';
import { applyAnswers } from '../../assets/js/configurator/answers.js';
import { checkIssueForms, describeIssueFormProblems } from '../../scripts/lib/issue_forms.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const shipped = defaultConfig();

const sentence = (n, words = 12) => `Sentence ${n} ${'word '.repeat(words).trim()}.`;
const LONG_DESCRIPTION = [1, 2, 3, 4, 5].map((n) => sentence(n)).join(' '); // about 340 characters

/** A one-field schema around `field`. */
function schemaWith(field) {
  return {
    entry: { singular: 'Entry' },
    fields: [{ key: 'title', label: 'Title', type: 'text', required: true }, field],
  };
}

const generate = (schema, site = {}) => jsYaml.load(issueTemplateFromSchema(schema, site));

/** The words of some text, to prove a split lost none of them. */
const words = (text) =>
  String(text)
    .replace(/[*:.…]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

test('fitHelp leaves help that fits exactly as the generator always wrote it', () => {
  const parts = [
    { text: 'Short prompt', rank: 1 },
    { text: 'Short description', rank: 2 },
  ];
  assert.deepEqual(fitHelp(parts), {
    text: joinSentences(['Short prompt', 'Short description']),
    overflow: '',
  });
});

test('fitHelp moves the lowest-ranked parts out first, the later of two equals first', () => {
  const prompt = 'p'.repeat(60);
  const description = 'd'.repeat(60);
  const guidance = 'g'.repeat(60);
  const hint = 'h'.repeat(60);
  const result = fitHelp([
    { text: prompt, rank: 1 },
    { text: description, rank: 2 },
    { text: guidance, rank: 0 },
    { text: hint, rank: 0 },
  ]);
  assert.equal(result.text, joinSentences([prompt, description, guidance]));
  assert.equal(result.overflow, joinSentences([hint]));
});

test('fitHelp keeps whole leading sentences of a part too long on its own', () => {
  const result = fitHelp([{ text: LONG_DESCRIPTION }]);
  assert.ok(result.text.length <= DESCRIPTION_MAX, `${result.text.length} characters`);
  assert.match(result.text, /^Sentence 1 .*\.$/);
  assert.match(result.overflow, /^Sentence \d .*Sentence 5 .*\.$/);
  assert.deepEqual(words(`${result.text} ${result.overflow}`), words(LONG_DESCRIPTION));
});

test('fitHelp cuts one enormous sentence at a word, and keeps all of it as overflow', () => {
  const huge = `One ${'enormous '.repeat(40)}sentence`;
  const result = fitHelp([{ text: huge }]);
  assert.ok(result.text.length <= DESCRIPTION_MAX);
  assert.match(result.text, /enormous…$/);
  assert.equal(result.overflow, `${huge}.`);
});

test('an over-long schema description stays under 200, the rest reads just above the control', () => {
  const doc = generate(
    schemaWith({
      key: 'summary',
      label: 'Summary',
      type: 'textarea',
      prompt: 'What does it do?',
      description: LONG_DESCRIPTION,
    })
  );
  assert.deepEqual(issueFormProblems(doc), []);
  const index = doc.body.findIndex((item) => item.id === 'summary');
  const control = doc.body[index];
  const above = doc.body[index - 1];
  assert.ok(control.attributes.description.length <= DESCRIPTION_MAX);
  assert.match(
    control.attributes.description,
    /^Sentence 1 /,
    'the schema description is what stays under the label'
  );
  assert.equal(above.type, 'markdown');
  assert.match(above.attributes.value, /^\*\*Summary:\*\* What does it do\? /);
  assert.deepEqual(
    words(`${control.attributes.description} ${above.attributes.value}`).sort(),
    words(`Summary What does it do? ${LONG_DESCRIPTION}`).sort(),
    'no word of the help text is lost'
  );
});

test('the generator guidance moves out before the prompt or the schema description', () => {
  const doc = generate(
    schemaWith({
      key: 'shots',
      label: 'Screenshots',
      type: 'images',
      prompt: 'Screenshots of it in use',
      description: `${sentence(1, 14)} ${sentence(2, 8)}`,
    })
  );
  const index = doc.body.findIndex((item) => item.id === 'shots');
  assert.match(doc.body[index].attributes.description, /^Screenshots of it in use\. Sentence 1/);
  assert.doesNotMatch(doc.body[index].attributes.description, /Drag images/);
  assert.match(doc.body[index - 1].attributes.value, /^\*\*Screenshots:\*\* Drag images into this box/);
});

test('an over-long submit intro keeps its leading sentences as the form description, the rest opens the form', () => {
  const intro = [1, 2, 3, 4].map((n) => sentence(n, 10)).join(' ');
  assert.ok(intro.length > DESCRIPTION_MAX);
  const doc = generate(shipped.schema, { ...shipped.site, submit: { ...shipped.site.submit, intro } });
  assert.deepEqual(issueFormProblems(doc), []);
  assert.ok(doc.description.length <= DESCRIPTION_MAX, `${doc.description.length} characters`);
  assert.ok(intro.startsWith(doc.description));
  assert.equal(doc.body[0].type, 'markdown');
  assert.equal(`${doc.description} ${doc.body[0].attributes.value}`, intro);
});

test('a submit intro that fits is still used verbatim', () => {
  const doc = generate(shipped.schema, shipped.site);
  assert.equal(doc.description, shipped.site.submit.intro);
});

for (const preset of presets) {
  test(`${preset.id}: the generated new-entry form is within GitHub's limits`, () => {
    const files = renderFiles(applyAnswers(preset.config, {}), { url: '', baseurl: '' });
    const form = jsYaml.load(files['.github/ISSUE_TEMPLATE/new-entry.yml']);
    assert.deepEqual(issueFormProblems(form), []);
  });
}

test("every committed issue form is within GitHub's limits", () => {
  assert.equal(describeIssueFormProblems(checkIssueForms(ROOT)), '');
});

test('issueFormProblems names each broken rule and where it is', () => {
  const ok = { type: 'input', id: 'a', attributes: { label: 'A', description: 'x'.repeat(200) } };
  assert.deepEqual(issueFormProblems({ name: 'Good form', description: 'Fine.', body: [ok] }), []);

  const problems = issueFormProblems({
    name: 'Bug',
    description: 'd'.repeat(201),
    body: [
      { type: 'markdown', attributes: { value: 'Intro' } },
      { type: 'input', id: 'a', attributes: { label: 'A', description: 'x'.repeat(201) } },
      { type: 'textarea', id: 'a', attributes: { label: '' } },
      { type: 'dropdown', id: 'bad id', attributes: { label: 'Pick', options: [] } },
      { type: 'textarea', id: 'b', attributes: { label: 'B', description: 'no' } },
    ],
  });
  assert.deepEqual(
    problems.map((p) => p.path),
    [
      'name',
      'description',
      'body[1] (a).attributes.description',
      'body[2] (a).id',
      'body[2] (a).attributes.label',
      'body[3] (bad id).id',
      'body[3] (bad id).attributes.options',
      'body[4] (b).attributes.description',
    ]
  );
  assert.match(problems[1].message, /is 201 characters; GitHub needs 3 to 200/);
  assert.deepEqual(
    issueFormProblems({
      name: 'Only words',
      description: 'Fine.',
      body: [{ type: 'markdown', attributes: { value: 'Hi' } }],
    }),
    [{ path: 'body', message: 'needs at least one element that is not markdown.' }]
  );
});

/** A throwaway copy of what generate.mjs reads, sharing this checkout's node_modules. */
function scratchRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-form-limits-'));
  for (const dir of ['_data', '_includes', 'scripts', 'assets/js/configurator', '.github/ISSUE_TEMPLATE']) {
    fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, '_config.yml'), path.join(root, '_config.yml'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

test('npm run generate refuses to go on while any issue form breaks the limits, naming the field', (t) => {
  const root = scratchRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/generate.mjs', ...args], { cwd: root, encoding: 'utf8' });

  assert.equal(run('--check').status, 0, 'the copy starts in sync');

  const bug = path.join(root, '.github/ISSUE_TEMPLATE/bug.yml');
  const form = jsYaml.load(fs.readFileSync(bug, 'utf8'));
  form.body.find((item) => item.type !== 'markdown').attributes.description = 'Too long. '.repeat(25);
  fs.writeFileSync(bug, jsYaml.dump(form));

  for (const args of [['--check'], []]) {
    const result = run(...args);
    assert.equal(result.status, 1, `generate ${args.join(' ')} exits 1`);
    assert.match(result.stderr, /GitHub would reject these issue forms/);
    assert.match(
      result.stderr,
      /\.github\/ISSUE_TEMPLATE\/bug\.yml\n {2}• body\[\d+\] \([\w-]+\)\.attributes\.description is 250 characters/
    );
  }
});
