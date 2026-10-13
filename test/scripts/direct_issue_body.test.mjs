/**
 * The issue body "Sign in with GitHub" sends (window.SubmitForm.issueFormBody,
 * assets/js/submit/handoff.js) against the body GitHub's own form writes for
 * the same answers, and what the entry scaffolder reads back from each.
 *
 * The page is the Liquid snapshot submit_form.test.mjs uses, and everything
 * compared against it comes from that page's own questions (pageSchema in
 * test/helpers/issue_form.mjs): GitHub's side is the form the generator
 * (assets/js/configurator/issue-template.js) writes for them, filled with
 * exactly what the link hand-off would have prefilled — so "the same answers"
 * is the hand-off's own definition — and the scaffolder runs in a throwaway
 * checkout holding that schema. Never this repository's own schema or issue
 * template: a deployment's update runs this file on its own questions, which
 * are not the snapshot's. The byte-for-byte comparison on the repository's own
 * schema, from a freshly built page and the form generate.mjs wrote, is in
 * test/build/variants.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import * as yaml from 'js-yaml';

import { issueTemplateFromSchema } from '../../assets/js/configurator/issue-template.js';
import { fillEveryField, githubFormBody, pageSchema } from '../helpers/issue_form.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'submit-form.html'), 'utf8');
const SCRIPTS = yaml
  .load(fs.readFileSync(path.join(ROOT, 'submit', 'index.md'), 'utf8').split(/^---$/m)[1])
  .scripts.map((src) => src.replace(/^\//, ''));
const SCAFFOLDER = path.join(ROOT, 'scripts', 'new_entry_from_issue.mjs');

// The throwaway checkout the scaffolder runs in: one file, _data/schema.yml,
// removed file by file when this file finishes.
const CHECKOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-body-'));
const CHECKOUT_SCHEMA = path.join(CHECKOUT, '_data', 'schema.yml');

const booted = [];
test.after(() => {
  booted.forEach((dom) => dom.window.close());
  if (fs.existsSync(CHECKOUT_SCHEMA)) fs.unlinkSync(CHECKOUT_SCHEMA);
  if (fs.existsSync(path.dirname(CHECKOUT_SCHEMA))) fs.rmdirSync(path.dirname(CHECKOUT_SCHEMA));
  fs.rmdirSync(CHECKOUT);
});

async function filledPage() {
  const dom = new JSDOM('<!doctype html><body>' + FIXTURE + '</body>', {
    url: 'https://example.org/submit/',
    runScripts: 'outside-only',
  });
  booted.push(dom);
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  SCRIPTS.forEach((rel) => window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  const form = window.document.querySelector('[data-submit-form]');
  const schema = pageSchema(form);
  const template = yaml.load(issueTemplateFromSchema(schema));
  const title = fillEveryField(window, form);
  const ns = window.SubmitForm;
  const fields = ns.readFields(form);
  const params = new URL(ns.issueUrl(form, fields, title)).searchParams;
  return {
    window,
    form,
    ns,
    fields,
    title,
    params,
    schema,
    template,
    issueTitle: form.dataset.titlePrefix + title,
  };
}

/** The scaffolder's dry run for one issue body against `schema`: the entry file it would write. */
function scaffold(body, title, schema) {
  fs.mkdirSync(path.dirname(CHECKOUT_SCHEMA), { recursive: true });
  fs.writeFileSync(CHECKOUT_SCHEMA, yaml.dump(schema), 'utf8');
  const result = spawnSync(process.execPath, [SCAFFOLDER, '--dry-run'], {
    cwd: CHECKOUT,
    env: { ...process.env, ISSUE_BODY: body, ISSUE_TITLE: title, ISSUE_NUMBER: '7', GITHUB_OUTPUT: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^---\n([\s\S]*?)\n---\n/m);
  assert.ok(match, `no front matter in:\n${result.stdout}`);
  return { front: yaml.load(match[1]), page: result.stdout.slice(match.index + match[0].length) };
}

test('the direct body is GitHub’s form body for the same answers, question for question', async () => {
  const { fields, ns, params, template } = await filledPage();
  const direct = ns.issueFormBody(fields);
  const github = githubFormBody(template, (id) => params.get(id) ?? '');
  assert.equal(direct, github);
  // Every answer the page sends travels: nothing blank but the file question.
  const blank = direct.split('\n\n### ').filter((section) => section.endsWith('\n\n_No response_'));
  assert.deepEqual(blank, ['Slide deck or one-pager (PDF)\n\n_No response_']);
});

test('the scaffolder reads the direct body exactly as it reads the form’s, every field', async () => {
  const { fields, ns, params, schema, template, issueTitle } = await filledPage();
  const direct = scaffold(ns.issueFormBody(fields), issueTitle, schema);
  const github = scaffold(
    githubFormBody(template, (id) => params.get(id) ?? ''),
    issueTitle,
    schema
  );
  assert.deepEqual(direct, github);
  assert.equal(direct.front.title, 'Water routing');
  // Every choice answer matched one of its question's options.
  assert.doesNotMatch(direct.page, /Answers to fix/);
  // The write-up's own "### " line stayed prose, not a section.
  assert.match(direct.page, /### Not a real heading/);
});

test('an image question’s address is sent, though the hand-off link cannot carry it', async () => {
  const { window, form, ns } = await filledPage();
  // The snapshot has no `image` question; one is a URL input marked as such.
  const wrap = form.querySelector('[data-type="url"]');
  wrap.dataset.type = 'image';
  wrap.dataset.prefill = 'false';
  const field = ns.readFields(form).find((candidate) => candidate.wrap === wrap);
  const input = wrap.querySelector('input');
  assert.equal(ns.issueFormBody([field]), '### ' + field.label + '\n\n' + input.value);
  assert.ok(!new URL(ns.issueUrl(form, [field], 'x')).search.includes(encodeURIComponent(input.value)));
  input.value = '';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ns.issueFormBody([field]), '### ' + field.label + '\n\n_No response_');
});
