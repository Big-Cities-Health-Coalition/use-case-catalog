/**
 * The showcase: the landing page and one full live site per preset, as
 * scripts/build_showcase.mjs assembles them (docs/showcase-plan.md).
 *
 * The pure half — the shapes the builder writes into `_config.showcase.yml` and
 * `_data/showcase_presets.json`, which the landing and the example switcher are
 * built against — runs everywhere. The five Jekyll builds are skipped unless
 * RUN_BUILD_TESTS=1 (`npm run test:build`), for the reason given in
 * test/build/variants.test.mjs.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import * as yaml from 'js-yaml';

import {
  ROOT,
  buildShowcase,
  keepsLandingLink,
  landingModules,
  loadPresets,
  normalizeRoot,
  preflight,
  presetFacts,
  showcaseExamples,
  showcaseOverride,
} from '../../scripts/build_showcase.mjs';

const presets = await loadPresets();

/* ------------------------------------------------------- the emitted shapes */

test('the landing switches off every module, including one site.yml does not name', () => {
  assert.deepEqual(landingModules({ events: true }, ['events', 'status']), { events: false, status: false });
  assert.deepEqual(landingModules(undefined, ['status']), { status: false });
});

test('normalizeRoot turns a baseurl into the prefix every showcase path is built on', () => {
  assert.equal(normalizeRoot(''), '');
  assert.equal(normalizeRoot('/'), '');
  assert.equal(normalizeRoot('/phct'), '/phct');
  assert.equal(normalizeRoot('phct/'), '/phct');
  assert.equal(normalizeRoot(undefined), '');
});

test('site.showcase is the shape the landing and the switcher read', () => {
  const examples = showcaseExamples(presets, '/phct');
  assert.deepEqual(examples[0], {
    id: presets[0].id,
    name: presets[0].name,
    path: `/phct/examples/${presets[0].id}`,
  });
  assert.equal(examples.length, presets.length, 'every preset is an example');

  const landing = showcaseOverride({
    role: 'landing',
    root: '/phct',
    url: 'https://x.test',
    examples,
  });
  assert.deepEqual(Object.keys(landing), ['url', 'showcase']);
  assert.deepEqual(Object.keys(landing.showcase), ['role', 'root', 'examples']);
  assert.equal(landing.showcase.role, 'landing');
  assert.equal(landing.url, 'https://x.test');

  const example = showcaseOverride({ role: 'example', example: 'blank', root: '', examples });
  assert.deepEqual(Object.keys(example.showcase), ['role', 'example', 'root', 'examples']);
  assert.equal(example.showcase.example, 'blank');
  assert.equal(example.showcase.root, '', 'a site served from the domain root has an empty root');
  assert.equal(example.url, '');
});

test('_data/showcase_presets.json says what choosing each preset configures', () => {
  const facts = presetFacts(presets, '');
  assert.equal(facts.length, presets.length);
  for (const [index, fact] of facts.entries()) {
    const preset = presets[index];
    assert.deepEqual(Object.keys(fact), [
      'id',
      'name',
      'description',
      'modules',
      'field_count',
      'facet_count',
      'entry_singular',
      'entry_plural',
      'theme',
      'path',
    ]);
    assert.equal(fact.id, preset.id);
    assert.equal(fact.name, preset.name);
    assert.equal(fact.description, preset.description);
    assert.equal(fact.path, `/examples/${preset.id}`);
    assert.deepEqual(Object.keys(fact.theme), ['primary', 'secondary', 'accent']);
    assert.match(fact.theme.primary, /^#/, 'the landing swatches read this');

    // Counted off the preset's own schema, never written down here.
    const fields = preset.config.schema.fields;
    assert.equal(fact.field_count, fields.length);
    assert.equal(fact.facet_count, fields.filter((field) => field.facet === true).length);
    assert.ok(fact.facet_count <= fact.field_count);
    assert.equal(fact.entry_singular, preset.config.schema.entry.singular);
    assert.equal(fact.entry_plural, preset.config.schema.entry.plural);

    // Only the modules the preset switches on, so the landing can list them.
    const on = Object.entries(preset.config.site.modules)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    assert.deepEqual(fact.modules, on);
  }
});

test('the landing chrome keeps external links and the pages the landing has', () => {
  assert.equal(keepsLandingLink('/'), true);
  assert.equal(keepsLandingLink('/setup/'), true);
  assert.equal(keepsLandingLink('https://example.org/'), true);
  assert.equal(keepsLandingLink('/catalog/'), false, 'the landing does not build the catalog');
  assert.equal(keepsLandingLink('/submit/'), false);
  assert.equal(keepsLandingLink(undefined), false);
});

/* ------------------------------------------------------------ the built site */

const ENABLED = process.env.RUN_BUILD_TESTS === '1';
const SHOWCASE_CONFIGURED = fs.existsSync(path.join(ROOT, '_data', 'showcase.yml'));
const ready = !ENABLED
  ? { ok: false, reason: 'set RUN_BUILD_TESTS=1 (`npm run test:build`)' }
  : !SHOWCASE_CONFIGURED
    ? { ok: false, reason: 'this downstream does not deploy the PHCT showcase' }
    : preflight();

/** Parsed `<dir>/<page>/index.html`. */
function page(siteDir, urlPath) {
  const file = path.join(siteDir, urlPath, 'index.html');
  assert.ok(fs.existsSync(file), `${urlPath || '/'} was not built`);
  return new JSDOM(fs.readFileSync(file, 'utf8')).window.document;
}

/** Every `href` on a page. */
const hrefs = (document) => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

describe('the showcase', { skip: ready.ok ? false : ready.reason, concurrency: false }, () => {
  /** @type {Awaited<ReturnType<typeof buildShowcase>>} */
  let built;
  let scratchRoot = '';
  let out = '';

  before(
    async () => {
      if (!ready.ok) return;
      scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-showcase-'));
      out = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-showcase-out-'));
      built = await buildShowcase({ destination: out, scratchRoot });
    },
    { timeout: 15 * 60 * 1000 }
  );

  after(() => {
    if (!process.env.KEEP_BUILD_SHOWCASE) {
      for (const dir of [scratchRoot, out]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every step of every build succeeds', () => {
    const failed = built.results.flatMap((result) =>
      result.steps.filter((step) => !step.ok).map((step) => ({ ...step, id: result.id }))
    );
    assert.deepEqual(
      failed.map((step) => `${step.id} · ${step.name}`),
      [],
      failed.map((step) => `\n--- ${step.id} · ${step.name} ---\n${step.output.trim()}`).join('\n')
    );
    assert.equal(built.results.length, presets.length + 1, 'the landing plus one build per preset');
  });

  test('the landing is the landing: the home page, /setup/ and 404, and nothing else', () => {
    const landing = built.results.find((result) => result.role === 'landing');
    assert.ok(page(landing.siteDir, '').querySelector('h1'), 'the landing has no heading');
    assert.ok(fs.existsSync(path.join(landing.siteDir, 'setup', 'index.html')), '/setup/ is the way in');
    assert.ok(fs.existsSync(path.join(landing.siteDir, '404.html')));
    for (const dropped of ['catalog', 'submit', 'governance', 'about']) {
      assert.equal(
        fs.existsSync(path.join(landing.siteDir, dropped, 'index.html')),
        false,
        `/${dropped}/ was built into the landing`
      );
    }
    // _plugins/showcase.rb returns before the generators that index a catalog
    // the landing does not have.
    assert.equal(fs.existsSync(path.join(landing.siteDir, 'search.json')), false);
    assert.equal(fs.existsSync(path.join(landing.siteDir, 'catalog', 'feed.xml')), false);
  });

  test('nothing on the landing links to a page the landing does not build', () => {
    const landing = built.results.find((result) => result.role === 'landing');
    const document = page(landing.siteDir, '');
    const broken = hrefs(document)
      .filter((href) => href.startsWith('/') && !href.startsWith('//'))
      .filter((href) => !href.startsWith('/examples/') && !href.startsWith('/assets/'))
      .filter((href) => {
        const url = href.split('#')[0];
        if (url === '' || url === '/') return false;
        const target = path.join(landing.siteDir, url);
        return !fs.existsSync(target) && !fs.existsSync(path.join(target, 'index.html'));
      });
    assert.deepEqual(broken, [], 'the header, footer or landing copy links to a 404');
  });

  test('the landing carries the facts the examples are described with', () => {
    const landing = built.results.find((result) => result.role === 'landing');
    const facts = JSON.parse(
      fs.readFileSync(path.join(landing.dir, '_data', 'showcase_presets.json'), 'utf8')
    );
    assert.deepEqual(facts, presetFacts(presets, built.root));

    const config = yaml.load(fs.readFileSync(path.join(landing.dir, '_config.showcase.yml'), 'utf8'));
    assert.deepEqual(config.showcase.examples, built.examples);
    assert.equal(config.showcase.role, 'landing');
    assert.equal(config.showcase.example, undefined, 'the landing is not an example');
  });

  test('the landing is named by its own copy, not by the catalog this repository ships', () => {
    const copyFile = path.join(ROOT, '_data', 'showcase.yml');
    const copy = yaml.load(fs.readFileSync(copyFile, 'utf8'));
    const landing = built.results.find((result) => result.role === 'landing');

    const site = yaml.load(fs.readFileSync(path.join(landing.dir, '_data', 'site.yml'), 'utf8'));
    assert.equal(site.name, copy.title, 'the header and the tab still name the shipped catalog');
    assert.equal(
      Object.values(site.modules).some(Boolean),
      false,
      'a module left on gives the chrome a link to a page the landing does not build'
    );

    const document = page(landing.siteDir, '');
    assert.equal(document.querySelector('title').textContent, copy.title);
    // head.html truncates at 200 characters, so this is the opening of the
    // landing's own lead rather than the whole of it.
    const description = document.querySelector('meta[name="description"]').getAttribute('content');
    assert.ok(
      copy.lead.startsWith(description.replace(/\.\.\.$/, '')),
      `the shared link and the search result describe the shipped catalog: ${description}`
    );
  });

  for (const preset of presets) {
    describe(preset.id, () => {
      const result = () => built.results.find((r) => r.id === preset.id);

      test('is a whole site: a home page, a catalog with entries, search and /setup/', () => {
        const { dir, siteDir } = result();
        const schema = yaml.load(fs.readFileSync(path.join(dir, '_data', 'schema.yml'), 'utf8'));
        assert.ok(page(siteDir, '').querySelector('h1'));
        assert.ok(fs.existsSync(path.join(siteDir, 'setup', 'index.html')), 'the way to configure your own');
        const entryPath = schema.entry.path;
        const slugs = fs
          .readdirSync(path.join(siteDir, entryPath), { withFileTypes: true })
          .filter(
            (item) =>
              item.isDirectory() && fs.existsSync(path.join(siteDir, entryPath, item.name, 'index.html'))
          );
        assert.ok(slugs.length > 0, `${preset.id} has no entries — an empty example demonstrates nothing`);
        const index = JSON.parse(fs.readFileSync(path.join(siteDir, 'search.json'), 'utf8'));
        assert.ok(index.docs.length > 0, 'search.json is empty');
      });

      test('the demo banner is the switcher, and it names every other example', () => {
        const { siteDir } = result();
        const document = page(siteDir, '');
        const switcher = document.querySelector('[data-component="example-switcher"]');
        assert.ok(switcher, 'the example switcher is not on the page');
        assert.equal(switcher.tagName, 'DETAILS', 'it must work with JavaScript blocked');
        assert.match(
          switcher.querySelector('summary').textContent.replace(/\s+/g, ' '),
          new RegExp(`Example: ${preset.name}`)
        );
        assert.match(
          document.querySelector('[data-component="demo-banner"]').textContent.replace(/\s+/g, ' '),
          /Everything on this site is sample data/
        );

        const menu = [...switcher.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
        for (const example of built.examples) {
          if (example.id === preset.id) {
            assert.ok(!menu.includes(`${example.path}/`), 'the switcher offers the example you are on');
            continue;
          }
          assert.ok(menu.includes(`${example.path}/`), `the switcher does not offer ${example.id}`);
        }
        assert.ok(menu.includes(`${built.root}/#example-${preset.id}`), 'no "How this one is configured"');
        assert.ok(menu.includes(`${built.root}/`), 'no way back to the landing');
        // This example's own wizard, so `relative_url` carries its baseurl.
        assert.ok(
          menu.includes(`${built.root}/examples/${preset.id}/setup/`),
          'no way to configure your own'
        );
      });

      test('_config.showcase.yml names this example and every other one', () => {
        const config = yaml.load(fs.readFileSync(path.join(result().dir, '_config.showcase.yml'), 'utf8'));
        assert.equal(config.showcase.role, 'example');
        assert.equal(config.showcase.example, preset.id);
        assert.equal(config.showcase.root, built.root);
        assert.deepEqual(config.showcase.examples, built.examples);
      });
    });
  }

  test('only the flagship example can open an issue on the template repository', () => {
    const repository = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'site.yml'), 'utf8')).github
      .repository;
    assert.ok(repository, 'precondition: the working tree names a repository');
    const flagship = built.results.filter(
      (result) =>
        result.role === 'example' &&
        yaml.load(fs.readFileSync(path.join(result.dir, '_data', 'site.yml'), 'utf8')).github?.repository ===
          repository
    );
    assert.equal(flagship.length, 1, 'exactly one example is built from the working tree');

    for (const result of built.results) {
      if (result.role !== 'example' || result === flagship[0]) continue;
      const submit = fs.readFileSync(path.join(result.siteDir, 'submit', 'index.html'), 'utf8');
      assert.ok(
        !submit.includes(`github.com/${repository}`),
        `${result.id} would file its sample submissions on ${repository}`
      );
      // The footer's "Report a problem with the site" link is on every page.
      const home = fs.readFileSync(path.join(result.siteDir, 'index.html'), 'utf8');
      assert.ok(
        !home.includes(`github.com/${repository}/issues/new`),
        `${result.id} would open an issue on ${repository} from its footer`
      );
    }
  });
});
