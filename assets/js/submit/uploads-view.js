/**
 * Submit form — file uploads, the page side. Optional.
 *
 * The markup assets/js/submit/uploads.js paints its state into: the picker
 * and notes under each `images` and `file` question, one row per file (name,
 * status, progress, description, Try again and Remove), and the live region
 * that reads progress out. It holds no state of its own: every function takes
 * the item objects uploads.js keeps, and hands the submitter's actions back
 * through the `{onRetry, onRemove, onPick}` callbacks it is given. The one
 * exception is a row's description box, which writes `item.alt` as it is
 * typed, so the item is always what the issue body reads.
 *
 * Loaded with uploads.js, after uploads-core.js and before uploads.js
 * (submit/index.md). `ns.el` (review.js) is read only when something is built,
 * so it may load later.
 *
 * Exposes: window.SubmitForm.uploadsView
 */
(function (ns) {
  'use strict';

  const core = ns.uploadsCore;

  /**
   * @typedef {object} Handlers
   * @property {(item: object) => void} onRetry Try again was pressed
   * @property {(field: object, item: object) => void} onRemove Remove was pressed
   * @property {(field: object, files: File[]) => void} onPick files were picked
   */

  /**
   * The polite live region every upload message is read out through.
   * @param {HTMLFormElement} form
   * @returns {HTMLElement}
   */
  function buildLive(form) {
    const live = ns.el('p', {
      class: 'sr-only',
      role: 'status',
      'aria-live': 'polite',
      'data-uploads-live': true,
    });
    form.append(live);
    return live;
  }

  /** @param {HTMLElement} live @param {string} text */
  function announce(live, text) {
    live.textContent = text;
  }

  /**
   * One row of the list: name, status, progress, description, buttons.
   * @param {object} field
   * @param {object} item
   * @param {Handlers} handlers
   */
  function buildRow(field, item, handlers) {
    const el = ns.el;
    const base = (field.wrap.id || 'f-' + field.key) + '-file-' + item.id;
    const name = el('p', { class: 'text-sm font-medium text-brand-ink break-words' });
    const status = el('p', { class: 'text-sm text-brand-muted' });
    const bar = el('progress', {
      class: 'mt-1 block h-2 w-full',
      max: '100',
      value: '0',
      'aria-label': 'Upload progress for ' + item.name,
      hidden: true,
    });
    const row = el('li', {
      class: 'rounded-lg border border-brand-line bg-surface-card p-3',
      'data-upload-item': true,
    });
    row.append(name, status, bar);

    let altInput = null;
    if (item.kind === 'image') {
      altInput = el('input', {
        type: 'text',
        class: 'field-input mt-1',
        id: base + '-alt',
        maxlength: String(core.MAX_ALT),
        autocomplete: 'off',
        'aria-required': 'true',
        'aria-describedby': base + '-alt-help',
        'data-upload-alt': true,
      });
      altInput.value = item.alt;
      altInput.addEventListener('input', () => {
        item.alt = altInput.value;
      });
      row.append(
        el('label', {
          class: 'field-label mt-3',
          for: base + '-alt',
          text: 'Description of ' + item.name + ' (required)',
        }),
        el('span', {
          class: 'field-help block',
          id: base + '-alt-help',
          text:
            'What the picture shows, for people who cannot see it: one sentence, up to ' +
            core.MAX_ALT +
            ' characters.',
        }),
        altInput
      );
    }

    const retry = el('button', {
      type: 'button',
      class: 'btn-secondary btn-sm',
      'data-upload-action': 'retry',
      'aria-label': 'Try again: ' + item.name,
      text: 'Try again',
      onclick: () => {
        handlers.onRetry(item);
      },
    });
    const remove = el('button', {
      type: 'button',
      class: 'btn-secondary btn-sm',
      'data-upload-action': 'remove',
      'aria-label': 'Remove ' + item.name,
      text: 'Remove',
      onclick: () => {
        handlers.onRemove(field, item);
      },
    });
    row.append(el('div', { class: 'mt-3 flex flex-wrap items-center gap-3' }, [retry, remove]));
    item.row = row;
    item.dom = { name: name, status: status, bar: bar, retry: retry, remove: remove };
  }

  /** @param {object} item repaint its row from its state */
  function updateRow(item) {
    if (!item.row) return;
    const dom = item.dom;
    dom.name.textContent =
      item.name +
      (item.bytes || (item.blob && item.blob.size)
        ? ' (' + core.sizeText(item.bytes || item.blob.size) + ')'
        : '');
    const percent = Math.round(item.progress * 100);
    const text = item.removing
      ? 'Removing…'
      : item.status === 'queued'
        ? 'Waiting to upload.'
        : item.status === 'encoding'
          ? 'Preparing the picture…'
          : item.status === 'uploading'
            ? (item.note ? item.note + ' ' : 'Uploading… ') + percent + '%'
            : item.status === 'done'
              ? 'Uploaded.'
              : 'Not uploaded: ' + item.message;
    dom.status.textContent = text;
    dom.bar.hidden = item.status !== 'uploading';
    dom.bar.value = percent;
    dom.retry.hidden = item.status !== 'error';
    dom.remove.hidden = item.status === 'encoding' || item.status === 'uploading' || item.removing;
  }

  /**
   * The picker and its notes, built when the submitter is signed in and torn
   * down when not, so a signed-out page holds no file input at all.
   * @param {object} field
   * @param {string} base id prefix
   * @param {string} linkQuestion where a deck link can be pasted instead
   * @param {Handlers} handlers
   */
  function buildPicker(field, base, linkQuestion, handlers) {
    const el = ns.el;
    const isImage = field.type === 'images';
    const input = el('input', {
      type: 'file',
      class: 'field-input',
      id: base,
      accept: isImage ? core.IMAGE_TYPES.join(',') : 'application/pdf',
      multiple: isImage,
      'aria-describedby': base + '-help ' + base + '-note',
      'data-upload-picker': true,
    });
    input.addEventListener('change', () => {
      // Copied first: clearing the input empties the live FileList, and
      // clearing it lets the same file be picked again.
      const picked = Array.from(input.files || []);
      input.value = '';
      handlers.onPick(field, picked);
    });
    const help = isImage
      ? 'PNG, JPEG or WebP, up to ' +
        core.MAX_IMAGES +
        ' pictures. Each is shrunk to fit and stripped of hidden details such as location before it is sent. Already online? Paste addresses in the box below instead, one per line; they are added after the pictures you upload.'
      : 'A PDF up to 4 MB — in your PDF program, choose export as PDF, minimum size. Over 4 MB, or kept in a shared workspace? Leave this blank and paste a link in ' +
        linkQuestion +
        '. A file you upload is used instead of any link.';
    const picker = el('div', { class: 'space-y-1', 'data-upload-picker-block': true }, [
      el('label', {
        class: 'field-label',
        for: base,
        text: isImage ? 'Add screenshots from your computer' : 'Upload the file from your computer',
      }),
      el('span', { class: 'field-help block', id: base + '-help', text: help }),
      el('span', {
        class: 'field-help block',
        id: base + '-note',
        text: 'A reviewer checks every file. Screenshots become public on a draft as soon as you send them, so do not show personal information.',
      }),
      input,
    ]);
    return { picker: picker, input: input };
  }

  /**
   * Build the always-present parts of a field's box.
   * @param {object} field
   * @returns {object} the parts renderField repaints
   */
  function buildBox(field) {
    const el = ns.el;
    const base = (field.wrap.id || 'f-' + field.key) + '-upload';
    const message = el('p', {
      class: 'field-help mt-2 font-medium text-brand-ink',
      'data-upload-message': true,
      hidden: true,
    });
    const list = el('ul', { class: 'mt-3 space-y-3', 'data-upload-list': true });
    const slot = el('div', {});
    const outNote = el('p', {
      class: 'field-note',
      'data-upload-signed-out': true,
      hidden: true,
      text: 'Files you uploaded are saved in this draft. Sign in with GitHub again to see them and send them with your answers.',
    });
    const box = el('div', { class: 'mt-3', 'data-uploads': field.key, hidden: true }, [slot, message, list]);
    const notes = Array.from(field.wrap.querySelectorAll('.field-note'));
    const before =
      field.type === 'images'
        ? field.wrap.querySelector('textarea')
        : field.wrap.querySelector('.field-error');
    field.wrap.insertBefore(outNote, before);
    field.wrap.insertBefore(box, before);
    return {
      base: base,
      box: box,
      slot: slot,
      list: list,
      message: message,
      outNote: outNote,
      notes: notes,
      picker: null,
    };
  }

  /**
   * Repaint a field's box from the sign-in state and its items.
   * @param {object} field
   * @param {object} part from buildBox
   * @param {object[]} items the field's items, in display order
   * @param {{mode: 'out'|'checking'|'ready', uploaded: number, linkQuestion: string}} state
   *   `uploaded` counts the field's items that are done
   * @param {Handlers} handlers
   */
  function renderField(field, part, items, state, handlers) {
    const ready = state.mode === 'ready';
    part.box.hidden = !ready;
    part.outNote.hidden = !(state.mode === 'out' && state.uploaded > 0);
    // The page's own "drag it into the GitHub issue" note is wrong while
    // files can be sent from here.
    part.notes.forEach((note) => {
      note.hidden = ready;
    });
    const wantPicker = ready && (field.type === 'images' || items.length === 0);
    if (wantPicker && !part.picker) {
      part.picker = buildPicker(field, part.base, state.linkQuestion, handlers);
      part.slot.append(part.picker.picker);
    } else if (!wantPicker && part.picker) {
      part.picker.picker.remove();
      part.picker = null;
    }
    Array.from(part.list.children).forEach((row) => {
      if (!items.some((item) => item.row === row)) row.remove();
    });
    items.forEach((item, index) => {
      if (!item.row) buildRow(field, item, handlers);
      updateRow(item);
      if (part.list.children[index] !== item.row)
        part.list.insertBefore(item.row, part.list.children[index] || null);
    });
  }

  /**
   * Move focus on after a row went: to the next row's Remove, else the
   * picker, else any button left in the box.
   * @param {object} part from buildBox
   * @param {object[]} items the field's items, the removed one gone
   * @param {number} index where the removed row was, -1 when unknown
   */
  function focusAfterRemoval(part, items, index) {
    const next = items[Math.min(index, items.length - 1)];
    const target =
      (next && next.dom && !next.dom.remove.hidden ? next.dom.remove : null) ||
      (part.picker ? part.picker.input : null) ||
      part.box.querySelector('button:not([hidden])');
    if (target && typeof target.focus === 'function') target.focus();
  }

  ns.uploadsView = {
    buildLive: buildLive,
    announce: announce,
    buildRow: buildRow,
    updateRow: updateRow,
    buildPicker: buildPicker,
    buildBox: buildBox,
    renderField: renderField,
    focusAfterRemoval: focusAfterRemoval,
  };
})((window.SubmitForm = window.SubmitForm || {}));
