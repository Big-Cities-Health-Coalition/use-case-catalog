import assert from 'node:assert/strict';
import test from 'node:test';

import { COVERAGE_GROUPS, coverageArguments, parseCoverageSummary } from '../../scripts/coverage.mjs';

test('coverage groups include explicit security-parser and updater expectations', () => {
  assert.deepEqual(
    COVERAGE_GROUPS.map((group) => group.id),
    ['full', 'signin-service', 'security-parsers', 'updater-workflows']
  );
  for (const group of COVERAGE_GROUPS) {
    assert.ok(group.thresholds.lines > 0);
    assert.ok(group.thresholds.branches > 0);
    assert.ok(group.thresholds.functions > 0);
  }
});

test('coverage arguments use the pinned Node runner and exclude test implementation', () => {
  const group = COVERAGE_GROUPS.find(({ id }) => id === 'security-parsers');
  const args = coverageArguments(group);
  assert.ok(args.includes('--experimental-test-coverage'));
  assert.ok(args.includes('--test-coverage-exclude=test/**'));
  assert.ok(args.includes('--test-coverage-lines=88'));
  assert.ok(args.includes('--test-coverage-include=scripts/lib/issue_body.mjs'));
  assert.ok(args.includes('test/scripts/issue_body.test.mjs'));

  const full = coverageArguments(COVERAGE_GROUPS.find(({ id }) => id === 'full'));
  assert.ok(full.includes('--test-coverage-include=assets/js/**/*.js'));
  assert.ok(full.includes('--test-coverage-include=scripts/**/*.mjs'));
  assert.ok(full.includes('--test-coverage-include=services/*/lib/**/*.mjs'));

  const signin = coverageArguments(COVERAGE_GROUPS.find(({ id }) => id === 'signin-service'));
  assert.ok(signin.includes('--test-coverage-include=services/github-signin/lib/**/*.mjs'));
  assert.ok(signin.includes('services/github-signin/test/signin.test.mjs'));
});

test('coverage summary parsing returns line, branch, and function evidence', () => {
  const output = [
    '# start of coverage report',
    '# all files | 90.54 | 80.55 | 93.59 |',
    '# end of coverage report',
  ].join('\n');
  assert.deepEqual(parseCoverageSummary(output), {
    lines: 90.54,
    branches: 80.55,
    functions: 93.59,
  });
  assert.throws(() => parseCoverageSummary('TAP version 13'), /all-files coverage summary/);
});
