#!/usr/bin/env node
/** Collect reproducible Node coverage evidence and enforce reviewed regression floors. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = path.join(ROOT, 'coverage');

export const COVERAGE_GROUPS = [
  {
    id: 'full',
    label: 'All Node production code loaded by the complete unit suite',
    thresholds: { lines: 82, branches: 72, functions: 75 },
    includes: ['assets/js/**/*.js', 'scripts/**/*.mjs', 'services/*/api/**/*.mjs', 'services/*/lib/**/*.mjs'],
    tests: [],
  },
  {
    id: 'signin-service',
    label: 'The optional GitHub sign-in service, which handles OAuth state and user tokens',
    thresholds: { lines: 95, branches: 90, functions: 95 },
    includes: ['services/github-signin/api/**/*.mjs', 'services/github-signin/lib/**/*.mjs'],
    tests: ['services/github-signin/test/signin.test.mjs'],
  },
  {
    id: 'uploads-service',
    label: 'The optional upload service, which handles user tokens, the uploads App key and file writes',
    thresholds: { lines: 95, branches: 90, functions: 95 },
    includes: ['services/uploads/api/**/*.mjs', 'services/uploads/lib/**/*.mjs'],
    tests: [
      'services/uploads/test/config.test.mjs',
      'services/uploads/test/github.test.mjs',
      'services/uploads/test/upload.test.mjs',
    ],
  },
  {
    id: 'security-parsers',
    label: 'Security-sensitive issue, YAML, image, attachment, and advisory parsers',
    thresholds: { lines: 88, branches: 78, functions: 90 },
    includes: [
      'scripts/audit_dependencies.mjs',
      'scripts/check_security_exceptions.mjs',
      'scripts/lib/attachments.mjs',
      'scripts/lib/images.mjs',
      'scripts/lib/issue_body.mjs',
      'scripts/lib/yaml.mjs',
    ],
    tests: [
      'test/scripts/audit_dependencies.test.mjs',
      'test/scripts/check_security_exceptions.test.mjs',
      'test/scripts/attachments.test.mjs',
      'test/scripts/images.test.mjs',
      'test/scripts/issue_body.test.mjs',
      'test/scripts/yaml.test.mjs',
    ],
  },
  {
    id: 'updater-workflows',
    label: 'Parent-to-deployment updater, checksum, and release-lock logic',
    thresholds: { lines: 70, branches: 75, functions: 85 },
    includes: [
      'scripts/apply_phct_update.mjs',
      'scripts/protected_checksums.mjs',
      'scripts/upgrade_check.mjs',
    ],
    tests: [
      'test/scripts/apply_phct_update.test.mjs',
      'test/scripts/protected_checksums.test.mjs',
      'test/scripts/upgrade_check.test.mjs',
    ],
  },
];

export function coverageArguments(group) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-exclude=test/**',
    `--test-coverage-lines=${group.thresholds.lines}`,
    `--test-coverage-branches=${group.thresholds.branches}`,
    `--test-coverage-functions=${group.thresholds.functions}`,
  ];
  for (const include of group.includes) args.push(`--test-coverage-include=${include}`);
  return [...args, ...group.tests];
}

export function parseCoverageSummary(output) {
  const match = String(output).match(/^# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/mu);
  if (!match) throw new Error('Node did not emit an all-files coverage summary.');
  return { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
}

function reportSection(output) {
  const start = output.indexOf('# start of coverage report');
  const end = output.indexOf('# end of coverage report', start);
  if (start === -1 || end === -1) return output.split('\n').slice(-80).join('\n');
  return output.slice(start, end + '# end of coverage report'.length);
}

function writeSummary(groups) {
  const report = {
    schema_version: 1,
    runtime: process.version,
    note: 'Regression floors are release evidence, not a substitute for review or behavior tests.',
    groups,
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, 'summary.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
}

function main() {
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const evidence = [];
  let failed = false;

  for (const group of COVERAGE_GROUPS) {
    console.log(`\n=== Coverage: ${group.label} ===\n`);
    const result = spawnSync(process.execPath, coverageArguments(group), {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    fs.writeFileSync(path.join(OUTPUT_DIRECTORY, `${group.id}.tap`), `${stdout}${stderr}`, 'utf8');

    let metrics = null;
    let error = result.error?.message || null;
    try {
      metrics = parseCoverageSummary(stdout);
    } catch (parseError) {
      error ??= parseError.message;
    }
    const passed = result.status === 0 && !error;
    evidence.push({
      id: group.id,
      label: group.label,
      scope: group.includes.length > 0 ? group.includes : ['production modules loaded by the test suite'],
      thresholds: group.thresholds,
      metrics,
      passed,
      exit_code: result.status,
      error,
    });
    writeSummary(evidence);

    const section = reportSection(stdout);
    if (section.trim()) console.log(section.trim());
    if (stderr.trim()) console.error(stderr.trim());
    if (!passed) {
      failed = true;
      console.error(`Coverage group ${group.id} failed; inspect coverage/${group.id}.tap.`);
    }
  }

  console.log('\n=== Coverage: Ruby production code loaded by the complete Minitest suite ===\n');
  fs.rmSync(path.join(OUTPUT_DIRECTORY, 'ruby.json'), { force: true });
  const ruby = spawnSync('bundle', ['exec', 'ruby', 'scripts/ruby_coverage.rb'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const rubyStdout = ruby.stdout || '';
  const rubyStderr = ruby.stderr || '';
  fs.writeFileSync(path.join(OUTPUT_DIRECTORY, 'ruby.tap'), `${rubyStdout}${rubyStderr}`, 'utf8');
  if (rubyStdout.trim()) console.log(rubyStdout.trim());
  if (rubyStderr.trim()) console.error(rubyStderr.trim());

  let rubyReport = null;
  let rubyError = ruby.error?.message || null;
  try {
    rubyReport = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIRECTORY, 'ruby.json'), 'utf8'));
  } catch (parseError) {
    rubyError ??= `Ruby coverage report was unavailable: ${parseError.message}`;
  }
  const rubyPassed = ruby.status === 0 && rubyReport?.passed === true && !rubyError;
  evidence.push({
    id: 'ruby',
    label: rubyReport?.label || 'Ruby production code loaded by the complete Minitest suite',
    scope: rubyReport?.scope || null,
    thresholds: rubyReport?.thresholds || null,
    metrics: rubyReport?.metrics || null,
    passed: rubyPassed,
    exit_code: ruby.status,
    error: rubyError,
  });
  writeSummary(evidence);
  if (!rubyPassed) {
    failed = true;
    console.error('Ruby coverage failed; inspect coverage/ruby.tap and coverage/ruby.json.');
  }

  if (failed) return 1;
  console.log('\nAll reviewed Node and Ruby coverage floors passed. Evidence: coverage/summary.json\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
