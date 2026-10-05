/**
 * Submit page behaviour, driven through a real DOM.
 *
 * The fixture is a snapshot of the Liquid-rendered /submit/ page (see the
 * comment at the top of test/fixtures/submit-form.html), so these tests
 * exercise the same markup the site ships.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import * as jsYaml from 'js-yaml';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'submit-form.html'), 'utf8');
// The page's own script list, in order, from submit/index.md's front matter,
// so a script added there (or reordered) is what these tests boot too.
const SCRIPTS = jsYaml
  .load(fs.readFileSync(path.join(ROOT, 'submit', 'index.md'), 'utf8').split(/^---$/m)[1])
  .scripts.map((src) => src.replace(/^\//, ''));

// Every booted page, closed when the file finishes. The draft's relative-time
// clock is a live setInterval, and jsdom keeps the Node event loop alive for it
// until its window is closed — without this the test run never exits.
const booted = [];
test.after(() => booted.forEach((dom) => dom.window.close()));

/**
 * A booted submit page. The scripts are evaluated only once the document is
 * complete, mirroring the deferred <script> tags the layout emits.
 * @param {{popupBlocked?: boolean, draft?: object, ui?: object}} [options]
 *   popupBlocked makes window.open return null the way a pop-up blocker does;
 *   draft seeds a saved draft in localStorage before the scripts boot, and ui
 *   rides beside it as the draft's stored UI state (step, short-form mode).
 * @returns {Promise<object>}
 */
async function boot(options = {}) {
  const dom = new JSDOM('<!doctype html><body>' + HTML + '</body>', {
    url: 'https://example.org/submit/',
    runScripts: 'outside-only',
  });
  booted.push(dom);
  const { window } = dom;
  const opened = [];
  window.open = (url) => {
    opened.push(url);
    return options.popupBlocked ? null : { focus() {} };
  };
  const copied = [];
  window.navigator.clipboard = {
    writeText: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
  };

  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });

  const form = window.document.querySelector('[data-submit-form]');
  const draftKey = 'catalog-template:submit-draft:v2:' + form.dataset.draftKey;
  if (options.draft) {
    const stored = { saved: new Date().toISOString(), fields: options.draft };
    if (options.ui) stored.ui = options.ui;
    window.localStorage.setItem(draftKey, JSON.stringify(stored));
  }

  SCRIPTS.forEach((rel) => window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')));

  return {
    window,
    document: window.document,
    form,
    opened,
    copied,
    draftKey,
    storedDraft: () => JSON.parse(window.localStorage.getItem(draftKey) || 'null'),
  };
}

/** Wait past the draft autosave debounce. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

/**
 * Submit the form once. Before the last step that is a request to move on
 * (the stepper treats implicit submission as Next); on the last step it opens
 * "check your answers".
 * @param {object} ctx from boot()
 */
function submitForm(ctx) {
  ctx.form.dispatchEvent(new ctx.window.Event('submit', { bubbles: true, cancelable: true }));
}

/**
 * Walk forward through every step to "check your answers". Fails the test if
 * a step's validation blocks the walk.
 * @param {object} ctx from boot()
 */
function toReview(ctx) {
  const cap = ctx.form.querySelectorAll('[data-section]').length + 1;
  for (let i = 0; i < cap; i += 1) {
    submitForm(ctx);
    if (!ctx.form.querySelector('[data-review]').hidden) return;
  }
  assert.fail('never reached the review step — a step blocked the walk');
}

/**
 * Press a button in the review panel by its visible label.
 * @param {object} ctx from boot()
 * @param {string} label
 * @returns {HTMLElement} the button that was pressed
 */
function press(ctx, label) {
  const button = Array.from(ctx.form.querySelectorAll('[data-review] button')).find(
    (node) => node.textContent.trim() === label
  );
  assert.ok(button, 'no “' + label + '” button in the review panel');
  button.click();
  return button;
}

/** Walk a filled form through every step and the review to GitHub. */
function sendToGitHub(ctx) {
  toReview(ctx);
  press(ctx, 'Send to GitHub');
}

/**
 * Tick the first `count` options of a select/multiselect field.
 * @param {object} ctx
 * @param {string} key
 * @param {number} count
 */
function tick(ctx, key, count) {
  const wrap = ctx.form.querySelector('[data-field="' + key + '"]');
  Array.from(wrap.querySelectorAll('input[value]:not([data-clear])'))
    .slice(0, count)
    .forEach((input) => {
      input.checked = true;
      input.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    });
}

/**
 * Type a value into a field the way a person would, events and all.
 * @param {object} ctx from boot()
 * @param {string} key schema key
 * @param {string} value
 */
function answer(ctx, key, value) {
  const wrap = ctx.form.querySelector('[data-field="' + key + '"]');
  const type = wrap.dataset.type;
  if (type === 'select' || type === 'multiselect') {
    const inputs = Array.from(wrap.querySelectorAll('input[value]'));
    if (inputs.length === 0) {
      // A select with many options renders as a dropdown, not radios.
      const select = wrap.querySelector('select');
      const option = Array.from(select.options).find((candidate) =>
        value ? candidate.value === value : candidate.value !== ''
      );
      select.value = option ? option.value : '';
      select.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
      return;
    }
    const choice = inputs.find((input) =>
      value ? input.value === value : input.value && !input.hasAttribute('data-clear')
    );
    choice.checked = true;
    choice.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    return;
  }
  if (type === 'boolean') {
    const box = wrap.querySelector('input[type="checkbox"]');
    box.checked = value !== '' && value !== false;
    box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    return;
  }
  const control = wrap.querySelector('input, textarea');
  control.value = value;
  control.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
}

/** Fill one required question with something plausible. @param {object} ctx @param {Element} wrap */
function fillWrap(ctx, wrap) {
  const key = wrap.dataset.field;
  const type = wrap.dataset.type;
  if (type === 'email') answer(ctx, key, 'someone@example.org');
  else if (type === 'url') answer(ctx, key, 'https://example.org');
  else if (type === 'select' || type === 'multiselect') answer(ctx, key, '');
  else if (type === 'boolean') answer(ctx, key, 'true');
  else answer(ctx, key, 'Value for ' + key);
}

/** Fill every required field with something plausible. @param {object} ctx */
function fillRequired(ctx) {
  ctx.form.querySelectorAll('[data-required="true"]').forEach((wrap) => fillWrap(ctx, wrap));
}

/** Fill only one step's required questions. @param {object} ctx @param {string} sectionKey */
function fillSection(ctx, sectionKey) {
  ctx.form
    .querySelectorAll('[data-section="' + sectionKey + '"] [data-required="true"]')
    .forEach((wrap) => fillWrap(ctx, wrap));
}

test('the card preview mirrors what has been typed', async () => {
  const ctx = await boot();
  answer(ctx, 'title', 'Service request routing');
  answer(ctx, 'summary', 'A daily brief for the response team.');
  assert.equal(ctx.document.querySelector('[data-preview-title]').textContent, 'Service request routing');
  assert.equal(
    ctx.document.querySelector('[data-preview-summary]').textContent,
    'A daily brief for the response team.'
  );
});

test('choosing a chip option renders the schema-styled chip, not raw text', async () => {
  const ctx = await boot();
  const chipField = ctx.form.querySelector('[data-slot="chip"]');
  const first = chipField.querySelector('input[value]:not([data-clear])');
  first.checked = true;
  first.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  const chips = ctx.document.querySelector('[data-preview-chips]');
  assert.equal(chips.hidden, false);
  assert.equal(chips.querySelectorAll('.chip').length, 1);
});

test('an image address fills the media band', async () => {
  const ctx = await boot();
  answer(ctx, 'screenshots', 'https://example.org/shot.png | The queue view');
  const media = ctx.document.querySelector('[data-preview-media]');
  assert.equal(media.hidden, false);
  assert.equal(ctx.document.querySelector('[data-preview-image]').alt, 'The queue view');
  assert.equal(ctx.form.querySelectorAll('[data-image-previews] img').length, 1);
});

test('submitting an empty form is blocked and announced', async () => {
  const ctx = await boot();
  submitForm(ctx);

  const summary = ctx.form.querySelector('[data-error-summary]');
  assert.equal(summary.hidden, false);
  // The panel takes focus, so announcing it as a live region as well would
  // deliver it twice.
  assert.equal(summary.getAttribute('role'), null);
  assert.equal(summary.getAttribute('tabindex'), '-1');
  const links = [...summary.querySelectorAll('.error-summary-link')];
  assert.ok(links.length >= 5, 'every required question in the step is listed');
  // Every link points at something real, and only at the step being left:
  // problems on later steps are that step's business when it is reached.
  for (const link of links) {
    const href = link.getAttribute('href');
    assert.notEqual(href, '#', `${link.textContent} links nowhere`);
    const target = ctx.document.querySelector(href);
    assert.ok(target, `${href} is not on the page`);
    assert.equal(target.closest('[data-section]').dataset.section, 'about');
  }
  const title = ctx.form.querySelector('[data-field="title"] input');
  assert.equal(title.getAttribute('aria-invalid'), 'true');
  assert.equal(ctx.opened.length, 0);
  assert.equal(ctx.form.querySelector('[data-section]').hidden, false, 'still on the first step');
  assert.equal(ctx.form.querySelector('[data-review]').hidden, true, 'no review step until it is valid');
});

test('following a summary link leaves the summary up for the other problems', async () => {
  const ctx = await boot();
  submitForm(ctx);
  const summary = ctx.form.querySelector('[data-error-summary]');
  summary.querySelector('.error-summary-link').click();
  assert.equal(summary.hidden, false);
  assert.equal(ctx.document.activeElement.closest('[data-field]').dataset.field, 'title');
});

test('error messages name the question and say what to do', async () => {
  const ctx = await boot();
  submitForm(ctx);
  const messageFor = (key) =>
    ctx.form.querySelector('[data-field="' + key + '"] .field-error').textContent.trim();
  const question = (key) => ctx.form.querySelector('[data-field="' + key + '"]').dataset.question;

  assert.equal(messageFor('title'), 'Enter an answer for “' + question('title') + '”');
  assert.equal(messageFor('stage'), 'Select an option for “' + question('stage') + '”');
  assert.equal(messageFor('area'), 'Select at least one option for “' + question('area') + '”');
});

test('aria-invalid marks the control at fault, not every box in the group', async () => {
  const ctx = await boot();
  submitForm(ctx);
  const wrap = ctx.form.querySelector('[data-field="area"]');
  const marked = wrap.querySelectorAll('[aria-invalid="true"]');
  assert.equal(marked.length, 1, 'one control carries the invalid state');
  assert.equal(marked[0], wrap.querySelector('input:not([data-clear])'));
});

test('a blocked step paints its problem count on the rail', async () => {
  const ctx = await boot();
  submitForm(ctx);
  const badge = ctx.document.querySelector('[data-progress-link="about"] [data-progress-errors]');
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /^\d+ to fix$/);
  // Steps the attempt never validated carry no badge yet.
  ctx.document
    .querySelectorAll('[data-progress-link]:not([data-progress-link="about"]) [data-progress-errors]')
    .forEach((other) => assert.equal(other.hidden, true));
});

test('the review step reads the answers back before anything is sent', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  answer(ctx, 'title', 'Service request routing');
  toReview(ctx);

  const panel = ctx.form.querySelector('[data-review]');
  assert.equal(panel.hidden, false);
  assert.equal(ctx.document.activeElement.id, 'review-heading');
  assert.equal(ctx.opened.length, 0, 'nothing is sent from the review step itself');
  // The questions are out of the way while the answers are being read back.
  Array.from(ctx.form.querySelectorAll('[data-section]')).forEach((section) => {
    assert.equal(section.hidden, true);
  });
  assert.match(panel.textContent, /Service request routing/);
  assert.match(panel.textContent, /What happens next/);
  assert.match(panel.textContent, /4\. GitHub gives your submission a number/);
  assert.ok(panel.querySelector('a[href="/status/"]'), '"what happens next" links to the status page');
  // Optional questions left blank are shown as such rather than dropped.
  assert.match(panel.textContent, /Not answered/);
});

test('Change takes you back to the question it belongs to', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  toReview(ctx);
  const rows = Array.from(ctx.form.querySelectorAll('[data-review] dl > dd button'));
  rows[0].click();
  assert.equal(ctx.form.querySelector('[data-review]').hidden, true);
  // The question is on the first step, so the stepper is brought back there.
  assert.equal(ctx.form.querySelector('[data-section]').hidden, false);
  assert.equal(ctx.document.activeElement, ctx.form.querySelector('[data-field="title"] input'));
});

test('a bad email is caught on blur', async () => {
  const ctx = await boot();
  answer(ctx, 'contact_email', 'not-an-address');
  const control = ctx.form.querySelector('[data-field="contact_email"] input');
  control.dispatchEvent(new ctx.window.Event('blur', { bubbles: true }));
  const error = ctx.form.querySelector('[data-field="contact_email"] .field-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /email address/);
});

test('a complete form opens a prefilled issue URL', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  answer(ctx, 'title', 'Service request routing');
  sendToGitHub(ctx);

  assert.equal(ctx.form.querySelector('[data-error-summary]').hidden, true);
  assert.equal(ctx.opened.length, 1);
  const url = new ctx.window.URL(ctx.opened[0]);
  assert.equal(url.hostname, 'github.com');
  assert.equal(url.searchParams.get('template'), 'new-entry.yml');
  assert.equal(url.searchParams.get('title'), ctx.form.dataset.titlePrefix + 'Service request routing');
  assert.equal(url.searchParams.get('title_key'), null);
  assert.equal(url.searchParams.get('contact_email'), 'someone@example.org');
  // A multi-select is a dropdown now, and GitHub prefills those: the answer
  // travels, comma-separated, the way the rendered form itself writes it.
  const area = ctx.form.querySelector('[data-field="area"]');
  const chosen = Array.from(area.querySelectorAll('input:checked')).map((input) => input.value);
  assert.equal(url.searchParams.get('area'), chosen.join(', '));
});

// GitHub's new-issue page reads ?body= and ?title= as its own (the plain issue
// body and the issue title), so a question with that id is never prefilled:
// confirmed live, the write-up keyed `body` showed its default skeleton. The
// generator and this page both rename such a key's id to `entry_<key>`, through
// assets/js/configurator/issue-form-ids.js, and the no-script route names the
// control the same way (the issue_form_id Liquid filter).
//
// The fixture is the template's own page, whatever schema this repository has,
// so the issue form compared against is generated from the fixture's fields.
async function fixtureIssueForm(ctx) {
  const { issueTemplateFromSchema } = await import('../../assets/js/configurator/issue-template.js');
  const fields = Array.from(ctx.form.querySelectorAll('[data-field]'), (wrap) => ({
    key: wrap.dataset.field,
    label: wrap.dataset.label,
    type: wrap.dataset.type,
    options: Array.from(wrap.querySelectorAll('input[value], option'), (node) => node.value).filter(Boolean),
  }));
  return jsYaml.load(issueTemplateFromSchema({ entry: { singular: 'Entry' }, fields }));
}

test('a field keyed like a GitHub parameter is prefilled under the id the issue form gives it', async () => {
  const ctx = await boot();
  const form = await fixtureIssueForm(ctx);
  const idFor = (label) => form.body.find((item) => item.attributes?.label === label)?.id;
  fillRequired(ctx);
  answer(ctx, 'title', 'Service request routing');
  answer(ctx, 'body', '## Problem\n\nCalls pile up.');
  sendToGitHub(ctx);
  const url = new ctx.window.URL(ctx.opened[0]);

  for (const [key, answerText] of [
    ['body', '## Problem\n\nCalls pile up.'],
    ['title', 'Service request routing'],
  ]) {
    const wrap = ctx.form.querySelector(`[data-field="${key}"]`);
    assert.ok(wrap, `the fixture has a "${key}" field`);
    const id = idFor(wrap.dataset.label);
    assert.ok(id, `the issue form has a question labelled "${wrap.dataset.label}"`);
    assert.notEqual(id, key, `the issue form does not give "${key}" an id GitHub claims`);
    assert.equal(url.searchParams.get(id), answerText, `the handoff sends the ${key} answer as ?${id}=`);
    assert.equal(
      wrap.querySelector('input, textarea').name,
      id,
      'the no-script route names the control the same'
    );
  }
  assert.equal(url.searchParams.get('body'), null, 'no plain issue body that would replace the form');
  assert.equal(url.searchParams.get('title'), ctx.form.dataset.titlePrefix + 'Service request routing');
});

test('every other field is prefilled under its own key, as before', async () => {
  const ctx = await boot();
  const ids = new Set((await fixtureIssueForm(ctx)).body.map((item) => item.id).filter(Boolean));
  const keys = Array.from(ctx.form.querySelectorAll('[data-field]'), (wrap) => wrap.dataset.field);
  const moved = keys.filter((key) => !ids.has(key));
  assert.deepEqual(moved.sort(), ['body', 'title']);
  for (const key of moved) assert.ok(ids.has('entry_' + key), `entry_${key} is in the issue form`);
});

test('the confirmation panel says the submission is not finished yet', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  await settle();
  sendToGitHub(ctx);

  const panel = ctx.form.querySelector('[data-review]');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Almost there/);
  assert.match(panel.textContent, /Submit new issue/);
  const reopen = panel.querySelector('a[target="_blank"]');
  assert.equal(reopen.href, ctx.opened[0], 'the prefilled link is kept, so the tab can be reopened');
  // What to do once it is filed: keep the number, watch for GitHub's emails,
  // and where to look it up (submit/index.md, template[data-after-submit]).
  assert.match(panel.textContent, /After you submit/);
  assert.match(panel.textContent, /GitHub gives your submission a number, like #42\. Keep it/);
  assert.match(panel.textContent, /GitHub emails you each time something changes/);
  const status = Array.from(panel.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/status/');
  assert.ok(status, 'the confirmation links to the status page');
  assert.equal(status.textContent, 'check where it stands');
  // The draft is the submitter's only copy until the issue is actually filed.
  assert.ok(ctx.storedDraft(), 'the draft survives the hand-off');
  press(ctx, 'Submitted it? Delete the saved draft');
  assert.equal(ctx.storedDraft(), null);
});

test('the Markdown fallback keeps the answers GitHub cannot prefill', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  const fields = ctx.window.SubmitForm.readFields(ctx.form);
  const body = ctx.window.SubmitForm.markdownBody(fields);
  const areaWrap = ctx.form.querySelector('[data-field="area"]');
  const chosen = areaWrap.querySelector('input:checked').value;
  assert.ok(body.includes('### ' + areaWrap.dataset.label));
  assert.ok(body.includes(chosen));
});

test('YAML front matter renders lists and links as blocks', async () => {
  const ctx = await boot();
  answer(ctx, 'title', 'Service request routing');
  answer(ctx, 'ai_tools', 'Azure OpenAI\nLangChain');
  answer(ctx, 'screenshots', 'https://example.org/shot.png | The queue view');
  const yaml = ctx.window.SubmitForm.yamlFrontMatter(ctx.window.SubmitForm.readFields(ctx.form));
  assert.match(yaml, /^---\n/);
  assert.match(yaml, /ai_tools:\n {2}- Azure OpenAI\n {2}- LangChain/);
  assert.match(yaml, /screenshots:\n {2}- src: https:\/\/example\.org\/shot\.png\n {4}alt: The queue view/);
});

test('a draft is autosaved and can be restored', async () => {
  const ctx = await boot();
  answer(ctx, 'title', 'Draft in progress');
  await new Promise((resolve) => setTimeout(resolve, 700));

  const key = 'catalog-template:submit-draft:v2:' + ctx.form.dataset.draftKey;
  const saved = JSON.parse(ctx.window.localStorage.getItem(key));
  assert.equal(saved.fields.title, 'Draft in progress');
  assert.match(
    ctx.form.querySelector('[data-draft-status]').textContent,
    /Saved just now — on this device only\./
  );

  answer(ctx, 'title', '');
  ctx.form.querySelector('[data-draft-action="restore"]').click();
  assert.equal(ctx.form.querySelector('[data-field="title"] input').value, 'Draft in progress');
  assert.equal(ctx.document.querySelector('[data-preview-title]').textContent, 'Draft in progress');

  ctx.form.querySelector('[data-draft-action="clear"]').click();
  assert.equal(ctx.window.localStorage.getItem(key), null);
});

test('the progress rail counts completed sections', async () => {
  const ctx = await boot();
  const line = ctx.form.querySelector('[data-progress-line]');
  assert.match(line.textContent, /^0 of /);
  const total = Number(/of (\d+) sections/.exec(line.textContent)[1]);

  // Answering every required field completes every section that has one.
  const expected = new Set(
    Array.from(ctx.form.querySelectorAll('[data-required="true"]')).map(
      (wrap) => wrap.closest('[data-section]').dataset.section
    )
  );
  fillRequired(ctx);
  assert.equal(line.textContent, expected.size + ' of ' + total + ' sections complete');
  const done = Array.from(ctx.document.querySelectorAll('[data-progress-link][data-done="true"]')).map(
    (link) => link.dataset.progressLink
  );
  assert.deepEqual(new Set(done), expected);
});

test('links rows can be added, filled and serialized', async () => {
  const ctx = await boot();
  const wrap = ctx.form.querySelector('[data-field="resources"]');
  wrap.querySelector('[data-links-add]').click();
  const rows = wrap.querySelectorAll('[data-links-rows] > *');
  assert.equal(rows.length, 2);
  rows[0].querySelector('[data-links-label]').value = 'Evaluation';
  rows[0].querySelector('[data-links-url]').value = 'https://example.org/eval.pdf';
  const field = ctx.window.SubmitForm.readFields(ctx.form).find((f) => f.key === 'resources');
  assert.equal(ctx.window.SubmitForm.serialize(field), 'Evaluation | https://example.org/eval.pdf');
});

test('autosave is held while the restore prompt is unanswered', async () => {
  const ctx = await boot({ draft: { title: 'Saved earlier' } });
  assert.equal(ctx.form.querySelector('[data-draft-restore]').hidden, false);

  // Typing before the prompt is answered must not overwrite the saved draft.
  answer(ctx, 'title', 'Typed over the offer');
  await settle();
  assert.equal(ctx.storedDraft().fields.title, 'Saved earlier');

  ctx.form.querySelector('[data-draft-action="restore"]').click();
  assert.equal(ctx.form.querySelector('[data-field="title"] input').value, 'Saved earlier');
  assert.equal(ctx.form.querySelector('[data-draft-restore]').hidden, true);

  // ...and autosave resumes once the decision is made.
  answer(ctx, 'title', 'Typed after restoring');
  await settle();
  assert.equal(ctx.storedDraft().fields.title, 'Typed after restoring');
});

test('discarding the prompt clears the draft and resumes autosave', async () => {
  const ctx = await boot({ draft: { title: 'Saved earlier' } });
  ctx.form.querySelector('[data-draft-action="discard"]').click();
  assert.equal(ctx.storedDraft(), null);
  assert.equal(ctx.form.querySelector('[data-draft-restore]').hidden, true);

  answer(ctx, 'title', 'A fresh start');
  await settle();
  assert.equal(ctx.storedDraft().fields.title, 'A fresh start');
});

test('a blocked pop-up keeps the draft and offers the link instead', async () => {
  const ctx = await boot({ popupBlocked: true });
  fillRequired(ctx);
  await settle();
  assert.ok(ctx.storedDraft(), 'a draft should exist before submitting');

  sendToGitHub(ctx);

  const link = ctx.form.querySelector('[data-fallback-link]');
  assert.equal(link.hidden, false);
  assert.equal(link.href, ctx.opened[0]);
  assert.match(ctx.form.querySelector('[data-submit-status]').textContent, /blocked the new tab/);
  // The answers are the submitter's only copy until the issue is actually filed.
  assert.ok(ctx.storedDraft(), 'the draft must survive a blocked pop-up');
});

test('a pop-up that opens leaves the fallback hidden', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  await settle();
  sendToGitHub(ctx);

  assert.equal(ctx.form.querySelector('[data-fallback-link]').hidden, true);
});

test('a length warning appears before the link stops fitting', async () => {
  const ctx = await boot();
  const note = ctx.form.querySelector('[data-length-note]');
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.hidden, true);

  answer(ctx, 'summary', 'x'.repeat(6000));
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /getting long|too long/);
});

test('answers too long for a link fall back to the empty issue form, never a blank issue', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  answer(ctx, 'summary', 'x'.repeat(8000));
  await settle();
  sendToGitHub(ctx);

  assert.equal(ctx.opened.length, 0, 'no tab should open for an over-long URL');
  const link = ctx.form.querySelector('[data-fallback-link]');
  assert.equal(link.hidden, false, 'the empty-form link is the way in');
  assert.equal(link.href, 'https://github.com/crypticpy/phct/issues/new?template=new-entry.yml');
  const status = ctx.form.querySelector('[data-submit-status]').textContent;
  assert.match(status, /too long to carry across/);
  assert.doesNotMatch(status, /blank issue/, 'blank issues are disabled — never send anyone there');
});

test('the preview strip caps signals the way the card does', async () => {
  const ctx = await boot();
  tick(ctx, 'readiness', 3);
  tick(ctx, 'data_sensitivity', 3);

  const strip = ctx.document.querySelector('[data-preview-signals]');
  const items = strip.children;
  assert.equal(items.length, 4, 'at most four items, the "+n" included');
  assert.equal(items[items.length - 1].textContent, '+3');
  assert.equal(ctx.document.querySelector('[data-preview-foot]').hidden, false);
});

test('the preview card mirrors the real card element and class names', async () => {
  const ctx = await boot();
  const card = ctx.document.querySelector('[data-preview]');
  assert.equal(card.tagName, 'ARTICLE');
  assert.ok(card.classList.contains('entry-card'));
  [
    'entry-media',
    'entry-body',
    'entry-meta',
    'entry-title',
    'entry-line',
    'entry-summary',
    'entry-chips',
    'entry-foot',
    'signal-strip',
  ].forEach((name) => {
    assert.ok(card.querySelector('.' + name), name + ' is missing from the preview');
  });
  // The card's title is not a heading, so the preview's must not be either.
  assert.equal(ctx.document.querySelector('[data-preview-title]').tagName, 'P');
});

test('link rows are numbered for screen readers and adding one moves focus', async () => {
  const ctx = await boot();
  const wrap = ctx.form.querySelector('[data-field="resources"]');
  const add = wrap.querySelector('[data-links-add]');
  add.click();
  add.click();

  const labels = () =>
    Array.from(wrap.querySelectorAll('[data-links-remove]'), (button) => button.getAttribute('aria-label'));
  assert.deepEqual(labels(), ['Remove link 1', 'Remove link 2', 'Remove link 3']);
  const rows = wrap.querySelectorAll('[data-links-rows] > *');
  assert.equal(ctx.document.activeElement, rows[2].querySelector('[data-links-label]'));
  assert.equal(rows[2].querySelector('[data-links-url]').getAttribute('aria-label'), 'Link 3 address');

  wrap.querySelectorAll('[data-links-remove]')[0].click();
  assert.deepEqual(labels(), ['Remove link 1', 'Remove link 2']);
});

test('the preview meta line uses the card segment class that draws the separator', async () => {
  const ctx = await boot();
  answer(ctx, 'organization', 'City of Testville');
  answer(ctx, 'stage', '');
  const meta = ctx.document.querySelector('[data-preview-meta]');
  assert.equal(meta.hidden, false);
  const segments = Array.from(meta.querySelectorAll('.entry-meta-seg'));
  assert.ok(segments.length >= 2, 'expected at least two meta segments');
  // Only the free-text organization segment takes the flex/truncate modifier;
  // the option-valued stage keeps the plain segment class.
  const flagged = segments.filter((segment) => segment.classList.contains('entry-meta-seg--text'));
  assert.deepEqual(
    flagged.map((segment) => segment.textContent),
    ['City of Testville']
  );
  // The dot is a ::before on the class, never an element in the strip.
  assert.equal(meta.textContent.includes('\u00b7'), false);
});

test('the restore bar says when the draft was saved and how much of it there is', async () => {
  const ctx = await boot({ draft: { title: 'Saved earlier', organization: 'City of Testville' } });
  const bar = ctx.form.querySelector('[data-draft-restore]');
  assert.equal(bar.hidden, false);
  assert.match(bar.querySelector('[data-draft-saved]').textContent, /saved just now on this device/);
  const total = ctx.form.querySelectorAll('[data-field]').length;
  assert.equal(bar.querySelector('[data-draft-count]').textContent, '2 of ' + total + ' answers.');
  assert.equal(
    bar.querySelector('[data-draft-action="discard"]').textContent.trim(),
    'Delete it and start fresh'
  );
});

test('a draft saved against a question that no longer exists is dropped, and said so', async () => {
  const ctx = await boot({ draft: { title: 'Saved earlier', retired_question: 'Orphaned answer' } });
  ctx.form.querySelector('[data-draft-action="restore"]').click();
  const status = ctx.form.querySelector('[data-draft-status]').textContent;
  assert.match(status, /Restored 1 answer\./);
  assert.match(status, /1 answer was saved for questions this form no longer asks/);
  assert.equal(ctx.form.querySelector('[data-field="title"] input').value, 'Saved earlier');
});

test('"Save and come back later" writes the draft without waiting for the debounce', async () => {
  const ctx = await boot();
  answer(ctx, 'title', 'Half finished');
  ctx.form.querySelector('[data-draft-action="save"]').click();
  assert.equal(ctx.storedDraft().fields.title, 'Half finished');
  assert.match(ctx.form.querySelector('[data-draft-status]').textContent, /Saved\. Come back/);
});

test('a browser that refuses storage says so where the draft bar would be', async () => {
  const ctx = await boot();
  // Re-boot with localStorage throwing, the way a locked-down private window does.
  Object.defineProperty(ctx.window, 'localStorage', {
    configurable: true,
    get() {
      throw new ctx.window.Error('access denied');
    },
  });
  ctx.window.SubmitForm.init(ctx.document);
  const note = ctx.form.querySelector('[data-draft-unavailable]');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /will not save a draft/);
});

test('the form still works without scripts', async () => {
  const dom = new JSDOM('<!doctype html><body>' + HTML + '</body>', {
    url: 'https://example.org/submit/',
  });
  booted.push(dom);
  const form = dom.window.document.querySelector('[data-submit-form]');

  // A plain GET to the issue form: the control names are its input ids.
  assert.equal(form.getAttribute('method'), 'get');
  assert.match(form.getAttribute('action'), /^https:\/\/github\.com\/.+\/issues\/new$/);
  assert.equal(form.querySelector('input[type="hidden"][name="template"]').value, 'new-entry.yml');
  // No `novalidate` in the markup: without scripts, the browser's own
  // required-field messages are all there is.
  assert.equal(form.hasAttribute('novalidate'), false);

  const wrap = form.querySelector('[data-field="title"]');
  assert.equal(wrap.querySelector('input').required, true);
  const optional = form.querySelector('[data-field="impact"]');
  assert.equal(optional.querySelector('input').required, false);
  // "Tick at least one" has no HTML spelling, so a required multiselect keeps
  // aria-required and is checked by script only.
  const multi = form.querySelector('[data-field="area"]');
  assert.equal(multi.querySelector('input').required, false);
  assert.equal(multi.querySelector('input').getAttribute('aria-required'), 'true');

  const noscript = dom.window.document.querySelector('noscript');
  assert.ok(noscript, 'a <noscript> explanation is present');
  // jsdom parses <noscript> children as elements when scripting is off and as
  // raw text when it is on, so handle both rather than depend on the setting.
  const fallback =
    noscript.querySelector('textarea') || JSDOM.fragment(noscript.textContent).querySelector('textarea');
  assert.match(fallback.value, /^### /, 'the copy-paste outline is pre-filled');
  // Every question except the file upload, which has no issue-body heading.
  Array.from(form.querySelectorAll('[data-field]'))
    .filter((node) => node.dataset.type !== 'file')
    .forEach((node) => {
      assert.ok(fallback.value.includes('### ' + node.dataset.label), node.dataset.label);
    });
});

test('scripts turn the browser validation off, so this page can do it better', async () => {
  const ctx = await boot();
  assert.equal(ctx.form.hasAttribute('novalidate'), true);
});

test('the questions mark what is optional rather than what is required', async () => {
  const ctx = await boot();
  const optional = ctx.form.querySelector('[data-field="impact"]');
  assert.match(optional.textContent, /\(optional\)/);
  const required = ctx.form.querySelector('[data-field="title"]');
  assert.doesNotMatch(required.textContent, /\(optional\)/);
  assert.equal(ctx.form.querySelectorAll('.field-required').length, 0, 'no REQUIRED pills remain');
});

test('the form opens as one step at a time', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  assert.ok(sections.length > 1, 'the fixture schema has more than one section');
  assert.equal(sections[0].hidden, false);
  sections.slice(1).forEach((section) => assert.equal(section.hidden, true));

  // The first step has no Back, the closing block waits for the last step.
  const nav = sections[0].querySelector('[data-step-nav]');
  assert.equal(nav.hidden, false);
  assert.equal(nav.querySelector('[data-step-action="back"]').hidden, true);
  assert.equal(nav.querySelector('[data-step-action="next"]').hidden, false);
  assert.equal(ctx.form.querySelector('[data-step-finish]').hidden, true);

  // The rail marks the current step, wizard-style.
  const first = ctx.document.querySelector('[data-progress-link="' + sections[0].dataset.section + '"]');
  assert.equal(first.getAttribute('aria-current'), 'step');
});

test('Next moves on when the step is clean, and Back returns freely', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  fillSection(ctx, sections[0].dataset.section);
  sections[0].querySelector('[data-step-action="next"]').click();

  assert.equal(sections[0].hidden, true);
  assert.equal(sections[1].hidden, false);
  // The heading takes focus: the step change is its own announcement.
  const heading = sections[1].querySelector('h2');
  assert.equal(ctx.document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
  assert.match(ctx.form.querySelector('[data-progress-section]').textContent, /\S/);

  // Back is free even though the step it returns through is now incomplete.
  sections[1].querySelector('[data-step-action="back"]').click();
  assert.equal(sections[0].hidden, false);
  assert.equal(ctx.document.activeElement, sections[0].querySelector('h2'));
});

test('a step with problems cannot be left forward', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  sections[0].querySelector('[data-step-action="next"]').click();
  assert.equal(sections[0].hidden, false, 'the move is refused');
  assert.equal(ctx.form.querySelector('[data-error-summary]').hidden, false);
});

test('a forward jump on the rail validates the steps it would skip', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  fillSection(ctx, sections[0].dataset.section);
  // Jump from step 1 to step 3: step 2 is empty, so the jump stops there.
  ctx.document.querySelector('[data-progress-link="' + sections[2].dataset.section + '"]').click();
  assert.equal(sections[2].hidden, true);
  assert.equal(sections[1].hidden, false);
  assert.equal(ctx.form.querySelector('[data-error-summary]').hidden, false);
  const badge = ctx.document.querySelector(
    '[data-progress-link="' + sections[1].dataset.section + '"] [data-progress-errors]'
  );
  assert.equal(badge.hidden, false);
});

test('Enter before the last step moves on instead of submitting', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  fillSection(ctx, sections[0].dataset.section);
  submitForm(ctx);
  assert.equal(sections[1].hidden, false);
  assert.equal(ctx.form.querySelector('[data-review]').hidden, true);
  assert.equal(ctx.opened.length, 0);
});

test('the short form hides unanswered optional questions and skips emptied steps', async () => {
  const ctx = await boot();
  const toggle = ctx.form.querySelector('[data-shortform-toggle]');
  toggle.click();

  assert.equal(ctx.form.querySelector('[data-field="impact"]').hidden, true, 'optional hides');
  assert.equal(ctx.form.querySelector('[data-field="title"]').hidden, false, 'required stays');
  assert.equal(toggle.textContent, 'Show every question');
  const note = ctx.form.querySelector('[data-shortform-note]');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^\d+ optional questions hidden\.$/);

  // A step with no required questions has nothing left: the rail dims it and
  // refuses to go there.
  const cost = ctx.document.querySelector('[data-progress-link="cost"]');
  assert.equal(cost.dataset.skipped, 'true');
  assert.equal(cost.getAttribute('aria-disabled'), 'true');
  cost.click();
  assert.equal(ctx.form.querySelector('[data-section="cost"]').hidden, true);
  assert.equal(ctx.form.querySelector('[data-section]').hidden, false, 'still on the first step');

  toggle.click();
  assert.equal(ctx.form.querySelector('[data-field="impact"]').hidden, false);
  assert.equal(note.hidden, true);
  assert.equal(cost.dataset.skipped, 'false');
});

test('the short form keeps answered optional questions on screen', async () => {
  const ctx = await boot();
  answer(ctx, 'impact', 'Cut triage time in half');
  ctx.form.querySelector('[data-shortform-toggle]').click();
  assert.equal(ctx.form.querySelector('[data-field="impact"]').hidden, false);
});

test('moving on saves the step and the short-form mode with the draft', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  fillSection(ctx, sections[0].dataset.section);
  sections[0].querySelector('[data-step-action="next"]').click();
  await settle();
  assert.deepEqual(ctx.storedDraft().ui, { step: sections[1].dataset.section, short: false });
});

test('a restored draft reopens on the step it was left at, in the same mode', async () => {
  const ctx = await boot({ draft: { title: 'Saved earlier' }, ui: { step: 'build', short: true } });
  ctx.form.querySelector('[data-draft-action="restore"]').click();
  assert.equal(ctx.form.querySelector('[data-section="build"]').hidden, false);
  assert.equal(ctx.form.querySelector('[data-field="impact"]').hidden, true, 'short mode is back on');
  assert.equal(ctx.form.querySelector('[data-shortform-toggle]').textContent, 'Show every question');
});

test('review Change reveals a question the short form hid', async () => {
  const ctx = await boot();
  ctx.form.querySelector('[data-shortform-toggle]').click();
  fillRequired(ctx);
  toReview(ctx);

  const wrap = ctx.form.querySelector('[data-field="impact"]');
  const question = wrap.dataset.question;
  // The Change button says which question it changes in sr-only text beside it.
  const row = Array.from(ctx.form.querySelectorAll('[data-review] dl > dd')).find(
    (dd) => dd.querySelector('button') && dd.textContent.includes(question)
  );
  assert.ok(row, 'the hidden question still has a review row');
  row.querySelector('button').click();
  assert.equal(wrap.hidden, false, 'the short form gives the question back');
  assert.equal(wrap.closest('[data-section]').hidden, false);
  assert.equal(ctx.document.activeElement, wrap.querySelector('input, textarea'));
});

test('the draft controls and status regions live on every step, not the last', async () => {
  const ctx = await boot();
  // Hiding a role="status" region silences it, so none of these may sit in
  // the [data-step-finish] block the stepper hides until the last step.
  // [data-submit-status] is here too: the copy-out fallback stays visible on
  // every step once shown, and its Copy button writes its feedback there.
  ['[data-draft-status]', '[data-length-note]', '[data-submit-status]', '[data-draft-action="save"]'].forEach(
    (selector) => {
      const node = ctx.form.querySelector(selector);
      assert.equal(node.parentElement.closest('[hidden]'), null, selector + ' is inside a hidden block');
    }
  );
  // ...while the submit controls do wait for the last step.
  const submit = ctx.form.querySelector('button[type="submit"]');
  assert.ok(submit.closest('[data-step-finish]'), 'the submit button waits with the finish block');
  assert.equal(ctx.form.querySelector('[data-step-finish]').hidden, true);
});

test('a last-step problem list survives following a cross-step link', async () => {
  const ctx = await boot();
  const sections = Array.from(ctx.form.querySelectorAll('[data-section]'));
  fillRequired(ctx);
  for (let i = 0; i < sections.length - 1; i += 1) submitForm(ctx);
  assert.equal(sections[sections.length - 1].hidden, false, 'the walk reached the last step');

  // Break an answer back on step 1, then ask for the full check.
  answer(ctx, 'title', '');
  submitForm(ctx);
  const summary = ctx.form.querySelector('[data-error-summary]');
  assert.equal(summary.hidden, false);
  summary.querySelector('.error-summary-link').click();
  assert.equal(summary.hidden, false, 'the other problems are still listed');
  assert.equal(sections[0].hidden, false, 'the link went back to the problem’s step');
  assert.equal(ctx.document.activeElement, ctx.form.querySelector('[data-field="title"] input'));
});

test('only radio groups get a way to un-pick themselves', async () => {
  const ctx = await boot();
  Array.from(ctx.form.querySelectorAll('[data-clear]')).forEach((input) => {
    const wrap = input.closest('[data-field]');
    assert.equal(wrap.dataset.type, 'select', wrap.dataset.field + ' is not a radio group');
    assert.equal(wrap.dataset.required, 'false');
  });
});
