/**
 * Shared by the "Sign in with GitHub" body tests (test/scripts/direct_issue_body.test.mjs
 * and test/build/variants.test.mjs): fill every question on a booted /submit/
 * page, and write the issue body GitHub's own form produces for given answers.
 *
 * GitHub's form body is one section per question element (`input`,
 * `textarea`, `dropdown`, `checkboxes`, `upload`; never `markdown`), in form
 * order: `### <label>`, a blank line, the answer — `_No response_` when it was
 * left blank — with a blank line between sections.
 */

/**
 * The schema a booted /submit/ page was built from, read back off the page:
 * each question's key, label and type, whether it is required, and a choice
 * question's options, in page order. A test driving the committed snapshot
 * (test/fixtures/submit-form.html) generates its issue form and runs the
 * scaffolder from this, never from the repository's own _data/schema.yml or
 * .github/ISSUE_TEMPLATE/new-entry.yml: a deployment's update runs these tests
 * on its own schema, whose questions and labels are not the snapshot's.
 * @param {HTMLFormElement} form
 * @returns {{entry: object, fields: object[]}}
 */
export function pageSchema(form) {
  const fields = Array.from(form.querySelectorAll('[data-field]'), (wrap) => ({
    key: wrap.dataset.field,
    label: wrap.dataset.label,
    type: wrap.dataset.type,
    required: wrap.dataset.required === 'true',
    ...(wrap.dataset.type === 'select' || wrap.dataset.type === 'multiselect'
      ? {
          options: Array.from(wrap.querySelectorAll('input[value], option'), (node) => node.value).filter(
            Boolean
          ),
        }
      : {}),
  }));
  return { entry: { singular: 'Entry', path: 'catalog' }, fields };
}

/** Issue-form elements that write a section into the issue body. */
const ANSWERED = new Set(['input', 'textarea', 'dropdown', 'checkboxes', 'upload']);

/**
 * @param {{body: object[]}} template a parsed .github/ISSUE_TEMPLATE form
 * @param {(id: string) => string} answerFor the answer GitHub's form holds for an element id
 * @returns {string}
 */
export function githubFormBody(template, answerFor) {
  return template.body
    .filter((element) => ANSWERED.has(element.type))
    .map((element) => `### ${element.attributes.label}\n\n${answerFor(element.id) || '_No response_'}`)
    .join('\n\n');
}

/**
 * Answer every question on the page with something distinct, events and all,
 * the way a person would. `file` questions take no answer on the page, and an
 * `image` question is left blank: it is an upload on GitHub, so its address is
 * not carried by the prefilled link these tests compare against.
 * @param {Window} window
 * @param {HTMLFormElement} form
 * @returns {string} the title typed
 */
export function fillEveryField(window, form) {
  const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true }));
  form.querySelectorAll('[data-field]').forEach((wrap) => {
    const key = wrap.dataset.field;
    const type = wrap.dataset.type;
    if (type === 'file' || type === 'image') return;
    if (type === 'select' || type === 'multiselect') {
      const inputs = Array.from(wrap.querySelectorAll('input[value]:not([data-clear])'));
      if (inputs.length === 0) {
        const select = wrap.querySelector('select');
        select.value = Array.from(select.options).find((option) => option.value !== '').value;
        fire(select, 'change');
        return;
      }
      inputs.slice(0, type === 'multiselect' ? 2 : 1).forEach((input) => {
        input.checked = true;
        fire(input, 'change');
      });
      return;
    }
    if (type === 'boolean') {
      const box = wrap.querySelector('input[type="checkbox"]');
      box.checked = true;
      fire(box, 'change');
      return;
    }
    if (type === 'links') {
      const row = wrap.querySelector('[data-links-rows] > *');
      row.querySelector('[data-links-label]').value = 'Evaluation report';
      row.querySelector('[data-links-url]').value = 'https://example.org/' + key + '.pdf';
      fire(row.querySelector('[data-links-url]'), 'input');
      return;
    }
    const control = wrap.querySelector('input, textarea');
    const value =
      type === 'email'
        ? 'someone@example.org'
        : type === 'url'
          ? 'https://example.org/' + key
          : type === 'images'
            ? 'https://example.org/' + key + '.png | A screenshot'
            : type === 'list'
              ? 'First ' + key + '\nSecond ' + key
              : type === 'date'
                ? '2026-01-02'
                : type === 'number'
                  ? '3'
                  : type === 'markdown'
                    ? 'The story of ' + key + '.\n\n### Not a real heading\n\n- a list\n- of things'
                    : key === 'title'
                      ? 'Water routing'
                      : 'Answer for ' + key;
    control.value = value;
    fire(control, 'input');
  });
  return 'Water routing';
}
