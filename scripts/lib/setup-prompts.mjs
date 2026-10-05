/**
 * The question half of `npm run setup`: the stdin/stdout asker, the answer
 * validators, and the script of questions itself.
 *
 * `askAnswers()` is the whole interview in one place, so the flow can be read
 * top to bottom without the file writing and diffing around it.
 */

import process from 'node:process';
import readline from 'node:readline/promises';

import { bold, cyan, dim, red } from './setup-io.mjs';

/* -------------------------------------------------------------------------- */
/* Asker                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Prompts the wizard's questions over stdin/stdout, or answers every question
 * with its default when `auto` is true (`--yes`, `--out`, or once stdin ends).
 */
export class Asker {
  /** @param {{auto: boolean}} options `auto: true` skips prompting entirely. */
  constructor({ auto }) {
    this.auto = auto;
    this.queue = [];
    this.pending = null;
    if (auto) {
      this.rl = null;
      return;
    }
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: Infinity });
    // Buffer lines ourselves. When stdin is a pipe readline emits every line as
    // soon as the chunk arrives, so answers would be dropped between questions.
    this.rl.on('line', (line) => {
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    // End of input: fall back to accepting defaults for whatever is left.
    this.rl.on('close', () => {
      this.auto = true;
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve('');
      }
    });
  }

  /**
   * Print `prompt` and resolve with the next line of input, pulling from the
   * buffered queue first (see the constructor's `line` handler).
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async ask(prompt) {
    if (this.rl.terminal) {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    } else {
      process.stdout.write(prompt);
    }
    if (this.queue.length > 0) return this.queue.shift();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  /**
   * Ask a free-text question, re-prompting until `validate` passes (or `auto`
   * is set, in which case `fallback` is returned unchecked).
   * @param {string} label question text.
   * @param {string} fallback used when the answer is blank, or always in auto mode.
   * @param {{help?: string, validate?: (value: string) => string|null}} [options]
   *   `validate` returns an error message, or null when the value is fine.
   * @returns {Promise<string>}
   */
  async text(label, fallback, { help, validate } = {}) {
    for (;;) {
      if (this.auto) return fallback;
      if (help) console.log(dim(`  ${help}`));
      const answer = (await this.ask(`${label} ${dim(`[${fallback}]`)}\n> `)).trim();
      const value = answer === '' ? fallback : answer;
      const problem = validate ? validate(value) : null;
      if (!problem) {
        console.log('');
        return value;
      }
      console.log(red(`  ${problem}`));
    }
  }

  /**
   * Ask a yes/no question.
   * @param {string} label question text.
   * @param {boolean} fallback used on a blank answer, or always in auto mode.
   * @param {{help?: string}} [options]
   * @returns {Promise<boolean>}
   */
  async confirm(label, fallback, { help } = {}) {
    if (this.auto) return fallback;
    if (help) console.log(dim(`  ${help}`));
    const suffix = fallback ? 'Y/n' : 'y/N';
    const answer = (await this.ask(`${label} ${dim(`[${suffix}]`)} `)).trim().toLowerCase();
    if (answer === '') return fallback;
    return /^(y|yes)$/.test(answer);
  }

  /**
   * Ask the submitter to pick one of a numbered list of choices.
   * @param {string} label question text.
   * @param {Array<{name: string, description?: string}>} choices
   * @param {number} [fallbackIndex] used on a blank answer, or always in auto mode.
   * @returns {Promise<object>} the chosen entry from `choices`.
   */
  async choose(label, choices, fallbackIndex = 0) {
    if (this.auto) return choices[fallbackIndex];
    console.log(bold(label));
    choices.forEach((choice, index) => {
      console.log(`  ${cyan(String(index + 1))}. ${bold(choice.name)}`);
      if (choice.description) console.log(dim(`     ${choice.description}`));
    });
    for (;;) {
      if (this.auto) return choices[fallbackIndex];
      const answer = (await this.ask(`Choose 1-${choices.length} ${dim(`[${fallbackIndex + 1}]`)} `)).trim();
      if (answer === '') {
        console.log('');
        return choices[fallbackIndex];
      }
      const index = Number.parseInt(answer, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) {
        console.log('');
        return choices[index];
      }
      console.log(red(`  Enter a number between 1 and ${choices.length}.`));
    }
  }

  close() {
    if (this.rl) this.rl.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Validators                                                                 */
/* -------------------------------------------------------------------------- */

/** @returns {string|null} an error message, or null when the value is fine. */
export const requiredValidator = (value) => (String(value).trim() ? null : 'This cannot be empty.');

/** @returns {string|null} */
export const emailValidator = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Enter a valid email address.';

/** @returns {string|null} */
export const repoValidator = (value) =>
  /^[\w.-]+\/[\w.-]+$/.test(value) ? null : 'Use the form owner/repo, e.g. bigcities/ai-catalog.';

/**
 * @param {(value: string) => boolean} isHexColor from the configurator core.
 * @returns {(value: string) => string|null}
 */
export const hexValidator = (isHexColor) => (value) =>
  isHexColor(value) ? null : 'Enter a 6-digit hex color such as #1D4E89.';

/* -------------------------------------------------------------------------- */
/* Choices                                                                    */
/* -------------------------------------------------------------------------- */

export const MODULE_HELP = {
  catalog: 'The browsable, filterable catalog of entries. This is the core of the site.',
  submit: 'A public "Submit an entry" form that opens a GitHub issue, then a pull request.',
  carousel: 'A featured-entries carousel on the home page.',
  stats: 'Headline numbers (entry counts, contributing organizations) on the home page.',
  events: 'An events calendar rendered from _data/events.yml.',
  cohorts: 'Cohort / program-year pages with timelines and materials.',
  resources: 'A separate curated resource library from _data/resources.yml.',
  status: 'A "Check your submission" page: submitters look up a submission by its GitHub number.',
};

export const RADIUS_CHOICES = [
  { id: 'sharp', name: 'Sharp', description: 'Square corners — institutional, dense.' },
  { id: 'soft', name: 'Soft', description: 'Lightly rounded corners. A good default.' },
  { id: 'round', name: 'Round', description: 'Generously rounded — friendly, consumer-like.' },
];

export const BODY_FONT_CHOICES = [
  { id: 'Inter', name: 'Inter', description: 'Bundled. Neutral, excellent at small sizes.' },
  { id: 'PHCT Sans', name: 'PHCT Sans', description: 'Bundled. Slightly warmer than Inter.' },
  {
    id: 'other',
    name: 'Something else',
    description: 'Any family, loaded from a Google Fonts URL you provide.',
  },
];

export const HEADING_FONT_CHOICES = [
  {
    id: 'PHCT Serif',
    name: 'PHCT Serif',
    description: 'Bundled title face derived from Source Serif 4.',
  },
  ...BODY_FONT_CHOICES,
];

/** The index of `id` in `choices`, or 0 when it is not one of them. */
function indexOfChoice(choices, id) {
  const index = choices.findIndex((choice) => choice.id === id);
  return index >= 0 ? index : 0;
}

/* -------------------------------------------------------------------------- */
/* The interview                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ask every question, in order, and return the flat answers object
 * `core.applyAnswers()` consumes.
 *
 * @param {Asker} asker
 * @param {{site: object, theme: object, schema: object}} base the chosen preset's config; every default comes from it.
 * @param {{core: object, gitRepository: string|null}} context
 * @returns {Promise<Record<string, *>>}
 */
export async function askAnswers(asker, base, { core, gitRepository }) {
  const answers = {};
  const isHex = hexValidator(core.isHexColor);

  // --- identity -------------------------------------------------------------
  answers.siteName = await asker.text('Site name', base.site.name, { validate: requiredValidator });
  answers.tagline = await asker.text('Tagline (one short line under the site name)', base.site.tagline);
  answers.description = await asker.text('Description (used for SEO and the feed)', base.site.description);

  answers.orgName = await asker.text('Organization name', base.site.organization.name, {
    validate: requiredValidator,
  });
  answers.orgShort = await asker.text(
    'Organization short name / initials',
    base.site.organization.short_name
  );
  answers.logoText = await asker.text(
    'Logo text mark (shown when no logo image is set)',
    base.site.logo.text || answers.orgShort
  );
  answers.orgUrl = await asker.text('Organization website', base.site.organization.url);
  answers.contactEmail = await asker.text('Contact email', base.site.organization.contact_email, {
    validate: emailValidator,
  });
  answers.submitFallbackEmail = answers.contactEmail;

  answers.repository = await asker.text(
    'GitHub repository (owner/repo)',
    gitRepository || base.site.github.repository,
    {
      help: gitRepository
        ? 'Detected from your git remote.'
        : 'Where this site lives. Used for submit links and "edit this page".',
      validate: repoValidator,
    }
  );
  answers.branch = await asker.text('Branch GitHub Pages builds from', base.site.github.branch);

  // --- colors and type ------------------------------------------------------
  console.log(bold('Colors') + dim(' — 6-digit hex. Keep text on background at 4.5:1 contrast.'));
  answers.primary = await asker.text('Primary (buttons, links)', base.theme.colors.primary, {
    validate: isHex,
  });
  answers.primaryDark = await asker.text(
    'Primary dark (hero and footer background)',
    base.theme.colors.primary_dark,
    { validate: isHex }
  );
  answers.secondary = await asker.text('Secondary (supporting badges)', base.theme.colors.secondary, {
    validate: isHex,
  });
  answers.accent = await asker.text('Accent (warm highlights)', base.theme.colors.accent, {
    validate: isHex,
  });

  const primaryContrast = core.contrastRatio(base.theme.colors.on_dark ?? '#FFFFFF', answers.primaryDark);
  if (primaryContrast !== null && primaryContrast < 4.5) {
    console.log(
      red(
        `  Warning: text on the primary-dark background is only ${primaryContrast.toFixed(1)}:1 (AA needs 4.5:1).`
      )
    );
    console.log(
      dim('  Pick a darker primary_dark, or edit theme.colors.on_dark in _data/theme.yml afterwards.\n')
    );
  }

  const headingChoice = await asker.choose(
    'Heading font:',
    HEADING_FONT_CHOICES,
    indexOfChoice(HEADING_FONT_CHOICES, core.normalizeBundledFontName(base.theme.fonts.heading))
  );
  if (headingChoice.id === 'other') {
    answers.headingFont = await asker.text('Heading font family name', base.theme.fonts.heading);
    answers.googleFontsUrl = await asker.text('Google Fonts <link> href', base.theme.fonts.google_fonts_url, {
      help: 'Copy the href from fonts.google.com, e.g. https://fonts.googleapis.com/css2?family=...&display=swap',
    });
  } else {
    answers.headingFont = headingChoice.id;
  }

  const bodyChoice = await asker.choose(
    'Body font:',
    BODY_FONT_CHOICES,
    indexOfChoice(BODY_FONT_CHOICES, core.normalizeBundledFontName(base.theme.fonts.body))
  );
  if (bodyChoice.id === 'other') {
    answers.bodyFont = await asker.text('Body font family name', base.theme.fonts.body);
    answers.googleFontsUrl = await asker.text(
      'Google Fonts <link> href',
      answers.googleFontsUrl ?? base.theme.fonts.google_fonts_url
    );
  } else {
    answers.bodyFont = bodyChoice.id;
  }

  answers.radius = (
    await asker.choose('Corner rounding:', RADIUS_CHOICES, indexOfChoice(RADIUS_CHOICES, base.theme.radius))
  ).id;

  // --- modules --------------------------------------------------------------
  console.log(bold('Modules') + dim(' — turn sections of the site on or off. You can change these later.'));
  answers.modules = {};
  for (const [key, enabled] of Object.entries(base.site.modules)) {
    answers.modules[key] = await asker.confirm(`  Enable ${bold(key)}?`, enabled, { help: MODULE_HELP[key] });
  }
  console.log('');
  if (!answers.modules.catalog) {
    console.log(red('  Note: the catalog module is off — the site will have no entry listing.\n'));
  }

  // --- entry naming ---------------------------------------------------------
  answers.entrySingular = await asker.text(
    'What is one entry called? (singular)',
    base.schema.entry.singular,
    {
      help: 'Used in buttons, the issue form and page headings. e.g. "Use case", "Resource", "Team project".',
      validate: requiredValidator,
    }
  );
  answers.entryPlural = await asker.text('And several of them? (plural)', base.schema.entry.plural, {
    validate: requiredValidator,
  });

  // --- copy -----------------------------------------------------------------
  answers.heroEyebrow = await asker.text(
    'Home page eyebrow (small line above the headline)',
    base.site.hero.eyebrow
  );
  answers.heroTitle = await asker.text('Home page headline', base.site.hero.title, {
    validate: requiredValidator,
  });
  answers.heroLead = await asker.text('Home page lead paragraph', base.site.hero.lead);
  answers.submitIntro = await asker.text('Submission page intro', base.site.submit.intro);
  answers.footerAbout = await asker.text('Footer "about" paragraph', base.site.footer.about);
  answers.copyright = await asker.text('Copyright holder', answers.orgName || base.site.footer.copyright);

  return answers;
}
