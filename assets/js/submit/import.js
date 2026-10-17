/**
 * Submit form — "Import answers": paste the JSON an AI agent prepared and have
 * it fill the form.
 *
 * The JSON follows submit/answers.schema.json (generated from _data/schema.yml
 * by scripts/lib/agent_files.mjs). Nothing here names a field: values are matched
 * to the form by `data-field` key, and each is checked against the controls the
 * page actually rendered — its radios, boxes and options. Filling goes through
 * the form's own `setValue`, and the result through its own `validateAll`, so
 * an imported answer is held to exactly what a typed one is. File inputs and
 * uploads are never touched: files are not part of the JSON.
 *
 * DOM contract (submit/index.md, inside the intro, outside the form):
 *   [data-import]                    the container
 *   [data-import-input]              the <textarea> for the JSON
 *   [data-import-button]             "Import answers"
 *   [data-import-status]             polite live region
 *   [data-import-report]             list of what was not imported
 *   [data-import-confirm]            inline "replace your answers?" block, with
 *                                    [data-import-confirm-text],
 *                                    [data-import-confirm-yes] and
 *                                    [data-import-confirm-no]
 *
 * Exposes: window.SubmitForm.planImport, .initImport
 */
(function (ns) {
  'use strict';

  /** A pasted object larger than this is not an answer set. */
  const MAX_CHARS = 200000;
  /** Alt text longer than this is reported (submit/answers.schema.json says so). */
  const ALT_MAX = 125;

  const isBlank = (value) => value === null || value === undefined || value === '';

  /**
   * The values a choice field offers, from the controls on the page.
   * @param {object} field
   * @returns {string[]}
   */
  function optionsOf(field) {
    const boxes = Array.from(field.wrap.querySelectorAll('input[type=radio], input[type=checkbox]'))
      .filter((input) => !input.hasAttribute('data-clear'))
      .map((input) => input.value);
    if (boxes.length > 0) return boxes;
    return Array.from(field.wrap.querySelectorAll('select option'))
      .map((option) => option.value)
      .filter((value) => value !== '');
  }

  /** @returns {string|null} the option the text means, exactly or ignoring case and spacing */
  function matchOption(options, value) {
    const exact = options.find((option) => option === value);
    if (exact !== undefined) return exact;
    const wanted = String(value).trim().toLowerCase();
    const loose = options.find((option) => option.trim().toLowerCase() === wanted);
    return loose === undefined ? null : loose;
  }

  function hostOf(url) {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch (error) {
      return url;
    }
  }

  /** The question as the submitter read it, in quotes, for messages. */
  function named(field) {
    return '“' + (field.question || field.label) + '”';
  }

  /**
   * Turn one JSON value into what `setValue` takes for this field.
   * @param {object} field
   * @param {unknown} raw
   * @returns {{value?: string|string[]|object[], problem?: string, notes?: string[]}}
   *   `problem` leaves the field as it is; `notes` are kept-but-flagged oddities
   */
  function coerce(field, raw) {
    const notes = [];
    const wrong = (what) => ({ problem: named(field) + ' expects ' + what + '.' });

    switch (field.type) {
      case 'select': {
        if (typeof raw !== 'string') return wrong('one of its options, as text');
        const option = matchOption(optionsOf(field), raw);
        if (option === null) {
          return { problem: named(field) + ': “' + raw + '” is not one of its options.' };
        }
        return { value: option };
      }
      case 'multiselect': {
        const wanted = typeof raw === 'string' ? [raw] : raw;
        if (!Array.isArray(wanted) || wanted.some((item) => typeof item !== 'string')) {
          return wrong('a list of its options');
        }
        const options = optionsOf(field);
        const chosen = [];
        const unknown = [];
        wanted.forEach((item) => {
          const option = matchOption(options, item);
          if (option === null) unknown.push(item);
          else if (!chosen.includes(option)) chosen.push(option);
        });
        if (unknown.length > 0) {
          notes.push(
            named(field) +
              ': left out ' +
              unknown.map((item) => '“' + item + '”').join(', ') +
              ', which ' +
              (unknown.length === 1 ? 'is not one of its options.' : 'are not among its options.')
          );
        }
        return { value: chosen, notes };
      }
      case 'boolean': {
        if (raw === true || raw === false) return { value: raw ? 'true' : '' };
        if (typeof raw === 'string' && /^(true|yes)$/i.test(raw.trim())) return { value: 'true' };
        if (typeof raw === 'string' && /^(false|no)$/i.test(raw.trim())) return { value: '' };
        return wrong('true or false');
      }
      case 'list': {
        const items = typeof raw === 'string' ? raw.split('\n') : raw;
        if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
          return wrong('a list of text items');
        }
        const lines = items
          .flatMap((item) => item.split(/\r?\n/))
          .map((item) => item.trim())
          .filter(Boolean);
        const comma = lines.filter((line) => line.includes(','));
        if (comma.length > 0) {
          notes.push(
            named(field) +
              ': ' +
              comma.map((line) => '“' + line + '”').join(', ') +
              ' contains a comma, so GitHub will read it as more than one item.'
          );
        }
        return { value: lines, notes };
      }
      case 'links': {
        if (!Array.isArray(raw)) return wrong('a list of links');
        const links = [];
        for (const item of raw) {
          const entry = typeof item === 'string' ? { url: item } : item;
          if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
            return wrong('links with a web address');
          }
          const url = entry.url.trim();
          const label = typeof entry.label === 'string' ? entry.label.trim() : '';
          links.push({ label: label || hostOf(url), url });
        }
        return { value: links };
      }
      case 'images': {
        if (!Array.isArray(raw)) return wrong('a list of images');
        const images = [];
        for (const item of raw) {
          const entry = typeof item === 'string' ? { url: item } : item;
          if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
            return wrong('images with a web address');
          }
          const alt = typeof entry.alt === 'string' ? entry.alt.trim() : '';
          if (alt.length > ALT_MAX) {
            notes.push(
              named(field) + ': alt text for ' + entry.url.trim() + ' is over ' + ALT_MAX + ' characters.'
            );
          }
          images.push({ url: entry.url.trim(), alt: alt });
        }
        return { value: images, notes };
      }
      default: {
        // text, textarea, markdown, url, email, date, number, image
        if (typeof raw === 'number' && Number.isFinite(raw)) return { value: String(raw) };
        if (typeof raw !== 'string') return wrong('text');
        return { value: raw };
      }
    }
  }

  /**
   * Read pasted JSON against the form, without changing anything.
   *
   * @param {object[]} fields from readFields
   * @param {string} source what was pasted
   * @returns {{error: string, items: Array<{field: object, value: unknown, overwrites: boolean}>,
   *   unknown: string[], problems: string[], notes: string[]}}
   */
  ns.planImport = function planImport(fields, source) {
    const plan = { error: '', items: [], unknown: [], problems: [], notes: [] };
    const textValue = String(source || '').trim();
    if (!textValue) {
      plan.error = 'Paste the JSON your AI agent gave you first.';
      return plan;
    }
    if (textValue.length > MAX_CHARS) {
      plan.error = 'That is too long to be a set of answers.';
      return plan;
    }
    let data;
    try {
      data = JSON.parse(textValue);
    } catch (error) {
      plan.error =
        'That is not valid JSON (' +
        String(error && error.message ? error.message : error) +
        '). Ask your agent to reply with only the JSON object, then paste it again.';
      return plan;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      plan.error = 'Expected one JSON object with an entry per question, like { "title": "…" }.';
      return plan;
    }

    const byKey = new Map(fields.map((field) => [field.key, field]));
    Object.keys(data).forEach((key) => {
      const field = byKey.get(key);
      if (!field) {
        plan.unknown.push(key);
        return;
      }
      const raw = data[key];
      if (isBlank(raw) || (Array.isArray(raw) && raw.length === 0)) return;
      // Files cannot come from pasted text; the page's picker (or GitHub) takes them.
      if (field.type === 'file') {
        plan.problems.push(
          named(field) +
            ' is a file, so it was skipped. Attach it with the file picker on this page, or drag it into the GitHub issue.'
        );
        return;
      }
      const result = coerce(field, raw);
      if (result.problem) {
        plan.problems.push(result.problem);
        return;
      }
      (result.notes || []).forEach((note) => plan.notes.push(note));
      plan.items.push({ field: field, value: result.value, overwrites: ns.isAnswered(field) });
    });
    return plan;
  };

  /**
   * Wire the Import answers box.
   * @param {{root: Document|HTMLElement, fields: object[], summary: HTMLElement|null,
   *   afterFill?: (problems: object[]) => void}} options
   *   `afterFill` repaints whatever mirrors the answers (preview, progress, draft)
   * @returns {{import: (source: string) => void}|null}
   */
  ns.initImport = function initImport(options) {
    const root = options.root;
    const box = root.querySelector('[data-import]');
    if (!box) return null;
    const input = box.querySelector('[data-import-input]');
    const button = box.querySelector('[data-import-button]');
    const status = box.querySelector('[data-import-status]');
    const report = box.querySelector('[data-import-report]');
    const confirmBox = box.querySelector('[data-import-confirm]');
    const confirmText = box.querySelector('[data-import-confirm-text]');
    const confirmYes = box.querySelector('[data-import-confirm-yes]');
    const confirmNo = box.querySelector('[data-import-confirm-no]');
    if (!input || !button) return null;
    let pending = null;

    function say(message) {
      if (status) status.textContent = message;
    }

    function showReport(lines) {
      if (!report) return;
      report.textContent = '';
      lines.forEach((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        report.appendChild(item);
      });
      report.hidden = lines.length === 0;
    }

    function hideConfirm() {
      pending = null;
      if (confirmBox) confirmBox.hidden = true;
    }

    /** Fill the form from a plan, then hold it to the form's own checks. */
    function apply(plan) {
      hideConfirm();
      plan.items.forEach((item) => {
        ns.setValue(item.field, item.value);
        // The form listens for `input` on a field's wrapper: it repaints the
        // preview, clears a stale error and saves the draft.
        item.field.wrap.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const problems = ns.validateAll(options.fields);
      if (options.summary) {
        if (problems.length > 0) ns.renderSummary(options.summary, problems);
        else ns.hideSummary(options.summary);
      }
      if (options.afterFill) options.afterFill(problems);

      const skipped = [];
      if (plan.unknown.length > 0) {
        skipped.push(
          'Ignored ' +
            plan.unknown.length +
            (plan.unknown.length === 1 ? ' entry that is' : ' entries that are') +
            ' not a question on this form: ' +
            plan.unknown.join(', ') +
            '.'
        );
      }
      const lines = skipped.concat(plan.problems, plan.notes);
      showReport(lines);

      const filled = plan.items.length;
      let message = 'Filled in ' + filled + (filled === 1 ? ' answer.' : ' answers.');
      if (lines.length > 0)
        message +=
          ' ' +
          lines.length +
          (lines.length === 1 ? ' thing was' : ' things were') +
          ' not imported cleanly; see the list below.';
      message +=
        problems.length > 0
          ? ' ' +
            problems.length +
            (problems.length === 1 ? ' answer still needs' : ' answers still need') +
            ' attention; the list is above the form.'
          : ' Every answer passes the form’s checks. Read them over before you submit.';
      say(message);
    }

    function run() {
      hideConfirm();
      showReport([]);
      const plan = ns.planImport(options.fields, input.value);
      if (plan.error) {
        say(plan.error);
        showReport([]);
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      if (plan.items.length === 0) {
        showReport(
          (plan.unknown.length > 0
            ? ['Not a question on this form: ' + plan.unknown.join(', ') + '.']
            : []
          ).concat(plan.problems, plan.notes)
        );
        say('Nothing was imported: none of the entries matched a question on this form.');
        return;
      }
      const replacing = plan.items.filter((item) => item.overwrites);
      if (replacing.length === 0 || !confirmBox) {
        apply(plan);
        return;
      }
      pending = plan;
      if (confirmText) {
        confirmText.textContent =
          'You have already answered ' +
          replacing.map((item) => named(item.field)).join(', ') +
          '. Importing will replace ' +
          (replacing.length === 1 ? 'that answer' : 'those answers') +
          '.';
      }
      confirmBox.hidden = false;
      say(
        'Importing will replace ' +
          replacing.length +
          (replacing.length === 1 ? ' answer' : ' answers') +
          ' you already typed. Choose Replace them or Keep mine.'
      );
      if (confirmYes) confirmYes.focus();
    }

    button.addEventListener('click', run);
    if (confirmYes) {
      confirmYes.addEventListener('click', () => {
        if (pending) apply(pending);
      });
    }
    if (confirmNo) {
      confirmNo.addEventListener('click', () => {
        hideConfirm();
        say('Nothing was changed. Your answers are as you left them.');
        button.focus();
      });
    }
    // Editing the JSON makes a waiting plan out of date.
    input.addEventListener('input', hideConfirm);

    return {
      import: (source) => {
        input.value = source;
        run();
      },
    };
  };
})((window.SubmitForm = window.SubmitForm || {}));
