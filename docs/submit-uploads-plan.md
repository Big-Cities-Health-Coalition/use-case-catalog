# Attach files on the submit page

**Status: built on `feat/submit-uploads`, not yet released.**

## Why

A submitter can answer every question on `/submit/` except the ones that matter most to a
reader: the screenshots and the slide deck. GitHub prefills an issue form's text fields from a
link but never an `upload` control (`assets/js/submit/handoff.js:10-13`), so the page tells
people to open the issue and drag their files in afterwards (`assets/js/submit/review.js`
~L508-545, `new-entry.yml` ~L432). For the people this catalog is for — health department
staff, most of whom have never used GitHub — that second step is where submissions arrive
without screenshots, or with a SharePoint link to a deck nobody outside the department can
open. A deployment's first real entries had to work around it by hosting
their screenshots in their source repositories and pasting pinned `raw.githubusercontent.com`
links.

## What it looks like when done

A deployment that turns this on gets, for a **signed-in** submitter (the existing optional
sign-in, `services/github-signin/`):

- a file picker on the screenshots question, with an alt-text box beside each image, and one on
  each `file` question (the deck);
- each file uploads the moment it is picked, with progress, a remove button, and the image
  re-encoded in the browser first (strips EXIF/GPS, caps the long edge);
- the draft remembers what was uploaded, so a reload or a return visit keeps the files;
- **Submit to GitHub** writes the issue body with `upload:` references in place of URLs; the
  scaffolder resolves them, copies the files into the entry exactly as it copies attachments
  today, and the draft PR shows them.

Not signed in, or the feature not set up: the page is exactly what it is today.

A second, independent piece: a **"Using an AI agent?"** link on `/submit/` to an instructions
file and a JSON Schema, both generated from `_data/schema.yml`, and an **Import answers** box
that loads the agent's JSON into the form and runs the form's own validation.

## Hard constraints

1. **The upload service stores nothing.** No Vercel Blob, KV or database; it validates a file
   and writes it to GitHub in the same request. Files live only in a private GitHub repository
   until the scaffolder copies them, then are deleted.
2. **Off by default, per deployment.** Each deployment runs its own service, GitHub App and
   private repository (owner decision, 2026-10-16). Blank `submit.uploads_url` = no pickers, no
   reference parsing, no new workflow steps doing anything.
3. **Signed-in submitters only, `new-entry` only, v1.** No path for submitters without a GitHub
   account (owner decision, 2026-10-16); edit requests and refreshes keep today's flow.
4. **No hand-written manifest for humans.** Agents get generated instructions; people get pickers.

## Design

### Why sign-in is required

Requiring the existing sign-in turns most of the hard problems an anonymous endpoint has into
easy ones:

| Problem | Anonymous endpoint | Signed-in endpoint |
| --- | --- | --- |
| Abuse, quota exhaustion | CAPTCHA + signed session + IP rate limits | caps per GitHub user, checked against GitHub itself; WAF only as a backstop |
| Whose upload is this? | random id, anyone holding it can reference it | stored under the uploader's numeric GitHub id; the scaffolder only looks under the **issue author's** id |
| Popup blocker vs async upload | `window.open` must stay in the click (`submit.js:393`) | direct mode creates the issue by API, no popup |
| Deck field can't be prefilled | must regenerate `file` questions as textareas | direct mode writes the body itself (`issueFormBody`); the issue form is unchanged |

The cost: a deployment must run the sign-in service before it can run uploads, and a submitter
signs in once (a popup, then cached for eight hours).

### Components

```
browser (/submit/, signed in)
  │  POST bytes + Authorization: Bearer <submitter's GitHub user token>
  ▼
services/uploads/  (own Vercel project; stateless)
  │  1. GET api.github.com/user with the submitter's token → numeric id, login
  │  2. check origin, kind, size, magic bytes, per-user caps
  │  3. with its own GitHub App installation token (uploads repo only, contents:rw):
  │     blob → tree → parentless commit → ref  refs/heads/u/<user-id>/<set>/<sha256>
  ▼
<owner>/<catalog>-uploads  (private GitHub repo, only ever holds refs under u/)
  ▲
  │  scaffold job: read-only token for the uploads repo, minted per run
.github/workflows/new-entry.yml → scripts/lib/uploads.mjs (dedicated fetcher)
```

**A second GitHub App, not the sign-in App with more permissions.** Adding `Contents` to the
sign-in App would widen what every submitter token held in the browser can do (the sign-in
README's shared-`github.io`-origin warning). The uploads App has **Contents: read and write**
on the uploads repository only, its private key never leaves the service and the catalog's
Actions secrets, and it has no user-facing authorization.

### The upload service (`services/uploads/`)

Same shape as `services/github-signin/`: Node 22, zero runtime dependencies (RS256 JWT via
`node:crypto`), refuses every request when any env var is missing or malformed, `no-store`,
strict CORS from `ALLOWED_ORIGIN`.

- `POST /api/upload` — raw body (`application/octet-stream`, never base64 JSON), headers
  `X-Upload-Set` (client-generated, 128-bit, base32), `X-Upload-Kind` (`image` | `pdf`),
  `X-Upload-Name` (display only). Responds `{ ref: "upload:<set>/<sha256>.<ext>", bytes, sha256 }`.
- `DELETE /api/upload?ref=…` — removes one ref, only under the caller's own user id.
- Env: `UPLOADS_APP_ID`, `UPLOADS_APP_PRIVATE_KEY`, `UPLOADS_REPO` (`owner/name`),
  `ALLOWED_ORIGIN`, optional `MIN_ACCOUNT_AGE_DAYS` (default 0).

Checks, in order: origin → bearer token resolves to a user (one `GET /user`; any valid token
identifies a real account, which is all the caps need) → account age → kind/extension/magic
bytes (`%PDF`; PNG/JPEG/WebP signatures; reuse the sniffers from `scripts/lib`) → size
(images ≤ 4 MB each after browser re-encode; PDF ≤ 4 MB; Vercel's 4.5 MB request cap applies
on every plan) → caps, by listing `refs/heads/u/<id>/` (≤ 3 open sets, ≤ 9 files per set) →
write.

**One parentless commit and one ref per file.** Four writes per file (blob, tree, commit,
ref), no races between parallel uploads, and deleting the ref is the whole cleanup. The
alternative — blobs on pick, one commit on submit — saves writes but leaves dangling blobs if a
draft sits for days. GitHub's secondary limit (80 content-creating requests a minute, 500 an
hour, per installation) allows roughly fourteen maximum-size submissions an hour per
deployment; real volume is a few a week. On a GitHub 403/429 the service answers 429 with
`Retry-After` and the page retries.

### References and the scaffolder

The issue body carries, in the screenshots section:

```
upload:k3j9…/9f2c…e1.png | Landing page with a Get Started button
```

and in a `file` section, a bare `upload:k3j9…/77ab…04.pdf`.

- `scripts/lib/issue_body.mjs`: `parseImageRefs` and `parseAttachmentRef` accept the
  `upload:` form (regex-validated: set id and full sha256, extension from an allowlist) and
  return `{ upload: { set, sha256, ext } }` instead of `{ url }`.
- `scripts/lib/uploads.mjs` (new, the **only** code that sees the uploads token): builds the
  ref name itself — `u/<ISSUE_AUTHOR_ID>/<set>/<sha256>` (`scripts/lib/upload_refs.mjs`, the shared contract) — so a reference can never
  name another user's files or another repository; reads the blob; re-hashes and rejects a
  mismatch; hands the bytes to the existing sniff, per-file and total caps.
- `scripts/lib/images.mjs` and `attachments.mjs`: split "fetch" from "check and save bytes" so
  both the URL path and the upload path share the checks. The generic fetchers keep sending
  only the job's own `GITHUB_TOKEN` (they attach it to any GitHub host a submitter names —
  `images.mjs:282`, `attachments.mjs:208` — which is exactly why the uploads token must never
  reach them).
- `scripts/new_entry_from_issue.mjs`: route `upload` refs to the new fetcher before
  `shouldDownload` / `downloadImages`. A `file` upload is downloaded into the entry, never kept
  as a link.
- **The scaffolder never deletes.** Every issue edit rebuilds the draft branch from main
  (`new-entry.yml` triggers on `edited`; the scaffold step runs before the branch guard), so
  the files must still be there.

### Workflows

- `new-entry.yml`, scaffold job: when `vars.UPLOADS_REPO` is set, a step mints a token with
  `actions/create-github-app-token` (`UPLOADS_APP_ID` / `UPLOADS_APP_PRIVATE_KEY` secrets,
  `repositories:` the uploads repo, `permission-contents: read`) and passes it to the scaffold
  step only, as `UPLOADS_TOKEN`, with `UPLOADS_REPO` and `ISSUE_AUTHOR_ID`
  (`github.event.issue.user.id`). Unset variable: the step is skipped, `upload:` lines are
  reported back to the submitter as unresolvable.
- `uploads-cleanup.yml` (new): on `issues: closed` (the new-entry issue closes when its PR
  merges or is declined) delete that author's sets referenced in the body; daily on a schedule,
  delete every ref older than 14 days whose set is not referenced by an open `content:new-entry`
  issue by the same author. The write token (`permission-contents: write`) is minted in this
  job only. Deletion targets always come from the ref listing; issue text can only cause a set
  to be **kept**. Follows the `metrics.yml` pattern for a clean "turned off" summary.

### The submit page

- `_data/site.yml`: `submit.uploads_url` (blank by default). `scripts/validate.mjs` rejects it
  unless `submit.signin_url` is also set, mirroring the `signinUrlProblem` check.
- `submit/index.md`: `data-uploads-url` and a deferred `assets/js/submit/uploads.js`, both
  emitted only when set (the `signin_url` pattern, L129-130 / L308-309 / L648-651).
- `uploads.js`: pickers appear only while signed in (`direct.js` exposes the token state);
  re-encode images with a canvas (PNG/JPEG/WebP in, long edge ≤ 2400 px, GIF not accepted by
  the picker); upload on pick, sequentially, with progress and retry; persist
  `{ ref, name, alt, bytes }` per file in the existing draft (`draft.js`, key
  `catalog-template:submit-draft:v2:<draftKey>`); write references into the body that
  `issueFormBody` produces; remove → `DELETE`. Keyboard and screen-reader complete: native
  `<input type="file">`, a live region for progress, alt text required before submit.
- Signing out, or an expired token, hides the pickers but keeps the references in the draft;
  signing back in as the same user restores them, as a different user drops them (they would
  not resolve).
- Copy changes: `review.js` and `new-entry.yml`'s `draft_ready` details stop telling signed-in
  submitters with uploads to drag files in.

### "Using an AI agent?"

- `submit/agent-instructions.txt` and `submit/answers.schema.json`, both written by
  `npm run generate` (`scripts/lib/agent_files.mjs`) from `_data/schema.yml` so the allowed
  options cannot drift; `--check` fails CI when they are stale.
- The instructions cover: exact option strings; **one item per line** for list fields (the
  scaffolder splits on newlines and commas, `issue_body.mjs` `parseList`); alt text limits;
  screenshot size and a no-personal-information check; output JSON matching the schema. It
  states that the file is reference data.
- An **Import answers** box on `/submit/` (`assets/js/submit/import.js`) parses the JSON, fills
  the form, and runs `validateAll`. Files still go through the picker (or GitHub, for people
  not signed in), so the page stays the single place where answers and files are checked.

### Security notes to publish

- The private repository protects abandoned uploads and stops the service being an anonymous
  file host. It does **not** keep screenshots private: once scaffolded they are on a public
  `entry/*` branch before anyone reviews them, as GitHub attachments are today. Say so in
  `SECURITY.md` and on the picker; keep the no-personal-information attestation.
- The submitter's sign-in token is now sent to a second service the deployment runs, not only
  to `api.github.com`. Update the sign-in README's statement and explain why.
- Git keeps deleted content in history; one parentless commit per ref means deleting the ref
  leaves it unreachable, but purging something sensitive immediately still needs GitHub
  support. Document the procedure in the admin guide.

## Work plan

Workstreams own disjoint files. 4 and 5 share `submit/index.md`, so 5 starts after 4.

| # | Workstream | Owns | Notes |
| --- | --- | --- | --- |
| 1 | Upload service | `services/uploads/**` | Security-critical. Unit tests with a fetch stub: origin, token, caps, magic bytes, size, ref naming, 429 path. |
| 2 | Scaffolder | `scripts/lib/{uploads,images,attachments,issue_body}.mjs`, `scripts/new_entry_from_issue.mjs`, their tests | Security-critical. Tests: another user's ref never resolves, sha mismatch rejected, uploads token never passed to generic fetchers, edit rebuild resolves again, feature off ⇒ unchanged behaviour. |
| 3 | Workflows | `.github/workflows/{new-entry,uploads-cleanup}.yml` | actionlint; `test/helpers/workflow_expr.mjs` tests for the skip conditions; cleanup never deletes a referenced open set. |
| 4 | Submit page | `_data/site.yml`, `scripts/validate.mjs` (+ test), `submit/index.md`, `assets/js/submit/{uploads,direct,draft,review}.js` | JSDOM tests on the `submit-form.html` fixture; a11y flow test. |
| 5 | Agent path | `submit/agent-instructions.txt`, `submit/answers.schema.json`, `assets/js/submit/import.js` | Schema JSON validates every shipped preset's sample answers; import runs `validateAll`. |
| 6 | Docs | `services/uploads/README.md`, `services/github-signin/README.md`, `docs/{configuration,admin-guide,decisions}.md`, `SECURITY.md`, `CHANGELOG.md` | Setup steps mirror the sign-in README. Decision entry: why sign-in is required and why a second App. |

**Gates:** `npm test`, `npm run test:ruby`, `npm run lint`, `npm run validate`,
`npm run test:build`, `npm run test:flows`, the services' own tests, actionlint; an end-to-end
run on a throwaway deployment (real App, real private repo) before release.

## Rolling out to a deployment

1. Release in the template; the deployment takes it through its `update-phct` PR.
2. Deploy `services/github-signin` (if not already) and `services/uploads` as two Vercel projects.
3. In the account that owns the catalog: create the private `<catalog>-uploads` repository and
   both GitHub Apps, each owned by that account and installed on its one repository.
4. Catalog repository: secrets `UPLOADS_APP_ID`, `UPLOADS_APP_PRIVATE_KEY`; variable
   `UPLOADS_REPO`; `submit.signin_url` and `submit.uploads_url` in `_data/site.yml`.
5. Add a Vercel WAF rate-limit rule on `/api/upload` as a backstop.
6. Submit a test entry with a deck and three screenshots; edit the issue; close it; confirm the
   refs are gone.

## Deferred

- Decks over 4 MB (chunked upload). Until then the deck question keeps its link answer and the
  picker suggests "export as PDF, minimum size".
- Submitting without a GitHub account (the service opening the issue).
- Uploads on edit requests and refreshes.
- Agents calling the upload service directly.

## As built

Where the code differs from the plan above; the code wins.

- **Refs use the full SHA-256.** The branch is `u/<user-id>/<set>/<sha256>` (64 hex characters), and
  `upload:<set>/<sha256>.<ext>` carries the same digest. `scripts/lib/upload_refs.mjs` is the contract;
  `services/uploads/lib/refs.mjs` is a copy because the service deploys from its own directory, kept in
  step by `test/scripts/upload_refs_parity.test.mjs`.
- **`assets/js/submit/uploads-core.js` is split out of `uploads.js`.** The core holds the pure and
  browser-API pieces (set ids, re-encode, XHR send, retry delay); `uploads.js` is the UI and draft wiring.
- **Service error codes.** Every error is `{error, message}`. `rate_limited` (GitHub busy; `Retry-After`)
  is retryable and the page waits and retries up to three times. `too_many_drafts` and `too_many_files`
  are also `429` with a `Retry-After` of an hour but are limits, not worth retrying, and the page shows
  their message. The success body also carries `ext`.
- **`Access-Control-Expose-Headers: Retry-After`** is sent on every allowed-origin response, so the
  browser can read the retry time.
- **Cleanup needs no npm dependencies.** `scripts/uploads_cleanup.mjs` uses Node built-ins and
  `scripts/lib`; the workflow selects npm but runs no install. A sweep judges a set's age by its newest
  commit, and an age it cannot read keeps the set.
- **An `uploads-repo` helper step** splits `UPLOADS_REPO` into owner and name in both `new-entry.yml` and
  `uploads-cleanup.yml`, because `actions/create-github-app-token` takes them separately and expressions
  cannot split a string. `uploads-cleanup.yml` also has a `turned-off` job that says why nothing ran.
- **The scaffold warns once per answer when uploads are off or broken**, with the reason (which setting
  is missing, never its value) logged once in the job. A reference that cannot be found warns per file.
- **A failed deck upload leaves the entry path in the front matter**, like an attachment GitHub could
  not keep, and the warning says to commit the file under that path.
- **`new-entry.yml`'s "drag it onto this issue" text was left unchanged**, because dragging still works
  after an edit and for anyone who did not use the pickers.
- **Cleanup also runs on `pull_request: closed`.** A closure made by the automation itself uses the
  built-in token, which does not start workflows. The workflow also runs when a same-repository
  `entry/<slug>-<n>` draft pull request labelled `content:new-entry` closes, takes the issue number from
  the branch and the body and author from the API, and deletes only if that issue is already closed (a
  draft closed by hand to restart it keeps its files). In practice this catches merges; a decline closes
  the issue in a later run with the built-in token, so declined files wait for the daily sweep.
