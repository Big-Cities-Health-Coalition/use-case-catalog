/**
 * What a scaffolded pull request tells its reviewer (scripts/lib/review.mjs).
 *
 * `escalations()` decides which answers get the closer-review block and the
 * `review:data-governance` label, so it is pinned tightly: a boolean's absence
 * escalates as "not confirmed" (a missing attestation is not a passed one), a
 * multiselect escalates on any listed value, and a field with no `escalate_on`
 * never escalates however alarming its value. `reviewChecklist()` must carry
 * the site's own criteria when it publishes them, and the review-status flip
 * only when the schema names one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CRITERIA, escalations, reviewChecklist } from '../../scripts/lib/review.mjs';

const FIELDS = [
  { key: 'no_pii', label: 'No PII/PHI in the shared material', type: 'boolean', escalate_on: [false] },
  {
    key: 'data',
    label: 'Data it touches',
    type: 'multiselect',
    options: [
      'Aggregate only',
      'De-identified data',
      'Health information (PHI)',
      'Personal information (PII)',
    ],
    escalate_on: ['Health information (PHI)', 'Personal information (PII)'],
  },
  {
    key: 'audience',
    label: 'Who sees the output',
    type: 'select',
    options: ['Internal staff', 'Public-facing'],
    escalate_on: ['Public-facing'],
  },
  { key: 'stage', label: 'Stage', type: 'select', options: ['Pilot', 'Production'] },
];

test('a boolean escalates when its answer is on the list — and a missing answer reads as false', () => {
  assert.deepEqual(
    escalations(FIELDS, { no_pii: false }).map((item) => item.key),
    ['no_pii']
  );
  assert.deepEqual(
    escalations(FIELDS, {}).map((item) => item.key),
    ['no_pii'],
    'absent is not confirmed'
  );
  assert.deepEqual(escalations(FIELDS, { no_pii: true }), []);
  assert.equal(escalations(FIELDS, {}).at(0).value, 'not confirmed');
  assert.equal(escalations(FIELDS, {}).at(0).reason, '**No PII/PHI in the shared material**: not confirmed');
});

test('a select or multiselect escalates on any listed value, reported in the answer’s order', () => {
  const flagged = escalations(FIELDS, {
    no_pii: true,
    data: ['De-identified data', 'Personal information (PII)', 'Health information (PHI)'],
    audience: 'Public-facing',
    stage: 'Production',
  });
  assert.deepEqual(
    flagged.map((item) => [item.key, item.value]),
    [
      ['data', 'Personal information (PII), Health information (PHI)'],
      ['audience', 'Public-facing'],
    ]
  );
  assert.deepEqual(
    escalations(FIELDS, { no_pii: true, data: ['Aggregate only'], audience: 'Internal staff' }),
    []
  );
  assert.deepEqual(
    escalations(FIELDS, { no_pii: true, data: 'Health information (PHI)' }).map((i) => i.key),
    ['data'],
    'a scalar answer to a multiselect still counts'
  );
});

test('a field without escalate_on never escalates, and the schema order is kept', () => {
  const noisy = escalations(FIELDS, { no_pii: false, stage: 'Production', audience: 'Public-facing' });
  assert.deepEqual(
    noisy.map((item) => item.key),
    ['no_pii', 'audience']
  );
  assert.deepEqual(escalations([], { anything: 'Public-facing' }), []);
  assert.deepEqual(escalations(undefined, new Map([['no_pii', false]])), []);
  assert.deepEqual(
    escalations(FIELDS, new Map([['no_pii', false]])).map((i) => i.key),
    ['no_pii'],
    'a Map of entries works too'
  );
});

test('the checklist carries the closer-review block only when something was flagged', () => {
  const quiet = reviewChecklist({ criteria: [], status: {}, escalations: [], entryDir: 'catalog/x' });
  assert.doesNotMatch(quiet, /Closer review/);
  assert.match(quiet, /^### Maintainer checklist$/m);
  assert.match(quiet, /^- \[ \] Any PDF or extra file is uploaded into `catalog\/x\/`$/m);
  assert.doesNotMatch(quiet, /set to \*\*/, 'no status flip without a status field');

  const loud = reviewChecklist({
    escalations: [{ reason: '**Data it touches**: Health information (PHI)' }],
    status: { key: 'review_status', start: 'Under review', approved: 'Reviewed & approved' },
  });
  assert.ok(loud.startsWith('### Closer review\n'), 'the flagged answers come first');
  assert.match(loud, /^- \*\*Data it touches\*\*: Health information \(PHI\)$/m);
  assert.match(
    loud,
    /`review_status` set to \*\*Reviewed & approved\*\* \(the scaffold wrote \*Under review\*\)/
  );
  assert.match(loud, /`review:revisions-requested`/);
  assert.match(loud, /^- \[ \] Merge to publish$/m);
  assert.doesNotMatch(loud, /uploaded into/, 'no entry directory, no upload line');
});

test('answers that matched no option are listed for the reviewer to fix', () => {
  assert.doesNotMatch(reviewChecklist({}), /Answers to fix/);
  const md = reviewChecklist({
    escalations: [{ reason: '**Data it touches**: Health information (PHI)' }],
    unmatched: [
      { key: 'stage', label: 'Stage', values: ['Pilott'] },
      { key: 'area', label: 'Area of work', values: ['Space travel', '@someone `x`', 'a\nb'] },
    ],
  });
  assert.match(md, /^### Answers to fix$/m);
  assert.match(md, /left out of the front matter/);
  assert.match(md, /^- \[ \] \*\*Stage\*\* \(`stage`\): `Pilott`$/m);
  // Submitter text is a code span (no @-mention fires), on one line.
  assert.match(md, /^- \[ \] \*\*Area of work\*\* \(`area`\): `Space travel`, `@someone 'x'`, `a b`$/m);
  const order = ['### Closer review', '### Answers to fix', '### Maintainer checklist'].map((h) =>
    md.indexOf(h)
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'closer review, then answers to fix, then the checklist'
  );
});

test('the criteria are the site’s when it publishes them and the generic five otherwise', () => {
  const generic = reviewChecklist({});
  for (const { name } of DEFAULT_CRITERIA)
    assert.match(generic, new RegExp(`^- \\[ \\] \\*\\*${name}\\*\\* — `, 'm'));
  assert.equal(DEFAULT_CRITERIA.length, 5);

  const own = reviewChecklist({
    criteria: [{ name: 'Fits our remit', body: 'Says so.' }, { name: '  ' }, { name: 'Bare' }],
  });
  assert.match(own, /^- \[ \] \*\*Fits our remit\*\* — Says so\.$/m);
  assert.match(own, /^- \[ \] \*\*Bare\*\*$/m, 'a criterion without a body is a bare checkbox');
  assert.doesNotMatch(own, /Completeness/, 'the site’s list replaces the generic one');
});
