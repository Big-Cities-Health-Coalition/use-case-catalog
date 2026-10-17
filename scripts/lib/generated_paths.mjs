/**
 * Files written by scripts/generate.mjs.
 *
 * Keep this list importable: ownership checks must prove that every generator
 * target is protected during a PHCT update. A path should never be copied into
 * another hand-maintained checklist.
 */

export const GENERATOR_OUTPUTS = Object.freeze([
  '_data/site.yml',
  'assets/js/configurator/defaults.generated.js',
  '.github/ISSUE_TEMPLATE/new-entry.yml',
  '_config.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  'submit/answers.schema.json',
  'submit/agent-instructions.txt',
]);

export const DERIVED_OUTPUTS = Object.freeze([
  'assets/js/configurator/defaults.generated.js',
  '.github/ISSUE_TEMPLATE/new-entry.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  'submit/answers.schema.json',
  'submit/agent-instructions.txt',
]);
