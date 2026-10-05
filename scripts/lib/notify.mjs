/**
 * What the automation tells a submitter, and which status their issue is in.
 *
 * Submitters do not watch the draft pull request (the automation authored it,
 * so GitHub never subscribed them), but GitHub emails every comment on their
 * own issue to them. So every step of a submission's life is a comment on the
 * issue, and every comment is built here: one module, so the wording a
 * deployment sets in `_data/site.yml` `notifications:` reaches every workflow,
 * and so a future email transport can send the same text.
 *
 * Everything here is pure: no filesystem, no network, no environment. The
 * GitHub side (reading the YAML, posting, labelling) is
 * scripts/lib/notify_github.mjs. See test/scripts/notify.test.mjs.
 *
 * Status labels go on the submission issue, and exactly one is present at a
 * time. The /status/ page reads them, so the names are a contract.
 */

/** The five status labels, in the order a submission moves through them. */
export const STATUS = Object.freeze({
  received: 'status:received',
  inReview: 'status:in-review',
  changesRequested: 'status:changes-requested',
  published: 'status:published',
  declined: 'status:declined',
});

/** Every label the notifier creates on demand; bootstrap-labels.yml carries the same table. */
export const NOTIFY_LABELS = Object.freeze([
  {
    name: STATUS.received,
    color: '0969DA',
    description: 'Submission received; waiting for its draft or for triage',
  },
  {
    name: STATUS.inReview,
    color: '6E40C9',
    description: 'A draft pull request is open and with the reviewers',
  },
  {
    name: STATUS.changesRequested,
    color: 'D4A72C',
    description: 'Waiting on the submitter: the reviewer asked for changes',
  },
  { name: STATUS.published, color: '1A7F37', description: 'Merged and live on the site' },
  {
    name: STATUS.declined,
    color: '9E6A03',
    description: 'Not published; the reason is on the draft pull request',
  },
  {
    name: 'needs-triage',
    color: 'BF8700',
    description: 'Opened outside the submission forms; a maintainer needs to read it',
  },
]);

/** The label `missing-label.yml` puts on an issue no form claimed. */
export const TRIAGE_LABEL = 'needs-triage';

/** The intake label that marks an entry submission and its draft pull request. */
export const ENTRY_LABEL = 'content:new-entry';

/**
 * Every submission form's intake label. The form puts it on the issue, and the
 * form's workflow puts the same label on the draft pull request it opens and
 * sets the issue's status. Closing any of these drafts without a merge is a
 * decline (submission-status.yml); the review stages in between are tracked
 * for entries only. All start with `content:`, the prefix the workflow's `if`
 * filters on (test/scripts/notify_workflows.test.mjs checks both, and that
 * bootstrap-labels.yml creates exactly these).
 */
export const INTAKE_LABELS = Object.freeze([
  ENTRY_LABEL,
  'content:new-event',
  'content:new-year',
  'content:schedule',
  'content:event-attachments',
  'content:refresh',
  'content:also-deployed-by',
  'content:site-config',
]);

/** Review-tier labels the stage workflow (submission-status.yml) acts on. */
export const REVIEW_LABELS = Object.freeze({
  revisions: 'review:revisions-requested',
  committee: 'review:committee',
  partner: 'review:partner',
  declined: 'review:declined',
});

/** Statuses a submission does not leave by a review-stage event. */
const TERMINAL = new Set([STATUS.published, STATUS.declined]);

/**
 * The default wording. A deployment overrides any of these by key under
 * `notifications.messages` in `_data/site.yml`.
 *
 * Placeholders are `{name}`. Paragraphs are separated by a blank line, and a
 * paragraph is left out when every placeholder in it is empty, so
 * "**How long it takes:** {turnaround}" disappears on a site that promises no
 * turnaround. Kept short and plain: the readers are public health staff who
 * may never have used GitHub, and every one of these arrives as an email.
 */
export const DEFAULT_MESSAGES = Object.freeze({
  status_help:
    'You can follow along right here on this issue. GitHub emails you each time we post an update, so there is no need to keep checking.',
  status_page: 'You can also check where it stands at any time: {status_url}',
  draft_ready: [
    'Thank you! We received your submission. Its number is **{number}**.',
    '**What happens next:** a reviewer will read the draft we made from your answers, and may ask you a question here or on the draft. Nothing is published until a reviewer approves it. Here is the draft: {pr_url}',
    '{details}',
    '**How long it takes:** {turnaround}',
    '{status_help}',
    'Need to change an answer? Edit this issue and we will update the draft.',
  ].join('\n\n'),
  draft_updated: [
    'We updated the draft from your edit: {pr_url}',
    '{details}',
    'Nothing is published until a reviewer approves it.',
  ].join('\n\n'),
  draft_mention: [
    '@{author} this is the draft of your submission **{number}**. Your reviewer will leave notes and questions here, and GitHub will email you when they do. You are welcome to reply here too.',
  ].join('\n\n'),
  scaffold_failed: [
    'Thank you! We received your submission. Its number is **{number}**.',
    'We could not turn it into a draft yet. Here is what went wrong:',
    '{reason}',
    'Please edit this issue to fix it and we will try again. If the message above does not say what to change, add a comment here and a maintainer will help.',
    '{status_help}',
  ].join('\n\n'),
  pr_failed: [
    'We received your submission (**{number}**) and nothing has been lost, but we could not open its draft, so nothing has been published yet.',
    'For the maintainers: the usual cause is one repository setting. Open **Settings → Actions → General → Workflow permissions** and tick **Allow GitHub Actions to create and approve pull requests**. Once that is on, edit this issue to try again. The full run is in the [Actions tab]({actions_url}).',
    '{status_help}',
  ].join('\n\n'),
  paused: [
    'Thank you! We received your submission. Its number is **{number}**.',
    'Automatic drafts are paused right now, so a maintainer will handle this one by hand. There is nothing more you need to do, and everything you wrote is saved on this issue.',
    '**How long it takes:** {turnaround}',
    '{status_help}',
  ].join('\n\n'),
  no_change: [
    'Thank you! We received this. Its number is **{number}**.',
    'Nothing needed changing, so there is no draft to review:',
    '{reason}',
    'Edit this issue if you would like us to try again.',
    '{status_help}',
  ].join('\n\n'),
  handed_over: [
    'Thank you! We received this. Its number is **{number}**.',
    'A maintainer will read what you reported and update the entry. Nothing on the site changes until they do.',
    '{details}',
    '{status_help}',
  ].join('\n\n'),
  triage_ack: [
    'Thank you for getting in touch! We received this. Its number is **{number}**.',
    'A maintainer will read it and reply here. There is nothing more you need to do right now.',
    '{status_help}',
  ].join('\n\n'),
  label_missing: [
    'Thank you! We received this. Its number is **{number}**.',
    "It looks like a **{form_name}** submission, but the label the automation needs is missing, usually because the repository's labels were never set up.",
    'For the maintainers: run **Actions → Bootstrap labels → Run workflow** once, then add the `{form_label}` label to this issue. Adding the label by itself will not start anything, because every content workflow watches for the issue being opened or edited, not labelled. So make any small edit to the issue afterward (open it, add a space, save) to wake it up. Closing this issue and asking for the form to be resubmitted works too, now that the label exists.',
    'Nothing you wrote is lost. It is all saved on this issue.',
    '{status_help}',
  ].join('\n\n'),
  changes_requested: [
    'Your reviewer has a few requests before **{number}** can be published.',
    '**Where to find their notes:** {notes_url}',
    '**How to update your submission:** edit this issue (choose **Edit** from the **...** menu at the top of your first post), change your answers, and save. Or reply on the draft and your reviewer will make the changes for you.',
    '{status_help}',
  ].join('\n\n'),
  with_committee: [
    'Good news: **{number}** passed the first check and is now with the {reviewers} for a closer look.',
    '{status_help}',
  ].join('\n\n'),
  with_partner: [
    'An update on **{number}**: it is now with the {reviewers} for an outside check. This is a normal step for some submissions.',
    '{status_help}',
  ].join('\n\n'),
  declined: [
    'Thank you for sharing **{number}** with us. After review, we are not able to publish it.',
    'Your reviewer explains why on the draft: {pr_url}',
    '**If you disagree:** {appeal}',
    'We are closing this issue now. You are always welcome to revise your submission and send it again.',
  ].join('\n\n'),
  published: ['Your entry is now live at {page_url}', 'Thank you for contributing it.'].join('\n\n'),
  edit_held: [
    'Thank you, we got your changes to **{number}**.',
    'Your reviewer had already made edits to the draft, so we did not replace it. We have passed your new answers to them, and they will add them by hand.',
    '{status_help}',
  ].join('\n\n'),
  edit_summary: [
    'The submitter edited issue **{number}** after this draft was changed by hand, so the automation did not rebuild the branch. Rebuilding would have erased those commits.',
    '**What changed in their answers:**',
    '{changes}',
    'Please apply what should be kept, then carry on with the review.',
  ].join('\n\n'),
});

/** The appeal line when neither site.yml nor a published appeals policy gives one. */
export const DEFAULT_APPEAL =
  'reply on this issue and ask for the decision to be looked at again. A maintainer will pick it up.';

/** Who `review:committee` and `review:partner` hand a submission to, unless site.yml names them. */
export const DEFAULT_REVIEWERS = Object.freeze({
  committee: 'review committee',
  partner: 'partner reviewers',
});

/**
 * Every placeholder the default messages use. One a caller does not pass reads
 * as empty, so its paragraph drops out (a draft link step with no `details`),
 * instead of reaching the submitter as a literal "{details}". A name that is
 * not in this list, such as a typo in a site.yml override, is still left as
 * written.
 */
const KNOWN_PLACEHOLDERS = Object.freeze([
  ...new Set(
    Object.values(DEFAULT_MESSAGES).flatMap((template) =>
      [...template.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])
    )
  ),
]);

/** Placeholders whose value is quoted (`> `) rather than inserted as written. */
const QUOTED = new Set(['reason']);

/** An absolute https URL the comment can embed without breaking out of the attribute. */
const SAFE_HTTPS = /^https:\/\/[^\s"'<>]+$/;

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The address the site is served from, worked out the way pages.yml's
 * "Resolve site URL" step does it, so a link in a comment matches the deploy.
 *
 * @param {{configUrl?: string, cname?: string, repository?: string}} options
 *   `_config.yml` `url`, the CNAME file's contents, and "owner/repo"
 * @returns {string} no trailing slash; '' when it cannot be known
 */
export function siteUrl({ configUrl = '', cname = '', repository = '' } = {}) {
  const [owner = '', name = ''] = String(repository).split('/');
  const domain = String(cname).replace(/\s+/g, '');
  let url;
  let baseurl = '';
  if (domain) url = `https://${domain}`;
  else if (name.endsWith('.github.io')) url = `https://${name}`;
  else if (owner && name) {
    url = `https://${owner}.github.io`;
    baseurl = `/${name}`;
  } else return '';
  // pages.yml lets an explicit url win but keeps the derived baseurl.
  if (text(configUrl)) url = text(configUrl);
  return `${url.replace(/\/+$/, '')}${baseurl}`;
}

/**
 * Whether the /status/ page is on. It matches `_plugins/modules.rb`, which
 * builds a module's pages unless its key is explicitly `false`, so a
 * `site.yml` written before the status module existed still gets the link.
 *
 * @param {object} site parsed `_data/site.yml`
 * @returns {{enabled: boolean, path: string}}
 */
export function statusPage(site = {}) {
  return { enabled: site?.modules?.status !== false, path: '/status/' };
}

/**
 * The first paragraph of a markdown block, on one line.
 * @param {unknown} value
 * @returns {string}
 */
function firstParagraph(value) {
  return text(value)
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Everything the messages need from the site's configuration, resolved once.
 *
 * @param {object} options
 * @param {object} [options.site] parsed `_data/site.yml`
 * @param {object} [options.governance] parsed `_data/governance.yml`
 * @param {object} [options.config] parsed `_config.yml`
 * @param {string} [options.cname] the CNAME file, when there is one
 * @param {string} [options.repository] "owner/repo"
 * @returns {{siteName: string, siteUrl: string, statusUrlBase: string, turnaround: string,
 *   appeal: string, reviewers: {committee: string, partner: string}, logo: string,
 *   logoAlt: string, messages: Record<string, string>, warnings: string[]}}
 */
export function resolveSettings({
  site = {},
  governance = {},
  config = {},
  cname = '',
  repository = '',
} = {}) {
  const block = isObject(site?.notifications) ? site.notifications : {};
  const warnings = [];
  const base = siteUrl({ configUrl: config?.url, cname, repository });
  const page = statusPage(site);

  const messages = { ...DEFAULT_MESSAGES };
  if (isObject(block.messages)) {
    for (const [kind, value] of Object.entries(block.messages)) {
      if (!Object.hasOwn(DEFAULT_MESSAGES, kind)) {
        warnings.push(`notifications.messages.${kind} is not a message the automation sends; it is ignored.`);
      } else if (text(value)) {
        messages[kind] = String(value);
      }
    }
  }

  // The appeals policy is only quoted while the governance page is published:
  // `eject:samples` switches the module off because the shipped text is an
  // invented community's, not this site's.
  const policies = Array.isArray(governance?.policies) ? governance.policies : [];
  const appealsPolicy =
    site?.modules?.governance === false ? null : policies.find((p) => p?.id === 'appeals');
  const appeal = text(block.appeal) || firstParagraph(appealsPolicy?.body) || DEFAULT_APPEAL;

  let logo = text(block.logo);
  if (logo.startsWith('/') && !logo.startsWith('//') && base) logo = `${base}${logo}`;
  if (logo && !SAFE_HTTPS.test(logo)) {
    warnings.push('notifications.logo must be an https:// address or a site path; it is left out.');
    logo = '';
  }

  const reviewers = isObject(block.reviewers) ? block.reviewers : {};
  return {
    siteName: text(site?.name),
    siteUrl: base,
    statusUrlBase: page.enabled && base ? `${base}${page.path}` : '',
    turnaround: text(block.turnaround) || text(site?.submit?.turnaround),
    appeal,
    reviewers: {
      committee: text(reviewers.committee) || DEFAULT_REVIEWERS.committee,
      partner: text(reviewers.partner) || DEFAULT_REVIEWERS.partner,
    },
    logo,
    logoAlt: text(block.logo_alt) || text(site?.name),
    messages,
    warnings,
  };
}

/**
 * The status page address for one submission, or '' when the page is off.
 * @param {{statusUrlBase?: string}} settings
 * @param {number|string} number
 * @returns {string}
 */
export function statusUrl(settings, number) {
  const n = String(number ?? '').replace(/^#/, '');
  if (!settings?.statusUrlBase || !/^\d+$/.test(n)) return '';
  return `${settings.statusUrlBase}?n=${n}`;
}

/**
 * Fill a template: `{name}` placeholders, paragraph by paragraph, dropping a
 * paragraph whose placeholders are all empty. An unknown placeholder is left
 * as written, so a typo in a site.yml override shows up in the comment rather
 * than silently eating a sentence.
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export function fill(template, values) {
  const out = [];
  for (const paragraph of String(template)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)) {
    const names = [...paragraph.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
    const empty = (name) => Object.hasOwn(values, name) && String(values[name] ?? '').trim() === '';
    if (names.length > 0 && names.every(empty)) continue;
    const filled = paragraph.replace(/\{([a-z_]+)\}/g, (whole, name) =>
      Object.hasOwn(values, name) ? String(values[name] ?? '') : whole
    );
    if (filled.trim()) out.push(filled.trim());
  }
  return out.join('\n\n');
}

/**
 * Quote text as a markdown blockquote, every line prefixed, so nothing in it
 * can stand on a line of its own (the duplicate-comment marker relies on that).
 * @param {unknown} value
 * @returns {string}
 */
export function quote(value) {
  const body = String(value ?? '').trim();
  return body ? `> ${body.replace(/\r\n?/g, '\n').split('\n').join('\n> ')}` : '';
}

/**
 * The hidden line that lets a re-run find the comment it already posted.
 * @param {string} id
 * @returns {string}
 */
export function marker(id) {
  return `<!-- phct-notify:${String(id).replace(/[^\w:.-]/g, '')} -->`;
}

/**
 * Whether a comment body carries this marker on a line of its own. Values
 * quoted from an issue are flattened or line-prefixed before they reach a
 * comment, so a submitter cannot plant a marker that suppresses a message.
 * @param {string} body
 * @param {string} id
 * @returns {boolean}
 */
export function hasMarker(body, id) {
  const wanted = marker(id);
  return String(body ?? '')
    .split(/\r?\n/)
    .some((line) => line.trim() === wanted);
}

/**
 * Build one message.
 *
 * @param {string} kind a key of DEFAULT_MESSAGES
 * @param {Record<string, unknown>} vars per-message values (`number`, `pr_url`, ...)
 * @param {ReturnType<typeof resolveSettings>} settings
 * @returns {string} markdown, logo first when one is configured
 */
export function render(kind, vars = {}, settings = resolveSettings()) {
  const template = settings.messages?.[kind] ?? DEFAULT_MESSAGES[kind];
  if (typeof template !== 'string') throw new Error(`Unknown notification "${kind}".`);
  const number = String(vars.number ?? '').replace(/^#/, '');
  const link = vars.status_url === undefined ? statusUrl(settings, number) : String(vars.status_url ?? '');
  const help = [
    fill(settings.messages?.status_help ?? DEFAULT_MESSAGES.status_help, {}),
    link ? fill(settings.messages?.status_page ?? DEFAULT_MESSAGES.status_page, { status_url: link }) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const values = {
    ...Object.fromEntries(KNOWN_PLACEHOLDERS.map((name) => [name, ''])),
    site_name: settings.siteName ?? '',
    turnaround: settings.turnaround ?? '',
    appeal: settings.appeal ?? DEFAULT_APPEAL,
    reviewers: (kind === 'with_partner' ? settings.reviewers?.partner : settings.reviewers?.committee) ?? '',
    status_help: help,
    ...vars,
    number: number ? `#${number}` : '',
    status_url: link,
  };
  for (const name of QUOTED) if (Object.hasOwn(values, name)) values[name] = quote(values[name]);
  if (Object.hasOwn(values, 'author') && !LOGIN.test(String(values.author))) values.author = '';

  const body = fill(template, values);
  if (!settings.logo) return body;
  const alt = String(settings.logoAlt ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<img src="${settings.logo}" alt="${alt}" height="48">\n\n${body}`;
}

/**
 * Which labels to add and remove so `target` is the one status on the issue.
 * Any `status:*` label counts, so a stray hand-made one is cleared too.
 * @param {string[]} current label names on the issue
 * @param {string} target one of STATUS
 * @returns {{add: string[], remove: string[]}}
 */
export function statusLabelPlan(current, target) {
  if (!Object.values(STATUS).includes(target)) throw new Error(`Unknown status label "${target}".`);
  const names = (Array.isArray(current) ? current : []).map(String);
  return {
    add: names.includes(target) ? [] : [target],
    remove: names.filter((name) => name.startsWith('status:') && name !== target),
  };
}

/**
 * The status label on an issue, '' when there is none.
 * @param {string[]} labels
 * @returns {string}
 */
export function currentStatus(labels) {
  return (
    (Array.isArray(labels) ? labels : []).map(String).find((name) => Object.values(STATUS).includes(name)) ??
    ''
  );
}

/**
 * Whether a review-stage event may move the issue to `target`. A published or
 * declined submission is not pulled back into review by a label shuffle on a
 * closed pull request; the final outcomes always apply.
 * @param {string} current
 * @param {string} target
 * @returns {boolean}
 */
export function mayMoveTo(current, target) {
  return TERMINAL.has(target) || !TERMINAL.has(current);
}

/**
 * The issue a pull request closes, from the "Closes #N" line the scaffolder
 * writes into its body (the same pattern pages.yml's announce job reads).
 * @param {unknown} body
 * @returns {number|null}
 */
export function linkedIssue(body) {
  const match = /(?:^|\s)(?:closes|fixes|resolves)\s+#(\d+)\b/i.exec(String(body ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The number at the end of a pull request URL.
 * @param {unknown} url
 * @returns {number|null}
 */
export function pullNumber(url) {
  const match = /\/pull\/(\d+)\/?$/.exec(String(url ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Who may ask a submitter for changes with a review: the repository's owner,
 * members of the organization that owns it, and its collaborators. On a public
 * repository anyone can submit a review that "requests changes", and it would
 * otherwise email the submitter a link to a stranger's comment.
 */
export const MAINTAINER_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Repository roles that cannot label or close a pull request. GitHub already
 * requires triage access for both, so this is a second check, not the only
 * one: any other role (triage and up, or an organization's custom role) passes.
 */
const NO_TRIAGE_ROLES = new Set(['read', 'none']);

/**
 * What one event on a submission's draft pull request means for its issue.
 *
 * Closing a draft, merged or not, counts for every intake form's draft (one
 * carrying a label in INTAKE_LABELS). The review stages (review labels, a
 * review asking for changes) count for entry drafts only.
 *
 * The event says what woke the run; the pull request's labels and state say
 * where the submission stands. Runs for one pull request queue behind each
 * other and GitHub keeps only the newest waiting one, so a run can stand in
 * for an event that never got its own. So the status comes from the labels:
 * `review:declined` on the draft means declined, `review:revisions-requested`
 * means changes requested (or a maintainer's review asking for changes, which
 * leaves no label), anything else means in review. `review:committee` and
 * `review:partner` each tell the submitter once, whichever run sees them first.
 *
 * @param {string} eventName `pull_request` or `pull_request_review`
 * @param {object} payload the webhook payload
 * @param {{pull?: object, senderRole?: string}} [current] what the caller read
 *   just now: `pull`, the pull request (its labels, state and body win over
 *   the payload's snapshot); `senderRole`, the sender's role on the repository
 *   (`role_name` from the collaborator permission API), when it could be read
 * @returns {{skip: string} | {issue: number, intake: string, status: string, kind?: string,
 *   once?: boolean, onlyOnStatusChange?: boolean, close?: boolean,
 *   supersedable?: boolean, also?: Array<{kind: string, once: true, vars: Record<string, string>}>,
 *   vars?: Record<string, string>}}
 *   `once`: post at most one such comment per issue. `onlyOnStatusChange`:
 *   post only when the status actually moves (a label and a review asking for
 *   the same changes arrive together; the submitter needs one email).
 *   `supersedable`: a close without `review:declined`, which is a decline only
 *   if no other draft for the issue is still open (the caller checks).
 *   `also`: once-only messages for review labels already on the draft.
 *   `intake`: the draft's intake label; the caller checks the issue carries it.
 */
export function stageDecision(eventName, payload = {}, { pull, senderRole } = {}) {
  const pr = payload?.pull_request;
  if (!pr) return { skip: 'not a pull request event' };
  const state = pull ?? pr;
  const action = String(payload.action ?? '');
  const label = String(payload.label?.name ?? '');
  const names = (state.labels ?? []).map((item) => (typeof item === 'string' ? item : item?.name));
  // Without a fresh read, the event's own label is the newest fact there is.
  const labels = new Set(names);
  if (!pull && label && action === 'labeled') labels.add(label);
  if (!pull && label && action === 'unlabeled') labels.delete(label);

  // An entry draft is an entry draft whatever else it carries.
  const intake = INTAKE_LABELS.find((name) => labels.has(name));
  if (!intake) return { skip: "the pull request is not labelled with a submission form's intake label" };
  const repo = payload.repository?.full_name;
  if (!repo || pr.head?.repo?.full_name !== repo) return { skip: 'the pull request comes from a fork' };
  const issue = linkedIssue(state.body);
  if (!issue) return { skip: 'the pull request body names no "Closes #N" issue' };

  const isPull = eventName === 'pull_request';
  const isReview = eventName === 'pull_request_review';
  if (intake !== ENTRY_LABEL && !(isPull && action === 'closed')) {
    return {
      skip: `only closing a ${intake} draft changes its issue's status; review stages are for entries`,
    };
  }
  const relevant =
    (isPull && action === 'closed') ||
    isReview ||
    (isPull && action === 'labeled' && Object.values(REVIEW_LABELS).includes(label)) ||
    (isPull && action === 'unlabeled' && label === REVIEW_LABELS.revisions);
  if (!relevant) {
    if (isPull && action === 'labeled')
      return { skip: `the ${label || 'unnamed'} label does not change the status` };
    if (isPull && action === 'unlabeled')
      return { skip: `removing ${label || 'a label'} does not change the status` };
    return { skip: `${eventName} ${action} does not change the status` };
  }

  if (isReview) {
    if (String(payload.review?.state ?? '').toLowerCase() !== 'changes_requested') {
      return { skip: 'the review did not request changes' };
    }
    const association = String(payload.review?.author_association ?? '');
    if (!MAINTAINER_ASSOCIATIONS.includes(association)) {
      return { skip: `the review is by ${association || 'someone'} outside the project, not a maintainer` };
    }
  }
  const bot = payload.sender?.type === 'Bot';
  if (isPull && !bot && NO_TRIAGE_ROLES.has(String(senderRole ?? '').toLowerCase())) {
    return { skip: `${payload.sender?.login || 'the sender'} cannot label or close pull requests here` };
  }

  const prUrl = String(pr.html_url ?? '');
  const declined = {
    issue,
    intake,
    status: STATUS.declined,
    kind: 'declined',
    once: true,
    close: true,
    vars: { pr_url: prUrl },
  };

  if (isPull && action === 'closed') {
    if (state.merged) return { issue, intake, status: STATUS.published };
    return labels.has(REVIEW_LABELS.declined) ? declined : { ...declined, supersedable: true };
  }
  if (state.state === 'closed') {
    // "Add review:declined and close the pull request", in either order: when
    // the label comes second, its run may be the one standing in for the close.
    if (!bot && action === 'labeled' && label === REVIEW_LABELS.declined && !state.merged) return declined;
    return { skip: 'the pull request is already closed' };
  }
  if (bot) return { skip: 'a bot made this change' };
  if (labels.has(REVIEW_LABELS.declined)) return declined;

  // Each tier label tells the submitter once; `postOnce` finds a repeat.
  const tiers = [
    [REVIEW_LABELS.committee, 'with_committee'],
    [REVIEW_LABELS.partner, 'with_partner'],
  ]
    .filter(([name]) => labels.has(name))
    .map(([name, kind]) => ({ name, kind }));
  const triggered = isPull && action === 'labeled' ? tiers.find((tier) => tier.name === label) : undefined;
  const also = (list) =>
    list.length > 0 ? { also: list.map(({ kind }) => ({ kind, once: true, vars: { pr_url: prUrl } })) } : {};

  // A review reaching this line asked for changes and is a maintainer's.
  if (labels.has(REVIEW_LABELS.revisions) || isReview) {
    return {
      issue,
      intake,
      status: STATUS.changesRequested,
      kind: 'changes_requested',
      onlyOnStatusChange: true,
      vars: { notes_url: String((isReview && payload.review?.html_url) || prUrl), pr_url: prUrl },
      ...also(tiers),
    };
  }
  if (triggered) {
    const rest = tiers.filter((tier) => tier !== triggered);
    return {
      issue,
      intake,
      status: STATUS.inReview,
      kind: triggered.kind,
      once: true,
      vars: { pr_url: prUrl },
      ...also(rest),
    };
  }
  return { issue, intake, status: STATUS.inReview, ...also(tiers) };
}
