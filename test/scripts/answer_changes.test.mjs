/**
 * The answer-by-answer summary a reviewer gets when a submitter edits an issue
 * whose draft they have already changed by hand (scripts/lib/answer_changes.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_VALUE_CHARS, answerChanges, formatChanges } from '../../scripts/lib/answer_changes.mjs';

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'area', label: 'Area', type: 'multiselect' },
  { key: 'internal', label: 'Internal', type: 'text', form: false },
  { key: 'notes', label: 'Write-up', type: 'markdown' },
];

const body = ({ name = 'Router', area = 'Health', notes = 'First draft.' } = {}) =>
  `### Name\n\n${name}\n\n### Area\n\n${area}\n\n### Write-up\n\n${notes}\n`;

test('an entry is compared field by field, through the schema, in form order', () => {
  const changes = answerChanges(
    body(),
    body({ name: 'Router v2', notes: 'Second draft.\n\n### Name\n\nForged' }),
    { fields: FIELDS }
  );
  assert.deepEqual(changes, [
    { label: 'Name', before: 'Router', after: 'Router v2' },
    { label: 'Write-up', before: 'First draft.', after: 'Second draft.\n\n### Name\n\nForged' },
  ]);
});

test('an unchanged body, and _No response_ against blank, are no change', () => {
  assert.deepEqual(answerChanges(body(), body(), { fields: FIELDS }), []);
  assert.deepEqual(
    answerChanges(body({ area: '_No response_' }), body({ area: '' }), { fields: FIELDS }),
    []
  );
});

test('any other form is compared by its own headings, keeping their case', () => {
  const before = '### Event ID\n\nkickoff\n\n### Slides\n\n_No response_\n';
  const after =
    '### Event ID\n\nkickoff\n\n### Slides\n\nhttps://example.org/deck.pdf\n\n### Recording\n\nhttps://example.org/v\n';
  assert.deepEqual(answerChanges(before, after), [
    { label: 'Slides', before: '', after: 'https://example.org/deck.pdf' },
    { label: 'Recording', before: '', after: 'https://example.org/v' },
  ]);
  assert.deepEqual(answerChanges('### Gone\n\nx\n', ''), [{ label: 'Gone', before: 'x', after: '' }]);
});

test('the summary is one flattened, code-spanned line per answer, nothing standing alone', () => {
  const long = 'word '.repeat(80);
  const text = formatChanges([
    { label: 'Na**me** @team', before: '', after: 'line one\n<!-- phct-notify:x -->' },
    { label: 'Notes', before: long, after: 'short' },
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- \*\*Name team\*\*: \*\(blank\)\* → `line one <!-- phct-notify:x -->`$/);
  const cut = /`([^`]*)` →/.exec(lines[1])[1];
  assert.ok(cut.length <= MAX_VALUE_CHARS && cut.endsWith('…'), cut.length);
});
