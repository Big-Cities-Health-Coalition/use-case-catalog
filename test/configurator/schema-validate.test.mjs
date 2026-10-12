import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkSchema,
  validateSchema,
  sortByWeight,
  overlapWarning,
  OPTION_TONES,
} from '../../assets/js/configurator/schema-validate.js';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';

/** A minimal valid schema; `overrides` are merged over it. */
function schemaWith(fields, overrides = {}) {
  return {
    entry: { singular: 'Entry', plural: 'Entries', path: 'catalog', sort: 'published', sort_order: 'desc' },
    groups: [{ key: 'about', title: 'About' }],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, group: 'about' },
      { key: 'summary', label: 'Summary', type: 'textarea', required: true, group: 'about' },
      ...fields,
    ],
    ...overrides,
  };
}

/** All error messages for a schema, as one searchable string. */
function errorText(schema) {
  return checkSchema(schema)
    .errors.map((e) => `${e.path} ${e.message}`)
    .join('\n');
}

test('the shipped schema is valid', () => {
  const result = checkSchema(defaultConfig().schema);
  assert.equal(result.ok, true, errorText(defaultConfig().schema));
});

test('accepts the v2 field types', () => {
  const schema = schemaWith([
    { key: 'shots', label: 'Screenshots', type: 'images', group: 'about' },
    { key: 'refs', label: 'Other links', type: 'links', group: 'about' },
  ]);
  assert.equal(checkSchema(schema).ok, true, errorText(schema));
});

test('rejects unknown types, bad keys, duplicate keys and duplicate labels', () => {
  assert.match(errorText(schemaWith([{ key: 'x', label: 'X', type: 'rainbow' }])), /Unknown type/);
  assert.match(errorText(schemaWith([{ key: 'Bad Key', label: 'X', type: 'text' }])), /snake_case/);
  assert.match(
    errorText(schemaWith([{ key: 'title', label: 'Repeat', type: 'text' }])),
    /already used by field 1/
  );
  assert.match(
    errorText(schemaWith([{ key: 'other', label: 'Title', type: 'text' }])),
    /labels identify answers/
  );
});

test('rejects site-managed keys as fields', () => {
  for (const key of ['slug', 'published', 'updated', 'featured', 'thumbnail', 'layout']) {
    assert.match(
      errorText(schemaWith([{ key, label: `Field ${key}`, type: 'text' }])),
      /managed by the site/,
      key
    );
  }
});

test('select and multiselect need options; images and links must not have them', () => {
  assert.match(
    errorText(schemaWith([{ key: 'pick', label: 'Pick', type: 'select', options: [] }])),
    /at least one option/
  );
  assert.match(
    errorText(schemaWith([{ key: 'pick', label: 'Pick', type: 'multiselect' }])),
    /at least one option/
  );
  assert.match(
    errorText(schemaWith([{ key: 'shots', label: 'Shots', type: 'images', options: ['a'] }])),
    /no fixed choices/
  );
  assert.match(
    errorText(schemaWith([{ key: 'pick', label: 'Pick', type: 'select', options: ['a', 'a'] }])),
    /must be unique/
  );
});

test('option_meta keys must be options, with a known tone', () => {
  const stray = schemaWith([
    { key: 'pick', label: 'Pick', type: 'select', options: ['A'], option_meta: { B: { short: 'B' } } },
  ]);
  assert.match(errorText(stray), /not one of this field's `options`/);

  const badTone = schemaWith([
    { key: 'pick', label: 'Pick', type: 'select', options: ['A'], option_meta: { A: { tone: 'danger' } } },
  ]);
  assert.match(errorText(badTone), /`tone` must be one of/);

  const longShort = schemaWith([
    {
      key: 'pick',
      label: 'Pick',
      type: 'select',
      options: ['A'],
      option_meta: { A: { short: 'A rather long label' } },
    },
  ]);
  const result = checkSchema(longShort);
  assert.equal(result.ok, true);
  assert.match(result.warnings.map((w) => w.message).join('\n'), /fits a chip/);
});

test('card slots only fit compatible types', () => {
  const ok = schemaWith([
    { key: 'stage', label: 'Stage', type: 'select', options: ['A'], card: 'badge' },
    { key: 'tags', label: 'Tags', type: 'list', card: 'chip' },
    { key: 'skills', label: 'Skills', type: 'multiselect', options: ['A'], card: 'icon' },
    { key: 'impact', label: 'Impact', type: 'text', card: 'line' },
    { key: 'org', label: 'Org', type: 'text', card: 'meta' },
    { key: 'legacy', label: 'Legacy', type: 'text', card: true },
  ]);
  assert.equal(checkSchema(ok).ok, true, errorText(ok));

  assert.match(
    errorText(schemaWith([{ key: 'tags', label: 'Tags', type: 'list', card: 'badge' }])),
    /does not fit a list/
  );
  assert.match(
    errorText(schemaWith([{ key: 'org', label: 'Org', type: 'text', card: 'chip' }])),
    /does not fit a text/
  );
  assert.match(
    errorText(schemaWith([{ key: 'when', label: 'When', type: 'date', card: 'icon' }])),
    /does not fit a date/
  );
  assert.match(
    errorText(schemaWith([{ key: 'org', label: 'Org', type: 'text', card: 'sidebar' }])),
    /`card` must be/
  );
});

test('at most one field may claim the card line', () => {
  const schema = schemaWith([
    { key: 'impact', label: 'Impact', type: 'text', card: 'line' },
    { key: 'result', label: 'Result', type: 'text', card: 'line' },
  ]);
  assert.match(errorText(schema), /Only one field may use `card: line`/);
});

test('at most one field may be markdown', () => {
  const schema = schemaWith([
    { key: 'body', label: 'Body', type: 'markdown' },
    { key: 'notes', label: 'Notes', type: 'markdown' },
  ]);
  assert.match(errorText(schema), /Only one field may be `markdown`/);
});

test('weight must be a whole number from 1 to 9', () => {
  assert.equal(checkSchema(schemaWith([{ key: 'a', label: 'A', type: 'text', weight: 9 }])).ok, true);
  assert.match(errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', weight: 0 }])), /between 1 and 9/);
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', weight: 10 }])),
    /between 1 and 9/
  );
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', weight: 2.5 }])),
    /between 1 and 9/
  );
});

test('group must be declared under groups', () => {
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', group: 'nowhere' }])),
    /not declared under/
  );
  assert.equal(checkSchema(schemaWith([{ key: 'a', label: 'A', type: 'text', group: 'about' }])).ok, true);
});

test('groups need unique keys and a title', () => {
  const dupe = schemaWith([], {
    groups: [
      { key: 'about', title: 'About' },
      { key: 'about', title: 'Again' },
    ],
  });
  assert.match(errorText(dupe), /used by more than one group/);
  const untitled = schemaWith([], { groups: [{ key: 'about' }] });
  assert.match(errorText(untitled), /needs a `title`/);
});

test('group placement is optional, takes main|rail, and only warns when unknown', () => {
  assert.equal(checkSchema(schemaWith([], { groups: [{ key: 'about', title: 'About' }] })).ok, true);
  for (const placement of ['main', 'rail']) {
    const schema = schemaWith([], { groups: [{ key: 'about', title: 'About', placement }] });
    const result = checkSchema(schema);
    assert.equal(result.ok, true, errorText(schema));
    assert.equal(result.warnings.length, 0, `${placement} is silent`);
  }
  const odd = checkSchema(
    schemaWith([], { groups: [{ key: 'about', title: 'About', placement: 'sidebar' }] })
  );
  assert.equal(odd.ok, true, 'an unknown placement is not fatal');
  assert.match(odd.warnings.map((w) => `${w.path} ${w.message}`).join('\n'), /placement.*main, rail/s);
});

test('facet only applies to filterable types, thumbnail only to files', () => {
  assert.match(
    errorText(schemaWith([{ key: 'shots', label: 'Shots', type: 'images', facet: true }])),
    /cannot be a filter/
  );
  assert.match(
    errorText(schemaWith([{ key: 'when', label: 'When', type: 'date', facet: true }])),
    /cannot be a filter/
  );
  assert.equal(checkSchema(schemaWith([{ key: 'tags', label: 'Tags', type: 'list', facet: true }])).ok, true);
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', thumbnail: true }])),
    /only applies to `file` fields/
  );
});

test('file fields need a filename', () => {
  assert.match(errorText(schemaWith([{ key: 'deck', label: 'Deck', type: 'file' }])), /needs a `filename`/);
});

test('search, facet and form must be booleans; prompt and icon must be strings', () => {
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', search: 'yes' }])),
    /`search` must be true or false/
  );
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', form: 'no' }])),
    /`form` must be true or false/
  );
  assert.match(
    errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', prompt: '  ' }])),
    /`prompt` must be/
  );
  assert.match(errorText(schemaWith([{ key: 'a', label: 'A', type: 'text', icon: 42 }])), /`icon` must be/);
});

test('warns about an icon name the site cannot render', () => {
  const result = checkSchema(schemaWith([{ key: 'a', label: 'A', type: 'text', icon: 'unicorn' }]));
  assert.equal(result.ok, true);
  assert.match(result.warnings.map((w) => w.message).join('\n'), /not in _includes\/icon\.html/);
});

test('validates the entry block', () => {
  assert.match(errorText(schemaWith([], { entry: { path: 'Catalog Folder' } })), /lowercase URL segment/);
  assert.match(errorText(schemaWith([], { entry: { sort_order: 'sideways' } })), /`asc` or `desc`/);
  assert.match(errorText(schemaWith([], { entry: 'nope' })), /`entry` must be a mapping/);
});

test('rejects a schema with no fields at all', () => {
  assert.match(errorText({ fields: [] }), /`fields` is empty/);
  assert.match(errorText({}), /`fields` must be a list/);
  assert.match(errorText(null), /must be a mapping/);
});

test('validateSchema keeps returning flat strings for the wizards', () => {
  const errors = validateSchema({ fields: [{ key: 'x', label: 'X', type: 'rainbow' }] });
  assert.ok(Array.isArray(errors));
  assert.equal(typeof errors[0], 'string');
  assert.match(errors[0], /fields\[0\]\.type: Unknown type/);
  assert.deepEqual(validateSchema(defaultConfig().schema), []);
});

test('sortByWeight is stable and defaults to 5', () => {
  const fields = [
    { key: 'a', weight: 5 },
    { key: 'b' },
    { key: 'c', weight: 1 },
    { key: 'd', weight: 9 },
    { key: 'e', weight: 1 },
  ];
  assert.deepEqual(
    sortByWeight(fields).map((f) => f.key),
    ['c', 'e', 'a', 'b', 'd']
  );
  assert.deepEqual(
    fields.map((f) => f.key),
    ['a', 'b', 'c', 'd', 'e'],
    'the input array is not mutated'
  );
});

/* --- Tones ---------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every tone the schema accepts has a matching badge class in the CSS', () => {
  const dir = path.join(ROOT, 'assets', 'css', 'components');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')) : [];
  // A fork that restyles from scratch has no components/ to check against; the
  // list is still the contract, there is just nothing to compare it to.
  if (files.length === 0) return;

  const css = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  // A tone is `.badge[data-tone="…"]` and nothing else — the composed
  // `.badge-<tone>` aliases are gone, including from the /setup/ preview.
  const styled = new Set([...css.matchAll(/\.badge\[data-tone="([a-z-]+)"/g)].map((m) => m[1]));

  // One direction only: a tone with no rule renders as an unstyled pill (the
  // base class still lands), which is the failure worth catching. The reverse
  // would flag nothing useful — the table may carry a tone the schema has
  // retired.
  assert.deepEqual(
    OPTION_TONES.filter((tone) => !styled.has(tone)),
    [],
    'schema-validate.js accepts a tone that assets/css/components has no `.badge[data-tone]` rule for'
  );
});

/* --- prompt / description overlap ----------------------------------------- */

test('overlapWarning finds a repeated run of four words, ignoring case and punctuation', () => {
  assert.equal(
    overlapWarning({
      prompt: 'Which organization is sharing this?',
      description: 'The organization sharing this entry, as it should be credited.',
    }),
    null,
    'a description that continues the prompt is not a stutter'
  );
  assert.equal(
    overlapWarning({
      prompt: 'Which organization is sharing this work?',
      description: 'Name the organization "is sharing" — the organization is sharing this work.',
    }),
    'organization is sharing this'
  );
  // Three shared words is a normal amount of shared vocabulary.
  assert.equal(
    overlapWarning({ prompt: 'What problem does it solve?', description: 'The problem it solves.' }),
    null
  );
  assert.equal(overlapWarning({ prompt: 'Anything at all?' }), null, 'no description is not a stutter');
  assert.equal(overlapWarning({}), null);
});

test('an overlapping description warns rather than failing the schema', () => {
  const schema = schemaWith([
    {
      key: 'owner',
      label: 'Owner',
      type: 'text',
      group: 'about',
      prompt: 'Who owns this work day to day?',
      description: 'Say who owns this work day to day, by role.',
    },
  ]);
  const result = checkSchema(schema);
  assert.equal(result.ok, true, errorText(schema));
  assert.match(result.warnings.map((w) => w.message).join('\n'), /repeats "who owns this work"/);
});

test('the shipped schema has no prompt/description stutter', () => {
  const fields = defaultConfig().schema.fields ?? [];
  assert.deepEqual(
    fields.filter((field) => overlapWarning(field)).map((field) => field.key),
    []
  );
});

test('a key GitHub reserves is fine on its own: the issue form gives it an entry_ id', () => {
  for (const key of ['body', 'labels', 'assignees', 'milestone', 'projects', 'template']) {
    const result = checkSchema(
      schemaWith([{ key, label: `Field ${key}`, type: 'textarea', group: 'about' }])
    );
    assert.equal(result.ok, true, key);
    assert.deepEqual(
      result.warnings.filter((w) => w.path === 'fields[2].key'),
      [],
      `${key} needs no rename now that the form remaps it`
    );
  }
});

test("a key that repeats a reserved key's issue-form id is an error", () => {
  const clash = checkSchema(
    schemaWith([
      { key: 'body', label: 'Write-up', type: 'markdown', group: 'about' },
      { key: 'entry_body', label: 'Another', type: 'textarea', group: 'about' },
    ])
  );
  assert.equal(clash.ok, false);
  assert.deepEqual(
    clash.errors.map((e) => e.path),
    ['fields[3].key']
  );
  assert.match(clash.errors[0].message, /share the issue-form id "entry_body" with field 3/);

  // A field the form never asks has no id to collide with.
  const hidden = checkSchema(
    schemaWith([
      { key: 'body', label: 'Write-up', type: 'markdown', group: 'about', form: false },
      { key: 'entry_body', label: 'Another', type: 'textarea', group: 'about' },
    ])
  );
  assert.equal(hidden.ok, true);
});

test('entry_title clashes with the Title question the form adds when there is no title field', () => {
  const schema = schemaWith([{ key: 'entry_title', label: 'Name', type: 'text', group: 'about' }]);
  schema.fields = schema.fields.filter((field) => field.key !== 'title');
  const result = checkSchema(schema);
  assert.deepEqual(
    result.errors.filter((e) => /entry_title/.test(e.message)).map((e) => e.path),
    ['fields[1].key']
  );
  assert.equal(
    checkSchema(schemaWith([{ key: 'entry_title', label: 'Name', type: 'text', group: 'about' }])).ok,
    false
  );
});
