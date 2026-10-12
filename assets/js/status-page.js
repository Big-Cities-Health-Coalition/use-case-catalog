// The /status/ page: look a submission up by the number GitHub gave it.
//
// ES module, loaded by status/index.md. It asks GitHub's public REST API for the issue
// (unauthenticated, from the reader's browser: nothing is sent anywhere else) and shows
// its title, the date it came in and its stage. What a response MEANS is decided in
// ./lib/submission-status.js; this file only turns that into DOM. Every string that
// came from the API is set with textContent, never parsed as HTML.
//
// A reader who types the number of a submission's draft pull request (every draft says
// "Closes #<submission>", and the bot links it from the issue) is shown the submission
// that draft closes: one follow-up request, under the same abort, timeout and
// retirement as the first.
//
// When GitHub cannot answer (the anonymous hourly allowance is used up, the network is
// down, the request times out) the page falls back to a plain link to the issue on
// GitHub, built from the repository and the number, so the reader is never stuck.
//
// MARKUP CONTRACT (status/index.md)
//   [data-status-app][data-repo]          mount point; data-repo is site.yml's github.repository
//   [data-status-form]                    the lookup form (a plain GET to this page without scripts)
//   [data-status-input]                   the number box, described by its hint
//   [data-status-error]                   inline validation message under the box,
//     [data-status-error-text]            with its text slot
//   [data-status-live]                    role=status region; every outcome is announced here
//   [data-status-result]                  where the outcome is rendered
//   template[data-status-step]            one step of the progress list
//   template[data-status-stage=<id>]      a stage's name (data-label) and what happens next

import {
  formatDate,
  interpretResponse,
  isRepository,
  issueApiUrl,
  mySubmissionsUrl,
  parseIssueNumber,
  stepsFor,
} from './lib/submission-status.js';

/** Longest wait for GitHub before falling back to the plain link. */
const TIMEOUT_MS = 10000;

/** Words a screen reader hears before each step's name; the circle's fill says the same visually. */
const STEP_STATE_WORDS = { done: 'Done: ', current: 'Current stage: ', upcoming: 'Not yet: ' };

/**
 * Wire the page up. Called once below, when the module loads; safe on a page without the
 * status app (it does nothing).
 */
export function initStatusPage() {
  const app = document.querySelector('[data-status-app]');
  if (!app) return;
  const repo = app.dataset.repo || '';
  if (!isRepository(repo)) return;

  const form = app.querySelector('[data-status-form]');
  const input = app.querySelector('[data-status-input]');
  const error = app.querySelector('[data-status-error]');
  const errorText = app.querySelector('[data-status-error-text]');
  const live = app.querySelector('[data-status-live]');
  const result = app.querySelector('[data-status-result]');
  if (!form || !input || !live || !result) return;

  // The browser's own validation would stop a submit that this script can explain better.
  form.setAttribute('novalidate', '');
  const hintIds = input.getAttribute('aria-describedby') || '';

  /** Bumped on every lookup, so a slow answer to an earlier one is never painted over a newer one. */
  let latest = 0;
  /** @type {AbortController|null} */
  let inFlight = null;

  /**
   * Element builder: `text` sets textContent, everything else is an attribute.
   * @param {string} tag
   * @param {object} [props]
   * @param {Array<Node|string>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'text') node.textContent = value;
      else node.setAttribute(name, String(value));
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  /** @type {number|undefined} */
  let announceTimer;

  /** @param {string} message */
  function announce(message) {
    // Clearing first makes a repeated message (the same lookup twice) announce again;
    // cancelling the pending write keeps a fast answer from being overtaken by the
    // "Checking" line that preceded it.
    window.clearTimeout(announceTimer);
    live.textContent = '';
    announceTimer = window.setTimeout(() => {
      live.textContent = message;
    }, 50);
  }

  /** A stage's display name and next-step line, from the Liquid-rendered templates. */
  function stageCopy(stage) {
    const template = app.querySelector(`template[data-status-stage="${stage}"]`);
    return {
      label: (template && template.dataset.label) || stage,
      next: template ? template.content.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  }

  function clearResult() {
    result.textContent = '';
    result.hidden = true;
    result.removeAttribute('aria-busy');
  }

  /** @param {string} message @param {boolean} moveFocus */
  function showInvalid(message, moveFocus) {
    if (error && errorText) {
      errorText.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-describedby', `${hintIds} ${error.id}`.trim());
    }
    input.setAttribute('aria-invalid', 'true');
    clearResult();
    announce(message);
    if (moveFocus && document.activeElement !== input) input.focus();
  }

  function clearInvalid() {
    if (error) error.hidden = true;
    if (errorText) errorText.textContent = '';
    input.removeAttribute('aria-invalid');
    if (hintIds) input.setAttribute('aria-describedby', hintIds);
    else input.removeAttribute('aria-describedby');
  }

  /** Put `?n=` in the address bar, so the page can be bookmarked or shared as it is. */
  function rememberNumber(number) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('n', String(number));
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // A history API that refuses (a sandboxed frame) only costs the shareable address.
    }
  }

  /** The progress list for a stage. */
  function stepList(stage) {
    const template = app.querySelector('template[data-status-step]');
    const list = el('ol', { class: 'mt-3', 'aria-label': 'Progress' });
    stepsFor(stage).forEach((step, index) => {
      const item = template ? template.content.firstElementChild.cloneNode(true) : el('li');
      item.setAttribute('data-state', step.state);
      if (step.current) item.setAttribute('aria-current', 'step');
      const num = item.querySelector('[data-step-num]');
      if (num) num.textContent = String(index + 1);
      const words = item.querySelector('[data-step-state]');
      if (words) words.textContent = step.current ? STEP_STATE_WORDS.current : STEP_STATE_WORDS[step.state];
      const label = item.querySelector('[data-step-label]') || item;
      label.append(stageCopy(step.id).label);
      list.append(item);
    });
    return list;
  }

  /** A neutral notice with an optional way onward. */
  function notice(message, link) {
    const children = [el('p', { text: message })];
    if (link) {
      children.push(
        el('p', { class: 'mt-2' }, [
          el('a', {
            class: 'font-semibold text-brand-primary underline underline-offset-2 hover:no-underline',
            href: link.href,
            text: link.text,
          }),
        ])
      );
    }
    return el(
      'div',
      { class: 'rounded-lg border border-brand-line bg-surface-card p-4 text-sm text-brand-ink' },
      children
    );
  }

  /** "#101 is the draft for submission #97." for an outcome reached through a draft's number. */
  function draftNote(outcome) {
    return `#${outcome.draft} is the draft for submission #${outcome.number}.`;
  }

  /** The found-it card. */
  function submissionCard(outcome) {
    const copy = stageCopy(outcome.stage);
    const submitted = formatDate(outcome.created);
    const header = [
      el('p', { class: 'eyebrow', text: `Submission #${outcome.number}` }),
      el('h2', {
        class: 'card-title mt-1',
        id: 'status-result-title',
        text: outcome.title || `Submission #${outcome.number}`,
      }),
    ];
    if (submitted)
      header.push(el('p', { class: 'mt-1 text-sm text-brand-muted', text: `Submitted ${submitted}` }));

    const body = [];
    if (outcome.draft)
      body.push(el('p', { class: 'mb-3 text-sm text-brand-muted', text: draftNote(outcome) }));
    body.push(
      el('p', { class: 'text-base text-brand-ink' }, [
        'Where it is now: ',
        el('strong', { text: copy.label }),
      ]),
      stepList(outcome.stage)
    );
    if (copy.next)
      body.push(
        el('p', { class: 'mt-4 rounded-lg bg-surface-tint p-4 text-sm text-brand-ink', text: copy.next })
      );
    if (outcome.derived) {
      body.push(
        el('p', {
          class: 'mt-3 text-xs text-brand-muted',
          text: 'This is our best guess, worked out from GitHub. Open your submission on GitHub for the full history.',
        })
      );
    }
    body.push(
      el('p', { class: 'mt-5' }, [
        el('a', { class: 'btn-primary', href: outcome.githubUrl, text: 'Open your submission on GitHub' }),
      ])
    );

    return el('section', { class: 'card', 'aria-labelledby': 'status-result-title' }, [
      el('div', { class: 'card-header' }, header),
      el('div', { class: 'px-6 py-5' }, body),
    ]);
  }

  /**
   * Paint an outcome and announce it.
   * @param {object} outcome from interpretResponse; `draft` is set (the number typed) when
   *   it is the submission a draft pull request closes, looked up in its place
   */
  function render(outcome) {
    const n = outcome.number;
    const mine = { href: mySubmissionsUrl(repo), text: 'See every submission you have made on GitHub' };
    const direct = { href: outcome.githubUrl, text: `Open submission #${n} on GitHub` };
    const via = outcome.draft ? `${draftNote(outcome)} ` : '';
    let node;
    let message;
    if (outcome.kind === 'submission') {
      node = submissionCard(outcome);
      message = `${via}Submission #${n}${outcome.title ? `, ${outcome.title}` : ''}: ${stageCopy(outcome.stage).label}.`;
    } else if (outcome.kind === 'not-found') {
      message = `We couldn't find submission #${n}. Check the number in the emails GitHub sent you and try again.`;
      node = notice(message, mine);
    } else if (outcome.kind === 'not-submission') {
      message = `Number ${n} isn't a submission. Enter the number of your submission itself (the issue), not of its draft. It is in the emails GitHub sent you.`;
      node = notice(message, mine);
    } else if (outcome.kind === 'rate-limited') {
      message = `${via}GitHub limits how often this page can look things up, and that limit has been reached for now. You can still open submission #${n} on GitHub directly.`;
      node = notice(message, direct);
    } else {
      message = `${via}We couldn't reach GitHub just now. You can still open submission #${n} on GitHub directly, or try again in a moment.`;
      node = notice(message, direct);
    }
    result.textContent = '';
    result.append(node);
    result.hidden = false;
    result.removeAttribute('aria-busy');
    announce(message);
  }

  /**
   * Ask GitHub for one issue and say what the answer means. A failed request (network,
   * timeout, abort, a body that is not JSON) reads as GitHub being unavailable.
   * @param {number} number
   * @param {AbortSignal} signal
   * @returns {Promise<object>} from interpretResponse
   */
  async function fetchOutcome(number, signal) {
    try {
      const response = await fetch(issueApiUrl(repo, number), {
        headers: { Accept: 'application/vnd.github+json' },
        signal,
      });
      const body = response.status === 200 ? await response.json() : null;
      return interpretResponse(response.status, body, { repo, number });
    } catch {
      return interpretResponse(0, null, { repo, number });
    }
  }

  /**
   * Look a number up and show the answer.
   * @param {string} raw what was typed, or the `?n=` parameter
   * @param {{fromReader: boolean}} options `fromReader` is false for the on-load lookup,
   *   which neither moves focus nor rewrites the address it was opened with.
   */
  async function lookup(raw, { fromReader }) {
    const number = parseIssueNumber(raw);
    if (number === null) {
      // Retire any lookup still running, so its answer can't land over the error.
      latest += 1;
      if (inFlight) inFlight.abort();
      inFlight = null;
      showInvalid(
        String(raw).trim() === ''
          ? 'Enter your submission number, like 42.'
          : 'Enter your submission number using digits only, like 42.',
        fromReader
      );
      return;
    }
    clearInvalid();
    if (fromReader) rememberNumber(number);

    latest += 1;
    const ticket = latest;
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    result.setAttribute('aria-busy', 'true');
    announce(`Checking submission #${number}.`);

    let outcome;
    try {
      outcome = await fetchOutcome(number, controller.signal);
      // A draft pull request's number: show the submission its body closes. One hop only.
      // When GitHub cannot answer that second request, its fallback link to the submission
      // is shown; when the linked issue is not a submission, the reader is told about the
      // number they typed.
      const linked = outcome.reason === 'pull-request' ? outcome.linked : null;
      if (ticket === latest && linked && linked !== number) {
        const followed = await fetchOutcome(linked, controller.signal);
        if (['submission', 'rate-limited', 'unavailable'].includes(followed.kind)) {
          outcome = { ...followed, draft: number };
        }
      }
    } finally {
      window.clearTimeout(timer);
    }
    if (ticket !== latest) return;
    inFlight = null;
    render(outcome);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    lookup(input.value, { fromReader: true });
  });

  const linked = new URLSearchParams(window.location.search).get('n');
  if (linked !== null && linked.trim() !== '') {
    input.value = linked.trim();
    lookup(linked, { fromReader: false });
  }
}

initStatusPage();
