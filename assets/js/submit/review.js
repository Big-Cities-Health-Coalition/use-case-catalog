/**
 * Submit form — "check your answers", and the confirmation after the hand-off.
 *
 * The form's last screen is not the form. Pressing the primary button swaps the
 * questions for a read-back of every answer, grouped by section, each with a
 * Change button — the GOV.UK check-your-answers pattern. Only from there do the
 * answers go to GitHub, and only then does the confirmation panel explain that
 * the submission is not finished until `Submit new issue` is pressed there.
 *
 * Nothing here knows a field key: sections come from [data-section], questions
 * from `data-question`, values from `ns.serialize`.
 *
 * DOM contract: [data-review] (the container), [data-form-chrome] (parts of the
 * form hidden while the review is up), [data-review-next] (a <template> holding
 * the long "what happens next" copy, rendered by Liquid), [data-after-submit] (a
 * <template> with the note on following a sent submission, cloned into the
 * confirmation panel; absent when the site has no repository).
 *
 * Exposes: window.SubmitForm.renderReview, .renderConfirmation, .exitReview,
 *          .copyText
 */
(function (ns) {
  'use strict';

  /**
   * Minimal element builder. The configurator has `dom.js` for this, but these
   * scripts are classic `<script defer>` tags and cannot import it.
   * @param {string} tag
   * @param {object} [props] attributes; `text` sets textContent, `onclick` binds
   * @param {Array<Node|string>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((name) => {
      const value = props[name];
      if (value === undefined || value === null || value === false) return;
      if (name === 'text') node.textContent = value;
      else if (name === 'onclick') node.addEventListener('click', value);
      else if (value === true) node.setAttribute(name, '');
      else node.setAttribute(name, String(value));
    });
    (children || []).forEach((child) => node.append(child));
    return node;
  }

  /**
   * Copy text to the clipboard.
   * @param {string} text
   * @returns {Promise<boolean>} whether the copy succeeded
   */
  ns.copyText = function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false
      );
    }
    return Promise.resolve(false);
  };

  /**
   * A button whose label reports the result of the copy for two seconds, with
   * the same result announced politely for anyone not watching the button.
   * @param {string} label
   * @param {() => string} textFor the text to copy, read at click time
   * @returns {HTMLElement}
   */
  function copyButton(label, textFor) {
    const button = el('button', { type: 'button', class: 'btn-secondary btn-sm', text: label });
    const live = el('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    button.addEventListener('click', () => {
      ns.copyText(textFor()).then((ok) => {
        button.textContent = ok ? 'Copied' : 'Press Ctrl/Cmd+C';
        live.textContent = ok
          ? 'Copied to the clipboard.'
          : 'Copying failed. Select the text and copy it by hand.';
        window.setTimeout(() => {
          button.textContent = label;
          live.textContent = '';
        }, 2000);
      });
    });
    return el('span', { class: 'contents' }, [button, live]);
  }

  /** @param {HTMLFormElement} form @returns {HTMLElement|null} */
  function panelHost(form) {
    return form.querySelector('[data-review]');
  }

  /**
   * Show or hide everything that is not the review panel.
   * @param {HTMLFormElement} form
   * @param {boolean} visible
   */
  function setFormVisible(form, visible) {
    form.querySelectorAll('[data-section]').forEach((node) => {
      node.hidden = !visible;
    });
    // The progress rail sits outside the form, so it is found from the document.
    document.querySelectorAll('[data-form-chrome]').forEach((node) => {
      node.hidden = !visible;
    });
  }

  /**
   * Put the questions back and clear the panel.
   * @param {HTMLFormElement} form
   */
  ns.exitReview = function exitReview(form) {
    const host = panelHost(form);
    if (host) {
      host.textContent = '';
      host.hidden = true;
    }
    setFormVisible(form, true);
    // Un-hiding everything is right for the flat form; when the stepper is
    // running, assets/js/submit.js re-applies the one-section-at-a-time view.
    if (typeof ns.afterExitReview === 'function') ns.afterExitReview(form);
  };

  /** The long "what happens next", cloned out of the Liquid-rendered template. */
  function whatHappensNext() {
    const template = document.querySelector('[data-review-next]');
    if (!template || !template.content) return null;
    return el('div', { class: 'border-t border-brand-line px-6 py-5' }, [template.content.cloneNode(true)]);
  }

  /** The note on following the submission once it is sent, when the page has one. */
  function afterSubmit() {
    const template = document.querySelector('[data-after-submit]');
    if (!template || !template.content) return null;
    return el('div', { class: 'border-t border-brand-line px-6 py-4' }, [template.content.cloneNode(true)]);
  }

  /**
   * One answer, read back: the question as it was asked, the answer as it will
   * be sent, and a way back to the control.
   * @param {object} field
   * @param {() => void} change called when the submitter wants to change it
   * @returns {HTMLElement[]} a <dt>/<dd> pair
   */
  function answerRow(field, change) {
    const text = ns.serialize(field);
    const term = el('dt', { class: 'text-sm font-medium text-brand-ink sm:col-span-4' }, [
      document.createTextNode(field.question || field.label),
    ]);
    const value = el('dd', { class: 'text-sm text-brand-muted sm:col-span-6' }, [
      text
        ? el('span', { class: 'whitespace-pre-line text-brand-ink', text: text })
        : el('span', { class: 'italic', text: field.required ? 'Not answered' : 'Not answered (optional)' }),
    ]);
    const action = el('dd', { class: 'text-sm sm:col-span-2 sm:text-right' }, [
      el('button', {
        type: 'button',
        class: 'underline decoration-brand-accent underline-offset-2 hover:no-underline',
        onclick: change,
        text: 'Change',
      }),
      el('span', { class: 'sr-only', text: ' ' + (field.question || field.label) }),
    ]);
    return [term, value, action];
  }

  /**
   * The answers that GitHub's issue form cannot be handed through the URL.
   * Empty today — every control the generator emits is prefillable — but the
   * moment a field goes back to `checkboxes` this is the block that stops the
   * submitter losing the answer without noticing.
   * @param {object[]} fields
   * @returns {HTMLElement|null}
   */
  function unprefillableBlock(fields) {
    const missed = ns.unprefillable(fields);
    if (missed.length === 0) return null;
    return el('section', { class: 'card border-brand-accent' }, [
      el('div', { class: 'card-header bg-brand-accent/10' }, [
        el('p', {
          class: 'card-title',
          text:
            missed.length === 1 ? 'One answer will not travel' : missed.length + ' answers will not travel',
        }),
        el('p', {
          class: 'section-lead mt-1',
          text: 'GitHub cannot pre-fill these, so they arrive blank. Copy each one now and paste it into the matching question on GitHub.',
        }),
      ]),
      el(
        'ul',
        { class: 'divide-y divide-brand-line' },
        missed.map((field) =>
          el('li', { class: 'flex flex-wrap items-start justify-between gap-3 px-6 py-3' }, [
            el('div', { class: 'min-w-0' }, [
              el('p', { class: 'text-sm font-medium text-brand-ink', text: field.question || field.label }),
              el('p', { class: 'whitespace-pre-line text-sm text-brand-muted', text: ns.serialize(field) }),
            ]),
            copyButton('Copy', () => ns.serialize(field)),
          ])
        )
      ),
    ]);
  }

  /**
   * Render "check your answers" in place of the form.
   *
   * @param {HTMLFormElement} form
   * @param {object[]} fields descriptors from readFields
   * @param {{onSend: () => void, onBack: () => void, sendLabel?: string}} handlers
   *   `onSend` hands the answers to GitHub; `onBack` returns to the questions.
   *   `sendLabel` renames the send button — a site with no repository behind it
   *   has nothing to send to, and gets the copy-out route under its own name.
   */
  ns.renderReview = function renderReview(form, fields, handlers) {
    const host = panelHost(form);
    if (!host) return;
    const back = () => {
      ns.exitReview(form);
      if (handlers && handlers.onBack) handlers.onBack();
    };

    const sections = Array.from(form.querySelectorAll('[data-section]'));
    const heading = el('h2', {
      class: 'section-title',
      id: 'review-heading',
      tabindex: '-1',
      text: 'Check your answers',
    });
    const answered = fields.filter((field) => ns.serialize(field)).length;

    const groups = sections.map((section, index) => {
      const key = section.dataset.section;
      const title = section.querySelector('h2');
      const rows = [];
      fields
        .filter((field) => field.section === key)
        .forEach((field) => {
          answerRow(field, () => {
            back();
            // The field may be on another step, or hidden by the short form;
            // revealField (assets/js/submit.js) brings it on screen first.
            (ns.revealField || ns.focusField)(field);
          }).forEach((node) => rows.push(node));
        });
      return el('section', { class: 'card' }, [
        el('div', { class: 'card-header flex items-center gap-3' }, [
          // Echoes the numbered circle on the progress rail, so the read-back
          // visibly maps onto the steps just walked.
          el('span', { class: 'review-step-num', 'aria-hidden': 'true', text: String(index + 1) }),
          el('p', { class: 'card-title', text: title ? title.textContent.trim() : key }),
        ]),
        el(
          'dl',
          {
            class:
              'divide-y divide-brand-line [&>*]:px-6 [&>*]:py-3 sm:grid sm:grid-cols-12 sm:gap-x-4 sm:[&>*]:py-3',
          },
          rows
        ),
      ]);
    });

    const panel = el('div', { class: 'space-y-6' }, [
      el('div', {}, [
        el('p', { class: 'eyebrow', text: 'Last step' }),
        heading,
        el('p', {
          class: 'section-lead mt-1',
          text:
            'Nothing has been sent yet. Read your ' +
            answered +
            (answered === 1 ? ' answer' : ' answers') +
            ' over — this is exactly what GitHub will receive.',
        }),
      ]),
      ...groups,
      ...[unprefillableBlock(fields)].filter(Boolean),
      el('div', { class: 'card' }, [whatHappensNext()].filter(Boolean)),
      el('div', { class: 'flex flex-wrap items-center gap-3' }, [
        el('button', {
          type: 'button',
          class: 'btn-primary',
          text: (handlers && handlers.sendLabel) || 'Send to GitHub',
          onclick: () => {
            if (handlers && handlers.onSend) handlers.onSend();
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn-secondary',
          text: 'Back to the questions',
          onclick: back,
        }),
      ]),
    ]);

    setFormVisible(form, false);
    host.textContent = '';
    host.append(panel);
    host.hidden = false;
    heading.focus();
  };

  /**
   * Render the panel shown once the answers have been handed to GitHub.
   *
   * The submission is not finished at this point and the copy has to say so —
   * the issue is a draft in another tab until `Submit new issue` is pressed.
   * The draft therefore stays in this browser: it is deleted from here, on
   * purpose, rather than the moment the tab opened.
   *
   * @param {HTMLFormElement} form
   * @param {object[]} fields
   * @param {{url: string, email: string, subject: string, body: string, onDelete: () => void}} options
   *   `url` is the prefilled issue link, kept so the tab can be reopened.
   */
  ns.renderConfirmation = function renderConfirmation(form, fields, options) {
    const host = panelHost(form);
    if (!host) return;
    const settings = options || {};
    const actions = [];
    if (settings.url) {
      actions.push(
        el('a', {
          class: 'btn-primary',
          href: settings.url,
          target: '_blank',
          rel: 'noopener',
          text: 'Reopen the GitHub tab',
        })
      );
    }
    actions.push(copyButton('Copy my answers', () => ns.markdownBody(fields)));
    if (settings.email) {
      actions.push(
        el('a', {
          class: 'btn-secondary btn-sm',
          href: ns.mailtoUrl(settings.email, settings.subject || '', ns.markdownBody(fields)),
          text: 'Email it instead',
        })
      );
    }

    const heading = el('h2', {
      class: 'section-title',
      id: 'review-heading',
      tabindex: '-1',
      text: 'Almost there — finish on GitHub',
    });

    // The success moment: a check that draws itself in. Decorative — the
    // heading carries the meaning — and the reduced-motion blanket rule in
    // base.css snaps the stroke straight to its drawn state.
    const svgNs = 'http://www.w3.org/2000/svg';
    const checkSvg = document.createElementNS(svgNs, 'svg');
    checkSvg.setAttribute('viewBox', '0 0 24 24');
    checkSvg.setAttribute('fill', 'none');
    checkSvg.setAttribute('stroke', 'currentColor');
    const checkPath = document.createElementNS(svgNs, 'path');
    checkPath.setAttribute('class', 'confirm-check-path');
    checkPath.setAttribute('stroke-linecap', 'round');
    checkPath.setAttribute('stroke-linejoin', 'round');
    checkPath.setAttribute('d', 'm4.5 12.75 6 6 9-13.5');
    checkSvg.append(checkPath);
    const badge = el('div', { class: 'confirm-check', 'aria-hidden': 'true' }, [checkSvg]);

    const panel = el('div', { class: 'card' }, [
      el('div', { class: 'card-header flex items-start gap-4' }, [
        badge,
        el('div', { class: 'min-w-0' }, [
          heading,
          el('p', {
            class: 'section-lead mt-1',
            text: 'A new tab has opened with your answers filled in. Read them over and press “Submit new issue” there. Until you do, nothing has been submitted.',
          }),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-3 px-6 py-5' }, actions),
      ...[afterSubmit()].filter(Boolean),
      el('div', { class: 'border-t border-brand-line px-6 py-4' }, [
        el('p', {
          class: 'text-sm text-brand-muted',
          text: 'Your answers are still saved in this browser, in case that tab goes missing.',
        }),
        el('button', {
          type: 'button',
          class: 'btn-ghost btn-sm mt-2',
          text: 'Submitted it? Delete the saved draft',
          onclick: () => {
            if (settings.onDelete) settings.onDelete();
          },
        }),
      ]),
    ]);

    setFormVisible(form, false);
    host.textContent = '';
    host.append(panel);
    host.hidden = false;
    heading.focus();
  };
})((window.SubmitForm = window.SubmitForm || {}));
