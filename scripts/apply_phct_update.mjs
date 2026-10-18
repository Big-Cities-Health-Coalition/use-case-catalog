#!/usr/bin/env node
/** Reconcile one immutable PHCT release into an unrelated downstream history. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

import { forkOwnershipRules, isForkOwned, isImmutableUpdateRef } from './upgrade_check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Parse `git diff --name-status -z --find-renames` without losing rename sources.
 *
 * @param {string} output
 * @returns {{status: string, oldPath?: string, path: string}[]}
 */
export function parseNameStatusZ(output) {
  const fields = String(output ?? '').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];

  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    const status = rawStatus[0];
    if (!'ACDMRT'.includes(status)) {
      throw new Error(`Unsupported parent diff status ${JSON.stringify(rawStatus)}.`);
    }
    if (status === 'R' || status === 'C') {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) throw new Error(`Incomplete ${status} record in parent diff.`);
      changes.push({ status, oldPath, path: newPath });
    } else {
      const file = fields[index++];
      if (!file) throw new Error(`Incomplete ${status} record in parent diff.`);
      changes.push({ status, path: file });
    }
  }

  return changes;
}

/**
 * Turn the parent diff into exact, ownership-aware filesystem operations.
 * Template-owned paths take the target release byte-for-byte. Deployment-owned
 * paths are left untouched and are checked again by the checksum gate.
 *
 * @param {{status: string, oldPath?: string, path: string}[]} changes
 * @param {{pattern: string, owned: boolean}[]} rules
 */
export function planUpdate(changes, rules) {
  const take = new Set();
  const remove = new Set();
  const preserve = new Set();

  function planPath(file, operation) {
    if (isForkOwned(rules, file)) {
      preserve.add(file);
      return;
    }
    (operation === 'remove' ? remove : take).add(file);
  }

  for (const change of changes) {
    if (change.status === 'R') planPath(change.oldPath, 'remove');
    if (change.status !== 'C' && change.status !== 'R') {
      planPath(change.path, change.status === 'D' ? 'remove' : 'take');
    } else {
      planPath(change.path, 'take');
    }
  }

  for (const file of take) remove.delete(file);
  return {
    take: [...take].sort(),
    remove: [...remove].sort(),
    preserve: [...preserve].sort(),
  };
}

/**
 * Reconcile the complete template-owned tree, including files that were
 * unchanged between parent releases but removed or edited downstream.
 *
 * @param {string[]} targetFiles
 * @param {string[]} currentFiles
 * @param {{pattern: string, owned: boolean}[]} rules
 */
export function planReconciliation(targetFiles, currentFiles, rules) {
  const target = new Set(targetFiles);
  const take = targetFiles.filter((file) => !isForkOwned(rules, file)).sort();
  const remove = currentFiles.filter((file) => !target.has(file) && !isForkOwned(rules, file)).sort();
  const preserve = [...new Set([...targetFiles, ...currentFiles])]
    .filter((file) => isForkOwned(rules, file))
    .sort();
  return { take, remove, preserve };
}

const CONTRACT_CHANGED =
  'Target release changes the deployment ownership contract. Apply and review the ' +
  '.gitattributes and .phct/ownership.yml migration separately before rerunning this update.';

const sameRule = (a, b) => a.pattern === b.pattern && a.owned === b.owned;

/**
 * The target's ownership rules, when they are the current rules plus only new
 * generator outputs the deployment does not have yet. Such a path cannot hold
 * deployment content, so protecting it overwrites nothing and reclaims
 * nothing: the update leaves it alone and `npm run generate` writes it from
 * the deployment's own data. Each added rule must be a literal `merge=ours`
 * path, listed in the target's `ownership.generated`, absent from the
 * deployment (tracked or not), and still protected after every target rule; the existing rules
 * must survive in order. Anything else returns null.
 *
 * @param {{pattern: string, owned: boolean}[]} currentRules
 * @param {{pattern: string, owned: boolean}[]} targetRules
 * @param {{generated?: string[], currentFiles?: string[], exists?: (file: string) => boolean}} context
 *   `exists` reports a path on disk, so an untracked file there counts as present
 * @returns {string[]|null} the adopted paths, or null when the change is not of that kind
 */
export function generatedOutputAdditions(
  currentRules,
  targetRules,
  { generated = [], currentFiles = [], exists = () => false } = {}
) {
  const added = [];
  let next = 0;
  for (const rule of targetRules) {
    if (next < currentRules.length && sameRule(rule, currentRules[next])) next += 1;
    else added.push(rule);
  }
  if (next !== currentRules.length || added.length === 0) return null;

  const present = new Set(currentFiles);
  const adoptable = (rule) =>
    rule.owned &&
    !/[*?[\]\\]/.test(rule.pattern) &&
    !rule.pattern.endsWith('/') &&
    generated.includes(rule.pattern) &&
    !present.has(rule.pattern) &&
    !exists(rule.pattern) &&
    isForkOwned(targetRules, rule.pattern);
  return added.every(adoptable) ? added.map((rule) => rule.pattern) : null;
}

/**
 * Refuse to guess when a release moves paths across the ownership boundary.
 * Ownership migrations need a separate, human-reviewed downstream change so
 * newly protected files cannot be overwritten and reclaimed files cannot keep
 * stale deployment content. The one exception is a release that only adds
 * generator outputs the deployment does not have (generatedOutputAdditions):
 * the update adopts those rules itself.
 *
 * @param {string} currentAttributes
 * @param {string} targetAttributes
 * @param {{generated?: string[], currentFiles?: string[]}} [context] the target's
 *   `ownership.generated` and the deployment's tracked files; without them only an
 *   unchanged contract passes
 * @returns {{rules: {pattern: string, owned: boolean}[], adopted: string[]}}
 */
export function resolveOwnershipContract(currentAttributes, targetAttributes, context = {}) {
  const currentRules = forkOwnershipRules(currentAttributes);
  const targetRules = forkOwnershipRules(targetAttributes);
  if (JSON.stringify(currentRules) === JSON.stringify(targetRules)) {
    return { rules: currentRules, adopted: [] };
  }
  const adopted = generatedOutputAdditions(currentRules, targetRules, context);
  if (!adopted) throw new Error(CONTRACT_CHANGED);
  return { rules: targetRules, adopted };
}

/**
 * The strict form: the target must keep the current contract exactly.
 *
 * @param {string} currentAttributes
 * @param {string} targetAttributes
 * @returns {{pattern: string, owned: boolean}[]}
 */
export function assertStableOwnershipContract(currentAttributes, targetAttributes) {
  return resolveOwnershipContract(currentAttributes, targetAttributes).rules;
}

/**
 * `ownership.generated` from the target release's manifest; empty when the
 * release has none, which leaves only the strict contract check.
 *
 * @param {string} root
 * @param {string} to
 * @returns {string[]}
 */
function targetGeneratedPaths(root, to) {
  let text;
  try {
    text = git(root, ['show', `${to}:.phct/ownership.yml`]);
  } catch {
    return [];
  }
  const generated = yaml.load(text)?.ownership?.generated;
  return Array.isArray(generated) ? generated.filter((item) => typeof item === 'string') : [];
}

/** Anything at the path, including a dangling symlink. */
function pathExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function nulList(output) {
  const values = String(output ?? '').split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

function batches(values, size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function assertRef(root, ref, label) {
  if (!isImmutableUpdateRef(ref)) {
    throw new Error(`${label} must be an immutable semantic-version tag, update ref, or full SHA.`);
  }
  git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/**
 * Reconcile the complete template-owned target tree without assuming that the
 * GitHub-template clone shares commit ancestry with PHCT.
 *
 * @param {{root?: string, from: string, to: string}} options
 */
export function applyUpdate({ root = ROOT, from, to }) {
  assertRef(root, from, 'Starting reference');
  assertRef(root, to, 'Target reference');

  const currentAttributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  const targetAttributes = git(root, ['show', `${to}:.gitattributes`]);
  const targetFiles = nulList(git(root, ['ls-tree', '-r', '-z', '--name-only', to, '--']));
  const currentFiles = nulList(git(root, ['ls-files', '-z']));
  const { rules, adopted } = resolveOwnershipContract(currentAttributes, targetAttributes, {
    generated: targetGeneratedPaths(root, to),
    currentFiles,
    exists: (file) => pathExists(path.join(root, file)),
  });
  const changes = parseNameStatusZ(
    git(root, ['diff', '--name-status', '-z', '--find-renames', from, to, '--'])
  );
  const plan = planReconciliation(targetFiles, currentFiles, rules);

  for (const batch of batches(plan.remove)) {
    git(root, ['rm', '--quiet', '--force', '--ignore-unmatch', '--', ...batch]);
  }
  for (const batch of batches(plan.take)) {
    git(root, ['checkout', '--quiet', to, '--', ...batch]);
  }

  const unmerged = git(root, ['diff', '--name-only', '--diff-filter=U', '--']).trim();
  if (unmerged) throw new Error(`Update left unresolved paths:\n${unmerged}`);

  return { changes, adopted, ...plan };
}

function parseArgs(argv) {
  const args = { from: '', to: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (!['--from', '--to'].includes(flag)) continue;
    args[flag.slice(2)] = String(inline ?? argv[++index] ?? '').trim();
  }
  return args;
}

function main(argv) {
  const { from, to } = parseArgs(argv);
  if (!from || !to) {
    console.error('Usage: node scripts/apply_phct_update.mjs --from <immutable-ref> --to <immutable-ref>');
    return 2;
  }

  try {
    const result = applyUpdate({ from, to });
    console.log(
      `Reconciled ${result.take.length + result.remove.length} template-owned paths to ${to} from ${result.changes.length} parent changes; preserved ${result.preserve.length} deployment-owned paths.`
    );
    if (result.adopted.length > 0) {
      console.log(
        `Adopted the release's new generated outputs as deployment-owned; npm run generate writes them: ${result.adopted.join(', ')}.`
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.exit(main(process.argv.slice(2)));
}
