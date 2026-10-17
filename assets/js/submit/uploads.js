/**
 * Submit form — file uploads. Optional.
 *
 * A signed-in submitter (assets/js/submit/direct.js) can attach screenshots and
 * a PDF deck right on this page instead of dragging them into the GitHub issue
 * afterwards. Each `images` question and each `file` question gets a native
 * file picker; a picked file is checked, (for a picture) re-encoded in the
 * browser, and sent to the upload service (services/uploads/) at once, one at
 * a time, with progress, a Remove button and a retry. The service answers with
 * an `upload:<set>/<sha256>.<ext>` reference, which is all the issue carries:
 * assets/js/submit/handoff.js writes it into the body, and the scaffolder
 * resolves it (scripts/lib/upload_refs.mjs is the shared contract).
 *
 * Only loaded when `submit.uploads_url` and `submit.signin_url` are both set
 * (submit/index.md renders `data-uploads-url` and this script together, after
 * uploads-core.js and uploads-view.js). This file holds the state and talks
 * to the service; uploads-view.js draws it. Without sign-in there are no
 * pickers at all: the page is what it was. assets/js/submit.js calls
 * initUploads once direct.js is wired.
 *
 * The record kept in the draft (draft.js, key `uploads`) names files and the
 * person who uploaded them, never the sign-in token or the file contents:
 *   {set, user: {id, login}, files: {<field key>: [{ref, name, alt, bytes, kind}]}}
 * A draft restored by the same account shows the files again; by another
 * account, drops them (they would not resolve); signed out, keeps them hidden.
 *
 * Tests can replace the three outside-world pieces before boot through
 * `window.SubmitForm.uploadHooks`: `reencode(file) -> {blob, type}`,
 * `send(request) -> {status, retryAfter, data}` and `sleep(ms)`.
 *
 * Exposes: window.SubmitForm.initUploads, .uploadLines, .uploadSummary
 */
(function (ns) {
  'use strict';

  const core = ns.uploadsCore;
  const view = ns.uploadsView;
  /** A picture bigger than this is not even decoded. */
  const MAX_ORIGINAL = 25 * 1024 * 1024;

  /**
   * Wire the pickers into the page.
   * @param {{form: HTMLFormElement, fields: object[], direct: object, draft?: object,
   *   onChange?: () => void}} options `direct` is what initDirect returned
   * @returns {null|{restore: (record: object|null) => void, reset: () => void,
   *   hasFiles: (field: object) => boolean, count: () => number, held: () => number}}
   *   null when the page has nothing to upload to or with
   */
  ns.initUploads = function initUploads(options) {
    if (!core || !view || typeof ns.el !== 'function') return null;
    const form = options.form;
    const fields = options.fields;
    const direct = options.direct;
    const origin = typeof ns.serviceOrigin === 'function' ? ns.serviceOrigin(form.dataset.uploadsUrl) : '';
    const targets = fields.filter((field) => field.type === 'images' || field.type === 'file');
    if (!origin || !direct || targets.length === 0) return null;
    try {
      core.newSetId();
    } catch (error) {
      return null; // no secure random source: no uploads rather than guessable ones
    }

    const hooks = ns.uploadHooks || {};
    const reencode = hooks.reencode || core.browserReencode;
    const send = hooks.send || core.xhrSend;
    const sleep = hooks.sleep || ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    const keys = targets.map((field) => field.key);

    /** The set id of this draft's uploads, picked at the first upload. */
    let set = '';
    /** {id, login} of the account that uploaded the files held here. */
    let owner = null;
    let counter = 0;
    let pumping = false;
    /** @type {Record<string, object[]>} items per field key, in display order */
    const lists = {};
    const parts = {};
    keys.forEach((key) => {
      lists[key] = [];
    });

    const live = view.buildLive(form);
    /** What the rows and pickers hand back (assets/js/submit/uploads-view.js). */
    const handlers = { onRetry: retry, onRemove: removeItem, onPick: addFiles };

    // --- small helpers --------------------------------------------------------

    /** @param {string} text */
    function announce(text) {
      view.announce(live, text);
    }

    /** @returns {'out'|'checking'|'ready'} */
    function mode() {
      if (!direct.signedIn()) return 'out';
      return direct.userId() === null ? 'checking' : 'ready';
    }

    /** @returns {object[]} every item, in field order */
    function everyItem() {
      return keys.reduce((all, key) => all.concat(lists[key]), []);
    }

    /** @param {string} key @returns {object[]} items that are uploaded */
    function uploaded(key) {
      return lists[key].filter((item) => item.status === 'done');
    }

    /** @param {string} text @returns {string} one line, as the body carries it */
    function oneLine(text) {
      return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /** @param {object} field @returns {string} the question in quotation marks */
    function named(field) {
      return '“' + (field.question || field.label || '') + '”';
    }

    /** @returns {string} where a deck link can be pasted instead, from the schema */
    function linkQuestion() {
      const links = fields.find((field) => field.type === 'links');
      return links ? named(links) : 'the form’s links question';
    }

    /**
     * Show or clear a note under a field's picker.
     * @param {object} field
     * @param {string[]} lines
     */
    function say(field, lines) {
      const box = parts[field.key].message;
      box.textContent = lines.join(' ');
      box.hidden = lines.length === 0;
    }

    /** Something the draft or the field's error depends on changed. */
    function changed(field) {
      if (field && !ns.checkField(field)) ns.clearError(field);
      if (options.onChange) options.onChange();
    }

    /** @returns {Record<string, string>|null} null when signed out */
    function authHeaders() {
      const token = direct.token();
      return token ? { Authorization: 'Bearer ' + token } : null;
    }

    /**
     * What the service said, or a plain sentence when it said nothing usable.
     * @param {{status: number, data: object|null}} result
     * @param {string} fallback
     */
    function serviceMessage(result, fallback) {
      const said = result.data && typeof result.data.message === 'string' ? result.data.message : '';
      return said ? said.slice(0, 300) : fallback + ' (HTTP ' + result.status + ').';
    }

    // --- the model ------------------------------------------------------------

    /**
     * @param {object} field
     * @param {{name: string, kind: string, file?: File, ref?: string, alt?: string, bytes?: number}} init
     */
    function makeItem(field, init) {
      counter += 1;
      return {
        id: counter,
        key: field.key,
        kind: init.kind,
        name: init.name,
        file: init.file || null,
        blob: null,
        status: init.ref ? 'done' : 'queued',
        progress: 0,
        note: '',
        message: '',
        ref: init.ref || '',
        alt: init.alt || '',
        bytes: init.bytes || 0,
        removing: false,
        announcedHalf: false,
        row: null,
      };
    }

    /** Take every uploaded file out of the lists (not the server: that is cleanup's job). */
    function dropUploaded() {
      keys.forEach((key) => {
        lists[key] = lists[key].filter((item) => {
          if (item.status !== 'done') return true;
          if (item.row) item.row.remove();
          return false;
        });
      });
    }

    /** @returns {object|null} the record draft.js stores beside the answers */
    function record() {
      if (!set || !owner) return null;
      const files = {};
      let any = false;
      keys.forEach((key) => {
        files[key] = uploaded(key).map((item) => ({
          ref: item.ref,
          name: item.name,
          alt: item.alt,
          bytes: item.bytes,
          kind: item.kind,
        }));
        if (files[key].length > 0) any = true;
      });
      return any ? { set: set, user: { id: owner.id, login: owner.login }, files: files } : null;
    }

    /**
     * @param {object} field
     * @returns {string[]} the `upload:` lines the issue body carries for it
     */
    function lines(field) {
      if (!lists[field.key] || mode() !== 'ready') return [];
      const items = uploaded(field.key);
      if (field.type === 'file') return items.slice(0, 1).map((item) => item.ref);
      return items.map((item) => (oneLine(item.alt) ? item.ref + ' | ' + oneLine(item.alt) : item.ref));
    }

    /**
     * @param {object} field
     * @returns {string[]} what the review reads back: file name and description
     */
    function summary(field) {
      if (!lists[field.key] || mode() !== 'ready') return [];
      return uploaded(field.key).map((item) =>
        oneLine(item.alt) ? item.name + ' — ' + oneLine(item.alt) : item.name
      );
    }

    /**
     * The reason a field cannot be submitted yet, or ''. Folded into
     * ns.checkField below, so the existing blur, step and submit paths all
     * honour it.
     * @param {object} field
     * @returns {string}
     */
    function problem(field) {
      const items = lists[field.key];
      if (!items || items.length === 0) return '';
      const current = mode();
      if (current === 'out') return '';
      if (current === 'checking')
        return (
          'Still checking your GitHub sign-in, which the files in ' +
          named(field) +
          ' depend on. Try again in a moment.'
        );
      if (items.some((item) => ['queued', 'encoding', 'uploading'].indexOf(item.status) !== -1))
        return 'A file in ' + named(field) + ' is still uploading. Wait for it to finish, then continue.';
      if (items.some((item) => item.status === 'error'))
        return 'A file in ' + named(field) + ' did not upload. Try it again or remove it, then continue.';
      if (items.some((item) => item.kind === 'image' && oneLine(item.alt) === ''))
        return (
          'Describe every screenshot in ' +
          named(field) +
          ': each one needs a short description for people who cannot see it.'
        );
      return '';
    }

    // --- the page (drawn by assets/js/submit/uploads-view.js) ----------------

    /** @param {object} item repaint its row */
    function updateRow(item) {
      view.updateRow(item);
    }

    /** @param {object} field repaint its box from the sign-in state and its items */
    function renderField(field) {
      view.renderField(
        field,
        parts[field.key],
        lists[field.key],
        { mode: mode(), uploaded: uploaded(field.key).length, linkQuestion: linkQuestion() },
        handlers
      );
    }

    function renderAll() {
      targets.forEach(renderField);
    }

    /**
     * The sign-in changed (or a draft came back): drop files that belong to
     * someone else, then repaint.
     */
    function reconcile() {
      if (mode() === 'ready') {
        const id = direct.userId();
        const has = everyItem().some((item) => item.status === 'done');
        if (owner && owner.id !== id) {
          if (has) {
            const was = owner.login ? '@' + owner.login : 'another GitHub account';
            const now = direct.login() ? '@' + direct.login() : 'a different account';
            const touched = targets.filter((field) => uploaded(field.key).length > 0);
            dropUploaded();
            const text =
              'The files in this draft were uploaded by ' +
              was +
              ', and you are signed in as ' +
              now +
              ', so they were removed from the draft. Add them again.';
            owner = null;
            set = '';
            renderAll();
            touched.forEach((field) => say(field, [text]));
            announce(text);
            if (options.onChange) options.onChange();
            return;
          }
          owner = null;
          set = '';
        } else if (owner && direct.login()) {
          owner.login = direct.login();
        }
      }
      renderAll();
    }

    // --- picking and uploading ---------------------------------------------

    /**
     * @param {object} field
     * @param {File[]} picked
     */
    function addFiles(field, picked) {
      const wanted = field.type === 'images' ? 'image' : 'pdf';
      const notes = [];
      let added = 0;
      picked.forEach((file) => {
        const label = '“' + file.name + '”';
        if (core.kindOf(file) !== wanted) {
          notes.push(
            label +
              (wanted === 'image'
                ? ' is not a PNG, JPEG or WebP picture, so it was not added.'
                : ' is not a PDF, so it was not added.')
          );
          return;
        }
        if (file.size === 0) {
          notes.push(label + ' is empty, so it was not added.');
          return;
        }
        if (wanted === 'pdf' && file.size > core.MAX_BYTES) {
          notes.push(
            label +
              ' is ' +
              core.sizeText(file.size) +
              ', over the 4 MB limit, so it was not uploaded. In your PDF program, export it again as PDF, minimum size, and pick the new file — or leave this blank and paste a link to the deck in ' +
              linkQuestion() +
              '.'
          );
          return;
        }
        if (wanted === 'image' && file.size > MAX_ORIGINAL) {
          notes.push(
            label + ' is ' + core.sizeText(file.size) + ', too large to prepare. Pick a smaller screenshot.'
          );
          return;
        }
        if (wanted === 'image' && lists[field.key].length >= core.MAX_IMAGES) {
          notes.push('Up to ' + core.MAX_IMAGES + ' screenshots fit; ' + label + ' was not added.');
          return;
        }
        if (wanted === 'pdf' && lists[field.key].length > 0) {
          notes.push('Remove the file already here before adding ' + label + '.');
          return;
        }
        if (everyItem().length >= core.MAX_FILES) {
          notes.push(
            'At most ' + core.MAX_FILES + ' files fit in one submission; ' + label + ' was not added.'
          );
          return;
        }
        lists[field.key].push(makeItem(field, { name: file.name, kind: wanted, file: file }));
        added += 1;
      });
      say(field, notes);
      renderField(field);
      if (notes.length > 0) announce(notes.join(' '));
      if (added > 0) {
        announce(added === 1 ? 'File added. Uploading…' : added + ' files added. Uploading…');
        pump();
      }
      changed(field);
    }

    /** Upload queued items one after another. */
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        for (;;) {
          const item = everyItem().find((candidate) => candidate.status === 'queued');
          if (!item) break;
          await upload(item);
        }
      } finally {
        pumping = false;
      }
    }

    /** @param {object} item a failed file, queued again */
    function retry(item) {
      item.status = 'queued';
      item.message = '';
      updateRow(item);
      announce('Trying ' + item.name + ' again.');
      pump();
    }

    /** @param {object} item @param {string} message */
    function fail(item, message) {
      item.status = 'error';
      item.message = message;
      item.note = '';
      updateRow(item);
      announce(item.name + ' did not upload: ' + message);
    }

    /** @param {object} item prepare and send one file */
    async function upload(item) {
      const field = targets.find((candidate) => candidate.key === item.key);
      try {
        if (!item.blob) {
          if (item.kind === 'image') {
            item.status = 'encoding';
            updateRow(item);
            announce('Preparing ' + item.name + '.');
            item.blob = (await reencode(item.file)).blob;
          } else {
            item.blob = item.file;
          }
        }
        const total = everyItem().reduce(
          (sum, other) => sum + (other.status === 'done' ? other.bytes : 0),
          0
        );
        if (total + item.blob.size > core.MAX_TOTAL_BYTES) {
          fail(
            item,
            'adding it would take your files past ' +
              core.sizeText(core.MAX_TOTAL_BYTES) +
              ' in total. Remove one first.'
          );
          return;
        }
        item.status = 'uploading';
        item.progress = 0;
        updateRow(item);
        announce('Uploading ' + item.name + '.');
        if (!set) set = core.newSetId();

        for (let attempt = 0; ; attempt += 1) {
          const headers = authHeaders();
          if (!headers) {
            fail(item, 'your GitHub sign-in ended. Sign in again, then try it again.');
            return;
          }
          let result;
          try {
            result = await send({
              method: 'POST',
              url: origin + '/api/upload',
              headers: {
                Authorization: headers.Authorization,
                'Content-Type': 'application/octet-stream',
                'X-Upload-Set': set,
                'X-Upload-Kind': item.kind,
                'X-Upload-Name': core.headerName(item.name),
              },
              body: item.blob,
              onProgress: (fraction) => {
                item.progress = fraction;
                updateRow(item);
                if (fraction >= 0.5 && !item.announcedHalf) {
                  item.announcedHalf = true;
                  announce(item.name + ' is halfway uploaded.');
                }
              },
            });
          } catch (error) {
            fail(item, 'could not reach the upload service. Check your connection, then try again.');
            return;
          }
          if (result.status === 201) {
            const data = result.data || {};
            const match = typeof data.ref === 'string' ? core.REF_RE.exec(data.ref) : null;
            if (!match || match[1] !== set) {
              fail(item, 'the upload service answered in a way this page does not understand.');
              return;
            }
            item.ref = data.ref;
            item.bytes = Number.isFinite(data.bytes) ? data.bytes : item.blob.size;
            item.status = 'done';
            item.progress = 1;
            item.note = '';
            item.file = null;
            item.blob = null;
            if (!owner) owner = { id: direct.userId(), login: direct.login() };
            updateRow(item);
            announce(item.name + ' uploaded.');
            changed(field);
            return;
          }
          if (result.status === 401) {
            direct.expire();
            fail(item, 'your GitHub sign-in has expired. Sign in again, then try it again.');
            return;
          }
          // Only `rate_limited` (GitHub busy) is worth waiting for; the per-user caps
          // (`too_many_drafts`, `too_many_files`) will not change, so their message is shown.
          if (
            result.status === 429 &&
            result.data &&
            result.data.error === 'rate_limited' &&
            attempt < core.MAX_RETRIES
          ) {
            const wait = core.retryDelay(result.retryAfter);
            item.note =
              'The upload service is busy. Trying again in ' +
              Math.max(1, Math.round(wait / 1000)) +
              ' seconds.';
            item.progress = 0;
            updateRow(item);
            announce(item.note);
            await sleep(wait);
            item.note = '';
            continue;
          }
          fail(item, serviceMessage(result, 'the upload service refused it'));
          return;
        }
      } catch (error) {
        fail(
          item,
          error && error.code === 'toolarge'
            ? 'even at lower quality this picture is over 4 MB. Crop it or pick a smaller screenshot.'
            : error && error.code === 'decode'
              ? 'this file could not be read as a picture.'
              : 'something went wrong preparing it. Try again, or pick a different file.'
        );
      } finally {
        changed(field);
      }
    }

    /**
     * Remove a file: from the service first when it was uploaded, then here.
     * @param {object} field
     * @param {object} item
     */
    async function removeItem(field, item) {
      if (item.removing) return;
      if (item.status === 'done' && item.ref) {
        const headers = authHeaders();
        if (!headers) {
          say(field, ['Sign in with GitHub again to remove ' + item.name + '.']);
          return;
        }
        item.removing = true;
        updateRow(item);
        announce('Removing ' + item.name + '.');
        let result;
        try {
          result = await send({
            method: 'DELETE',
            url: origin + '/api/upload?ref=' + encodeURIComponent(item.ref),
            headers: headers,
          });
        } catch (error) {
          result = null;
        }
        item.removing = false;
        updateRow(item);
        if (result && result.status === 401) {
          direct.expire();
          return;
        }
        if (!result || [200, 204, 404].indexOf(result.status) === -1) {
          const text = result
            ? item.name + ' could not be removed. ' + serviceMessage(result, 'The upload service refused')
            : item.name + ' could not be removed: the upload service could not be reached. Try again.';
          say(field, [text]);
          announce(text);
          return;
        }
      }
      // Found again only now: another Remove, a restore or a sign-in change
      // may have reshaped the list while the DELETE was out.
      const at = lists[field.key].indexOf(item);
      if (at !== -1) lists[field.key].splice(at, 1);
      if (item.row) item.row.remove();
      say(field, []);
      renderField(field);
      announce('Removed ' + item.name + '.');
      view.focusAfterRemoval(parts[field.key], lists[field.key], at);
      changed(field);
    }

    // --- the interface other scripts use ---------------------------------------

    // checkField is called as ns.checkField everywhere (blur, the stepper, the
    // final check), so wrapping it puts the upload rules on every one of them.
    const checkField = ns.checkField;
    if (typeof checkField === 'function') {
      ns.checkField = function checkFieldWithUploads(field) {
        const blocked = problem(field);
        if (blocked) return blocked;
        // A required question with only uploaded files is answered.
        if (field.required && !ns.isAnswered(field) && lines(field).length > 0) return '';
        return checkField(field);
      };
    }
    ns.uploadLines = lines;
    ns.uploadSummary = summary;

    if (options.draft && typeof options.draft.trackUploads === 'function') options.draft.trackUploads(record);
    targets.forEach((field) => {
      parts[field.key] = view.buildBox(field);
    });
    direct.onChange(reconcile);
    reconcile();

    return {
      /** A restored draft's record: it replaces what is held, as a draft replaces the answers. */
      restore: function restore(stored) {
        dropUploaded();
        owner = null;
        const read = core.readRecord(stored, keys);
        if (read) {
          set = read.set;
          owner = read.user;
          targets.forEach((field) => {
            const cap = field.type === 'images' ? core.MAX_IMAGES : 1;
            const kind = field.type === 'images' ? 'image' : 'pdf';
            read.files[field.key]
              .filter((entry) => entry.kind === kind)
              .slice(0, cap)
              .forEach((entry) => {
                lists[field.key].push(makeItem(field, entry));
              });
          });
        } else if (everyItem().length === 0) {
          set = '';
        }
        reconcile();
      },
      /** The submission went through: forget the files. */
      reset: function reset() {
        dropUploaded();
        owner = null;
        set = '';
        renderAll();
      },
      hasFiles: function hasFiles(field) {
        return lines(field).length > 0;
      },
      count: function count() {
        return mode() === 'ready' ? everyItem().filter((item) => item.status === 'done').length : 0;
      },
      /**
       * Uploaded files still in the draft whatever the sign-in state: after
       * the sign-in expires, count() is 0 but these are still stored, and
       * only a fresh sign-in as their owner can send them.
       */
      held: function held() {
        return owner ? everyItem().filter((item) => item.status === 'done').length : 0;
      },
    };
  };
})((window.SubmitForm = window.SubmitForm || {}));
