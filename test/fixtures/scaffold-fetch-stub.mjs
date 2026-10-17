/**
 * Preloaded (`node --import`) into a real run of scripts/new_entry_from_issue.mjs
 * by test/scripts/new_entry_scaffold.test.mjs, so the scaffolder can be run end
 * to end without a network: every hostname resolves to a public address, and
 * `fetch` answers from the plan named by `FETCH_STUB_PLAN` (JSON):
 *
 *   {
 *     "log": "<file every request is appended to, one JSON line each>",
 *     "urls": { "<url>": { "contentType": "image/png", "base64": "…" } },
 *     "uploads": { "repo": "owner/name", "branches": { "u/1/<set>/<sha>": { "path": "<sha>.png", "base64": "…" } } }
 *   }
 *
 * The uploads repository is served the way the GitHub REST API serves a git
 * database: ref → commit → tree → blob. Anything not in the plan is a 404.
 *
 * Without `FETCH_STUB_PLAN` it does nothing (`npm test` runs every .mjs under
 * test/ as a test file, this one included).
 */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import process from 'node:process';

if (process.env.FETCH_STUB_PLAN) install();

function install() {
  const plan = JSON.parse(fs.readFileSync(process.env.FETCH_STUB_PLAN, 'utf8'));

  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const objectId = (text) => crypto.createHash('sha1').update(text).digest('hex');

  /** Fake git objects for every branch in the plan, keyed by their ids. */
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();
  const refs = new Map();
  for (const [branch, file] of Object.entries(plan.uploads?.branches ?? {})) {
    const bytes = Buffer.from(file.base64, 'base64');
    const blob = objectId(`blob ${branch}`);
    const tree = objectId(`tree ${branch}`);
    const commit = objectId(`commit ${branch}`);
    blobs.set(blob, bytes);
    trees.set(tree, [{ path: file.path, mode: '100644', type: 'blob', sha: blob, size: bytes.length }]);
    commits.set(commit, tree);
    refs.set(branch, commit);
  }

  const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    fs.appendFileSync(
      plan.log,
      `${JSON.stringify({ url, method: init.method ?? 'GET', authorization: headers.authorization ?? '' })}\n`
    );

    const api = `https://api.github.com/repos/${plan.uploads?.repo}/git/`;
    if (plan.uploads && url.startsWith(api)) {
      const route = url.slice(api.length);
      let match;
      if ((match = /^ref\/heads\/(.+)$/.exec(route)) && refs.has(match[1])) {
        return json({ ref: `refs/heads/${match[1]}`, object: { type: 'commit', sha: refs.get(match[1]) } });
      }
      if ((match = /^commits\/([0-9a-f]+)$/.exec(route)) && commits.has(match[1])) {
        return json({ sha: match[1], tree: { sha: commits.get(match[1]) } });
      }
      if ((match = /^trees\/([0-9a-f]+)$/.exec(route)) && trees.has(match[1])) {
        return json({ sha: match[1], tree: trees.get(match[1]), truncated: false });
      }
      if ((match = /^blobs\/([0-9a-f]+)$/.exec(route)) && blobs.has(match[1])) {
        return new Response(blobs.get(match[1]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return notFound();
    }

    const answer = plan.urls?.[url];
    if (!answer) return notFound();
    return new Response(Buffer.from(answer.base64, 'base64'), {
      status: 200,
      headers: { 'content-type': answer.contentType },
    });
  };
}
