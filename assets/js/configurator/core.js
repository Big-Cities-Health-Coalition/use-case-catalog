/**
 * Configurator core — the public surface both wizards import.
 *
 * This file is a barrel: every export is defined in a focused sibling module.
 * Nothing here touches the filesystem, the network or the DOM, so it runs
 * unchanged in Node 20+ (scripts/setup.mjs, scripts/generate.mjs) and in the
 * browser (/setup/, via assets/js/configurator/setup-page.js).
 *
 *   strings.js            slugs, snake_case keys, GitHub file URLs
 *   yaml-emit.js          the YAML serializer
 *   color.js              hex parsing and WCAG contrast
 *   fonts.js              bundled family names and legacy-name compatibility
 *   motion.js             the optional theme.yml `motion:` block
 *   defaults.generated.js the shipped _data/*.yml, compiled in (generated)
 *   default-config.js     defaultConfig() over that data
 *   schema-validate.js    schema v2 rules
 *   answers.js            the shared question model and answers -> config merge
 *   issue-template.js     .github/ISSUE_TEMPLATE/new-entry.yml
 *   issue-form-limits.js  GitHub's issue-form limits and help-text fitting
 *   issue-form-ids.js     element ids for keys GitHub reserves (body -> entry_body); a classic script /submit/ shares
 *   issue-chooser.js      .github/ISSUE_TEMPLATE/config.yml
 *   jekyll-config.js      _config.yml
 *   render-files.js       config -> {path: contents}
 */

export { slugify, snakeKey, githubNewFileUrl, githubEditFileUrl, prefillNoticeIfTooLong } from './strings.js';
export { toYaml, quoteYamlString, isPlainObject } from './yaml-emit.js';
export { parseHexColor, toHexColor, contrastRatio, meetsAA, isHexColor, derivePrimaryDark } from './color.js';
export { BUNDLED_FONT_NAMES, normalizeBundledFontName } from './fonts.js';
export {
  MOTION_PRESETS,
  MOTION_DURATIONS,
  MOTION_MAX_MS,
  DEFAULT_MOTION,
  motionMs,
  motionProblems,
  matchMotionPreset,
  normalizeMotion,
} from './motion.js';
export { defaultConfig, DEFAULT_JEKYLL_CONFIG, DEFAULT_JEKYLL_VALUES, ICON_NAMES } from './default-config.js';
export {
  checkSchema,
  validateSchema,
  sortByWeight,
  FIELD_TYPES,
  RESERVED_KEYS,
  CARD_SLOTS,
  CARD_SLOT_TYPES,
  OPTION_TONES,
} from './schema-validate.js';
export { applyAnswers, answersFromConfig, navigationFromSite, COLOR_QUESTIONS } from './answers.js';
export { issueTemplateFromSchema, groupedFormFields } from './issue-template.js';
export {
  issueFormProblems,
  fitHelp,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  NAME_MIN,
} from './issue-form-limits.js';
export { isRepositoryIdentity, renderIssueChooser } from './issue-chooser.js';
export { jekyllConfig, patchJekyllConfig } from './jekyll-config.js';
export { renderFiles, HEADERS } from './render-files.js';
