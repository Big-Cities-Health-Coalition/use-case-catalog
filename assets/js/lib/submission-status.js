// The pure half of the /status/ page: what a GitHub issue says about a submission.
//
// Nothing here touches the DOM, `fetch` or `location` (assets/js/status-page.js owns
// all three), so the rules that decide what the page SAYS are unit-tested in node
// (test/scripts/submission_status.test.mjs).
//
// The contract with the issue automation: a submission issue carries one `content:*`
// label naming what kind of submission it is, and exactly one `status:*` label naming
// where it stands (STATUS_LABELS below). An issue from before the status labels existed
// has none, so its stage is worked out from the issue's open/closed state instead and
// flagged as `derived`, which the page shows as a best guess.

/** Stage ids keyed by the status label that names them. Do not rename: the automation writes these. */
export const STATUS_LABELS = Object.freeze({
  'status:received': 'received',
  'status:in-review': 'in-review',
  'status:changes-requested': 'changes-requested',
  'status:published': 'published',
  'status:declined': 'declined',
});

/** Every stage the page can show: the five the labels name, plus `closed` for an unlabelled issue closed for a reason we cannot read. */
export const STAGES = Object.freeze([
  'received',
  'in-review',
  'changes-requested',
  'published',
  'declined',
  'closed',
]);

/**
 * Which label wins if an issue ever carries more than one status label (the contract
 * says it never should): the stage furthest along, so a stale `status:received` left
 * behind next to `status:published` cannot drag the page backwards.
 */
const PRECEDENCE = ['published', 'declined', 'changes-requested', 'in-review', 'received'];

/**
 * The steps the indicator shows for each stage, in order. "Changes requested" only
 * appears when it is happening; a declined or closed submission never reached
 * "Published", so that step is replaced rather than shown as missed.
 */
const TRACKS = {
  received: ['received', 'in-review', 'published'],
  'in-review': ['received', 'in-review', 'published'],
  'changes-requested': ['received', 'in-review', 'changes-requested', 'published'],
  published: ['received', 'in-review', 'published'],
  declined: ['received', 'declined'],
  closed: ['received', 'closed'],
};

/** GitHub issue numbers are positive 32-bit integers. */
export const MAX_ISSUE_NUMBER = 2147483647;

/**
 * Read a typed or linked submission number.
 * @param {unknown} value what the reader typed, or the `?n=` parameter. A leading `#`
 *   (the way GitHub writes issue numbers) and surrounding spaces are allowed.
 * @returns {number|null} the issue number, or null when it is not a positive whole number.
 */
export function parseIssueNumber(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^#\s*/, '');
  if (!/^\d{1,10}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= MAX_ISSUE_NUMBER ? number : null;
}

/**
 * Whether `value` is an `owner/repo` pair GitHub could host. Checked before it is
 * put into a URL, since it comes from page markup rather than from code.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRepository(value) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(String(value ?? ''));
  return Boolean(match) && match[2] !== '.' && match[2] !== '..';
}

/** @param {string} repo `owner/repo` @param {number} number @returns {string} the REST API address */
export function issueApiUrl(repo, number) {
  return `https://api.github.com/repos/${repo}/issues/${number}`;
}

/** @param {string} repo `owner/repo` @param {number} number @returns {string} the issue's page on GitHub */
export function issueHtmlUrl(repo, number) {
  return `https://github.com/${repo}/issues/${number}`;
}

/**
 * The repository's issue list filtered to the signed-in reader's own issues: the way to
 * a submission whose number has been lost.
 * @param {string} repo `owner/repo`
 * @returns {string}
 */
export function mySubmissionsUrl(repo) {
  return `https://github.com/${repo}/issues?q=${encodeURIComponent('is:issue author:@me')}`;
}

/**
 * Lowercased label names. The API returns label objects; strings are accepted too.
 * @param {object} issue
 * @returns {string[]}
 */
function labelNames(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels
    .map((label) => (typeof label === 'string' ? label : typeof label?.name === 'string' ? label.name : ''))
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an issue is a submission: an issue rather than a pull request, carrying a
 * `content:*` label.
 * @param {object} issue an issue object from the GitHub REST API
 * @returns {boolean}
 */
export function isSubmission(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(issue, 'pull_request')) return false;
  return labelNames(issue).some((name) => name.startsWith('content:') && name.length > 'content:'.length);
}

/**
 * Where a submission stands.
 *
 * The status label is the answer when there is one. Without one, the issue's state is
 * the best guess: open means it is still waiting (received); closed as completed means
 * it was merged and published; closed as not planned (or as a duplicate) means it was
 * not published; closed for any other reason, or none recorded, is reported as closed.
 *
 * @param {object} issue an issue object from the GitHub REST API
 * @returns {{stage: string, derived: boolean}} `derived` is true when no status label was found.
 */
export function stageFor(issue) {
  const labelled = labelNames(issue)
    .map((name) => STATUS_LABELS[name])
    .filter(Boolean);
  if (labelled.length > 0) {
    return { stage: PRECEDENCE.find((stage) => labelled.includes(stage)), derived: false };
  }
  if (issue?.state !== 'closed') return { stage: 'received', derived: true };
  if (issue.state_reason === 'completed') return { stage: 'published', derived: true };
  if (issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate') {
    return { stage: 'declined', derived: true };
  }
  return { stage: 'closed', derived: true };
}

/**
 * The step indicator for a stage.
 *
 * Each step is `done`, `current` or `upcoming`, and exactly one step is `current: true`
 * (the one to mark with aria-current). A published submission's current step is also
 * `done`: it has nothing left to wait for.
 *
 * @param {string} stage one of STAGES
 * @returns {{id: string, state: 'done'|'current'|'upcoming', current: boolean}[]}
 */
export function stepsFor(stage) {
  const track = TRACKS[stage] || TRACKS.received;
  const at = track.indexOf(stage) === -1 ? 0 : track.indexOf(stage);
  return track.map((id, index) => {
    if (index < at) return { id, state: 'done', current: false };
    if (index > at) return { id, state: 'upcoming', current: false };
    return { id, state: stage === 'published' ? 'done' : 'current', current: true };
  });
}

/**
 * Only an `https://github.com/` address is used as a link; anything else the API
 * returns is replaced with the address built from the repository and number.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function safeGithubUrl(value, fallback) {
  return typeof value === 'string' && value.startsWith('https://github.com/') ? value : fallback;
}

/**
 * Turn an API response into what the page should say.
 *
 * - `submission`: an issue with a content label; carries the stage and what to show.
 * - `not-submission`: a pull request, or an issue that is not a submission.
 * - `not-found`: 404 (no such number) or 410 (deleted).
 * - `rate-limited`: 403 or 429, GitHub's answers when the anonymous hourly allowance
 *   for this reader's address is used up.
 * - `unavailable`: any other status, or a body that is not an issue.
 *
 * @param {number} status HTTP status
 * @param {unknown} body the parsed JSON body (only read for a 200)
 * @param {{repo: string, number: number}} lookup what was asked for
 * @returns {object}
 */
export function interpretResponse(status, body, { repo, number }) {
  const githubUrl = issueHtmlUrl(repo, number);
  if (status === 404 || status === 410) return { kind: 'not-found', number, githubUrl };
  if (status === 403 || status === 429) return { kind: 'rate-limited', number, githubUrl };
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unavailable', number, githubUrl };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pull_request')) {
    return { kind: 'not-submission', reason: 'pull-request', number, githubUrl };
  }
  if (!isSubmission(body)) return { kind: 'not-submission', reason: 'not-labelled', number, githubUrl };
  const { stage, derived } = stageFor(body);
  return {
    kind: 'submission',
    number,
    stage,
    derived,
    title: typeof body.title === 'string' ? body.title.trim() : '',
    created: typeof body.created_at === 'string' ? body.created_at : '',
    githubUrl: safeGithubUrl(body.html_url, githubUrl),
  };
}

/**
 * A timestamp as "March 4, 2026", in the reader's time zone. The site's copy is
 * English, so the month names are too.
 * @param {string} iso
 * @returns {string} '' when the value is not a date.
 */
export function formatDate(iso) {
  const date = new Date(String(iso ?? ''));
  if (!iso || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
