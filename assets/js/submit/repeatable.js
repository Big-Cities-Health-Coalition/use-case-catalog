/**
 * Submit form — repeatable "Label + URL" rows for `links` fields, and the
 * thumbnail strip under an `images` field.
 *
 * DOM contract:
 *   [data-links-rows]      container the rows live in
 *   [data-links-template]  <template> holding one blank row
 *   [data-links-add]       "Add another link" button
 *   [data-links-remove]    per-row remove button
 *   [data-image-previews]  <ul> the image thumbnails are rendered into
 *
 * Exposes: window.SubmitForm.initRepeatables, .setLinkRows, .renderImagePreviews
 */
(function (ns) {
  'use strict';

  /**
   * Renumber the per-row controls so a screen reader hears "Remove link 2"
   * rather than five buttons all called "Remove". Runs after every add and
   * every removal, because the numbers shift.
   * @param {object} field descriptor from readFields
   */
  function renumber(field) {
    const rows = field.wrap.querySelector('[data-links-rows]');
    if (!rows) return;
    Array.from(rows.children).forEach((row, index) => {
      const remove = row.querySelector('[data-links-remove]');
      if (remove) remove.setAttribute('aria-label', 'Remove link ' + (index + 1));
      const label = row.querySelector('[data-links-label]');
      if (label) label.setAttribute('aria-label', 'Link ' + (index + 1) + ' label');
      const url = row.querySelector('[data-links-url]');
      if (url) url.setAttribute('aria-label', 'Link ' + (index + 1) + ' address');
    });
  }

  /**
   * Append one blank row to a links field.
   * @param {object} field descriptor from readFields
   * @param {{label?: string, url?: string}} [values]
   * @returns {HTMLElement|null} the new row
   */
  function addRow(field, values) {
    const rows = field.wrap.querySelector('[data-links-rows]');
    const template = field.wrap.querySelector('[data-links-template]');
    if (!rows || !template) return null;

    const row = template.content.firstElementChild.cloneNode(true);
    if (values) {
      const label = row.querySelector('[data-links-label]');
      const url = row.querySelector('[data-links-url]');
      if (label) label.value = values.label || '';
      if (url) url.value = values.url || '';
    }
    rows.appendChild(row);
    renumber(field);
    return row;
  }

  /**
   * Replace a links field's rows with the given values (draft restore).
   * Always leaves at least one empty row so the control is never a dead end.
   * @param {object} field
   * @param {Array<{label: string, url: string}>} links
   */
  ns.setLinkRows = function setLinkRows(field, links) {
    const rows = field.wrap.querySelector('[data-links-rows]');
    if (!rows) return;
    rows.textContent = '';
    links.forEach((link) => addRow(field, link));
    if (rows.children.length === 0) addRow(field);
  };

  /**
   * Render the thumbnail strip for an `images` field. Images are loaded
   * without a referrer and hidden if they fail, so a bad paste is quiet.
   * @param {object} field
   */
  ns.renderImagePreviews = function renderImagePreviews(field) {
    const list = field.wrap.querySelector('[data-image-previews]');
    if (!list) return;
    const items = ns.readValue(field);
    // Runs on every keystroke in the textarea; skip the rebuild (and the image
    // re-requests) unless the parsed list actually changed.
    const signature = JSON.stringify(items);
    if (list.dataset.rendered === signature) return;
    list.dataset.rendered = signature;
    list.textContent = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.className = 'image-preview';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = item.alt || '';
      img.src = item.url;
      img.addEventListener('error', () => {
        li.hidden = true;
      });
      li.appendChild(img);
      list.appendChild(li);
    });
    list.hidden = items.length === 0;
  };

  /**
   * Announce a structural change (a row added or removed) the way typing
   * announces itself: a bubbling `input` from the field. The form's own input
   * handlers then treat it as the edit it is — assets/js/submit.js repaints
   * and saves, and assets/js/submit/draft.js resumes autosave after a delete.
   * @param {object} field
   */
  function announce(field) {
    field.wrap.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Wire every repeatable control in the form.
   * @param {object[]} fields descriptors from readFields
   */
  ns.initRepeatables = function initRepeatables(fields) {
    fields
      .filter((field) => field.type === 'links')
      .forEach((field) => {
        const rows = field.wrap.querySelector('[data-links-rows]');
        if (rows && rows.children.length === 0) addRow(field);

        renumber(field);

        const add = field.wrap.querySelector('[data-links-add]');
        if (add) {
          add.addEventListener('click', () => {
            const row = addRow(field);
            // Moving focus into the new row is what announces it: the label the
            // renumber pass just wrote ("Link 3 label") is read on arrival.
            const first = row ? row.querySelector('input') : null;
            if (first) first.focus();
            announce(field);
          });
        }

        field.wrap.addEventListener('click', (event) => {
          const button = event.target.closest ? event.target.closest('[data-links-remove]') : null;
          if (!button) return;
          const row = button.closest('.links-row');
          if (!row) return;
          const container = row.parentElement;
          row.remove();
          if (container && container.children.length === 0) addRow(field);
          renumber(field);
          if (add) add.focus();
          announce(field);
        });
      });

    fields
      .filter((field) => field.type === 'images')
      .forEach((field) => {
        ns.renderImagePreviews(field);
      });
  };
})((window.SubmitForm = window.SubmitForm || {}));
