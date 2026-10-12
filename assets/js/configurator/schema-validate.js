/**
 * Schema v2 validation.
 *
 * `_data/schema.yml` is the source of truth for the whole site, so a malformed
 * field definition breaks templates, the issue form and the scaffolder at once.
 * Everything here is a pure function over plain data.
 */

import { isPlainObject } from './yaml-emit.js';
import { ICON_NAMES } from './defaults.generated.js';
import './issue-form-ids.js'; // sets globalThis.PHCTIssueForm (shared with /submit/)

const { issueFormId } = globalThis.PHCTIssueForm;

/** Every `type` a field may declare. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'markdown',
  'url',
  'email',
  'select',
  'multiselect',
  'list',
  'date',
  'number',
  'boolean',
  'file',
  'image',
  'images',
  'links',
];

/**
 * Front matter keys the site manages itself. They exist on every entry, so a
 * field may not redefine them. `title` and `summary` are also always present
 * but ARE authored, so they stay legal field keys.
 */
export const RESERVED_KEYS = ['layout', 'slug', 'published', 'updated', 'verified', 'featured', 'thumbnail'];

/** Legal `card` values beyond `true` / `false`. */
export const CARD_SLOTS = ['badge', 'chip', 'meta', 'icon', 'line', 'fact'];

/** Where a group renders on the entry page: a sidebar card, or a body section. */
export const GROUP_PLACEMENTS = ['main', 'rail'];

/** Which types each explicit card slot can render. */
export const CARD_SLOT_TYPES = {
  badge: ['select'],
  chip: ['list', 'multiselect'],
  icon: ['select', 'multiselect'],
  line: ['text', 'textarea'],
  meta: ['text', 'select', 'date'],
  fact: ['select', 'multiselect', 'list', 'text', 'date'],
};

/** Types that can drive a filter in the catalog panel. */
const FACET_TYPES = ['select', 'multiselect', 'list', 'text'];

/**
 * Legal `option_meta.<option>.tone` values.
 *
 * Mirrors the `.badge-<tone>` classes in `assets/css/components/badges.css`
 * (the set `_includes/badge.html` documents). A tone with no class renders an
 * unstyled span, so this list has to stay in step with the CSS —
 * `test/configurator/schema-validate.test.mjs` greps the stylesheet to check.
 */
export const OPTION_TONES = ['primary', 'secondary', 'accent', 'neutral', 'warn', 'on-dark'];

/** `short` labels wider than this stop fitting a chip or badge. */
const SHORT_MAX = 14;

/** Words of overlap between `prompt` and `description` before it reads as a stutter. */
const OVERLAP_RUN = 4;

const OPTION_TYPES = new Set(['select', 'multiselect']);
const NO_OPTION_TYPES = new Set(['images', 'links', 'file', 'image']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Fields in presentation order: `weight` ascending (default 5), ties broken by
 * the order they appear in the schema. The one ordering rule every consumer —
 * cards, filters, the fact strip, the issue form — shares.
 *
 * @template T
 * @param {T[]} fields
 * @returns {T[]} a new array; the input is not mutated.
 */
export function sortByWeight(fields) {
  return (Array.isArray(fields) ? fields : [])
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const wa = Number.isFinite(a.field?.weight) ? a.field.weight : 5;
      const wb = Number.isFinite(b.field?.weight) ? b.field.weight : 5;
      return wa === wb ? a.index - b.index : wa - wb;
    })
    .map((item) => item.field);
}

/**
 * The stutter check behind the `prompt` / `description` contract in
 * `docs/content-model.md`: forms print the two strings back to back
 * (`issue-template.js` concatenates them, `submit/index.md` stacks them), so a
 * `description` that restates the question reads as a hiccup —
 * "Which organization is sharing this? The organization sharing this entry…".
 *
 * Deterministic on purpose: a shared run of {@link OVERLAP_RUN} words after
 * case/punctuation folding, no fuzzy matching to argue with. It is a warning,
 * not an error, because rephrasing copy must never fail a fork's build.
 *
 * @param {{key?: string, prompt?: unknown, description?: unknown}} field
 * @returns {string|null} the repeated run, or null when there is none.
 */
export function overlapWarning(field) {
  const words = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean);
  const prompt = words(field?.prompt);
  const description = ` ${words(field?.description).join(' ')} `;
  for (let i = 0; i + OVERLAP_RUN <= prompt.length; i += 1) {
    const run = prompt.slice(i, i + OVERLAP_RUN).join(' ');
    if (description.includes(` ${run} `)) return run;
  }
  return null;
}

/* -------------------------------------------------------------------------- */

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(path, message) {
    this.errors.push({ path, message });
  }

  warn(path, message) {
    this.warnings.push({ path, message });
  }
}

function checkEntry(entry, report) {
  if (entry === undefined) return;
  if (!isPlainObject(entry)) {
    report.error('entry', '`entry` must be a mapping (singular, plural, path, sort, sort_order).');
    return;
  }
  for (const key of ['singular', 'plural', 'path']) {
    if (entry[key] !== undefined && !isNonEmptyString(entry[key])) {
      report.error(`entry.${key}`, `\`entry.${key}\` must be a non-empty string.`);
    }
  }
  if (
    entry.path !== undefined &&
    isNonEmptyString(entry.path) &&
    !/^[a-z0-9][a-z0-9-]*$/.test(entry.path.trim())
  ) {
    report.error('entry.path', '`entry.path` must be a lowercase URL segment such as `catalog`.');
  }
  if (entry.sort_order !== undefined && !['asc', 'desc'].includes(String(entry.sort_order).trim())) {
    report.error('entry.sort_order', '`entry.sort_order` must be `asc` or `desc`.');
  }
  if (entry.updated_key !== undefined && !isNonEmptyString(entry.updated_key)) {
    report.error('entry.updated_key', '`entry.updated_key` must be a non-empty string when present.');
  }
}

/** @returns {Set<string>} the declared group keys. */
function checkGroups(groups, report) {
  const keys = new Set();
  if (groups === undefined) return keys;
  if (!Array.isArray(groups)) {
    report.error('groups', '`groups` must be a list of {key, title, description, icon, placement} mappings.');
    return keys;
  }
  groups.forEach((group, index) => {
    const path = `groups[${index}]`;
    if (!isPlainObject(group)) {
      report.error(path, 'Each group must be a mapping with `key` and `title`.');
      return;
    }
    const key = isNonEmptyString(group.key) ? group.key.trim() : '';
    if (!key) report.error(`${path}.key`, 'Missing `key`.');
    else if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      report.error(`${path}.key`, `"${key}" must be lowercase letters, digits and underscores.`);
    } else if (keys.has(key)) {
      report.error(`${path}.key`, `"${key}" is used by more than one group.`);
    } else {
      keys.add(key);
    }
    if (!isNonEmptyString(group.title))
      report.error(`${path}.title`, `Group "${key || index}" needs a \`title\`.`);
    if (group.description !== undefined && !isNonEmptyString(group.description)) {
      report.error(`${path}.description`, `Group "${key || index}" has an empty \`description\`.`);
    }
    if (group.icon !== undefined) checkIcon(group.icon, `${path}.icon`, report);
    if (group.placement !== undefined && !GROUP_PLACEMENTS.includes(String(group.placement).trim())) {
      report.warn(
        `${path}.placement`,
        `"${group.placement}" is not one of: ${GROUP_PLACEMENTS.join(', ')} — the group renders as a body section.`
      );
    }
  });
  return keys;
}

function checkOptionMeta(field, path, options, report) {
  const meta = field.option_meta;
  if (meta === undefined) return;
  if (!isPlainObject(meta)) {
    report.error(`${path}.option_meta`, '`option_meta` must be a mapping keyed by option value.');
    return;
  }
  const allowed = new Set(options);
  for (const [option, value] of Object.entries(meta)) {
    const where = `${path}.option_meta["${option}"]`;
    if (!allowed.has(option)) {
      report.error(where, `"${option}" is not one of this field's \`options\`.`);
      continue;
    }
    if (!isPlainObject(value)) {
      report.error(where, 'Each entry must be a mapping of {short, icon, tone, description}.');
      continue;
    }
    if (value.short !== undefined) {
      if (!isNonEmptyString(value.short))
        report.error(`${where}.short`, '`short` must be a non-empty string.');
      else if (value.short.trim().length > SHORT_MAX) {
        report.warn(
          `${where}.short`,
          `"${value.short}" is ${value.short.trim().length} characters; ${SHORT_MAX} or fewer fits a chip.`
        );
      }
    }
    if (value.tone !== undefined && !OPTION_TONES.includes(String(value.tone).trim())) {
      report.error(`${where}.tone`, `\`tone\` must be one of: ${OPTION_TONES.join(', ')}.`);
    }
    if (value.icon !== undefined) checkIcon(value.icon, `${where}.icon`, report);
    if (value.description !== undefined && !isNonEmptyString(value.description)) {
      report.error(`${where}.description`, '`description` must be a non-empty string.');
    }
  }
}

function checkIcon(icon, path, report) {
  if (!isNonEmptyString(icon)) {
    report.error(path, '`icon` must be a non-empty icon name.');
    return;
  }
  if (ICON_NAMES.length > 0 && !ICON_NAMES.includes(icon.trim())) {
    report.warn(path, `"${icon}" is not in _includes/icon.html; it will render as the fallback info icon.`);
  }
}

function checkPresentation(field, path, type, groupKeys, report) {
  if (field.card !== undefined && field.card !== true && field.card !== false) {
    const slot = String(field.card).trim();
    if (!CARD_SLOTS.includes(slot)) {
      report.error(`${path}.card`, `\`card\` must be true, false, or one of: ${CARD_SLOTS.join(', ')}.`);
    } else if (!CARD_SLOT_TYPES[slot].includes(type)) {
      report.error(
        `${path}.card`,
        `\`card: ${slot}\` does not fit a ${type} field — use it on: ${CARD_SLOT_TYPES[slot].join(', ')}.`
      );
    }
  }

  if (field.weight !== undefined) {
    const weight = field.weight;
    if (!Number.isInteger(weight) || weight < 1 || weight > 9) {
      report.error(`${path}.weight`, '`weight` must be a whole number between 1 and 9.');
    }
  }

  if (field.icon !== undefined) checkIcon(field.icon, `${path}.icon`, report);

  if (field.group !== undefined) {
    if (!isNonEmptyString(field.group)) report.error(`${path}.group`, '`group` must be a group key.');
    else if (groupKeys.size > 0 && !groupKeys.has(field.group.trim())) {
      report.error(`${path}.group`, `"${field.group}" is not declared under \`groups\`.`);
    }
  }

  if (field.prompt !== undefined && !isNonEmptyString(field.prompt)) {
    report.error(`${path}.prompt`, '`prompt` must be a non-empty question when present.');
  }

  const repeated = overlapWarning(field);
  if (repeated) {
    report.warn(
      `${path}.description`,
      `\`description\` repeats "${repeated}" from \`prompt\` — the two print back to back in the ` +
        'issue form, so write a continuation (a constraint, an example, a boundary) instead.'
    );
  }

  if (field.facet !== undefined) {
    if (typeof field.facet !== 'boolean') report.error(`${path}.facet`, '`facet` must be true or false.');
    else if (field.facet && !FACET_TYPES.includes(type)) {
      report.error(
        `${path}.facet`,
        `A ${type} field cannot be a filter — \`facet\` works on: ${FACET_TYPES.join(', ')}.`
      );
    }
  }

  if (field.search !== undefined && typeof field.search !== 'boolean') {
    report.error(`${path}.search`, '`search` must be true or false.');
  }

  if (field.form !== undefined && typeof field.form !== 'boolean') {
    report.error(`${path}.form`, '`form` must be true or false.');
  }

  if (field.thumbnail !== undefined && type !== 'file') {
    report.error(
      `${path}.thumbnail`,
      '`thumbnail` only applies to `file` fields (a thumb is rendered from page 1).'
    );
  }
}

/**
 * Validate a parsed `_data/schema.yml`.
 *
 * @param {object} schema
 * @returns {{ok: boolean, errors: {path: string, message: string}[], warnings: {path: string, message: string}[]}}
 */
export function checkSchema(schema) {
  const report = new Report();

  if (!isPlainObject(schema)) {
    report.error('schema', 'The schema must be a mapping with an `entry`, `groups` and `fields`.');
    return { ok: false, errors: report.errors, warnings: report.warnings };
  }

  checkEntry(schema.entry, report);
  const groupKeys = checkGroups(schema.groups, report);

  const fields = Array.isArray(schema.fields) ? schema.fields : null;
  if (!fields) {
    report.error('fields', '`fields` must be a list of field definitions.');
    return { ok: false, errors: report.errors, warnings: report.warnings };
  }
  if (fields.length === 0) {
    report.error('fields', '`fields` is empty — at least `title` and `summary` are required.');
    return { ok: false, errors: report.errors, warnings: report.warnings };
  }

  const seenKeys = new Map();
  const seenIds = new Map();
  const seenLabels = new Map();
  let markdownCount = 0;
  let lineCount = 0;

  fields.forEach((field, index) => {
    const path = `fields[${index}]`;
    if (!isPlainObject(field)) {
      report.error(path, 'Each field must be a mapping with `key`, `label` and `type`.');
      return;
    }

    const key = typeof field.key === 'string' ? field.key.trim() : '';
    const label = typeof field.label === 'string' ? field.label.trim() : '';

    if (!key) report.error(`${path}.key`, 'Missing `key`.');
    else if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      report.error(
        `${path}.key`,
        `"${key}" must be snake_case: lowercase letters, digits and underscores, starting with a letter.`
      );
    } else if (RESERVED_KEYS.includes(key)) {
      report.error(
        `${path}.key`,
        `"${key}" is managed by the site and is always present — remove it from \`fields\`.`
      );
    } else if (seenKeys.has(key)) {
      report.error(`${path}.key`, `"${key}" is already used by field ${seenKeys.get(key) + 1}.`);
    } else {
      seenKeys.set(key, index);
      // A key GitHub's new-issue page reads as its own parameter (`body`,
      // `title`, ...) gets the element id `entry_<key>` in the issue form
      // (issue-form-ids.js), which a field literally keyed `entry_<key>` would
      // repeat. GitHub rejects a form with a repeated id.
      if (field.form !== false) {
        const id = issueFormId(key);
        if (seenIds.has(id)) {
          report.error(
            `${path}.key`,
            `"${key}" would share the issue-form id "${id}" with field ${seenIds.get(id) + 1}` +
              ` ("${fields[seenIds.get(id)].key}" is renamed to "${id}" there, because GitHub reserves ` +
              `"${fields[seenIds.get(id)].key}" for itself). Choose another key.`
          );
        } else {
          seenIds.set(id, index);
        }
      }
    }

    if (!label) {
      report.error(`${path}.label`, 'Missing `label`.');
    } else {
      const normalized = label.toLowerCase();
      if (seenLabels.has(normalized)) {
        report.error(
          `${path}.label`,
          `"${label}" is already used by field ${seenLabels.get(normalized) + 1} — labels identify answers in the issue form and must be unique.`
        );
      } else {
        seenLabels.set(normalized, index);
      }
    }

    const type = typeof field.type === 'string' ? field.type.trim() : '';
    if (!FIELD_TYPES.includes(type)) {
      report.error(
        `${path}.type`,
        `Unknown type ${JSON.stringify(field.type ?? null)}. Use one of: ${FIELD_TYPES.join(', ')}.`
      );
      return;
    }

    if (type === 'markdown') markdownCount += 1;
    if (field.card === 'line') lineCount += 1;

    let options = [];
    if (OPTION_TYPES.has(type)) {
      options = Array.isArray(field.options)
        ? field.options.filter((o) => isNonEmptyString(o)).map((o) => o.trim())
        : [];
      if (options.length === 0) report.error(`${path}.options`, `A ${type} field needs at least one option.`);
      if (new Set(options).size !== options.length)
        report.error(`${path}.options`, 'Options must be unique.');
    } else if (field.options !== undefined && NO_OPTION_TYPES.has(type)) {
      report.error(`${path}.options`, `A ${type} field has no fixed choices — remove \`options\`.`);
    }

    checkOptionMeta(field, path, options, report);

    if (type === 'file' && !isNonEmptyString(field.filename)) {
      report.error(
        `${path}.filename`,
        'A file field needs a `filename` (e.g. deck.pdf) so contributors know what to upload.'
      );
    }

    checkPresentation(field, path, type, groupKeys, report);
  });

  // With no `title` field the generator adds a Title question of its own,
  // under the id a `title` field would have had.
  const titleId = issueFormId('title');
  if (!seenKeys.has('title') && seenIds.has(titleId)) {
    const index = seenIds.get(titleId);
    report.error(
      `fields[${index}].key`,
      `"${titleId}" is the id of the Title question the issue form adds when the schema has no \`title\` field. Choose another key.`
    );
  }

  if (markdownCount > 1) {
    report.error(
      'fields',
      `Only one field may be \`markdown\` — it becomes the page body; found ${markdownCount}.`
    );
  }
  if (lineCount > 1) {
    report.error(
      'fields',
      `Only one field may use \`card: line\` — the card has room for one; found ${lineCount}.`
    );
  }

  return { ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings };
}

/**
 * Backwards-compatible adapter: the flat list of error strings the CLI and the
 * /setup/ wizard already render.
 *
 * @param {object} schema
 * @returns {string[]} empty when the schema is valid.
 */
export function validateSchema(schema) {
  return checkSchema(schema).errors.map(({ path, message }) => `${path}: ${message}`);
}
