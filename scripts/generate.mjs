#!/usr/bin/env node
/**
 * Regenerate everything derived from _data/*.yml.
 *
 *   npm run generate            write the files that changed
 *   npm run generate -- --check exit 1 if anything would change (CI gate)
 *
 * Writes  assets/js/configurator/defaults.generated.js  (wizard defaults)
 * Writes  .github/ISSUE_TEMPLATE/new-entry.yml          (public submission form)
 * Syncs   _config.yml title/description from _data/site.yml (SEO fallbacks)
 * Writes  .github/ISSUE_TEMPLATE/config.yml          (public/private report routing)
 * Syncs   _data/site.yml links into this repository's own files (footer guide link)
 *
 * Run this after hand-editing _data/schema.yml or _data/site.yml. It is
 * idempotent: a second run reports no changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { renderDefaults, OUTPUT_PATH as DEFAULTS_PATH } from './build_defaults.mjs';
import { GENERATOR_OUTPUTS } from './lib/generated_paths.mjs';
import { renderIssueChooser } from '../assets/js/configurator/issue-chooser.js';
import { checkIssueForms, describeIssueFormProblems } from './lib/issue_forms.mjs';

const ROOT = process.cwd();
const [SITE_DATA_PATH, generatedDefaultsPath, ISSUE_TEMPLATE_PATH, CONFIG_PATH, CONTACT_LINKS_PATH] =
  GENERATOR_OUTPUTS;

if (generatedDefaultsPath !== DEFAULTS_PATH) {
  throw new Error(`Generator path mismatch: ${generatedDefaultsPath} !== ${DEFAULTS_PATH}`);
}

const check = process.argv.slice(2).some((arg) => arg === '--check');
const changes = [];
const stale = [];

function abort(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function readData(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) abort(`Missing ${relative}. Run \`npm run setup\` first.`);
  try {
    return yaml.load(fs.readFileSync(file, 'utf8')) || {};
  } catch (error) {
    abort(`Could not parse ${relative}:\n  ${error.message}`);
  }
}

/**
 * Write when the content differs — or, under `--check`, just record it.
 * @returns {boolean} true when the file was already up to date.
 */
function sync(relative, content, note = '') {
  const file = path.join(ROOT, relative);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return true;
  if (check) {
    stale.push(relative);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write beside the target and rename: every file here is tracked, and a
  // partial write (ENOSPC, Ctrl-C) would leave a committed file truncated.
  // A rename within one directory is atomic.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
  changes.push(`${existing === null ? 'created' : 'updated'} ${relative}${note ? ` (${note})` : ''}`);
  return false;
}

// --- 0. links into our own repository, in _data/site.yml --------------------
// The shipped footer has a "Maintainer guide" link to a file in this
// repository, so a fork's public footer keeps pointing at the template until
// someone rewrites it. Only file-view URLs (/blob/, /tree/, /raw/, /edit/) are
// rewritten — those name a repository's own source, whereas a bare
// github.com/org/project link in the footer is a deliberate link out.
//
// This runs before anything is derived from _data/site.yml: the wizard defaults
// below are compiled from the file, so patching it afterwards left them one run
// stale and `--check` red on the very commit that had just run `generate`.

const repository = String(readData(SITE_DATA_PATH).github?.repository || '').trim();
const ownRepository = /^[\w.-]+\/[\w.-]+$/.test(repository);
if (ownRepository) {
  const siteFile = path.join(ROOT, SITE_DATA_PATH);
  const original = fs.readFileSync(siteFile, 'utf8');
  const patched = original.replace(
    /github\.com\/[\w.-]+\/[\w.-]+(?=\/(?:blob|tree|raw|edit)\/)/g,
    `github.com/${repository}`
  );
  sync(SITE_DATA_PATH, patched, `repository links point at ${repository}`);
}

// --- 1. wizard defaults, compiled from _data/*.yml --------------------------
// Written first: core.js imports the generated module.

sync(DEFAULTS_PATH, renderDefaults(ROOT));

const core = await import(pathToFileURL(path.join(ROOT, 'assets/js/configurator/core.js')).href);

// --- 2. schema check --------------------------------------------------------

const schema = readData('_data/schema.yml');
const site = readData(SITE_DATA_PATH);

const result = core.checkSchema(schema);
if (!result.ok) {
  console.error('\n_data/schema.yml is not valid:\n');
  for (const { path: where, message } of result.errors) console.error(`  • ${where}: ${message}`);
  console.error('\nFix the field definitions and run `npm run generate` again.\n');
  process.exit(1);
}
for (const { path: where, message } of result.warnings) console.warn(`  ! ${where}: ${message}`);

// --- 3. issue form ----------------------------------------------------------

// GitHub hides a form that breaks its limits (a description over 200
// characters, for one) and its links then open a blank issue. The generator
// keeps new-entry.yml inside them; this catches what it cannot (a dropdown
// with no options) and every hand-written form beside it, before anything
// broken is written.

const fieldCount = (Array.isArray(schema.fields) ? schema.fields : []).filter((f) => f.form !== false).length;
const issueTemplate = core.issueTemplateFromSchema(schema, site);
const formProblems = describeIssueFormProblems(
  checkIssueForms(ROOT, { [ISSUE_TEMPLATE_PATH]: issueTemplate })
);
if (formProblems) {
  abort(
    `GitHub would reject these issue forms and hide them from the issue chooser:\n\n${formProblems}\n\n` +
      `Shorten the text named above (for new-entry.yml, the field in _data/schema.yml or the submit intro in\n` +
      `_data/site.yml) and run \`npm run generate\` again.`
  );
}
sync(ISSUE_TEMPLATE_PATH, issueTemplate, `${fieldCount} fields`);

// --- 4. _config.yml title/description ---------------------------------------

const configFile = path.join(ROOT, CONFIG_PATH);
if (fs.existsSync(configFile)) {
  const original = fs.readFileSync(configFile, 'utf8');
  const patched = core.patchJekyllConfig(original, site);
  sync(CONFIG_PATH, patched.text, `${patched.changed.join(' and ')} synced from _data/site.yml`);
} else {
  console.warn(`Warning: ${CONFIG_PATH} not found; skipped the title/description sync.`);
}

// --- 5. issue chooser -------------------------------------------------------
// This protected downstream file must retain repository identity while still
// receiving structural safety fixes from newer PHCT releases. Render it from
// the canonical generator instead of patching whatever older shape survived
// the update.

if (ownRepository) {
  sync(
    CONTACT_LINKS_PATH,
    renderIssueChooser(repository, site.github?.branch),
    `routing generated for ${repository}`
  );
}

// --- report -----------------------------------------------------------------

if (check) {
  if (stale.length === 0) {
    console.log('Generated files are in sync.');
  } else {
    console.error('\nThese generated files are out of date:\n');
    for (const file of stale) console.error(`  • ${file}`);
    console.error('\nRun `npm run generate` and commit the result.\n');
    process.exit(1);
  }
} else if (changes.length === 0) {
  console.log('Everything is up to date — no changes.');
} else {
  for (const change of changes) console.log(change);
}
