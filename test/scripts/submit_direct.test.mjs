/**
 * "Sign in with GitHub, submit directly" on the submit page
 * (assets/js/submit/direct.js), driven through a real DOM.
 *
 * The page is the same Liquid snapshot submit_form.test.mjs uses, with the
 * markup submit/index.md adds only when `submit.signin_url` is set laid over
 * it: `data-signin-url` on the form, the intro's sign-in notice, and the two
 * versions of the first "what happens next" step. GitHub's API, the sign-in
 * popup and its postMessage are stand-ins; everything else is the shipped
 * scripts, in the order the page loads them.
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
const SCRIPTS = jsYaml
  .load(fs.readFileSync(path.join(ROOT, 'submit', 'index.md'), 'utf8').split(/^---$/m)[1])
  .scripts.map((src) => src.replace(/^\//, ''));
const DIRECT = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'submit', 'direct.js'), 'utf8');

const SIGNIN = 'https://signin.example';
const PAGE = 'https://example.org/submit/';
const REPO = 'crypticpy/phct';
const TOKEN = 'ghu_' + 'a'.repeat(36);
const STORE = 'phct:github-signin:v1:' + REPO + '@' + SIGNIN;
const ISSUES_URL = 'https://api.github.com/repos/' + REPO + '/issues';

// The intro's notice as submit/index.md renders it: an icon, then the copy.
const NOTICE =
  '<p data-form-chrome data-signin-notice><svg data-icon="warning"></svg><span><strong>Sign in to GitHub before you start.</strong> <a href="https://github.com/login">Sign in to GitHub</a></span></p>' +
  '<ol><li><span data-handoff-copy>Press <em>Submit new issue</em> on GitHub</span><span data-direct-copy hidden>Press <em>Submit to GitHub</em></span></li></ol>';

const HANDOFF_STEP =
  '<li>1. Sending opens a GitHub issue with your answers already filled in. Nothing is submitted until you press <em>Submit new issue</em> there.</li>';

/** The fixture as a site with `submit.signin_url` set renders it. */
function configuredPage() {
  assert.ok(FIXTURE.includes(HANDOFF_STEP), 'the fixture no longer has the hand-off step this test rewrites');
  assert.ok(FIXTURE.includes(' data-submit-form=""'), 'the fixture form has no data-submit-form');
  return (
    NOTICE +
    FIXTURE.replace(' data-submit-form=""', ' data-submit-form="" data-signin-url="' + SIGNIN + '"').replace(
      HANDOFF_STEP,
      '<li>1. <span data-handoff-copy>Sending opens a GitHub issue.</span><span data-direct-copy hidden>Submitting creates a GitHub issue with your answers, filed as you, straight away.</span></li>'
    )
  );
}

const booted = [];
test.after(() => booted.forEach((dom) => dom.window.close()));

/** Let pending promise callbacks (fetch stand-ins, their .then chains) run. */
const flush = () =>
  new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
/** Wait past the draft autosave debounce. */
const settleDraft = () => new Promise((resolve) => setTimeout(resolve, 700));

/**
 * A JSON response the way `fetch` resolves one.
 * @param {number} status
 * @param {object|null} data null for a body that is not JSON
 */
function reply(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => (data === null ? Promise.reject(new SyntaxError('not JSON')) : Promise.resolve(data)),
  };
}

/**
 * A booted submit page.
 * @param {{configured?: boolean, token?: object, user?: object|number, post?: Function,
 *   popupBlocked?: boolean}} [options]
 *   `token` seeds sessionStorage as a previous sign-in left it; `user` is what
 *   GET /user answers (a status number for an error); `post(init)` answers
 *   POST /issues, returning a response or a promise of one.
 */
async function boot(options = {}) {
  const html = options.configured === false ? NOTICE + FIXTURE : configuredPage();
  const dom = new JSDOM('<!doctype html><body>' + html + '</body>', {
    url: PAGE,
    runScripts: 'outside-only',
  });
  booted.push(dom);
  const { window } = dom;
  const ctx = { window, document: window.document, opened: [], popups: [], requests: [] };

  window.open = (url, name) => {
    ctx.opened.push({ url, name });
    if (options.popupBlocked) return null;
    const popup = { closed: false, opener: window, focus() {}, close() {} };
    ctx.popups.push(popup);
    return popup;
  };
  window.fetch = (url, init = {}) => {
    ctx.requests.push({ url, init });
    if (url === 'https://api.github.com/user') {
      const user = options.user ?? { login: 'octo-cat' };
      return Promise.resolve(
        typeof user === 'number' ? reply(user, { message: 'Bad credentials' }) : reply(200, user)
      );
    }
    if (url === ISSUES_URL && init.method === 'POST') {
      return Promise.resolve(
        options.post
          ? options.post(init)
          : reply(201, { number: 42, html_url: 'https://github.com/' + REPO + '/issues/42' })
      );
    }
    return Promise.reject(new TypeError('unexpected request to ' + url));
  };
  if (options.token) window.sessionStorage.setItem(options.storeKey || STORE, JSON.stringify(options.token));

  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  ctx.form = window.document.querySelector('[data-submit-form]');
  ctx.draftKey = 'catalog-template:submit-draft:v2:' + ctx.form.dataset.draftKey;
  ctx.storedDraft = () => JSON.parse(window.localStorage.getItem(ctx.draftKey) || 'null');
  ctx.storedToken = () => JSON.parse(window.sessionStorage.getItem(STORE) || 'null');
  ctx.notice = () => window.document.querySelector('[data-signin-notice]');
  ctx.posts = () => ctx.requests.filter((r) => r.init.method === 'POST');

  // direct.js sits in the page body, so it runs before the front-matter scripts.
  if (options.configured !== false) window.eval(DIRECT);
  SCRIPTS.forEach((rel) => window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  await flush();
  return ctx;
}

/**
 * Deliver a message to the page as if `source` posted it from `origin`.
 * jsdom's MessageEvent only takes a real window as `source`, so it is set on
 * the event afterwards.
 */
function post(ctx, data, { origin = SIGNIN, source = ctx.popups[ctx.popups.length - 1] } = {}) {
  const event = new ctx.window.MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  ctx.window.dispatchEvent(event);
}

/** Type into a field, events and all. */
function answer(ctx, key, value) {
  const wrap = ctx.form.querySelector('[data-field="' + key + '"]');
  const type = wrap.dataset.type;
  if (type === 'select' || type === 'multiselect') {
    const inputs = Array.from(wrap.querySelectorAll('input[value]:not([data-clear])'));
    if (inputs.length === 0) {
      const select = wrap.querySelector('select');
      select.value = Array.from(select.options).find((o) => o.value !== '').value;
      select.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
      return;
    }
    inputs[0].checked = true;
    inputs[0].dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    return;
  }
  if (type === 'boolean') {
    const box = wrap.querySelector('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    return;
  }
  const control = wrap.querySelector('input, textarea');
  control.value = value;
  control.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
}

/** Fill every required question, the title last so it is the one we chose. */
function fillRequired(ctx, title = 'Water routing') {
  ctx.form.querySelectorAll('[data-required="true"]').forEach((wrap) => {
    const type = wrap.dataset.type;
    const key = wrap.dataset.field;
    if (type === 'email') answer(ctx, key, 'someone@example.org');
    else if (type === 'url') answer(ctx, key, 'https://example.org');
    else answer(ctx, key, 'Value for ' + key);
  });
  answer(ctx, 'title', title);
}

/** Walk through every step to "check your answers". */
function toReview(ctx) {
  const cap = ctx.form.querySelectorAll('[data-section]').length + 1;
  for (let i = 0; i < cap; i += 1) {
    ctx.form.dispatchEvent(new ctx.window.Event('submit', { bubbles: true, cancelable: true }));
    if (!ctx.form.querySelector('[data-review]').hidden) return;
  }
  assert.fail('never reached the review step');
}

/** The review panel's buttons, by visible label. */
function reviewButton(ctx, label) {
  return Array.from(ctx.form.querySelectorAll('[data-review] button')).find(
    (b) => b.textContent.trim() === label
  );
}

function press(ctx, label) {
  const button = reviewButton(ctx, label);
  assert.ok(button, 'no “' + label + '” button in the review panel');
  button.click();
  return button;
}

/** The status region under a direct send. */
const status = (ctx) => ctx.form.querySelector('[data-review-status]');

/** A filled form, autosaved, at the review step, signed in. */
async function readyToSubmit(options = {}) {
  const ctx = await boot({ token: { token: TOKEN, expiresAt: Date.now() + 3600000 }, ...options });
  fillRequired(ctx);
  await settleDraft();
  assert.ok(ctx.storedDraft(), 'the draft was not autosaved before submitting');
  toReview(ctx);
  return ctx;
}

/* ------------------------------------------------------- not configured */

test('without submit.signin_url the page is the link hand-off, untouched', async () => {
  const ctx = await boot({ configured: false });
  assert.equal(typeof ctx.window.SubmitForm.initDirect, 'undefined');
  assert.match(ctx.notice().textContent, /Sign in to GitHub before you start/);
  assert.equal(ctx.document.querySelector('[data-direct-action]'), null);
  fillRequired(ctx);
  toReview(ctx);
  assert.equal(status(ctx), null);
  press(ctx, 'Send to GitHub');
  assert.equal(ctx.opened.length, 1);
  assert.match(ctx.opened[0].url, /^https:\/\/github\.com\/crypticpy\/phct\/issues\/new\?/);
  assert.equal(ctx.requests.length, 0, 'an unconfigured page must not call GitHub’s API');
});

test('a signin_url that is not https (or loopback http) switches nothing on', async () => {
  for (const bad of ['http://signin.example', 'javascript:alert(1)', 'not a url']) {
    const dom = new JSDOM('<!doctype html><body>' + configuredPage().replace(SIGNIN, bad) + '</body>', {
      url: PAGE,
      runScripts: 'outside-only',
    });
    booted.push(dom);
    dom.window.fetch = () => assert.fail('fetch called for ' + bad);
    dom.window.eval(DIRECT);
    SCRIPTS.forEach((rel) => dom.window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
    assert.equal(dom.window.document.querySelector('[data-direct-action]'), null, bad);
  }
});

/* --------------------------------------------------------------- sign-in */

test('signed out, the intro notice becomes a Sign in with GitHub button and the hand-off is unchanged', async () => {
  const ctx = await boot();
  const notice = ctx.notice();
  assert.ok(notice.querySelector('svg[data-icon="warning"]'), 'the notice lost its icon');
  assert.doesNotMatch(notice.textContent, /Sign in to GitHub before you start/);
  assert.ok(notice.querySelector('[data-direct-action="signin"]'));
  assert.equal(ctx.requests.length, 0, 'no token, so no call to GitHub');
  fillRequired(ctx);
  toReview(ctx);
  assert.equal(status(ctx), null);
  press(ctx, 'Send to GitHub');
  assert.equal(ctx.opened.length, 1);
  assert.match(ctx.opened[0].url, /^https:\/\/github\.com\/crypticpy\/phct\/issues\/new\?/);
});

test('signing in takes the token only from the sign-in origin, from its popup, in the expected shape', async () => {
  const ctx = await boot();
  ctx.notice().querySelector('[data-direct-action="signin"]').click();
  assert.deepEqual(ctx.opened, [
    {
      url: SIGNIN + '/api/login?origin=' + encodeURIComponent('https://example.org'),
      name: 'phct-github-signin',
    },
  ]);
  const popup = ctx.popups[0];

  post(ctx, { type: 'phct-github-token', token: TOKEN }, { origin: 'https://evil.example' });
  post(ctx, { type: 'phct-github-token', token: TOKEN }, { source: { closed: false } });
  post(ctx, { type: 'something-else', token: TOKEN });
  post(ctx, { type: 'phct-github-token', token: 'not a token!' });
  post(ctx, 'phct-github-token');
  await flush();
  assert.equal(ctx.storedToken(), null, 'a message that failed a check was taken');

  const before = Date.now();
  post(ctx, { type: 'phct-github-token', token: TOKEN, expires_in: 28800 }, { source: popup });
  await flush();
  const saved = ctx.storedToken();
  assert.equal(saved.token, TOKEN);
  assert.ok(saved.expiresAt >= before + 28800 * 1000 && saved.expiresAt <= Date.now() + 28800 * 1000);
  const userCall = ctx.requests.find((r) => r.url === 'https://api.github.com/user');
  assert.equal(userCall.init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.match(ctx.notice().textContent, /Signed in to GitHub as @octo-cat/);
  assert.ok(ctx.notice().querySelector('[data-direct-action="signout"]'));
  assert.equal(ctx.document.querySelector('ol [data-direct-copy]').hidden, false);
  assert.equal(ctx.document.querySelector('ol [data-handoff-copy]').hidden, true);
  assert.equal(ctx.window.localStorage.getItem(ctx.draftKey), null, 'signing in wrote a draft');
});

test('a sign-in without an expiry is kept for the tab, and the token never lands in the draft', async () => {
  const ctx = await boot();
  ctx.notice().querySelector('[data-direct-action="signin"]').click();
  post(ctx, { type: 'phct-github-token', token: TOKEN });
  await flush();
  assert.deepEqual(ctx.storedToken(), { token: TOKEN, expiresAt: null });
  fillRequired(ctx);
  await settleDraft();
  assert.ok(ctx.storedDraft());
  assert.doesNotMatch(ctx.window.localStorage.getItem(ctx.draftKey), new RegExp(TOKEN));
});

test('the sign-in service’s error message is shown, and nothing is stored', async () => {
  const ctx = await boot();
  ctx.notice().querySelector('[data-direct-action="signin"]').click();
  post(ctx, { type: 'phct-github-error', message: 'Sign-in was cancelled on GitHub.' });
  await flush();
  assert.match(ctx.notice().textContent, /Sign-in was cancelled on GitHub\./);
  assert.equal(ctx.storedToken(), null);
  assert.ok(ctx.notice().querySelector('[data-direct-action="signin"]'));
});

test('a blocked sign-in popup says so and leaves the hand-off working', async () => {
  const ctx = await boot({ popupBlocked: true });
  ctx.notice().querySelector('[data-direct-action="signin"]').click();
  assert.match(ctx.notice().textContent, /blocked the GitHub sign-in window/);
  assert.equal(ctx.storedToken(), null);
});

test('a sign-in window closed without a token says so', async () => {
  const ctx = await boot();
  ctx.notice().querySelector('[data-direct-action="signin"]').click();
  ctx.popups[0].closed = true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.match(ctx.notice().textContent, /closed before sign-in finished/);
  // A late message from that closed window is no longer listened for.
  post(ctx, { type: 'phct-github-token', token: TOKEN }, { source: ctx.popups[0] });
  await flush();
  assert.equal(ctx.storedToken(), null);
});

test('a sign-in stored for another repository on the same origin is not used', async () => {
  const other = 'phct:github-signin:v1:someone/other-catalog@' + SIGNIN;
  const ctx = await boot({ token: { token: TOKEN, expiresAt: Date.now() + 60_000 }, storeKey: other });
  assert.ok(ctx.notice().querySelector('[data-direct-action="signin"]'), 'the page should be signed out');
  assert.equal(ctx.requests.length, 0, 'another site’s token must not be sent to GitHub');
});

test('an expired stored sign-in is dropped without asking GitHub', async () => {
  const ctx = await boot({ token: { token: TOKEN, expiresAt: Date.now() + 30000 } });
  assert.equal(ctx.storedToken(), null, 'a token within a minute of expiry was kept');
  assert.equal(ctx.requests.length, 0);
  assert.ok(ctx.notice().querySelector('[data-direct-action="signin"]'));
});

test('a stored sign-in GitHub no longer accepts is dropped, with a note', async () => {
  const ctx = await boot({ token: { token: TOKEN, expiresAt: null }, user: 401 });
  assert.equal(ctx.storedToken(), null);
  assert.match(ctx.notice().textContent, /sign-in has expired/);
});

test('signing out forgets the token and keeps the answers', async () => {
  const ctx = await boot({ token: { token: TOKEN, expiresAt: null } });
  answer(ctx, 'title', 'Kept');
  ctx.notice().querySelector('[data-direct-action="signout"]').click();
  assert.equal(ctx.storedToken(), null);
  assert.match(ctx.notice().textContent, /Signed out\. Your answers are still here\./);
  assert.equal(ctx.form.querySelector('[data-field="title"] input').value, 'Kept');
});

/* -------------------------------------------------------------- sending */

test('signed in, Submit to GitHub creates the issue as the submitter, and only then deletes the draft', async () => {
  let release;
  const ctx = await readyToSubmit({
    post: () =>
      new Promise((resolve) => {
        release = () =>
          resolve(reply(201, { number: 42, html_url: 'https://github.com/' + REPO + '/issues/42' }));
      }),
  });
  assert.match(ctx.form.querySelector('[data-review]').textContent, /Signed in to GitHub as @octo-cat/);
  assert.doesNotMatch(ctx.form.querySelector('[data-review]').textContent, /GitHub can drop your answers/);
  const next = ctx.form.querySelector('[data-review] [data-direct-copy]');
  assert.equal(next.hidden, false);
  assert.equal(ctx.form.querySelector('[data-review] [data-handoff-copy]').hidden, true);

  const button = press(ctx, 'Submit to GitHub');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Submitting…');
  // A second press while the first is out sends nothing.
  button.disabled = false;
  button.click();
  assert.equal(ctx.posts().length, 1, 'a double press sent twice');
  await flush();
  assert.ok(ctx.storedDraft(), 'the draft was deleted before GitHub answered');

  const [request] = ctx.posts();
  assert.equal(request.url, ISSUES_URL);
  assert.equal(request.init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(request.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(request.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  const sent = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'title']);
  assert.equal(sent.title, '[Use case] Water routing');
  const fields = ctx.window.SubmitForm.readFields(ctx.form);
  assert.equal(sent.body, ctx.window.SubmitForm.issueFormBody(fields));
  assert.match(sent.body, /^### Title\n\nWater routing\n\n### /);

  release();
  await flush();
  assert.equal(ctx.storedDraft(), null, 'the draft survived a 201');
  assert.equal(ctx.window.localStorage.getItem(ctx.draftKey + ':previous'), null);
  const panel = ctx.form.querySelector('[data-review]');
  assert.match(panel.textContent, /Submitted — thank you/);
  assert.match(panel.textContent, /issue #42/);
  const link = Array.from(panel.querySelectorAll('a')).find((a) => /View #42/.test(a.textContent));
  assert.equal(link.href, 'https://github.com/' + REPO + '/issues/42');
  assert.match(panel.textContent, /drag the file in under “Slide deck or one-pager \(PDF\)”/);
  assert.equal(ctx.opened.length, 0, 'a direct send also opened the hand-off');
});

test('a 201 whose link is not on github.com links to the submitter’s issues instead', async () => {
  const ctx = await readyToSubmit({
    post: () => reply(201, { number: 7, html_url: 'https://evil.example/7' }),
  });
  press(ctx, 'Submit to GitHub');
  await flush();
  const link = Array.from(ctx.form.querySelectorAll('[data-review] a')).find((a) =>
    /View #7/.test(a.textContent)
  );
  assert.match(link.href, /^https:\/\/github\.com\/crypticpy\/phct\/issues\?q=/);
});

for (const [code, pattern] of [
  [403, /may not be installed/],
  [404, /may not be installed/],
  [410, /Issues are turned off/],
  [422, /turned the issue down\. GitHub said: “Validation Failed”/],
  [418, /did not create the issue \(HTTP 418\)/],
]) {
  test(`a ${code} keeps the draft and offers GitHub’s form`, async () => {
    const ctx = await readyToSubmit({ post: () => reply(code, { message: 'Validation Failed' }) });
    const button = press(ctx, 'Submit to GitHub');
    await flush();
    assert.ok(ctx.storedDraft(), 'the draft was deleted on a ' + code);
    assert.match(status(ctx).textContent, pattern);
    assert.equal(status(ctx).hidden, false);
    assert.equal(button.disabled, false, 'the button stayed held');
    assert.ok(ctx.storedToken(), 'the token was dropped on a ' + code);
    status(ctx).querySelector('[data-direct-action="fallback"]').click();
    assert.equal(ctx.opened.length, 1);
    assert.match(ctx.opened[0].url, /^https:\/\/github\.com\/crypticpy\/phct\/issues\/new\?/);
  });
}

test('a 5xx may have created the issue: keep the draft, point at the submitter’s issues', async () => {
  const ctx = await readyToSubmit({ post: () => reply(502, null) });
  press(ctx, 'Submit to GitHub');
  await flush();
  assert.ok(ctx.storedDraft());
  assert.match(status(ctx).textContent, /HTTP 502\) and may or may not have created your issue/);
  const check = status(ctx).querySelector('[data-direct-action="check"]');
  assert.equal(check.href, 'https://github.com/crypticpy/phct/issues?q=is%3Aissue%20author%3A%40me');
  assert.ok(status(ctx).querySelector('[data-direct-action="fallback"]'));
});

for (const [name, error, pattern] of [
  ['a network failure', new TypeError('Failed to fetch'), /connection to GitHub failed/],
  ['a timeout', Object.assign(new Error('aborted'), { name: 'AbortError' }), /did not answer in time/],
]) {
  test(`${name} keeps the draft and says to check author:@me before trying again`, async () => {
    const ctx = await readyToSubmit({ post: () => Promise.reject(error) });
    const button = press(ctx, 'Submit to GitHub');
    await flush();
    assert.ok(ctx.storedDraft());
    assert.match(status(ctx).textContent, pattern);
    assert.match(status(ctx).textContent, /Check your issues on GitHub before you submit again/);
    assert.ok(status(ctx).querySelector('[data-direct-action="check"]'));
    assert.equal(button.disabled, false);
  });
}

test('a 401 forgets the token, keeps the draft, and sends once the submitter signs in again', async () => {
  let calls = 0;
  const ctx = await readyToSubmit({
    post: () => {
      calls += 1;
      return calls === 1
        ? reply(401, { message: 'Bad credentials' })
        : reply(201, { number: 9, html_url: 'https://github.com/' + REPO + '/issues/9' });
    },
  });
  press(ctx, 'Submit to GitHub');
  await flush();
  assert.equal(ctx.storedToken(), null, 'the dead token was kept');
  assert.ok(ctx.storedDraft());
  assert.match(status(ctx).textContent, /sign-in has expired, so nothing was sent/);
  status(ctx).querySelector('[data-direct-action="resignin"]').click();
  assert.equal(ctx.opened.length, 1);
  assert.match(ctx.opened[0].url, /\/api\/login\?/);
  const fresh = 'ghu_' + 'b'.repeat(36);
  post(ctx, { type: 'phct-github-token', token: fresh, expires_in: 28800 });
  await flush();
  await flush();
  assert.equal(ctx.posts().length, 2);
  assert.equal(ctx.posts()[1].init.headers.Authorization, 'Bearer ' + fresh);
  assert.equal(ctx.storedDraft(), null);
  assert.match(ctx.form.querySelector('[data-review]').textContent, /issue #9/);
});

test('a sign-in that ran out before the press asks for a fresh one instead of switching routes', async () => {
  const ctx = await readyToSubmit();
  ctx.window.sessionStorage.setItem(STORE, JSON.stringify({ token: TOKEN, expiresAt: Date.now() - 1 }));
  press(ctx, 'Submit to GitHub');
  await flush();
  assert.equal(ctx.posts().length, 0);
  assert.equal(ctx.opened.length, 0, 'it fell back to the hand-off unasked');
  assert.ok(status(ctx).querySelector('[data-direct-action="resignin"]'));
  assert.ok(ctx.storedDraft());
});

test('answers longer than GitHub takes in one issue are not sent, and are all kept', async () => {
  const ctx = await boot({ token: { token: TOKEN, expiresAt: null } });
  fillRequired(ctx);
  answer(ctx, 'body', 'x'.repeat(66000));
  await settleDraft();
  toReview(ctx);
  press(ctx, 'Submit to GitHub');
  await flush();
  assert.equal(ctx.posts().length, 0);
  assert.match(status(ctx).textContent, /more than the 65,536 GitHub allows/);
  assert.ok(ctx.storedDraft());
  assert.ok(status(ctx).querySelector('[data-direct-action="fallback"]'));
});
