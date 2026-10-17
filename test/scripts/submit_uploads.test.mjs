/**
 * File uploads on the submit page (assets/js/submit/uploads.js,
 * uploads-view.js and uploads-core.js), driven through a real DOM.
 *
 * Same harness as submit_direct.test.mjs: the Liquid snapshot of /submit/ with
 * the markup submit/index.md adds when `submit.signin_url` and
 * `submit.uploads_url` are set laid over it (`data-signin-url`,
 * `data-uploads-url`), and the shipped scripts in the order the page loads
 * them. GitHub's API and the upload service are stand-ins; so are the canvas
 * re-encode and the sleep between retries, which JSDOM cannot do (injected
 * through `window.SubmitForm.uploadHooks`, the seam uploads.js documents).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import * as jsYaml from 'js-yaml';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FIXTURE = read('test/fixtures/submit-form.html');
const INDEX = read('submit/index.md');
const SCRIPTS = jsYaml.load(INDEX.split(/^---$/m)[1]).scripts.map((src) => src.replace(/^\//, ''));
const DIRECT = read('assets/js/submit/direct.js');
const CORE = read('assets/js/submit/uploads-core.js');
const VIEW = read('assets/js/submit/uploads-view.js');
const UPLOADS = read('assets/js/submit/uploads.js');

const SIGNIN = 'https://signin.example';
const UPLOADS_URL = 'https://uploads.example';
const PAGE = 'https://example.org/submit/';
const REPO = 'crypticpy/phct';
const TOKEN = 'ghu_' + 'a'.repeat(36);
const STORE = 'phct:github-signin:v1:' + REPO + '@' + SIGNIN;
const ISSUES_URL = 'https://api.github.com/repos/' + REPO + '/issues';
const DRAFT_KEY = 'catalog-template:submit-draft:v2:' + /data-draft-key="([^"]+)"/.exec(FIXTURE)[1];
const SET_RE = /^[a-z2-7]{26}$/;
const REF_RE = /^upload:[a-z2-7]{26}\/[0-9a-f]{64}\.(png|jpg|webp|pdf)$/;

const NOTICE =
  '<p data-form-chrome data-signin-notice><svg data-icon="warning"></svg><span>Sign in first.</span></p>' +
  '<ol><li><span data-handoff-copy>Press <em>Submit new issue</em> on GitHub</span><span data-direct-copy hidden>Press <em>Submit to GitHub</em></span></li></ol>';
const HANDOFF_STEP =
  '<li>1. Sending opens a GitHub issue with your answers already filled in. Nothing is submitted until you press <em>Submit new issue</em> there.</li>';

/** The fixture as a site with the given switches renders it. */
function page({ signin = true, uploads = true } = {}) {
  assert.ok(FIXTURE.includes(HANDOFF_STEP), 'the fixture no longer has the hand-off step');
  const attrs =
    (signin ? ' data-signin-url="' + SIGNIN + '"' : '') +
    (uploads ? ' data-uploads-url="' + UPLOADS_URL + '"' : '');
  return (
    NOTICE +
    FIXTURE.replace(' data-submit-form=""', ' data-submit-form=""' + attrs).replace(
      HANDOFF_STEP,
      '<li>1. <span data-handoff-copy>Sending opens a GitHub issue.</span><span data-direct-copy hidden>Submitting creates a GitHub issue.</span></li>'
    )
  );
}

const booted = [];
test.after(() => booted.forEach((dom) => dom.window.close()));

const flush = () =>
  new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
/** Let chains of awaited stand-ins (re-encode, send, sleep) run to the end. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await flush();
}
const settleDraft = () => new Promise((resolve) => setTimeout(resolve, 700));

function reply(status, data, retryAfter = null) {
  return { status, retryAfter, data };
}

/** A fixed 64-hex digest per upload, so refs are predictable. */
const digest = (n) =>
  String(n)
    .padStart(64, '0')
    .replace(/0/g, (_, i) => (i % 2 ? 'a' : 'b'));

/**
 * A booted submit page.
 * @param {object} [options]
 * @param {boolean} [options.signin=true]  data-signin-url on the form
 * @param {boolean} [options.uploads=true] data-uploads-url and the upload scripts
 * @param {boolean} [options.signedIn=true] a token in sessionStorage
 * @param {object} [options.user] what GET /user answers
 * @param {string} [options.draft] raw localStorage draft to start from
 * @param {(request: object, ctx: object) => any} [options.send] the upload service
 * @param {(file: File) => any} [options.reencode] the canvas
 * @param {number} [options.issueStatus=201] what POST /issues answers
 */
async function boot(options = {}) {
  const dom = new JSDOM('<!doctype html><body>' + page(options) + '</body>', {
    url: PAGE,
    runScripts: 'outside-only',
  });
  booted.push(dom);
  const { window } = dom;
  const ctx = {
    window,
    document: window.document,
    requests: [],
    uploadsSent: [],
    sleeps: [],
    reencoded: [],
    opened: [],
    count: 0,
  };

  const send = async (request) => {
    ctx.uploadsSent.push(request);
    if (options.send) return options.send(request, ctx);
    if (request.method === 'DELETE') return reply(204, null);
    ctx.count += 1;
    const kind = request.headers['X-Upload-Kind'];
    const ext = kind === 'pdf' ? 'pdf' : 'png';
    const sha = digest(ctx.count);
    return reply(201, {
      ref: 'upload:' + request.headers['X-Upload-Set'] + '/' + sha + '.' + ext,
      sha256: sha,
      bytes: request.body.size,
      ext,
    });
  };
  window.SubmitForm = {
    uploadHooks: {
      send,
      sleep: async (ms) => {
        ctx.sleeps.push(ms);
      },
      reencode: async (file) => {
        if (options.reencode) return options.reencode(file);
        ctx.reencoded.push(file);
        return { blob: new window.Blob(['re-encoded ' + file.name], { type: file.type }), type: file.type };
      },
    },
  };

  window.open = (url) => {
    ctx.opened.push(url);
    return {};
  };
  window.fetch = (url, init = {}) => {
    ctx.requests.push({ url, init });
    if (url === 'https://api.github.com/user')
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(options.user || { login: 'octo-cat', id: 1001 }),
      });
    if (url === ISSUES_URL && init.method === 'POST' && options.issueStatus)
      return Promise.resolve({
        status: options.issueStatus,
        ok: false,
        json: () => Promise.resolve({ message: 'Validation Failed' }),
      });
    if (url === ISSUES_URL && init.method === 'POST')
      return Promise.resolve({
        status: 201,
        ok: true,
        json: () => Promise.resolve({ number: 42, html_url: 'https://github.com/' + REPO + '/issues/42' }),
      });
    return Promise.reject(new TypeError('unexpected request to ' + url));
  };
  if (options.signedIn !== false)
    window.sessionStorage.setItem(STORE, JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 3600000 }));
  if (options.draft) window.localStorage.setItem(DRAFT_KEY, options.draft);

  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  ctx.form = window.document.querySelector('[data-submit-form]');
  ctx.rawDraft = () => window.localStorage.getItem(DRAFT_KEY);
  ctx.storedDraft = () => JSON.parse(ctx.rawDraft() || 'null');
  ctx.live = () => ctx.form.querySelector('[data-uploads-live]');

  if (options.signin !== false) window.eval(DIRECT);
  if (options.uploads !== false) {
    window.eval(CORE);
    window.eval(VIEW);
    window.eval(UPLOADS);
  }
  SCRIPTS.forEach((rel) => window.eval(read(rel)));
  await settle();
  ctx.fields = window.SubmitForm.readFields(ctx.form);
  return ctx;
}

const wrapOf = (ctx, key) => ctx.form.querySelector('[data-field="' + key + '"]');
const pickerOf = (ctx, key) => wrapOf(ctx, key).querySelector('input[type="file"]');
const rowsOf = (ctx, key) => Array.from(wrapOf(ctx, key).querySelectorAll('[data-upload-item]'));

/** Pick files the way the browser reports them, then let the uploads run. */
async function pick(ctx, key, files) {
  const input = pickerOf(ctx, key);
  assert.ok(input, 'no file picker for ' + key);
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  await settle();
}

const file = (ctx, name, type, size = 10) => new ctx.window.File([new Uint8Array(size)], name, { type });
const png = (ctx, name = 'shot.png') => file(ctx, name, 'image/png');
const pdf = (ctx, name = 'deck.pdf', size = 10) => file(ctx, name, 'application/pdf', size);

function describe(ctx, key, index, alt) {
  const input = rowsOf(ctx, key)[index].querySelector('[data-upload-alt]');
  input.value = alt;
  input.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
}

function answer(ctx, key, value) {
  // The screenshots question’s typed addresses live in its textarea; its file
  // picker is an input too.
  const control = wrapOf(ctx, key).querySelector(key === 'screenshots' ? 'textarea' : 'input, textarea');
  control.value = value;
  control.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
}

function fillRequired(ctx) {
  ctx.form.querySelectorAll('[data-required="true"]').forEach((wrap) => {
    const type = wrap.dataset.type;
    const key = wrap.dataset.field;
    if (type === 'select' || type === 'multiselect') {
      const input = wrap.querySelector('input[value]:not([data-clear])');
      if (input) {
        input.checked = true;
        input.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
      } else {
        const select = wrap.querySelector('select');
        select.value = Array.from(select.options).find((o) => o.value !== '').value;
        select.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
      }
    } else if (type === 'boolean') {
      const box = wrap.querySelector('input[type="checkbox"]');
      box.checked = true;
      box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    } else if (type === 'email') answer(ctx, key, 'someone@example.org');
    else if (type === 'url') answer(ctx, key, 'https://example.org');
    else if (type !== 'file' && type !== 'images') answer(ctx, key, 'Value for ' + key);
  });
  answer(ctx, 'title', 'Water routing');
}

/** Press through the steps; true when the review panel opened. */
function tryReview(ctx) {
  const cap = ctx.form.querySelectorAll('[data-section]').length + 1;
  for (let i = 0; i < cap; i += 1) {
    ctx.form.dispatchEvent(new ctx.window.Event('submit', { bubbles: true, cancelable: true }));
    if (!ctx.form.querySelector('[data-review]').hidden) return true;
  }
  return false;
}

const summaryText = (ctx) => ctx.form.querySelector('[data-error-summary]').textContent;

/** Drive the review panel's send button. */
async function submitToGitHub(ctx) {
  const button = Array.from(ctx.form.querySelectorAll('[data-review] button')).find(
    (b) => b.textContent.trim() === 'Submit to GitHub'
  );
  assert.ok(button, 'no Submit to GitHub button');
  button.click();
  await settle();
}

/* ------------------------------------------------------------- off */

test('feature off: no pickers, no script, no data attribute — in the markup and at runtime', async () => {
  // The Liquid: the attribute and both scripts exist only inside the guard,
  // and the guard needs a sign-in service first (the signin_url pattern).
  assert.match(
    INDEX,
    /\{%- assign uploads_url = '' -%\}\n\{%- if signin_url != '' -%\}\{%- assign uploads_url = cfg\.submit\.uploads_url \| default: '' \| strip -%\}\{%- endif -%\}/
  );
  assert.match(
    INDEX,
    /\{% if uploads_url != '' %\}\s*data-uploads-url="\{\{ uploads_url \| escape \}\}"\{% endif %\}/
  );
  const scripts = INDEX.split('\n').filter(
    (line) => /uploads(-core|-view)?\.js/.test(line) && line.includes('<script')
  );
  assert.equal(scripts.length, 3);
  const block = INDEX.slice(INDEX.indexOf("{%- if uploads_url != '' %}\n{%- comment -%} Also before"));
  assert.ok(
    scripts.every((line) => block.includes(line)),
    'an uploads script sits outside the uploads_url guard'
  );
  assert.ok(
    !SCRIPTS.some((src) => /uploads/.test(src)),
    'the uploads scripts must not be in the always-on list'
  );
  // _data/site.yml belongs to the deployment (merge=ours), which may have
  // turned uploads on, so off-by-default is checked on the snapshot below.
  assert.doesNotMatch(FIXTURE, /uploads/i, 'the off-by-default snapshot mentions uploads');

  // At runtime: signed in, but no uploads script and no attribute.
  const ctx = await boot({ uploads: false });
  assert.equal(ctx.form.dataset.uploadsUrl, undefined);
  assert.equal(typeof ctx.window.SubmitForm.initUploads, 'undefined');
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
  assert.equal(ctx.form.querySelector('[data-uploads]'), null);
  assert.equal(ctx.form.querySelector('[data-uploads-live]'), null);
});

test('data-uploads-url without a sign-in service does nothing (initUploads is only called with direct)', async () => {
  const ctx = await boot({ signin: false });
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
});

test('signed out: no pickers at all', async () => {
  const ctx = await boot({ signedIn: false });
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
  assert.equal(ctx.form.querySelector('[data-uploads]:not([hidden])'), null);
  assert.equal(ctx.uploadsSent.length, 0);
});

test('signed in: a picker for every screenshots question and every file question', async () => {
  const ctx = await boot();
  const images = ctx.fields.filter((f) => f.type === 'images');
  const files = ctx.fields.filter((f) => f.type === 'file');
  assert.ok(images.length > 0 && files.length > 0);
  assert.equal(ctx.form.querySelectorAll('input[type="file"]').length, images.length + files.length);
  images.forEach((f) => {
    const input = pickerOf(ctx, f.key);
    assert.equal(input.accept, 'image/png,image/jpeg,image/webp');
    assert.equal(input.multiple, true);
    assert.doesNotMatch(input.accept, /gif/);
  });
  files.forEach((f) => {
    const input = pickerOf(ctx, f.key);
    assert.equal(input.accept, 'application/pdf');
    assert.equal(input.multiple, false);
    // Native, labelled, and the page’s "drag it into GitHub" note is hidden.
    assert.ok(wrapOf(ctx, f.key).querySelector('label[for="' + input.id + '"]'));
    assert.equal(wrapOf(ctx, f.key).querySelector('.field-note:not([data-upload-signed-out])').hidden, true);
  });
  assert.match(wrapOf(ctx, 'screenshots').textContent, /A reviewer checks every file/);
  assert.match(wrapOf(ctx, 'screenshots').textContent, /do not show personal information/);
  assert.match(wrapOf(ctx, 'deck_pdf').textContent, /used instead of any link/);
  const live = ctx.live();
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
});

test('signing out hides the pickers; signing back in shows them', async () => {
  const ctx = await boot();
  assert.ok(pickerOf(ctx, 'screenshots'));
  ctx.document.querySelector('[data-direct-action="signout"]').click();
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
  assert.equal(
    wrapOf(ctx, 'deck_pdf').querySelector('.field-note:not([data-upload-signed-out])').hidden,
    false
  );
});

/* ---------------------------------------------------------- uploading */

test('an upload request carries exactly the contract headers, the re-encoded bytes, and never reaches the draft', async () => {
  const ctx = await boot();
  await pick(ctx, 'screenshots', [png(ctx, 'My Screenshot é.png')]);
  assert.equal(ctx.uploadsSent.length, 1);
  const request = ctx.uploadsSent[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, UPLOADS_URL + '/api/upload');
  assert.deepEqual(Object.keys(request.headers).sort(), [
    'Authorization',
    'Content-Type',
    'X-Upload-Kind',
    'X-Upload-Name',
    'X-Upload-Set',
  ]);
  assert.equal(request.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(request.headers['Content-Type'], 'application/octet-stream');
  assert.equal(request.headers['X-Upload-Kind'], 'image');
  assert.match(request.headers['X-Upload-Set'], SET_RE);
  assert.equal(request.headers['X-Upload-Name'], 'My Screenshot _.png');
  assert.equal(await request.body.text(), 're-encoded My Screenshot é.png');
  assert.equal(ctx.reencoded.length, 1);

  describe(ctx, 'screenshots', 0, 'The queue');
  await settleDraft();
  const raw = ctx.rawDraft();
  assert.doesNotMatch(raw, new RegExp(TOKEN));
  assert.doesNotMatch(raw, /Bearer|Authorization/);
  assert.doesNotMatch(ctx.window.localStorage.getItem(STORE) || '', /./);
  const stored = ctx.storedDraft().uploads;
  assert.equal(stored.set, request.headers['X-Upload-Set']);
  assert.deepEqual(stored.user, { id: 1001, login: 'octo-cat' });
  assert.equal(stored.files.screenshots.length, 1);
  assert.deepEqual(Object.keys(stored.files.screenshots[0]).sort(), ['alt', 'bytes', 'kind', 'name', 'ref']);
  assert.match(stored.files.screenshots[0].ref, REF_RE);
  assert.equal(stored.files.screenshots[0].alt, 'The queue');
  assert.equal(stored.files.screenshots[0].kind, 'image');
});

test('a PDF is sent as it is, as kind pdf; a second one waits for the first to be removed', async () => {
  const ctx = await boot();
  const deck = pdf(ctx);
  await pick(ctx, 'deck_pdf', [deck]);
  assert.equal(ctx.reencoded.length, 0, 'a PDF must not be re-encoded');
  const request = ctx.uploadsSent[0];
  assert.equal(request.headers['X-Upload-Kind'], 'pdf');
  assert.equal(request.body, deck);
  assert.equal(pickerOf(ctx, 'deck_pdf'), null, 'one deck: the picker steps aside');
  assert.equal(rowsOf(ctx, 'deck_pdf').length, 1);
});

test('uploads go one at a time, in order, and share one set', async () => {
  let active = 0;
  let overlap = 0;
  const ctx = await boot({
    send: async (request, c) => {
      active += 1;
      overlap = Math.max(overlap, active);
      await flush();
      active -= 1;
      c.count += 1;
      const sha = digest(c.count);
      return reply(201, {
        ref: 'upload:' + request.headers['X-Upload-Set'] + '/' + sha + '.png',
        sha256: sha,
        bytes: 1,
        ext: 'png',
      });
    },
  });
  await pick(ctx, 'screenshots', [png(ctx, 'a.png'), png(ctx, 'b.png'), png(ctx, 'c.png')]);
  assert.equal(overlap, 1);
  const sets = new Set(ctx.uploadsSent.map((r) => r.headers['X-Upload-Set']));
  assert.equal(sets.size, 1);
  assert.deepEqual(
    ctx.uploadsSent.map((r) => r.headers['X-Upload-Name']),
    ['a.png', 'b.png', 'c.png']
  );
  assert.equal(rowsOf(ctx, 'screenshots').length, 3);
});

test('the set id is made once per draft and survives a reload', async () => {
  const first = await boot();
  await pick(first, 'screenshots', [png(first, 'a.png')]);
  describe(first, 'screenshots', 0, 'First');
  await settleDraft();
  const set = first.storedDraft().uploads.set;
  assert.match(set, SET_RE);

  const second = await boot({ draft: first.rawDraft() });
  second.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  assert.equal(rowsOf(second, 'screenshots').length, 1);
  await pick(second, 'screenshots', [png(second, 'b.png')]);
  assert.equal(second.uploadsSent[0].headers['X-Upload-Set'], set, 'a restored draft kept its set');
});

test('a 401 means the sign-in is over: signed-out state, pickers gone, files kept as failed', async () => {
  const ctx = await boot({
    send: async () => reply(401, { error: 'unauthorized', message: 'Token expired' }),
  });
  await pick(ctx, 'screenshots', [png(ctx)]);
  assert.equal(ctx.window.sessionStorage.getItem(STORE), null, 'the dead token was kept');
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
  assert.ok(ctx.document.querySelector('[data-direct-action="signin"]'), 'the sign-in button is back');
  assert.match(ctx.document.querySelector('[data-signin-notice]').textContent, /sign-in has expired/);
  assert.match(ctx.live().textContent, /did not upload/);
  assert.equal(ctx.uploadsSent.length, 1, 'a 401 must not be retried');
});

test('a 429 waits as long as Retry-After says, then retries, up to three times', async () => {
  const answers = [
    reply(429, { error: 'rate_limited', message: 'Busy' }, '3'),
    reply(429, { error: 'rate_limited', message: 'Busy' }, '7'),
  ];
  const ctx = await boot({
    send: async (request, c) => {
      const next = answers.shift();
      if (next) return next;
      c.count += 1;
      const sha = digest(c.count);
      return reply(201, {
        ref: 'upload:' + request.headers['X-Upload-Set'] + '/' + sha + '.png',
        sha256: sha,
        bytes: 1,
        ext: 'png',
      });
    },
  });
  await pick(ctx, 'screenshots', [png(ctx)]);
  assert.deepEqual(ctx.sleeps, [3000, 7000]);
  assert.equal(ctx.uploadsSent.length, 3);
  assert.match(rowsOf(ctx, 'screenshots')[0].textContent, /Uploaded\./);

  const never = await boot({
    send: async () =>
      reply(429, { error: 'rate_limited', message: 'Too many uploads. Try again in a minute.' }, '1'),
  });
  await pick(never, 'screenshots', [png(never)]);
  assert.equal(never.uploadsSent.length, 4, 'the first try and three retries');
  assert.deepEqual(never.sleeps, [1000, 1000, 1000]);
  const row = rowsOf(never, 'screenshots')[0];
  assert.match(row.textContent, /Not uploaded: Too many uploads\. Try again in a minute\./);
  assert.equal(row.querySelector('[data-upload-action="retry"]').hidden, false);
});

test('a 429 for a per-user cap (too_many_files, too_many_drafts) is not retried; its message is shown', async () => {
  for (const code of ['too_many_files', 'too_many_drafts']) {
    const ctx = await boot({
      send: async () => reply(429, { error: code, message: 'Cap reached: ' + code }, '5'),
    });
    await pick(ctx, 'screenshots', [png(ctx)]);
    assert.equal(ctx.uploadsSent.length, 1, code + ' was retried');
    assert.deepEqual(ctx.sleeps, []);
    assert.match(rowsOf(ctx, 'screenshots')[0].textContent, new RegExp('Not uploaded: Cap reached: ' + code));
  }
});

test('a refusal shows the service’s message; a network failure offers Try again, which uploads', async () => {
  let fail = true;
  const ctx = await boot({
    send: async (request, c) => {
      if (fail) throw new Error('network');
      c.count += 1;
      const sha = digest(c.count);
      return reply(201, {
        ref: 'upload:' + request.headers['X-Upload-Set'] + '/' + sha + '.png',
        sha256: sha,
        bytes: 1,
        ext: 'png',
      });
    },
  });
  await pick(ctx, 'screenshots', [png(ctx)]);
  const row = () => rowsOf(ctx, 'screenshots')[0];
  assert.match(row().textContent, /could not reach the upload service/);
  fail = false;
  row().querySelector('[data-upload-action="retry"]').click();
  await settle();
  assert.match(row().textContent, /Uploaded\./);
  assert.equal(ctx.reencoded.length, 1, 'a retry must not re-encode');

  const refused = await boot({
    send: async () => reply(413, { error: 'too_large', message: 'That file is over 4 MB.' }),
  });
  await pick(refused, 'screenshots', [png(refused)]);
  assert.match(rowsOf(refused, 'screenshots')[0].textContent, /That file is over 4 MB\./);
});

test('remove: DELETE with the ref, then the row is gone, focus moves on, the draft forgets it', async () => {
  const ctx = await boot();
  await pick(ctx, 'screenshots', [png(ctx, 'a.png'), png(ctx, 'b.png')]);
  const ref = rowsOf(ctx, 'screenshots').length && ctx.uploadsSent[0].headers['X-Upload-Set'];
  assert.ok(ref);
  const first = rowsOf(ctx, 'screenshots')[0];
  const button = first.querySelector('[data-upload-action="remove"]');
  assert.match(button.getAttribute('aria-label'), /a\.png/);
  button.click();
  await settle();
  const del = ctx.uploadsSent.find((r) => r.method === 'DELETE');
  assert.ok(del, 'no DELETE was sent');
  assert.match(
    del.url,
    /^https:\/\/uploads\.example\/api\/upload\?ref=upload%3A[a-z2-7]{26}%2F[0-9a-f]{64}\.png$/
  );
  assert.deepEqual(Object.keys(del.headers), ['Authorization']);
  assert.equal(del.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(rowsOf(ctx, 'screenshots').length, 1);
  assert.match(rowsOf(ctx, 'screenshots')[0].textContent, /b\.png/);
  assert.equal(
    ctx.document.activeElement,
    rowsOf(ctx, 'screenshots')[0].querySelector('[data-upload-action="remove"]')
  );
  assert.match(ctx.live().textContent, /Removed a\.png/);

  await settleDraft();
  assert.equal(ctx.storedDraft().uploads.files.screenshots.length, 1);

  // Last one out: focus lands on the picker.
  rowsOf(ctx, 'screenshots')[0].querySelector('[data-upload-action="remove"]').click();
  await settle();
  assert.equal(rowsOf(ctx, 'screenshots').length, 0);
  assert.equal(ctx.document.activeElement, pickerOf(ctx, 'screenshots'));
});

test('two quick removes take out the two files pressed, whichever DELETE answers first', async () => {
  // b's DELETE is held until a's has come back: the list shifts under it.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await boot({
    send: async (request, c) => {
      if (request.method !== 'DELETE') return defaultCreated(request, c);
      if (request.url.includes(digest(2))) await held;
      return reply(204, null);
    },
  });
  await pick(ctx, 'screenshots', [png(ctx, 'a.png'), png(ctx, 'b.png'), png(ctx, 'c.png')]);
  ['A', 'B', 'C'].forEach((alt, i) => describe(ctx, 'screenshots', i, 'Alt ' + alt));
  const set = ctx.uploadsSent[0].headers['X-Upload-Set'];
  const refC = 'upload:' + set + '/' + digest(3) + '.png';

  rowsOf(ctx, 'screenshots')[1].querySelector('[data-upload-action="remove"]').click();
  await settle();
  rowsOf(ctx, 'screenshots')[0].querySelector('[data-upload-action="remove"]').click();
  await settle();
  release();
  await settle();

  assert.deepEqual(
    rowsOf(ctx, 'screenshots').map((row) => /([abc])\.png/.exec(row.textContent)[1]),
    ['c']
  );
  const { issueFormBody, markdownBody } = ctx.window.SubmitForm;
  for (const body of [issueFormBody(ctx.fields), markdownBody(ctx.fields)])
    assert.deepEqual(
      body.split('\n').filter((line) => line.startsWith('upload:')),
      [refC + ' | Alt C']
    );
  await settleDraft();
  assert.deepEqual(
    ctx.storedDraft().uploads.files.screenshots.map((entry) => [entry.name, entry.ref]),
    [['c.png', refC]]
  );
});

test('a deck removed brings its picker back; a failed DELETE keeps the row and says so', async () => {
  const ctx = await boot({
    send: async (request, c) =>
      request.method === 'DELETE'
        ? reply(500, { error: 'x', message: 'GitHub is down.' })
        : defaultCreated(request, c),
  });
  await pick(ctx, 'deck_pdf', [pdf(ctx)]);
  rowsOf(ctx, 'deck_pdf')[0].querySelector('[data-upload-action="remove"]').click();
  await settle();
  assert.equal(rowsOf(ctx, 'deck_pdf').length, 1);
  assert.match(
    wrapOf(ctx, 'deck_pdf').querySelector('[data-upload-message]').textContent,
    /could not be removed.*GitHub is down\./
  );

  const ok = await boot();
  await pick(ok, 'deck_pdf', [pdf(ok)]);
  rowsOf(ok, 'deck_pdf')[0].querySelector('[data-upload-action="remove"]').click();
  await settle();
  assert.equal(rowsOf(ok, 'deck_pdf').length, 0);
  assert.ok(pickerOf(ok, 'deck_pdf'));
  assert.equal(ok.document.activeElement, pickerOf(ok, 'deck_pdf'));
});

function defaultCreated(request, c) {
  c.count += 1;
  const sha = digest(c.count);
  const ext = request.headers['X-Upload-Kind'] === 'pdf' ? 'pdf' : 'png';
  return reply(201, {
    ref: 'upload:' + request.headers['X-Upload-Set'] + '/' + sha + '.' + ext,
    sha256: sha,
    bytes: 1,
    ext,
  });
}

/* ------------------------------------------------------- refusals */

test('refusals before any upload: a big PDF, a GIF, a non-PDF, too many pictures', async () => {
  const ctx = await boot();
  await pick(ctx, 'deck_pdf', [pdf(ctx, 'big.pdf', 4 * 1024 * 1024 + 1)]);
  const message = wrapOf(ctx, 'deck_pdf').querySelector('[data-upload-message]');
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /big\.pdf.*over the 4 MB limit/);
  assert.match(message.textContent, /export it again as PDF, minimum size/);
  assert.match(message.textContent, /paste a link/);
  assert.equal(ctx.uploadsSent.length, 0);
  assert.match(ctx.live().textContent, /big\.pdf/);

  await pick(ctx, 'deck_pdf', [file(ctx, 'notes.txt', 'text/plain')]);
  assert.match(message.textContent, /is not a PDF/);
  await pick(ctx, 'screenshots', [file(ctx, 'move.gif', 'image/gif')]);
  assert.match(
    wrapOf(ctx, 'screenshots').querySelector('[data-upload-message]').textContent,
    /not a PNG, JPEG or WebP/
  );
  assert.equal(ctx.uploadsSent.length, 0);

  await pick(
    ctx,
    'screenshots',
    Array.from({ length: 9 }, (_, i) => png(ctx, 'p' + i + '.png'))
  );
  assert.equal(rowsOf(ctx, 'screenshots').length, 8);
  assert.match(
    wrapOf(ctx, 'screenshots').querySelector('[data-upload-message]').textContent,
    /Up to 8 screenshots/
  );
});

test('a picture that cannot be shrunk under 4 MB, or read, is reported with a way to remove it', async () => {
  const fails = (code) => async () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  const ctx = await boot({ reencode: fails('toolarge') });
  await pick(ctx, 'screenshots', [png(ctx)]);
  const row = rowsOf(ctx, 'screenshots')[0];
  assert.match(row.textContent, /over 4 MB/);
  assert.equal(row.querySelector('[data-upload-action="remove"]').hidden, false);
  assert.equal(ctx.uploadsSent.length, 0);

  const unreadable = await boot({ reencode: fails('decode') });
  await pick(unreadable, 'screenshots', [png(unreadable)]);
  assert.match(rowsOf(unreadable, 'screenshots')[0].textContent, /could not be read as a picture/);
});

/* ----------------------------------------------------------- the body */

test('the issue body carries upload lines for screenshots (with alt, then typed URLs) and a bare ref for the deck', async () => {
  const ctx = await boot();
  await pick(ctx, 'screenshots', [png(ctx, 'a.png'), png(ctx, 'b.png')]);
  await pick(ctx, 'deck_pdf', [pdf(ctx)]);
  describe(ctx, 'screenshots', 0, 'The   intake   queue');
  describe(ctx, 'screenshots', 1, 'Routing result');
  answer(ctx, 'screenshots', 'https://example.org/extra.png | Extra view');
  const set = ctx.uploadsSent[0].headers['X-Upload-Set'];
  const refs = ctx.uploadsSent.map(
    (r, i) => 'upload:' + set + '/' + digest(i + 1) + (r.headers['X-Upload-Kind'] === 'pdf' ? '.pdf' : '.png')
  );
  const { issueFormBody, markdownBody, issueUrl } = ctx.window.SubmitForm;
  const expectedShots =
    refs[0] +
    ' | The intake queue\n' +
    refs[1] +
    ' | Routing result\nhttps://example.org/extra.png | Extra view';

  const body = issueFormBody(ctx.fields);
  assert.ok(body.includes('### Screenshots\n\n' + expectedShots), body);
  assert.ok(
    body.includes('### Slide deck or one-pager (PDF)\n\n' + refs[2] + '\n\n') ||
      body.endsWith('### Slide deck or one-pager (PDF)\n\n' + refs[2]),
    body
  );
  const markdown = markdownBody(ctx.fields);
  assert.ok(markdown.includes('### Screenshots\n\n' + expectedShots + '\n'));
  assert.ok(markdown.includes('### Slide deck or one-pager (PDF)\n\n' + refs[2] + '\n'));
  for (const line of body.split('\n').filter((l) => l.startsWith('upload:')))
    assert.match(line.split(' | ')[0], REF_RE);

  // The prefilled link is for signed-out submitters: never an upload in it.
  const url = issueUrl(ctx.form, ctx.fields, 'Water routing');
  assert.doesNotMatch(decodeURIComponent(url), /upload:/);
  assert.match(decodeURIComponent(url), /extra\.png/);
});

test('with no uploads the body is exactly what it was', async () => {
  const ctx = await boot();
  answer(ctx, 'screenshots', 'https://example.org/a.png | A');
  const plain = await boot({ uploads: false });
  answer(plain, 'screenshots', 'https://example.org/a.png | A');
  assert.equal(
    ctx.window.SubmitForm.issueFormBody(ctx.fields),
    plain.window.SubmitForm.issueFormBody(plain.fields)
  );
  assert.equal(
    ctx.window.SubmitForm.markdownBody(ctx.fields),
    plain.window.SubmitForm.markdownBody(plain.fields)
  );
});

test('signed out, hidden uploads are not written into the body', async () => {
  const ctx = await boot();
  await pick(ctx, 'screenshots', [png(ctx)]);
  describe(ctx, 'screenshots', 0, 'Alt');
  ctx.document.querySelector('[data-direct-action="signout"]').click();
  assert.doesNotMatch(ctx.window.SubmitForm.issueFormBody(ctx.fields), /upload:/);
  assert.doesNotMatch(ctx.window.SubmitForm.markdownBody(ctx.fields), /upload:/);
});

/* ------------------------------------------------------ draft restore */

/** A draft with one uploaded screenshot, made by `user`. */
async function draftWithUpload(user = { login: 'octo-cat', id: 1001 }) {
  const ctx = await boot({ user });
  await pick(ctx, 'screenshots', [png(ctx, 'kept.png')]);
  describe(ctx, 'screenshots', 0, 'Kept alt');
  await pick(ctx, 'deck_pdf', [pdf(ctx, 'kept.pdf')]);
  await settleDraft();
  return ctx.rawDraft();
}

test('restoring a draft as the same user shows the files again, with their descriptions', async () => {
  const draft = await draftWithUpload();
  const ctx = await boot({ draft });
  assert.equal(rowsOf(ctx, 'screenshots').length, 0, 'files must wait for Restore, like the answers');
  ctx.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  const shots = rowsOf(ctx, 'screenshots');
  assert.equal(shots.length, 1);
  assert.match(shots[0].textContent, /kept\.png/);
  assert.equal(shots[0].querySelector('[data-upload-alt]').value, 'Kept alt');
  assert.equal(rowsOf(ctx, 'deck_pdf').length, 1);
  assert.match(
    ctx.window.SubmitForm.issueFormBody(ctx.fields),
    /upload:[a-z2-7]{26}\/[0-9a-f]{64}\.png \| Kept alt/
  );
  assert.equal(ctx.uploadsSent.length, 0, 'restoring must not upload anything');
});

test('restoring as a different user drops the files with a notice', async () => {
  const draft = await draftWithUpload();
  const ctx = await boot({ draft, user: { login: 'someone-else', id: 2002 } });
  ctx.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  assert.equal(rowsOf(ctx, 'screenshots').length, 0);
  assert.equal(rowsOf(ctx, 'deck_pdf').length, 0);
  const note = wrapOf(ctx, 'screenshots').querySelector('[data-upload-message]');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /uploaded by @octo-cat.*signed in as @someone-else.*removed from the draft/);
  assert.match(ctx.live().textContent, /removed from the draft/);
  assert.doesNotMatch(ctx.window.SubmitForm.issueFormBody(ctx.fields), /upload:/);
  await settleDraft();
  assert.equal((ctx.storedDraft() || {}).uploads, undefined, 'the other user’s refs stayed in the draft');
});

test('restoring while signed out keeps the files in the draft, hides the pickers, and says to sign in', async () => {
  const draft = await draftWithUpload();
  const ctx = await boot({ draft, signedIn: false });
  ctx.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  assert.equal(ctx.form.querySelector('input[type="file"]'), null);
  const note = wrapOf(ctx, 'screenshots').querySelector('[data-upload-signed-out]');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Sign in with GitHub again/);
  assert.doesNotMatch(ctx.window.SubmitForm.issueFormBody(ctx.fields), /upload:/);
  await settleDraft();
  assert.equal(ctx.storedDraft().uploads.files.screenshots.length, 1, 'the files were lost from the draft');
  assert.equal(ctx.storedDraft().uploads.user.id, 1001);

  // Signing in as the same user brings them back.
  ctx.window.sessionStorage.setItem(STORE, JSON.stringify({ token: TOKEN, expiresAt: null }));
  ctx.window.dispatchEvent(
    Object.assign(
      new ctx.window.MessageEvent('message', {
        data: { type: 'phct-github-token', token: TOKEN },
        origin: SIGNIN,
      })
    )
  );
});

test('an old draft, from before uploads, loads exactly as it did', async () => {
  const draft = JSON.stringify({ saved: new Date().toISOString(), fields: { title: 'Old draft' } });
  const ctx = await boot({ draft });
  ctx.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  assert.equal(wrapOf(ctx, 'title').querySelector('input').value, 'Old draft');
  assert.equal(rowsOf(ctx, 'screenshots').length, 0);
});

test('a hand-edited uploads record is checked: wrong set, wrong ref, wrong kind are dropped', async () => {
  const set = 'a'.repeat(26);
  const good = 'upload:' + set + '/' + 'b'.repeat(64) + '.png';
  const draft = JSON.stringify({
    saved: new Date().toISOString(),
    fields: {},
    uploads: {
      set,
      user: { id: 1001, login: 'octo-cat' },
      files: {
        screenshots: [
          { ref: good, name: 'ok.png', alt: 'ok', bytes: 5, kind: 'image' },
          {
            ref: 'upload:' + 'c'.repeat(26) + '/' + 'b'.repeat(64) + '.png',
            name: 'other-set.png',
            alt: '',
            bytes: 5,
            kind: 'image',
          },
          { ref: 'https://evil.example/x.png', name: 'url.png', alt: '', bytes: 5, kind: 'image' },
          {
            ref: 'upload:' + set + '/' + 'd'.repeat(64) + '.pdf',
            name: 'pdf-in-images.pdf',
            alt: '',
            bytes: 5,
            kind: 'pdf',
          },
        ],
      },
    },
  });
  const ctx = await boot({ draft });
  ctx.document.querySelector('[data-draft-action="restore"]').click();
  await settle();
  assert.deepEqual(
    rowsOf(ctx, 'screenshots').map(
      (row) => /ok\.png|other-set|url\.png|pdf-in-images/.exec(row.textContent)[0]
    ),
    ['ok.png']
  );
});

/* -------------------------------------------------- blocking submit */

test('Submit is blocked while a file uploads, after one fails, and while a description is missing', async () => {
  let release;
  const ctx = await boot({
    send: (request, c) =>
      new Promise((resolve) => {
        release = () => resolve(defaultCreated(request, c));
      }),
  });
  fillRequired(ctx);
  await pick(ctx, 'screenshots', [png(ctx)]);
  // Still uploading.
  assert.equal(tryReview(ctx), false);
  assert.match(summaryText(ctx), /still uploading/);
  assert.equal(rowsOf(ctx, 'screenshots')[0].querySelector('progress').hidden, false);

  release();
  await settle();
  // Uploaded, but no description yet.
  assert.equal(tryReview(ctx), false);
  assert.match(summaryText(ctx), /Describe every screenshot/);
  describe(ctx, 'screenshots', 0, 'The queue');
  assert.equal(tryReview(ctx), true, 'a described, uploaded screenshot should let the form through');

  // A failed upload blocks until it is dealt with.
  const failed = await boot({ send: async () => reply(500, { error: 'x', message: 'Broke.' }) });
  fillRequired(failed);
  await pick(failed, 'screenshots', [png(failed)]);
  assert.equal(tryReview(failed), false);
  assert.match(summaryText(failed), /did not upload/);
  rowsOf(failed, 'screenshots')[0].querySelector('[data-upload-action="remove"]').click();
  await settle();
  assert.equal(tryReview(failed), true);
});

test('a required question is satisfied by an upload alone', async () => {
  const ctx = await boot();
  const field = ctx.fields.find((f) => f.key === 'deck_pdf');
  field.required = true;
  assert.match(ctx.window.SubmitForm.checkField(field), /Enter an answer/);
  await pick(ctx, 'deck_pdf', [pdf(ctx)]);
  assert.equal(ctx.window.SubmitForm.checkField(field), '');
});

test('the review reads the files back by name and description', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  await pick(ctx, 'screenshots', [png(ctx, 'queue.png')]);
  describe(ctx, 'screenshots', 0, 'The queue');
  assert.equal(tryReview(ctx), true);
  assert.match(ctx.form.querySelector('[data-review]').textContent, /queue\.png — The queue/);
});

/* ------------------------------------------------------ sending, copy */

test('Submit to GitHub sends the upload lines; the confirmation no longer says to drag the deck in', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  await pick(ctx, 'screenshots', [png(ctx)]);
  describe(ctx, 'screenshots', 0, 'The queue');
  await pick(ctx, 'deck_pdf', [pdf(ctx)]);
  assert.equal(tryReview(ctx), true);
  await submitToGitHub(ctx);
  const post = ctx.requests.find((r) => r.url === ISSUES_URL);
  assert.ok(post, 'no issue was created');
  const body = JSON.parse(post.init.body).body;
  assert.match(body, /### Screenshots\n\nupload:[a-z2-7]{26}\/[0-9a-f]{64}\.png \| The queue/);
  assert.match(body, /### Slide deck or one-pager \(PDF\)\n\nupload:[a-z2-7]{26}\/[0-9a-f]{64}\.pdf/);
  const done = ctx.form.querySelector('[data-review]').textContent;
  assert.match(done, /Submitted — thank you/);
  assert.doesNotMatch(done, /Files cannot be sent from this page/);
  assert.match(done, /Your 2 uploaded files went with it/);
  assert.equal(ctx.rawDraft(), null, 'the draft survived the send');
});

test('without an upload the confirmation still says to drag the deck into the issue', async () => {
  const ctx = await boot();
  fillRequired(ctx);
  assert.equal(tryReview(ctx), true);
  await submitToGitHub(ctx);
  const done = ctx.form.querySelector('[data-review]').textContent;
  assert.match(done, /Files cannot be sent from this page.*Slide deck or one-pager \(PDF\)/);
  assert.doesNotMatch(done, /uploaded file/);
});

test('a failed send with files: GitHub’s form is offered as the copy-out box, which keeps them', async () => {
  const ctx = await boot({ issueStatus: 422 });
  fillRequired(ctx);
  await pick(ctx, 'screenshots', [png(ctx)]);
  describe(ctx, 'screenshots', 0, 'The queue');
  await pick(ctx, 'deck_pdf', [pdf(ctx)]);
  assert.equal(tryReview(ctx), true);
  await submitToGitHub(ctx);
  ctx.form.querySelector('[data-direct-action="fallback"]').click();
  await settle();

  assert.deepEqual(ctx.opened, [], 'the prefilled link was opened, dropping the files');
  assert.match(
    ctx.form.querySelector('[data-submit-status]').textContent,
    /The 2 files you uploaded do not travel in a link to GitHub’s form, but the box below carries them/
  );
  assert.equal(ctx.form.querySelector('[data-fallback]').hidden, false);
  const box = ctx.form.querySelector('[data-fallback-body]').value;
  assert.equal(box, ctx.window.SubmitForm.markdownBody(ctx.fields));
  assert.match(box, /### Screenshots\n\nupload:[a-z2-7]{26}\/[0-9a-f]{64}\.png \| The queue/);
  assert.match(box, /### Slide deck or one-pager \(PDF\)\n\nupload:[a-z2-7]{26}\/[0-9a-f]{64}\.pdf/);
  const link = ctx.form.querySelector('[data-fallback-link]');
  assert.equal(link.hidden, false);
  assert.equal(link.href, ctx.window.SubmitForm.issueUrl(ctx.form, ctx.fields, 'Water routing'));
  await settleDraft();
  assert.equal(ctx.storedDraft().uploads.files.screenshots.length, 1, 'a failed send lost the draft');
});

test('a send that finds the sign-in expired says only a fresh sign-in keeps the files', async () => {
  const ctx = await boot({ issueStatus: 401 });
  fillRequired(ctx);
  await pick(ctx, 'screenshots', [png(ctx)]);
  describe(ctx, 'screenshots', 0, 'The queue');
  assert.equal(tryReview(ctx), true);
  await submitToGitHub(ctx);
  ctx.form.querySelector('[data-direct-action="fallback"]').click();
  await settle();

  assert.deepEqual(ctx.opened, [], 'GitHub’s form opened without saying the files were left behind');
  assert.match(
    ctx.form.querySelector('[data-submit-status]').textContent,
    /Your GitHub sign-in has expired, so the file you uploaded is not in the box or the link below\. To keep it, sign in again/
  );
  const link = ctx.form.querySelector('[data-fallback-link]');
  assert.equal(link.hidden, false);
  assert.doesNotMatch(ctx.form.querySelector('[data-fallback-body]').value, /upload:/);
  await settleDraft();
  assert.equal(
    ctx.storedDraft().uploads.files.screenshots.length,
    1,
    'the expired sign-in lost the draft’s files'
  );
});

test('a failed send without files: GitHub’s form opens as before, with no files warning', async () => {
  const ctx = await boot({ issueStatus: 422 });
  fillRequired(ctx);
  assert.equal(tryReview(ctx), true);
  await submitToGitHub(ctx);
  ctx.form.querySelector('[data-direct-action="fallback"]').click();
  await settle();

  assert.equal(ctx.opened.length, 1);
  assert.match(ctx.opened[0], /^https:\/\/github\.com\/crypticpy\/phct\/issues\/new\?/);
  assert.doesNotMatch(ctx.form.textContent, /files? you uploaded/);
  assert.equal(ctx.form.querySelector('[data-fallback]').hidden, true);
});

/* ------------------------------------------- the core's decision logic */

function core() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  booted.push(dom);
  dom.window.eval(CORE);
  return dom.window.SubmitForm.uploadsCore;
}

test('encodeUnderLimit keeps the format at quality 0.9 when that fits', async () => {
  const c = core();
  const calls = [];
  const result = await c.encodeUnderLimit(async (type, quality) => {
    calls.push([type, quality]);
    return { size: 1000, type };
  }, 'image/png');
  assert.deepEqual(calls, [['image/png', 0.9]]);
  assert.equal(result.type, 'image/png');
});

test('encodeUnderLimit falls back to JPEG at falling quality until it fits', async () => {
  const c = core();
  const limit = 4 * 1024 * 1024;
  const calls = [];
  const sizes = {
    'image/webp@0.9': limit + 1,
    'image/jpeg@0.85': limit + 1,
    'image/jpeg@0.75': limit + 1,
    'image/jpeg@0.65': limit,
  };
  const result = await c.encodeUnderLimit(async (type, quality) => {
    calls.push(type + '@' + quality);
    return { size: sizes[type + '@' + quality] ?? 1, type };
  }, 'image/webp');
  assert.deepEqual(calls, ['image/webp@0.9', 'image/jpeg@0.85', 'image/jpeg@0.75', 'image/jpeg@0.65']);
  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.blob.size, limit, 'exactly 4 MiB is allowed');
});

test('encodeUnderLimit gives up (null) when no quality fits, after trying every step', async () => {
  const c = core();
  const calls = [];
  const result = await c.encodeUnderLimit(async (type, quality) => {
    calls.push(quality);
    return { size: 10 * 1024 * 1024, type };
  }, 'image/jpeg');
  assert.equal(result, null);
  assert.deepEqual(calls, [0.9, ...c.FALLBACK_QUALITIES]);
  assert.ok(
    c.FALLBACK_QUALITIES.every((q, i, all) => i === 0 || q < all[i - 1]),
    'qualities must decrease'
  );
});

test('fitWithin caps the long edge at 2400 px, keeps the ratio, never scales up', () => {
  const c = core();
  const fit = (core, w, h) => ({ ...core.fitWithin(w, h) });
  assert.deepEqual(fit(c, 4800, 2400), { width: 2400, height: 1200 });
  assert.deepEqual(fit(c, 1000, 6000), { width: 400, height: 2400 });
  assert.deepEqual(fit(c, 2400, 2400), { width: 2400, height: 2400 });
  assert.deepEqual(fit(c, 800, 600), { width: 800, height: 600 });
  assert.deepEqual(fit(c, 10000, 1), { width: 2400, height: 1 });
});

test('outputType keeps PNG, JPEG and WebP and refuses GIF; kindOf reads type then extension', () => {
  const c = core();
  assert.equal(c.outputType('image/png'), 'image/png');
  assert.equal(c.outputType('image/jpeg'), 'image/jpeg');
  assert.equal(c.outputType('image/webp'), 'image/webp');
  assert.equal(c.outputType('image/gif'), '');
  assert.equal(c.kindOf({ name: 'a.PDF', type: '' }), 'pdf');
  assert.equal(c.kindOf({ name: 'a.jpeg', type: '' }), 'image');
  assert.equal(c.kindOf({ name: 'a.gif', type: 'image/gif' }), '');
  assert.equal(c.kindOf({ name: 'a.png', type: 'application/pdf' }), 'pdf');
});

test('newSetId is 26 base32 characters from the secure source, 5 bits per byte', () => {
  const c = core();
  const id = c.newSetId({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(id, '7'.repeat(26));
  assert.equal(c.newSetId({ getRandomValues: (bytes) => bytes.fill(0) }), 'a'.repeat(26));
  assert.match(c.newSetId(), SET_RE);
  assert.notEqual(c.newSetId(), c.newSetId());
  assert.throws(() => c.newSetId({}), /secure random/);
});

test('retryDelay honours Retry-After seconds within reason', () => {
  const c = core();
  assert.equal(c.retryDelay('3'), 3000);
  assert.equal(c.retryDelay(0), 0);
  assert.equal(c.retryDelay('1.5'), 1500);
  assert.equal(c.retryDelay('9999'), 60000);
  for (const bad of [null, undefined, '', 'soon', '-4']) assert.equal(c.retryDelay(bad), 2000, String(bad));
});

test('headerName is printable ASCII, at most 200 characters', () => {
  const c = core();
  assert.equal(c.headerName('Résumé.pdf'), 'R_sum_.pdf');
  assert.equal(c.headerName('a'.repeat(300)).length, 200);
  assert.equal(c.headerName(''), 'file');
});
