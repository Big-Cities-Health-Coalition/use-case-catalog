import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsYaml from 'js-yaml';

import { issueTemplateFromSchema, groupedFormFields } from '../../assets/js/configurator/issue-template.js';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';
import { FIELD_TYPES } from '../../assets/js/configurator/schema-validate.js';
import '../../assets/js/configurator/issue-form-ids.js';

const { issueFormId } = globalThis.PHCTIssueForm;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/new-entry.yml';

// `shipped` is whatever this repository's _data/ holds: the template's own
// configuration here, a deployment's in a copy. Tests against it must not name
// a field key or rely on one existing; they iterate the schema, or find a field
// by type. Behaviour that needs a particular field uses a small schema below.
const shipped = defaultConfig();

/** The form's controls by element id. */
const controlsOf = (doc) => new Map(doc.body.filter((item) => item.id).map((item) => [item.id, item]));

/** The fields the issue form asks, in the live schema. */
const formFields = (schema = shipped.schema) => schema.fields.filter((field) => field.form !== false);

/** The control each schema type becomes. */
const CONTROL_FOR_TYPE = {
  text: 'input',
  url: 'input',
  email: 'input',
  date: 'input',
  number: 'input',
  textarea: 'textarea',
  markdown: 'textarea',
  list: 'textarea',
  images: 'textarea',
  links: 'textarea',
  select: 'dropdown',
  multiselect: 'dropdown',
  boolean: 'dropdown',
  file: 'upload',
  image: 'upload',
};

/** One field of every schema type, each with options or a filename where it needs one. */
const EVERY_TYPE = {
  entry: { singular: 'Entry' },
  fields: FIELD_TYPES.map((type) => ({
    key: type === 'text' ? 'title' : `a_${type}`,
    label: `A ${type}`,
    type,
    required: type === 'select' || type === 'multiselect',
    ...(type === 'select' || type === 'multiselect' ? { options: ['One', 'Two, with a comma'] } : {}),
    ...(type === 'file' ? { filename: 'deck.pdf' } : {}),
  })),
};

/** The generated template, parsed. */
function generate(schema = shipped.schema, site = shipped.site) {
  return jsYaml.load(issueTemplateFromSchema(schema, site));
}

/**
 * All the help a control shows: its description, plus the markdown element just
 * above it that carries whatever did not fit GitHub's 200-character limit
 * (see test/configurator/issue-form-limits.test.mjs).
 */
function helpFor(doc, id) {
  const index = doc.body.findIndex((item) => item.id === id);
  const control = doc.body[index];
  const above = doc.body[index - 1];
  const overflow =
    above?.type === 'markdown' &&
    String(above.attributes.value).startsWith(`**${control.attributes.label}:** `)
      ? String(above.attributes.value).slice(`**${control.attributes.label}:** `.length)
      : '';
  return [control.attributes.description ?? '', overflow].filter(Boolean).join(' ');
}

test('the committed issue template matches what the schema generates', () => {
  const committed = fs.readFileSync(path.join(ROOT, TEMPLATE_PATH), 'utf8');
  assert.equal(
    issueTemplateFromSchema(shipped.schema, shipped.site),
    committed,
    `${TEMPLATE_PATH} is stale. Run \`npm run generate\` and commit the result.`
  );
});

test('the template keeps its GitHub top-level keys', () => {
  assert.deepEqual(Object.keys(generate()), ['name', 'description', 'title', 'labels', 'body']);
  const doc = generate(
    { ...EVERY_TYPE, entry: { singular: 'Use case' } },
    { submit: { intro: 'Share what you built.' } }
  );
  assert.equal(doc.name, 'Submit a use case (creates PR)');
  assert.equal(doc.title, '[Use case] ');
  assert.deepEqual(doc.labels, ['content:new-entry']);
  assert.equal(doc.description, 'Share what you built.');
});

test('the header names the generator and forbids hand-editing', () => {
  const text = issueTemplateFromSchema(shipped.schema, shipped.site);
  assert.match(text, /^# GitHub issue form for new entries\./);
  assert.match(text, /Generated from _data\/schema\.yml by scripts\/generate\.mjs — do not hand-edit\./);
});

test('every field becomes one control, under its issue-form id, keeping its label', () => {
  const controls = controlsOf(generate());
  for (const field of formFields()) {
    const id = issueFormId(field.key);
    assert.ok(controls.has(id), `${field.key} has a control (id ${id})`);
    assert.equal(controls.get(id).attributes.label, field.label, `${field.key} keeps its label verbatim`);
  }
});

test('a key GitHub reads as its own parameter gets an entry_ id; every other key is its own id', () => {
  // GitHub's new-issue page takes ?body= as the plain issue body and ?title= as
  // the issue title, so a question with either id is never prefilled.
  const doc = jsYaml.load(
    issueTemplateFromSchema({
      entry: { singular: 'Entry' },
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'body', label: 'Write-up', type: 'markdown' },
        { key: 'write_up', label: 'Notes', type: 'markdown' },
        { key: 'labels', label: 'Tags', type: 'list' },
      ],
    })
  );
  const ids = doc.body.filter((item) => item.id).map((item) => item.id);
  assert.deepEqual(ids, ['entry_title', 'entry_body', 'write_up', 'entry_labels']);
  for (const key of ['title', 'body', 'labels', 'assignees', 'milestone', 'projects', 'template']) {
    assert.equal(issueFormId(key), `entry_${key}`);
  }
  assert.equal(issueFormId('summary'), 'summary');
});

test('types map to the right GitHub controls', () => {
  const controls = controlsOf(jsYaml.load(issueTemplateFromSchema(EVERY_TYPE)));
  for (const field of EVERY_TYPE.fields) {
    assert.equal(
      controls.get(issueFormId(field.key)).type,
      CONTROL_FOR_TYPE[field.type],
      `${field.type} control`
    );
  }
  assert.equal(controls.get('a_multiselect').attributes.multiple, true, 'multiselect dropdowns are multiple');
  assert.equal(controls.get('a_select').attributes.multiple, undefined);
  assert.deepEqual(controls.get('a_boolean').attributes.options, ['Yes', 'No']);
});

test('the live schema maps every field type the same way', () => {
  const controls = controlsOf(generate());
  for (const field of formFields()) {
    assert.equal(
      controls.get(issueFormId(field.key)).type,
      CONTROL_FOR_TYPE[field.type],
      `${field.key} (${field.type})`
    );
  }
});

test('options are copied verbatim for both kinds of dropdown', () => {
  const controls = controlsOf(generate());
  for (const field of formFields().filter((f) => f.type === 'select' || f.type === 'multiselect')) {
    // Plain strings, not `{label}` objects: that shape belongs to `checkboxes`,
    // which this generator no longer emits.
    assert.deepEqual(
      controls.get(issueFormId(field.key)).attributes.options,
      field.options.map(String),
      field.key
    );
  }
});

test('an option label containing a comma survives verbatim', () => {
  const controls = controlsOf(jsYaml.load(issueTemplateFromSchema(EVERY_TYPE)));
  for (const id of ['a_select', 'a_multiselect']) {
    assert.ok(
      controls.get(id).attributes.options.includes('Two, with a comma'),
      `${id}: the comma is not split or escaped`
    );
  }
});

test('required is set from the schema on every control, multi-selects included', () => {
  const controls = controlsOf(generate());
  for (const field of formFields()) {
    const control = controls.get(issueFormId(field.key));
    assert.equal(control.validations.required, field.required === true, `${field.key} required`);
    // A multi-select dropdown can be required; the `checkboxes` control it
    // replaced could not, and used to fake it with a line of description text.
    assert.doesNotMatch(String(control.attributes.description ?? ''), /Required — choose at least one/);
  }
  const multi = controlsOf(jsYaml.load(issueTemplateFromSchema(EVERY_TYPE))).get('a_multiselect');
  assert.equal(multi.validations.required, true);
});

test('prompt comes before description in the help text', () => {
  const field = {
    key: 'summary',
    label: 'Summary',
    type: 'textarea',
    prompt: 'What does it do',
    description: 'Two sentences.',
  };
  const doc = jsYaml.load(
    issueTemplateFromSchema({
      entry: { singular: 'Entry' },
      fields: [{ key: 'title', label: 'Title', type: 'text' }, field],
    })
  );
  const summary = controlsOf(doc).get('summary');
  assert.ok(summary.attributes.description.startsWith(field.prompt), 'prompt first');
  assert.ok(summary.attributes.description.includes(field.description), 'description second');
});

test('images and links controls explain their line format', () => {
  const doc = jsYaml.load(issueTemplateFromSchema(EVERY_TYPE));
  assert.match(helpFor(doc, 'a_images'), /one image URL per line/i);
  assert.match(helpFor(doc, 'a_images'), /alt text/i);
  assert.match(helpFor(doc, 'a_links'), /`Label \| URL`/);
});

test('groups become markdown separators in schema order', () => {
  const doc = generate();
  const headings = doc.body
    .filter((item) => item.type === 'markdown' && String(item.attributes.value).startsWith('### '))
    .map((item) => String(item.attributes.value).split('\n')[0].replace('### ', ''));
  assert.deepEqual(
    headings,
    shipped.schema.groups.map((group) => group.title)
  );
});

test('fields are ordered by weight inside their group', () => {
  const sections = groupedFormFields(shipped.schema);
  for (const section of sections) {
    const weights = section.fields.map((field) => field.weight ?? 5);
    assert.deepEqual(
      [...weights].sort((a, b) => a - b),
      weights,
      `${section.group.key} is weight-ordered`
    );
  }
});

test('ungrouped fields land in a trailing "More" group', () => {
  const sections = groupedFormFields({
    groups: [{ key: 'about', title: 'About' }],
    fields: [
      { key: 'title', label: 'Title', type: 'text', group: 'about' },
      { key: 'stray', label: 'Stray', type: 'text' },
    ],
  });
  assert.deepEqual(
    sections.map((s) => s.group.key),
    ['about', 'other']
  );
  assert.equal(sections[1].group.title, 'More');
});

test('a file field is a real upload control that accepts its own extension', () => {
  const doc = jsYaml.load(issueTemplateFromSchema(EVERY_TYPE));
  const deck = controlsOf(doc).get('a_file');
  assert.ok(deck, 'the file field is a control, not a paragraph telling someone to do it later');
  assert.equal(deck.type, 'upload');
  assert.equal(deck.validations.accept, '.pdf', 'accept comes from the schema `filename`');
  assert.equal(deck.validations.required, false);
  assert.equal(deck.attributes.placeholder, undefined, 'an upload has nothing to prefill');
  assert.equal(
    doc.body.some(
      (item) => item.type === 'markdown' && /cannot accept file uploads/i.test(String(item.attributes.value))
    ),
    false,
    'the old "GitHub cannot do this" instruction is gone'
  );
});

test('a file field points past-the-cap files at the first links field the form asks', () => {
  const doc = jsYaml.load(issueTemplateFromSchema(EVERY_TYPE));
  const linksField = EVERY_TYPE.fields.find((field) => field.type === 'links');
  const deckHelp = helpFor(doc, 'a_file');
  assert.ok(
    deckHelp.endsWith(
      `Over 25 MB, or kept in a shared workspace? Paste a link in “${linksField.label}” instead.`
    ),
    deckHelp
  );

  // A links field the form never shows is no place to send anyone, and a
  // schema without one gets no sentence at all.
  const schemaFor = (extra) => ({
    entry: { singular: 'Entry' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'deck', label: 'Deck', type: 'file', filename: 'deck.pdf' },
      ...extra,
    ],
  });
  for (const extra of [[], [{ key: 'adopters', label: 'Adopters', type: 'links', form: false }]]) {
    const upload = jsYaml
      .load(issueTemplateFromSchema(schemaFor(extra)))
      .body.find((item) => item.id === 'deck');
    assert.doesNotMatch(upload.attributes.description, /25 MB/);
  }
  const custom = jsYaml
    .load(issueTemplateFromSchema(schemaFor([{ key: 'more', label: 'More links', type: 'links' }])))
    .body.find((item) => item.id === 'deck');
  assert.match(custom.attributes.description, /Paste a link in “More links” instead\.$/);
});

test('an image field uploads, an images gallery stays a textarea', () => {
  const doc = jsYaml.load(
    issueTemplateFromSchema({
      entry: { singular: 'Entry' },
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'cover', label: 'Cover image', type: 'image', required: true },
        { key: 'shots', label: 'Screenshots', type: 'images' },
      ],
    })
  );
  const byId = new Map(doc.body.filter((item) => item.id).map((item) => [item.id, item]));
  assert.equal(byId.get('cover').type, 'upload');
  assert.equal(byId.get('cover').validations.accept, '.png,.jpg,.jpeg,.gif,.webp');
  assert.equal(byId.get('cover').validations.required, true);
  // `upload` holds one file and has no per-file alt text, so a gallery keeps
  // the textarea it drags images into.
  assert.equal(byId.get('shots').type, 'textarea');
});

test('form: false fields are left out entirely', () => {
  const schema = {
    groups: [{ key: 'about', title: 'About' }],
    entry: { singular: 'Entry' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', group: 'about', required: true },
      { key: 'internal', label: 'Internal note', type: 'text', group: 'about', form: false },
    ],
  };
  const doc = jsYaml.load(issueTemplateFromSchema(schema));
  assert.equal(
    doc.body.some((item) => item.id === 'internal'),
    false
  );
});

test('a schema with no title field gets one synthesised', () => {
  const doc = jsYaml.load(
    issueTemplateFromSchema({
      entry: { singular: 'Resource' },
      fields: [{ key: 'note', label: 'Note', type: 'text' }],
    })
  );
  const title = doc.body.find((item) => item.id === issueFormId('title'));
  assert.ok(title, 'a title input is always present');
  assert.equal(title.id, 'entry_title', 'under the same id a schema `title` field would get');
  assert.equal(title.validations.required, true);
});

test('a single group does not get a redundant separator', () => {
  const doc = jsYaml.load(
    issueTemplateFromSchema({
      groups: [{ key: 'about', title: 'About' }],
      fields: [{ key: 'title', label: 'Title', type: 'text', group: 'about', required: true }],
    })
  );
  assert.equal(
    doc.body.some((item) => item.type === 'markdown'),
    false
  );
});
