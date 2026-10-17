/**
 * "Import answers" on the submit page (assets/js/submit/import.js), driven
 * through a real DOM.
 *
 * The page is the Liquid snapshot submit_form.test.mjs uses, with the
 * "Using an AI agent?" block laid over it. That block lives in the page intro,
 * which the snapshot leaves out, so it is lifted from submit/index.md itself
 * (Liquid links resolved) rather than copied here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import * as jsYaml from 'js-yaml';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'submit-form.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'submit', 'index.md'), 'utf8');
const SCRIPTS = jsYaml.load(INDEX.split(/^---$/m)[1]).scripts.map((src) => src.replace(/^\//, ''));

/** The import block as submit/index.md writes it, with its Liquid links resolved. */
const IMPORT_BLOCK = (() => {
  const match = /<details[^>]*data-import>[\s\S]*?<\/details>/.exec(INDEX);
  assert.ok(match, 'submit/index.md has no [data-import] block');
  return match[0].replace(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g, '$1');
})();

const booted = [];
test.after(() => booted.forEach((dom) => dom.window.close()));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A booted submit page.
 * @param {{draftSeed?: boolean}} [options]
 */
async function boot() {
  const dom = new JSDOM('<!doctype html><body>' + IMPORT_BLOCK + FIXTURE + '</body>', {
    url: 'https://example.org/submit/',
    runScripts: 'outside-only',
  });
  booted.push(dom);
  const { window } = dom;
  window.open = () => null;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  const { document } = window;

  // A file question as the page renders it when uploads are on: a real file
  // input and the picker's list, which import must leave exactly as they are.
  const deck = document.querySelector('[data-field="deck_pdf"]');
  deck.insertAdjacentHTML(
    'beforeend',
    '<div data-uploads="deck_pdf"><input type="file" data-upload-picker><ul data-upload-list><li data-upload-item>deck.pdf</li></ul></div>'
  );
  const shots = document.querySelector('[data-field="screenshots"]');
  shots.insertAdjacentHTML(
    'beforeend',
    '<div data-uploads="screenshots"><input type="file" data-upload-picker><ul data-upload-list><li data-upload-item>a.png</li></ul></div>'
  );

  SCRIPTS.forEach((rel) => window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  await flush();

  const ctx = { window, document, form: document.querySelector('[data-submit-form]') };
  ctx.box = document.querySelector('[data-import]');
  ctx.input = ctx.box.querySelector('[data-import-input]');
  ctx.button = ctx.box.querySelector('[data-import-button]');
  ctx.status = ctx.box.querySelector('[data-import-status]');
  ctx.report = ctx.box.querySelector('[data-import-report]');
  ctx.confirm = ctx.box.querySelector('[data-import-confirm]');
  ctx.summary = ctx.form.querySelector('[data-error-summary]');
  ctx.field = (key) => ctx.form.querySelector('[data-field="' + key + '"]');
  ctx.fields = window.SubmitForm.readFields(ctx.form);
  // Through JSON: arrays built inside the jsdom window are a different realm's.
  ctx.read = (key) =>
    JSON.parse(JSON.stringify(window.SubmitForm.readValue(ctx.fields.find((f) => f.key === key))));
  /** The first option of a select/multiselect, as the page offers it. */
  ctx.option = (key, index = 0) =>
    Array.from(ctx.field(key).querySelectorAll('input[value]:not([data-clear]), select option[value]'))
      .map((el) => el.value)
      .filter(Boolean)[index];
  ctx.importJson = (value) => {
    ctx.input.value = typeof value === 'string' ? value : JSON.stringify(value);
    ctx.button.click();
  };
  return ctx;
}

test('the page ships the import block, hooks and script', () => {
  assert.ok(SCRIPTS.includes('assets/js/submit/import.js'), 'import.js is in the page scripts');
  assert.ok(
    SCRIPTS.indexOf('assets/js/submit/import.js') < SCRIPTS.indexOf('assets/js/submit.js'),
    'import.js loads before submit.js'
  );
  for (const hook of [
    'data-import-input',
    'data-import-button',
    'data-import-status',
    'data-import-report',
    'data-import-confirm-yes',
    'data-import-confirm-no',
  ]) {
    assert.ok(IMPORT_BLOCK.includes(hook), `${hook} is in the markup`);
  }
  assert.match(IMPORT_BLOCK, /<summary[^>]*>Using an AI agent\?<\/summary>/);
  assert.match(IMPORT_BLOCK, /href="\/submit\/agent-instructions\.txt"/);
  assert.match(IMPORT_BLOCK, /href="\/submit\/answers\.schema\.json"/);
  assert.match(IMPORT_BLOCK, /<label[^>]*for="import-json"/);
});

test('valid JSON fills the form and runs the form’s own validation', async () => {
  const ctx = await boot();
  const type = ctx.option('solution_type', 1);
  const areas = [ctx.option('area', 0), ctx.option('area', 1)];
  ctx.importJson({
    title: 'Hotline triage',
    solution_type: type,
    area: areas,
    summary: 'Sorts calls by urgency.',
    ai_tools: ['Claude', 'Copilot'],
    repo_url: 'https://example.org/repo',
    resources: [{ label: 'Report', url: 'https://example.org/r' }, { url: 'https://www.example.org/x' }],
    screenshots: [{ url: 'https://example.org/a.png', alt: 'The triage queue' }],
  });

  assert.equal(ctx.read('title'), 'Hotline triage');
  assert.equal(ctx.read('solution_type'), type);
  assert.deepEqual(ctx.read('area'), areas);
  assert.deepEqual(ctx.read('ai_tools'), ['Claude', 'Copilot']);
  assert.equal(ctx.field('ai_tools').querySelector('textarea').value, 'Claude\nCopilot');
  assert.deepEqual(ctx.read('resources'), [
    { label: 'Report', url: 'https://example.org/r' },
    { label: 'example.org', url: 'https://www.example.org/x' },
  ]);
  assert.deepEqual(ctx.read('screenshots'), [{ url: 'https://example.org/a.png', alt: 'The triage queue' }]);

  // validateAll ran: other required questions are still empty, so the form's
  // error summary lists them as links to their fields.
  assert.equal(ctx.summary.hidden, false);
  const links = Array.from(ctx.summary.querySelectorAll('[data-error-summary-list] a'));
  assert.ok(links.length > 0, 'the summary lists what is left');
  assert.ok(links.every((a) => a.getAttribute('href').startsWith('#')));
  assert.equal(ctx.field('organization').querySelector('[aria-invalid="true"]') !== null, true);
  assert.equal(ctx.field('title').querySelector('[aria-invalid="true"]'), null);
  assert.match(ctx.status.textContent, /Filled in 8 answers/);
  assert.match(ctx.status.textContent, /still need attention/);
});

test('a complete answer set passes validation and closes the summary', async () => {
  const ctx = await boot();
  const answers = {};
  for (const field of ctx.fields) {
    if (!field.required) continue;
    if (field.type === 'select') answers[field.key] = ctx.option(field.key);
    else if (field.type === 'multiselect') answers[field.key] = [ctx.option(field.key)];
    else if (field.type === 'boolean') answers[field.key] = true;
    else if (field.type === 'email') answers[field.key] = 'a@example.org';
    else if (field.type === 'url') answers[field.key] = 'https://example.org';
    else answers[field.key] = 'Text for ' + field.key;
  }
  ctx.summary.hidden = false;
  ctx.importJson(answers);
  assert.equal(ctx.summary.hidden, true);
  assert.match(ctx.status.textContent, /passes the form’s checks/);
});

test('a syntax error gets a friendly message and changes nothing', async () => {
  const ctx = await boot();
  ctx.importJson('{ "title": "Oops",');
  assert.match(ctx.status.textContent, /not valid JSON/);
  assert.match(ctx.status.textContent, /only the JSON object/);
  assert.equal(ctx.input.getAttribute('aria-invalid'), 'true');
  assert.equal(ctx.read('title'), '');
  assert.equal(ctx.window.document.activeElement, ctx.input);
});

test('empty input and non-objects are refused', async () => {
  const ctx = await boot();
  ctx.importJson('   ');
  assert.match(ctx.status.textContent, /Paste the JSON/);
  for (const bad of ['[1,2]', '"text"', '42', 'null']) {
    ctx.importJson(bad);
    assert.match(ctx.status.textContent, /Expected one JSON object/, bad);
  }
  assert.equal(ctx.read('title'), '');
});

test('unknown keys are ignored and reported, the rest still imports', async () => {
  const ctx = await boot();
  ctx.importJson({ title: 'Known', not_a_question: 'x', also_missing: 1 });
  assert.equal(ctx.read('title'), 'Known');
  assert.match(ctx.report.textContent, /not a question on this form: not_a_question, also_missing/);
  assert.equal(ctx.report.hidden, false);
  assert.equal(ctx.field('not_a_question'), null);
});

test('a value outside the options is reported against its own question and left alone', async () => {
  const ctx = await boot();
  ctx.importJson({
    title: 'T',
    solution_type: 'Not an option',
    area: [ctx.option('area'), 'Imaginary area'],
  });
  assert.equal(ctx.read('solution_type'), '');
  assert.match(ctx.report.textContent, /“What are you sharing\?”: “Not an option” is not one of its options/);
  // One good multiselect option survives; the bad one is named.
  assert.deepEqual(ctx.read('area'), [ctx.option('area')]);
  assert.match(ctx.report.textContent, /“Imaginary area”/);
  // Option text matches ignoring case, and is stored as the page spells it.
  ctx.importJson({ solution_type: ctx.option('solution_type', 2).toUpperCase() });
  assert.equal(ctx.read('solution_type'), ctx.option('solution_type', 2));
});

test('wrong types are rejected without touching the field', async () => {
  const ctx = await boot();
  ctx.importJson({
    title: { nested: true },
    ai_tools: 'one',
    no_pii_attestation: 'maybe',
    resources: 'https://x.org',
  });
  assert.equal(ctx.read('title'), '');
  assert.match(ctx.report.textContent, /expects text/);
  assert.match(ctx.report.textContent, /true or false/);
  assert.match(ctx.report.textContent, /a list of links/);
  // A single string is a one-item list, not an error.
  assert.deepEqual(ctx.read('ai_tools'), ['one']);
});

test('list items go one per line, newlines split and commas are flagged', async () => {
  const ctx = await boot();
  ctx.importJson({ ai_tools: ['Claude', 'GPT\nGemini', 'Acme, Inc.'] });
  assert.equal(ctx.field('ai_tools').querySelector('textarea').value, 'Claude\nGPT\nGemini\nAcme, Inc.');
  assert.match(ctx.report.textContent, /“Acme, Inc\.” contains a comma/);
});

test('booleans take true or false; null and empty values are skipped', async () => {
  const ctx = await boot();
  ctx.importJson({ no_pii_attestation: true, vendor: null, impact: '', area: [] });
  assert.equal(ctx.read('no_pii_attestation'), 'true');
  assert.equal(ctx.read('vendor'), '');
  ctx.importJson({ no_pii_attestation: false });
  ctx.box.querySelector('[data-import-confirm-yes]').click(); // it was ticked, so replacing it asks first
  assert.equal(ctx.read('no_pii_attestation'), '');
});

test('an answer the form rejects shows up in the summary (validation is the form’s own)', async () => {
  const ctx = await boot();
  ctx.importJson({ repo_url: 'not a url' });
  assert.equal(ctx.read('repo_url'), 'not a url');
  assert.match(ctx.summary.textContent, /web address starting with https/);
});

test('answers the submitter already typed ask before being replaced', async () => {
  const ctx = await boot();
  const title = ctx.field('title').querySelector('input');
  title.value = 'My own title';
  title.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));

  ctx.importJson({ title: 'Agent title', vendor: 'Acme' });
  assert.equal(ctx.confirm.hidden, false, 'an inline confirmation is shown');
  assert.match(ctx.confirm.textContent, /already answered .*Title|What is it called/);
  assert.equal(ctx.read('title'), 'My own title', 'nothing changes while it waits');
  assert.equal(ctx.read('vendor'), '', 'not even the fields that would not clash');
  assert.equal(ctx.window.document.activeElement, ctx.box.querySelector('[data-import-confirm-yes]'));
  assert.match(ctx.status.textContent, /replace 1 answer/);

  // Keep mine: nothing changes, focus returns to the Import button.
  ctx.box.querySelector('[data-import-confirm-no]').click();
  assert.equal(ctx.confirm.hidden, true);
  assert.equal(ctx.read('title'), 'My own title');
  assert.equal(ctx.window.document.activeElement, ctx.button);

  // Replace them: everything lands.
  ctx.button.click();
  ctx.box.querySelector('[data-import-confirm-yes]').click();
  assert.equal(ctx.confirm.hidden, true);
  assert.equal(ctx.read('title'), 'Agent title');
  assert.equal(ctx.read('vendor'), 'Acme');
});

test('no confirmation when nothing the JSON names was answered', async () => {
  const ctx = await boot();
  const vendor = ctx.field('vendor').querySelector('input');
  vendor.value = 'Typed';
  vendor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  ctx.importJson({ title: 'Fresh' });
  assert.equal(ctx.confirm.hidden, true);
  assert.equal(ctx.read('title'), 'Fresh');
  assert.equal(ctx.read('vendor'), 'Typed', 'questions the JSON does not name are kept');
});

test('file inputs and uploads are never touched; a file answer is reported', async () => {
  const ctx = await boot();
  const before = ctx.form.querySelectorAll('[data-uploads]');
  const snapshot = Array.from(before).map((node) => node.outerHTML);
  ctx.importJson({
    title: 'T',
    deck_pdf: 'https://example.org/deck.pdf',
    screenshots: [{ url: 'https://example.org/a.png', alt: 'x' }],
  });
  assert.deepEqual(
    Array.from(ctx.form.querySelectorAll('[data-uploads]')).map((node) => node.outerHTML),
    snapshot
  );
  ctx.form.querySelectorAll('input[type=file]').forEach((input) => assert.equal(input.value, ''));
  assert.match(ctx.report.textContent, /is a file, so it was skipped/);
  // The typed-address box of the images question is separate from the picker.
  assert.equal(ctx.read('screenshots').length, 1);
});

test('over-long alt text is flagged but kept', async () => {
  const ctx = await boot();
  ctx.importJson({ screenshots: [{ url: 'https://example.org/a.png', alt: 'x'.repeat(126) }] });
  assert.match(ctx.report.textContent, /over 125 characters/);
  assert.equal(ctx.read('screenshots')[0].alt.length, 126);
});

test('the box is keyboard operable and announces itself', async () => {
  const ctx = await boot();
  assert.equal(ctx.button.tagName, 'BUTTON');
  assert.equal(ctx.button.type, 'button');
  assert.equal(ctx.input.tagName, 'TEXTAREA');
  assert.equal(ctx.box.tagName, 'DETAILS');
  assert.equal(ctx.box.querySelector('summary').tabIndex, 0);
  for (const node of [ctx.button, ctx.input]) assert.notEqual(node.getAttribute('tabindex'), '-1');
  assert.ok(
    ctx.input.getAttribute('aria-describedby').split(' ').includes(ctx.status.id),
    'the live region describes the textarea'
  );
  assert.equal(ctx.status.getAttribute('role'), 'status');
  assert.equal(ctx.status.getAttribute('aria-live'), 'polite');

  // The js-only part is revealed by the page's boot, not left hidden.
  assert.equal(ctx.input.closest('[data-js-only]').hidden, false);

  assert.equal(ctx.status.textContent, '');
  ctx.importJson({ title: 'Hello' });
  assert.match(ctx.status.textContent, /Filled in 1 answer\./);
  ctx.importJson('{');
  assert.match(ctx.status.textContent, /not valid JSON/);
});

test('importing saves a draft like typing does', async () => {
  const ctx = await boot();
  ctx.importJson({ title: 'Drafted' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const key = Object.keys(ctx.window.localStorage).find((k) => k.includes('submit-draft'));
  assert.ok(key, 'a draft was stored');
  assert.equal(JSON.parse(ctx.window.localStorage.getItem(key)).fields.title, 'Drafted');
});
