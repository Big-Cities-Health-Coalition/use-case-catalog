# Security

This is a Jekyll site published by GitHub Pages. There is no server, no
database and no user session: the whole site is static files, and every change
to it arrives as a commit on the default branch.

What follows is the trust model — what the automation assumes about the people
who use it, and what it does not assume.

## Where untrusted input enters

One place: **GitHub issues**. Anyone with a GitHub account can open one, and
several workflows react to them. The submission form at `/submit/` does not
send anything anywhere; it composes a prefilled issue URL and the submitter
presses the button on GitHub.

Everything below is about keeping that input from turning into anything more
than text in a pull request.

## What the automation guarantees

**Issue content never executes.**
Issue bodies and titles reach a workflow step only through `env:`, never
interpolated into a `run:` script, so shell metacharacters in a submission are
inert. Nothing a submitter writes is passed to `eval`, a shell, or a template
that renders it as code.

**The generated page is not run through Liquid.**
A scaffolded entry carries `render_with_liquid: false` in its front matter.
Without it, Jekyll would evaluate the page body at build time and a Liquid tag
typed into a write-up would execute against the site's data. `check_front_matter.rb`
warns about any entry that is missing the flag.

**The scaffolder writes inside one folder.**
`scripts/new_entry_from_issue.mjs` derives a slug, re-checks it against
`^[a-z0-9]+(?:-[a-z0-9]+)*$`, and then resolves every path it is about to
write and refuses anything that does not sit under `catalog/<slug>/` — file
writes and image downloads alike.

**The issue-form parser is hard to spoof.**
A GitHub issue form renders as `### <label>` sections in template order. The
parser takes the first occurrence of each known heading and treats everything
after the final free-form section as prose, so a `### Contact email` typed
inside someone's write-up cannot overwrite the answer GitHub collected.
Repeated headings are reported on the pull request, not silently applied.
This holds for a body GitHub rendered from the form; an issue written by hand
(or edited afterwards) is still parsed, so the pull request — not the parser —
is the trust boundary.

**Images are fetched behind an SSRF guard.**
Before each request — and again after every redirect hop, up to five — the
target host is resolved and refused if any resolved address is loopback,
link-local (including the cloud metadata address at `169.254.169.254`),
private, unique-local, multicast or unspecified, or if the hostname ends in
`.internal`, `.local` or `localhost`. IP-literal URLs go through the same
check, and IPv6 literals are judged numerically — an IPv4-mapped,
IPv4-compatible or NAT64 address is decoded and held to the IPv4 rules,
whatever its spelling. Redirects are followed by hand so a credential is never
carried to a host it was not meant for. Downloads are capped by count, by total size and by
a request timeout that covers the response body, and each file must be a PNG,
JPEG, GIF or WebP by both its `Content-Type` and its magic bytes before it is
written.

**The cohort and event automation holds to the same rules.**
It reads issue bodies with the same first-occurrence-wins heading parser: only
a heading belonging to the relevant issue form starts a section, and
everything after the form's trailing free-text field is treated as prose, so a
`###` heading typed inside an answer does not replace the answer GitHub itself
collected. Every cohort year and event id is checked against `^\d{4}$` and
`^[a-z0-9]+(?:-[a-z0-9]+)*$`, and the resolved path is re-checked to be inside
`cohorts/<year>/events/` before any file is read or written. The front matter
these scripts generate comes from the shared YAML emitter, so quotes, control
characters and Unicode line separators survive a round trip through both Psych
and js-yaml. Every `$GITHUB_OUTPUT` value is written as a heredoc whose
delimiter is random per write, so no answer can forge an additional step
output, and the four workflows declare `permissions: {}` at the top level and
honour the `SUBMISSIONS_OPEN` repository variable.

**Values written into YAML are quoted unless provably safe.**
`scripts/lib/yaml.mjs` emits a plain scalar only for prose-shaped values and
double-quotes everything else, escaping control characters. A submitted value
cannot change the type or the structure of the front matter it lands in.

**Nothing publishes itself.**
Every issue-driven workflow ends at a pull request. A maintainer reviews and
merges it, and only then does the site rebuild. The `contents: write` token is
repository-wide (GitHub has no branch-scoped token), so the workflows confine
themselves by construction: each pushes only to a branch it created for that
issue. The one workflow that commits to an existing branch is `thumbnails.yml`,
which renders PDF thumbnails onto a pull request's own head branch — or, when a
maintainer runs it by hand, onto the branch they chose — and adds only derived
`.jpg` files under the entry folder. Branch protection on the default branch is
the backstop; see "What you should still do" below.

**The optional `CONTENT_BOT_TOKEN` is a deliberate delegation.**
By default the content workflows use the built-in `GITHUB_TOKEN`, which cannot
trigger other workflows, so they dispatch the validation checks against the new
branch by hand. A maintainer may instead add a `CONTENT_BOT_TOKEN` secret so the
pull requests are opened as that token's user and trigger checks normally. That
token is a real user's credential rather than a per-run one: scope it to this
repository and to **Contents: write** and **Pull requests: write** only, give it
a short expiry, and prefer a machine account. The workflows read it as
`secrets.CONTENT_BOT_TOKEN || secrets.GITHUB_TOKEN`, so removing the secret
returns them to the default path with no other change.
See [docs/admin-guide.md](docs/admin-guide.md#checks-on-a-generated-pull-request).

**Third-party actions are pinned.**
Every `uses:` in `.github/workflows/` names a full commit SHA with the release
tag in a trailing comment. Dependabot proposes updates weekly.

## File uploads on the submit page (optional)

Off unless a deployment sets `submit.uploads_url`. Then a signed-in submitter can attach screenshots
and a PDF deck on `/submit/` through a small service the deployment runs
([`services/uploads/`](services/uploads/README.md)). What that changes:

- **The service stores nothing.** No database, no file storage, nothing on disk. It checks each file
  (origin, a real PNG, JPEG, WebP or PDF judged by its bytes, at most 4 MB, per-person caps) and writes
  it to a **private** GitHub repository in the same request. It has no runtime dependencies.
- **A private repository does not keep screenshots private.** It protects drafts that were never
  submitted and stops the service being an anonymous file host. Once a submission is scaffolded, its
  files are committed to a public `entry/*` draft branch and shown in the draft pull request before
  anyone has reviewed them, just as files dragged into an issue are public the moment they are attached.
  The page tells submitters not to show personal information; reviewers still open every picture at
  full size ([docs/incidents.md](docs/incidents.md)).
- **The submitter's sign-in token goes to the upload service too.** Without uploads it is sent only to
  `api.github.com`. With uploads the page also sends it to the service the deployment runs, which uses
  it for one `GET /user` call to learn who is uploading and never logs, stores or forwards it. It can
  do only what the sign-in App allows, and cannot touch the uploads repository.
- **A reference cannot name someone else's files.** The scaffolder builds the branch name itself from
  the issue author's numeric id, so a reference copied into another person's issue finds nothing, and
  no reference can name another repository. It re-hashes every file and rejects a mismatch.
- **The uploads token is read-only and reaches one step.** The scaffold job mints a token that can
  read contents of the uploads repository only, hands it to the scaffold step alone, and the generic
  image and attachment fetchers (which send their token to any GitHub host a submitter names) never
  see it. Deleting uses a separate write token minted only in `uploads-cleanup.yml`, whose deletion
  targets always come from the repository's own branch listing; issue text can only cause a set to be
  kept.
- **Deleted is not erased.** One parentless commit per file means deleting a branch leaves the file
  unreachable, but git keeps it until GitHub garbage-collects. To purge something sensitive at once,
  contact GitHub Support. The procedure is in
  [docs/admin-guide.md](docs/admin-guide.md#files-attached-on-the-submit-page).

Report a problem with the upload service the same way as any other: see
[Reporting a vulnerability](#reporting-a-vulnerability) below.

## Who can submit

Open by default: the catalog is meant to collect work from people without
write access. To restrict it, set the repository variable `SUBMISSIONS_OPEN` to
`false` (Settings → Secrets and variables → Actions → Variables). Every
issue-driven workflow (`new-entry`, `new-event`, `new-year`, `update-schedule`,
`update-event-attachments`) then runs only for issues opened by the repository
owner, an organization member or a collaborator. See
[docs/admin-guide.md](docs/admin-guide.md) for the maintainer view.

`apply-setup` is the exception, and is not governed by that variable: the YAML
it applies *becomes* the site's configuration, so the workflow refuses to run
for anyone outside `OWNER`/`MEMBER`/`COLLABORATOR` whatever `SUBMISSIONS_OPEN`
says. Its blast radius is bounded the same way everything else is —
`renderFiles()` returns a fixed set of seven repo-relative paths, so the script
cannot write outside them, and the result is still only a pull request.

## What you should still do

- **Protect the default branch.** Require a pull request before merging
  (Settings → Branches). The automation never targets the default branch, but
  the workflow token *could*, and branch protection is what turns "never does"
  into "cannot".
- **Review the generated pull request as content.** The checklist on it is the
  last look a submission gets before it is published.
- **Watch the Actions tab occasionally.** A workflow that fails on an issue
  posts a comment on that issue; one that fails before it can comment only
  shows up in Actions.

## Known limitations

- **DNS rebinding.** The image fetcher resolves the host, checks every address,
  and then lets `fetch` resolve it again for the actual request. A DNS name
  that flips from a public to a private address between those two lookups
  could reach an internal host of the runner. GitHub-hosted runners have no
  interesting internal hosts, but a self-hosted runner does — put it on a
  network segment with nothing to reach, or drop the `images` field from
  `_data/schema.yml` and let maintainers add screenshots on the pull request.
- **The runner's own network.** The SSRF guard is an allow-list of address
  classes, not a proxy; anything routable and public is fetchable, which is the
  point.

## What is out of scope

- Content accuracy. Maintainers review submissions; the automation does not.
- Anything a maintainer merges by hand. The review checklist on each generated
  pull request is the control there.
- Denial of service against GitHub Actions minutes. The workflows use a
  per-issue `concurrency` group so re-runs replace each other rather than
  stacking, but a determined spammer can still consume minutes; disable the
  workflow or set `SUBMISSIONS_OPEN=false` if that happens.

## Reporting a vulnerability

Please report privately rather than opening a public issue. Use GitHub's
private vulnerability reporting: the **Security** tab of this repository →
**Report a vulnerability**. (A repository admin enables it under Settings →
Advanced Security → Private vulnerability reporting.) See
[GitHub's documentation](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
for what the reporting form looks like.

If private reporting is not enabled, email the address in
`_data/site.yml` → `organization.contact_email` and say that the report is a
security issue, so it is not handled as a normal submission.

Expect an acknowledgement within a few working days. There is no bounty.

Something published that should not have been — a takedown request, a leaked
email address, protected data in a screenshot — is not a vulnerability report;
follow [docs/incidents.md](docs/incidents.md), which covers removing the page,
purging it from git history, and asking GitHub Support to clear the caches.
