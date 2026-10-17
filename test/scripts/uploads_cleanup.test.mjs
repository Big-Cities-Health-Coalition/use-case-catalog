import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, issueFromDraftBranch } from '../../scripts/uploads_cleanup.mjs';

const SET_B = 'b'.repeat(26);
const SET_C = 'c'.repeat(26);
const SET_D = 'd'.repeat(26);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86400000;
const TOKEN = 'ghs_SECRETUPLOADS';
const GH_TOKEN = 'ghs_SECRETCATALOG';

const refLine = (set, hash, ext = 'png') => `upload:${set}/${hash}.${ext}`;
const entry = (user, set, hash, ageDays = 0) => ({
  ref: `refs/heads/u/${user}/${set}/${hash}`,
  object: { sha: `sha-${user}-${set}-${hash}`.slice(0, 40), ageDays },
});

/** A fake GitHub: records every call, serves the listing, issues and commits. */
function fake({ refs = [], issues = [], deleteStatus = 204 } = {}) {
  const calls = [];
  const byBranch = new Map(refs.map((r) => [r.ref.replace('refs/heads/', ''), r]));
  const bySha = new Map(refs.map((r) => [r.object.sha, r]));
  const slice = (list, url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    return list.slice((page - 1) * 100, page * 100);
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, auth: init.headers?.authorization });
    const u = new URL(url);
    if (method === 'DELETE') {
      const branch = u.pathname.split('/git/refs/heads/')[1];
      assert.ok(
        byBranch.has(branch) || deleteStatus !== 204,
        `DELETE of a branch that is not in the listing: ${branch}`
      );
      return new Response(null, { status: deleteStatus });
    }
    // Like GitHub: matching-refs ignores per_page/page and always answers in full.
    if (u.pathname.endsWith('/git/matching-refs/heads/u/')) return json(refs);
    if (u.pathname.includes('/git/commits/')) {
      const r = bySha.get(u.pathname.split('/').pop());
      if (!r) return json({}, 404);
      return json({ committer: { date: new Date(NOW - r.object.ageDays * DAY).toISOString() } });
    }
    if (u.pathname.endsWith('/issues')) return json(slice(issues, url));
    const one = /\/issues\/(\d+)$/.exec(u.pathname);
    if (one) {
      const found = issues.find((i) => String(i.number) === one[1]);
      return found ? json(found) : json({}, 404);
    }
    return json({}, 404);
  };
  return {
    fetchImpl,
    calls,
    deletes: () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/git/refs/heads/')[1]),
  };
}

const env = (extra) => ({
  UPLOADS_TOKEN: TOKEN,
  GITHUB_TOKEN: GH_TOKEN,
  UPLOADS_REPO: 'org/uploads',
  CATALOG_REPO: 'org/catalog',
  ...extra,
});

const run = (gh, e, out = []) =>
  cleanup({ env: env(e), fetch: gh.fetchImpl, now: () => NOW, log: (l) => out.push(l) });

test("closed: deletes only the author's referenced sets, never another author's identical set id", async () => {
  const gh = fake({
    refs: [entry(7, SET_B, H1), entry(7, SET_B, H2), entry(7, SET_C, H1), entry(8, SET_B, H1)],
  });
  const body = `### Screenshots\n\n${refLine(SET_B, H1)} | alt text\n${refLine(SET_B, H2, 'pdf')}\n`;
  const result = await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_BODY: body });
  assert.deepEqual(gh.deletes().sort(), [`u/7/${SET_B}/${H1}`, `u/7/${SET_B}/${H2}`].sort());
  assert.equal(result.deleted.length, 2);
});

test('closed: issue text naming refs that are not in the listing never produces a DELETE', async () => {
  const gh = fake({ refs: [entry(7, SET_B, H1)] });
  const body = [refLine(SET_C, H3), refLine(SET_D, H1), 'u/7/x/y', '../../heads/main'].join('\n');
  await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_BODY: body });
  assert.deepEqual(gh.deletes(), []);
});

test('closed: a body that does not look like an author id is refused before any call deletes', async () => {
  const gh = fake({ refs: [entry(7, SET_B, H1)] });
  await assert.rejects(
    run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7/../8', ISSUE_BODY: refLine(SET_B, H1) }),
    /user id/
  );
  assert.deepEqual(gh.deletes(), []);
});

test('malformed refs in the listing are ignored', async () => {
  const gh = fake({
    refs: [
      entry(7, SET_B, H1),
      { ref: 'refs/heads/u/7/short/' + H1, object: { sha: 'a' } },
      { ref: `refs/heads/u/abc/${SET_B}/${H1}`, object: { sha: 'b' } },
      { ref: `refs/heads/u/7/${SET_B}/${H1}/extra`, object: { sha: 'c' } },
      { ref: `refs/heads/u/7/${SET_B}/${'a'.repeat(64).toUpperCase()}`, object: { sha: 'd' } },
      { ref: 'refs/heads/main', object: { sha: 'e' } },
      { ref: `refs/tags/u/7/${SET_B}/${H1}`, object: { sha: 'f' } },
    ],
  });
  const result = await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_BODY: refLine(SET_B, H1) });
  assert.deepEqual(gh.deletes(), [`u/7/${SET_B}/${H1}`]);
  assert.equal(result.ignored, 6);
});

test('sweep: keeps referenced and young sets, deletes old unreferenced ones', async () => {
  const gh = fake({
    refs: [
      entry(7, SET_B, H1, 30), // old, referenced by an open issue of user 7
      entry(7, SET_C, H1, 30), // old, unreferenced -> delete
      entry(7, SET_C, H2, 20), // same set, also old
      entry(7, SET_D, H1, 3), // young
      entry(8, SET_B, H2, 30), // same set id as a referenced one, but another author -> delete
      entry(9, SET_D, H3, 30), // old set with one young member is kept
      entry(9, SET_D, H1, 1),
    ],
    issues: [
      { number: 1, user: { id: 7 }, body: `text\n${refLine(SET_B, H1)} | alt\n` },
      { number: 2, user: { id: 9 }, pull_request: {}, body: refLine(SET_C, H1) },
    ],
  });
  const result = await run(gh, { MODE: 'sweep' });
  assert.deepEqual(
    gh.deletes().sort(),
    [`u/7/${SET_C}/${H1}`, `u/7/${SET_C}/${H2}`, `u/8/${SET_B}/${H2}`].sort()
  );
  assert.equal(result.kept, 3);
});

test('sweep: honours MAX_AGE_DAYS', async () => {
  const gh = fake({ refs: [entry(7, SET_C, H1, 5)] });
  await run(gh, { MODE: 'sweep', MAX_AGE_DAYS: '3' });
  assert.equal(gh.deletes().length, 1);
});

test('sweep: an unreadable commit keeps the set; a failed issue listing deletes nothing', async () => {
  const unreadable = fake({
    refs: [{ ref: `refs/heads/u/7/${SET_C}/${H1}`, object: { sha: 'missing', ageDays: 99 } }],
  });
  const orig = unreadable.fetchImpl;
  const gh = {
    ...unreadable,
    fetchImpl: (u, i) =>
      u.includes('/git/commits/') ? Promise.resolve(new Response('{}', { status: 404 })) : orig(u, i),
  };
  await run(gh, { MODE: 'sweep' });
  assert.deepEqual(unreadable.deletes(), []);

  const broken = fake({ refs: [entry(7, SET_C, H1, 99)] });
  const o2 = broken.fetchImpl;
  await assert.rejects(
    cleanup({
      env: env({ MODE: 'sweep' }),
      now: () => NOW,
      fetch: (u, i) =>
        u.includes('/issues') ? Promise.resolve(new Response('{}', { status: 500 })) : o2(u, i),
    }),
    /failed: 500/
  );
  assert.deepEqual(broken.deletes(), []);
});

test('matching-refs is read in one unpaginated call: 250 refs terminate and are all deleted', async () => {
  const refs = [];
  for (let i = 0; i < 250; i += 1) refs.push(entry(7, SET_B, i.toString(16).padStart(64, '0'), 30));
  refs.push(entry(8, SET_B, H1, 30));
  for (const mode of ['closed', 'sweep']) {
    const gh = fake({ refs });
    const result = await run(gh, { MODE: mode, ISSUE_AUTHOR_ID: '7', ISSUE_BODY: refLine(SET_B, H1) });
    const listings = gh.calls.filter((c) => c.url.includes('/git/matching-refs/'));
    assert.equal(listings.length, 1, mode);
    assert.ok(!/[?&](per_page|page)=/.test(listings[0].url), listings[0].url);
    assert.equal(result.listed, 251, mode);
    const expected = refs.filter((r) => mode === 'sweep' || r.ref.includes('/u/7/'));
    assert.equal(gh.deletes().length, expected.length, mode);
    assert.equal(new Set(gh.deletes()).size, expected.length, mode);
  }
});

test('pagination: lists and issues beyond one page are all considered', async () => {
  const refs = [];
  for (let i = 0; i < 130; i += 1) refs.push(entry(7, 'e'.repeat(26), i.toString(16).padStart(64, '0'), 30));
  const issues = [];
  for (let i = 0; i < 100; i += 1) issues.push({ number: i, user: { id: 1 }, body: '' });
  issues.push({ number: 101, user: { id: 7 }, body: refLine('e'.repeat(26), '0'.repeat(64)) });
  const gh = fake({ refs, issues });
  const result = await run(gh, { MODE: 'sweep' });
  // The only reference sits on page 2 of the issues; the whole set is kept.
  assert.equal(result.listed, 130);
  assert.deepEqual(gh.deletes(), []);

  const closed = fake({ refs });
  await run(closed, {
    MODE: 'closed',
    ISSUE_AUTHOR_ID: '7',
    ISSUE_BODY: refLine('e'.repeat(26), '0'.repeat(64)),
  });
  assert.equal(closed.deletes().length, 130);
});

for (const status of [404, 422]) {
  test(`a ${status} on delete means already gone, not a failure`, async () => {
    const gh = fake({ refs: [entry(7, SET_B, H1)], deleteStatus: status });
    const result = await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_BODY: refLine(SET_B, H1) });
    assert.equal(result.gone, 1);
    assert.equal(result.failed, 0);
  });
}

test('another delete error is counted as a failure', async () => {
  const gh = fake({ refs: [entry(7, SET_B, H1)], deleteStatus: 403 });
  const result = await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_BODY: refLine(SET_B, H1) });
  assert.equal(result.failed, 1);
});

test('DRY_RUN makes no DELETE request but reports what would go', async () => {
  const gh = fake({ refs: [entry(7, SET_B, H1)] });
  const result = await run(gh, {
    MODE: 'closed',
    ISSUE_AUTHOR_ID: '7',
    ISSUE_BODY: refLine(SET_B, H1),
    DRY_RUN: 'true',
  });
  assert.equal(gh.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(result.deleted.length, 1);
  assert.match(result.lines.join('\n'), /would delete: 1/);
});

test('tokens never appear in the output, and each token goes only to its own repository', async () => {
  const out = [];
  const gh = fake({ refs: [entry(7, SET_C, H1, 30)], issues: [] });
  const result = await run(gh, { MODE: 'sweep' }, out);
  const text = [...out, ...result.lines].join('\n');
  assert.ok(!text.includes(TOKEN) && !text.includes(GH_TOKEN));
  for (const c of gh.calls) {
    const expected = c.url.includes('/org/catalog/') ? `Bearer ${GH_TOKEN}` : `Bearer ${TOKEN}`;
    assert.equal(c.auth, expected, c.url);
  }
});

test('a missing token or bad mode is refused', async () => {
  const gh = fake();
  await assert.rejects(
    cleanup({ env: { MODE: 'closed', UPLOADS_REPO: 'o/r' }, fetch: gh.fetchImpl }),
    /UPLOADS_TOKEN/
  );
  await assert.rejects(run(gh, { MODE: 'nuke' }), /MODE/);
});

test('closed: a set another open issue by the same author still references is kept', async () => {
  const gh = fake({
    refs: [entry(7, SET_B, H1), entry(7, SET_C, H1)],
    issues: [
      { number: 5, user: { id: 7 }, body: refLine(SET_B, H1) },
      { number: 6, user: { id: 8 }, body: refLine(SET_C, H1) }, // another author: no protection
    ],
  });
  const body = `${refLine(SET_B, H1)}\n${refLine(SET_C, H1)}`;
  const result = await run(gh, { MODE: 'closed', ISSUE_AUTHOR_ID: '7', ISSUE_NUMBER: '9', ISSUE_BODY: body });
  assert.deepEqual(gh.deletes(), [`u/7/${SET_C}/${H1}`]);
  assert.equal(result.kept, 1);
});

test('issueFromDraftBranch: good, malformed and fork-like branch names', () => {
  assert.equal(issueFromDraftBranch('entry/water-routing-41'), 41);
  assert.equal(issueFromDraftBranch('entry/a-1'), 1);
  for (const bad of [
    'entry/water',
    'entry/-41',
    'entry/Water-41',
    'entry/a/b-41',
    'feature/water-41',
    'refs/heads/entry/a-41',
    'entry/a-0',
    'entry/a-41 ',
    'entry/a-41\nx',
    '',
    null,
    undefined,
    'entry/../x-41',
    'entry/a-99999999999',
  ]) {
    assert.equal(issueFromDraftBranch(bad), null, String(bad));
  }
});

test('pr-closed: the issue is found from the branch, fetched, and handled as closed', async () => {
  const gh = fake({
    refs: [entry(7, SET_B, H1), entry(8, SET_B, H1), entry(7, SET_C, H1)],
    issues: [
      { number: 41, user: { id: 7 }, body: refLine(SET_B, H1), state: 'closed' },
      { number: 42, user: { id: 7 }, body: refLine(SET_C, H1) },
    ],
  });
  const result = await run(gh, { MODE: 'pr-closed', PR_BRANCH: 'entry/water-41' });
  assert.deepEqual(gh.deletes(), [`u/7/${SET_B}/${H1}`]);
  assert.equal(result.mode, 'pr-closed');
  assert.ok(gh.calls.some((c) => c.url.endsWith('/org/catalog/issues/41')));
});

test('pr-closed: a branch that is not a draft branch does nothing, and a PR number is refused', async () => {
  const gh = fake({
    refs: [entry(7, SET_B, H1)],
    issues: [{ number: 41, user: { id: 7 }, body: refLine(SET_B, H1) }],
  });
  const result = await run(gh, { MODE: 'pr-closed', PR_BRANCH: 'main' });
  assert.deepEqual(gh.deletes(), []);
  assert.deepEqual(result.deleted, []);
  assert.ok(!gh.calls.some((c) => c.url.includes('/issues/')));

  const pr = fake({
    refs: [entry(7, SET_B, H1)],
    issues: [{ number: 41, pull_request: {}, user: { id: 7 }, body: refLine(SET_B, H1) }],
  });
  await assert.rejects(run(pr, { MODE: 'pr-closed', PR_BRANCH: 'entry/x-41' }), /pull request/);
  assert.deepEqual(pr.deletes(), []);
});

test('pr-closed: an issue that is still open keeps its files and says why', async () => {
  const gh = fake({
    refs: [entry(7, SET_B, H1)],
    issues: [{ number: 41, user: { id: 7 }, body: refLine(SET_B, H1), state: 'open' }],
  });
  const out = [];
  const result = await run(gh, { MODE: 'pr-closed', PR_BRANCH: 'entry/water-41' }, out);
  assert.deepEqual(gh.deletes(), []);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed, 0);
  assert.match(out.join('\n'), /#41 is still open/);
  assert.deepEqual(result.lines, out);
});
