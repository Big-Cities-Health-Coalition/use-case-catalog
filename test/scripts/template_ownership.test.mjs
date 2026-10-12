import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

import { validateOwnership } from '../../scripts/check_template_ownership.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function inputs() {
  const lockPath = path.join(ROOT, '.phct-version.json');
  return {
    manifest: yaml.load(read('.phct/ownership.yml')),
    lock: fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null,
    attributes: read('.gitattributes'),
    packageJson: JSON.parse(read('package.json')),
  };
}

function downstreamLock(values) {
  return (
    values.lock ?? {
      schema_version: 1,
      source_repository: values.manifest.template.repository,
      version: values.packageJson.version,
      release: `v${values.packageJson.version}`,
      commit: 'a'.repeat(40),
      recorded_at: '2026-08-22',
    }
  );
}

test('the checked-in PHCT ownership contract is internally consistent', () => {
  assert.deepEqual(validateOwnership(inputs()), []);
});

test('the canonical template is valid without a downstream version lock', () => {
  const values = inputs();
  values.lock = null;
  assert.deepEqual(validateOwnership(values), []);
});

test('a new unprotected deployment file fails closed', () => {
  const values = inputs();
  values.manifest.ownership.deployment.push('_data/new-bchc-policy.yml');
  assert.ok(validateOwnership(values).some((error) => error.includes('_data/new-bchc-policy.yml')));
});

test('an undocumented merge=ours path fails closed', () => {
  const values = inputs();
  values.attributes += '\n_layouts/default.html merge=ours\n';
  assert.ok(validateOwnership(values).some((error) => error.includes('_layouts/default.html')));
});

test('the package and consumed PHCT release cannot drift', () => {
  const values = inputs();
  values.lock = downstreamLock(values);
  values.packageJson.version = '9.9.9';
  assert.ok(validateOwnership(values).some((error) => error.includes('package.json version')));
});

test('downstream version metadata remains part of the update boundary', () => {
  const values = inputs();
  values.manifest.ownership.update_metadata = [];
  assert.ok(validateOwnership(values).some((error) => error.includes('.phct-version.json')));
});

test('optional issue forms stay template-owned so generate can add and remove them after an update', () => {
  const values = inputs();
  values.attributes += '\n.github/ISSUE_TEMPLATE/new-year.yml merge=ours\n';
  values.manifest.ownership.deployment.push('.github/ISSUE_TEMPLATE/new-year.yml');
  assert.ok(
    validateOwnership(values).some(
      (error) => error.includes('.github/ISSUE_TEMPLATE/new-year.yml') && error.includes('PHCT-owned')
    )
  );
});
