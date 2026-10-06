/**
 * The /status/ page (assets/js/status-page.js), driven through a real DOM with GitHub's
 * API mocked.
 *
 * The fixture is a snapshot of the Liquid-rendered page (see the comment at the top of
 * test/fixtures/status-page.html), so these tests exercise the markup the site ships.
 * The rules the page applies (what a label means, what a number is) are pinned down on
 * their own in submission_status.test.mjs; this file is about what the reader sees and
 * hears, and what the page asks GitHub.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'status-page.html'), 'utf8');
const REPO = 'crypticpy/phct';

const booted = [];
test.after(() => booted.forEach((dom) => dom.window.close()));

// The module wires the page up as soon as it loads, as it does in the browser. Imported
// once, against a page without the status app (so that first run does nothing); each test
// then gets a fresh page and calls initStatusPage itself. One import keeps coverage
// attributed to assets/js/status-page.js rather than to a new URL per test.
const blank = new JSDOM('<!doctype html><body></body>');
booted.push(blank);
globalThis.document = blank.window.document;
const { initStatusPage } = await import('../../assets/js/status-page.js');

/** A Response-shaped answer. */
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/** An issue as the REST API returns it. */
function issue(overrides = {}) {
  return {
    number: 42,
    title: '[Use case] Permit intake triage',
    state: 'open',
    state_reason: null,
    created_at: '2026-03-04T12:00:00Z',
    html_url: `https://github.com/${REPO}/issues/42`,
    labels: [{ name: 'content:new-entry' }, { name: 'status:in-review' }],
    ...overrides,
  };
}

/**
 * A status page with the script running against it.
 * @param {{url?: string, respond?: (url: string) => Promise<object>|object, html?: string}} [options]
 *   `respond` answers each fetch (a thrown error or rejected promise is a network failure).
 * @returns {Promise<{win: object, doc: Document, requests: string[]}>}
 */
async function boot({
  url = 'https://example.org/status/',
  respond = () => answer(200, issue()),
  html = HTML,
} = {}) {
  const dom = new JSDOM('<!doctype html><body>' + html + '</body>', { url, pretendToBeVisual: true });
  booted.push(dom);
  const win = dom.window;
  const requests = [];
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.fetch = async (address, init) => {
    requests.push(String(address));
    assert.equal(init?.headers?.Accept, 'application/vnd.github+json');
    return respond(String(address));
  };
  initStatusPage();
  return { win, doc: win.document, requests };
}

const live = (doc) => doc.querySelector('[data-status-live]').textContent;
const result = (doc) => doc.querySelector('[data-status-result]');
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

/** Wait until the live region has said something other than "Checking…". */
async function settled(doc) {
  for (let i = 0; i < 200; i += 1) {
    const said = live(doc);
    if (said && !said.startsWith('Checking')) return said;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`the live region never settled (last said: "${live(doc)}")`);
}

/** Type into the number box and press the button. */
function check(ctx, value) {
  const input = ctx.doc.querySelector('[data-status-input]');
  input.focus();
  input.value = value;
  ctx.doc.querySelector('[data-status-form] button[type="submit"]').click();
}

/* ------------------------------------------------------------------ found */

test('a submission: title, date, stage in words and steps, what happens next, and the GitHub link', async () => {
  const ctx = await boot();
  check(ctx, '#42');
  const said = await settled(ctx.doc);

  assert.deepEqual(ctx.requests, [`https://api.github.com/repos/${REPO}/issues/42`]);
  const card = result(ctx.doc);
  assert.equal(card.hidden, false);
  assert.equal(card.hasAttribute('aria-busy'), false);
  assert.equal(text(card.querySelector('h2')), '[Use case] Permit intake triage');
  assert.match(text(card), /Submission #42/);
  assert.match(text(card), /Submitted March 4, 2026/);
  assert.match(text(card), /Where it is now: In review/);

  const steps = [...card.querySelectorAll('ol[aria-label="Progress"] > li')];
  assert.deepEqual(
    steps.map((li) => [
      li.querySelector('[data-step-num]').textContent,
      li.querySelector('[data-step-state]').textContent + li.querySelector('[data-step-label]').textContent,
      li.dataset.state,
      li.getAttribute('aria-current'),
    ]),
    [
      ['1', 'Done: Received', 'done', null],
      ['2', 'Current stage: In review', 'current', 'step'],
      ['3', 'Not yet: Published', 'upcoming', null],
    ],
    'each step says its state in words, not just in colour'
  );
  assert.match(text(card), /the reviewers are reading it/, 'the next-step line for the stage');
  assert.doesNotMatch(text(card), /best guess/, 'a labelled issue is not called a guess');

  const link = [...card.querySelectorAll('a')].find(
    (a) => a.textContent === 'Open your submission on GitHub'
  );
  assert.ok(link, 'no "Open your submission on GitHub" link');
  assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues/42`);

  assert.equal(said, 'Submission #42, [Use case] Permit intake triage: In review.');
  assert.equal(
    new URL(ctx.win.location.href).searchParams.get('n'),
    '42',
    'the address can be shared as it is'
  );
  assert.equal(ctx.doc.activeElement, ctx.doc.querySelector('[data-status-input]'), 'focus stays put');
});

test('text from the API is shown as text, never parsed as markup', async () => {
  const ctx = await boot({
    respond: () => answer(200, issue({ title: '<img src=x onerror="window.pwned=1">Hi' })),
  });
  check(ctx, '42');
  await settled(ctx.doc);
  const card = result(ctx.doc);
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('h2').textContent, '<img src=x onerror="window.pwned=1">Hi');
  assert.equal(ctx.win.pwned, undefined);
});

test('changes requested appears as its own step; an unlabelled issue is labelled a best guess', async () => {
  const ctx = await boot({
    respond: (url) =>
      url.endsWith('/7')
        ? answer(
            200,
            issue({ number: 7, labels: [{ name: 'content:refresh' }, { name: 'status:changes-requested' }] })
          )
        : answer(200, issue({ labels: ['content:new-entry'], state: 'closed', state_reason: 'not_planned' })),
  });
  check(ctx, '7');
  await settled(ctx.doc);
  assert.deepEqual(
    [...result(ctx.doc).querySelectorAll('ol > li [data-step-label]')].map((node) => node.textContent),
    ['Received', 'In review', 'Changes requested', 'Published']
  );
  assert.match(text(result(ctx.doc)), /reply there/);

  check(ctx, '8');
  await settled(ctx.doc);
  const card = result(ctx.doc);
  assert.match(text(card), /Where it is now: Not published/);
  assert.match(text(card), /This is our best guess, worked out from GitHub\./);
  assert.deepEqual(
    [...card.querySelectorAll('ol > li [data-step-label]')].map((node) => node.textContent),
    ['Received', 'Not published']
  );
});

/** A draft pull request as the issues API returns it: `pull_request` set, `body` the PR description. */
function draft(number, body) {
  return issue({
    number,
    title: `Add Permit intake triage (#${number})`,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    labels: [{ name: 'intake' }],
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
    body,
  });
}

const NOT_SUBMISSION =
  /^Number 101 isn't a submission\. Enter the number of your submission itself \(the issue\), not of its draft\./;

/* ------------------------------------------------------ a draft's number */

test('a draft pull request that closes a submission shows that submission', async () => {
  const ctx = await boot({
    respond: (url) =>
      url.endsWith('/101')
        ? answer(200, draft(101, 'Scaffolded from the submission.\n\nCloses #97\n'))
        : answer(200, issue({ number: 97, html_url: `https://github.com/${REPO}/issues/97` })),
  });
  check(ctx, '101');
  const said = await settled(ctx.doc);

  assert.deepEqual(ctx.requests, [
    `https://api.github.com/repos/${REPO}/issues/101`,
    `https://api.github.com/repos/${REPO}/issues/97`,
  ]);
  const card = result(ctx.doc);
  assert.equal(text(card.querySelector('h2')), '[Use case] Permit intake triage');
  assert.match(text(card), /#101 is the draft for submission #97\./);
  assert.match(text(card), /Submission #97/);
  assert.match(text(card), /Where it is now: In review/);
  const link = [...card.querySelectorAll('a')].find(
    (a) => a.textContent === 'Open your submission on GitHub'
  );
  assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues/97`);
  assert.equal(
    said,
    '#101 is the draft for submission #97. Submission #97, [Use case] Permit intake triage: In review.'
  );
  assert.equal(
    new URL(ctx.win.location.href).searchParams.get('n'),
    '101',
    'the address keeps what was typed'
  );
});

test('a draft pull request that links nothing gets the not-a-submission message', async () => {
  const ctx = await boot({ respond: () => answer(200, draft(101, 'A draft with no closing line.')) });
  check(ctx, '101');
  const said = await settled(ctx.doc);
  assert.deepEqual(ctx.requests, [`https://api.github.com/repos/${REPO}/issues/101`], 'no second lookup');
  assert.match(said, NOT_SUBMISSION);
  assert.equal(result(ctx.doc).querySelector('h2'), null, 'no submission card');
  const link = result(ctx.doc).querySelector('a');
  assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues?q=is%3Aissue%20author%3A%40me`);
});

test('a pull request with no body at all gets the same message', async () => {
  const ctx = await boot({ respond: () => answer(200, draft(101, null)) });
  check(ctx, '101');
  assert.match(await settled(ctx.doc), NOT_SUBMISSION);
  assert.equal(ctx.requests.length, 1);
});

test('a pull request that closes an issue which is not a submission gets the same message', async () => {
  for (const linkedIssue of [
    answer(200, issue({ number: 97, labels: [{ name: 'bug' }] })),
    answer(200, draft(97, 'Closes #96')),
    answer(404, { message: 'Not Found' }),
  ]) {
    const ctx = await boot({
      respond: (url) => (url.endsWith('/101') ? answer(200, draft(101, 'Fixes #97')) : linkedIssue),
    });
    check(ctx, '101');
    const said = await settled(ctx.doc);
    assert.deepEqual(
      ctx.requests,
      [`https://api.github.com/repos/${REPO}/issues/101`, `https://api.github.com/repos/${REPO}/issues/97`],
      'one follow-up lookup, never a chain'
    );
    assert.match(said, NOT_SUBMISSION, `linked issue answered ${linkedIssue.status}`);
    assert.equal(result(ctx.doc).querySelector('h2'), null, 'no submission card');
  }
});

test('a pull request that closes itself is not looked up twice', async () => {
  const ctx = await boot({ respond: () => answer(200, draft(101, 'Closes #101')) });
  check(ctx, '101');
  assert.match(await settled(ctx.doc), NOT_SUBMISSION);
  assert.equal(ctx.requests.length, 1);
});

test('when GitHub stops answering on the follow-up, the fallback link goes to the submission', async () => {
  const ctx = await boot({
    respond: (url) =>
      url.endsWith('/101')
        ? answer(200, draft(101, 'Closes #97'))
        : answer(403, { message: 'API rate limit exceeded' }),
  });
  check(ctx, '101');
  const said = await settled(ctx.doc);
  assert.match(said, /^#101 is the draft for submission #97\. GitHub limits how often/);
  const link = result(ctx.doc).querySelector('a');
  assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues/97`);
  assert.equal(link.textContent, 'Open submission #97 on GitHub');
});

test('a newer lookup retires a draft whose follow-up is still running', async () => {
  let releaseFollowUp;
  const ctx = await boot({
    respond: (url) => {
      if (url.endsWith('/101')) return answer(200, draft(101, 'Closes #97'));
      if (url.endsWith('/97'))
        return new Promise((resolve) => {
          releaseFollowUp = () => resolve(answer(200, issue({ number: 97, title: 'Stale' })));
        });
      return answer(200, issue({ number: 2, title: 'Second' }));
    },
  });
  check(ctx, '101');
  for (let i = 0; i < 200 && !releaseFollowUp; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(releaseFollowUp, 'the follow-up lookup never started');
  check(ctx, '2');
  await settled(ctx.doc);
  releaseFollowUp();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(result(ctx.doc).querySelector('h2').textContent, 'Second');
});

/* ----------------------------------------------------------------- refused */

test('an issue with no content label is not a submission either', async () => {
  const ctx = await boot({ respond: () => answer(200, issue({ labels: [{ name: 'bug' }] })) });
  check(ctx, '42');
  assert.match(await settled(ctx.doc), /^Number 42 isn't a submission\./);
  assert.equal(ctx.requests.length, 1);
});

test('404: we could not find that number', async () => {
  const ctx = await boot({ respond: () => answer(404, { message: 'Not Found' }) });
  check(ctx, '42');
  const said = await settled(ctx.doc);
  assert.match(said, /^We couldn't find submission #42\./);
  assert.match(text(result(ctx.doc)), /See every submission you have made on GitHub/);
});

/* --------------------------------------------------------------- fallback */

for (const status of [403, 429]) {
  test(`rate limited (${status}): a plain link to the issue on GitHub`, async () => {
    const ctx = await boot({ respond: () => answer(status, { message: 'API rate limit exceeded' }) });
    check(ctx, '42');
    const said = await settled(ctx.doc);
    assert.match(said, /GitHub limits how often this page can look things up/);
    const link = result(ctx.doc).querySelector('a');
    assert.equal(link.getAttribute('href'), `https://github.com/${REPO}/issues/42`);
    assert.equal(link.textContent, 'Open submission #42 on GitHub');
  });
}

test('a network failure falls back to the same plain link', async () => {
  const ctx = await boot({
    respond: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  check(ctx, '42');
  assert.match(await settled(ctx.doc), /^We couldn't reach GitHub just now\./);
  assert.equal(
    result(ctx.doc).querySelector('a').getAttribute('href'),
    `https://github.com/${REPO}/issues/42`
  );
});

test('a 200 whose body is not JSON is treated as GitHub being unavailable', async () => {
  const ctx = await boot({
    respond: () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  check(ctx, '42');
  assert.match(await settled(ctx.doc), /couldn't reach GitHub/);
});

/* ------------------------------------------------------------------- input */

test('a number that is not a number is caught before anything is sent', async () => {
  const ctx = await boot();
  const input = ctx.doc.querySelector('[data-status-input]');
  const error = ctx.doc.querySelector('[data-status-error]');

  check(ctx, '42abc');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(ctx.requests, []);
  assert.equal(error.hidden, false);
  assert.equal(text(error), 'Enter your submission number using digits only, like 42.');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(input.getAttribute('aria-describedby').split(' '), ['status-number-hint', error.id]);
  assert.equal(live(ctx.doc), 'Enter your submission number using digits only, like 42.');
  assert.equal(ctx.doc.activeElement, input);
  assert.equal(ctx.doc.querySelector('form').hasAttribute('novalidate'), true);

  check(ctx, '');
  assert.equal(text(error), 'Enter your submission number, like 42.');

  check(ctx, '42');
  await settled(ctx.doc);
  assert.equal(error.hidden, true, 'a good number clears the error');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(input.getAttribute('aria-describedby'), 'status-number-hint');
});

/* ---------------------------------------------------------------- ?n= link */

test('?n= looks the number up on load, without moving focus or rewriting the address', async () => {
  const ctx = await boot({ url: 'https://example.org/status/?n=%2317&utm=email' });
  const said = await settled(ctx.doc);
  assert.deepEqual(ctx.requests, [`https://api.github.com/repos/${REPO}/issues/17`]);
  assert.equal(ctx.doc.querySelector('[data-status-input]').value, '#17');
  assert.match(said, /: In review\.$/);
  assert.notEqual(ctx.doc.activeElement, ctx.doc.querySelector('[data-status-input]'));
  assert.equal(ctx.win.location.search, '?n=%2317&utm=email');
});

test('a malformed ?n= shows the error without sending anything or taking focus', async () => {
  const ctx = await boot({ url: 'https://example.org/status/?n=abc' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(ctx.requests, []);
  assert.equal(ctx.doc.querySelector('[data-status-error]').hidden, false);
  assert.notEqual(ctx.doc.activeElement, ctx.doc.querySelector('[data-status-input]'));
});

test('no ?n= means no request until the reader asks', async () => {
  const ctx = await boot({ url: 'https://example.org/status/?n=' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(ctx.requests, []);
  assert.equal(result(ctx.doc).hidden, true);
});

/* ------------------------------------------------------------------- races */

test('a slow answer to an earlier lookup never replaces a newer one', async () => {
  let releaseFirst;
  const ctx = await boot({
    respond: (url) =>
      url.endsWith('/1')
        ? new Promise((resolve) => {
            releaseFirst = () => resolve(answer(200, issue({ number: 1, title: 'First' })));
          })
        : answer(200, issue({ number: 2, title: 'Second' })),
  });
  check(ctx, '1');
  check(ctx, '2');
  await settled(ctx.doc);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(result(ctx.doc).querySelector('h2').textContent, 'Second');
  assert.match(live(ctx.doc), /^Submission #2, Second/);
});

test('a slow answer never lands over a later invalid entry', async () => {
  let releaseFirst;
  const ctx = await boot({
    respond: () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve(answer(200, issue({ number: 1, title: 'First' })));
      }),
  });
  check(ctx, '1');
  check(ctx, 'abc');
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(result(ctx.doc).querySelector('h2'), null, 'the stale answer was rendered');
  assert.equal(ctx.doc.querySelector('input[name=n]').getAttribute('aria-invalid'), 'true');
});

test('without a repository the script leaves the page alone', async () => {
  const ctx = await boot({
    url: 'https://example.org/status/?n=42',
    html: HTML.replace(`data-repo="${REPO}"`, 'data-repo=""'),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(ctx.requests, []);
  assert.equal(ctx.doc.querySelector('form').hasAttribute('novalidate'), false);
});
