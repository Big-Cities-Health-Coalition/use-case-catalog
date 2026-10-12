/**
 * The /setup/ wizard, driven through a real DOM.
 *
 * setup-page.js boots on import and renders into the page, so the shell below
 * has to exist first. It mirrors setup/index.md — the test asserts that, so the
 * fixture cannot drift from the page the site actually ships — and the modules
 * are imported once, after the globals are in place. Every test then works the
 * same live wizard, in order, the way a person would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { defaultConfig } from '../../assets/js/configurator/default-config.js';
import { OPTIONAL_FORM_SOURCES } from '../../assets/js/configurator/defaults.generated.js';
import { optionalFormFiles } from '../../assets/js/configurator/issue-chooser.js';

const setupPage = readFileSync(fileURLToPath(new URL('../../setup/index.md', import.meta.url)), 'utf8');

/** The ids setup-page.js reaches for. Each one has to be on the real page too. */
const REQUIRED_IDS = [
  'wizard',
  'wizard-steps',
  'wizard-errors',
  'resume-banner',
  'current-config',
  'current-theme',
  'current-schema',
];

const shipped = defaultConfig();

const dom = new JSDOM(
  `<!doctype html><html><body>
     <div id="resume-banner" hidden></div>
     <nav id="wizard-steps" aria-label="Setup steps"></nav>
     <div id="wizard-errors"></div>
     <div id="wizard"></div>
     <script id="current-config" type="application/json">${JSON.stringify(shipped.site)}</script>
     <script id="current-theme" type="application/json">${JSON.stringify(shipped.theme)}</script>
     <script id="current-schema" type="application/json">${JSON.stringify(shipped.schema)}</script>
     <script id="current-repository" type="application/json">"bigcities/ai-catalog"</script>
   </body></html>`,
  { url: 'https://example.org/setup/' }
);

const { window } = dom;
const { document } = window;

// jsdom has neither of these; the wizard uses both.
window.confirm = () => true;
window.Element.prototype.scrollIntoView = () => {};

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.Blob = window.Blob;
globalThis.URL.createObjectURL ??= () => 'blob:preview';
globalThis.URL.revokeObjectURL ??= () => {};

const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.error || event.message)));

const wizardState = await import('../../assets/js/configurator/wizard/state.js');
await import('../../assets/js/configurator/setup-page.js');

/* --- helpers -------------------------------------------------------------- */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Click the numbered step pill, the way an admin jumps between steps. */
function goToStep(oneBased) {
  const pill = $$('#wizard-steps button').find(
    (button) => button.querySelector('.wizard-step-index').textContent === String(oneBased)
  );
  assert.ok(pill, `no step pill ${oneBased}`);
  pill.click();
}

/** Type into a control and fire the event its listener is bound to. */
function type(selector, value, eventName = 'input') {
  const node = $(selector);
  assert.ok(node, `missing ${selector}`);
  node.value = value;
  node.dispatchEvent(new window.Event(eventName, { bubbles: true }));
  return node;
}

const fieldRows = () => $$('#wizard .schema-field-row');
const rowFor = (key) => fieldRows().find((row) => row.querySelector('.font-mono')?.textContent === key);
const toggleFor = (key) => rowFor(key).querySelector('button[aria-expanded]');
const isOpen = (key) => toggleFor(key).getAttribute('aria-expanded') === 'true';
const setOpen = (key, open) => {
  if (isOpen(key) !== open) toggleFor(key).click();
};

/** Press one of the wizard's buttons by its label. */
function press(label) {
  const button = $$('#wizard button').find((node) => node.textContent === label);
  assert.ok(button, `no "${label}" button`);
  button.click();
}

/** Rewrite one field row's options textarea, one option per line. */
function setOptions(key, text) {
  const textarea = rowFor(key).querySelector('textarea[id$="-options"]');
  assert.ok(textarea, `no options textarea on the ${key} row`);
  textarea.value = text;
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/* --- the page shell ------------------------------------------------------- */

test('setup/index.md still provides every id the wizard renders into', () => {
  for (const id of REQUIRED_IDS) {
    assert.ok(setupPage.includes(`id="${id}"`), `setup/index.md no longer has #${id}`);
  }
  // The entry point path is referenced by the page and must stay stable.
  assert.match(setupPage, /assets\/js\/configurator\/setup-page\.js/);
});

test('the wizard boots on step 1 with one pill per step, each naming its step id', () => {
  assert.deepEqual(
    $$('#wizard-steps button').map((button) => button.dataset.step),
    ['start', 'basics', 'look', 'words', 'modules', 'fields', 'review']
  );
  assert.deepEqual(
    $$('#wizard-steps button').map((button) => button.querySelector('.wizard-step-index').textContent),
    ['1', '2', '3', '4', '5', '6', '7']
  );
  assert.deepEqual(
    $$('#wizard-steps button').map((button) => button.querySelector('.wizard-step-label').textContent),
    ['Start', 'Basics', 'Look', 'Words', 'Modules', 'Entry model', 'Review']
  );
  assert.equal($('#step-heading').textContent, 'Choose a starting point');
  assert.deepEqual(errors, []);
});

/* --- basics / look / words (the split Branding step) ----------------------- */

test('the three branding steps together ask every question the one step asked', () => {
  const asked = new Set();
  for (const step of [2, 3, 4]) {
    goToStep(step);
    for (const control of $$('#wizard [id^="field-"]')) asked.add(control.id.replace('field-', ''));
  }
  // The question set of v1.2.0's single "Branding & contact" step, plus the
  // `motion` control added in 1.3.0. Splitting a step must move questions,
  // never drop them.
  assert.deepEqual([...asked].sort(), [
    'accent',
    'bodyFont',
    'branch',
    'contactEmail',
    'copyright',
    'description',
    'footerAbout',
    'googleFontsUrl',
    'headingFont',
    'heroEyebrow',
    'heroLead',
    'heroTitle',
    'lineStrong',
    'logoImage',
    'logoText',
    'motion',
    'orgName',
    'orgShort',
    'orgUrl',
    'primary',
    'primaryDark',
    'radius',
    'repository',
    'secondary',
    'siteName',
    'submitIntro',
    'submitReviewNote',
    'submitTurnaround',
    'tagline',
    'warn',
  ]);
});

test('an empty or malformed repository is explained before review rendering', () => {
  goToStep(2);
  type('#field-repository', '');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Names & contact');
  assert.match($('#wizard-error-summary').textContent, /owner\/repo/u);

  type('#field-repository', 'not-a-repository');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Names & contact');
  assert.match($('#wizard-error-summary').textContent, /owner\/repo/u);

  type('#field-repository', 'bigcities/ai-catalog');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Colors & type');
});

test('a repository still naming the template is refused on another deployment', () => {
  goToStep(2);
  type('#field-repository', shipped.site.github.repository);
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Names & contact');
  assert.match($('#wizard-error-summary').textContent, /still points at the template/u);

  // Repository identities are case-insensitive on GitHub; so is the refusal.
  type('#field-repository', shipped.site.github.repository.toUpperCase());
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Names & contact');
  assert.match($('#wizard-error-summary').textContent, /still points at the template/u);

  type('#field-repository', 'bigcities/ai-catalog');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Colors & type');
});

test('jumping ahead by step pill validates the steps it would skip', () => {
  goToStep(3);
  type('#field-primary', 'nope');
  goToStep(7);
  assert.equal($('#step-heading').textContent, 'Colors & type', 'the jump skipped an invalid step');
  assert.ok($('#wizard-error-summary'), 'no error summary for the skipped step');
  type('#field-primary', '#1D4E89');
});

test('the Look step asks every colour question the CLI asks, and offers a custom font', () => {
  goToStep(3);
  for (const key of ['primary', 'primaryDark', 'secondary', 'accent', 'lineStrong', 'warn']) {
    assert.ok($(`#field-${key}`), `no colour field for ${key}`);
  }
  assert.ok(wizardState.state.answers.lineStrong, 'lineStrong was not seeded from the starting point');
  assert.ok(wizardState.state.answers.warn, 'warn was not seeded from the starting point');

  wizardState.state.answers.headingFont = 'Roboto';
  goToStep(1);
  goToStep(3);
  const select = $('#field-headingFont');
  assert.equal(select.value, 'Roboto', 'a custom font left the select unselected');
  assert.ok([...select.options].some((o) => o.value === 'Roboto'));
  wizardState.state.answers.headingFont = 'PHCT Sans';
});

test('the Look step renders and the live preview follows the primary colour', () => {
  goToStep(3);
  assert.equal($('#step-heading').textContent, 'Colors & type');
  const preview = $('#wizard .theme-preview');
  assert.ok(preview, 'the theme preview is missing');
  assert.match(preview.getAttribute('style'), /--c-primary: 29 78 137/);

  type('#field-primary', '#AA0011');
  assert.match($('#wizard .theme-preview').getAttribute('style'), /--c-primary: 170 0 17/);
  assert.deepEqual(errors, []);
});

test('the motion control writes a whole block, and a hand-written one is offered back', () => {
  goToStep(3);
  const select = type('#field-motion', 'calm', 'change');
  assert.deepEqual(wizardState.state.answers.motion, {
    fast: '180ms',
    base: '280ms',
    slow: '380ms',
    ease: 'ease-in-out',
  });
  assert.match(select.parentElement.textContent, /Now 180ms \/ 280ms \/ 380ms/);
  assert.equal(
    [...select.options].some((option) => option.value === 'custom'),
    false,
    'a named speed is not a custom block'
  );

  // Timings nobody picked here stay picked: the extra option names them rather
  // than silently resetting the file to a preset.
  wizardState.state.answers.motion = { fast: '0.1s', base: '0.2s', slow: '0.3s', ease: 'ease-out' };
  goToStep(1);
  goToStep(3);
  const custom = $('#field-motion');
  assert.equal(custom.value, 'custom');
  assert.match(custom.parentElement.textContent, /Now 0.1s \/ 0.2s \/ 0.3s, easing ease-out/);
});

test('a motion block the file cannot use blocks Continue and links to the control', () => {
  goToStep(3);
  wizardState.state.answers.motion = { fast: '900ms', base: '200ms', slow: '3s', ease: 'springy' };
  goToStep(4);

  const summary = $('#wizard-error-summary');
  assert.ok(summary, 'an unusable motion block was accepted');
  assert.equal($('#step-heading').textContent, 'Colors & type', 'the step advanced anyway');
  const messages = [...summary.querySelectorAll('a[href="#field-motion"]')].map((a) => a.textContent);
  assert.equal(messages.length, 3, messages.join(' | '));
  assert.ok(messages.some((m) => /between 0 and 1000ms/.test(m)));
  assert.ok(messages.some((m) => /"fast" must not be slower than "base"/.test(m)));
  assert.ok(messages.some((m) => /easing must be one of/.test(m)));
  assert.equal($('#field-motion').getAttribute('aria-invalid'), 'true');

  type('#field-motion', 'default', 'change');
  goToStep(4);
  assert.equal($('#wizard-error-summary'), null);
  assert.equal($('#step-heading').textContent, 'Home page & footer copy');
});

test('the preview picks up copy answered on the other two steps', () => {
  goToStep(4);
  type('#field-heroTitle', 'What our county is building with AI');
  goToStep(3);
  assert.match(
    $('#wizard .theme-preview').textContent,
    /What our county is building with AI/,
    'the preview did not pick up the headline written on the Words step'
  );
});

test('an invalid colour blocks Continue and focuses the error summary, linked to the field', () => {
  type('#field-primary', 'not-a-colour');
  $$('#wizard button')
    .find((button) => button.textContent === 'Continue')
    .click();

  const summary = $('#wizard-error-summary');
  assert.ok(summary, 'no error summary was rendered');
  assert.equal(summary.getAttribute('tabindex'), '-1');
  assert.equal(document.activeElement, summary, 'focus did not move to the error summary');
  // The panel takes focus; a live-region role on the container would make an
  // assistive technology read the same problems a second time.
  assert.equal($('#wizard-errors').getAttribute('role'), null);

  const link = summary.querySelector('a[href="#field-primary"]');
  assert.ok(link, 'the problem does not link to the field it belongs to');
  assert.match(link.textContent, /Main colour must be a 6-digit hex/);
  assert.equal($('#step-heading').textContent, 'Colors & type', 'the step advanced anyway');

  // Fixing it clears the summary and lets the step advance.
  type('#field-primary', '#1D4E89');
  $$('#wizard button')
    .find((button) => button.textContent === 'Continue')
    .click();
  assert.equal($('#wizard-error-summary'), null);
  assert.equal($('#step-heading').textContent, 'Home page & footer copy');
});

test('a problem is marked on the control it belongs to before Continue returns', () => {
  goToStep(3);
  type('#field-primary', 'not-a-colour');
  press('Continue');
  // No waiting: the step is rendered first and the problems are announced
  // onto the controls that render produced, in the same task.

  const control = $('#field-primary');
  assert.equal(control.getAttribute('aria-invalid'), 'true');
  const message = $('#field-primary-error');
  assert.ok(message, 'no inline message beside the control');
  assert.equal(message.previousElementSibling, control, 'the message is not beside its control');
  assert.match(message.textContent, /Main colour must be a 6-digit hex/);
  assert.match(control.getAttribute('aria-describedby') || '', /\bfield-primary-error\b/);

  // Touching the control is the moment the reader has done something about it.
  type('#field-primary', '#1D4E89');
  assert.equal($('#field-primary').getAttribute('aria-invalid'), null);
  assert.equal($('#field-primary-error'), null);
});

test('the two URL answers are validated, each on the step that asks for it', () => {
  goToStep(2);
  type('#field-orgUrl', 'bigcities.org');
  press('Continue');

  assert.equal($('#step-heading').textContent, 'Names & contact', 'the step advanced anyway');
  const summary = $('#wizard-error-summary');
  assert.ok(summary.querySelector('a[href="#field-orgUrl"]'), 'the problem does not link to the field');
  assert.match($('#field-orgUrl-error').textContent, /must start with https:\/\//);

  type('#field-orgUrl', 'https://bigcities.org');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Colors & type');

  type('#field-googleFontsUrl', 'javascript:alert(1)');
  press('Continue');
  assert.match($('#field-googleFontsUrl-error').textContent, /must start with https:\/\//);

  // Leave the step valid for the tests that follow.
  type('#field-googleFontsUrl', '');
  press('Continue');
  assert.equal($('#wizard-error-summary'), null);
  assert.equal($('#step-heading').textContent, 'Home page & footer copy');
});

test('the saved session names the step it is on, and an older numbered one still resumes', () => {
  goToStep(3);
  assert.equal(JSON.parse(localStorage.getItem(wizardState.STORAGE_KEY)).step, 'look');

  // v1.2.0 stored a position in a five-step list; 3 was the Entry model step.
  const stored = JSON.parse(localStorage.getItem(wizardState.STORAGE_KEY));
  localStorage.setItem(wizardState.STORAGE_KEY, JSON.stringify({ ...stored, step: 3 }));
  assert.equal(wizardState.restore(), true);
  assert.equal(wizardState.STEPS[wizardState.state.step], 'fields');

  localStorage.setItem(wizardState.STORAGE_KEY, JSON.stringify({ ...stored, step: 'nonsense' }));
  wizardState.restore();
  assert.equal(wizardState.state.step, 0, 'an unknown step id must not leave the wizard nowhere');

  // Put the live session back where the following tests expect it.
  localStorage.setItem(wizardState.STORAGE_KEY, JSON.stringify(stored));
  wizardState.restore();
  goToStep(3);
});

/* --- entry model ---------------------------------------------------------- */

test('every field row starts collapsed behind a real expand button', () => {
  goToStep(6);
  assert.equal($('#step-heading').textContent, 'Entry model');
  const rows = fieldRows();
  assert.ok(rows.length > 5, 'expected the shipped schema to have several fields');
  for (const row of rows) {
    const toggle = row.querySelector('button[aria-expanded]');
    assert.ok(toggle, 'a row has no expand button');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), row.querySelector('.schema-field-details').id);
    assert.equal(row.querySelector('.schema-field-details').hidden, true);
  }
});

test('the collapsed summary carries the label, key, type and the presentation badges', () => {
  const row = rowFor('title');
  assert.ok(row, 'no row for the title field');
  const summary = row.querySelector('button[aria-expanded]').textContent;
  assert.match(summary, /Title/);
  assert.match(summary, /title/);
  assert.match(summary, /text/);
  assert.match(summary, /Required/);
});

test('expanding a row reveals its controls, including the card-slot select', () => {
  const row = rowFor('audience') || rowFor('title');
  const toggle = row.querySelector('button[aria-expanded]');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('.schema-field-details').hidden, false);
  assert.ok(row.querySelector('input[id$="-label"]'), 'the label input is missing');
  assert.ok(row.querySelector('select[id$="-group"]'), 'the group select is missing');
  assert.ok(row.querySelector('input[id$="-weight"]'), 'the weight input is missing');
  assert.ok(row.querySelector('select[id$="-card-slot"]'), 'the card-slot select is missing');
});

test('expanded rows survive a re-render of the step', () => {
  const key = 'title';
  rowFor(key).querySelector('button[aria-expanded]').getAttribute('aria-expanded') === 'true' ||
    rowFor(key).querySelector('button[aria-expanded]').click();
  goToStep(5);
  goToStep(6);
  const toggle = rowFor(key).querySelector('button[aria-expanded]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(rowFor(key).querySelector('.schema-field-details').hidden, false);
});

test('the Entry model step pins its actions, including Add a field, to the bottom', () => {
  const bar = $('#wizard .wizard-actions');
  assert.ok(bar.classList.contains('is-sticky'), 'the action bar is not sticky on this step');
  const labels = [...bar.querySelectorAll('button')].map((button) => button.textContent);
  assert.deepEqual(labels, ['Back', 'Add a field', 'Start over', 'Continue']);
});

test('a new field can be given a group and a weight, and they reach the schema', () => {
  $('#new-field-label').value = 'Budget range';
  $('#new-field-label').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('#new-field-key').value, 'budget_range', 'the key did not derive from the label');

  type('#new-field-type', 'select', 'change');
  type('#new-field-group', 'reuse', 'change');
  type('#new-field-weight', '7');
  $$('#wizard button')
    .find((button) => button.textContent === 'Add field')
    .click();

  const added = wizardState.state.fields.find((field) => field.key === 'budget_range');
  assert.ok(added, 'the field was not added');
  assert.equal(added.group, 'reuse');
  assert.equal(added.weight, 7);

  const emitted = wizardState.schemaFields().find((field) => field.key === 'budget_range');
  assert.deepEqual(emitted, {
    key: 'budget_range',
    label: 'Budget range',
    type: 'select',
    group: 'reuse',
    weight: 7,
    options: ['Option one', 'Option two'],
  });
  assert.equal(emitted.enabled, undefined, 'the wizard-only `enabled` flag leaked into the schema');

  // The new row opens straight away so it can be filled in.
  assert.equal(
    rowFor('budget_range').querySelector('button[aria-expanded]').getAttribute('aria-expanded'),
    'true'
  );
});

test('an out-of-range weight is rejected and linked to its input', () => {
  $('#new-field-label').value = 'Too heavy';
  $('#new-field-label').dispatchEvent(new window.Event('input', { bubbles: true }));
  type('#new-field-weight', '42');
  $$('#wizard button')
    .find((button) => button.textContent === 'Add field')
    .click();

  const summary = $('#wizard-error-summary');
  assert.ok(
    summary.querySelector('a[href="#new-field-weight"]'),
    'the weight problem does not link to the input'
  );
  assert.equal(
    wizardState.state.fields.some((field) => field.key === 'too_heavy'),
    false
  );
});

test('a schema problem opens the row it blames and links to its toggle', () => {
  // A select field with no options is invalid. Empty it, then collapse the row.
  setOpen('budget_range', true);
  setOptions('budget_range', '');
  setOpen('budget_range', false);
  assert.equal(
    rowFor('budget_range').querySelector('.schema-field-details').hidden,
    true,
    'a collapsed row must keep its controls hidden'
  );

  press('Continue');

  const summary = $('#wizard-error-summary');
  assert.ok(summary, 'no error summary');
  assert.equal(document.activeElement, summary);
  const link = summary.querySelector('a[href="#schema-field-budget_range-toggle"]');
  assert.ok(link, 'the schema problem does not link to the field row');
  assert.match(link.textContent, /needs at least one option/);
  assert.equal(isOpen('budget_range'), true, 'the blamed row was not re-opened');
  assert.equal(
    rowFor('budget_range').querySelector('.schema-field-details').hidden,
    false,
    'the re-opened row still hides its controls'
  );
});

test('a blocked Continue keeps what was typed into "Add a field"', () => {
  // budget_range is still invalid from the previous test, so Continue repaints
  // the step; the half-filled add-field form must survive that repaint.
  type('#new-field-label', 'Cost centre');
  type('#new-field-weight', '3');
  press('Continue');
  assert.ok($('#wizard-error-summary'), 'expected the step to still be blocked');
  assert.equal($('#new-field-label').value, 'Cost centre');
  assert.equal($('#new-field-key').value, 'cost_centre');
  assert.equal($('#new-field-weight').value, '3');
  // Clean up: clear the draft and restore the options so the review test can pass.
  type('#new-field-label', '');
  type('#new-field-weight', '');
  setOptions('budget_range', 'Under 10k\nOver 10k');
});

test('changing a group or label updates the collapsed row header immediately', () => {
  setOpen('budget_range', true);
  const row = rowFor('budget_range');
  const groupSelect = row.querySelector('select[id$="-group"]');
  const firstReal = Array.from(groupSelect.options).find((o) => o.value && o.value !== groupSelect.value);
  groupSelect.value = firstReal.value;
  groupSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  const badges = () =>
    Array.from(row.querySelectorAll('.schema-field-toggle .chip')).map((c) => c.textContent);
  assert.ok(badges().includes(`Group: ${firstReal.value}`), `header badges ${badges()} lack the new group`);
  const labelInput = row.querySelector('input[id$="-label"]');
  labelInput.value = 'Budget band';
  labelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(row.querySelector('.schema-field-name').textContent, 'Budget band');
  setOpen('budget_range', false);
});

/* --- review --------------------------------------------------------------- */

test('the review step renders every file, and the new field is in the schema output', () => {
  setOptions('budget_range', 'Under $10k\nOver $10k');
  press('Continue');
  assert.equal($('#step-heading').textContent, 'Review & publish');
  assert.equal($('#wizard-error-summary'), null);

  const paths = $$('#wizard section.card .card-title.font-mono').map((node) => node.textContent);
  assert.deepEqual(paths, [
    '_data/site.yml',
    '_data/theme.yml',
    '_data/schema.yml',
    '_data/navigation.yml',
    '_config.yml',
    '.github/ISSUE_TEMPLATE/new-entry.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
  ]);

  const schemaYaml = $$('#wizard section.card')
    .find((section) => section.textContent.includes('_data/schema.yml'))
    .querySelector('pre').textContent;
  assert.match(schemaYaml, /key: budget_range/);
  assert.match(schemaYaml, /group: reuse/);
  assert.match(schemaYaml, /weight: 7/);

  const chooserYaml = $$('#wizard section.card')
    .find((section) => section.textContent.includes('.github/ISSUE_TEMPLATE/config.yml'))
    .querySelector('pre').textContent;
  assert.match(chooserYaml, /security\/advisories\/new/u);

  assert.ok($$('#wizard button').some((button) => button.textContent === 'Copy'));
  assert.ok($$('#wizard button').some((button) => button.textContent === 'Download'));
  assert.deepEqual(errors, []);
});

test('turning cohorts on lists the cohort forms to create, rendered as generate writes them', () => {
  goToStep(5);
  const cohorts = $('#module-cohorts');
  assert.equal(cohorts.checked, false, 'the shipped site has cohorts off');
  cohorts.checked = true;
  cohorts.dispatchEvent(new window.Event('change', { bubbles: true }));
  goToStep(7);
  assert.equal($('#step-heading').textContent, 'Review & publish');

  const cards = $$('#wizard section.card').filter((section) =>
    section.querySelector('.card-title.font-mono')
  );
  const newForms = cards.filter((section) => section.querySelector('.eyebrow')?.textContent === 'New file');
  const expected = optionalFormFiles(
    { ...shipped.site, modules: { ...shipped.site.modules, cohorts: true } },
    OPTIONAL_FORM_SOURCES
  ).write;
  const cohortPaths = Object.keys(expected).filter((relative) => !relative.endsWith('/apply-setup.yml'));
  assert.deepEqual(
    newForms.map((section) => section.querySelector('.card-title').textContent),
    cohortPaths,
    'the four cohort forms, after the seven files; Apply setup already exists'
  );
  for (const section of newForms) {
    const relative = section.querySelector('.card-title').textContent;
    assert.equal(section.querySelector('pre').textContent, expected[relative], `${relative} preview`);
    const link = [...section.querySelectorAll('a')].find((node) => node.textContent === 'Create on GitHub');
    assert.ok(link, `${relative} has no Create on GitHub link`);
    const url = new URL(link.href);
    assert.equal(url.pathname, '/bigcities/ai-catalog/new/main');
    assert.equal(url.searchParams.get('filename'), relative);
    assert.equal(url.searchParams.get('value'), expected[relative], `${relative} prefill`);
  }
  assert.match($('#wizard ol').textContent, /add 4 issue forms to GitHub's New issue page/u);
  const publish = $$('#wizard .card').find((card) =>
    card.textContent.includes('How to publish these changes')
  );
  assert.doesNotMatch(publish.textContent, /npm run|terminal/u, 'the browser path needs no terminal');

  // Back off: nothing to create or delete.
  goToStep(5);
  $('#module-cohorts').checked = false;
  $('#module-cohorts').dispatchEvent(new window.Event('change', { bubbles: true }));
  goToStep(7);
  assert.equal(
    $$('#wizard .eyebrow').filter((node) => ['New file', 'Delete'].includes(node.textContent)).length,
    0
  );
  assert.deepEqual(errors, []);
});

test('nothing in the whole run raised a page error', () => {
  assert.deepEqual(errors, []);
});

test('repositoryFromLocation names the repository a github.io address serves', async () => {
  const { repositoryFromLocation } = await import('../../assets/js/configurator/wizard/state.js');
  // A project site: the first path segment is the repository.
  assert.equal(repositoryFromLocation('bigcities.github.io', '/ai-catalog/setup/'), 'bigcities/ai-catalog');
  // A user/organization site serves from the root of a repo named after the host.
  assert.equal(repositoryFromLocation('bigcities.github.io', '/setup/'), 'bigcities/bigcities.github.io');
  // A project repository literally named `setup` serves the page at /setup/setup/.
  assert.equal(repositoryFromLocation('bigcities.github.io', '/setup/setup/'), 'bigcities/setup');
  // The canonical file URL on a root site is still the page's own route.
  assert.equal(
    repositoryFromLocation('bigcities.github.io', '/setup/index.html'),
    'bigcities/bigcities.github.io'
  );
  // A custom domain names neither owner nor repository.
  assert.equal(repositoryFromLocation('catalog.example.org', '/setup/'), null);
  assert.equal(repositoryFromLocation('github.io', '/setup/'), null);
});
