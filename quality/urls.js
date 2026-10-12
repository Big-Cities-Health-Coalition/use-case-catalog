/**
 * URL lists for the quality gate (`quality/pa11yci.js`, `quality/lighthouserc.js`).
 *
 * The gate audits real entry pages, but which entries exist depends on the
 * deployment — `npm run setup` deletes the shipped samples — so the URLs are
 * discovered from the built site instead of being written into the configs.
 * Two entries are chosen: one with a screenshot gallery (the field whose type
 * is `images` is set) and one without, so both card/entry variants are covered.
 * With no entries yet, only the static pages are audited and CI stays green.
 *
 * CommonJS on purpose (see ./package.json): both tools `require()` their configs.
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

/** The `entry.path` from `_data/schema.yml` (`catalog` when unset). */
function entryPath() {
  try {
    const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
    return String(schema?.entry?.path || 'catalog').replace(/^\/+|\/+$/g, '');
  } catch {
    return 'catalog';
  }
}

/** Key of the first schema field of type `images`, or null. */
function imagesKey() {
  try {
    const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
    return (schema?.fields || []).find((f) => f && f.type === 'images')?.key ?? null;
  } catch {
    return null;
  }
}

/** Front matter of `<dir>/index.md` as an object ({} when unreadable). */
function frontMatter(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return match ? yaml.load(match[1]) || {} : {};
  } catch {
    return {};
  }
}

/**
 * Site-relative paths of the entry pages to audit: the first entry with images
 * and the first without (alphabetical), each only if it exists.
 * @param {string} [root] repo root (tests pass a fixture).
 * @returns {string[]} e.g. `['/catalog/permit-intake-triage/', '/catalog/council-meeting-summaries/']`.
 */
function sampleEntryPaths(root = ROOT) {
  const dir = path.join(root, entryPath());
  if (!fs.existsSync(dir)) return [];
  const key = imagesKey();
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'index.md')))
    .map((d) => d.name)
    .sort();
  const hasImages = (slug) => {
    const value = key ? frontMatter(path.join(dir, slug, 'index.md'))[key] : null;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  };
  const withImages = slugs.find(hasImages);
  const without = slugs.find((slug) => !hasImages(slug));
  return [withImages, without].filter(Boolean).map((slug) => `/${entryPath()}/${slug}/`);
}

/**
 * Whether `_data/site.yml` has the module switched on (off when unreadable).
 * `absent` is the answer when site.yml has no key for the module: `false` for
 * the modules every site.yml has always listed, `true` for one added later that
 * `_plugins/modules.rb` builds unless it is explicitly `false` (`status`).
 */
function moduleOn(name, absent = false) {
  try {
    const site = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'site.yml'), 'utf8'));
    const value = site?.modules?.[name];
    return value === undefined || value === null ? absent : Boolean(value);
  } catch {
    return false;
  }
}

/**
 * Absolute URLs for the gate: the static pages plus the sample entries.
 * `governance` is null when that module is off — `_plugins/modules.rb` drops
 * the page, so auditing it would only find a 404. `compare` belongs to the
 * catalog module and is gated the same way; `atoz` additionally needs entries,
 * because `_plugins/facet_pages.rb` skips the A–Z directory of an empty
 * catalog (the state a fresh `npm run setup` leaves behind). `status` is null
 * only when the status module is switched off; a site.yml with no `status` key
 * still builds the page.
 * @param {string} base e.g. `http://127.0.0.1:4173`.
 * @returns {{ home: string, catalog: string, submit: string, governance: string|null, compare: string|null, atoz: string|null, status: string|null, notFound: string, entries: string[] }}
 */
function qualityUrls(base) {
  const at = (p) => `${base.replace(/\/$/, '')}${p}`;
  const entries = sampleEntryPaths();
  return {
    home: at('/'),
    catalog: at(`/${entryPath()}/`),
    submit: at('/submit/'),
    governance: moduleOn('governance') ? at('/governance/') : null,
    compare: moduleOn('catalog') ? at('/compare/') : null,
    atoz: moduleOn('catalog') && entries.length > 0 ? at(`/${entryPath()}/a-z/`) : null,
    status: moduleOn('status', true) ? at('/status/') : null,
    notFound: at('/404.html'),
    entries: entries.map(at),
  };
}

/**
 * The pages of a showcase build (`scripts/build_showcase.mjs`), which the
 * single build the gate serves does not contain: the landing, and for every
 * example in the build its home page and one entry page.
 *
 * Discovered from the built tree rather than written down, so which examples
 * were built is quality.yml's decision alone and no preset id lives here. Each
 * example's `entries.json` carries its own entry URLs, which is also how this
 * stays right for a preset whose `entry.path` is not `catalog`.
 *
 * Empty unless the showcase was built — a fork's gate never has one, and
 * neither does `npm run a11y` unless you point it at one:
 *
 *   QUALITY_SHOWCASE_DIR=/tmp/showcase \
 *   QUALITY_SHOWCASE_BASE_URL=http://127.0.0.1:4174 npm run a11y
 *
 * @param {string} base the URL the showcase build is served at.
 * @param {string} [dir] the built tree (defaults to `$QUALITY_SHOWCASE_DIR`).
 * @returns {string[]}
 */
function showcaseUrls(base, dir = process.env.QUALITY_SHOWCASE_DIR || '') {
  if (!base || !dir) return [];
  const root = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(path.join(root, 'index.html'))) return [];

  const at = (p) => `${base.replace(/\/$/, '')}${p}`;
  const urls = [at('/')];
  const examples = path.join(root, 'examples');
  if (!fs.existsSync(examples)) return urls;

  for (const id of fs.readdirSync(examples).sort()) {
    if (!fs.existsSync(path.join(examples, id, 'index.html'))) continue;
    urls.push(at(`/examples/${id}/`));
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(examples, id, 'entries.json'), 'utf8'));
      const first = (manifest.entries || [])[0];
      if (first && first.url) urls.push(at(first.url));
    } catch {
      // An example with no catalog publishes no manifest; its home page is enough.
    }
  }
  return urls;
}

module.exports = { entryPath, sampleEntryPaths, qualityUrls, showcaseUrls };
