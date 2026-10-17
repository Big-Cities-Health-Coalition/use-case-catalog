#!/usr/bin/env node
/**
 * Delete files attached on /submit/ once nobody needs them. See
 * docs/submit-uploads-plan.md and .github/workflows/uploads-cleanup.yml.
 *
 * Each uploaded file is a branch `u/<user-id>/<set>/<sha256>` in the
 * deployment's PRIVATE uploads repository. Two modes:
 *
 *   closed  A new-entry issue was closed: delete the author's sets that its
 *           body references.
 *   pr-closed  A draft pull request closed (merged or declined). Neither
 *           closing path is guaranteed to start `issues: closed` (a close made
 *           with GITHUB_TOKEN starts nothing), so the issue is found from the
 *           draft branch `entry/<slug>-<issue>` and handled as `closed`;
 *           an issue that is still open is left alone.
 *   sweep   Daily: delete every set older than MAX_AGE_DAYS that no OPEN
 *           `content:new-entry` issue by the same author still references.
 *
 * The invariant both modes keep: deletion targets ALWAYS come from the ref
 * listing of the uploads repository. Issue text is untrusted and can only
 * select among refs already listed (closed) or cause a set to be KEPT (sweep);
 * it never constructs a ref name. Anything in the listing that is not exactly
 * `refs/heads/u/<digits>/<set>/<sha256>` is left alone.
 *
 * Environment: UPLOADS_TOKEN (write, uploads repo only), UPLOADS_REPO,
 * CATALOG_REPO, GITHUB_TOKEN (issues: read), MODE, ISSUE_BODY, ISSUE_AUTHOR_ID
 * and ISSUE_NUMBER (closed), PR_BRANCH (pr-closed), MAX_AGE_DAYS (default 14), DRY_RUN.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { draftBranchPattern } from './lib/drafts.mjs';
import { parseUploadRef, SET_ID_RE, SHA256_RE } from './lib/upload_refs.mjs';

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY_LABEL = 'content:new-entry';
const REF_RE = /^refs\/heads\/u\/([1-9][0-9]*)\/([^/]+)\/([^/]+)$/;
const REF_IN_TEXT_RE = /upload:[a-z2-7]{26}\/[0-9a-f]{64}\.(?:png|jpg|webp|pdf)/g;

/** @param {string} text @returns {Set<string>} set ids named by strict `upload:` lines */
function setsFromLines(text) {
  const sets = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const ref = parseUploadRef(line.split('|')[0]);
    if (ref) sets.add(ref.set);
  }
  return sets;
}

/** Looser than setsFromLines on purpose: it only ever keeps more. */
function setsFromAnywhere(text) {
  const sets = new Set();
  for (const hit of String(text ?? '').match(REF_IN_TEXT_RE) ?? []) {
    const ref = parseUploadRef(hit);
    if (ref) sets.add(ref.set);
  }
  return sets;
}

/**
 * The issue number a draft branch `entry/<slug>-<issue>` was made for, or null.
 * The shape is checked by the same pattern the draft finder uses.
 *
 * @param {unknown} branch
 * @returns {number|null}
 */
export function issueFromDraftBranch(branch) {
  const m = /-([1-9][0-9]{0,9})$/.exec(String(branch ?? ''));
  if (!m) return null;
  const issue = Number(m[1]);
  return draftBranchPattern('entry/', issue, { numbered: true }).test(String(branch)) ? issue : null;
}

/**
 * @param {{ env: Record<string,string|undefined>, fetch?: typeof fetch, now?: () => number, log?: (line: string) => void }} io
 * @returns {Promise<{ mode: string, dryRun: boolean, listed: number, ignored: number, deleted: string[], gone: number, kept: number, failed: number, lines: string[] }>}
 */
export async function cleanup({ env, fetch: fetchImpl = globalThis.fetch, now = Date.now, log = () => {} }) {
  const mode = env.MODE;
  if (!['closed', 'pr-closed', 'sweep'].includes(mode))
    throw new Error(`MODE must be "closed", "pr-closed" or "sweep", got ${JSON.stringify(mode)}`);
  const uploadsRepo = env.UPLOADS_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(uploadsRepo ?? '')) throw new Error('UPLOADS_REPO must be owner/name');
  if (!env.UPLOADS_TOKEN) throw new Error('UPLOADS_TOKEN is not set');
  const dryRun = /^(1|true|yes)$/i.test(env.DRY_RUN ?? '');

  async function call(method, url, token) {
    const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'phct-uploads-cleanup',
      },
    });
    return res;
  }

  /**
   * Every item of a list endpoint that paginates (`per_page`/`page`), such as
   * the issue listing.
   */
  async function pages(url, token) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const res = await call(
        'GET',
        `${url}${url.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`,
        token
      );
      if (!res.ok) throw new Error(`GET ${url.split('?')[0]} failed: ${res.status}`);
      const batch = await res.json();
      if (!Array.isArray(batch)) throw new Error(`GET ${url.split('?')[0]} did not return a list`);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }

  /**
   * The whole answer of a list endpoint in one call. `git/matching-refs` does
   * not paginate: it ignores `per_page`/`page` and returns every match each
   * time, so `pages()` would never see a short page and would loop forever.
   */
  async function all(url, token) {
    const res = await call('GET', url, token);
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error(`GET ${url} did not return a list`);
    return list;
  }

  function requireCatalog() {
    if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.CATALOG_REPO ?? ''))
      throw new Error('CATALOG_REPO must be owner/name');
  }

  function maxAgeDays() {
    const days = Number(env.MAX_AGE_DAYS || 14);
    if (!Number.isFinite(days) || days < 0) throw new Error('MAX_AGE_DAYS must be a non-negative number');
    return days;
  }

  /**
   * `<user>/<set>` for every set an OPEN entry issue (other than `except`) still
   * names. A failure throws before anything is deleted: not knowing what is
   * still referenced must never look like "nothing is".
   */
  async function openReferences(except) {
    requireCatalog();
    const open = await pages(
      `/repos/${env.CATALOG_REPO}/issues?state=open&labels=${encodeURIComponent(ENTRY_LABEL)}`,
      env.GITHUB_TOKEN
    );
    const referenced = new Set();
    for (const issue of open) {
      if (issue.pull_request || String(issue.number) === String(except ?? '')) continue;
      const author = String(issue.user?.id ?? '');
      for (const set of setsFromAnywhere(issue.body)) referenced.add(`${author}/${set}`);
    }
    return referenced;
  }

  // The ref listing: the only source of deletion targets.
  const listing = await all(`/repos/${uploadsRepo}/git/matching-refs/heads/u/`, env.UPLOADS_TOKEN);
  const refs = [];
  for (const item of listing) {
    const m = REF_RE.exec(String(item?.ref ?? ''));
    if (!m || !SET_ID_RE.test(m[2]) || !SHA256_RE.test(m[3])) continue;
    refs.push({ branch: `u/${m[1]}/${m[2]}/${m[3]}`, user: m[1], set: m[2], sha: item?.object?.sha });
  }
  const ignored = listing.length - refs.length;

  /** @type {typeof refs} */
  let targets = [];
  let kept = 0;
  const lines = [];

  /** @param {string} reason */
  function nothingToDo(reason) {
    lines.push(`Uploads cleanup (${mode}): ${reason}`);
    for (const line of lines) log(line);
    return { mode, dryRun, listed: listing.length, ignored, deleted: [], gone: 0, kept: 0, failed: 0, lines };
  }

  if (mode !== 'sweep') {
    let { ISSUE_AUTHOR_ID: authorId, ISSUE_BODY: body, ISSUE_NUMBER: number } = env;
    if (mode === 'pr-closed') {
      number = String(issueFromDraftBranch(env.PR_BRANCH) ?? '');
      if (!number) return nothingToDo('branch is not a draft branch; nothing to do');
      requireCatalog();
      const res = await call('GET', `/repos/${env.CATALOG_REPO}/issues/${number}`, env.GITHUB_TOKEN);
      if (!res.ok) throw new Error(`GET issue ${number} failed: ${res.status}`);
      const issue = await res.json();
      if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
      // An issue that is still open outlives this draft (a maintainer closed it
      // by hand to restart it, or another draft for the issue is open), and its
      // files are still needed. A decline also closes the issue, but in a run
      // of its own (submission-status.yml -> notify_github.mjs, after the pull
      // request closed), and a merge's "Closes #N" may land a moment late; if
      // the issue still reads open here, the daily sweep deletes the files
      // once it is closed and they are past MAX_AGE_DAYS. Skipping can only
      // ever keep files longer.
      if (issue.state === 'open') {
        return nothingToDo(`issue #${number} is still open; its files are kept`);
      }
      authorId = String(issue.user?.id ?? '');
      body = issue.body;
    }
    const author = String(authorId ?? '').trim();
    if (!/^[1-9][0-9]*$/.test(author)) throw new Error('ISSUE_AUTHOR_ID is not a GitHub user id');
    const named = setsFromLines(body);
    // Another open submission by the same author that still names a set keeps
    // it, so a copied `upload:` line cannot take that submission's files.
    const referenced = await openReferences(number);
    targets = refs.filter(
      (r) => r.user === author && named.has(r.set) && !referenced.has(`${r.user}/${r.set}`)
    );
    kept =
      new Set(refs.filter((r) => r.user === author && named.has(r.set)).map((r) => r.set)).size -
      new Set(targets.map((r) => r.set)).size;
  } else {
    const cutoff = now() - maxAgeDays() * DAY_MS;
    const referenced = await openReferences();

    const groups = new Map();
    for (const r of refs) {
      const key = `${r.user}/${r.set}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, members] of groups) {
      if (referenced.has(key)) {
        kept += 1;
        continue;
      }
      let newest = 0;
      let known = true;
      for (const r of members) {
        let when = NaN;
        if (r.sha) {
          const res = await call('GET', `/repos/${uploadsRepo}/git/commits/${r.sha}`, env.UPLOADS_TOKEN);
          if (res.ok) {
            const commit = await res.json();
            when = Date.parse(commit?.committer?.date ?? '');
          }
        }
        if (Number.isNaN(when)) known = false;
        else newest = Math.max(newest, when);
      }
      // An age that cannot be read keeps the set.
      if (!known || newest > cutoff) {
        kept += 1;
        continue;
      }
      targets.push(...members);
    }
  }

  const deleted = [];
  let gone = 0;
  let failed = 0;
  for (const r of targets) {
    if (dryRun) {
      deleted.push(r.branch);
      continue;
    }
    const res = await call('DELETE', `/repos/${uploadsRepo}/git/refs/heads/${r.branch}`, env.UPLOADS_TOKEN);
    if (res.ok) deleted.push(r.branch);
    else if (res.status === 404 || res.status === 422) gone += 1;
    else failed += 1;
  }

  lines.push(
    `Uploads cleanup (${mode}${dryRun ? ', dry run' : ''}) on ${uploadsRepo}`,
    `- refs listed: ${listing.length} (ignored, not an upload branch: ${ignored})`,
    `- ${dryRun ? 'would delete' : 'deleted'}: ${deleted.length}`,
    `- already gone: ${gone}`,
    `- sets kept (referenced elsewhere${mode === 'sweep' ? ' or too young' : ''}): ${kept}`,
    `- failed: ${failed}`
  );
  for (const line of lines) log(line);
  return { mode, dryRun, listed: listing.length, ignored, deleted, gone, kept, failed, lines };
}

async function main() {
  try {
    const result = await cleanup({ env: process.env, log: (line) => console.log(line) });
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.lines.join('\n')}\n`);
    }
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`uploads cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
