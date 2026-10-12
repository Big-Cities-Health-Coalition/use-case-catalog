#!/usr/bin/env node
/**
 * Local mirror of the CI validation gate: `npm run validate`.
 *
 * 1. Parses every _data/*.yml and _data/cohorts/*.yml file.
 * 2. Checks _data/theme.yml's colours against the contrast pairs the rendered
 *    site actually puts on top of each other.
 * 3. Checks every .github/ISSUE_TEMPLATE form against GitHub's limits.
 * 4. In CI (GITHUB_REPOSITORY set), checks that _data/site.yml and the issue
 *    template contact links point at *this* repository, not the template's.
 * 5. Runs scripts/check_front_matter.rb and scripts/check_file_sizes.rb.
 *
 * Deliberately build-free: it must stay runnable without Ruby, Jekyll or a
 * built _site. The checks that need a built tree live in `npm run test:build`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { expectedToolchain, parseToolVersions } from './lib/toolchain.mjs';
import { checkIssueForms } from './lib/issue_forms.mjs';

const ROOT = process.cwd();
let failed = false;

function report(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failed = true;
}

function warn(label, detail) {
  console.log(`WARN  ${label}${detail ? `\n      ${detail}` : ''}`);
}

// --- YAML data files -------------------------------------------------------

const dataFiles = [...listYaml(path.join(ROOT, '_data')), ...listYaml(path.join(ROOT, '_data', 'cohorts'))];

function listYaml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

for (const file of dataFiles) {
  const rel = path.relative(ROOT, file);
  try {
    yaml.load(fs.readFileSync(file, 'utf8'));
    report(true, rel);
  } catch (error) {
    report(false, rel, error.message);
  }
}

if (dataFiles.length === 0) console.log('SKIP  no YAML data files found under _data/');

// --- Theme contrast --------------------------------------------------------
// `hex_to_rgb` (_plugins/theme_filters.rb) returns "0 0 0" for anything it
// cannot parse, so a hand-edited `primary: blue` produces a black site with no
// error anywhere. The wizards already warn on these pairs interactively; this
// closes the hand-edit path with the same list.

const themeFile = path.join(ROOT, '_data', 'theme.yml');
if (fs.existsSync(themeFile)) {
  const colorModule = pathToFileURL(path.join(ROOT, 'assets/js/configurator/color.js')).href;
  const { checkThemeContrast } = await import(colorModule);
  let colors = null;
  try {
    colors = yaml.load(fs.readFileSync(themeFile, 'utf8'))?.colors ?? null;
  } catch {
    // The parse failure was already reported above.
  }
  if (colors) {
    const results = checkThemeContrast(colors);
    const problems = results.filter((result) => !result.ok);
    const describe = (result) =>
      `${result.fg} on ${result.bg} (${result.what}) is ` +
      `${result.ratio === null ? 'not a readable colour pair' : `${result.ratio.toFixed(2)}:1`}; ` +
      `needs ${result.min}:1.`;
    for (const result of problems.filter((r) => r.level === 'warn')) {
      warn('_data/theme.yml colors contrast', describe(result));
    }
    const errors = problems.filter((result) => result.level === 'error');
    report(
      errors.length === 0,
      `_data/theme.yml colors meet WCAG AA (${results.length} pairs)`,
      errors.map(describe).join('\n      ')
    );
  }
}

// --- Issue forms -------------------------------------------------------------
// GitHub drops a form that breaks its limits from the issue chooser, silently,
// and every prefilled link to it opens a blank issue instead. A schema field
// whose help text grew past 200 characters did exactly that to a deployment's
// submission form, so the PR gate checks every form, generated or hand-written.

for (const { file, problems } of checkIssueForms(ROOT)) {
  report(
    problems.length === 0,
    `${file} is within GitHub's issue-form limits`,
    problems.map((p) => `${p.path} ${p.message}`).join('\n      ')
  );
}

// --- Repository identity (CI only) -----------------------------------------
// A fork or a "Use this template" copy still carries the template's
// owner/repo until the admin runs the setup wizard. Everything the site links
// to on GitHub (issue forms, "edit this page", the submit fallback) would then
// point at the wrong repository, so fail the PR gate with the fix spelled out.
// Locally there is nothing to compare against, so the check is skipped.

const ciRepository = (process.env.GITHUB_REPOSITORY || '').trim();

if (ciRepository) {
  const siteFile = path.join(ROOT, '_data', 'site.yml');
  let siteRepository = '';
  try {
    siteRepository = String(yaml.load(fs.readFileSync(siteFile, 'utf8'))?.github?.repository || '').trim();
  } catch {
    // Parse failures were already reported above.
  }
  const matches = siteRepository.toLowerCase() === ciRepository.toLowerCase();
  report(
    matches,
    '_data/site.yml github.repository matches this repository',
    matches
      ? ''
      : `site.yml says ${JSON.stringify(siteRepository)} but this repository is ${JSON.stringify(ciRepository)}.\n` +
          `      This is normal on a fresh copy: every pull request stays red until the site is configured.\n` +
          `      Fix it from the browser — open /setup/ on your site (or edit github.repository in\n` +
          `      _data/site.yml on GitHub) and publish the result. \`npm run setup\` works too, from a checkout.`
  );

  const contactFile = path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml');
  if (fs.existsSync(contactFile)) {
    const contactText = fs.readFileSync(contactFile, 'utf8');
    const foreign = [...contactText.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)]
      .map((m) => m[1])
      .filter((repo) => repo.toLowerCase() !== ciRepository.toLowerCase());
    report(
      foreign.length === 0,
      '.github/ISSUE_TEMPLATE/config.yml links point at this repository',
      foreign.length
        ? `contact links still point at ${[...new Set(foreign)].join(', ')}. The setup wizard regenerates\n` +
            `      this file — open /setup/ on your site (or run \`npm run setup\`) and publish\n` +
            `      .github/ISSUE_TEMPLATE/config.yml with the URLs pointing at ${ciRepository}.`
        : ''
    );
  }
} else {
  console.log('SKIP  repository identity check — only runs in GitHub Actions (GITHUB_REPOSITORY unset).');
}

// --- Ruby checks -----------------------------------------------------------

const expectedRuby = expectedToolchain(ROOT).ruby;
const rubyResult = spawnSync('ruby', ['--version'], { encoding: 'utf8' });
const actualRuby = parseToolVersions({ ruby: `${rubyResult.stdout ?? ''}${rubyResult.stderr ?? ''}` }).ruby;
const rubyAvailable = rubyResult.status === 0;

if (!rubyAvailable) {
  report(
    false,
    'Ruby checks',
    `Ruby ${expectedRuby} was not found. Run \`npm run doctor\` for setup instructions; validation cannot pass partially.`
  );
} else if (actualRuby !== expectedRuby) {
  report(
    false,
    'Ruby checks',
    `Found Ruby ${actualRuby || 'unknown'}, expected exactly ${expectedRuby}. Run \`npm run doctor\`; Ruby checks were not run.`
  );
} else {
  for (const script of ['check_front_matter.rb', 'check_file_sizes.rb']) {
    const result = spawnSync('ruby', [path.join('scripts', script)], { cwd: ROOT, stdio: 'inherit' });
    report(result.status === 0, `scripts/${script}`);
  }
}

console.log(failed ? '\nValidation failed.' : '\nValidation passed.');
process.exit(failed ? 1 : 0);
