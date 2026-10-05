/**
 * Check every issue form in `.github/ISSUE_TEMPLATE/` against GitHub's limits
 * (assets/js/configurator/issue-form-limits.js). An invalid form vanishes from
 * the issue chooser and its prefilled links open a blank issue, so
 * `npm run generate` and `npm run validate` both stop on one.
 *
 * `config.yml` is the chooser's own settings, not a form, and is skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { issueFormProblems } from '../../assets/js/configurator/issue-form-limits.js';

export const ISSUE_TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';

/**
 * @param {string} root the repository root
 * @param {Record<string, string>} [overrides] repository-relative path → text to
 *   check instead of the file on disk (the generator's not-yet-written output)
 * @returns {{file: string, problems: {path: string, message: string}[]}[]} one per form, sorted
 */
export function checkIssueForms(root, overrides = {}) {
  const dir = path.join(root, ISSUE_TEMPLATE_DIR);
  const names = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  for (const file of Object.keys(overrides)) {
    if (path.posix.dirname(file) === ISSUE_TEMPLATE_DIR) names.add(path.posix.basename(file));
  }
  return [...names]
    .filter((name) => /\.ya?ml$/.test(name) && name !== 'config.yml' && name !== 'config.yaml')
    .sort()
    .map((name) => {
      const file = `${ISSUE_TEMPLATE_DIR}/${name}`;
      let form;
      try {
        form = yaml.load(overrides[file] ?? fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (error) {
        return {
          file,
          problems: [{ path: '(file)', message: `does not parse: ${error.message.split('\n')[0]}` }],
        };
      }
      return { file, problems: issueFormProblems(form) };
    });
}

/**
 * The failures as indented lines for a terminal, '' when there are none.
 * @param {ReturnType<typeof checkIssueForms>} results
 * @returns {string}
 */
export function describeIssueFormProblems(results) {
  return results
    .filter((result) => result.problems.length > 0)
    .map((result) => [result.file, ...result.problems.map((p) => `  • ${p.path} ${p.message}`)].join('\n'))
    .join('\n');
}
