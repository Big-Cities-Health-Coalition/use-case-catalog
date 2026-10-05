/**
 * The submitter-facing messages and the status-label rules
 * (scripts/lib/notify.mjs). The GitHub side is test/scripts/notify_github.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_APPEAL,
  DEFAULT_MESSAGES,
  ENTRY_LABEL,
  MAINTAINER_ASSOCIATIONS,
  NOTIFY_LABELS,
  REVIEW_LABELS,
  STATUS,
  currentStatus,
  fill,
  hasMarker,
  linkedIssue,
  marker,
  mayMoveTo,
  pullNumber,
  quote,
  render,
  resolveSettings,
  siteUrl,
  stageDecision,
  statusLabelPlan,
  statusPage,
  statusUrl,
} from '../../scripts/lib/notify.mjs';

const REPO = 'acme/catalog';
const settingsWithStatus = () =>
  resolveSettings({ site: { name: 'Acme', status: { enabled: true } }, repository: REPO });

test('the five status labels are the contract the /status/ page reads', () => {
  assert.deepEqual(Object.values(STATUS), [
    'status:received',
    'status:in-review',
    'status:changes-requested',
    'status:published',
    'status:declined',
  ]);
  const names = NOTIFY_LABELS.map((label) => label.name);
  for (const status of Object.values(STATUS)) assert.ok(names.includes(status), status);
  for (const label of NOTIFY_LABELS) {
    assert.match(label.color, /^[0-9A-F]{6}$/, `${label.name} color`);
    assert.ok(label.description.length <= 100, `${label.name}: GitHub caps label descriptions at 100`);
  }
});

test('no default message uses an em dash, and every acknowledgement names the issue number', () => {
  for (const [kind, text] of Object.entries(DEFAULT_MESSAGES)) {
    assert.doesNotMatch(text, /—/, `${kind} has an em dash`);
  }
  assert.doesNotMatch(DEFAULT_APPEAL, /—/);
  const acknowledgements = [
    'draft_ready',
    'scaffold_failed',
    'pr_failed',
    'paused',
    'no_change',
    'handed_over',
    'triage_ack',
    'label_missing',
  ];
  for (const kind of acknowledgements) {
    const body = render(
      kind,
      { number: 12, pr_url: 'https://github.com/acme/catalog/pull/13', reason: 'x', details: 'd' },
      settingsWithStatus()
    );
    assert.match(body, /\*\*#12\*\*/, `${kind} names #12`);
    assert.match(body, /GitHub emails you/, `${kind} says GitHub emails updates`);
    assert.match(
      body,
      /https:\/\/acme\.github\.io\/catalog\/status\/\?n=12/,
      `${kind} links the status page`
    );
  }
});

test('draft_ready says what happens next, how long, and where the draft is', () => {
  const settings = resolveSettings({
    site: { submit: { turnaround: 'About two weeks.' } },
    repository: REPO,
  });
  const body = render(
    'draft_ready',
    { number: 7, pr_url: 'https://github.com/acme/catalog/pull/8' },
    settings
  );
  assert.match(body, /What happens next:/);
  assert.match(body, /\*\*How long it takes:\*\* About two weeks\./);
  assert.match(body, /pull\/8/);
  assert.doesNotMatch(body, /\{/, 'no placeholder left unfilled');
  assert.match(body, /check where it stands at any time: https:\/\/acme\.github\.io\/catalog\/status\/\?n=7/);
  const off = resolveSettings({ site: { modules: { status: false } }, repository: REPO });
  assert.doesNotMatch(
    render('draft_ready', { number: 7, pr_url: 'https://github.com/acme/catalog/pull/8' }, off),
    /check where it stands/,
    'no status link while the page is off'
  );
});

test('a paragraph whose placeholders are all empty is dropped, an unknown one is kept as written', () => {
  assert.equal(fill('A\n\n**How long:** {turnaround}\n\nB', { turnaround: '' }), 'A\n\nB');
  assert.equal(fill('Hello {nmae}', { name: 'x' }), 'Hello {nmae}');
  assert.equal(fill('One {a} two {b}', { a: '', b: 'x' }), 'One  two x');
});

test('a quoted reason cannot stand on a line of its own, so it cannot plant a marker', () => {
  const planted = `oops\n${marker('draft_ready')}`;
  const body = render('scaffold_failed', { number: 3, reason: planted }, resolveSettings());
  assert.equal(hasMarker(body, 'draft_ready'), false);
  assert.match(body, /^> oops$/m);
  assert.equal(quote(''), '');
});

test('hasMarker matches only the exact marker on its own line', () => {
  const body = `Hello\n\n${marker('kind:42')}`;
  assert.equal(hasMarker(body, 'kind:42'), true);
  assert.equal(hasMarker(body, 'kind:4'), false);
  assert.equal(hasMarker(`text ${marker('kind:42')}`, 'kind:42'), false);
  assert.equal(marker('a b<c>'), '<!-- phct-notify:abc -->');
});

test('settings: overrides, unknown kinds, appeal, reviewers and a logo', () => {
  const settings = resolveSettings({
    site: {
      name: 'Acme Exchange',
      notifications: {
        messages: { declined: 'Sorry about {number}.', nonsense: 'x', published: '   ' },
        reviewers: { committee: 'steering group' },
        logo: '/assets/images/logo.png',
        appeal: 'email the chair.',
      },
    },
    repository: REPO,
  });
  assert.equal(settings.messages.declined, 'Sorry about {number}.');
  assert.equal(settings.messages.published, DEFAULT_MESSAGES.published, 'a blank override keeps the default');
  assert.deepEqual(settings.warnings, [
    'notifications.messages.nonsense is not a message the automation sends; it is ignored.',
  ]);
  assert.equal(settings.appeal, 'email the chair.');
  assert.equal(settings.reviewers.committee, 'steering group');
  assert.equal(settings.reviewers.partner, 'partner reviewers');
  assert.equal(settings.logo, 'https://acme.github.io/catalog/assets/images/logo.png');

  const body = render('with_committee', { number: 5 }, settings);
  assert.match(
    body,
    /^<img src="https:\/\/acme\.github\.io\/catalog\/assets\/images\/logo\.png" alt="Acme Exchange" height="48">/
  );
  assert.match(body, /with the steering group/);

  const unsafe = resolveSettings({ site: { notifications: { logo: 'javascript:alert(1)' } } });
  assert.equal(unsafe.logo, '');
  assert.equal(unsafe.warnings.length, 1);
});

test('the appeal comes from the published appeals policy, then the default', () => {
  const governance = { policies: [{ id: 'appeals', body: 'Write to the board.\n\nMore detail.' }] };
  assert.equal(resolveSettings({ governance }).appeal, 'Write to the board.');
  assert.equal(
    resolveSettings({ governance, site: { modules: { governance: false } } }).appeal,
    DEFAULT_APPEAL
  );
});

test('site URL and status page follow pages.yml and the status switches', () => {
  assert.equal(siteUrl({ repository: REPO }), 'https://acme.github.io/catalog');
  assert.equal(siteUrl({ repository: 'acme/acme.github.io' }), 'https://acme.github.io');
  assert.equal(siteUrl({ repository: REPO, cname: 'catalog.example.org\n' }), 'https://catalog.example.org');
  assert.equal(siteUrl({ repository: REPO, configUrl: 'https://x.org/' }), 'https://x.org/catalog');
  assert.equal(siteUrl({}), '');

  assert.deepEqual(statusPage({}), { enabled: true, path: '/status/' });
  assert.deepEqual(statusPage({ modules: { status: true } }), { enabled: true, path: '/status/' });
  assert.deepEqual(statusPage({ modules: { status: false } }), { enabled: false, path: '/status/' });

  assert.equal(statusUrl(settingsWithStatus(), '#9'), 'https://acme.github.io/catalog/status/?n=9');
  assert.equal(statusUrl(settingsWithStatus(), 'x'), '');
  assert.equal(
    statusUrl(resolveSettings({ repository: REPO }), 9),
    'https://acme.github.io/catalog/status/?n=9'
  );
  assert.equal(statusUrl(resolveSettings({ repository: REPO, site: { modules: { status: false } } }), 9), '');
});

test('an explicit empty status_url leaves the status link out', () => {
  const body = render('triage_ack', { number: 4, status_url: '' }, settingsWithStatus());
  assert.doesNotMatch(body, /status\//);
});

test('a mention needs a real GitHub login', () => {
  assert.match(render('draft_mention', { number: 1, author: 'jane-doe' }), /^@jane-doe /);
  assert.doesNotMatch(render('draft_mention', { number: 1, author: 'x y' }), /@x/);
  assert.throws(() => render('nope'), /Unknown notification "nope"/);
});

test('exactly one status label at a time', () => {
  assert.deepEqual(statusLabelPlan(['bug', 'status:received', 'status:typo'], STATUS.inReview), {
    add: ['status:in-review'],
    remove: ['status:received', 'status:typo'],
  });
  assert.deepEqual(statusLabelPlan(['status:in-review'], STATUS.inReview), { add: [], remove: [] });
  assert.throws(() => statusLabelPlan([], 'status:other'));
  assert.equal(currentStatus(['x', 'status:declined']), 'status:declined');
  assert.equal(currentStatus([]), '');
});

test('a finished submission is not pulled back into review; final outcomes always apply', () => {
  assert.equal(mayMoveTo(STATUS.published, STATUS.inReview), false);
  assert.equal(mayMoveTo(STATUS.declined, STATUS.changesRequested), false);
  assert.equal(mayMoveTo(STATUS.declined, STATUS.published), true);
  assert.equal(mayMoveTo(STATUS.inReview, STATUS.declined), true);
  assert.equal(mayMoveTo('', STATUS.changesRequested), true);
});

test('linkedIssue and pullNumber read what the workflows write', () => {
  assert.equal(linkedIssue('Draft.\n\nCloses #41'), 41);
  assert.equal(linkedIssue('fixes #7 and more'), 7);
  assert.equal(linkedIssue('See #41'), null);
  assert.equal(linkedIssue('Encloses #41'), null);
  assert.equal(pullNumber('https://github.com/acme/catalog/pull/12'), 12);
  assert.equal(pullNumber('https://github.com/acme/catalog/issues/12'), null);
});

/** A draft pull request event payload. */
function payload({
  action,
  label,
  merged = false,
  state = 'open',
  review,
  sender = 'User',
  fork = false,
  labels = [ENTRY_LABEL],
}) {
  return {
    action,
    label: label ? { name: label } : undefined,
    review,
    sender: { type: sender },
    repository: { full_name: REPO },
    pull_request: {
      body: 'Closes #41',
      html_url: 'https://github.com/acme/catalog/pull/50',
      merged,
      state,
      labels: labels.map((name) => ({ name })),
      head: { repo: { full_name: fork ? 'someone/catalog' : REPO } },
    },
  };
}

test('stageDecision: the transition table in submission-status.yml', () => {
  const pick = (d) => ({
    status: d.status,
    kind: d.kind,
    once: d.once,
    only: d.onlyOnStatusChange,
    close: d.close,
  });
  const cases = [
    [
      ['pull_request', { action: 'labeled', label: REVIEW_LABELS.revisions }],
      { status: STATUS.changesRequested, kind: 'changes_requested', only: true },
    ],
    [
      [
        'pull_request_review',
        {
          action: 'submitted',
          review: { state: 'CHANGES_REQUESTED', html_url: 'u', author_association: 'MEMBER' },
        },
      ],
      { status: STATUS.changesRequested, kind: 'changes_requested', only: true },
    ],
    [['pull_request', { action: 'unlabeled', label: REVIEW_LABELS.revisions }], { status: STATUS.inReview }],
    [
      ['pull_request', { action: 'labeled', label: REVIEW_LABELS.committee }],
      { status: STATUS.inReview, kind: 'with_committee', once: true },
    ],
    [
      ['pull_request', { action: 'labeled', label: REVIEW_LABELS.partner }],
      { status: STATUS.inReview, kind: 'with_partner', once: true },
    ],
    [
      ['pull_request', { action: 'labeled', label: REVIEW_LABELS.declined }],
      { status: STATUS.declined, kind: 'declined', once: true, close: true },
    ],
    [
      ['pull_request', { action: 'closed', state: 'closed' }],
      { status: STATUS.declined, kind: 'declined', once: true, close: true },
    ],
    [['pull_request', { action: 'closed', state: 'closed', merged: true }], { status: STATUS.published }],
  ];
  for (const [[eventName, options], expected] of cases) {
    const decision = stageDecision(eventName, payload(options));
    assert.equal(decision.issue, 41, JSON.stringify(options));
    const want = {
      status: expected.status,
      kind: expected.kind,
      once: expected.once,
      only: expected.only,
      close: expected.close,
    };
    assert.deepEqual(pick(decision), want, `${eventName} ${JSON.stringify(options)}`);
  }
  assert.equal(
    stageDecision(
      'pull_request_review',
      payload({
        action: 'submitted',
        review: { state: 'CHANGES_REQUESTED', html_url: 'https://r', author_association: 'MEMBER' },
      })
    ).vars.notes_url,
    'https://r'
  );
});

test('stageDecision skips what is not an entry draft of this repository, or not a status change', () => {
  const skips = [
    ['pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.revisions, labels: [] })],
    ['pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.revisions, fork: true })],
    ['pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.revisions, sender: 'Bot' })],
    ['pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.revisions, state: 'closed' })],
    ['pull_request', payload({ action: 'labeled', label: 'bug' })],
    ['pull_request', payload({ action: 'unlabeled', label: REVIEW_LABELS.committee })],
    ['pull_request_review', payload({ action: 'submitted', review: { state: 'approved' } })],
    ['pull_request', payload({ action: 'synchronize' })],
    ['push', {}],
  ];
  for (const [eventName, body] of skips) {
    assert.ok(stageDecision(eventName, body).skip, `${eventName} ${body.action} ${body.label?.name ?? ''}`);
  }
  const noLink = payload({ action: 'closed', state: 'closed' });
  noLink.pull_request.body = 'no link';
  assert.match(stageDecision('pull_request', noLink).skip, /Closes #N/);
});

test('a placeholder the caller does not pass drops its paragraph instead of showing braces', () => {
  for (const kind of Object.keys(DEFAULT_MESSAGES)) {
    const body = render(kind, { number: 2 }, resolveSettings());
    assert.doesNotMatch(body, /\{[a-z_]+\}/, `${kind} leaks a placeholder`);
  }
  const override = resolveSettings({
    site: { notifications: { messages: { published: 'Live at {pgae_url}' } } },
  });
  assert.equal(
    render('published', { number: 2, page_url: 'https://x' }, override),
    'Live at {pgae_url}',
    'a typo stays visible'
  );
});

test('stageDecision: a review asks for changes only when a maintainer wrote it', () => {
  assert.deepEqual([...MAINTAINER_ASSOCIATIONS].sort(), ['COLLABORATOR', 'MEMBER', 'OWNER']);
  const review = (association) =>
    stageDecision(
      'pull_request_review',
      payload({
        action: 'submitted',
        review: {
          state: 'changes_requested',
          html_url: 'https://evil.example/r',
          author_association: association,
        },
      })
    );
  for (const outsider of [
    'NONE',
    'CONTRIBUTOR',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'MANNEQUIN',
    '',
    undefined,
  ]) {
    assert.match(review(outsider).skip ?? '', /not a maintainer/, String(outsider));
  }
  for (const maintainer of MAINTAINER_ASSOCIATIONS) {
    const decision = review(maintainer);
    assert.equal(decision.status, STATUS.changesRequested, maintainer);
    assert.equal(decision.vars.notes_url, 'https://evil.example/r');
  }
});

test('stageDecision: a sender who cannot triage moves nothing; bots keep the merge and close path', () => {
  const declinedLabel = payload({ action: 'labeled', label: REVIEW_LABELS.declined });
  declinedLabel.sender.login = 'stranger';
  assert.match(
    stageDecision('pull_request', declinedLabel, { senderRole: 'read' }).skip,
    /stranger cannot label/
  );
  assert.ok(stageDecision('pull_request', declinedLabel, { senderRole: 'none' }).skip);
  assert.ok(
    stageDecision('pull_request', payload({ action: 'closed', state: 'closed' }), { senderRole: 'read' }).skip
  );
  for (const role of ['triage', 'write', 'maintain', 'admin', 'content-reviewer', undefined]) {
    assert.equal(
      stageDecision('pull_request', declinedLabel, { senderRole: role }).status,
      STATUS.declined,
      String(role)
    );
  }
  // An app's token merging or closing the draft is never asked for a role.
  const merged = payload({ action: 'closed', state: 'closed', merged: true, sender: 'Bot' });
  assert.equal(stageDecision('pull_request', merged, { senderRole: 'read' }).status, STATUS.published);
  const closed = payload({ action: 'closed', state: 'closed', sender: 'Bot' });
  assert.equal(stageDecision('pull_request', closed, { senderRole: 'none' }).status, STATUS.declined);
});

test('stageDecision: a plain close may be superseded by another draft; review:declined may not', () => {
  const plain = stageDecision('pull_request', payload({ action: 'closed', state: 'closed' }));
  assert.equal(plain.status, STATUS.declined);
  assert.equal(plain.supersedable, true);
  const labelled = stageDecision(
    'pull_request',
    payload({ action: 'closed', state: 'closed', labels: [ENTRY_LABEL, REVIEW_LABELS.declined] })
  );
  assert.equal(labelled.status, STATUS.declined);
  assert.equal(labelled.supersedable, undefined);
  assert.equal(
    stageDecision('pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.declined })).supersedable,
    undefined
  );
  assert.equal(
    stageDecision('pull_request', payload({ action: 'closed', state: 'closed', merged: true })).supersedable,
    undefined
  );
});

/** The labels the other intake workflows put on their drafts (the forms' issue labels). */
const OTHER_INTAKE = [
  'content:new-event',
  'content:new-year',
  'content:schedule',
  'content:event-attachments',
  'content:refresh',
  'content:also-deployed-by',
  'content:site-config',
];

test('stageDecision: closing any intake form draft unmerged declines its issue; review stages stay entry-only', () => {
  for (const label of OTHER_INTAKE) {
    const closed = stageDecision(
      'pull_request',
      payload({ action: 'closed', state: 'closed', labels: [label] })
    );
    assert.equal(closed.issue, 41, label);
    assert.equal(closed.status, STATUS.declined, label);
    assert.equal(closed.kind, 'declined', label);
    assert.equal(closed.once, true, label);
    assert.equal(closed.close, true, label);
    assert.equal(closed.supersedable, true, `${label}: another open draft still carries the issue`);
    assert.equal(closed.intake, label, `${label}: the caller checks the issue against the draft's label`);

    const declinedClose = stageDecision(
      'pull_request',
      payload({ action: 'closed', state: 'closed', labels: [label, REVIEW_LABELS.declined] })
    );
    assert.equal(declinedClose.status, STATUS.declined, label);
    assert.equal(declinedClose.supersedable, undefined, `${label}: review:declined is always a decline`);

    const merged = stageDecision(
      'pull_request',
      payload({ action: 'closed', state: 'closed', merged: true, labels: [label] })
    );
    assert.equal(merged.status, STATUS.published, label);
    assert.equal(merged.intake, label, label);

    assert.ok(
      stageDecision('pull_request', payload({ action: 'closed', state: 'closed', labels: [label] }), {
        senderRole: 'read',
      }).skip,
      `${label}: a read-only sender cannot decline`
    );
    for (const review of Object.values(REVIEW_LABELS)) {
      assert.match(
        stageDecision('pull_request', payload({ action: 'labeled', label: review, labels: [label, review] }))
          .skip ?? '',
        /only closing/,
        `${label} ${review}`
      );
    }
    assert.match(
      stageDecision(
        'pull_request_review',
        payload({
          action: 'submitted',
          labels: [label],
          review: { state: 'changes_requested', html_url: 'https://r', author_association: 'MEMBER' },
        })
      ).skip ?? '',
      /only closing/,
      `${label}: a review asking for changes`
    );
  }

  // Entries keep every stage, and say which intake they are.
  assert.equal(
    stageDecision('pull_request', payload({ action: 'closed', state: 'closed' })).intake,
    ENTRY_LABEL
  );
  assert.equal(
    stageDecision('pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.committee })).intake,
    ENTRY_LABEL
  );
  assert.equal(
    stageDecision(
      'pull_request',
      payload({ action: 'labeled', label: REVIEW_LABELS.committee, labels: ['content:refresh', ENTRY_LABEL] })
    ).kind,
    'with_committee',
    'a draft carrying the entry label is an entry draft'
  );

  // A closed pull request without an intake label is no submission's draft.
  for (const labels of [[], ['bug'], ['content:unknown'], ['status:in-review']]) {
    assert.match(
      stageDecision('pull_request', payload({ action: 'closed', state: 'closed', labels })).skip ?? '',
      /intake label/,
      JSON.stringify(labels)
    );
  }
});

test('stageDecision: the status follows the labels on the pull request as it is now', () => {
  const now = (labels, state = 'open') => ({
    pull: { body: 'Closes #41', state, merged: false, labels: labels.map((name) => ({ name })) },
  });
  const pick = (d) => ({
    status: d.status,
    kind: d.kind,
    also: (d.also ?? []).map((m) => m.kind),
    skip: d.skip,
  });

  // A committee label lands while revisions are still requested: the request stands.
  assert.deepEqual(
    pick(
      stageDecision(
        'pull_request',
        payload({ action: 'labeled', label: REVIEW_LABELS.committee }),
        now([ENTRY_LABEL, REVIEW_LABELS.committee, REVIEW_LABELS.revisions])
      )
    ),
    { status: STATUS.changesRequested, kind: 'changes_requested', also: ['with_committee'], skip: undefined }
  );
  // The revisions label was removed again before this run started.
  assert.deepEqual(
    pick(
      stageDecision(
        'pull_request',
        payload({ action: 'labeled', label: REVIEW_LABELS.revisions }),
        now([ENTRY_LABEL])
      )
    ),
    { status: STATUS.inReview, kind: undefined, also: [], skip: undefined }
  );
  // Two tiers at once: the event's tier is the message, the other comes along once.
  const both = stageDecision(
    'pull_request',
    payload({ action: 'labeled', label: REVIEW_LABELS.partner }),
    now([ENTRY_LABEL, REVIEW_LABELS.committee, REVIEW_LABELS.partner])
  );
  assert.deepEqual(pick(both), {
    status: STATUS.inReview,
    kind: 'with_partner',
    also: ['with_committee'],
    skip: undefined,
  });
  assert.equal(both.once, true);
  assert.ok(both.also.every((m) => m.once === true && m.vars.pr_url));
  // Removing revisions while a tier label is on: back in review, the tier note once.
  assert.deepEqual(
    pick(
      stageDecision(
        'pull_request',
        payload({ action: 'unlabeled', label: REVIEW_LABELS.revisions }),
        now([ENTRY_LABEL, REVIEW_LABELS.committee])
      )
    ),
    { status: STATUS.inReview, kind: undefined, also: ['with_committee'], skip: undefined }
  );
  // review:declined on the draft wins over whatever woke the run.
  assert.equal(
    stageDecision(
      'pull_request',
      payload({ action: 'labeled', label: REVIEW_LABELS.committee }),
      now([ENTRY_LABEL, REVIEW_LABELS.committee, REVIEW_LABELS.declined])
    ).status,
    STATUS.declined
  );
  // The intake label was taken off since: not a submission draft any more.
  assert.match(
    stageDecision('pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.committee }), now([]))
      .skip,
    /not labelled/
  );
  // Closed since: only review:declined still decides, and only from a person.
  const closedNow = now([ENTRY_LABEL, REVIEW_LABELS.declined], 'closed');
  assert.equal(
    stageDecision('pull_request', payload({ action: 'labeled', label: REVIEW_LABELS.declined }), closedNow)
      .status,
    STATUS.declined
  );
  assert.ok(
    stageDecision(
      'pull_request',
      payload({ action: 'labeled', label: REVIEW_LABELS.declined, sender: 'Bot' }),
      closedNow
    ).skip
  );
  assert.ok(
    stageDecision(
      'pull_request',
      payload({ action: 'labeled', label: REVIEW_LABELS.committee }),
      now([ENTRY_LABEL, REVIEW_LABELS.committee], 'closed')
    ).skip
  );
});
