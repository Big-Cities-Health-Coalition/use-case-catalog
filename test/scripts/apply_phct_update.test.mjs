import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  applyUpdate,
  assertStableOwnershipContract,
  generatedOutputAdditions,
  parseNameStatusZ,
  planReconciliation,
  planUpdate,
  resolveOwnershipContract,
} from '../../scripts/apply_phct_update.mjs';
import { forkOwnershipRules } from '../../scripts/upgrade_check.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/apply_phct_update.mjs', import.meta.url));

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('NUL name-status parsing retains both sides of renames and copies', () => {
  assert.deepEqual(parseNameStatusZ('M\0app.js\0R100\0old.md\0new.md\0C090\0a.txt\0b.txt\0'), [
    { status: 'M', path: 'app.js' },
    { status: 'R', oldPath: 'old.md', path: 'new.md' },
    { status: 'C', oldPath: 'a.txt', path: 'b.txt' },
  ]);
});

test('the update plan takes template files and leaves deployment files alone', () => {
  const rules = forkOwnershipRules('config/** merge=ours\nconfig/template/** !merge\n');
  const plan = planUpdate(
    [
      { status: 'M', path: 'app.js' },
      { status: 'D', path: 'old.js' },
      { status: 'M', path: 'config/site.yml' },
      { status: 'A', path: 'config/template/schema.yml' },
      { status: 'R', oldPath: 'before.md', path: 'after.md' },
    ],
    rules
  );
  assert.deepEqual(plan.take, ['after.md', 'app.js', 'config/template/schema.yml']);
  assert.deepEqual(plan.remove, ['before.md', 'old.js']);
  assert.deepEqual(plan.preserve, ['config/site.yml']);
});

test('tree reconciliation restores unchanged parent files removed downstream', () => {
  const rules = forkOwnershipRules('config/** merge=ours\n');
  assert.deepEqual(
    planReconciliation(
      ['app.js', 'showcase/data.yml', 'config/site.yml'],
      ['app.js', 'child-only.js', 'config/site.yml'],
      rules
    ),
    {
      take: ['app.js', 'showcase/data.yml'],
      remove: ['child-only.js'],
      preserve: ['config/site.yml'],
    }
  );
});

test('ownership transitions fail closed in both directions', () => {
  const current = 'config/** merge=ours\nconfig/template/** !merge\n';
  assert.deepEqual(assertStableOwnershipContract(`# current\n${current}`, `${current}# target\n`), [
    { pattern: 'config/**', owned: true },
    { pattern: 'config/template/**', owned: false },
  ]);
  assert.throws(
    () => assertStableOwnershipContract(current, `${current}config/reclaimed/** !merge\n`),
    /changes the deployment ownership contract/
  );
  assert.throws(
    () => assertStableOwnershipContract(current, `${current}new-protected/** merge=ours\n`),
    /changes the deployment ownership contract/
  );
});

test('an ownership migration stops before changing the downstream tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-ownership-transition-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'PHCT test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v1');
  git(root, 'tag', 'v1.0.0');

  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\nconfig/reclaimed/** !merge\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v2\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v2');
  git(root, 'tag', 'v1.1.0');

  git(root, 'checkout', '--quiet', '-b', 'downstream', 'v1.0.0');
  fs.writeFileSync(path.join(root, 'app.txt'), 'downstream drift\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '--quiet', '-m', 'customize downstream');

  assert.throws(
    () => applyUpdate({ root, from: 'v1.0.0', to: 'v1.1.0' }),
    /changes the deployment ownership contract/
  );
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'downstream drift\n');
  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), 'config/** merge=ours\n');
  assert.equal(git(root, 'status', '--short'), '');
});

test('a release that only adds absent generator outputs is adopted, not refused', () => {
  const current = 'config/** merge=ours\nconfig/template/** !merge\ngen/a.json merge=ours\n';
  const target = `${current}gen/b.json merge=ours\ngen/c.txt merge=ours\n`;
  const context = {
    generated: ['gen/a.json', 'gen/b.json', 'gen/c.txt'],
    currentFiles: ['gen/a.json', 'app.js'],
  };
  const { rules, adopted } = resolveOwnershipContract(current, target, context);
  assert.deepEqual(adopted, ['gen/b.json', 'gen/c.txt']);
  assert.deepEqual(rules, forkOwnershipRules(target));

  // Inserted between existing rules is still a pure addition.
  const between =
    'config/** merge=ours\ngen/b.json merge=ours\nconfig/template/** !merge\ngen/a.json merge=ours\n';
  assert.deepEqual(resolveOwnershipContract(current, between, context).adopted, ['gen/b.json']);

  // An unchanged contract adopts nothing.
  assert.deepEqual(resolveOwnershipContract(current, `# target\n${current}`, context).adopted, []);
});

test('every other ownership change still fails closed', () => {
  const current = 'config/** merge=ours\nconfig/template/** !merge\n';
  const context = { generated: ['gen/b.json', 'config/template/out.json'], currentFiles: ['app.js'] };
  const refused = (target, ctx = context) =>
    assert.throws(
      () => resolveOwnershipContract(current, target, ctx),
      /changes the deployment ownership contract/
    );

  refused(`${current}gen/b.json merge=ours\n`, { ...context, currentFiles: ['gen/b.json'] }); // the deployment has the file
  refused(`${current}gen/b.json merge=ours\n`, { ...context, exists: (file) => file === 'gen/b.json' }); // untracked on disk
  refused(`${current}gen/b.json merge=ours\n`, { ...context, generated: [] }); // not a generator output
  refused(`${current}gen/b.json merge=ours\n`, {}); // no context: strict
  refused(`${current}gen/** merge=ours\n`, { ...context, generated: ['gen/**'] }); // a glob
  refused(`${current}gen/b?.json merge=ours\n`, { ...context, generated: ['gen/b?.json'] });
  refused(`${current}gen/b.json merge=ours\ngen/b.json !merge\n`); // a later rule unprotects it
  refused(`${current}gen/b.json merge=ours\nconfig/reclaimed/** !merge\n`); // a reclaim rides along
  refused('config/template/** !merge\nconfig/** merge=ours\ngen/b.json merge=ours\n'); // reordered
  refused('config/** merge=ours\ngen/b.json merge=ours\n'); // an existing rule removed
  // Added before an existing exception glob that unprotects it: still template-owned.
  refused('config/** merge=ours\nconfig/template/out.json merge=ours\nconfig/template/** !merge\n');
  assert.equal(
    generatedOutputAdditions(forkOwnershipRules(current), forkOwnershipRules(current), context),
    null
  );
});

test('the updater adopts a new generated output end to end and leaves it for generate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-generated-addition-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'PHCT test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(root, '.phct'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\n');
  fs.writeFileSync(path.join(root, '.phct/ownership.yml'), 'ownership:\n  generated: []\n');
  fs.writeFileSync(path.join(root, 'config/site.yml'), 'name: parent\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v1');
  git(root, 'tag', 'v1.0.0');

  const targetAttributes = 'config/** merge=ours\nout/answers.json merge=ours\n';
  fs.writeFileSync(path.join(root, '.gitattributes'), targetAttributes);
  fs.writeFileSync(
    path.join(root, '.phct/ownership.yml'),
    'ownership:\n  generated:\n    - out/answers.json\n'
  );
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out/answers.json'), '{"from":"the template demo"}\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v2\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v2');
  git(root, 'tag', 'v1.1.0');

  git(root, 'checkout', '--quiet', '-b', 'downstream', 'v1.0.0');
  fs.writeFileSync(path.join(root, 'config/site.yml'), 'name: downstream\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'customize downstream');

  const result = applyUpdate({ root, from: 'v1.0.0', to: 'v1.1.0' });
  assert.deepEqual(result.adopted, ['out/answers.json']);
  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), targetAttributes);
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'parent v2\n');
  assert.equal(fs.readFileSync(path.join(root, 'config/site.yml'), 'utf8'), 'name: downstream\n');
  assert.equal(fs.existsSync(path.join(root, 'out/answers.json')), false, 'left for npm run generate');
  assert.ok(result.preserve.includes('out/answers.json'));
});

test('an untracked file at a new generated path stops the update before it writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-generated-untracked-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'PHCT test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(root, '.phct'));
  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\n');
  fs.writeFileSync(path.join(root, '.phct/ownership.yml'), 'ownership:\n  generated: []\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v1');
  git(root, 'tag', 'v1.0.0');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\nout.json merge=ours\n');
  fs.writeFileSync(path.join(root, '.phct/ownership.yml'), 'ownership:\n  generated:\n    - out.json\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v2\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v2');
  git(root, 'tag', 'v1.1.0');
  git(root, 'checkout', '--quiet', '-b', 'downstream', 'v1.0.0');
  fs.writeFileSync(path.join(root, 'out.json'), 'hand-made, never committed\n');

  assert.throws(
    () => applyUpdate({ root, from: 'v1.0.0', to: 'v1.1.0' }),
    /changes the deployment ownership contract/
  );
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'parent v1\n');
  assert.equal(fs.readFileSync(path.join(root, 'out.json'), 'utf8'), 'hand-made, never committed\n');
});

test('the CLI runs when invoked through a symlinked path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-update-cli-'));
  const link = path.join(root, 'apply-update.mjs');
  fs.symlinkSync(SCRIPT, link);
  const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/apply_phct_update\.mjs/);
});

test('an unrelated GitHub-template history receives the exact parent diff without conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phct-update-test-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'PHCT test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitattributes'), 'config/** merge=ours\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v1\n');
  fs.writeFileSync(path.join(root, 'stable.txt'), 'unchanged parent file\n');
  fs.writeFileSync(path.join(root, 'old.txt'), 'remove me\n');
  fs.writeFileSync(path.join(root, 'config', 'site.yml'), 'parent: v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'parent v1');
  git(root, 'tag', 'v1.0.0');
  const baselineTree = git(root, 'rev-parse', 'v1.0.0^{tree}');

  fs.writeFileSync(path.join(root, 'app.txt'), 'parent v2\n');
  fs.rmSync(path.join(root, 'old.txt'));
  fs.writeFileSync(path.join(root, 'added.txt'), 'new in parent\n');
  fs.writeFileSync(path.join(root, 'config', 'site.yml'), 'parent: v2\n');
  fs.writeFileSync(path.join(root, 'config', 'parent-only.yml'), 'do not import\n');
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'parent v2');
  git(root, 'tag', 'v1.1.0');

  const childRoot = git(root, 'commit-tree', baselineTree, '-m', 'template snapshot');
  git(root, 'branch', 'downstream', childRoot);
  git(root, 'checkout', '--quiet', 'downstream');
  fs.writeFileSync(path.join(root, 'config', 'site.yml'), 'bchc: true\n');
  fs.writeFileSync(path.join(root, 'stable.txt'), 'downstream drift\n');
  fs.writeFileSync(path.join(root, 'child-only.txt'), 'not deployment-owned\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'customize downstream');

  assert.throws(() => git(root, 'merge-base', 'HEAD', 'v1.1.0'));
  const result = applyUpdate({ root, from: 'v1.0.0', to: 'v1.1.0' });

  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'parent v2\n');
  assert.equal(fs.readFileSync(path.join(root, 'added.txt'), 'utf8'), 'new in parent\n');
  assert.equal(fs.readFileSync(path.join(root, 'stable.txt'), 'utf8'), 'unchanged parent file\n');
  assert.equal(fs.existsSync(path.join(root, 'child-only.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'config', 'site.yml'), 'utf8'), 'bchc: true\n');
  assert.equal(fs.existsSync(path.join(root, 'config', 'parent-only.yml')), false);
  assert.deepEqual(result.preserve, ['config/parent-only.yml', 'config/site.yml']);
  assert.equal(git(root, 'diff', '--name-only', '--diff-filter=U'), '');
});
