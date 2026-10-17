# Decisions

Why the template is the way it is. Append-only: when a decision is reversed, add a new entry that
says so rather than editing the old one, so the reasoning survives alongside the change.

Decisions that only affect one file are recorded in that file's header comment instead. What is
here is the set a contributor would otherwise have to guess at.

---

## 2026-08-17 — Area, not department

The broad tagging field is `area` ("Area of work"). Organizations split themselves into
departments, divisions, units and programs differently, so the wording stays neutral and the option
list mixes program areas with business functions (HR, procurement, IT, legal, coordination…).

## 2026-08-17 — Screenshots live in the repository

Submitters drag images onto the GitHub issue; the scaffolder downloads them into
`catalog/<slug>/screenshots/` so entries stay durable and the site builds offline. Remote URLs are
still accepted for hand-authored entries. The cost is repository size and a takedown that has to
reach git history — see [incidents.md](incidents.md).

## 2026-08-17 — Readiness is one multiselect of flags

`readiness` is a single multiselect whose options each carry an icon and a tone, rather than
several booleans. Simpler to author, to filter and to render, and adding a flag is a line in
`_data/schema.yml` instead of a field.

## 2026-08-17 — Light mode only, for now

Theme tokens stay the single source of colour, so dark mode can be added later without touching
components. Shipping one mode well beat shipping two modes with untested contrast pairs.

## 2026-08-17 — Tailwind stays on 3.4

Tailwind 4's browser floor (Safari 16.4 / Chrome 111 / Firefox 128) is too high for a public-sector
audience on managed and older devices, and it fails hard rather than gracefully below it. Recorded
under "Browser support" in [design-system.md](design-system.md); Dependabot ignores the major.

## 2026-08-17 — The schema is the source of truth

No layout, include, script or workflow names a field key. Everything iterates
`_data/schema.yml`'s `fields` and acts on presentation hints (`facet`, `card`, `weight`, `group`,
`placement`, `option_meta`…). It is what makes the template retargetable at all: rename the entry
noun and the fields, and the forms, filters, cards, search index and validator follow. The price is
that a feature needing a new per-entry attribute must be added as a schema field rather than
bolted on. See [content-model.md](content-model.md).

## 2026-08-17 — Entry bodies render with `render_with_liquid: false`

An entry's body comes from an issue that anyone can open. Scaffolded entries set
`render_with_liquid: false` in their front matter, so a body containing `{{ … }}` or `{% … %}` is
printed rather than executed at build time. See [SECURITY.md](../SECURITY.md).

## 2026-08-17 — No generated placeholder images

`_includes/entry-thumb.html` resolves a real image or emits nothing at all, and callers omit the
whole media band when it does. A generated gradient or initial-letter tile makes every card look
equally complete, which is exactly the signal a catalog for evaluation must not send.

## 2026-08-17 — `x.first` is the array test, and include assigns are prefixed

A schema field's value may be a scalar (`text`, `select`) or a list (`list`, `multiselect`), and
Liquid has no type test: a string's `.first` is `nil`, an array's is truthy. Every template uses
`{% if v.first %}` for this. Separately, Jekyll's `{% include %}` shares the caller's variable
scope (unlike Shopify's sandboxed `render`), so assigns inside `_includes/*.html` are prefixed
(`ec_`, `fv_`, `es_`…) to keep them from clobbering the caller's. Both rules are in `CLAUDE.md`
and `CONTRIBUTING.md`.

## 2026-08-17 — Documentation is repository Markdown, not a docs site

`_config.yml` excludes `docs/` from the Jekyll build. A docs site would be a second thing to theme,
deploy, keep in sync and explain, on a project whose premise is that a health department maintains
it. Every reader of these files is already on GitHub.

## 2026-08-17 — The "Recently added" grid is hidden at `lg` and up

At wide widths the hero already lists the newest entries beside it and the carousel is showing
cards, so a third "what's new" block above the fold says the same thing a third time. The section
stays for narrow screens, where the hero list is hidden. Recorded here because the
`lg:hidden` in `index.md` looks like a mistake otherwise.

## 2026-08-17 — Quality is checked by a persona review panel

A panel (design principal · civic digital-service UX/a11y lead · staff front-end engineer ·
non-technical program manager · technical writer) reviews at fixed checkpoints, and we iterate
until no P1 or P2 findings remain. Automated gates catch regressions; the panel catches the things
that are working as coded and wrong for the reader.

## 2026-08-17 — "What it took" is asked of everyone and required of no one

The `cost` group (stand-up cost, running cost, procurement route, approvals, who it affects) is
the set of questions a peer needs answered before they can copy a project, so every preset that
describes projects asks them. None is required: a blank answer is more honest than a guessed
band, and the group's option lists are a draft for the site owner to rewrite in their own
vocabulary. `organization` dropped to weight 8 at the same time — sharing an organization is not
a reason for two entries to be strongly related.

## 2026-08-17 — Verification is a date, not a badge

Staleness is derived: `verified` is a plain date in front matter, `catalog.verify_after_days`
turns it into "not confirmed since", and the sweep workflow files one rolling issue a month for
what is due. There is no "verified ✓" badge because a badge that is never revoked is worse than
none; the notice is quiet on purpose and the entry stays in the catalog and in search.

## 2026-08-17 — Questions go to Discussions, not issues

"Ask in the open" opens a GitHub Discussion (Q&A category), not an issue: issues are the
submission pipeline and every open one is a bot's to-do; a Discussion is a place where the
answer helps the next reader too. The composed `mailto:` stays for people who prefer a private
question. Sites without Discussions set `contact.ask_in_open: false` and lose only the button.

## 2026-08-17 — Forks upgrade with a merge driver, not a sync bot

The upgrade path is `.gitattributes` `merge=ours` on the files a fork owns plus
`npm run upgrade:check` and `docs/upgrading.md`. A scheduled sync workflow that opens PRs against
every fork was considered and deferred: it needs a token with write access to the fork, and the
merge driver already makes `git merge upstream/main` safe for the files that matter.

## 2026-08-22 — Protected updates use immutable diffs, not shared ancestry

The release updater supersedes the ancestry-dependent part of the earlier merge-driver decision.
A repository created with **Use this template** has a new root commit, so
`--allow-unrelated-histories` permits a merge but still treats every common file as an add/add and
cannot identify the consumed PHCT release as the merge base. The updater now verifies the locked
and target immutable PHCT refs directly, reconciles every template-owned path byte-for-byte to the
complete target tree (including files unchanged between releases), and leaves deployment-owned
paths untouched before verifying their checksums. The ordered
`.gitattributes` rules remain the ownership source and a manual-merge defense, but the supported
automation does not depend on local merge-driver configuration or shared history.

## 2026-08-17 — Saved constraints overlay is deferred

Letting a reader save "my constraints" (budget band, no PHI, on-prem only) and shading the
catalog by fit was proposed and deferred rather than declined: compare + printable brief covers
the immediate need, and the overlay is worth building only once real catalogs answer the cost
questions consistently enough for the shading to mean something.

## 2026-10-16 — Files attached on the submit page go through a stateless service

A submitter can attach screenshots and a slide deck on `/submit/` instead of dragging them onto the
issue afterwards. GitHub never prefills an upload control from a link, so the second step was where
submissions lost their screenshots. The files go to a small service the deployment runs
(`services/uploads/`), which checks each one and writes it straight to a **private GitHub repository**
in the same request. It stores nothing itself: no database, no blob store, nothing on disk.

- **Sign-in is required.** Signed in, an upload is attributable: the service asks GitHub who the token
  belongs to, holds each person to their own caps (3 drafts, 9 files each) without CAPTCHAs or signed
  sessions, and files the upload under that person's numeric id. The scaffolder then looks only under
  the **issue author's** id, so a reference pasted into someone else's issue finds nothing. Direct
  mode also creates the issue by API, so there is no popup to keep alive across an upload and the
  deck question needs no prefilled text field. The cost is that a deployment must run the sign-in
  service first, and submitters without a GitHub account keep the old flow.
- **A second GitHub App, not more permissions on the sign-in App.** The sign-in App's user token sits in
  every submitter's browser, on an origin the sign-in README already warns may be shared. Giving that App
  *Contents* would widen what each of those tokens can do. The uploads App has Contents on the uploads
  repository only, and its key lives only in the service and the catalog's Actions secrets. The scaffold
  job gets a **read-only** token for one step; deleting uses a separate write token that only the cleanup
  workflow mints.
- **One parentless commit and one branch per file** (`u/<user-id>/<set>/<sha256>`). A file is four
  writes with no ordering between parallel uploads, nothing to merge, and deleting the branch is the whole
  cleanup, without touching anyone else's files. Blobs on pick and one commit on submit would save
  writes but leave dangling blobs when a draft sits for days. The cost is GitHub's secondary rate limit,
  about fourteen maximum-size submissions an hour per deployment, far above real volume.
- **The scaffolder never deletes.** Every edit of the issue rebuilds the draft from `main` and resolves
  the references again, so the files must outlive the first scaffold. Only `uploads-cleanup.yml` deletes,
  when the draft pull request or the issue closes, and in a daily sweep of anything past 14 days that no open submission names.
- **Decks are capped at 4 MB for now.** Vercel accepts at most 4.5 MB per request on every plan, and
  chunked upload would make the service stateful. The picker suggests "export as PDF, minimum size", and
  the deck question keeps its link answer for anything bigger. Revisit if real decks routinely exceed it.
- **The private repository is not a privacy promise.** It protects abandoned uploads and stops the service
  being an anonymous file host. Once scaffolded, files sit on a public draft branch before review, as
  GitHub attachments always did. [SECURITY.md](../SECURITY.md) and the picker say so.

The whole feature is off by default and per deployment: a blank `submit.uploads_url` means no pickers
and no new behaviour. Design: [submit-uploads-plan.md](submit-uploads-plan.md).
