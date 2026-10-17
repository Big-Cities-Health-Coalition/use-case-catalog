/**
 * Submit form — "Sign in with GitHub, submit directly". Optional.
 *
 * The link hand-off carries answers to GitHub's issue form in the URL, and a
 * long write-up does not fit: GitHub drops a prefilled link through its
 * sign-in page above about 5,400 characters and refuses one above about 8,000.
 * With `submit.signin_url` set in _data/site.yml, a submitter can instead sign
 * in with GitHub on this page and the answers are sent as an issue through
 * GitHub's REST API, as them, however long they are. The link hand-off stays
 * as it was for everyone who does not sign in, and is the way out whenever a
 * direct send fails.
 *
 * Sign-in is a GitHub App's web flow finished by a small service the site
 * owner deploys (services/github-signin/ in the template): a popup opens
 * `<signin_url>/api/login`, and the service's callback page posts the token
 * back to this window. Only a message from that exact origin, from the popup
 * this page opened, with the expected shape, is accepted. The token is kept in
 * sessionStorage — this tab only, gone when it closes — with its expiry, and
 * is sent to api.github.com and nowhere else. It is never part of the draft.
 *
 * Only loaded when `submit.signin_url` is set: submit/index.md then renders
 * this script and `data-signin-url` on the form. It runs before the other
 * submit scripts (it sits in the page body) and only defines initDirect;
 * assets/js/submit.js calls it at boot.
 *
 * DOM contract: [data-submit-form] with data-signin-url, data-repo and
 * data-draft-key; [data-signin-notice] (the intro's sign-in notice, whose
 * contents this replaces with the sign-in controls); [data-handoff-copy] /
 * [data-direct-copy] (the intro's two versions of the last step, one shown);
 * [data-review-status] (rendered by review.js when `handlers.direct` is set).
 *
 * The object initDirect returns also lets assets/js/submit/uploads.js (file
 * uploads, only when `submit.uploads_url` is set) use the sign-in: `token()`
 * hands out the bearer token for a request to the upload service (never to be
 * stored or logged), `userId()` / `login()` say whose it is, `onChange(fn)`
 * reports every sign-in state change, and `expire()` treats the token as dead.
 *
 * Exposes: window.SubmitForm.initDirect, .serviceOrigin
 */
(function (ns) {
  'use strict';

  const API = 'https://api.github.com';
  /** GitHub's ceiling on an issue body and title, in characters. */
  const MAX_BODY = 65536;
  const MAX_TITLE = 256;
  /** Long enough for a slow connection; past it the outcome is unknown. */
  const TIMEOUT_MS = 30000;
  /** Treat a token as expired a minute early, rather than send one mid-expiry. */
  const EARLY_MS = 60000;
  const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,512}$/;
  const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  const MESSAGE_TOKEN = 'phct-github-token';
  const MESSAGE_ERROR = 'phct-github-error';

  /**
   * The sign-in service's origin, or '' when `value` is not a usable address:
   * https only (plain http for a loopback address, for local testing).
   * @param {string} value
   * @returns {string}
   */
  function serviceOrigin(value) {
    let url;
    try {
      url = new URL(String(value || ''));
    } catch {
      return '';
    }
    const local = url.protocol === 'http:' && LOOPBACK_HOSTS.indexOf(url.hostname) !== -1;
    return url.protocol === 'https:' || local ? url.origin : '';
  }

  ns.serviceOrigin = serviceOrigin;

  /**
   * Wire "Sign in with GitHub" into the page.
   * @param {HTMLFormElement} form
   * @returns {null|{signedIn: () => boolean, login: () => string, userId: () => number|null,
   *   token: () => string|null, onChange: (fn: () => void) => void, expire: () => void,
   *   submit: (options: object) => void}}
   *   null when the site has no sign-in service (or no repository to send to)
   */
  ns.initDirect = function initDirect(form) {
    const origin = serviceOrigin(form.dataset.signinUrl);
    const repo = form.dataset.repo || '';
    if (!origin || !repo) return null;
    const el = ns.el;
    // Per repository and sign-in service: several sites can share one
    // *.github.io origin, and with it one sessionStorage, and a token from one
    // site's GitHub App is no use on another's repository.
    const storeKey = 'phct:github-signin:v1:' + repo + '@' + origin;
    const notice = document.querySelector('[data-signin-notice]');
    const mineUrl = 'https://github.com/' + repo + '/issues?q=' + encodeURIComponent('is:issue author:@me');

    /** Fallback when sessionStorage is refused: the token lives as long as the page. */
    let memory = null;
    let login = '';
    /** GitHub's numeric id for the signed-in account, once GitHub has been asked. */
    let userId = null;
    /** Callbacks told whenever the sign-in state is repainted. */
    const listeners = [];
    /** The sign-in window in progress: {popup, resolve, timer}. */
    let pending = null;
    let inFlight = false;

    // --- the token -----------------------------------------------------------

    /** @returns {{token: string, expiresAt: number|null}|null} a token still worth sending */
    function readToken() {
      let saved = memory;
      try {
        const stored = window.sessionStorage.getItem(storeKey);
        if (stored) saved = JSON.parse(stored);
      } catch {
        // Storage refused, or not JSON: the in-memory copy is all there is.
      }
      if (!saved || typeof saved.token !== 'string' || !TOKEN_PATTERN.test(saved.token)) return null;
      const expiresAt = typeof saved.expiresAt === 'number' ? saved.expiresAt : null;
      if (expiresAt !== null && Date.now() >= expiresAt - EARLY_MS) {
        clearToken();
        return null;
      }
      return { token: saved.token, expiresAt: expiresAt };
    }

    /** @param {{token: string, expiresAt: number|null}} saved */
    function writeToken(saved) {
      memory = saved;
      try {
        window.sessionStorage.setItem(storeKey, JSON.stringify(saved));
      } catch {
        // Kept in memory instead: it lasts until the page is left.
      }
    }

    function clearToken() {
      memory = null;
      login = '';
      userId = null;
      try {
        window.sessionStorage.removeItem(storeKey);
      } catch {
        // Nothing stored, nothing to remove.
      }
    }

    /** @param {string} token @returns {Record<string, string>} */
    function apiHeaders(token) {
      return {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      };
    }

    // --- the intro's sign-in controls -----------------------------------------

    const note = el('span', { class: 'mt-2 block text-brand-muted', role: 'status', hidden: true });
    const controls = el('span', { class: 'block' });
    const ui = el('span', { class: 'min-w-0' }, [controls, note]);
    if (notice) {
      // Keep the warning icon; replace the "sign in on github.com first" copy.
      Array.from(notice.childNodes).forEach((node) => {
        if (!(node.nodeName && node.nodeName.toLowerCase() === 'svg')) node.remove();
      });
      notice.append(ui);
    }

    /** @param {string} text '' hides the line */
    function sayNote(text) {
      note.textContent = text;
      note.hidden = text === '';
    }

    /** @param {'out'|'checking'|'in'} state */
    function paint(state) {
      paintControls(state);
      listeners.forEach((listener) => {
        try {
          listener();
        } catch {
          // A listener's trouble is not the sign-in's.
        }
      });
    }

    /** @param {'out'|'checking'|'in'} state */
    function paintControls(state) {
      // The intro's "what happens" steps, outside any template: say which
      // route a press of the last button will take.
      const signed = state !== 'out';
      document.querySelectorAll('[data-handoff-copy]').forEach((node) => {
        node.hidden = signed;
      });
      document.querySelectorAll('[data-direct-copy]').forEach((node) => {
        node.hidden = !signed;
      });
      controls.textContent = '';
      if (state === 'checking') {
        controls.append('Checking your GitHub sign-in…');
        return;
      }
      if (state === 'in') {
        controls.append(
          login ? 'Signed in to GitHub as ' : 'Signed in to GitHub',
          ...(login ? [el('strong', { text: '@' + login })] : []),
          '. When you submit, your answers go straight to GitHub from this page. ',
          el('button', {
            type: 'button',
            class: 'font-medium text-brand-primary underline underline-offset-2 hover:no-underline',
            'data-direct-action': 'signout',
            text: 'Sign out',
            onclick: signOut,
          })
        );
        return;
      }
      controls.append(
        el('strong', { text: 'Sign in with GitHub before you start.' }),
        ' Then your answers go straight to GitHub from this page when you submit, however long they are.',
        el('span', { class: 'mt-2 block' }, [
          el('button', {
            type: 'button',
            class: 'btn-secondary btn-sm',
            'data-direct-action': 'signin',
            text: 'Sign in with GitHub',
            onclick: () => {
              signIn();
            },
          }),
        ]),
        el('span', {
          class: 'mt-2 block text-brand-muted',
          text: 'It opens a small GitHub window. Or skip it: at the end you can still send your answers through GitHub’s own form.',
        })
      );
    }

    /** Ask GitHub who the token belongs to, to show it, and drop a dead token. */
    function checkUser() {
      const saved = readToken();
      if (!saved) {
        paint('out');
        return Promise.resolve();
      }
      paint('checking');
      return window
        .fetch(API + '/user', { headers: apiHeaders(saved.token) })
        .then((response) => {
          if (response.status === 401) {
            clearToken();
            paint('out');
            sayNote('Your GitHub sign-in has expired. Sign in again to submit from this page.');
            return;
          }
          return response.json().then((user) => {
            login = user && LOGIN_PATTERN.test(String(user.login)) ? String(user.login) : '';
            userId = user && Number.isInteger(user.id) && user.id > 0 ? user.id : null;
            paint('in');
          });
        })
        .catch(() => {
          // GitHub out of reach: keep the token, and say only that it is there.
          login = '';
          userId = null;
          paint(readToken() ? 'in' : 'out');
        });
    }

    function signOut() {
      clearToken();
      sayNote('Signed out. Your answers are still here.');
      paint('out');
    }

    /**
     * End the sign-in in progress.
     * @param {boolean} ok
     * @param {string} text what to tell the submitter, '' for nothing
     */
    function finish(ok, text) {
      if (!pending) return;
      const done = pending;
      pending = null;
      window.clearInterval(done.timer);
      sayNote(text);
      done.resolve(ok);
    }

    /**
     * Open the sign-in window.
     * @returns {Promise<boolean>} whether a token arrived
     */
    function signIn() {
      if (pending) {
        if (pending.popup && !pending.popup.closed && pending.popup.focus) pending.popup.focus();
        return new Promise((resolve) => {
          const earlier = pending.resolve;
          pending.resolve = (ok) => {
            earlier(ok);
            resolve(ok);
          };
        });
      }
      const url = origin + '/api/login?origin=' + encodeURIComponent(window.location.origin);
      const popup = window.open(url, 'phct-github-signin', 'popup,width=640,height=760');
      if (!popup) {
        sayNote(
          'Your browser blocked the GitHub sign-in window. Allow pop-ups for this site and try again — or skip signing in and send your answers through GitHub’s own form at the end.'
        );
        return Promise.resolve(false);
      }
      sayNote('Finish signing in in the GitHub window.');
      return new Promise((resolve) => {
        pending = { popup: popup, resolve: resolve, timer: 0 };
        const watched = pending;
        // A window closed without a message: the submitter gave up, or the
        // service could not reach this page. Wait a moment first — a token
        // posted just before the window closed may still be on its way.
        watched.timer = window.setInterval(() => {
          if (pending !== watched || !popup.closed) return;
          window.clearInterval(watched.timer);
          window.setTimeout(() => {
            if (pending === watched) finish(false, 'The GitHub window closed before sign-in finished.');
          }, 500);
        }, 500);
      });
    }

    window.addEventListener('message', (event) => {
      if (event.origin !== origin || !pending || event.source !== pending.popup) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === MESSAGE_TOKEN && typeof data.token === 'string' && TOKEN_PATTERN.test(data.token)) {
        const seconds = Number.isInteger(data.expires_in) && data.expires_in > 0 ? data.expires_in : 0;
        writeToken({ token: data.token, expiresAt: seconds ? Date.now() + seconds * 1000 : null });
        finish(true, '');
        checkUser();
        return;
      }
      if (data.type === MESSAGE_ERROR) {
        const text = typeof data.message === 'string' ? data.message.slice(0, 300) : '';
        finish(false, text || 'GitHub sign-in did not finish.');
      }
    });

    // --- sending --------------------------------------------------------------

    /**
     * Put the outcome of a send in the review panel's status region.
     * @param {HTMLElement|null} status
     * @param {string} text
     * @param {HTMLElement[]} actions buttons and links offered under it
     */
    function report(status, text, actions) {
      if (!status) return;
      status.textContent = '';
      status.append(
        el('p', { text: text }),
        ...(actions.length ? [el('div', { class: 'flex flex-wrap items-center gap-3' }, actions)] : [])
      );
      status.hidden = false;
    }

    /** @param {object} options from submit() @returns {HTMLElement} */
    function fallbackButton(options) {
      return el('button', {
        type: 'button',
        class: 'btn-secondary btn-sm',
        'data-direct-action': 'fallback',
        text: 'Use GitHub’s form instead',
        onclick: () => {
          if (options.onFallback) options.onFallback();
        },
      });
    }

    /** @returns {HTMLElement} */
    function checkLink() {
      return el('a', {
        class: 'btn-primary btn-sm',
        href: mineUrl,
        target: '_blank',
        rel: 'noopener',
        'data-direct-action': 'check',
        text: 'Check your issues on GitHub',
      });
    }

    /** The sign-in ran out: sign in again, right here, and send once it is back. */
    function expired(options, text) {
      clearToken();
      paint('out');
      report(options.status, text, [
        el('button', {
          type: 'button',
          class: 'btn-primary btn-sm',
          'data-direct-action': 'resignin',
          text: 'Sign in again and submit',
          onclick: () => {
            signIn().then((ok) => {
              if (ok) submit(options);
              else
                report(options.status, note.textContent || 'Sign-in did not finish. Nothing was sent.', [
                  fallbackButton(options),
                ]);
            });
          },
        }),
        fallbackButton(options),
      ]);
    }

    /**
     * Send the answers as an issue, as the signed-in submitter. Every outcome
     * but GitHub's 201 keeps the answers exactly where they are.
     *
     * @param {{button?: HTMLButtonElement, status: HTMLElement|null, title: string, body: string,
     *   onCreated: (issue: {number: number|null, url: string}) => void, onFallback: () => void}} options
     *   `onCreated` runs only after a 201 — it is where the draft may be
     *   deleted; `onFallback` is the link hand-off, offered on every failure.
     */
    function submit(options) {
      if (inFlight) return;
      const saved = readToken();
      if (!saved) {
        expired(
          options,
          'Your GitHub sign-in has expired, so nothing was sent. Sign in again and your answers go straight to GitHub.'
        );
        return;
      }
      if (options.body.length > MAX_BODY) {
        report(
          options.status,
          'Your answers come to ' +
            options.body.length.toLocaleString('en') +
            ' characters, more than the ' +
            MAX_BODY.toLocaleString('en') +
            ' GitHub allows in one issue. Shorten the longest answer and submit again — nothing was sent, and everything is still here.',
          [fallbackButton(options)]
        );
        return;
      }
      if (options.title.length > MAX_TITLE) {
        report(
          options.status,
          'Your title is longer than the ' +
            MAX_TITLE +
            ' characters GitHub allows in an issue title. Shorten it and submit again — nothing was sent.',
          [fallbackButton(options)]
        );
        return;
      }

      inFlight = true;
      const button = options.button || null;
      const label = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = 'Submitting…';
      }
      if (options.status) options.status.hidden = true;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = window.setTimeout(() => {
        if (controller) controller.abort();
      }, TIMEOUT_MS);

      const headers = apiHeaders(saved.token);
      headers['Content-Type'] = 'application/json';
      window
        .fetch(API + '/repos/' + repo + '/issues', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ title: options.title, body: options.body }),
          signal: controller ? controller.signal : undefined,
        })
        .then((response) =>
          response.json().then(
            (data) => ({ response: response, data: data }),
            () => ({ response: response, data: null })
          )
        )
        .then(
          (result) => settle(options, result.response.status, result.data || {}),
          (error) => {
            const timedOut = error && error.name === 'AbortError';
            report(
              options.status,
              (timedOut
                ? 'GitHub did not answer in time, so we cannot tell whether your issue was created.'
                : 'The connection to GitHub failed, so we cannot tell whether your issue was created.') +
                ' Check your issues on GitHub before you submit again. If it is not there, submit again or use GitHub’s form — your answers are all still here.',
              [checkLink(), fallbackButton(options)]
            );
          }
        )
        .then(() => {
          window.clearTimeout(timer);
          inFlight = false;
          if (button) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.textContent = label;
          }
        });
    }

    /**
     * Act on GitHub's answer.
     * @param {object} options from submit()
     * @param {number} status HTTP status
     * @param {object} data the response body, {} when it was not JSON
     */
    function settle(options, status, data) {
      const said =
        typeof data.message === 'string' && data.message
          ? ' GitHub said: “' + data.message.slice(0, 200) + '”.'
          : '';
      if (status === 201) {
        const url =
          typeof data.html_url === 'string' && data.html_url.indexOf('https://github.com/') === 0
            ? data.html_url
            : mineUrl;
        const number = Number.isInteger(data.number) && data.number > 0 ? data.number : null;
        options.onCreated({ number: number, url: url });
        return;
      }
      if (status === 401) {
        expired(
          options,
          'Your GitHub sign-in has expired, so nothing was sent. Sign in again and your answers go straight to GitHub.'
        );
        return;
      }
      if (status === 403 || status === 404) {
        report(
          options.status,
          'GitHub would not let this page create the issue for you — the site’s GitHub App may not be installed on the catalog’s repository, or your account cannot open issues there.' +
            said +
            ' Nothing was sent. Use GitHub’s form instead; your answers are all still here.',
          [fallbackButton(options)]
        );
        return;
      }
      if (status === 410) {
        report(
          options.status,
          'Issues are turned off on the catalog’s repository, so GitHub cannot take the submission. Nothing was sent; let the maintainers know. Your answers are all still here.',
          [fallbackButton(options)]
        );
        return;
      }
      if (status === 422) {
        report(
          options.status,
          'GitHub turned the issue down.' +
            said +
            ' Nothing was sent. Use GitHub’s form instead; your answers are all still here.',
          [fallbackButton(options)]
        );
        return;
      }
      if (status >= 500) {
        // A gateway error can arrive after the issue was made.
        report(
          options.status,
          'GitHub had a problem (HTTP ' +
            status +
            ') and may or may not have created your issue. Check your issues on GitHub before you submit again — your answers are all still here.',
          [checkLink(), fallbackButton(options)]
        );
        return;
      }
      report(
        options.status,
        'GitHub did not create the issue (HTTP ' +
          status +
          ').' +
          said +
          ' Nothing was sent. Use GitHub’s form instead; your answers are all still here.',
        [fallbackButton(options)]
      );
    }

    checkUser();

    return {
      signedIn: () => readToken() !== null,
      login: () => login,
      userId: () => (readToken() !== null ? userId : null),
      token: () => {
        const saved = readToken();
        return saved ? saved.token : null;
      },
      onChange: (listener) => {
        listeners.push(listener);
      },
      // A service that took the token said it is no longer good.
      expire: () => {
        clearToken();
        paint('out');
        sayNote('Your GitHub sign-in has expired. Sign in again to submit from this page.');
      },
      submit: submit,
    };
  };
})((window.SubmitForm = window.SubmitForm || {}));
