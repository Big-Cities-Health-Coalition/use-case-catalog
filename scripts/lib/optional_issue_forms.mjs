/**
 * The issue forms a site only has while it uses them (see OPTIONAL_ISSUE_FORMS
 * in assets/js/configurator/issue-chooser.js): the cohort forms follow
 * `modules.cohorts`, Apply setup follows `github.setup_forms` or `demo`.
 *
 * Their sources live in `scripts/issue-forms/`, which is template code, so a
 * PHCT update always delivers the current wording. The copies in
 * `.github/ISSUE_TEMPLATE/` are template-owned too: the updater may add or
 * remove one while it reconciles the tree, and the `npm run generate` it runs
 * straight afterwards puts back exactly the set this deployment's
 * `_data/site.yml` asks for. That is why they are not in `ownership.generated`
 * (whose paths the updater never touches) — and why adding them there would
 * change the ownership contract every existing deployment updates through.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import {
  OPTIONAL_FORM_SOURCE_DIR,
  OPTIONAL_ISSUE_FORMS,
  optionalFormFiles,
  optionalFormPath,
  optionalFormSource,
  renderOptionalForm,
} from '../../assets/js/configurator/issue-chooser.js';
import { issueFormProblems } from '../../assets/js/configurator/issue-form-limits.js';

export { OPTIONAL_FORM_SOURCE_DIR, optionalFormPath, optionalFormSource, renderOptionalForm };

/**
 * Every optional form's source, read from disk. scripts/build_defaults.mjs
 * compiles the same map into defaults.generated.js for /setup/; a missing file
 * is left out (checkOptionalFormSources names it).
 *
 * @param {string} root the repository root
 * @returns {Record<string, string>} file name → text of scripts/issue-forms/<file>
 */
export function readOptionalFormSources(root) {
  const sources = {};
  for (const form of OPTIONAL_ISSUE_FORMS) {
    const file = path.join(root, optionalFormSource(form.file));
    if (fs.existsSync(file)) sources[form.file] = fs.readFileSync(file, 'utf8');
  }
  return sources;
}

/**
 * Which optional forms this site should have, rendered.
 *
 * @param {string} root the repository root
 * @param {object} site a parsed _data/site.yml
 * @returns {{write: Record<string, string>, remove: Record<string, string>}}
 *   repository-relative path → contents for the forms that are on, and
 *   path → the setting that turned it off for the forms that are not
 */
export function planOptionalForms(root, site) {
  return optionalFormFiles(site, readOptionalFormSources(root));
}

/**
 * What `npm run generate` would do to the optional forms, without doing it:
 * each form it would create or rewrite, and each one it would delete because
 * it is on disk while its setting is off. `npm run setup -- --dry-run` prints
 * this.
 *
 * @param {string} root the repository root
 * @param {object} site a parsed _data/site.yml
 * @returns {{write: Record<string, string>, remove: Record<string, string>}}
 *   as planOptionalForms, with `remove` narrowed to files that exist
 */
export function pendingOptionalForms(root, site) {
  const plan = planOptionalForms(root, site);
  const write = Object.fromEntries(
    Object.entries(plan.write).filter(([relative, content]) => {
      const file = path.join(root, relative);
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content;
    })
  );
  const remove = Object.fromEntries(
    Object.entries(plan.remove).filter(([relative]) => fs.existsSync(path.join(root, relative)))
  );
  return { write, remove };
}

/**
 * Check every optional form's source against GitHub's limits, on or off. The
 * template ships with the cohort module off, so without this a broken cohort
 * form would pass the template's own gate and reach every deployment that has
 * the module on.
 *
 * @param {string} root the repository root
 * @returns {{file: string, problems: {path: string, message: string}[]}[]} the
 *   same shape as checkIssueForms, one per source
 */
export function checkOptionalFormSources(root) {
  return OPTIONAL_ISSUE_FORMS.map((form) => {
    const file = optionalFormSource(form.file);
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      return { file, problems: [{ path: '(file)', message: 'is missing; restore it from PHCT.' }] };
    }
    let parsed;
    try {
      parsed = yaml.load(fs.readFileSync(absolute, 'utf8'));
    } catch (error) {
      return {
        file,
        problems: [{ path: '(file)', message: `does not parse: ${error.message.split('\n')[0]}` }],
      };
    }
    return { file, problems: issueFormProblems(parsed) };
  });
}
