#!/usr/bin/env node
/**
 * Build `assets/js/configurator/defaults.generated.js` from the repository's
 * real configuration files.
 *
 *   node scripts/build_defaults.mjs            # write when it changed
 *   node scripts/build_defaults.mjs --check    # exit 1 when it would change
 *
 * The /setup/ wizard runs in a browser and cannot read `_data/*.yml`, so the
 * defaults it starts from have to be compiled into a module. Generating that
 * module means the wizard's "AI use case catalog" preset can never drift from
 * what the site actually ships. `npm run generate` calls this first.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';

import { OPTIONAL_FORM_SOURCE_DIR, readOptionalFormSources } from './lib/optional_issue_forms.mjs';

export const OUTPUT_PATH = 'assets/js/configurator/defaults.generated.js';

const SOURCES = {
  SITE: '_data/site.yml',
  THEME: '_data/theme.yml',
  SCHEMA: '_data/schema.yml',
  NAVIGATION: '_data/navigation.yml',
};

const CONFIG_PATH = '_config.yml';
const ICON_INCLUDE_PATH = '_includes/icon.html';

/** Icon names listed in the generated `_includes/icon.html` header comment. */
function readIconNames(root) {
  const file = path.join(root, ICON_INCLUDE_PATH);
  if (!fs.existsSync(file)) return [];
  const match = /^Names:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean).sort();
}

/**
 * Render the defaults module. Pure: takes a repo root, returns file text.
 * @param {string} root repository root
 * @param {Record<string, string>} [pending] repository-relative path → text to
 *   read instead of the file on disk, so `npm run setup -- --dry-run` can show
 *   what the module would become once its files were written
 * @returns {string}
 */
export function renderDefaults(root, pending = {}) {
  const readSource = (relative) => {
    if (typeof pending[relative] === 'string') return pending[relative];
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`Missing ${relative}.`);
    return fs.readFileSync(file, 'utf8');
  };

  const parsed = {};
  for (const [name, relative] of Object.entries(SOURCES)) {
    parsed[name] = yaml.load(readSource(relative)) ?? null;
  }

  const configText = readSource(CONFIG_PATH);
  const configData = yaml.load(configText) ?? {};

  const lines = [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' *',
    ` * Built from ${Object.values(SOURCES).join(', ')}, ${CONFIG_PATH}`,
    ` * and ${OPTIONAL_FORM_SOURCE_DIR}/*.yml`,
    ' * by scripts/build_defaults.mjs (run via `npm run generate`).',
    ' *',
    ' * The browser wizard cannot read the repository at runtime, so the shipped',
    ' * configuration is compiled into this module. CI fails when it is stale.',
    ' */',
    '',
    `/** Parsed ${SOURCES.SITE}. */`,
    `export const SITE = ${JSON.stringify(parsed.SITE, null, 2)};`,
    '',
    `/** Parsed ${SOURCES.THEME}. */`,
    `export const THEME = ${JSON.stringify(parsed.THEME, null, 2)};`,
    '',
    `/** Parsed ${SOURCES.SCHEMA}. */`,
    `export const SCHEMA = ${JSON.stringify(parsed.SCHEMA, null, 2)};`,
    '',
    `/** Parsed ${SOURCES.NAVIGATION}. */`,
    `export const NAVIGATION = ${JSON.stringify(parsed.NAVIGATION, null, 2)};`,
    '',
    `/** Verbatim ${CONFIG_PATH}; the wizard patches title/description/url/baseurl into it. */`,
    `export const JEKYLL_CONFIG = ${JSON.stringify(configText)};`,
    '',
    `/** The build-mechanics values ${CONFIG_PATH} ships with. */`,
    `export const JEKYLL_DEFAULTS = ${JSON.stringify(
      {
        title: configData.title ?? '',
        description: configData.description ?? '',
        url: configData.url ?? '',
        baseurl: configData.baseurl ?? '',
        timezone: configData.timezone ?? '',
      },
      null,
      2
    )};`,
    '',
    `/** Icon names available to \`icon\` hints, read from ${ICON_INCLUDE_PATH}. */`,
    `export const ICON_NAMES = ${JSON.stringify(readIconNames(root), null, 2)};`,
    '',
    `/**`,
    ` * The optional issue forms' sources, file name → text of ${OPTIONAL_FORM_SOURCE_DIR}/<file>.`,
    ` * /setup/ renders from these the forms a configuration change adds, byte for`,
    ` * byte what \`npm run generate\` writes.`,
    ` */`,
    `export const OPTIONAL_FORM_SOURCES = ${JSON.stringify(readOptionalFormSources(root), null, 2)};`,
    '',
  ];

  return lines.join('\n');
}

/* --- CLI ------------------------------------------------------------------ */

// Not `file://${argv[1]}`: a checkout path with a space or a non-ASCII
// character percent-encodes in import.meta.url, the comparison quietly fails,
// and `--check` then exits 0 having done nothing — a stale-file gate that
// always passes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const check = process.argv.slice(2).includes('--check');
  const target = path.join(root, OUTPUT_PATH);
  const next = renderDefaults(root);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  if (current === next) {
    console.log(`${OUTPUT_PATH} is up to date.`);
  } else if (check) {
    console.error(`${OUTPUT_PATH} is stale — run \`npm run generate\`.`);
    process.exit(1);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next, 'utf8');
    console.log(`${current === null ? 'created' : 'updated'} ${OUTPUT_PATH}`);
  }
}
