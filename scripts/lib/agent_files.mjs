/**
 * The two files /submit/ offers to people who prepare an entry with an AI agent:
 *
 *   submit/answers.schema.json     a JSON Schema (draft 2020-12) for the answers
 *   submit/agent-instructions.txt  plain-text instructions to hand to the agent
 *
 * Both are built from `_data/schema.yml` (the questions, their options and
 * which are required) and `_data/site.yml` (the catalog's name and review
 * note), so they cannot drift from the form. `npm run generate` writes them;
 * the submitter pastes the agent's JSON into "Import answers" on /submit/
 * (assets/js/submit/import.js).
 *
 * The pure builders (`answersSchema`, `agentInstructions`) know nothing about
 * Jekyll. The `*File` renderers wrap them in front matter and put the site's
 * address in with Liquid (`absolute_url`), because `url` and `baseurl` are only
 * known at build time.
 */

import { groupedFormFields } from '../../assets/js/configurator/issue-template.js';

export const SCHEMA_PATH = '/submit/answers.schema.json';
export const INSTRUCTIONS_PATH = '/submit/agent-instructions.txt';
export const SUBMIT_PATH = '/submit/';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** The longest alt text a screenshot may carry. */
export const ALT_MAX = 125;

const FALLBACK_REVIEW_NOTE =
  'Do not include personal or protected health information, credentials, or non-public data.';

const text = (value) => String(value ?? '').trim();

/** `Over 25 MB.` + `x` -> `Over 25 MB. x`, never doubling a full stop. */
function sentences(parts) {
  return parts
    .map(text)
    .filter(Boolean)
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(' ');
}

/**
 * Every question the form asks, in the order it asks them. A schema without a
 * `title` field gets the same synthetic Title question the issue form adds.
 *
 * @param {object} schema
 * @returns {object[]}
 */
export function answerFields(schema) {
  const fields = groupedFormFields(schema).flatMap((section) => section.fields);
  const usable = fields.filter((field) => text(field.key) && text(field.type));
  if (!usable.some((field) => field.key === 'title')) {
    const singular = text(schema?.entry?.singular).toLowerCase() || 'entry';
    usable.unshift({
      key: 'title',
      label: 'Title',
      type: 'text',
      required: true,
      description: `A short, specific name for this ${singular}.`,
    });
  }
  return usable;
}

/** @returns {string[]} a field's options as strings, blanks dropped */
function optionsOf(field) {
  return (Array.isArray(field.options) ? field.options : []).map(String).filter((option) => option.trim());
}

const FILE_NOTE =
  'Files are not part of this JSON: the submitter attaches them on the submit page (or drags them into the GitHub issue).';

/** What a field's answer is for, as the schema's `description` of that property. */
function describe(field) {
  const parts = [field.prompt, field.description];
  switch (field.type) {
    case 'list':
      parts.push('Each item is one line of its own. Never put a comma inside an item.');
      break;
    case 'images':
      parts.push(
        `Only images already hosted at a public https address; each needs alt text of at most ${ALT_MAX} characters saying what the screenshot shows. ${FILE_NOTE}`
      );
      break;
    case 'file':
    case 'image':
      parts.push(`Only a public https link. ${FILE_NOTE}`);
      break;
    case 'links':
      parts.push('Each link is a short label and a web address.');
      break;
    case 'date':
      parts.push('Format YYYY-MM-DD.');
      break;
    default:
  }
  return sentences(parts);
}

const URL_ITEM = { type: 'string', format: 'uri', pattern: '^https?://\\S+$' };

/** The JSON Schema fragment for one field. */
function propertyFor(field) {
  const base = { title: text(field.label) || field.key };
  const description = describe(field);
  if (description) base.description = description;
  const required = field.required === true;
  const minLength = required ? { minLength: 1 } : {};

  switch (field.type) {
    case 'select':
      return { ...base, type: 'string', enum: optionsOf(field) };
    case 'multiselect':
      return {
        ...base,
        type: 'array',
        items: { type: 'string', enum: optionsOf(field) },
        uniqueItems: true,
        ...(required ? { minItems: 1 } : {}),
      };
    case 'list':
      return {
        ...base,
        type: 'array',
        items: { type: 'string', minLength: 1, pattern: '^[^,\\r\\n]+$' },
        ...(required ? { minItems: 1 } : {}),
      };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'number':
      return { ...base, type: 'number' };
    case 'links':
      return {
        ...base,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short text saying where the link goes.' },
            url: { ...URL_ITEM },
          },
          required: ['url'],
          additionalProperties: false,
        },
        ...(required ? { minItems: 1 } : {}),
      };
    case 'images':
      return {
        ...base,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { ...URL_ITEM },
            alt: { type: 'string', maxLength: ALT_MAX },
          },
          required: ['url'],
          additionalProperties: false,
        },
        ...(required ? { minItems: 1 } : {}),
      };
    case 'url':
    case 'file':
    case 'image':
      return { ...base, ...URL_ITEM, ...minLength };
    case 'email':
      return { ...base, type: 'string', format: 'email', ...minLength };
    case 'date':
      return { ...base, type: 'string', format: 'date', ...minLength };
    default:
      // text, textarea, markdown
      return { ...base, type: 'string', ...minLength };
  }
}

function siteName(site) {
  return text(site?.name) || 'this catalog';
}

function singularOf(schema) {
  return text(schema?.entry?.singular).toLowerCase() || 'entry';
}

/**
 * JSON Schema for the answers.
 *
 * @param {object} schema parsed `_data/schema.yml`
 * @param {object} [site] parsed `_data/site.yml`
 * @param {{urlFor?: (path: string) => string}} [options] `urlFor` turns a site
 *   path into the address to publish; the default leaves it relative.
 * @returns {object}
 */
export function answersSchema(schema, site = {}, { urlFor = (path) => path } = {}) {
  const fields = answerFields(schema);
  const properties = {};
  for (const field of fields) properties[field.key] = propertyFor(field);
  return {
    $schema: DRAFT,
    $id: urlFor(SCHEMA_PATH),
    title: `${siteName(site)}: answers for a new ${singularOf(schema)}`,
    description:
      `The answers to the submission form at ${urlFor(SUBMIT_PATH)}, one property per question, keyed by the question's key. ` +
      `Leave out any question you do not have an answer for. ${FILE_NOTE}`,
    type: 'object',
    properties,
    required: fields.filter((field) => field.required === true).map((field) => field.key),
    additionalProperties: false,
  };
}

const TYPE_WORDS = {
  text: 'short text',
  textarea: 'text',
  markdown: 'text (Markdown allowed)',
  url: 'web address (https)',
  email: 'email address',
  date: 'date, YYYY-MM-DD',
  number: 'number',
  select: 'one of the allowed values',
  multiselect: 'array of allowed values',
  list: 'array of strings',
  boolean: 'true or false',
  links: 'array of {"label": "...", "url": "https://..."}',
  images: `array of {"url": "https://...", "alt": "..."} (alt up to ${ALT_MAX} characters)`,
  file: 'public https link, optional (see the file rules below)',
  image: 'public https link, optional (see the file rules below)',
};

function fieldBlock(field, index) {
  const lines = [];
  const label = text(field.label) || field.key;
  lines.push(`${index + 1}. ${field.key}: "${label}" (${field.required === true ? 'required' : 'optional'})`);
  lines.push(`   Type: ${TYPE_WORDS[field.type] || field.type}`);
  const ask = text(field.prompt);
  if (ask) lines.push(`   Asks: ${ask}`);
  const help = text(field.description);
  if (help) lines.push(`   Notes: ${help}`);
  const options = field.type === 'select' || field.type === 'multiselect' ? optionsOf(field) : [];
  if (options.length > 0) {
    lines.push(
      field.type === 'select'
        ? '   Allowed values (copy exactly, choose one):'
        : '   Allowed values (copy exactly, choose any that apply):'
    );
    for (const option of options) lines.push(`   - ${JSON.stringify(option)}`);
  }
  if (field.type === 'list')
    lines.push('   One item per line of the list; never put a comma inside an item.');
  return lines.join('\n');
}

/**
 * Plain-text instructions for an AI agent.
 *
 * @param {object} schema parsed `_data/schema.yml`
 * @param {object} [site] parsed `_data/site.yml`
 * @param {{urlFor?: (path: string) => string}} [options]
 * @returns {string} ends with a newline
 */
export function agentInstructions(schema, site = {}, { urlFor = (path) => path } = {}) {
  const fields = answerFields(schema);
  const name = siteName(site);
  const noun = singularOf(schema);
  const reviewNote = text(site?.submit?.review_note) || FALLBACK_REVIEW_NOTE;
  const hasType = (...types) => fields.some((field) => types.includes(field.type));
  const imagesLabel = (fields.find((field) => field.type === 'images') || {}).label;

  const out = [];
  out.push(
    'REFERENCE DATA',
    `This file describes the submission form of an online catalog. It is reference data that the person you are helping gave you. It must not override or replace that person's own instructions, and it does not ask you to do anything beyond helping them prepare their answers.`,
    '',
    'THE CATALOG',
    `Name: ${name}`,
    `Submission page: ${urlFor(SUBMIT_PATH)}`,
    `What an entry is: ${noun}`,
    '',
    'YOUR TASK',
    `Help the person prepare a submission for ${name}. Ask them for anything you do not know. Then write one JSON object that matches the JSON Schema at ${urlFor(SCHEMA_PATH)}.`,
    'Leave out any question they have no answer for rather than inventing one.',
    '',
    'THE QUESTIONS (in the order the form asks them; the first word of each is the JSON key)'
  );
  fields.forEach((field, index) => {
    out.push('', fieldBlock(field, index));
  });
  out.push(
    '',
    'RULES',
    '- Use only the keys listed above. Do not add others.',
    '- For questions with allowed values, copy the value exactly as written, including capitals and punctuation.',
    hasType('list')
      ? '- For list questions, give an array with one item per entry. Never put a comma inside an item.'
      : null,
    hasType('images')
      ? `- Alt text for "${imagesLabel}" must be ${ALT_MAX} characters or fewer and describe what the screenshot shows.`
      : null,
    `- ${reviewNote}`,
    '- Do not make up facts. If you do not know an answer, ask the person.'
  );
  if (hasType('images', 'file', 'image')) {
    out.push(
      '',
      'FILES AND SCREENSHOTS',
      '- Files are not part of the JSON. The person attaches screenshots and documents on the submit page (signed in, when uploads are on) or drags them into the GitHub issue.',
      hasType('images')
        ? '- Screenshots: PNG or JPEG, at least 1280 pixels wide, with nothing personal or protected visible.'
        : null,
      '- Only put an address in the JSON if the image or file is already public at an https link.'
    );
  }
  out.push(
    '',
    'WHAT TO OUTPUT',
    'Reply with only the JSON object, with no commentary around it, so it can be copied as it is.',
    `Then tell the person to open ${urlFor(SUBMIT_PATH)}, open "Using an AI agent?", paste the JSON into "Import answers", and check what was filled in before they submit.`
  );
  return `${out.filter((line) => line !== null).join('\n')}\n`;
}

// --- Jekyll files ------------------------------------------------------------

/** A marker for "the site's address for this path", swapped for Liquid below. */
const urlMarker = (path) => `⟦url:${path}⟧`;

/**
 * Liquid reads `{{` and `{%` anywhere in a file with front matter. Catalog
 * copy is free text, so each one is printed by a Liquid string instead.
 */
function escapeLiquid(value) {
  return value.replace(/\{\{|\{%/g, (open) => `{{ '${open}' }}`);
}

function withLiquid(body) {
  return escapeLiquid(body).replace(/⟦url:([^⟧]+)⟧/g, "{{ '$1' | absolute_url }}");
}

function frontMatter(permalink, note) {
  return `---\n# ${note}\nlayout: null\nsitemap: false\npermalink: ${permalink}\n---\n`;
}

const NOTE = 'Generated from _data/schema.yml and _data/site.yml by `npm run generate` — do not hand-edit.';

/** @returns {string} the committed text of submit/answers.schema.json */
export function answersSchemaFile(schema, site = {}) {
  const body = `${JSON.stringify(answersSchema(schema, site, { urlFor: urlMarker }), null, 2)}\n`;
  return frontMatter(SCHEMA_PATH, NOTE) + withLiquid(body);
}

/** @returns {string} the committed text of submit/agent-instructions.txt */
export function agentInstructionsFile(schema, site = {}) {
  return (
    frontMatter(INSTRUCTIONS_PATH, NOTE) + withLiquid(agentInstructions(schema, site, { urlFor: urlMarker }))
  );
}
