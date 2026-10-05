/**
 * Submit form — handing the answers over to GitHub.
 *
 * Three shapes of the same answers:
 *   1. a prefilled issue-form URL (query parameter per field id),
 *   2. the Markdown body GitHub itself would render — `### <Label>` sections,
 *      which is exactly what scripts/new_entry_from_issue.mjs parses back, and
 *   3. YAML front matter, for a maintainer editing the file by hand.
 *
 * GitHub prefills only an issue form's text fields (`input`, `textarea`) by
 * id — never a `dropdown`, `checkboxes` or `upload` — which is why the
 * generated form asks select, multiselect and boolean questions as text
 * inputs. Fields marked data-prefill="false" (an `image` question, an `upload`
 * on GitHub) are left out of the URL and called out to the submitter instead. A field's id, and so its
 * query parameter, is its key, except for a key GitHub reads as its own
 * parameter (`body`, `title`, ...): window.PHCTIssueForm.issueFormId, from
 * assets/js/configurator/issue-form-ids.js, the same helper the generator
 * names the form's elements with.
 *
 * Exposes: window.SubmitForm.issueUrl, .markdownBody, .yamlFrontMatter,
 *          .mailtoUrl, .unprefillable
 */
(function (ns, issueFormId) {
  'use strict';

  /**
   * Answered fields, in form order.
   * @param {object[]} fields
   * @returns {Array<{field: object, text: string}>}
   */
  function answered(fields) {
    return fields
      .map((field) => ({ field: field, text: ns.serialize(field) }))
      .filter((entry) => entry.text !== '');
  }

  /**
   * Fields the submitter will have to re-answer on GitHub.
   * @param {object[]} fields
   * @returns {object[]}
   */
  ns.unprefillable = function unprefillable(fields) {
    return answered(fields)
      .filter((entry) => !entry.field.prefill)
      .map((entry) => entry.field);
  };

  /**
   * The prefilled "new issue" URL.
   * @param {HTMLFormElement} form carries data-repo / data-template / data-title-prefix
   * @param {object[]} fields
   * @param {string} title the entry title, used for the issue title
   * @returns {string}
   */
  ns.issueUrl = function issueUrl(form, fields, title) {
    const repo = form.dataset.repo || '';
    const params = new URLSearchParams();
    params.set('template', form.dataset.template || 'new-entry.yml');
    params.set('title', (form.dataset.titlePrefix || '') + (title || 'New entry'));
    answered(fields).forEach((entry) => {
      if (entry.field.prefill) params.set(issueFormId(entry.field.key), entry.text);
    });
    return 'https://github.com/' + repo + '/issues/new?' + params.toString();
  };

  /**
   * The issue body in the shape GitHub renders and the scaffolder parses.
   * @param {object[]} fields
   * @returns {string}
   */
  ns.markdownBody = function markdownBody(fields) {
    return answered(fields)
      .map((entry) => '### ' + entry.field.label + '\n\n' + entry.text + '\n')
      .join('\n');
  };

  /**
   * @param {string} value
   * @returns {string} a YAML scalar that survives a round trip
   */
  function scalar(value) {
    const text = String(value);
    if (text === '') return '""';
    const risky =
      /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) || //  an indicator in first position
      /:(\s|$)/.test(text) || //                                looks like a mapping key
      / #/.test(text) || //                                      looks like a comment
      /[\n\r\t]/.test(text) || //                                needs escaping
      /\s$/.test(text) || //                                     trailing space is eaten
      /^(true|false|null|yes|no|on|off|~)$/i.test(text) || //     would be retyped to a boolean
      /^\d{4}-\d{1,2}-\d{1,2}([Tt ].*)?$/.test(text); //      would be retyped to a date
    if (risky) {
      return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    return text;
  }

  /**
   * The answers as YAML front matter, for pasting straight into an entry file.
   * @param {object[]} fields
   * @returns {string}
   */
  ns.yamlFrontMatter = function yamlFrontMatter(fields) {
    const lines = ['---'];
    fields.forEach((field) => {
      const value = ns.readValue(field);
      if (Array.isArray(value) && value.length === 0) return;
      if (!Array.isArray(value) && String(value).trim() === '') return;

      if (field.type === 'links') {
        lines.push(field.key + ':');
        value.forEach((link) => {
          lines.push('  - label: ' + scalar(link.label));
          lines.push('    url: ' + scalar(link.url));
        });
        return;
      }
      if (field.type === 'images') {
        lines.push(field.key + ':');
        value.forEach((item) => {
          lines.push('  - src: ' + scalar(item.url));
          lines.push('    alt: ' + scalar(item.alt));
        });
        return;
      }
      if (Array.isArray(value)) {
        lines.push(field.key + ':');
        value.forEach((item) => lines.push('  - ' + scalar(item)));
        return;
      }
      if (field.type === 'boolean') {
        lines.push(field.key + ': true');
        return;
      }
      if (field.type === 'markdown' || String(value).indexOf('\n') !== -1) {
        lines.push(field.key + ': |-');
        String(value)
          .split('\n')
          .forEach((row) => lines.push('  ' + row));
        return;
      }
      lines.push(field.key + ': ' + scalar(value));
    });
    lines.push('---');
    return lines.join('\n') + '\n';
  };

  /**
   * The same answers as an email, for submitters without a GitHub account.
   * @param {string} email
   * @param {string} subject
   * @param {string} body
   * @returns {string}
   */
  ns.mailtoUrl = function mailtoUrl(email, subject, body) {
    return (
      'mailto:' +
      encodeURIComponent(email) +
      '?subject=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(body)
    );
  };
})((window.SubmitForm = window.SubmitForm || {}), window.PHCTIssueForm.issueFormId);
