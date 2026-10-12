/**
 * GitHub's limits on issue forms, and the help-text fitting that keeps a
 * generated form inside them.
 *
 * GitHub drops an invalid form from the issue chooser without telling anyone,
 * and a `?template=new-entry.yml` link then opens a plain blank issue: the
 * submission arrives as unstructured text and the scaffolder cannot read it.
 * The rule that bit a deployment is "Description must be between 3 and 200
 * characters". GitHub reports it for the form's top-level `description`; the
 * same 3 to 200 range is applied to every element's `attributes.description`
 * here too, so no form this template ships depends on GitHub never extending
 * the check to them.
 *
 * Other limits checked, from GitHub's form-schema documentation: a `name` of
 * more than 3 characters (shorter forms are hidden), element ids made of
 * letters, digits, `-` and `_` and unique within the form, a non-empty label on
 * every input, at least one non-markdown element, and at least one option on a
 * dropdown or checkboxes element. The documentation gives no length limit for
 * labels, placeholders, values or option text, so none is invented here.
 *
 * Pure and DOM-free: imported by the issue-form generator (both wizards),
 * scripts/generate.mjs and scripts/validate.mjs.
 */

/** GitHub's range for a form's (and here, every element's) description. */
export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 200;

/** A form `name` must be more than 3 characters or GitHub hides the form. */
export const NAME_MIN = 4;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ELEMENT_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes', 'upload']);

/**
 * Split text into sentences, keeping each one's punctuation. A sentence ends at
 * `.`, `!` or `?` followed by whitespace; text without one is one sentence.
 * @param {string} text
 * @returns {string[]}
 */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Join help fragments, punctuating each, as the generator always has. */
export function joinSentences(parts) {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .map((part) => (/[.!?:)\]…]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

/** Cut at the last word boundary that leaves room for an ellipsis. */
function cutAtWord(text, max) {
  const room = String(text).slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Fit help text into `max` characters without losing any of it.
 *
 * `parts` are the help fragments in the order they read. When all of them do
 * not fit, the part with the lowest `rank` moves out first (the later of two
 * equal ranks first), until what is left fits. A part that cannot fit on its
 * own keeps as many whole leading sentences as fit, and if not even its first
 * sentence does, a word-boundary cut ending in "…". Everything moved out comes
 * back as `overflow`, in reading order, for the caller to show nearby (a
 * markdown element above the control), so nothing is silently dropped.
 *
 * @param {{text: unknown, rank?: number}[]} parts
 * @param {number} [max]
 * @returns {{text: string, overflow: string}}
 */
export function fitHelp(parts, max = DESCRIPTION_MAX) {
  const items = parts
    .map((part, index) => ({ index, rank: Number(part?.rank ?? 0), text: String(part?.text ?? '').trim() }))
    .filter((item) => item.text);
  const kept = new Map(items.map((item) => [item.index, item.text]));
  const moved = new Map();
  const shown = () =>
    joinSentences(items.filter((item) => kept.has(item.index)).map((item) => kept.get(item.index)));

  while (shown().length > max && kept.size > 1) {
    const candidates = items.filter((item) => kept.has(item.index));
    const lowest = Math.min(...candidates.map((item) => item.rank));
    const out = candidates.filter((item) => item.rank === lowest).at(-1);
    moved.set(out.index, kept.get(out.index));
    kept.delete(out.index);
  }

  if (shown().length > max && kept.size === 1) {
    const [index, text] = [...kept][0];
    const all = sentences(text);
    let lead = [];
    for (const sentence of all) {
      if (joinSentences([...lead, sentence]).length > max) break;
      lead.push(sentence);
    }
    if (lead.length > 0) {
      kept.set(index, lead.join(' '));
      moved.set(index, all.slice(lead.length).join(' '));
    } else {
      kept.set(index, cutAtWord(text, max));
      moved.set(index, text);
    }
  }

  const overflow = joinSentences(
    items.filter((item) => moved.has(item.index)).map((item) => moved.get(item.index))
  );
  return { text: shown(), overflow };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = (value) => [...String(value)].length;

/**
 * Everything wrong with one parsed issue form, by GitHub's rules above.
 * @param {unknown} form the parsed YAML of one `.github/ISSUE_TEMPLATE/*.yml`
 * @returns {{path: string, message: string}[]} empty when the form is valid
 */
export function issueFormProblems(form) {
  const problems = [];
  const add = (path, message) => problems.push({ path, message });
  if (!isObject(form)) return [{ path: '(form)', message: 'is not a YAML mapping.' }];

  const name = typeof form.name === 'string' ? form.name.trim() : '';
  if (length(name) < NAME_MIN)
    add('name', `must be more than ${NAME_MIN - 1} characters, or GitHub hides the form.`);

  if (typeof form.description !== 'string') add('description', 'is required.');
  else checkDescription(add, 'description', form.description);

  const body = Array.isArray(form.body) ? form.body : null;
  if (!body || body.length === 0) {
    add('body', 'must list at least one element.');
    return problems;
  }
  const ids = new Set();
  let inputs = 0;
  body.forEach((element, index) => {
    const where = `body[${index}]${isObject(element) && element.id ? ` (${element.id})` : ''}`;
    if (!isObject(element) || !ELEMENT_TYPES.has(element.type)) {
      add(where, `has an unknown type ${JSON.stringify(element?.type)}.`);
      return;
    }
    const attributes = isObject(element.attributes) ? element.attributes : {};
    if (element.type === 'markdown') {
      if (!String(attributes.value ?? '').trim())
        add(`${where}.attributes.value`, 'is required on a markdown element.');
      return;
    }
    inputs += 1;
    if (element.id !== undefined) {
      const id = String(element.id);
      if (!ID_PATTERN.test(id)) add(`${where}.id`, 'may only use letters, digits, "-" and "_".');
      if (ids.has(id)) add(`${where}.id`, `repeats the id "${id}"; ids must be unique.`);
      ids.add(id);
    }
    if (!String(attributes.label ?? '').trim()) add(`${where}.attributes.label`, 'is required.');
    if (attributes.description !== undefined) {
      checkDescription(add, `${where}.attributes.description`, String(attributes.description));
    }
    if (element.type === 'dropdown' || element.type === 'checkboxes') {
      const options = Array.isArray(attributes.options) ? attributes.options : [];
      const text = (option) => String(isObject(option) ? (option.label ?? '') : (option ?? '')).trim();
      if (options.length === 0 || options.some((option) => !text(option))) {
        add(`${where}.attributes.options`, 'needs at least one option, and no option may be blank.');
      }
    }
  });
  if (inputs === 0) add('body', 'needs at least one element that is not markdown.');
  return problems;
}

/** The 3 to 200 character rule, with the actual length in the message. */
function checkDescription(add, path, value) {
  // Trailing whitespace (a YAML block scalar's final newline) is counted
  // toward the maximum, in case GitHub counts it, but cannot make up the minimum.
  const size = length(value);
  if (length(value.trim()) < DESCRIPTION_MIN || size > DESCRIPTION_MAX) {
    add(
      path,
      `is ${size} characters; GitHub needs ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX}, or it drops the whole form.`
    );
  }
}
