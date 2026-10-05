#!/usr/bin/env node
/**
 * Build the showcase: a landing page at the site root and one complete,
 * live example site per preset under `/examples/<preset-id>/`.
 *
 *   node scripts/build_showcase.mjs                          into ./_site
 *   node scripts/build_showcase.mjs --destination _site \
 *        --url https://owner.github.io --baseurl /phct
 *   node scripts/build_showcase.mjs cohort-portal            landing + that one
 *   node scripts/build_showcase.mjs --keep                   leave the scratch trees
 *
 * Why: a Jekyll site is one configuration, so the deployment could only ever
 * show one of the four presets — a reader had to take the README's word that
 * the same repository is also a cohort portal or a resource library. Each
 * example here is a full build of this repository with that preset's `_data`
 * overlaid and its own sample content, assembled into a single Pages artifact.
 * See docs/showcase-plan.md.
 *
 * The overlay runs through `scripts/setup.mjs --preset <id> --out <dir>`, the
 * same code path the wizard uses, so an example is exactly what a fork gets
 * from picking that preset on step 1. The flagship example — the preset whose
 * configuration this repository already ships — is built from the working tree
 * untouched, and is the only one left able to open issues.
 *
 * Everything the built pages read about the showcase is data: `site.showcase`
 * (a generated `_config.showcase.yml`) for build-time facts, and
 * `_data/showcase_presets.json` (generated from `assets/js/configurator/presets.js`)
 * for what each preset actually configures. Neither is committed.
 *
 * Needs Ruby + `bundle install` and a built `assets/css/site.css`, like
 * scripts/build_variants.mjs; assertions live in test/build/showcase.test.mjs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';

import { copyTree, readYaml, removeEntries, run, writeYaml } from './lib/build-tree.mjs';
import { emptiedYaml } from './eject_samples.mjs';
import { seedFixtureEntries } from './seed_fixture_entries.mjs';

export const ROOT = process.env.BUILD_SHOWCASE_ROOT
  ? path.resolve(process.env.BUILD_SHOWCASE_ROOT)
  : process.cwd();

/** Where an example's authored sample content lives, relative to the repository. */
export const SHOWCASE_CONTENT = '_showcase';

/**
 * Shipped sample content an example replaces with its own: the entry folders,
 * the cohort data and the pages paired with it, and the two feature data files.
 * Emptied rather than left in place, so an example that ships no cohort data
 * does not inherit this repository's.
 */
const EMPTIED_DATA = ['_data/events.yml', '_data/resources.yml'];

/** The landing's one include; a landing build cannot go ahead without it. */
const LANDING_INCLUDE = path.join('_includes', 'showcase-landing.html');

/**
 * The pages a landing build ships. Keep in step with `_plugins/showcase.rb`'s
 * LANDING_PAGES, which is what actually drops the rest; this copy is only used
 * to keep the shipped header and footer from linking to the dropped ones.
 */
const LANDING_PAGES = ['/', '/setup/', '/404.html'];

/* -------------------------------------------------------------------------- */
/* Pure helpers — the contracts the templates and the tests read.              */

/**
 * A baseurl in the one form the rest of this file assumes: '' at a domain root,
 * or '/name' with no trailing slash.
 * @param {string} baseurl
 * @returns {string}
 */
export function normalizeRoot(baseurl) {
  const trimmed = String(baseurl ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Every example, in landing order, as `site.showcase.examples`: the switcher
 * and the landing take their names and paths from here, so nothing downstream
 * ever writes a preset id.
 *
 * @param {{id: string, name: string}[]} presets `presets` from presets.js.
 * @param {string} root normalized baseurl of the landing build.
 * @returns {{id: string, name: string, path: string}[]}
 */
export function showcaseExamples(presets, root) {
  return presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    path: `${root}/examples/${preset.id}`,
  }));
}

/**
 * The generated `_config.showcase.yml` for one build.
 *
 * `url` rides along because the examples are built from a scratch tree whose
 * `_config.yml` has none; `baseurl` does not — it is passed on the Jekyll
 * command line, where it also has to be right for `--destination`.
 *
 * @param {{role: 'landing'|'example', example?: string, root: string,
 *          url?: string, examples: object[]}} options
 * @returns {object} the object written as YAML.
 */
export function showcaseOverride({ role, example, root, url = '', examples }) {
  const showcase = { role };
  if (role === 'example') showcase.example = example;
  showcase.root = root;
  showcase.examples = examples;
  return { url: String(url ?? ''), showcase };
}

/**
 * `_data/showcase_presets.json`: what choosing each preset in the wizard
 * actually configures, read off the wizard's own preset objects so the landing
 * cannot drift from what step 1 gives you.
 *
 * @param {{id: string, name: string, description: string, config: object}[]} presets
 * @param {string} root normalized baseurl of the landing build.
 * @returns {object[]}
 */
export function presetFacts(presets, root) {
  return presets.map((preset) => {
    const site = preset.config?.site ?? {};
    const schema = preset.config?.schema ?? {};
    const colors = preset.config?.theme?.colors ?? {};
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    const modules = site.modules ?? {};
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      modules: Object.keys(modules).filter((key) => modules[key] === true),
      field_count: fields.length,
      facet_count: fields.filter((field) => field.facet === true).length,
      entry_singular: schema.entry?.singular ?? '',
      entry_plural: schema.entry?.plural ?? '',
      theme: {
        primary: colors.primary ?? '',
        secondary: colors.secondary ?? '',
        accent: colors.accent ?? '',
      },
      path: `${root}/examples/${preset.id}`,
    };
  });
}

/**
 * The preset this repository is already configured as — the one example that
 * keeps the live submission loop, and the only one built from the working tree
 * rather than from a wizard overlay. Matched on the site name rather than a
 * written-down id, so renaming the shipped preset cannot silently make two
 * examples (or none) the flagship.
 *
 * @param {{id: string, config: object}[]} presets
 * @param {string} siteName `_data/site.yml` → `name` in the working tree.
 * @returns {string|null} the preset id, or null when nothing matches.
 */
export function flagshipId(presets, siteName) {
  const name = String(siteName ?? '').trim();
  if (name === '') return null;
  const match = presets.find((preset) => String(preset.config?.site?.name ?? '').trim() === name);
  return match ? match.id : null;
}

/* -------------------------------------------------------------------------- */

/** The wizard's presets, loaded from the working tree the way setup.mjs does. */
export async function loadPresets(root = ROOT) {
  const module = await import(pathToFileURL(path.join(root, 'assets/js/configurator/presets.js')).href);
  return module.presets;
}

/** Preconditions a showcase build needs, as `{ok, reason}`. */
export function preflight(root = ROOT) {
  if (!fs.existsSync(path.join(root, 'assets', 'css', 'site.css'))) {
    return { ok: false, reason: 'assets/css/site.css is missing — run `npm run build:css` first.' };
  }
  if (!run('bundle', ['--version']).ok) {
    return { ok: false, reason: 'bundler is not on PATH — install Ruby 3.3+ and run `bundle install`.' };
  }
  const site = readYaml(path.join(root, '_data', 'site.yml'));
  if (site.demo !== true) {
    return {
      ok: false,
      reason:
        'this catalog is not demo content (`demo: false` in _data/site.yml) — the showcase only builds for the template itself.',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * A fresh scratch copy of the working tree.
 * @param {string} dir where to put it.
 */
function scratchCopy(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  copyTree(ROOT, dir);
  // Symlinked rather than copied, as in build_variants: 79 MB a tree, and only
  // the Node scripts read it (`_config.yml` excludes it from the build).
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
}

/**
 * Drop this repository's own sample content from a scratch tree, so an example
 * shows its own or nothing — never a cohort of a program it has no page for.
 * @param {string} dir the scratch tree.
 */
function clearSampleContent(dir) {
  removeEntries(dir);
  fs.rmSync(path.join(dir, '_data', 'cohorts'), { recursive: true, force: true });
  const cohortPages = path.join(dir, 'cohorts');
  if (fs.existsSync(cohortPages)) {
    for (const item of fs.readdirSync(cohortPages, { withFileTypes: true })) {
      if (item.isDirectory()) fs.rmSync(path.join(cohortPages, item.name), { recursive: true, force: true });
    }
  }
  for (const name of EMPTIED_DATA) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.writeFileSync(file, emptiedYaml(fs.readFileSync(file, 'utf8')), 'utf8');
  }
}

/**
 * Force the demo banner on and point it at the starter site, and (on every
 * example but the flagship) blank the repository so the submit form cannot
 * open an issue whose fields this repository's workflows would misread.
 *
 * @param {string} dir the scratch tree.
 * @param {{starterUrl: string, blankRepository: boolean}} options
 */
function patchSite(dir, { starterUrl, blankRepository }) {
  const file = path.join(dir, '_data', 'site.yml');
  const site = readYaml(file);
  site.demo = true;
  site.demo_starter_url = starterUrl;
  if (blankRepository) site.github = { ...(site.github ?? {}), repository: '' };
  writeYaml(file, site);
}

/**
 * Build one example: a complete site for one preset.
 *
 * @param {object} options
 * @param {object} options.preset the preset object from presets.js.
 * @param {boolean} options.flagship whether this is the shipped configuration.
 * @param {string} options.dir the scratch tree to build in.
 * @param {string} options.destination absolute path to build into.
 * @param {string} options.root normalized baseurl of the landing.
 * @param {string} options.url site url.
 * @param {object[]} options.examples `site.showcase.examples`.
 * @param {object[]} options.facts `_data/showcase_presets.json`.
 * @param {string} options.starterUrl `demo_starter_url` from the working tree.
 * @param {(message: string) => void} options.log
 * @returns {{id: string, role: string, dir: string, siteDir: string, steps: object[], ok: boolean}}
 */
function buildExample({
  preset,
  flagship,
  dir,
  destination,
  root,
  url,
  examples,
  facts,
  starterUrl,
  log = () => {},
}) {
  const steps = [];
  const step = (name, result) => {
    steps.push({ name, ok: result.ok, output: result.output ?? '' });
    log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${preset.id} · ${name}`);
    return result.ok;
  };
  const done = () => ({
    id: preset.id,
    role: 'example',
    dir,
    siteDir: destination,
    steps,
    ok: steps.every((s) => s.ok),
  });

  log(`\n${preset.id} — ${flagship ? 'the shipped configuration' : preset.name}`);
  scratchCopy(dir);

  // The flagship *is* the working tree: overlaying its own preset would only
  // rewrite the files it was compiled from, losing their comments for nothing.
  if (!flagship) {
    // Run from ROOT: setup.mjs resolves assets/js/configurator/core.js relative
    // to the working directory, and `--out` implies `--yes`.
    const overlay = run(process.execPath, ['scripts/setup.mjs', '--preset', preset.id, '--out', dir], {
      cwd: ROOT,
    });
    if (!step(`setup --preset ${preset.id}`, overlay)) return done();

    clearSampleContent(dir);
    const content = path.join(ROOT, SHOWCASE_CONTENT, preset.id);
    if (fs.existsSync(content)) {
      copyTree(content, dir);
      step(`content from ${SHOWCASE_CONTENT}/${preset.id}`, { ok: true, output: '' });
    } else {
      // A preset with no authored content (a new preset before its examples are
      // written) still has to be a working catalog, so it gets the same
      // generated fixtures the preset build matrix uses.
      seedFixtureEntries(dir, { count: 3, force: true });
      step('content from generated fixtures', { ok: true, output: '' });
    }
  }

  fs.writeFileSync(
    path.join(dir, '_data', 'showcase_presets.json'),
    `${JSON.stringify(facts, null, 2)}\n`,
    'utf8'
  );
  patchSite(dir, { starterUrl, blankRepository: !flagship });

  const baseurl = `${root}/examples/${preset.id}`;
  fs.writeFileSync(
    path.join(dir, '_config.showcase.yml'),
    showcaseYaml(showcaseOverride({ role: 'example', example: preset.id, root, url, examples })),
    'utf8'
  );

  // The issue template and the wizard defaults are derived from _data; an
  // example that skipped this would ship a form for another preset's schema.
  // Each step only runs when the one before it passed: a failed generate would
  // otherwise be followed by a validator and a full build of a half-written tree.
  if (
    step('generate', run(process.execPath, [path.join(dir, 'scripts', 'generate.mjs')], { cwd: dir })) &&
    step('check_front_matter', run('ruby', [path.join('scripts', 'check_front_matter.rb')], { cwd: dir }))
  ) {
    step('jekyll build', jekyll(dir, destination, baseurl));
  }

  return done();
}

/**
 * Does a header or footer link survive on the landing page? External links do;
 * internal ones only when the landing actually ships that page — everything
 * else 404s, and a broken nav is the first thing a visitor meets.
 *
 * @param {string} url a `url:` from `_data/navigation.yml` or `footer.links`.
 * @returns {boolean}
 */
export function keepsLandingLink(url) {
  const href = String(url ?? '');
  return href.includes('://') || LANDING_PAGES.includes(href);
}

/**
 * Every module switched off, including one the site's `modules:` block does
 * not name: a module with no key is on (`_plugins/modules.rb`), so a
 * `site.yml` written before a module existed would keep linking to its page.
 *
 * @param {Record<string, unknown> | undefined} siteModules the site's `modules:` block.
 * @param {string[]} known every module `_data/modules.yml` declares.
 * @returns {Record<string, false>}
 */
export function landingModules(siteModules, known) {
  const keys = new Set([...Object.keys(siteModules ?? {}), ...known]);
  return Object.fromEntries([...keys].map((key) => [key, false]));
}

/**
 * Point the shipped header and footer at the pages the landing has. Both read
 * `_data`, so this is a data edit on the scratch tree rather than a template
 * branch: the catalog, submit and governance pages are not in this build, and a
 * header linking to three 404s is the first thing a visitor would meet.
 *
 * Every module is switched off for the same reason — the module flags are what
 * the chrome tests for its own links (the accessibility statement, the feed) —
 * and then the two link lists are filtered for the pages that are left.
 *
 * @param {string} dir the landing's scratch tree.
 * @returns {{title: string, tagline: string, lead: string}} the landing's own
 *   name for itself, for the `_config` the build runs with.
 */
function landingChrome(dir) {
  const navFile = path.join(dir, '_data', 'navigation.yml');
  const nav = readYaml(navFile);
  if (Array.isArray(nav))
    writeYaml(
      navFile,
      nav.filter((item) => keepsLandingLink(item?.url))
    );

  const siteFile = path.join(dir, '_data', 'site.yml');
  const site = readYaml(siteFile);
  site.modules = landingModules(
    site.modules,
    Object.keys(readYaml(path.join(dir, '_data', 'modules.yml')) ?? {})
  );
  const links = site.footer?.links;
  if (Array.isArray(links)) site.footer.links = links.filter((link) => keepsLandingLink(link?.url));

  // No demo strip: the landing is the template introducing itself, not a
  // catalog full of sample entries, and "everything on this site is sample
  // data" would be the first thing a visitor read. The examples still carry it
  // (as the switcher) — patchSite turns it back on for each of them.
  site.demo = false;

  // The landing is the template introducing itself, not the shipped catalog:
  // the browser tab, the header, the meta description and the footer blurb say
  // what the page says. Taken from the landing's own copy
  // (`_data/showcase.yml`) so there is one place to edit it.
  const copy = readYaml(path.join(dir, '_data', 'showcase.yml'));
  const title = String(copy.title ?? '').trim();
  const tagline = String(copy.tagline ?? '').trim();
  const lead = String(copy.lead ?? '').trim();
  if (title !== '') site.name = title;
  if (tagline !== '') site.tagline = tagline;
  if (lead !== '') site.description = lead;
  if (lead !== '') site.footer = { ...(site.footer ?? {}), about: lead };

  writeYaml(siteFile, site);
  retitleLanding(dir, title);
  return { title, tagline, lead };
}

/**
 * Give the landing's `index.md` its own front-matter title in the scratch tree.
 *
 * `_includes/head.html` already prints the site name alone at `/`, so the
 * browser tab is right without this; jekyll-seo-tag is not — it reads `og:title`
 * off the page, and index.md's title is "Home", the shipped home page's name for
 * itself. A card shared from the landing would say "Home". Edited in the scratch
 * copy only: the repository's index.md is the home page of every other build.
 *
 * @param {string} dir the landing's scratch tree.
 * @param {string} title the landing's title, from `_data/showcase.yml`.
 * @returns {void}
 */
function retitleLanding(dir, title) {
  if (title === '') return;
  const file = path.join(dir, 'index.md');
  const source = fs.readFileSync(file, 'utf8');
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) return;
  fs.writeFileSync(
    file,
    source.replace(front[1], front[1].replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`)),
    'utf8'
  );
}

/**
 * Build the landing page: this repository built with `showcase.role: landing`,
 * which `_plugins/showcase.rb` reduces to `/`, `/setup/` and `/404.html`.
 *
 * @param {object} options same shape as {@link buildExample}, without a preset.
 * @returns {{id: string, role: string, dir: string, siteDir: string, steps: object[], ok: boolean}}
 */
function buildLanding({ dir, destination, root, url, examples, facts, log = () => {} }) {
  const steps = [];
  const step = (name, result) => {
    steps.push({ name, ok: result.ok, output: result.output ?? '' });
    log(`  ${result.ok ? 'ok  ' : 'FAIL'} landing · ${name}`);
    return result.ok;
  };

  log('\nlanding — what the template is, and the way into each example');
  scratchCopy(dir);
  const copy = landingChrome(dir);

  // Jekyll aborts on a missing include with a message that names the layout,
  // not the file; say plainly what is missing before it gets that far.
  if (!fs.existsSync(path.join(dir, LANDING_INCLUDE))) {
    throw new Error(`${LANDING_INCLUDE} is missing — the landing page cannot be built without it.`);
  }

  fs.writeFileSync(
    path.join(dir, '_data', 'showcase_presets.json'),
    `${JSON.stringify(facts, null, 2)}\n`,
    'utf8'
  );
  // `title` and `description` are jekyll-seo-tag's, so the shared link and the
  // search result say what the landing is rather than what the shipped catalog
  // is; `_data/site.yml` (patched above) is what the page itself reads.
  const config = showcaseOverride({ role: 'landing', root, url, examples });
  if (copy.title !== '') config.title = copy.title;
  if (copy.lead !== '') config.description = copy.lead;
  fs.writeFileSync(path.join(dir, '_config.showcase.yml'), showcaseYaml(config), 'utf8');

  step('jekyll build', jekyll(dir, destination, root));

  return { id: 'landing', role: 'landing', dir, siteDir: destination, steps, ok: steps.every((s) => s.ok) };
}

/** The generated override, as the YAML written to `_config.showcase.yml`. */
function showcaseYaml(override) {
  const header = '# Generated by scripts/build_showcase.mjs for one build. Never committed.\n';
  return header + yaml.dump(override, { lineWidth: 100, noRefs: true });
}

/** One `jekyll build` of a scratch tree. */
function jekyll(dir, destination, baseurl) {
  return run(
    'bundle',
    [
      'exec',
      'jekyll',
      'build',
      '--config',
      '_config.yml,_config.showcase.yml',
      '--destination',
      destination,
      '--baseurl',
      baseurl,
      '--strict_front_matter',
      '--quiet',
    ],
    {
      cwd: dir,
      env: { ...process.env, JEKYLL_ENV: 'production', BUNDLE_GEMFILE: path.join(dir, 'Gemfile') },
    }
  );
}

/**
 * Build the landing and every example into `destination`.
 *
 * The landing is built first and on its own: Jekyll cleans its destination of
 * anything it did not produce, so the examples have to be written into it
 * afterwards.
 *
 * @param {{destination?: string, url?: string, baseurl?: string, ids?: string[],
 *          scratchRoot?: string, log?: (message: string) => void}} [options]
 * @returns {Promise<{results: object[], root: string, destination: string, examples: object[]}>}
 */
export async function buildShowcase({
  destination = '_site',
  url = '',
  baseurl = '',
  ids = [],
  scratchRoot,
  log = () => {},
} = {}) {
  const presets = await loadPresets();
  const unknown = ids.filter((id) => !presets.some((preset) => preset.id === id));
  if (unknown.length) throw new Error(`no such preset: ${unknown.join(', ')}`);

  const root = normalizeRoot(baseurl);
  const target = path.resolve(ROOT, destination);
  const scratch = scratchRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-showcase-'));
  const site = readYaml(path.join(ROOT, '_data', 'site.yml'));
  const starterUrl = String(site.demo_starter_url ?? '');
  const flagship = flagshipId(presets, site.name);

  const examples = showcaseExamples(presets, root);
  const facts = presetFacts(presets, root);
  const shared = { root, url, examples, facts, log };

  const results = [buildLanding({ dir: path.join(scratch, 'landing'), destination: target, ...shared })];
  for (const preset of presets) {
    if (ids.length && !ids.includes(preset.id)) continue;
    results.push(
      buildExample({
        preset,
        flagship: preset.id === flagship,
        dir: path.join(scratch, 'examples', preset.id),
        destination: path.join(target, 'examples', preset.id),
        starterUrl,
        ...shared,
      })
    );
  }

  return { results, root, destination: target, examples, scratchRoot: scratch };
}

/* -------------------------------------------------------------------------- */

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  /** `--flag value`, with the rest positional. */
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const flags = new Set(['--destination', '--url', '--baseurl']);
  const ids = argv.filter((arg, index) => !arg.startsWith('--') && !flags.has(argv[index - 1] ?? ''));

  const ready = preflight();
  if (!ready.ok) {
    console.error(`STOP  ${ready.reason}`);
    process.exit(1);
  }

  const keep = argv.includes('--keep');
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-showcase-'));
  const { results, destination } = await buildShowcase({
    destination: value('--destination', '_site'),
    url: value('--url', ''),
    baseurl: value('--baseurl', ''),
    ids,
    scratchRoot,
    log: (message) => console.log(message),
  });

  console.log('');
  for (const result of results.filter((r) => !r.ok)) {
    for (const failed of result.steps.filter((s) => !s.ok)) {
      console.error(`\n--- ${result.id} · ${failed.name} ---\n${failed.output.trim()}`);
    }
  }
  const failures = results.filter((r) => !r.ok).length;
  console.log(
    keep
      ? `\nScratch trees kept in ${scratchRoot}`
      : `\n${results.length - failures}/${results.length} builds into ${destination}.`
  );
  if (!keep) fs.rmSync(scratchRoot, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
