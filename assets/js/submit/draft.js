/**
 * Submit form — draft autosave.
 *
 * The form is long, so answers are saved to localStorage as they're typed and
 * offered back on the next visit. Nothing leaves the browser, and the copy says
 * so: a draft saved here is on one device, in one browser, and a colleague
 * opening the same link sees an empty form.
 *
 * DOM contract: [data-draft-key] on the form (a site slug, so two catalogs on
 * the same origin don't collide), [data-draft-restore] bar with
 * [data-draft-saved] / [data-draft-count] and
 * [data-draft-action=restore|discard|save|clear], [data-draft-status], and
 * [data-draft-unavailable] for the "this browser will not save" case.
 *
 * A stored draft offered by the bar is never overwritten by new typing: the
 * first edit made before the bar is answered moves it to `<key>:previous`, and
 * the bar stays up offering it from there while the new answers save as usual.
 * Nothing is ever moved onto an occupied `:previous`: a visit that finds both
 * keys picks up the newer work in the form and offers the kept one again.
 *
 * Exposes: window.SubmitForm.initDraft
 */
(function (ns) {
  'use strict';

  /**
   * Bump the version segment when the stored shape changes *incompatibly*.
   * The optional `ui` key (stepper position, short-form mode) rode in without
   * a bump on purpose: readers on either side ignore keys they don't know, so
   * a bump would only have thrown away everyone's saved answers.
   */
  const KEY_PREFIX = 'catalog-template:submit-draft:v2';
  const DEBOUNCE_MS = 500;

  /** How often "saved just now" is re-read, so it ages while the page is open. */
  const CLOCK_MS = 30000;

  /**
   * @param {HTMLFormElement} form
   * @returns {string} the localStorage key for this site's draft
   */
  function storageKey(form) {
    return KEY_PREFIX + ':' + (form.dataset.draftKey || 'catalog');
  }

  /**
   * localStorage, or null when the browser refuses it (private mode, quota).
   * @returns {Storage|null}
   */
  function store() {
    try {
      const probe = window.localStorage;
      probe.setItem(KEY_PREFIX + ':probe', '1');
      probe.removeItem(KEY_PREFIX + ':probe');
      return probe;
    } catch (error) {
      return null;
    }
  }

  /**
   * How long ago, in words. Under an hour it counts up in minutes, because that
   * is the span where "is this the thing I was just typing?" is the question.
   * Older than that, a date answers it better than an elapsed time.
   * @param {string} iso an ISO timestamp
   * @returns {string} e.g. "just now", "12 minutes ago", "on 3 June"
   */
  function relative(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60) return minutes + ' minutes ago';
    const date = new Date(then);
    const hours = Math.floor(minutes / 60);
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (hours < 24) return 'at ' + time;
    return 'on ' + date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  }

  /**
   * Wire autosave, the restore bar and the draft buttons.
   *
   * Besides `save`/`clear`, the returned `flush` writes a pending autosave now
   * (for the page being left), and `unsaved` flushes, then reports whether
   * typed answers are still not in storage — the one case worth a warning.
   * @param {HTMLFormElement} form
   * @param {object[]} fields descriptors from readFields
   * @param {(ui: object|null) => void} onRestore called after a draft is
   *   written into the form, with the draft's saved UI state (or null)
   * @param {(() => object|null)|undefined} uiState reads the UI state (stepper
   *   position, short-form mode) to store beside the answers
   * @returns {{save: Function, clear: Function, flush: Function, unsaved: () => boolean}}
   */
  ns.initDraft = function initDraft(form, fields, onRestore, uiState) {
    const key = storageKey(form);
    // Where an offered draft is kept once new typing starts (see the header).
    const previousKey = key + ':previous';
    const memory = store();
    const status = form.querySelector('[data-draft-status]');
    const bar = form.querySelector('[data-draft-restore]');
    const barSaved = form.querySelector('[data-draft-saved]');
    const barCount = form.querySelector('[data-draft-count]');
    const discardButton = form.querySelector('[data-draft-action="discard"]');
    const unavailable = form.querySelector('[data-draft-unavailable]');
    let timer = null;
    let savedAt = '';
    // True between "you have an unfinished draft" appearing and the first
    // edit (or the submitter answering it). Writing then would overwrite the
    // very draft the bar is offering, so the first write sets it aside first.
    let pending = false;
    // The storage key the bar offers to restore from; '' with the bar down.
    let offered = '';
    // What was stored under `offered` when this tab offered it. Another tab
    // can move or replace it meanwhile; Delete removes only this exact draft.
    let offeredRaw = null;
    // True once the draft has been deleted and until the next real edit: the
    // form still shows the answers, and saving them again unasked would undo
    // the delete.
    let held = false;
    // True while there are answers storage does not have yet.
    let dirty = false;
    // True after the kept draft is restored and until its answers are saved
    // under `key`: until then `:previous` is still the only stored copy.
    let dropKept = false;

    /** @returns {object} the current answers, keyed by schema key */
    function snapshot() {
      const data = {};
      fields.forEach((field) => {
        if (ns.isAnswered(field)) data[field.key] = ns.readValue(field);
      });
      return data;
    }

    /**
     * Update the live status only when its text changes, so a screen reader
     * hears "Draft saved" once, not on every autosave while typing.
     * @param {string} text
     */
    function setStatus(text) {
      if (status && status.textContent !== text) status.textContent = text;
    }

    /** Repaint the saved-a-moment-ago line from the stored timestamp. */
    function paintStatus() {
      if (!savedAt) return;
      setStatus('Saved ' + relative(savedAt) + ' — on this device only.');
    }

    /**
     * Copy the offered draft to the `previous` key, so the new answers can be
     * saved over it under `key`. Throws when storage refuses.
     * @returns {string|null} the draft copied, or null when there was none (a
     *   copy must be undone if the new answers then fail to save)
     */
    function setAside() {
      const current = memory.getItem(key);
      if (current === null) return null;
      // Never onto a kept draft: that one would be gone without anyone
      // choosing it. Load picks up both (see the boot code below), so this
      // only guards against storage changed under the page.
      if (memory.getItem(previousKey) !== null) throw new Error('an earlier draft is already kept');
      memory.setItem(previousKey, current);
      return current;
    }

    /**
     * The bar now offers the kept draft while the current answers save as
     * usual: say what Restore and Delete will do from here.
     */
    function showKept() {
      pending = false;
      offered = previousKey;
      if (barCount) barCount.textContent += ' Restoring it replaces what you have typed since.';
      if (discardButton) discardButton.textContent = 'Delete the earlier draft';
    }

    /** Write the current answers to storage and announce it. */
    function write() {
      if (timer) window.clearTimeout(timer);
      timer = null;
      if (held) return;
      const data = snapshot();
      const empty = Object.keys(data).length === 0;
      if (!memory) {
        dirty = !empty;
        return;
      }
      // Nothing typed yet: the offered draft stays exactly where it is.
      if (pending && empty) {
        dirty = false;
        return;
      }
      if (empty) {
        memory.removeItem(key);
        if (dropKept) memory.removeItem(previousKey);
        dropKept = false;
        savedAt = '';
        dirty = false;
        setStatus('');
        return;
      }
      const stamp = new Date().toISOString();
      const payload = { saved: stamp, fields: data };
      const ui = uiState ? uiState() : null;
      if (ui) payload.ui = ui;
      // A failed setItem leaves the key as it was, so the offered draft stays
      // under `key` until the new answers have actually replaced it; the copy
      // under `:previous` is undone if they have not.
      let copied = null;
      try {
        if (pending) copied = setAside();
        memory.setItem(key, JSON.stringify(payload));
      } catch (error) {
        if (copied !== null) {
          try {
            memory.removeItem(previousKey);
          } catch (ignored) {
            // A reload offers both drafts, so a copy left behind loses nothing.
          }
        }
        savedAt = '';
        dirty = true;
        setStatus(
          pending
            ? 'This browser would not keep your earlier draft and save your new answers too. Restore the draft or delete it to keep saving.'
            : 'This browser would not save a draft. Copy your answers before leaving.'
        );
        return;
      }
      if (dropKept) memory.removeItem(previousKey);
      dropKept = false;
      savedAt = stamp;
      dirty = false;
      paintStatus();
      if (pending) {
        if (copied !== null) offeredRaw = copied;
        showKept();
        if (status)
          setStatus(status.textContent + ' Your earlier draft is kept until you restore or delete it.');
      }
    }

    /** Debounced autosave. Inert after a delete, until the next real edit. */
    function save() {
      if (held) return;
      dirty = true;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(write, DEBOUNCE_MS);
    }

    /** Write a pending autosave now, rather than after the debounce. */
    function flush() {
      if (timer) write();
    }

    /** @returns {boolean} true when typed answers could not be saved, even now */
    function unsaved() {
      flush();
      return dirty;
    }

    /** Drop the saved draft, and the kept one, and hold autosave until the next edit. */
    function clear() {
      if (timer) window.clearTimeout(timer);
      timer = null;
      pending = false;
      offered = '';
      held = true;
      dirty = false;
      dropKept = false;
      savedAt = '';
      if (memory) {
        memory.removeItem(key);
        memory.removeItem(previousKey);
      }
      if (status) status.textContent = '';
      if (bar) bar.hidden = true;
    }

    /**
     * @param {string} from storage key
     * @returns {{saved: string, fields: object, ui: object|null}|null} the stored draft, if any
     */
    function read(from) {
      if (!memory) return null;
      try {
        const parsed = JSON.parse(memory.getItem(from) || 'null');
        if (!parsed || !parsed.fields) return null;
        return {
          saved: String(parsed.saved || ''),
          fields: parsed.fields,
          ui: parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : null,
        };
      } catch (error) {
        return null;
      }
    }

    /**
     * Write the stored answers back into the form.
     *
     * A draft can outlive the schema that produced it — a maintainer removes a
     * question, and the answer to it has nowhere to go. Those keys are dropped
     * rather than silently kept, and the submitter is told how many, so a
     * shorter form than they remember has an explanation.
     *
     * The draft replaces the form rather than merging into it: an answer it
     * does not have is put back to the question's starting value, so a draft
     * restored over newer typing comes back as it was saved.
     */
    function restore() {
      const from = offered || key;
      const draft = read(from);
      if (timer) window.clearTimeout(timer);
      timer = null;
      pending = false;
      held = false;
      if (!draft) return;
      const message = fill(draft);
      // Used up: from here on it is the current draft, saved under `key`. The
      // kept copy goes once that save has gone through (see write).
      if (from === previousKey) dropKept = true;
      offered = '';
      if (bar) bar.hidden = true;
      setStatus(message);
      onRestore(draft.ui);
      savedAt = '';
      save();
    }

    /**
     * Put a draft's answers into the form (see restore).
     * @param {{fields: object}} draft
     * @returns {string} what was restored, and what was left behind, in words
     */
    function fill(draft) {
      const known = new Set(fields.map((field) => field.key));
      const stored = Object.keys(draft.fields);
      const dropped = stored.filter((stored_key) => !known.has(stored_key)).length;
      fields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(draft.fields, field.key)) {
          ns.setValue(field, draft.fields[field.key]);
        } else if (ns.isAnswered(field)) {
          ns.setValue(field, field.initial);
        }
      });
      const restored = stored.length - dropped;
      return (
        'Restored ' +
        restored +
        (restored === 1 ? ' answer.' : ' answers.') +
        (dropped > 0
          ? ' ' +
            dropped +
            (dropped === 1 ? ' answer was' : ' answers were') +
            ' saved for questions this form no longer asks, so it was left behind.'
          : '')
      );
    }

    /**
     * Fill the restore bar with what is in storage, and show it.
     * @param {{saved: string, fields: object}} draft
     * @param {string} from the storage key it was read from
     */
    function offerRestore(draft, from) {
      if (!bar) return;
      if (barSaved) {
        const when = relative(draft.saved);
        barSaved.textContent = when ? 'saved ' + when + ' on this device' : 'saved on this device';
      }
      if (barCount) {
        const answered = Object.keys(draft.fields).length;
        barCount.textContent = answered + ' of ' + fields.length + ' answers.';
      }
      bar.hidden = false;
      pending = true;
      offered = from;
      offeredRaw = memory.getItem(from);
    }

    if (!memory) {
      if (unavailable) unavailable.hidden = false;
    } else {
      const existing = read(key);
      const kept = read(previousKey);
      if (existing && kept) {
        // Left last time after typing over a draft: the newer work goes back
        // into the form, where it was, and the kept draft is offered as before.
        // Offering the newer one instead would mean moving it onto the kept
        // one at the first keystroke.
        offerRestore(kept, previousKey);
        showKept();
        setStatus(fill(existing) + ' Your earlier draft is kept until you restore or delete it.');
        // After the caller has finished starting up: the answers are in place
        // for its controllers to read, but the stepper and short-form mode the
        // saved UI state moves do not exist until initDraft has returned.
        Promise.resolve().then(() => onRestore(existing.ui));
      } else if (existing) offerRestore(existing, key);
      else if (kept) offerRestore(kept, previousKey);
    }

    // A real edit after a delete is new work: saving resumes. Registered here,
    // before assets/js/submit.js adds the listeners that call save().
    form.addEventListener('input', () => {
      held = false;
    });
    form.addEventListener('change', () => {
      held = false;
    });

    // The status line ages in place: a form open for half an hour should not
    // still claim the draft was saved "just now".
    if (memory) window.setInterval(paintStatus, CLOCK_MS);

    form.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('[data-draft-action]') : null;
      if (!button) return;
      const action = button.dataset.draftAction;
      if (action === 'restore') restore();
      if (action === 'save') {
        // An explicit save is a request, held or not.
        held = false;
        write();
        if (!memory) {
          setStatus('This browser will not save a draft. Copy your answers before leaving.');
          return;
        }
        if (!savedAt) return;
        setStatus('Saved. Come back to this page in this browser and your answers will be waiting.');
      }
      if (action === 'discard' && offered) {
        // Only the offered draft goes: what is in the form is the current
        // work, whether it is saved already (the draft was kept aside), is
        // waiting on the debounce, or did not fit beside the offered draft.
        const kept = !pending;
        const unchanged = memory.getItem(offered) === offeredRaw;
        if (unchanged) memory.removeItem(offered);
        pending = false;
        offered = '';
        if (bar) bar.hidden = true;
        if (!unchanged) {
          // Moved or replaced by another tab: that draft is not this one to delete.
          if (timer) window.clearTimeout(timer);
          timer = null;
          setStatus(
            'That draft was changed in another tab, so it was not deleted. Reload the page to see the latest version.'
          );
          return;
        }
        // Saved now, or retried: with the offered draft gone there may be room.
        if (dirty) write();
        const deleted = kept ? 'Earlier draft deleted.' : 'Saved draft deleted.';
        if (dirty) {
          setStatus(
            deleted + ' Your latest answers could not be saved on this device. Copy them before leaving.'
          );
        } else if (kept) {
          setStatus(deleted + ' Your new answers are still saved on this device.');
        } else if (savedAt) {
          setStatus(deleted + ' Your new answers are saved on this device.');
        } else {
          setStatus('');
        }
        return;
      }
      // Everything goes, on request ("Submitted it? Delete the saved draft"):
      // the answers left in the form are held, not saved again (see clear).
      if (action === 'clear') {
        clear();
        if (status) status.textContent = 'Saved draft deleted.';
      }
    });

    return { save: save, clear: clear, flush: flush, unsaved: unsaved };
  };
})((window.SubmitForm = window.SubmitForm || {}));
