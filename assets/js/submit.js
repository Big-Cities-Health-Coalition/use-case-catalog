/**
 * Submit form — entry point. Wires the pieces in assets/js/submit/*.js:
 * fields (registry) → validate → repeatable → preview → draft → handoff →
 * review.
 *
 * Loaded last by the `scripts:` list in submit/index.md front matter, so every
 * window.SubmitForm helper it calls is already defined.
 *
 * DOM contract: see the comment block at the top of submit/index.md.
 */
(function (ns) {
  'use strict';

  /**
   * GitHub rejects very long URLs; well below that we switch to copy-paste.
   * Keep this in step with `prefillNoticeIfTooLong` in
   * assets/js/configurator/strings.js, which warns at the same length for the
   * configurator's prefilled "new file" links.
   */
  const MAX_URL = 7000;

  /** Warn the submitter once the prefilled URL is this close to the ceiling. */
  const URL_WARN_AT = Math.round(MAX_URL * 0.85);

  /**
   * Show a message in the status region under the buttons.
   * @param {HTMLElement|null} box
   * @param {string} message
   */
  function say(box, message) {
    if (!box) return;
    box.textContent = message;
    box.hidden = message === '';
  }

  /**
   * Count a hand-off in Plausible, when the site has analytics on
   * (`analytics.plausible_domain`; _includes/head.html then defines
   * window.plausible). Only the event name is sent — never an answer. The
   * call can neither throw nor hold up the hand-off: no Plausible, or one that
   * misbehaves, just means one uncounted event.
   * @param {string} name
   */
  function countEvent(name) {
    try {
      if (typeof window.plausible === 'function') window.plausible(name);
    } catch {
      // Analytics is never worth an error between the submitter and GitHub.
    }
  }

  /** Screen-reader suffix for each section state. */
  const PROGRESS_LABELS = { complete: ' — complete', partial: ' — in progress', empty: ' — not started' };

  /**
   * Section progress: `complete` once every required field in the section has
   * an answer (or, with no required fields, once anything is answered),
   * `partial` when something is answered but a required field is still blank,
   * `empty` otherwise.
   * @param {object[]} fields
   * @param {string} sectionKey
   * @returns {'complete'|'partial'|'empty'}
   */
  function sectionState(fields, sectionKey) {
    const inSection = fields.filter((field) => field.section === sectionKey);
    if (inSection.length === 0) return 'empty';
    const answered = inSection.filter((field) => ns.isAnswered(field));
    if (answered.length === 0) return 'empty';
    const required = inSection.filter((field) => field.required);
    if (required.every((field) => ns.isAnswered(field))) return 'complete';
    return 'partial';
  }

  /**
   * Keep the sticky rail and the mobile counter in step with the answers.
   * @param {HTMLElement} root
   * @param {HTMLFormElement} form
   * @param {object[]} fields
   * @param {boolean} observe track the scrolled-to section with an
   *   IntersectionObserver — right for the flat form, wrong under the stepper,
   *   which paints aria-current and the mobile bar itself
   * @returns {{update: () => void, errors: (problems: object[]) => void,
   *   sectionErrors: (key: string, found: number) => void}}
   */
  function initProgress(root, form, fields, observe) {
    const links = Array.from(root.querySelectorAll('[data-progress-link]'));
    const count = root.querySelector('[data-progress-count]');
    const lineText = form.querySelector('[data-progress-line]');
    const lineSection = form.querySelector('[data-progress-section]');
    const total = links.length;

    const sections = Array.from(form.querySelectorAll('[data-section]'));
    if (observe && typeof IntersectionObserver === 'function' && sections.length > 0) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const key = entry.target.dataset.section;
            links.forEach((link) => {
              link.setAttribute('aria-current', String(link.dataset.progressLink === key));
            });
            // The sticky mobile bar is the only place a small screen shows which
            // section it is in, so it tracks the same observer as the rail.
            const heading = entry.target.querySelector('h2');
            if (lineSection && heading) lineSection.textContent = heading.textContent.trim();
          });
        },
        { rootMargin: '-20% 0px -70% 0px' }
      );
      sections.forEach((section) => observer.observe(section));
    }

    /**
     * Put the number of problems found in each section on its rail link. The
     * rail is the only map of a form this long; after a failed submit it should
     * say where the work is, not just how much of it is done.
     * @param {Array<{field: object, message: string}>} problems
     */
    function paintErrors(problems) {
      links.forEach((link) => {
        const badge = link.querySelector('[data-progress-errors]');
        if (!badge) return;
        const found = problems.filter(
          (problem) => problem.field.section === link.dataset.progressLink
        ).length;
        badge.textContent = found > 0 ? found + ' to fix' : '';
        badge.hidden = found === 0;
      });
    }

    /**
     * Rewrite one section's rail badge — the stepper's per-step counterpart
     * to paintErrors, which repaints every badge from a full-form validate.
     * @param {string} key
     * @param {number} found
     */
    function paintSectionErrors(key, found) {
      const link = links.find((candidate) => candidate.dataset.progressLink === key);
      const badge = link ? link.querySelector('[data-progress-errors]') : null;
      if (!badge) return;
      badge.textContent = found > 0 ? found + ' to fix' : '';
      badge.hidden = found === 0;
    }

    return {
      update: function update() {
        let done = 0;
        links.forEach((link) => {
          const progress = sectionState(fields, link.dataset.progressLink);
          if (progress === 'complete') done += 1;
          link.dataset.done = progress === 'complete' ? 'true' : progress === 'partial' ? 'partial' : 'false';
          const state = link.querySelector('[data-progress-state]');
          if (state) state.textContent = PROGRESS_LABELS[progress];
        });
        const message = done + ' of ' + total + ' sections complete';
        if (count) count.textContent = message;
        if (lineText) lineText.textContent = message;
      },
      errors: paintErrors,
      sectionErrors: paintSectionErrors,
    };
  }

  /**
   * Boot the page.
   * @param {Document|HTMLElement} root
   */
  function init(root) {
    const form = root.querySelector('[data-submit-form]');
    if (!form) return;

    const fields = ns.readFields(form);
    const summary = form.querySelector('[data-error-summary]');
    const status = form.querySelector('[data-submit-status]');
    const fallback = form.querySelector('[data-fallback]');
    const fallbackBody = form.querySelector('[data-fallback-body]');
    const fallbackLink = form.querySelector('[data-fallback-link]');
    const lengthNote = form.querySelector('[data-length-note]');

    // The browser's own required-field messages are the no-JS fallback, so
    // `novalidate` is set here rather than in the markup: with scripts running,
    // this page's messages are the better ones.
    form.setAttribute('novalidate', 'novalidate');

    // More than one section and the stepper takes over: one section at a
    // time, Next/Back, the rail as step navigation. A single-group schema
    // keeps the flat form (initSteps also returns null for it).
    const stepping = typeof ns.initSteps === 'function' && form.querySelectorAll('[data-section]').length > 1;
    let stepper = null;
    let shortform = null;
    // True while revealField is steering the stepper (see onMove below).
    let revealing = false;

    const paintPreview = ns.initPreview(root.documentElement || root, fields);
    const progress = initProgress(root.documentElement || root, form, fields, !stepping);
    const paintProgress = progress.update;
    const titleField = fields.find((field) => field.wrap.dataset.role === 'title');

    /** @returns {string} the entry title, for issue titles and filenames */
    function entryTitle() {
      return titleField ? String(ns.readValue(titleField)) : '';
    }

    let draft = { save: function () {}, clear: function () {}, flush: function () {} };

    /**
     * Warn while there is still time to do something about it: once the
     * prefilled link is near the ceiling, say so instead of waiting for the
     * submitter to press the button and be handed a copy-paste box.
     */
    function paintLength() {
      if (!lengthNote) return;
      const length = ns.issueUrl(form, fields, entryTitle()).length;
      const near = length >= URL_WARN_AT;
      if (near) {
        lengthNote.textContent =
          length > MAX_URL
            ? 'Your answers are now too long to carry in a link. Pressing the button below will hand you your answers to paste into the GitHub form instead.'
            : 'Your answers are getting long. A little more and they will not fit in a link — you will be handed them to paste into the GitHub form instead.';
      }
      lengthNote.hidden = !near;
    }

    /** Repaint everything that mirrors the answers. */
    function refresh() {
      paintPreview();
      paintProgress();
      paintLength();
      draft.save();
    }

    draft = ns.initDraft(
      form,
      fields,
      function afterRestore(ui) {
        fields.filter((field) => field.type === 'images').forEach(ns.renderImagePreviews);
        // Visibility before position: the short-form recompute decides which
        // sections still have anything to show before the stepper lands on one.
        if (shortform) {
          if (ui && typeof ui.short === 'boolean') shortform.set(ui.short);
          else shortform.refresh();
        }
        if (stepper && ui && ui.step) stepper.show(ui.step, true);
        paintPreview();
        paintProgress();
        paintLength();
      },
      function uiState() {
        if (!stepper && !shortform) return null;
        const ui = {};
        if (stepper) ui.step = stepper.current();
        if (shortform) ui.short = shortform.enabled();
        return ui;
      }
    );

    shortform = ns.initShortForm
      ? ns.initShortForm(form, fields, {
          onChange: function () {
            if (stepper) stepper.apply(false);
            draft.save();
          },
        })
      : null;

    stepper = stepping
      ? ns.initSteps(form, fields, {
          isSectionAvailable: function (key) {
            return !shortform || shortform.sectionVisible(key);
          },
          validateSection: function (key) {
            return ns.validateSection(fields, key);
          },
          onProblems: function (key, problems) {
            progress.sectionErrors(key, problems.length);
            ns.renderSummary(summary, problems);
          },
          onClean: function (key) {
            progress.sectionErrors(key, 0);
          },
          onMove: function () {
            // A move made to fix a listed problem keeps the list up — the
            // other links still have work to do (see revealField below).
            if (!revealing) ns.hideSummary(summary);
            draft.save();
          },
        })
      : null;

    /**
     * Bring a field on screen — its optional question un-hidden, its step the
     * current one — then focus it. The error summary and the review's Change
     * buttons both land here; on the flat form it is just focusField.
     * @param {object} field
     */
    ns.revealField = function revealField(field) {
      if (shortform) shortform.reveal(field);
      // Moving to the field's step must not dismiss the error summary the
      // link came from — the last step's full check can list problems across
      // several steps, and following the first link must keep the rest.
      if (stepper && field.section && stepper.current() !== field.section) {
        revealing = true;
        stepper.show(field.section, false);
        revealing = false;
      }
      ns.focusField(field);
    };

    // Leaving the review un-hides the whole form; put the current step back.
    ns.afterExitReview = function afterExitReview() {
      if (stepper) stepper.apply(true);
    };

    ns.initRepeatables(fields, refresh);

    form.addEventListener('input', (event) => {
      const wrap = event.target.closest ? event.target.closest('[data-field]') : null;
      const field = wrap ? fields.find((candidate) => candidate.wrap === wrap) : null;
      if (field && field.type === 'images') ns.renderImagePreviews(field);
      if (field && !ns.checkField(field)) ns.clearError(field);
      refresh();
    });
    form.addEventListener('change', refresh);

    form.addEventListener(
      'blur',
      (event) => {
        const wrap = event.target.closest ? event.target.closest('[data-field]') : null;
        if (!wrap) return;
        const field = fields.find((candidate) => candidate.wrap === wrap);
        if (!field) return;
        const message = ns.checkField(field);
        if (message) ns.showError(field, message);
        else ns.clearError(field);
      },
      true
    );

    /**
     * Hand the answers to GitHub, from the review panel.
     *
     * The draft is deliberately *not* cleared here. Opening a tab is not
     * submitting: the issue is still a draft until "Submit new issue" is
     * pressed on GitHub, and a submitter who loses that tab needs their answers
     * to still be here. The confirmation panel offers to delete it instead.
     */
    function send() {
      // No repository, no issue to open — `https://github.com//issues/new` is a
      // dead link, so the copy-out route is the whole of it. The markup already
      // says so; this is the button honouring it.
      if (!form.dataset.repo) {
        ns.exitReview(form);
        showFallback(
          'This site has no catalog repository behind it, so there is no issue to open. Your answers are in the box below — copy them wherever they need to go.',
          ''
        );
        return;
      }

      const url = ns.issueUrl(form, fields, entryTitle());
      if (url.length > MAX_URL) {
        ns.exitReview(form);
        // Too long for a prefilled link, but the empty issue form still opens
        // fine — it applies the automation's label itself, and its questions
        // carry the same headings as the copy-out box. A blank issue would
        // not: the chooser has blank issues off, and submitters cannot label.
        showFallback(
          'Your answers are too long to carry across in a link. Open the issue form with the link below, then copy each answer from the box into the question with the same heading.',
          'https://github.com/' +
            form.dataset.repo +
            '/issues/new?template=' +
            (form.dataset.template || 'new-entry.yml')
        );
        return;
      }

      // Not `window.open(url, '_blank', 'noopener')`: with `noopener` in the
      // features string the call returns null even when the tab opened, which
      // made every successful submit look blocked. Sever the opener afterwards.
      const opened = window.open(url, '_blank');
      if (opened) opened.opener = null;
      if (!opened) {
        ns.exitReview(form);
        showFallback(
          'Your browser blocked the new tab. Use the link below to open the prefilled issue — your answers travel with it.',
          url
        );
        return;
      }
      // Counted only once the tab is open: a blocked pop-up or a too-long
      // link has not reached GitHub, and validation never gets this far.
      countEvent('Send to GitHub');
      say(status, '');
      ns.renderConfirmation(form, fields, {
        url: url,
        email: form.dataset.fallbackEmail || '',
        subject: (form.dataset.titlePrefix || '') + (entryTitle() || 'New entry'),
        onDelete: function () {
          draft.clear();
          ns.exitReview(form);
          say(status, 'Saved draft deleted. Thanks for sending it in.');
          refresh();
        },
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      // Implicit submission (Enter in a text input) before the last step is a
      // request to move on, not to review six sections' worth of answers.
      if (stepper && !stepper.isLast()) {
        stepper.next();
        return;
      }
      const problems = ns.validateAll(fields);
      progress.errors(problems);
      if (problems.length > 0) {
        ns.renderSummary(summary, problems);
        say(status, '');
        return;
      }
      ns.hideSummary(summary);
      say(status, '');
      ns.renderReview(form, fields, {
        onSend: send,
        onBack: refresh,
        sendLabel: form.dataset.repo ? '' : 'Copy your answers',
      });
    });

    /**
     * Reveal the copy-paste route, optionally with a direct link to the
     * prefilled issue (present when a popup was blocked, absent when the URL
     * was too long to exist).
     * @param {string} message
     * @param {string} url
     */
    function showFallback(message, url) {
      // The copy-out box lives in the closing block, which the stepper shows
      // on the last step only — stand there before pointing at it.
      if (stepper) stepper.showLast();
      if (fallbackBody) fallbackBody.value = ns.markdownBody(fields);
      if (fallbackLink) {
        if (url) fallbackLink.href = url;
        fallbackLink.hidden = !url;
      }
      if (fallback) fallback.hidden = false;
      say(status, message);
      if (fallbackBody) fallbackBody.focus();
    }

    form.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('[data-action]') : null;
      if (!button) return;
      const action = button.dataset.action;

      if (action === 'email') {
        const email = form.dataset.fallbackEmail || '';
        if (!email) {
          say(status, 'No email address is configured for this catalog. Use the GitHub button instead.');
          return;
        }
        const subject = (form.dataset.titlePrefix || '') + (entryTitle() || 'New entry');
        window.location.href = ns.mailtoUrl(email, subject, ns.markdownBody(fields));
        return;
      }

      const text =
        action === 'copy-yaml'
          ? ns.yamlFrontMatter(fields)
          : action === 'copy-markdown'
            ? ns.markdownBody(fields)
            : action === 'copy-fallback' && fallbackBody
              ? fallbackBody.value
              : null;
      if (text === null) return;
      if (!text.trim()) {
        say(status, 'There is nothing to copy yet.');
        return;
      }
      ns.copyText(text).then((ok) => {
        say(
          status,
          ok ? 'Copied to your clipboard.' : 'Copying failed — select the text and copy it by hand.'
        );
      });
    });

    // Copying, emailing and saving a draft all need scripting, so the markup
    // ships them hidden rather than leaving dead buttons on a page without JS.
    // On a flat form the Back/Next bars would be dead buttons with scripting
    // too — drop them before the reveal reaches them.
    if (!stepper) {
      form.querySelectorAll('[data-step-nav]').forEach((node) => node.remove());
    }
    root.querySelectorAll('[data-js-only]').forEach((node) => {
      node.hidden = false;
    });
    // After the reveal, so the first paint of Back/Next wins over it.
    if (stepper) stepper.apply(false);

    // The preview is a scripting feature: reveal it only now, and start it
    // collapsed on narrow screens so it doesn't push the form down.
    const panel = root.querySelector('[data-preview-panel]');
    if (panel) {
      panel.hidden = false;
      panel.open = !window.matchMedia || window.matchMedia('(min-width: 1024px)').matches;
    }

    fields.filter((field) => field.type === 'images').forEach(ns.renderImagePreviews);
    paintPreview();
    paintProgress();
    paintLength();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(document));
  } else {
    init(document);
  }

  ns.init = init;
})((window.SubmitForm = window.SubmitForm || {}));
