/**
 * What `npm run generate` would change, worked out without writing anything.
 *
 * `npm run setup` writes the configurator's files and then runs generate, so
 * its `--dry-run` has to show both halves: the files it writes itself, and what
 * generate does next with them — the wizard defaults it recompiles, and the
 * optional issue forms it adds or deletes.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { renderIssueChooser, setupFormsEnabled } from '../../assets/js/configurator/issue-chooser.js';
import { OUTPUT_PATH as DEFAULTS_PATH, renderDefaults } from '../build_defaults.mjs';
import { pendingOptionalForms } from './optional_issue_forms.mjs';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const CHOOSER_PATH = '.github/ISSUE_TEMPLATE/config.yml';

/**
 * Point file-view links into GitHub (/blob/, /tree/, /raw/, /edit/) at
 * `repository`. The shipped footer links to a file in the template's own
 * repository, so a fork's footer keeps pointing at the template until this
 * runs; a bare github.com/org/project link is a deliberate link out and stays.
 *
 * @param {string} text the contents of _data/site.yml
 * @param {string} repository owner/repository; anything else leaves the text alone
 * @returns {string}
 */
export function pointRepositoryLinks(text, repository) {
  const own = String(repository ?? '').trim();
  if (!REPOSITORY.test(own)) return text;
  return text.replace(/github\.com\/[\w.-]+\/[\w.-]+(?=\/(?:blob|tree|raw|edit)\/)/g, `github.com/${own}`);
}

/**
 * The files `npm run generate` would write or delete once `files` are on disk.
 * Generate rewrites `files` to the same bytes, except the issue chooser when
 * the setup flag in `files`' site.yml differs from the one it was rendered with.
 *
 * @param {string} root the repository root
 * @param {Record<string, string>} files repository-relative path → contents
 *   about to be written; must include _data/site.yml
 * @returns {{write: Record<string, string>, remove: Record<string, string>}}
 *   path → new contents for each file generate would create or change, and
 *   path → the setting that turned it off for each file it would delete
 */
export function planGenerate(root, files) {
  const site = yaml.load(files['_data/site.yml']) || {};
  const write = {};

  const defaults = renderDefaults(root, files);
  const defaultsFile = path.join(root, DEFAULTS_PATH);
  if (!fs.existsSync(defaultsFile) || fs.readFileSync(defaultsFile, 'utf8') !== defaults) {
    write[DEFAULTS_PATH] = defaults;
  }

  // The chooser follows the setup flag, which can differ from what `files`
  // rendered (setup's demo removal turns `demo` off after writing them).
  const repository = String(site.github?.repository ?? '').trim();
  if (REPOSITORY.test(repository)) {
    const chooser = renderIssueChooser(repository, site.github?.branch, { setup: setupFormsEnabled(site) });
    const chooserFile = path.join(root, CHOOSER_PATH);
    const current =
      files[CHOOSER_PATH] ?? (fs.existsSync(chooserFile) ? fs.readFileSync(chooserFile, 'utf8') : null);
    if (current !== chooser) write[CHOOSER_PATH] = chooser;
  }
  const forms = pendingOptionalForms(root, site);
  return { write: { ...write, ...forms.write }, remove: forms.remove };
}
