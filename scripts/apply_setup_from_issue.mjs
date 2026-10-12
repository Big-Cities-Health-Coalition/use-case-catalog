#!/usr/bin/env node
/**
 * Apply a site configuration from a GitHub issue, as a pull request.
 *
 * The `/setup/` wizard runs in the browser and hands back finished files, but
 * the last mile has always been manual: download seven files, find each one in
 * the GitHub file editor, paste, commit. This closes that gap for a maintainer
 * with no terminal — paste the three files the wizard produced into an issue
 * and the answer comes back as a reviewable pull request.
 *
 * Only three files are pasted. `_data/navigation.yml`, `_config.yml`,
 * `.github/ISSUE_TEMPLATE/new-entry.yml` and `.github/ISSUE_TEMPLATE/config.yml` are *derived* from them by
 * `renderFiles()` — the same function both configurators use — so the
 * generated half can never drift from the pasted half, however stale the tab
 * the maintainer copied from.
 *
 * Input (env):   ISSUE_BODY, ISSUE_NUMBER
 * Output:        _data/site.yml, _data/theme.yml, _data/schema.yml,
 *                _data/navigation.yml, _config.yml,
 *                .github/ISSUE_TEMPLATE/new-entry.yml,
 *                .github/ISSUE_TEMPLATE/config.yml
 *                $GITHUB_OUTPUT:  branch, title, files, warnings, summary
 *                $GITHUB_STEP_SUMMARY: the same report, for the run page
 *
 * Flags:         --dry-run   report what would be written, write nothing
 *
 * Trust model: the workflow that runs this refuses issues from anyone who is
 * not a maintainer, because the pasted YAML becomes the site's configuration.
 * The blast radius is still bounded — `renderFiles()` returns a fixed set of
 * seven repo-relative paths, so nothing here can write outside them — and the
 * result is a pull request either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import * as core from '../assets/js/configurator/core.js';
import { checkThemeContrast } from '../assets/js/configurator/color.js';
import { ejectSamples, ejectSummary } from './eject_samples.mjs';
import { fail, setOutput } from './lib/actions_output.mjs';
import { parseSections, rawValue } from './lib/issue_body.mjs';
import { diffSummary, writeFiles } from './lib/setup-io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Section headings in `scripts/issue-forms/apply-setup.yml` (copied into
 * `.github/ISSUE_TEMPLATE/` while setup forms are on). The form is
 * hand-written rather than built from the schema, so these two lists are the contract
 * between it and this script; `test/scripts/apply_setup.test.mjs` asserts they
 * still agree.
 */
export const SECTION_LABELS = {
  site: '_data/site.yml',
  theme: '_data/theme.yml',
  schema: '_data/schema.yml',
  options: 'While you are here',
};

/** The checkbox that also clears the demo content. */
export const EJECT_LABEL = 'Remove the demo content';

/**
 * The YAML inside a section, with the code fence GitHub's `render: yaml`
 * wraps it in removed. A maintainer who pastes into a plain textarea, or who
 * adds their own fence, lands in the same place.
 *
 * @param {string} raw the section's text.
 * @returns {string}
 */
export function stripFence(raw) {
  const text = String(raw ?? '').trim();
  const fenced = /^(?:```|~~~)[^\n]*\n([\s\S]*?)\n?(?:```|~~~)\s*$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Split the issue into the three pasted files and the options.
 *
 * @param {string} body the raw issue body.
 * @returns {{site: string, theme: string, schema: string, eject: boolean}}
 */
export function parseSetupIssue(body) {
  const sections = parseSections(body, Object.values(SECTION_LABELS));
  const section = (label) => stripFence(rawValue(sections, { label }));
  const options = rawValue(sections, { label: SECTION_LABELS.options });
  return {
    site: section(SECTION_LABELS.site),
    theme: section(SECTION_LABELS.theme),
    schema: section(SECTION_LABELS.schema),
    // `- [x] Remove the demo content …` — the checked box, not merely the
    // presence of the words.
    eject: new RegExp(`^\\s*[-*]\\s*\\[x\\]\\s*${EJECT_LABEL}`, 'im').test(options),
  };
}

/**
 * Parse one pasted file, refusing anything that is not a YAML mapping.
 *
 * @param {string} text the section contents.
 * @param {string} label the file it is supposed to be, for the error message.
 * @returns {object|null} null when the box was left empty.
 */
export function parseYamlSection(text, label) {
  if (text === '') return null;
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    throw new Error(`${label} is not valid YAML: ${error.message.split('\n')[0]}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${label} must be a mapping of settings, not ${Array.isArray(parsed) ? 'a list' : 'a scalar'}.`
    );
  }
  return parsed;
}

/**
 * Everything wrong with a configuration, as maintainer-readable lines. An
 * empty array means the pull request is worth opening.
 *
 * @param {{site: object, theme: object, schema: object}} config
 * @returns {string[]}
 */
export function configErrors(config) {
  const errors = core.validateSchema(config.schema).map((message) => `_data/schema.yml — ${message}`);
  if (!config.site?.name)
    errors.push('_data/site.yml — `name` is required; the header and every page title use it.');
  if (!core.isRepositoryIdentity(config.site?.github?.repository)) {
    errors.push('_data/site.yml — `github.repository` is required in the form "owner/repo".');
  }
  // The same pairs `npm run validate` gates on, checked here so the answer
  // arrives on the issue rather than as a red X on the pull request.
  for (const result of checkThemeContrast(config.theme?.colors ?? {})) {
    if (result.ok || result.level !== 'error') continue;
    const ratio = result.ratio === null ? 'unreadable' : `${result.ratio.toFixed(2)}:1`;
    errors.push(
      `_data/theme.yml — ${result.fg} on ${result.bg} (${result.what}) is ${ratio}, needs ${result.min}:1.`
    );
  }
  return errors;
}

/**
 * The files to write, with `_config.yml` patched rather than replaced: it
 * holds build mechanics the wizard does not manage (excludes, plugins,
 * defaults), and only the two lines derived from `_data/site.yml` are ours.
 *
 * @param {string} root repository root.
 * @param {{site: object, theme: object, schema: object}} config
 * @returns {Record<string, string>} repo-relative path -> contents.
 */
export function filesFor(root, config) {
  const files = core.renderFiles(config, { url: '', baseurl: '' });
  const configFile = path.join(root, '_config.yml');
  if (fs.existsSync(configFile)) {
    files['_config.yml'] = core.patchJekyllConfig(fs.readFileSync(configFile, 'utf8'), config.site).text;
  }
  return files;
}

/**
 * Read `_data/theme.yml` from disk, for an issue that left the theme box empty.
 * @param {string} root repository root.
 * @returns {object}
 */
function currentTheme(root) {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(root, '_data', 'theme.yml'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the run report to stdout and, in Actions, to the job summary. */
function report(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// --- run --------------------------------------------------------------------

function run() {
  const issueBody = String(process.env.ISSUE_BODY ?? '').replace(/\r\n?/g, '\n');
  const issueNumber = String(process.env.ISSUE_NUMBER ?? '').trim();

  if (!/^\d+$/.test(issueNumber)) fail('ISSUE_NUMBER must be the issue number.');

  const pasted = parseSetupIssue(issueBody);
  if (pasted.site === '' && pasted.schema === '') {
    fail(
      'Nothing to apply: both `_data/site.yml` and `_data/schema.yml` were empty. ' +
        'Open /setup/ on the site, copy each file from the review step, and edit this issue.'
    );
  }

  let config;
  try {
    config = {
      site: parseYamlSection(pasted.site, '_data/site.yml'),
      theme: parseYamlSection(pasted.theme, '_data/theme.yml') ?? currentTheme(ROOT),
      schema: parseYamlSection(pasted.schema, '_data/schema.yml'),
    };
  } catch (error) {
    fail(error.message);
  }

  const warnings = [];
  if (pasted.theme === '') warnings.push('The theme box was empty, so `_data/theme.yml` was left as it is.');

  const errors = configErrors(config);
  if (errors.length > 0) {
    fail(`This configuration cannot be applied yet:\n${errors.map((line) => `- ${line}`).join('\n')}`);
  }

  const files = filesFor(ROOT, config);
  const changed = Object.entries(files).map(([relative, content]) => ({
    relative,
    change: diffSummary(ROOT, relative, content),
  }));

  if (!DRY_RUN) writeFiles(ROOT, files);

  // Ejecting runs after the write: `_data/site.yml` has just been replaced, and
  // the `demo:` line it turns off is the one in the new file.
  const ejected = pasted.eject ? ejectSummary(ejectSamples(ROOT, { dryRun: DRY_RUN })) : [];

  const modulesOn =
    Object.entries(config.site.modules ?? {})
      .filter(([, on]) => on)
      .map(([key]) => key)
      .join(', ') || 'none';

  const summary = [
    '### Configuration',
    '',
    '| | |',
    '| --- | --- |',
    `| Site | ${config.site.name} |`,
    `| Entries | ${config.schema.entry?.singular} / ${config.schema.entry?.plural} (${config.schema.fields.length} fields) |`,
    `| Modules on | ${modulesOn} |`,
    `| Repository | ${config.site.github.repository} (${config.site.github.branch ?? 'main'}) |`,
    '',
    '### Files',
    '',
    ...changed.map(({ relative, change }) => `- \`${relative}\` — ${change}`),
    ...(ejected.length ? ['', '### Demo content', '', ...ejected.map((line) => `- ${line}`)] : []),
    ...(warnings.length ? ['', '### Warnings', '', ...warnings.map((line) => `- ${line}`)] : []),
  ].join('\n');

  setOutput('branch', `setup/apply-${issueNumber}`);
  setOutput('title', `Configure the site: ${config.site.name}`);
  setOutput('files', changed.map(({ relative }) => relative).join('\n'));
  setOutput('warnings', warnings.join('\n'));
  setOutput('summary', summary);

  report(`${DRY_RUN ? '## Dry run — nothing was written\n\n' : ''}${summary}`);
}

// Importable for the tests; only a direct invocation touches the repository.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
