# Staying up to date with the template

Your catalog is a fork of a template that keeps moving. New releases fix layout bugs, harden the
submission workflows, and add features you did not have when you launched. None of that reaches
you automatically — a fork is a copy, not a subscription.

This is how to pull a release in without losing your own site.

## The split

One repository, two kinds of file:

| | Files | On upgrade |
|---|---|---|
| **Template code** | `_layouts/`, `_includes/`, `_plugins/`, `assets/` (except `assets/images/`), `scripts/`, `test/`, `.github/workflows/`, `quality/`, `docs/`, `package.json`, `Gemfile` | Take the template's version. |
| **Yours** | `.phct-version.json`, `_config.yml`, deployment-owned `_data/` files, `catalog/`, `cohorts/`, `events/`, `resources/`, `about/`, `assets/images/`, `docs/bchc/`, `.github/CODEOWNERS`, `MAINTAINERS.md`, `SUPPORT.md`, `README.md`, `CNAME` | Keep yours. These include deployment identity, content, governance, maintainers, and support commitments. |
| **The template's own** | `_showcase/`, `_data/showcase.yml`, `assets/images/showcase/` | The landing page and example sites the template publishes about itself. Nothing in your build reads them (they are only built while `demo` is `true`), so if `npm run eject:samples` removed them, review what a later update restores. |
| **Generated** | `.github/ISSUE_TEMPLATE/new-entry.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `assets/js/configurator/defaults.generated.js` | Keep yours, then `npm run generate` — they are built from *your* `_data/`. |
| **Optional issue forms** | `.github/ISSUE_TEMPLATE/` `new-year.yml`, `schedule.yml`, `new-event.yml`, `update-event-attachments.yml` (while `modules.cohorts` is on) and `apply-setup.yml` (while `github.setup_forms`, or `demo`, is on) | Template code, so the update may add or delete them as it reconciles the tree; the `npm run generate` that follows writes back exactly the set *your* `_data/site.yml` asks for, from the release's `scripts/issue-forms/`. |

That split lives in [`.gitattributes`](../.gitattributes), which marks every file in the **Yours** and
**Generated** rows `merge=ours`. The protected updater reads those ordered rules directly: it
reconciles the complete template-owned tree byte-for-byte to the target release and does not write
a deployment-owned path. Checksums prove the protected set is identical afterward.

The machine-readable source is [`.phct/ownership.yml`](../.phct/ownership.yml). `npm run
ownership:check` fails if that manifest, `.gitattributes`, the generator output list, or the PHCT
version lock drift apart. In particular, `_data/governance.yml`, `_data/search.yml`,
`_data/derivatives.json`, and `_data/security_signals.json` are deployment-owned;
`_data/modules.yml`, `_data/showcase.yml`, `_showcase/`, and showcase images are PHCT-owned.

Before writing any file, the updater compares the current and target release's ordered ownership
rules. If they differ, the update fails closed. Apply `.gitattributes` and
`.phct/ownership.yml` as a separate reviewed migration first, deciding explicitly how every path
that changes owner should be handled, and then rerun the update. This prevents a newly protected
path from being overwritten and a path reclaimed by PHCT from silently retaining stale deployment
content.

One change needs no migration: a release that only adds new generated files, such as a new file
`npm run generate` writes from your configuration. The updater adopts those rules itself when every
added rule is a single file (not a pattern) marked `merge=ours`, listed under `ownership.generated`
in the release's `.phct/ownership.yml`, and absent from your working tree (committed or not), and when every existing
rule is kept in order. It leaves those files alone, `npm run generate` writes them from your data,
and the run's log names them. Anything else, including a new pattern, a path PHCT takes back, or a
file you already have, still fails closed. The updater that runs is the one your deployment already
has, so this applies from the update after the one that ships it.

## Optional expert merge setup

```sh
git config merge.ours.driver true
```

The supported updater and manual recovery command below do not need a merge driver or shared Git
history. Configure this only if an expert deliberately uses `git merge` outside that process;
`merge=ours` is otherwise inert because Git will not run an untrusted repository-defined driver.
The setting is per clone.

A repository created directly from a PHCT release may not have a `.phct-version.json` yet. On that
repository's first **Update from PHCT** run, the workflow derives the current release from
`package.json`, resolves that release tag to a full commit, and calls this out in the update pull
request. The pull request tells you how to check it: open
[the releases page](https://github.com/crypticpy/phct/releases), find that release, and confirm the
commit shown beside the tag starts with the abbreviated SHA in the pull request. The update then
records the target tag and full commit, so every later run can fail closed if the previously
consumed tag has moved or the lock is inconsistent.

A copy taken between releases can report a `package.json` version that was never published. There
is no release tag to start from, so the run stops before changing anything and says so in its
summary. Check the releases page: if that version is listed there now, run the updater again and it
will work; if the newest release is still older than the version your copy reports, wait for that
release or [tell the maintainers](https://github.com/crypticpy/phct/issues).

## Workflow token required for workflow updates

GitHub's built-in Actions token can create ordinary code branches, but GitHub refuses to let it
create or update files under `.github/workflows/`. PHCT releases normally improve those workflows,
so configure a separate repository secret named `PHCT_UPDATE_TOKEN` before the first protected
update:

1. Create a fine-grained personal access token owned by the deployment's machine or release
   account, scoped to this repository only.
2. Grant **Contents: Read and write**, **Pull requests: Read and write**, and **Workflows: Read and
   write**. GitHub lists workflow-file access as the separate
   [Workflows repository permission](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-workflows),
   and its token guide explains how to
   [create and limit a fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
3. Add the value at **Settings → Secrets and variables → Actions → New repository secret** with the
   exact name `PHCT_UPDATE_TOKEN`.
4. Give the token a short expiry, record its owner and rotation date outside the public repository,
   and test the update again before the expiry date.

Do not reuse the narrower `CONTENT_BOT_TOKEN`: routine content automation does not need permission
to rewrite its own workflows. Never paste either credential into the workflow's release input,
logs, an issue, or a pull request.

The updater checks out and validates the candidate with GitHub's built-in token and does not
persist checkout credentials. After verification, it commits without repository hooks and sends
that exact commit through a digest-checked Git bundle to a fresh publication runner. That clean
runner never checks out or executes the candidate. It exposes `PHCT_UPDATE_TOKEN` only to the push
and pull-request operations, through an ephemeral askpass helper rather than a remote URL or Git
configuration. This separation prevents candidate install/build code, background processes, and
Git hooks from reading the workflow-capable credential.

If a target release changes workflow files and this secret is absent, **Update from PHCT** stops
immediately after the protected reconciliation and checksum check. It explains the missing
permission in the run summary and creates neither a branch nor a pull request. A release with no
workflow-file changes can still use the built-in token and its explicit check-dispatch fallback.

## Recommended: one protected update pull request

From the repository's **Actions** tab, run **Update from PHCT** and enter the exact release tag —
copy it from <https://github.com/crypticpy/phct/releases>, where every release is listed with its
tag (for example `v1.9.0` or `v1.9.0-rc.1`) — then wait for it to open a pull request. The
workflow:

1. fetches the current and target immutable tags and records both full commit SHAs;
2. snapshots every deployment-owned file;
3. uses those exact refs to reconcile the complete template-owned tree to the target, including
   files unchanged between releases, while leaving deployment-owned paths untouched even though
   GitHub template repositories do not share commit ancestry with PHCT;
4. proves protected files are byte-identical before and after the update;
5. installs the candidate dependencies and regenerates only derived outputs;
6. records the tag and commit in `.phct-version.json`;
7. runs `npm run verify` and uploads an inspectable site artifact; and
8. opens a human-reviewed pull request, dispatching validation and quality checks when needed.

### How a run ends

Every ending is written in plain English in the run's own summary, at the top of the run's page
under **Actions**. You should never have to read the log to find out what happened.

- **A pull request was opened.** Review it against the checklist in its description, which includes
  downloading the site preview attached to the run.
- **Already up to date.** This deployment already runs the release you asked for, so the run created
  nothing. It finishes green, because it is not a failure — rerunning the updater on a release you
  already have is always safe.
- **The run failed and nothing was published.** A tag that is not a release tag, a release that does
  not exist, a `package.json` version that was never released, a release tag that has moved since
  this deployment consumed it, or a release whose tests fail here. In every one of those cases there
  is no branch, no pull request, and no change to your live site, and the summary names the cause
  and the next step — usually rerunning with a tag copied from the releases page, or telling the
  maintainers.
- **Required update checks were not dispatched.** The pull request exists and `main` is unchanged,
  but its checks did not start on their own. The recovery is below.

When GitHub suppresses pull-request events for the built-in token, the updater dispatches only the
`validate.yml` and `quality.yml` entrypoints that exist in every supported deployment. The
candidate branch's `validate.yml` then calls its own Performance, Supply chain, and CodeQL
workflows, so newly added gates run before their workflow paths have reached the deployment's
default branch. Each dispatch has a 45-second limit and is tried up to three times, so a temporary
GitHub API timeout or rate limit does not immediately strand the update.

If the run ends with **Required update checks were not dispatched**, the verified update branch
and pull request already exist and `main` is unchanged. Do not merge the pull request yet. The run
summary names every missing dispatch and links the pull request. From **Actions**, manually run
**Validate Content** and/or **Quality (a11y + Lighthouse)** on the named `upgrade/phct-*` branch,
wait for every required check to turn green, and then continue the normal review. You can instead
rerun **Update from PHCT** after a GitHub outage or rate limit clears; it updates the same branch and
pull request rather than creating a duplicate.

The workflow is manual-only until the first candidate upgrade and rollback have been rehearsed.
It never merges its own pull request.

## Manual recovery path

Start in the browser. Everything most deployments ever need is a button on the repository's
**Actions** and **Pull requests** tabs, and none of it needs a checkout:

- **Run the updater again.** **Actions → Update from PHCT → Run workflow**, same release tag. It
  reuses the same `upgrade/phct-*` branch and the same pull request instead of creating a duplicate,
  so a run interrupted by a GitHub outage or a rate limit is fixed by rerunning it. If the release
  is already installed, the rerun simply reports **Already up to date**.
- **Look before you approve.** There is no preview-only mode: the pull request is the preview.
  Every run that produces one attaches a `phct-update-<release>` artifact containing the built site
  and the before/after checksum manifests — download it from the run's page, unzip it, and open
  `index.html`. The run's **Preview incoming ownership classification** step lists what the release
  changes and what it leaves alone.
- **Throw an update away, or undo one you merged.** Close the pull request and delete its branch,
  or press **Revert** on the merged pull request. See [If it goes wrong](#if-it-goes-wrong).

If you or a colleague has a checkout, the same update can also be driven by hand.

`upgrade:check` is read-only. It compares `.phct-version.json` with the exact tag and prints the
incoming diff in two lists — what you will take, and what you own and will keep. Moving branches
and abbreviated SHAs are rejected.

Fetch both exact releases into the same immutable temporary refs the workflow uses, preview them,
snapshot
the protected files, and run the deterministic applier. Replace `v1.7.0` with the release in the
current `.phct-version.json`:

```sh
git remote add template https://github.com/crypticpy/phct.git # once per clone
git fetch --no-tags template \
  refs/tags/v1.7.0:refs/phct-update/from/v1.7.0 \
  refs/tags/v1.9.0:refs/phct-update/to/v1.9.0
npm run upgrade:check -- \
  --from refs/phct-update/from/v1.7.0 \
  --to refs/phct-update/to/v1.9.0
npm run ownership:snapshot -- /tmp/deployment-protected.json
git checkout -b upgrade/phct-v1.9.0
node scripts/apply_phct_update.mjs \
  --from refs/phct-update/from/v1.7.0 \
  --to refs/phct-update/to/v1.9.0
```

This does not invoke a Git merge, so a GitHub-template repository's unrelated root cannot create
add/add conflicts. Any local edit to a template-owned path changed by the release is replaced by
the target version by design; re-apply an intentional customization afterward and document it in
the pull request.

Before running target-version scripts, generating, or committing anything, install and select the
candidate runtimes and package managers. The recommended commands below use Mise; an equivalent
version manager is acceptable only if it selects the exact versions in `mise.toml`,
`.node-version`, `.ruby-version`, and `.bundler-version`. Then install dependencies, prove the
update kept deployment content intact, regenerate downstream outputs, update the lock, and run the
same gates CI runs:

```sh
mise trust mise.toml # after inspecting the target release's pinned definitions
mise install
mise exec -- gem install bundler -v "$(cat .bundler-version)"
mise exec -- node scripts/install_exact_npm.mjs
mise exec -- npm ci
mise exec -- bundle install
mise exec -- npm run ownership:verify -- /tmp/deployment-protected.json
mise exec -- npm run generate
mise exec -- npm run version:record -- --release v1.9.0 --commit <full-tag-commit-sha>
mise exec -- npm run ownership:verify -- /tmp/deployment-protected.json
mise exec -- npm run verify
```

Push the branch, let the checks run, and merge. The deploy is the same one your content uses.

## What the protected update cannot do for you

The ownership boundary protects your files; it cannot adopt a change the template made *inside* one.

- **New schema field types or options.** `_data/schema.yml` is yours, so a new field type the
  release added is available but unused. Read the release notes, then add it with the field editor
  at `/setup/`, the [Apply setup issue](launch.md#3-configure-the-site), or by hand — followed by
  `npm run generate`.
- **New `_data/site.yml` keys.** Same story: a new copy block is empty and a new module's header
  and footer links stay hidden until you add the key — but the module's *pages* are only removed
  from the build by an explicit `<module>: false`, so add that line for a module you are not ready
  to show. `docs/configuration.md` lists every key with its default.
- **Renamed template files.** If a release moves `_includes/foo.html` to `_includes/bar.html` and
  you referenced the old name in your own content, the update succeeds and the build fails. That is
  what `bundle exec jekyll build` above is for.

## Deciding whether to upgrade at all

You do not have to. A fork that never merges again keeps working — it is a static site with no
runtime dependencies, and GitHub Pages will keep serving it.

Upgrade when the release notes name something you want, and always read
[`CHANGELOG.md`](../CHANGELOG.md) first:

```sh
git log --oneline v1.2.0..template/main -- CHANGELOG.md
```

## If it goes wrong

Nothing here touches your published site until you merge the upgrade branch into your default
branch, so the whole thing is disposable:

Before committing, switch back to the default branch and discard the disposable update branch.
After committing but before merging the pull request, close it and delete its update branch.

If you already merged and deployed, open the merged pull request and press **Revert**, then merge
the revert pull request GitHub creates for you. The deploy re-runs from the reverted state. In a
checkout, the equivalent is:

```sh
git revert <downstream update commit>
```
