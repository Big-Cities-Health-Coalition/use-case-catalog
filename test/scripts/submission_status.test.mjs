/**
 * The rules behind /status/ (assets/js/lib/submission-status.js): reading the number a
 * submitter types, and turning a GitHub issue into a stage. The page itself is driven
 * through a real DOM in status_page.test.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ISSUE_NUMBER,
  STAGES,
  STATUS_LABELS,
  formatDate,
  interpretResponse,
  isRepository,
  isSubmission,
  issueApiUrl,
  issueHtmlUrl,
  mySubmissionsUrl,
  parseIssueNumber,
  stageFor,
  stepsFor,
} from '../../assets/js/lib/submission-status.js';

/** An issue as the REST API returns it, trimmed to the keys the page reads. */
function issue(overrides = {}) {
  return {
    number: 42,
    title: '[Use case] Permit intake triage',
    state: 'open',
    state_reason: null,
    created_at: '2026-03-04T15:00:00Z',
    html_url: 'https://github.com/owner/repo/issues/42',
    labels: [{ name: 'content:new-entry' }],
    ...overrides,
  };
}

const labels = (...names) => names.map((name) => ({ name }));

/* ------------------------------------------------------------ the number */

test('a submission number is a positive whole number, with or without a leading #', () => {
  assert.equal(parseIssueNumber('42'), 42);
  assert.equal(parseIssueNumber('#42'), 42);
  assert.equal(parseIssueNumber('  # 42 '), 42);
  assert.equal(parseIssueNumber('007'), 7);
  assert.equal(parseIssueNumber(42), 42);
  assert.equal(parseIssueNumber(String(MAX_ISSUE_NUMBER)), MAX_ISSUE_NUMBER);
});

test('anything else is not a number to look up', () => {
  for (const value of [
    '',
    '   ',
    '#',
    '0',
    '#0',
    '-3',
    '4.5',
    '1e3',
    '42abc',
    'abc',
    '4 2',
    '##42',
    '0x10',
    String(MAX_ISSUE_NUMBER + 1),
    '12345678901',
    null,
    undefined,
  ]) {
    assert.equal(parseIssueNumber(value), null, `${JSON.stringify(value)} should be rejected`);
  }
});

test('the repository must look like owner/repo before it goes into a URL', () => {
  assert.equal(isRepository('owner/repo'), true);
  assert.equal(isRepository('Big-Org/use-case.catalog_2'), true);
  for (const value of [
    '',
    'owner',
    'owner/',
    '/repo',
    'owner/repo/extra',
    'own er/repo',
    'owner/..',
    '-x/repo',
    'o/r?x',
  ]) {
    assert.equal(isRepository(value), false, `${value} should be rejected`);
  }
});

test('the addresses: the API, the issue page and the reader’s own submissions', () => {
  assert.equal(issueApiUrl('owner/repo', 7), 'https://api.github.com/repos/owner/repo/issues/7');
  assert.equal(issueHtmlUrl('owner/repo', 7), 'https://github.com/owner/repo/issues/7');
  assert.equal(
    mySubmissionsUrl('owner/repo'),
    'https://github.com/owner/repo/issues?q=is%3Aissue%20author%3A%40me'
  );
});

/* ------------------------------------------------------- what counts */

test('a submission is an issue with a content: label; a pull request never is', () => {
  assert.equal(isSubmission(issue()), true);
  assert.equal(isSubmission(issue({ labels: ['content:refresh'] })), true, 'string labels are read too');
  assert.equal(
    isSubmission(issue({ labels: labels('Content:Also-Deployed-By') })),
    true,
    'case does not matter'
  );
  assert.equal(isSubmission(issue({ labels: [] })), false);
  assert.equal(isSubmission(issue({ labels: labels('bug', 'status:received') })), false);
  assert.equal(isSubmission(issue({ labels: labels('content:') })), false, 'a bare prefix names no kind');
  assert.equal(isSubmission(issue({ labels: undefined })), false);
  assert.equal(isSubmission(issue({ pull_request: { url: 'x' } })), false);
  assert.equal(isSubmission(issue({ pull_request: null })), false, 'the key alone marks a pull request');
  assert.equal(isSubmission(null), false);
});

/* ------------------------------------------------------------ the stage */

test('every status label maps to its stage', () => {
  assert.deepEqual(Object.keys(STATUS_LABELS), [
    'status:received',
    'status:in-review',
    'status:changes-requested',
    'status:published',
    'status:declined',
  ]);
  for (const [label, stage] of Object.entries(STATUS_LABELS)) {
    assert.deepEqual(stageFor(issue({ labels: labels('content:new-entry', label) })), {
      stage,
      derived: false,
    });
    assert.ok(STAGES.includes(stage));
  }
});

test('the status label wins over the open/closed state', () => {
  const closedButLabelled = issue({
    state: 'closed',
    state_reason: 'not_planned',
    labels: labels('content:new-entry', 'status:published'),
  });
  assert.deepEqual(stageFor(closedButLabelled), { stage: 'published', derived: false });
  assert.deepEqual(stageFor(issue({ labels: labels('content:new-entry', 'Status:In-Review') })), {
    stage: 'in-review',
    derived: false,
  });
});

test('two status labels at once (never meant to happen) resolve to the furthest along', () => {
  const stale = issue({ labels: labels('content:new-entry', 'status:received', 'status:published') });
  assert.equal(stageFor(stale).stage, 'published');
  const both = issue({ labels: labels('status:in-review', 'status:changes-requested') });
  assert.equal(stageFor(both).stage, 'changes-requested');
});

test('with no status label the stage is a best guess from the state', () => {
  assert.deepEqual(stageFor(issue()), { stage: 'received', derived: true });
  assert.deepEqual(stageFor(issue({ state: 'closed', state_reason: 'completed' })), {
    stage: 'published',
    derived: true,
  });
  assert.deepEqual(stageFor(issue({ state: 'closed', state_reason: 'not_planned' })), {
    stage: 'declined',
    derived: true,
  });
  assert.deepEqual(stageFor(issue({ state: 'closed', state_reason: 'duplicate' })), {
    stage: 'declined',
    derived: true,
  });
  // Closed with no reason recorded (issues closed before GitHub kept one): we do
  // not know whether it was published, so we do not say.
  assert.deepEqual(stageFor(issue({ state: 'closed', state_reason: null })), {
    stage: 'closed',
    derived: true,
  });
  assert.deepEqual(stageFor(issue({ state: 'open', state_reason: 'reopened' })), {
    stage: 'received',
    derived: true,
  });
});

/* ------------------------------------------------------------ the steps */

const view = (stage) => stepsFor(stage).map((s) => `${s.id}:${s.state}${s.current ? '*' : ''}`);

test('the step indicator for each stage', () => {
  assert.deepEqual(view('received'), ['received:current*', 'in-review:upcoming', 'published:upcoming']);
  assert.deepEqual(view('in-review'), ['received:done', 'in-review:current*', 'published:upcoming']);
  assert.deepEqual(view('changes-requested'), [
    'received:done',
    'in-review:done',
    'changes-requested:current*',
    'published:upcoming',
  ]);
  assert.deepEqual(view('published'), ['received:done', 'in-review:done', 'published:done*']);
  assert.deepEqual(view('declined'), ['received:done', 'declined:current*']);
  assert.deepEqual(view('closed'), ['received:done', 'closed:current*']);
});

test('every stage has exactly one current step, and an unknown stage reads as received', () => {
  for (const stage of STAGES) {
    assert.equal(stepsFor(stage).filter((step) => step.current).length, 1, stage);
  }
  assert.deepEqual(view('mystery'), view('received'));
});

/* ------------------------------------------------------- the response */

const lookup = { repo: 'owner/repo', number: 42 };

test('a 200 for a submission carries what the page shows', () => {
  const outcome = interpretResponse(
    200,
    issue({ labels: labels('content:new-entry', 'status:in-review') }),
    lookup
  );
  assert.deepEqual(outcome, {
    kind: 'submission',
    number: 42,
    stage: 'in-review',
    derived: false,
    title: '[Use case] Permit intake triage',
    created: '2026-03-04T15:00:00Z',
    githubUrl: 'https://github.com/owner/repo/issues/42',
  });
});

test('only a github.com address from the API is used as the link', () => {
  const outcome = interpretResponse(200, issue({ html_url: 'javascript:alert(1)' }), lookup);
  assert.equal(outcome.githubUrl, 'https://github.com/owner/repo/issues/42');
  const missing = interpretResponse(200, issue({ html_url: undefined, title: 42, created_at: null }), lookup);
  assert.equal(missing.githubUrl, 'https://github.com/owner/repo/issues/42');
  assert.equal(missing.title, '', 'a title that is not a string is dropped, not coerced');
  assert.equal(missing.created, '');
});

test('pull requests and unlabelled issues are not submissions', () => {
  assert.deepEqual(interpretResponse(200, issue({ pull_request: {} }), lookup), {
    kind: 'not-submission',
    reason: 'pull-request',
    number: 42,
    githubUrl: 'https://github.com/owner/repo/issues/42',
  });
  assert.equal(interpretResponse(200, issue({ labels: labels('bug') }), lookup).reason, 'not-labelled');
});

test('error statuses: not found, rate limited, and everything else unavailable', () => {
  assert.equal(interpretResponse(404, null, lookup).kind, 'not-found');
  assert.equal(interpretResponse(410, null, lookup).kind, 'not-found');
  assert.equal(interpretResponse(403, null, lookup).kind, 'rate-limited');
  assert.equal(interpretResponse(429, null, lookup).kind, 'rate-limited');
  for (const status of [0, 500, 502, 301]) {
    const outcome = interpretResponse(status, null, lookup);
    assert.equal(outcome.kind, 'unavailable', String(status));
    assert.equal(outcome.githubUrl, 'https://github.com/owner/repo/issues/42', 'the fallback link is built');
  }
  assert.equal(interpretResponse(200, null, lookup).kind, 'unavailable');
  assert.equal(interpretResponse(200, [issue()], lookup).kind, 'unavailable');
  assert.equal(interpretResponse(200, 'not json', lookup).kind, 'unavailable');
});

test('dates read like the rest of the site, and nonsense reads as nothing', () => {
  // Noon UTC is the same calendar day from UTC-12 to UTC+11, wherever the suite runs.
  assert.equal(formatDate('2026-03-04T12:00:00Z'), 'March 4, 2026');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate(undefined), '');
});
