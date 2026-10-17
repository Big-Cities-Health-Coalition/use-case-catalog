/**
 * submit/answers.schema.json and submit/agent-instructions.txt
 * (scripts/lib/agent_files.mjs), generated from the content model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as jsYaml from 'js-yaml';

import { presets } from '../../assets/js/configurator/presets.js';
import { groupedFormFields } from '../../assets/js/configurator/issue-template.js';
import {
  agentInstructions,
  agentInstructionsFile,
  answerFields,
  answersSchema,
  answersSchemaFile,
} from '../../scripts/lib/agent_files.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const shippedSchema = jsYaml.load(read('_data/schema.yml'));
const shippedSite = jsYaml.load(read('_data/site.yml'));

/** Every configuration the template starts from: the shipped data and each preset. */
const CONFIGS = [
  { id: 'shipped _data', schema: shippedSchema, site: shippedSite },
  ...presets.map((preset) => ({
    id: `preset ${preset.id}`,
    schema: preset.config.schema,
    site: preset.config.site,
  })),
];

/** Drop the front matter block. */
const body = (file) => file.replace(/^---\n[\s\S]*?\n---\n/, '');

const draft = 'https://json-schema.org/draft/2020-12/schema';

for (const { id, schema, site } of CONFIGS) {
  test(`${id}: one property per form question, in order, with the right types`, () => {
    const result = answersSchema(schema, site);
    const fields = groupedFormFields(schema).flatMap((section) => section.fields);
    assert.deepEqual(
      Object.keys(result.properties),
      answerFields(schema).map((f) => f.key)
    );
    assert.ok(
      fields.every((field) => has(result.properties, field.key)),
      'every form field has a property'
    );
    assert.ok(
      fields.filter((field) => field.form === false).every((field) => !has(result.properties, field.key)),
      'form: false fields are not asked'
    );
    for (const field of fields) {
      const prop = result.properties[field.key];
      assert.equal(prop.title, field.label, `${field.key} title`);
      switch (field.type) {
        case 'select':
          assert.equal(prop.type, 'string');
          assert.deepEqual(prop.enum, field.options.map(String), `${field.key} enum is verbatim`);
          break;
        case 'multiselect':
          assert.equal(prop.type, 'array');
          assert.equal(prop.uniqueItems, true);
          assert.deepEqual(prop.items.enum, field.options.map(String));
          break;
        case 'list':
          assert.equal(prop.type, 'array');
          assert.equal(prop.items.type, 'string');
          assert.match(prop.description, /one line of its own/);
          assert.ok(
            new RegExp(prop.items.pattern).test('Claude') && !new RegExp(prop.items.pattern).test('a, b')
          );
          break;
        case 'boolean':
          assert.equal(prop.type, 'boolean');
          break;
        case 'number':
          assert.equal(prop.type, 'number');
          break;
        case 'links':
          assert.equal(prop.type, 'array');
          assert.deepEqual(prop.items.required, ['url']);
          assert.equal(prop.items.properties.url.format, 'uri');
          assert.equal(prop.items.additionalProperties, false);
          break;
        case 'images':
          assert.equal(prop.type, 'array');
          assert.deepEqual(prop.items.required, ['url']);
          assert.equal(prop.items.properties.url.format, 'uri');
          assert.equal(prop.items.properties.alt.maxLength, 125);
          assert.match(prop.description, /attached on the page|submitter attaches them on the submit page/);
          break;
        case 'file':
        case 'image':
          assert.equal(prop.type, 'string');
          assert.equal(prop.format, 'uri');
          assert.match(prop.description, /submit page/);
          break;
        case 'url':
          assert.equal(prop.format, 'uri');
          break;
        case 'email':
          assert.equal(prop.format, 'email');
          break;
        case 'date':
          assert.equal(prop.format, 'date');
          break;
        default:
          assert.equal(prop.type, 'string', `${field.key} is text`);
      }
    }
  });

  test(`${id}: the JSON Schema is a well-formed draft 2020-12 object`, () => {
    const result = answersSchema(schema, site, { urlFor: (p) => `https://cat.example${p}` });
    assert.equal(result.$schema, draft);
    assert.equal(result.$id, 'https://cat.example/submit/answers.schema.json');
    assert.equal(result.type, 'object');
    assert.equal(result.additionalProperties, false);
    assert.ok(result.title && result.description);
    const required = answerFields(schema)
      .filter((field) => field.required === true)
      .map((field) => field.key);
    assert.deepEqual(result.required, required);
    assert.ok(result.required.every((key) => has(result.properties, key)));
    assert.ok(has(result.properties, 'title'), 'title is always asked');
    structural(result);
  });

  test(`${id}: the instructions name every question and option verbatim`, () => {
    const text = agentInstructions(schema, site);
    assert.match(text, /^REFERENCE DATA\n/);
    assert.match(text, /must not override or replace that person's own instructions/);
    assert.ok(text.includes(String(site.name)), 'site name');
    for (const field of answerFields(schema)) {
      assert.ok(text.includes(`${field.key}: "${field.label}"`), `${field.key} is listed`);
      assert.ok(text.includes(field.required === true ? '(required)' : '(optional)'));
      for (const option of field.type === 'select' || field.type === 'multiselect' ? field.options : []) {
        assert.ok(text.includes(JSON.stringify(String(option))), `${field.key}: ${option}`);
      }
    }
    assert.match(text, /Reply with only the JSON object/);
    assert.match(text, /"Import answers"/);
    if (site.submit?.review_note) assert.ok(text.includes(site.submit.review_note.trim()));
    if (answerFields(schema).some((field) => field.type === 'images')) {
      assert.match(text, /at least 1280 pixels wide/);
      assert.match(text, /125 characters or fewer/);
      assert.match(text, /not part of the JSON/);
    }
    if (answerFields(schema).some((field) => field.type === 'list')) {
      assert.match(text, /Never put a comma inside an item/);
    }
  });

  test(`${id}: output is deterministic and the files parse`, () => {
    assert.equal(answersSchemaFile(schema, site), answersSchemaFile(schema, site));
    assert.equal(agentInstructionsFile(schema, site), agentInstructionsFile(schema, site));
    assert.equal(
      JSON.stringify(answersSchema(schema, site)),
      JSON.stringify(answersSchema(structuredClone(schema), structuredClone(site)))
    );
    const file = answersSchemaFile(schema, site);
    assert.match(
      file,
      /^---\n(# .*\n)?layout: null\nsitemap: false\npermalink: \/submit\/answers\.schema\.json\n---\n/
    );
    const parsed = JSON.parse(body(file));
    assert.equal(parsed.$schema, draft);
    assert.ok(file.endsWith('\n'));
    assert.ok(agentInstructionsFile(schema, site).endsWith('\n'));
  });
}

test('the site address comes from Liquid, so it is right wherever the site is built', () => {
  const file = answersSchemaFile(shippedSchema, shippedSite);
  assert.match(body(file), /"\$id": "\{\{ '\/submit\/answers\.schema\.json' \| absolute_url \}\}"/);
  const text = agentInstructionsFile(shippedSchema, shippedSite);
  assert.match(text, /Submission page: \{\{ '\/submit\/' \| absolute_url \}\}/);
  assert.match(text, /JSON Schema at \{\{ '\/submit\/answers\.schema\.json' \| absolute_url \}\}/);
});

test('copy that looks like Liquid cannot break the files', () => {
  const schema = {
    entry: { singular: 'thing' },
    fields: [
      {
        key: 'title',
        label: 'Title {{ x }}',
        type: 'text',
        required: true,
        description: 'Use {% raw %} never',
      },
      { key: 'kind', label: 'Kind', type: 'select', options: ['{{ a }}', 'b'] },
    ],
  };
  for (const file of [
    answersSchemaFile(schema, { name: '{{ site }}' }),
    agentInstructionsFile(schema, { name: '{{ site }}' }),
  ]) {
    // Every `{{` or `{%` left in the file opens one of our own, known tags.
    const rest = body(file)
      .replace(/\{\{ '[^']*' \| absolute_url \}\}/g, '')
      .replace(/\{\{ '(\{\{|\{%)' \}\}/g, '');
    assert.doesNotMatch(rest, /\{\{|\{%/);
  }
  assert.doesNotThrow(() => JSON.parse(body(answersSchemaFile(schema, {}))));
});

test('a schema without a title question still gets one', () => {
  const result = answersSchema(
    { entry: { singular: 'Thing' }, fields: [{ key: 'x', label: 'X', type: 'text' }] },
    {}
  );
  assert.deepEqual(Object.keys(result.properties), ['title', 'x']);
  assert.deepEqual(result.required, ['title']);
});

test('the committed files equal freshly generated output', () => {
  assert.equal(read('submit/answers.schema.json'), answersSchemaFile(shippedSchema, shippedSite));
  assert.equal(read('submit/agent-instructions.txt'), agentInstructionsFile(shippedSchema, shippedSite));
});

test('both files are listed as generator outputs, so updates keep them regenerated', () => {
  const generated = jsYaml.load(read('.phct/ownership.yml'));
  const text = JSON.stringify(generated);
  for (const file of ['submit/answers.schema.json', 'submit/agent-instructions.txt']) {
    assert.ok(text.includes(file), `${file} in .phct/ownership.yml`);
    const lines = read('.gitattributes')
      .split('\n')
      .map((line) => line.trim().split(/\s+/));
    assert.ok(
      lines.some(([path, attr]) => path === file && attr === 'merge=ours'),
      `${file} merge=ours in .gitattributes`
    );
  }
});

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Structural checks for the subset of draft 2020-12 these schemas use. */
function structural(node, where = '#') {
  const types = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  const allowed = new Set([
    '$schema',
    '$id',
    'title',
    'description',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'uniqueItems',
    'minItems',
    'minLength',
    'maxLength',
    'pattern',
    'format',
  ]);
  for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${where}: unexpected keyword ${key}`);
  if (node.type !== undefined) assert.ok(types.includes(node.type), `${where}: type`);
  if (node.enum !== undefined) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${where}: enum is non-empty`);
    assert.equal(new Set(node.enum).size, node.enum.length, `${where}: enum values are unique`);
  }
  if (node.pattern !== undefined) assert.doesNotThrow(() => new RegExp(node.pattern), `${where}: pattern`);
  if (node.type === 'array') assert.ok(node.items && typeof node.items === 'object', `${where}: items`);
  if (node.items) structural(node.items, `${where}/items`);
  if (node.properties) {
    assert.equal(node.type, 'object');
    for (const [key, child] of Object.entries(node.properties)) structural(child, `${where}/${key}`);
  }
  if (node.required) {
    assert.ok(Array.isArray(node.required));
    for (const key of node.required)
      assert.ok(has(node.properties || {}, key), `${where}: required ${key} is defined`);
  }
}
