#!/usr/bin/env node
/** Validate the PHCT/downstream update boundary before an upgrade can be merged. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

import { OPTIONAL_ISSUE_FORMS } from '../assets/js/configurator/issue-chooser.js';
import { DERIVED_OUTPUTS, GENERATOR_OUTPUTS } from './lib/generated_paths.mjs';
import { optionalFormPath, optionalFormSource } from './lib/optional_issue_forms.mjs';
import { forkOwnershipRules, isForkOwned, matchesPattern } from './upgrade_check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = '.phct/ownership.yml';
const LOCK_PATH = '.phct-version.json';

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function probe(pattern) {
  return pattern.endsWith('/**') ? `${pattern.slice(0, -2)}__ownership_probe__` : pattern;
}

function stringList(value, name, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`${name} must be a list of non-empty paths.`);
    return [];
  }
  return value;
}

export function validateOwnership({ manifest, lock, attributes, packageJson }) {
  const errors = [];
  const deployment = stringList(manifest?.ownership?.deployment, 'ownership.deployment', errors);
  const generated = stringList(manifest?.ownership?.generated, 'ownership.generated', errors);
  const updateMetadata = stringList(
    manifest?.ownership?.update_metadata,
    'ownership.update_metadata',
    errors
  );
  const exceptions = stringList(
    manifest?.ownership?.template_exceptions,
    'ownership.template_exceptions',
    errors
  );
  const assertions = stringList(manifest?.template_owned_assertions, 'template_owned_assertions', errors);
  const declaredOwned = [...deployment, ...generated, ...updateMetadata];
  const rules = forkOwnershipRules(attributes);

  if (manifest?.schema_version !== 1) errors.push(`${MANIFEST_PATH} schema_version must be 1.`);

  // The canonical PHCT repository defines the update contract but does not
  // consume itself, so only downstream deployments have a version lock.
  if (lock !== null && lock !== undefined) {
    if (lock?.schema_version !== 1) errors.push(`${LOCK_PATH} schema_version must be 1.`);
    if (manifest?.template?.repository !== lock?.source_repository) {
      errors.push('The ownership manifest and version lock name different PHCT repositories.');
    }
    if (lock?.release !== `v${lock?.version ?? ''}`) {
      errors.push(`${LOCK_PATH} release must equal "v" plus version.`);
    }
    if (packageJson?.version !== lock?.version) {
      errors.push(
        `package.json version ${packageJson?.version} does not match ${LOCK_PATH} ${lock?.version}.`
      );
    }
    if (!/^[0-9a-f]{40}$/.test(lock?.commit ?? '')) {
      errors.push(`${LOCK_PATH} commit must be a full 40-character Git SHA.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lock?.recorded_at ?? '')) {
      errors.push(`${LOCK_PATH} recorded_at must use YYYY-MM-DD.`);
    }
  }

  if (!updateMetadata.includes(LOCK_PATH)) {
    errors.push(`ownership.update_metadata must declare ${LOCK_PATH}.`);
  }

  const duplicates = [
    ...new Set(declaredOwned.filter((item, index) => declaredOwned.indexOf(item) !== index)),
  ];
  if (duplicates.length > 0) errors.push(`Ownership paths appear more than once: ${duplicates.join(', ')}`);

  for (const pattern of declaredOwned) {
    if (!rules.some((rule) => rule.pattern === pattern && rule.owned)) {
      errors.push(`${pattern} is declared deployment-owned but has no merge=ours rule.`);
    }
    if (!isForkOwned(rules, probe(pattern))) {
      errors.push(`${pattern} is not deployment-owned after ordered .gitattributes rules are applied.`);
    }
  }

  for (const pattern of exceptions) {
    if (!rules.some((rule) => rule.pattern === pattern && !rule.owned)) {
      errors.push(`${pattern} is a template exception but has no !merge rule.`);
    }
    if (isForkOwned(rules, probe(pattern))) {
      errors.push(`${pattern} is still deployment-owned after its exception rule.`);
    }
  }

  for (const rule of rules.filter((item) => item.owned)) {
    if (!declaredOwned.includes(rule.pattern)) {
      errors.push(`${rule.pattern} has merge=ours but is missing from ${MANIFEST_PATH}.`);
    }
  }

  for (const pattern of assertions) {
    if (isForkOwned(rules, probe(pattern))) {
      errors.push(`${pattern} must remain PHCT-owned but resolves to deployment-owned.`);
    }
  }

  for (const output of GENERATOR_OUTPUTS) {
    if (!isForkOwned(rules, output)) errors.push(`Generator output ${output} is not protected.`);
  }
  for (const output of DERIVED_OUTPUTS) {
    if (!generated.includes(output))
      errors.push(`Derived output ${output} is absent from ownership.generated.`);
  }
  for (const output of generated) {
    if (!DERIVED_OUTPUTS.includes(output))
      errors.push(`${output} is marked generated but generate.mjs does not derive it.`);
  }

  // generate.mjs writes and deletes these from template sources after every
  // update, so neither side may be deployment-owned: a protected copy would
  // fail the after-update checksum the moment generate removed it.
  for (const form of OPTIONAL_ISSUE_FORMS) {
    for (const file of [optionalFormPath(form.file), optionalFormSource(form.file)]) {
      if (isForkOwned(rules, file)) {
        errors.push(`${file} is an optional issue form generate.mjs manages; it must stay PHCT-owned.`);
      }
    }
  }

  for (const exception of exceptions) {
    if (!assertions.some((pattern) => matchesPattern(pattern, probe(exception)))) {
      errors.push(`${exception} is an exception but is not covered by template_owned_assertions.`);
    }
  }

  return errors;
}

function main() {
  const manifest = yaml.load(read(MANIFEST_PATH));
  const lock = fs.existsSync(path.join(ROOT, LOCK_PATH)) ? JSON.parse(read(LOCK_PATH)) : null;
  const packageJson = JSON.parse(read('package.json'));
  const errors = validateOwnership({ manifest, lock, attributes: read('.gitattributes'), packageJson });

  if (errors.length > 0) {
    console.error('\nPHCT ownership contract failed:\n');
    for (const error of errors) console.error(`  • ${error}`);
    console.error('');
    return 1;
  }

  const mode = lock ? `downstream locked to ${lock.release}` : 'canonical template';
  console.log(
    `PHCT ownership contract is valid (${mode}): ${manifest.ownership.deployment.length} deployment paths, ` +
      `${manifest.ownership.generated.length} derived paths, ${manifest.ownership.update_metadata.length} update metadata path, ` +
      `${manifest.ownership.template_exceptions.length} exception.`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
