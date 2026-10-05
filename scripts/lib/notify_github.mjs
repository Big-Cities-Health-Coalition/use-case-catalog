/**
 * The GitHub side of the submitter notifications: read the site's settings,
 * post a comment at most once, keep exactly one status label on the issue.
 *
 * Called from `actions/github-script` steps, which pass in their `github`
 * (an authenticated Octokit), `context` and `core`:
 *
 *     const { pathToFileURL } = require('node:url');
 *     const notify = await import(pathToFileURL(`${process.env.GITHUB_WORKSPACE}/scripts/lib/notify_github.mjs`).href);
 *     await notify.notifyIssue({ github, context, core, kind: 'draft_ready', ... });
 *
 * The workspace is always a checkout of the default branch, never a pull
 * request's code: issue events check out the default branch, and
 * submission-status.yml asks for it by name.
 *
 * The wording lives in scripts/lib/notify.mjs. This module only decides when
 * to post and where. js-yaml is loaded lazily, so `setStatus` works in a job
 * that never ran `npm ci`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { answerChanges, formatChanges } from './answer_changes.mjs';
import { draftsForIssue } from './drafts.mjs';
import {
  INTAKE_LABELS,
  NOTIFY_LABELS,
  STATUS,
  TRIAGE_LABEL,
  currentStatus,
  hasMarker,
  linkedIssue,
  marker,
  mayMoveTo,
  pullNumber,
  render,
  resolveSettings,
  stageDecision,
  statusLabelPlan,
} from './notify.mjs';

export { STATUS } from './notify.mjs';

const quietCore = { info() {}, warning() {}, notice() {} };

/**
 * The person who opened the event's issue, to mention on the draft; '' for a
 * bot or an app, which would only be pinged for nothing.
 * @param {object} context github-script's context
 * @returns {string}
 */
export function submitter(context) {
  const user = context?.payload?.issue?.user;
  return user?.type === 'User' ? String(user.login ?? '') : '';
}

/** @param {Array<string|{name?: string}>} labels @returns {string[]} */
const labelNames = (labels) =>
  (labels ?? []).map((label) => (typeof label === 'string' ? label : String(label?.name ?? '')));

/**
 * Read `_data/site.yml`, `_data/governance.yml`, `_config.yml` and CNAME.
 * A file that is missing or does not parse reads as empty, with a warning:
 * a broken settings file must not cost a submitter their reply.
 * @param {{root?: string, repository?: string, core?: object}} [options]
 * @returns {Promise<ReturnType<typeof resolveSettings>>}
 */
export async function loadSettings({
  root = process.env.GITHUB_WORKSPACE || process.cwd(),
  repository = '',
  core = quietCore,
} = {}) {
  const { load } = await import('js-yaml');
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return {};
    try {
      return load(fs.readFileSync(file, 'utf8')) || {};
    } catch (error) {
      core.warning(
        `Could not read ${relative} (${error.message}); the default notification wording is used.`
      );
      return {};
    }
  };
  const cnameFile = path.join(root, 'CNAME');
  const settings = resolveSettings({
    site: read('_data/site.yml'),
    governance: read('_data/governance.yml'),
    config: read('_config.yml'),
    cname: fs.existsSync(cnameFile) ? fs.readFileSync(cnameFile, 'utf8') : '',
    repository,
  });
  for (const warning of settings.warnings) core.warning(warning);
  return settings;
}

/**
 * The schema's field list, for reading an entry's answers by label.
 * @param {string} root
 * @returns {Promise<object[]>}
 */
async function schemaFields(root) {
  const { load } = await import('js-yaml');
  const schema = load(fs.readFileSync(path.join(root, '_data', 'schema.yml'), 'utf8')) || {};
  return Array.isArray(schema.fields) ? schema.fields : [];
}

/**
 * Make sure a label exists before it is applied: bootstrap-labels.yml is a
 * manual one-time step a fork can skip, and these run unattended.
 * @param {object} github
 * @param {{owner: string, repo: string}} repo
 * @param {string} name
 */
async function ensureLabel(github, { owner, repo }, name) {
  const definition = NOTIFY_LABELS.find((label) => label.name === name);
  if (!definition) return;
  try {
    await github.rest.issues.createLabel({ owner, repo, ...definition });
  } catch (error) {
    if (error?.status !== 422) throw error; // 422 = it already exists
  }
}

/**
 * Put `needs-triage` on the event's issue, creating the label if the
 * repository never ran Bootstrap labels. Best effort, like every label here.
 * @param {{github: object, context: object, core?: object}} options
 */
export async function addTriageLabel({ github, context, core = quietCore }) {
  const { owner, repo } = context.repo;
  try {
    await ensureLabel(github, { owner, repo }, TRIAGE_LABEL);
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: context.issue.number,
      labels: [TRIAGE_LABEL],
    });
  } catch (error) {
    core.warning(
      `Could not add ${TRIAGE_LABEL} to #${context.issue.number} (${error?.status ?? error?.message}).`
    );
  }
}

/**
 * Leave `status` as the one status label on the issue.
 * Best effort: a label that cannot be set is a warning, never a lost reply.
 * @param {{github: object, core?: object, owner: string, repo: string, issueNumber: number,
 *   status: string, labels?: string[]}} options `labels`: the issue's labels, when already read
 * @returns {Promise<{previous: string, changed: boolean, labels: string[]}>}
 */
export async function setStatus({ github, core = quietCore, owner, repo, issueNumber, status, labels }) {
  const issue_number = Number(issueNumber);
  let current = labels;
  if (!current) {
    const { data } = await github.rest.issues.get({ owner, repo, issue_number });
    current = labelNames(data.labels);
  }
  const plan = statusLabelPlan(current, status);
  try {
    for (const name of plan.remove) {
      try {
        await github.rest.issues.removeLabel({ owner, repo, issue_number, name });
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    if (plan.add.length > 0) {
      await ensureLabel(github, { owner, repo }, status);
      await github.rest.issues.addLabels({ owner, repo, issue_number, labels: plan.add });
    }
  } catch (error) {
    core.warning(`Could not set ${status} on #${issue_number} (${error?.status ?? error?.message}).`);
  }
  return {
    previous: currentStatus(current),
    changed: plan.add.length > 0 || plan.remove.length > 0,
    labels: current,
  };
}

/**
 * Post a comment unless this run (or an earlier one, for a once-only message)
 * already did. Only comments a bot wrote count, and only a marker on a line of
 * its own: see `hasMarker`.
 * @returns {Promise<boolean>} true when posted
 */
async function postOnce(github, core, { owner, repo, issue_number }, body, id) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  if (comments.some((comment) => comment?.user?.type === 'Bot' && hasMarker(comment.body, id))) {
    core.info(`#${issue_number} already has the "${id}" comment; not posting it again.`);
    return false;
  }
  await github.rest.issues.createComment({ owner, repo, issue_number, body: `${body}\n\n${marker(id)}` });
  return true;
}

/**
 * Tell a submitter something on their issue, and move its status.
 *
 * @param {object} options
 * @param {object} options.github Octokit from github-script
 * @param {object} options.context github-script's context
 * @param {object} [options.core]
 * @param {number} [options.issueNumber] defaults to the event's issue
 * @param {string} [options.kind] a message in scripts/lib/notify.mjs; omit to only set the status
 * @param {Record<string, string>} [options.vars] values for the message's placeholders
 * @param {string} [options.status] one of STATUS
 * @param {boolean} [options.once] at most one such comment per issue, ever
 * @param {boolean} [options.onlyOnStatusChange] comment only if `status` moved
 * @param {boolean} [options.close] close the issue as "not planned"
 * @param {string} [options.prUrl] the draft pull request
 * @param {string} [options.mention] the submitter's login: mention them once on the draft
 * @param {object} [options.settings] from `loadSettings`, to skip re-reading
 * @param {string[]} [options.labels] the issue's labels, when already read
 * @returns {Promise<{posted: boolean, changed: boolean}>}
 */
export async function notifyIssue({
  github,
  context,
  core = quietCore,
  issueNumber = context?.issue?.number,
  kind = '',
  vars = {},
  status = '',
  once = false,
  onlyOnStatusChange = false,
  close = false,
  prUrl = '',
  mention = '',
  settings,
  labels,
}) {
  const { owner, repo } = context.repo;
  const issue_number = Number(issueNumber);
  let changed = true;
  if (status)
    ({ changed } = await setStatus({ github, core, owner, repo, issueNumber: issue_number, status, labels }));

  let posted = false;
  const needsText = (kind && !(onlyOnStatusChange && !changed)) || (mention && prUrl);
  const resolved = needsText
    ? (settings ?? (await loadSettings({ repository: `${owner}/${repo}`, core })))
    : settings;
  const shared = {
    number: String(issue_number),
    pr_url: prUrl,
    actions_url: `${context.serverUrl || 'https://github.com'}/${owner}/${repo}/actions`,
    ...vars,
  };

  if (kind && onlyOnStatusChange && !changed) {
    core.info(`#${issue_number} was already ${status}; no "${kind}" comment.`);
  } else if (kind) {
    const id = once ? kind : `${kind}:${context.runId}`;
    posted = await postOnce(github, core, { owner, repo, issue_number }, render(kind, shared, resolved), id);
  }

  // Review happens on the draft, which the submitter is not subscribed to. One
  // mention subscribes them; it is posted once, never on a rebuild.
  const pull = pullNumber(prUrl);
  if (mention && pull) {
    const text = render('draft_mention', { ...shared, author: mention }, resolved);
    if (text.includes(`@${mention}`)) {
      await postOnce(github, core, { owner, repo, issue_number: pull }, text, 'draft_mention');
    }
  }

  if (close) {
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number });
    if (issue.state === 'open') {
      await github.rest.issues.update({
        owner,
        repo,
        issue_number,
        state: 'closed',
        state_reason: 'not_planned',
      });
    }
  }
  return { posted, changed };
}

/**
 * The pull request as it is now, and the sender's role on the repository.
 * Both are best effort: the payload is a snapshot that is usually still right,
 * and GitHub already requires triage access to label or close a pull request,
 * so a read that fails costs a warning, never the submitter's update.
 * @returns {Promise<{pull?: object, senderRole?: string}>}
 */
async function readCurrent(github, core, { owner, repo }, eventName, payload) {
  const current = {};
  const number = payload.pull_request?.number;
  if (number) {
    try {
      ({ data: current.pull } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    } catch (error) {
      core.warning(
        `Could not re-read pull request #${number} (${error?.status ?? error?.message}); using the event's copy.`
      );
    }
  }
  const sender = payload.sender;
  if (eventName === 'pull_request' && sender?.type !== 'Bot' && sender?.login) {
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: sender.login,
      });
      current.senderRole = String(data?.role_name || data?.permission || '');
    } catch (error) {
      core.warning(`Could not read ${sender.login}'s role (${error?.status ?? error?.message}).`);
    }
  }
  return current;
}

/**
 * submission-status.yml: one event on a submission's draft pull request.
 * @param {{github: object, context: object, core?: object}} options
 * @returns {Promise<object>} the decision, for the log and the tests
 */
export async function handleStageEvent({ github, context, core = quietCore }) {
  const skipped = (skip) => {
    core.info(`Nothing to do: ${skip}.`);
    return { skip };
  };
  const { eventName, payload } = context;
  const first = stageDecision(eventName, payload);
  if ('skip' in first) return skipped(first.skip);
  const { owner, repo } = context.repo;
  // Decide again on what is true now: this run may have waited behind another.
  const decision = stageDecision(
    eventName,
    payload,
    await readCurrent(github, core, { owner, repo }, eventName, payload)
  );
  if ('skip' in decision) return skipped(decision.skip);

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: decision.issue });
  const labels = labelNames(issue.labels);
  // "Closes #N" is free text a maintainer can mistype; never close or relabel
  // an issue that is not a submission, or that another form's draft serves.
  if (issue.pull_request || (!labels.includes(decision.intake) && !currentStatus(labels))) {
    return skipped(`#${decision.issue} is not a submission issue`);
  }
  if (!labels.includes(decision.intake) && labels.some((name) => INTAKE_LABELS.includes(name))) {
    return skipped(`#${decision.issue} is not a ${decision.intake} submission`);
  }
  const previous = currentStatus(labels);
  if (!mayMoveTo(previous, decision.status)) return skipped(`#${decision.issue} is already ${previous}`);

  // Closing one draft while another for the same issue is still open (a
  // duplicate, or one replaced by hand) is housekeeping, not a decision.
  // `review:declined` on the closed one says otherwise, and stageDecision does
  // not mark that case supersedable.
  if (decision.supersedable) {
    const pulls = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    const others = draftsForIssue(pulls, {
      issue: decision.issue,
      repository: `${owner}/${repo}`,
      label: decision.intake,
      exclude: payload.pull_request?.number,
    });
    if (others.length > 0) {
      return skipped(
        `#${decision.issue} still has an open draft, #${others[0].number}, so this close is not a decline`
      );
    }
  }

  await notifyIssue({
    github,
    context,
    core,
    issueNumber: decision.issue,
    kind: decision.kind ?? '',
    vars: decision.vars ?? {},
    status: decision.status,
    once: decision.once === true,
    onlyOnStatusChange: decision.onlyOnStatusChange === true,
    close: decision.close === true,
    prUrl: decision.vars?.pr_url ?? '',
    labels,
  });
  for (const message of decision.also ?? []) {
    await notifyIssue({
      github,
      context,
      core,
      issueNumber: decision.issue,
      kind: message.kind,
      vars: message.vars,
      once: true,
    });
  }
  return decision;
}

/**
 * An `issues: edited` run whose draft branch a reviewer has committed to: do
 * not rebuild it, tell the reviewer what changed and the submitter that their
 * edit arrived.
 *
 * @param {object} options
 * @param {object} options.github
 * @param {object} options.context
 * @param {object} [options.core]
 * @param {string} options.branch the draft branch
 * @param {boolean} [options.schema] read the answers through _data/schema.yml (entries)
 * @param {string} [options.root]
 * @returns {Promise<{changes: number, pr: number|null}>}
 */
export async function holdEdit({
  github,
  context,
  core = quietCore,
  branch,
  schema = false,
  root = process.env.GITHUB_WORKSPACE || process.cwd(),
}) {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue ?? {};
  const before = context.payload.changes?.body?.from;
  const fields = schema ? await schemaFields(root) : null;
  const changes = typeof before === 'string' ? answerChanges(before, issue.body ?? '', { fields }) : [];
  const titleBefore = context.payload.changes?.title?.from;
  if (typeof titleBefore === 'string' && titleBefore !== issue.title) {
    changes.push({ label: 'Issue title', before: titleBefore, after: String(issue.title ?? '') });
  }
  if (changes.length === 0) {
    core.info('The edit changed none of the answers, so there is nothing to hand to the reviewer.');
    return { changes: 0, pr: null };
  }

  const settings = await loadSettings({ root, repository: `${owner}/${repo}`, core });
  const { data: pulls } = await github.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'open',
    per_page: 1,
  });
  const pull = pulls[0] ?? null;
  if (pull) {
    const body = render(
      'edit_summary',
      { number: String(issue.number), changes: formatChanges(changes) },
      settings
    );
    await postOnce(
      github,
      core,
      { owner, repo, issue_number: pull.number },
      body,
      `edit_summary:${context.runId}`
    );
  } else {
    core.warning(`No open pull request uses ${branch}; the submitter's edit is only on the issue.`);
  }
  await notifyIssue({
    github,
    context,
    core,
    issueNumber: issue.number,
    kind: 'edit_held',
    status: STATUS.inReview,
    prUrl: pull?.html_url ?? '',
    settings,
  });
  return { changes: changes.length, pr: pull?.number ?? null };
}

/**
 * pages.yml's announce job: after a deploy, for each pull request the pushed
 * commit merged that closes an issue, mark the issue published and, when the
 * pull request added an entry, tell the submitter where it is live. Once per
 * issue, however many times the deploy is re-run.
 *
 * An issue is only touched when it already carries a status label or the
 * pull request added an entry page: a maintainer's own pull request that
 * happens to close a bug report is not a submission.
 *
 * @param {object} options
 * @param {object} options.github
 * @param {object} options.context
 * @param {object} [options.core]
 * @param {string} options.pageUrl the deployed site, from actions/deploy-pages
 * @param {string} options.entryPath the schema's `entry.path`
 * @returns {Promise<number[]>} the issues told
 */
export async function announcePublished({ github, context, core = quietCore, pageUrl, entryPath }) {
  const { owner, repo } = context.repo;
  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: context.sha,
  });
  const escaped = String(entryPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filePattern = new RegExp(`^${escaped}/([^/]+)/index\\.md$`);
  const told = [];
  let settings;

  for (const pull of pulls) {
    if (!pull.merged_at) continue;
    // The intake workflows write "Closes #N" into the body they generate,
    // so that is where the submitter's issue number lives.
    const issueNumber = linkedIssue(pull.body);
    if (!issueNumber) continue;
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
    if (issue.pull_request) continue;
    const labels = labelNames(issue.labels);

    let page = '';
    if (pageUrl) {
      const files = await github.paginate(github.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pull.number,
        per_page: 100,
      });
      const added = files
        .filter((file) => file.status === 'added')
        .map((file) => filePattern.exec(file.filename))
        .find(Boolean);
      if (added) page = `${String(pageUrl).replace(/\/$/, '')}/${entryPath}/${added[1]}/`;
    }
    if (!currentStatus(labels) && !page) continue;

    settings ??= page ? await loadSettings({ repository: `${owner}/${repo}`, core }) : undefined;
    await notifyIssue({
      github,
      context,
      core,
      issueNumber,
      kind: page ? 'published' : '',
      once: true,
      status: STATUS.published,
      vars: { page_url: page },
      settings,
      labels,
    });
    told.push(issueNumber);
  }
  return told;
}
