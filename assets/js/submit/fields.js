/**
 * Submit form — field registry and value reading.
 *
 * Reads the schema-generated DOM (see the comment block at the top of
 * submit/index.md) into plain descriptors, so nothing downstream needs to know
 * how a control is marked up.
 *
 * DOM contract consumed here:
 *   [data-field=<key>]  wrapper, with data-type / data-required / data-label /
 *                       data-slot / data-weight / data-prefill
 *   [data-links-rows]   container of repeatable link rows (type `links`)
 *   [data-clear]        the "Skip this one" radio/checkbox of an optional choice
 *
 * Exposes: window.SubmitForm.readFields, .readValue, .isAnswered, .serialize,
 *          .parseImageLines, .setValue, .scrollBehavior
 */
(function (ns) {
  'use strict';

  /**
   * The `behavior` to pass to a scroll call, honouring the reader's motion
   * setting. The same two lines as `scrollBehavior()` in assets/js/lib/motion.js
   * — these scripts are emitted as classic `<script defer>` tags by
   * _layouts/default.html and cannot import a module. Keep the two in step.
   * @returns {ScrollBehavior}
   */
  ns.scrollBehavior = function scrollBehavior() {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reduced ? 'auto' : 'smooth';
  };

  /**
   * @typedef {object} Field
   * @property {string} key schema key (also the issue-form input id)
   * @property {string} type schema type
   * @property {string} label schema label (the issue-form heading)
   * @property {string} question the visible question, used in error messages
   * @property {string} error schema `error:` override, '' when unset
   * @property {string} placeholder the control's placeholder, quoted in format errors
   * @property {boolean} required
   * @property {string} slot card slot: badge | chip | meta | icon | line | ''
   * @property {number} weight schema weight
   * @property {boolean} prefill false when GitHub cannot prefill the control
   * @property {HTMLElement} wrap the [data-field] wrapper
   * @property {HTMLElement|null} control first focusable control, for errors
   * @property {string} section key of the enclosing [data-section]
   */

  /**
   * Build the field registry from a rendered form.
   * @param {HTMLFormElement} form
   * @returns {Field[]} in document (weight) order
   */
  ns.readFields = function readFields(form) {
    return Array.from(form.querySelectorAll('[data-field]')).map((wrap) => {
      const section = wrap.closest('[data-section]');
      const field = {
        key: wrap.dataset.field,
        type: wrap.dataset.type || 'text',
        label: wrap.dataset.label || wrap.dataset.field,
        question: wrap.dataset.question || wrap.dataset.label || wrap.dataset.field,
        error: wrap.dataset.error || '',
        required: wrap.dataset.required === 'true',
        slot: wrap.dataset.slot || '',
        weight: Number(wrap.dataset.weight || 5),
        prefill: wrap.dataset.prefill !== 'false',
        wrap,
        control: wrap.querySelector('input:not([data-clear]), select, textarea'),
        section: section ? section.dataset.section : '',
      };
      field.placeholder = field.control ? field.control.getAttribute('placeholder') || '' : '';
      field.initial = ns.serialize(field);
      return field;
    });
  };

  /**
   * Parse the `images` textarea: one URL per line, optionally `| alt text`.
   * @param {string} text
   * @returns {Array<{url: string, alt: string}>}
   */
  ns.parseImageLines = function parseImageLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf('|');
        if (split === -1) return { url: line, alt: '' };
        return { url: line.slice(0, split).trim(), alt: line.slice(split + 1).trim() };
      })
      .filter((item) => item.url);
  };

  /**
   * Read the repeatable rows of a `links` field.
   * @param {Field} field
   * @returns {Array<{label: string, url: string}>}
   */
  function readLinkRows(field) {
    return Array.from(field.wrap.querySelectorAll('[data-links-rows] > *'))
      .map((row) => ({
        label: (row.querySelector('[data-links-label]') || {}).value || '',
        url: (row.querySelector('[data-links-url]') || {}).value || '',
      }))
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.url || link.label);
  }

  /**
   * Current value of a field.
   * @param {Field} field
   * @returns {string|string[]|Array<object>} a string, a string list, or a list
   *   of `{label, url}` (links) / `{url, alt}` (images)
   */
  ns.readValue = function readValue(field) {
    if (field.type === 'links') return readLinkRows(field);
    if (field.type === 'images') {
      const box = field.wrap.querySelector('textarea');
      return ns.parseImageLines(box ? box.value : '');
    }
    if (field.type === 'multiselect') {
      return Array.from(field.wrap.querySelectorAll('input[type=checkbox]:checked'))
        .filter((input) => !input.hasAttribute('data-clear'))
        .map((input) => input.value);
    }
    if (field.type === 'boolean') {
      const box = field.wrap.querySelector('input[type=checkbox]');
      return box && box.checked ? 'true' : '';
    }
    if (field.type === 'select') {
      const radio = field.wrap.querySelector('input[type=radio]:checked');
      if (radio) return radio.value;
      const select = field.wrap.querySelector('select');
      return select ? select.value : '';
    }
    const control = field.wrap.querySelector('input, textarea');
    const text = control ? String(control.value || '').trim() : '';
    if (field.type === 'list') {
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
    return text;
  };

  /**
   * Write a value back into a field (used when restoring a draft).
   * @param {Field} field
   * @param {string|string[]|Array<object>} value as produced by readValue
   */
  ns.setValue = function setValue(field, value) {
    if (field.type === 'links') {
      ns.setLinkRows(field, Array.isArray(value) ? value : []);
      return;
    }
    if (field.type === 'images') {
      const box = field.wrap.querySelector('textarea');
      if (box) {
        box.value = (Array.isArray(value) ? value : [])
          .map((item) => (item.alt ? item.url + ' | ' + item.alt : item.url))
          .join('\n');
      }
      return;
    }
    if (field.type === 'multiselect') {
      const chosen = new Set(Array.isArray(value) ? value : []);
      field.wrap.querySelectorAll('input[type=checkbox]').forEach((input) => {
        if (!input.hasAttribute('data-clear')) input.checked = chosen.has(input.value);
      });
      return;
    }
    if (field.type === 'boolean') {
      const box = field.wrap.querySelector('input[type=checkbox]');
      if (box) box.checked = value === 'true' || value === true;
      return;
    }
    if (field.type === 'select') {
      const radios = field.wrap.querySelectorAll('input[type=radio]');
      if (radios.length > 0) {
        radios.forEach((input) => {
          input.checked = input.value === value;
        });
        return;
      }
      const select = field.wrap.querySelector('select');
      if (select) select.value = String(value || '');
      return;
    }
    const control = field.wrap.querySelector('input, textarea');
    if (!control) return;
    control.value = Array.isArray(value) ? value.join('\n') : String(value || '');
  };

  /**
   * @param {Field} field
   * @returns {boolean} true when the submitter has answered the field
   */
  ns.isAnswered = function isAnswered(field) {
    const value = ns.readValue(field);
    const filled = Array.isArray(value) ? value.length > 0 : String(value).trim() !== '';
    if (!filled) return false;
    return ns.serialize(field) !== field.initial;
  };

  /**
   * Render a value the way the GitHub issue form expects to receive it:
   * one option per line for lists, the exact option text for a select,
   * comma-separated options for a multiselect (the issue form asks both as text
   * inputs and says so; scripts/lib/issue_body.mjs matches the text back onto
   * the options, so labels containing commas survive), `Label | URL` for links,
   * `URL | alt` for images, and "Yes" for a ticked boolean (nothing otherwise).
   * @param {Field} field
   * @returns {string} '' when the field is unanswered
   */
  ns.serialize = function serialize(field) {
    const value = ns.readValue(field);
    if (field.type === 'links') {
      return value.map((link) => (link.label ? link.label + ' | ' + link.url : link.url)).join('\n');
    }
    if (field.type === 'images') {
      return value.map((item) => (item.alt ? item.url + ' | ' + item.alt : item.url)).join('\n');
    }
    if (field.type === 'boolean') return value === 'true' ? 'Yes' : '';
    if (field.type === 'multiselect') return value.join(', ');
    if (field.type === 'list') return value.join('\n');
    return String(value);
  };
})((window.SubmitForm = window.SubmitForm || {}));
