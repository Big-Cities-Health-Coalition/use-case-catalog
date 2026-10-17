/**
 * The entry scaffolder's review-status default (scripts/new_entry_from_issue.mjs).
 *
 *   npm test     (node --test)
 *
 * Runs the real script in `--dry-run` mode, which prints the front matter it
 * would write and touches nothing. Two schemas: the repository's own, which
 * names a `status_key`, and a throwaway one that does not — the second is the
 * promise that other presets' front matter is unchanged by the feature.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as yaml from 'js-yaml';

import { formatUploadRef, uploadBranch, uploadFilename } from '../../scripts/lib/upload_refs.mjs';
import { notConfiguredWarning, notFoundWarning } from '../../scripts/lib/uploads.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'new_entry_from_issue.mjs');
const ISSUE_BODY = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'issue-basic.md'), 'utf8');

/**
 * @param {string} cwd checkout to run in
 * @returns {string} the dry run's stdout
 */
function dryRunOutput(cwd, body = ISSUE_BODY) {
  const result = spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    cwd,
    env: {
      ...process.env,
      ISSUE_BODY: body,
      ISSUE_TITLE: '[Use case] Service request routing',
      ISSUE_NUMBER: '7',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * @param {string} cwd checkout to run in
 * @returns {object} the parsed front matter of the dry run
 */
function dryRun(cwd, body = ISSUE_BODY) {
  const stdout = dryRunOutput(cwd, body);
  const match = stdout.match(/^---\n([\s\S]*?)\n---\n/m);
  assert.ok(match, `no front matter in:\n${stdout}`);
  return yaml.load(match[1]);
}

test('a schema with entry.status_key gets the scaffold value, whatever the issue said', () => {
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  const { status_key: key, status_scaffold_value: start } = schema.entry;
  assert.ok(key && start, 'the repository schema names a status field and a scaffold value');
  const fm = dryRun(ROOT);
  assert.equal(fm[key], start);
});

test('a schema without entry.status_key writes no status at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-status-'));
  fs.mkdirSync(path.join(root, '_data'));
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  delete schema.entry.status_key;
  delete schema.entry.deprecated_value;
  delete schema.entry.status_scaffold_value;
  fs.writeFileSync(path.join(root, '_data', 'schema.yml'), yaml.dump(schema), 'utf8');
  try {
    const fm = dryRun(root);
    // The field is still a schema field, so it is emitted as the (blank) answer
    // the issue carried; what must NOT happen is a default being invented.
    assert.notEqual(fm.review_status, 'Under review');
    assert.equal(fm.title, 'Service request routing assistant');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the pull request checklist flags escalate_on answers and carries the governance criteria', () => {
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  const flagged = schema.fields.filter((field) => Array.isArray(field.escalate_on));
  assert.ok(flagged.length >= 2, 'the repository schema flags at least the attestation and data sensitivity');
  const governance = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'governance.yml'), 'utf8'));
  const criteria = governance.review.criteria;
  assert.ok(criteria.length > 0, 'the governance page publishes review criteria');

  const stdout = dryRunOutput(ROOT);
  const checklist = stdout.slice(stdout.indexOf('# pull request checklist'));
  // The fixture leaves the attestation unticked and lists PHI under "Data it touches".
  assert.match(checklist, /^### Closer review$/m);
  const attestation = schema.fields.find(
    (field) => field.type === 'boolean' && Array.isArray(field.escalate_on)
  );
  assert.match(checklist, new RegExp(`^- \\*\\*${attestation.label}\\*\\*: not confirmed$`, 'm'));
  assert.match(checklist, /^- \*\*Data it touches\*\*: Health information \(PHI\)$/m);
  // The same criteria as /governance/, not a second copy kept in the script.
  for (const { name } of criteria) assert.match(checklist, new RegExp(`^- \\[ \\] \\*\\*${name}\\*\\*`, 'm'));
  const { status_key: key, status_scaffold_value: start, status_approved_value: approved } = schema.entry;
  assert.match(
    checklist,
    new RegExp(`\`${key}\` set to \\*\\*${approved}\\*\\* \\(the scaffold wrote \\*${start}\\*\\)`)
  );
});

test('a schema without escalate_on or a governance file gets a quiet checklist with the generic criteria', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-checklist-'));
  fs.mkdirSync(path.join(root, '_data'));
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  for (const field of schema.fields) delete field.escalate_on;
  fs.writeFileSync(path.join(root, '_data', 'schema.yml'), yaml.dump(schema), 'utf8');
  try {
    const stdout = dryRunOutput(root);
    const checklist = stdout.slice(stdout.indexOf('# pull request checklist'));
    assert.doesNotMatch(checklist, /Closer review/);
    assert.match(checklist, /^- \[ \] \*\*Completeness\*\* — /m);
    assert.match(checklist, /^- \[ \] \*\*Category fit\*\* — /m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file answer that links elsewhere is stored as that link, and a GitHub upload as the entry path', () => {
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  const field = schema.fields.find((f) => f.type === 'file');
  const upload = '[deck.pdf](https://github.com/user-attachments/files/12345678/deck.pdf)';
  assert.ok(ISSUE_BODY.includes(upload), 'the fixture attaches the deck through the upload control');

  // The upload control's own answer still names the file the pull request commits.
  assert.equal(
    dryRun(ROOT)[field.key],
    `/${schema.entry.path}/service-request-routing-assistant/${field.filename}`
  );

  // A file too big for GitHub, pasted as a link to where it actually lives.
  for (const answer of [
    'https://files.example.org/projects/1/deck.pdf',
    '[deck](https://files.example.org/projects/1/deck.pdf)',
  ]) {
    const fm = dryRun(ROOT, ISSUE_BODY.replace(upload, answer));
    assert.equal(fm[field.key], 'https://files.example.org/projects/1/deck.pdf', answer);
  }
});

test('a file link the page could not render is stored with a lower-case scheme, or not at all', () => {
  const schema = yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));
  const field = schema.fields.find((f) => f.type === 'file');
  const upload = '[deck.pdf](https://github.com/user-attachments/files/12345678/deck.pdf)';
  const publicPath = `/${schema.entry.path}/service-request-routing-assistant/${field.filename}`;

  // The page's `http_url` filter and the validator want a lower-case scheme.
  const upper = dryRun(ROOT, ISSUE_BODY.replace(upload, 'HTTPS://drive.example.com/deck.pdf'));
  assert.equal(upper[field.key], 'https://drive.example.com/deck.pdf');

  // An apostrophe would break the page's href, so the link is not stored at all:
  // the field keeps naming the path, and the pull request says why.
  const quoted = "https://drive.example.com/it's-the-deck.pdf";
  const body = ISSUE_BODY.replace(upload, quoted);
  assert.equal(dryRun(ROOT, body)[field.key], publicPath);
  const warnings = dryRunOutput(ROOT, body).split('# warnings')[1] ?? '';
  assert.match(warnings, new RegExp(`\\\`${field.key}\\\`.*could not be used`));
  assert.ok(warnings.includes("it's-the-deck.pdf"), warnings);
});

// Select, multiselect and boolean questions are single-line text inputs on the
// issue form (GitHub prefills nothing else from /submit/'s link), so their
// answers arrive as typed text. The bodies below are built from the schema, in
// GitHub's rendering, so no field key or option is named here.

/** The repository schema, parsed. */
const repoSchema = () => yaml.load(fs.readFileSync(path.join(ROOT, '_data', 'schema.yml'), 'utf8'));

/** The fields the issue form asks of each kind. */
const asked = (schema, type) => schema.fields.filter((field) => field.form !== false && field.type === type);

/**
 * An issue body answering every form question, `### Label` then the answer,
 * with the write-up last (the parser treats everything after it as prose).
 * @param {object} schema
 * @param {(field: object) => string} choice the text typed for a choice question
 * @returns {string}
 */
function bodyFor(schema, choice) {
  const sample = {
    url: 'https://example.org',
    email: 'someone@example.org',
    date: '2026-01-02',
    number: '3',
  };
  const fields = schema.fields.filter((field) => field.form !== false);
  const ordered = [
    ...fields.filter((f) => f.type !== 'markdown'),
    ...fields.filter((f) => f.type === 'markdown'),
  ];
  return ordered
    .map((field) => {
      let answer;
      if (['select', 'multiselect', 'boolean'].includes(field.type)) answer = choice(field);
      else if (['file', 'image', 'images', 'links'].includes(field.type)) answer = '_No response_';
      else answer = sample[field.type] ?? `Value for ${field.key}`;
      return `### ${field.label}\n\n${answer}`;
    })
    .join('\n\n');
}

test('choice answers typed in any case reach the front matter as their exact options', () => {
  const schema = repoSchema();
  const body = bodyFor(schema, (field) =>
    field.type === 'boolean'
      ? 'yes'
      : field.type === 'select'
        ? ` ${String(field.options.at(-1)).toUpperCase()} `
        : field.options
            .slice(0, 2)
            .map((option) => String(option).toLowerCase())
            .join(',')
  );
  const stdout = dryRunOutput(ROOT, body);
  const fm = dryRun(ROOT, body);
  for (const field of asked(schema, 'select')) assert.equal(fm[field.key], field.options.at(-1), field.key);
  for (const field of asked(schema, 'multiselect')) {
    assert.deepEqual(fm[field.key], field.options.slice(0, 2), field.key);
  }
  for (const field of asked(schema, 'boolean')) assert.equal(fm[field.key], true, field.key);
  assert.doesNotMatch(stdout, /Answers to fix/);
});

test('an answer that is not an option is left out of the front matter and listed for the reviewer', () => {
  const schema = repoSchema();
  const select = asked(schema, 'select')[0];
  const multi = asked(schema, 'multiselect')[0];
  assert.ok(select && multi, 'the repository schema asks at least one select and one multiselect');
  const body = bodyFor(schema, (field) => {
    if (field === select) return 'Not a real option';
    if (field === multi) return `${field.options[0]}, Space travel`;
    return field.type === 'boolean' ? 'Yes' : String(field.options[0]);
  });
  // The scaffold still succeeds (dryRunOutput asserts exit 0) …
  const stdout = dryRunOutput(ROOT, body);
  const fm = dryRun(ROOT, body);
  // … writes nothing invalid …
  assert.equal(fm[select.key], '');
  assert.deepEqual(fm[multi.key], [multi.options[0]]);
  // … and tells the reviewer what to put right.
  const checklist = stdout.slice(stdout.indexOf('# pull request checklist'));
  assert.match(checklist, /^### Answers to fix$/m);
  assert.ok(
    checklist.includes(`- [ ] **${select.label}** (\`${select.key}\`): \`Not a real option\``),
    checklist
  );
  assert.ok(checklist.includes(`- [ ] **${multi.label}** (\`${multi.key}\`): \`Space travel\``), checklist);
});

test('an issue in the old dropdown rendering still scaffolds every choice answer', () => {
  // The dropdown form wrote exact option text, comma-joined multi-selects
  // (options may themselves hold commas) and, for checkbox questions, ticked
  // task-list lines. Built from this repository's schema, not a fixture, so a
  // deployment with its own options runs the same check.
  const schema = repoSchema();
  const multis = asked(schema, 'multiselect');
  const ticked = multis[0];
  const body = bodyFor(schema, (field) => {
    if (field.type === 'boolean') return 'Yes';
    if (field.type === 'select') return String(field.options[0]);
    const picks = field.options.slice(0, 2).map(String);
    return field === ticked ? picks.map((o) => `- [X] ${o}`).join('\n') : picks.join(', ');
  });
  const stdout = dryRunOutput(ROOT, body);
  const fm = dryRun(ROOT, body);
  assert.ok(multis.length > 0, 'the repository schema asks at least one multiselect');
  for (const field of asked(schema, 'select')) assert.equal(fm[field.key], field.options[0], field.key);
  for (const field of multis) assert.deepEqual(fm[field.key], field.options.slice(0, 2), field.key);
  for (const field of asked(schema, 'boolean')) assert.equal(fm[field.key], true, field.key);
  assert.doesNotMatch(stdout, /Answers to fix/);
});

test('a file or image question left blank is stored blank, not as a path no file was written to', () => {
  // GitHub writes `_No response_` under an upload control nobody used. The
  // front matter used to name `/<entry path>/<slug>/<filename>` anyway, so the
  // merged entry pointed at a file that never existed.
  const schema = repoSchema();
  const attachments = schema.fields.filter(
    (field) => field.form !== false && (field.type === 'file' || field.type === 'image')
  );
  const file = attachments.find((field) => field.type === 'file');
  assert.ok(file, 'the repository schema asks at least one file question');
  const choice = (field) => (field.type === 'boolean' ? 'Yes' : String(field.options[0]));
  const blank = bodyFor(schema, choice);
  const unanswered = `### ${file.label}\n\n_No response_`;
  assert.ok(blank.includes(unanswered), 'bodyFor answers a file question with _No response_');

  // GitHub's own placeholder, an emptied answer, a note with no link in it,
  // and a body with the question missing altogether.
  for (const body of [
    blank,
    blank.replace(unanswered, `### ${file.label}\n\n`),
    blank.replace(unanswered, `### ${file.label}\n\nWe will send it later.`),
    blank.replace(unanswered, ''),
  ]) {
    const fm = dryRun(ROOT, body);
    for (const field of attachments) assert.equal(fm[field.key], '', field.key);
  }

  // An attachment the upload control did write still names the entry path.
  const slug = dryRun(ROOT, blank).slug;
  const attached = blank.replace(
    unanswered,
    `### ${file.label}\n\n[${file.filename}](https://github.com/user-attachments/files/12345678/${file.filename})`
  );
  assert.equal(dryRun(ROOT, attached)[file.key], `/${schema.entry.path}/${slug}/${file.filename}`);
});

// --- files attached on /submit/ (`upload:` references) ----------------------
// The real script, run end to end (not a dry run) in a throwaway checkout, with
// `fetch` and DNS answered by test/fixtures/scaffold-fetch-stub.mjs: GitHub
// attachment URLs, and a private uploads repository served the way the REST API
// serves a git database. Every request is logged, so the tests can see which
// credential went where.

const STUB = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'scaffold-fetch-stub.mjs')).href;
const UPLOADS_TOKEN = 'ghs_uploadsTokenThatMustNeverLeak0123456789';
const JOB_TOKEN = 'ghs_jobToken';
const UPLOADS_REPO = 'example-org/catalog-uploads';
const AUTHOR_ID = '4242';
const UPLOAD_SET = 'abcdefghijklmnopqrstuvwxyz';
const UPLOADS_ON = { UPLOADS_TOKEN, UPLOADS_REPO, ISSUE_AUTHOR_ID: AUTHOR_ID };
// What the workflow passes when `vars.UPLOADS_REPO` is unset: the token step is
// skipped, so its output is empty, and the author id is always there.
const UPLOADS_OFF = { UPLOADS_TOKEN: '', UPLOADS_REPO: '', ISSUE_AUTHOR_ID: AUTHOR_ID };

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0a]);
const PNG_URL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0b]);
const JPG_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0x0b]);
const JPG_URL = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0x0c]);
const PDF = Buffer.from('%PDF-1.7 uploaded deck');
const PDF_URL = Buffer.from('%PDF-1.7 attached deck');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const uploadOf = (bytes, ext) => ({ set: UPLOAD_SET, sha256: sha256(bytes), ext });
const UP_A = uploadOf(PNG_A, 'png');
const UP_B = uploadOf(JPG_B, 'jpg');
const UP_DECK = uploadOf(PDF, 'pdf');

/** The uploads repository and the attachment URLs every run can reach. */
const FETCH_PLAN = {
  urls: {
    'https://github.com/user-attachments/assets/aaa.png': {
      contentType: 'image/png',
      base64: PNG_URL.toString('base64'),
    },
    'https://example.org/shot2.jpg': { contentType: 'image/jpeg', base64: JPG_URL.toString('base64') },
    'https://github.com/user-attachments/files/12345678/deck.pdf': {
      contentType: 'application/pdf',
      base64: PDF_URL.toString('base64'),
    },
  },
  uploads: {
    repo: UPLOADS_REPO,
    branches: Object.fromEntries(
      [
        [UP_A, PNG_A],
        [UP_B, JPG_B],
        [UP_DECK, PDF],
      ].map(([ref, bytes]) => [
        uploadBranch(AUTHOR_ID, ref),
        { path: uploadFilename(ref), base64: bytes.toString('base64') },
      ])
    ),
  },
};

/** issue-basic.md with its screenshots and deck attached on /submit/ instead. */
function uploadBody() {
  const screenshots = [
    '![Daily brief](https://github.com/user-attachments/assets/aaa.png)\nhttps://example.org/shot2.jpg | The queue view',
    [
      `${formatUploadRef(UP_A)} | Landing page with a Get Started button`,
      'https://github.com/user-attachments/assets/aaa.png | Daily brief',
      `${formatUploadRef(UP_B)} | Results table`,
    ].join('\n'),
  ];
  const deck = [
    '[deck.pdf](https://github.com/user-attachments/files/12345678/deck.pdf)',
    formatUploadRef(UP_DECK),
  ];
  assert.ok(
    ISSUE_BODY.includes(screenshots[0]) && ISSUE_BODY.includes(deck[0]),
    'the fixture still has both answers'
  );
  return ISSUE_BODY.replace(screenshots[0], screenshots[1]).replace(deck[0], deck[1]);
}

/** `$GITHUB_OUTPUT`'s heredoc pairs, as a plain object. */
function readOutputs(file) {
  const outputs = {};
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const match of text.matchAll(/^([a-z_]+)<<(GHEOF_\S+)\n([\s\S]*?)\n\2$/gm))
    outputs[match[1]] = match[3];
  return outputs;
}

/**
 * Scaffold for real in a fresh checkout holding this repository's _data.
 * @param {string} body issue body
 * @param {Record<string, string>} uploadsEnv
 * @param {string} log request log shared across runs (each line one request)
 */
function scaffold(
  body,
  uploadsEnv,
  log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-log-')), 'requests.jsonl')
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-uploads-'));
  fs.mkdirSync(path.join(root, '_data'));
  for (const name of ['schema.yml', 'governance.yml']) {
    fs.copyFileSync(path.join(ROOT, '_data', name), path.join(root, '_data', name));
  }
  const planFile = path.join(root, 'fetch-plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ ...FETCH_PLAN, log }));
  const outputFile = path.join(root, 'github-output');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GITHUB_TOKEN|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|UPLOADS_.*|ISSUE_AUTHOR_ID)$/.test(key)
    )
  );
  const result = spawnSync(process.execPath, ['--import', STUB, SCRIPT], {
    cwd: root,
    env: {
      ...env,
      ...uploadsEnv,
      ISSUE_BODY: body,
      ISSUE_TITLE: '[Use case] Service request routing',
      ISSUE_NUMBER: '7',
      GITHUB_TOKEN: JOB_TOKEN,
      GITHUB_OUTPUT: outputFile,
      FETCH_STUB_PLAN: planFile,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = readOutputs(outputFile);
  const entryDir = path.join(root, outputs.entry_dir);
  const page = fs.readFileSync(path.join(entryDir, 'index.md'), 'utf8');
  const files = Object.fromEntries(
    fs
      .readdirSync(entryDir, { recursive: true })
      .filter((name) => fs.statSync(path.join(entryDir, name)).isFile())
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(entryDir, name))])
  );
  const calls = fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  fs.rmSync(root, { recursive: true, force: true });
  return {
    ...result,
    outputs,
    page,
    files,
    calls,
    frontMatter: yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(page)[1]),
  };
}

const imagesField = () => repoSchema().fields.find((f) => f.type === 'images');
const fileField = () => repoSchema().fields.find((f) => f.type === 'file');
const isUploadsApi = (call) => call.url.startsWith(`https://api.github.com/repos/${UPLOADS_REPO}/git/`);

test('upload: screenshots and deck are saved into the entry exactly as attachments are', () => {
  const images = imagesField();
  const file = fileField();
  const attached = scaffold(ISSUE_BODY, UPLOADS_ON);
  const uploaded = scaffold(uploadBody(), UPLOADS_ON);
  const slug = uploaded.frontMatter.slug;
  const shots = `/${repoSchema().entry.path}/${slug}/screenshots`;

  assert.deepEqual(uploaded.frontMatter[images.key], [
    { src: `${shots}/01.png`, alt: 'Landing page with a Get Started button' },
    { src: `${shots}/02.png`, alt: 'Daily brief' },
    { src: `${shots}/03.jpg`, alt: 'Results table' },
  ]);
  assert.deepEqual(
    Object.keys(uploaded.frontMatter[images.key][0]),
    Object.keys(attached.frontMatter[images.key][0])
  );
  // The deck names the same entry path a downloaded GitHub attachment does.
  assert.equal(uploaded.frontMatter[file.key], attached.frontMatter[file.key]);
  assert.equal(uploaded.frontMatter[file.key], `/${repoSchema().entry.path}/${slug}/${file.filename}`);

  assert.deepEqual(Object.keys(uploaded.files), [
    file.filename,
    'index.md',
    'screenshots/01.png',
    'screenshots/02.png',
    'screenshots/03.jpg',
  ]);
  // The same layout the attachment run produced: the deck beside the page, screenshots in their folder.
  assert.deepEqual(Object.keys(attached.files), [
    file.filename,
    'index.md',
    'screenshots/01.png',
    'screenshots/02.jpg',
  ]);
  assert.ok(uploaded.files['screenshots/01.png'].equals(PNG_A));
  assert.ok(uploaded.files['screenshots/02.png'].equals(PNG_URL));
  assert.ok(uploaded.files['screenshots/03.jpg'].equals(JPG_B));
  assert.ok(uploaded.files[file.filename].equals(PDF));
  assert.equal(uploaded.outputs.warnings, '');
  assert.match(uploaded.stdout, /Files written: 5 \(1 page, 3 screenshots, 1 attachment\)/);
});

test('UPLOADS_TOKEN reaches the uploads API only, never the generic fetchers or any output', () => {
  const run = scaffold(uploadBody(), UPLOADS_ON);
  const api = run.calls.filter(isUploadsApi);
  const generic = run.calls.filter((call) => !isUploadsApi(call));
  assert.equal(api.length, 12, 'ref, commit, tree and blob for each of the three references');
  for (const call of api) assert.equal(call.authorization, `Bearer ${UPLOADS_TOKEN}`, call.url);
  // The generic fetchers attach their token to any GitHub host a submitter names.
  assert.deepEqual(generic, [
    {
      url: 'https://github.com/user-attachments/assets/aaa.png',
      method: 'GET',
      authorization: `Bearer ${JOB_TOKEN}`,
    },
  ]);
  for (const text of [run.stdout, run.stderr, run.page, JSON.stringify(run.outputs)]) {
    assert.ok(!text.includes(UPLOADS_TOKEN));
  }
});

test('an issue edit scaffolds again: every reference is resolved anew, with reads only', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-log-')), 'requests.jsonl');
  const first = scaffold(uploadBody(), UPLOADS_ON, log);
  const firstCount = first.calls.filter(isUploadsApi).length;
  // The draft branch is rebuilt from main, so the second run starts from an empty folder.
  const second = scaffold(uploadBody(), UPLOADS_ON, log);
  assert.equal(firstCount, 12);
  assert.equal(second.calls.filter(isUploadsApi).length, 24, 'the second run resolved all three again');
  assert.deepEqual(second.files, first.files);
  // Nothing is ever written to or deleted from the uploads repository.
  assert.deepEqual([...new Set(second.calls.map((call) => call.method))], ['GET']);
});

test('uploads not set up: upload: lines become a warning, and everything else still scaffolds', () => {
  const images = imagesField();
  const file = fileField();
  const run = scaffold(uploadBody(), UPLOADS_OFF);
  const slug = run.frontMatter.slug;
  const entryPath = `/${repoSchema().entry.path}/${slug}`;

  assert.equal(run.calls.filter((call) => call.url.startsWith('https://api.github.com/')).length, 0);
  assert.deepEqual(run.frontMatter[images.key], [
    { src: `${entryPath}/screenshots/01.png`, alt: 'Daily brief' },
  ]);
  assert.equal(run.frontMatter.title, 'Service request routing assistant');
  // The deck gets what a GitHub attachment whose link cannot be kept gets.
  assert.equal(run.frontMatter[file.key], `${entryPath}/${file.filename}`);
  assert.deepEqual(Object.keys(run.files), ['index.md', 'screenshots/01.png']);

  const warnings = run.outputs.warnings;
  assert.ok(warnings.includes(`- ${notConfiguredWarning(images.label, 2)}`), warnings);
  assert.ok(
    warnings.includes(
      `- ${notConfiguredWarning(file.label, 1)} Commit the file as \`${entryPath}/${file.filename}\` in this pull request if it should be included.`
    ),
    warnings
  );
  assert.match(
    run.stderr,
    /upload: references skipped: uploads are not configured \(UPLOADS_TOKEN, UPLOADS_REPO not set\)/
  );
});

test('an upload that is gone is a not-found warning, and the rest still scaffolds', () => {
  const images = imagesField();
  // A reference the uploads repository does not hold under this author.
  const gone = { set: UPLOAD_SET, sha256: 'f'.repeat(64), ext: 'png' };
  const body = uploadBody().replace(formatUploadRef(UP_B), formatUploadRef(gone));
  const run = scaffold(body, UPLOADS_ON);
  assert.equal(run.frontMatter[images.key].length, 2);
  assert.ok(run.outputs.warnings.includes(`- ${notFoundWarning(images.label, gone)}`), run.outputs.warnings);
});

test('no upload: lines: the scaffold is identical whether uploads are set up or not', () => {
  const off = scaffold(ISSUE_BODY, UPLOADS_OFF);
  const on = scaffold(ISSUE_BODY, UPLOADS_ON);
  const none = scaffold(ISSUE_BODY, {});
  for (const run of [off, on, none]) {
    assert.equal(run.calls.filter((call) => call.url.startsWith('https://api.github.com/')).length, 0);
  }
  assert.equal(on.page, off.page);
  assert.equal(none.page, off.page);
  assert.deepEqual(on.files, off.files);
  assert.deepEqual(none.outputs, off.outputs);
  assert.deepEqual(on.outputs, off.outputs);
  assert.equal(on.stdout, off.stdout);
  assert.equal(off.stderr, '');
});

test('a dry run lists upload: references and fetches nothing', () => {
  const file = fileField();
  const stdout = dryRunOutput(ROOT, uploadBody());
  const fm = dryRun(ROOT, uploadBody());
  assert.equal(fm[imagesField().key].length, 3);
  assert.equal(fm[file.key], `/${repoSchema().entry.path}/${fm.slug}/${file.filename}`);
  const warnings = stdout.split('# warnings')[1];
  assert.ok(warnings.includes('- Dry run: 1 image URL(s) were parsed but not downloaded.'), warnings);
  assert.ok(
    warnings.includes(
      `- Dry run: \`${formatUploadRef(UP_A)}\`, \`${formatUploadRef(UP_B)}\` parsed but not fetched.`
    ),
    warnings
  );
  assert.ok(
    warnings.includes(`- Dry run: \`${formatUploadRef(UP_DECK)}\` was parsed but not fetched.`),
    warnings
  );
});
