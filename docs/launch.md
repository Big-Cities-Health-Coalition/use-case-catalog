# Launch your catalog

Start to finish: a copy of this template on GitHub, configured, emptied of the sample
content, and carrying one entry you published yourself. What you end up with is the
[blank example](https://crypticpy.github.io/phct/examples/blank/) with your own name on it
and one real entry.

- **Time:** about 40 minutes, most of it waiting for builds.
- **You need:** a GitHub account, and permission to create a repository in your organization.
- **You do not need:** a terminal, a server, or a CMS login. Everything below can be done in a
  browser; where a terminal is faster, it is offered as an alternative.

Reference material lives elsewhere and is linked as you need it: [configuration.md](configuration.md)
for every setting, [content-model.md](content-model.md) for designing your own fields,
[admin-guide.md](admin-guide.md) for the day-to-day once you are live.

---

## 1. Create the repository

On the template repository, press **Use this template → Create a new repository**. Pick the
organization that should own the catalog, name it, and make it **public** — GitHub Pages on a
private repository needs a paid plan, and a public catalog is the point.

Fork instead of templating only if you intend to send changes back upstream. A fork carries the
template's whole history and its open issues; a template copy starts clean. A fork also arrives
with its **Issues** tab switched off and its **Actions** paused until you enable them by hand —
this catalog needs both, since every piece of content arrives as an issue and is drafted by a
workflow. **Use this template** avoids that entirely.

## 2. Turn on the four GitHub settings

Do these before configuring, because the browser configurator only exists once the site has been
built and deployed at least once.

- [ ] **Pages source.** Settings → Pages → Source → **GitHub Actions** (not "Deploy from a
      branch"). Without this the `Build & Deploy` workflow has nowhere to publish to.
- [ ] **Actions can open pull requests.** Settings → Actions → General → Workflow permissions →
      tick **Allow GitHub Actions to create and approve pull requests**. Without this, every
      content workflow — `new-entry`, `new-year`, `new-event`, `update-schedule`,
      `update-event-attachments` — runs, does its work, and then fails on the last step.
- [ ] **Private vulnerability reporting.** Settings → Security → Code security and analysis →
      **Private vulnerability reporting** → **Enable**. Then open **Issues → New issue → Report a
      security vulnerability privately** in a signed-out/private window and confirm GitHub shows
      the private reporting form. If your plan or repository type does not offer that setting,
      keep the contact inbox below current: the chooser also links to `SECURITY.md`, whose fallback
      sends reports to `_data/site.yml` → `organization.contact_email` without using a public issue.
- [ ] **Create the content labels.** Actions tab → **Bootstrap labels** → **Run workflow**. It
      creates `content:new-entry`, `content:new-event`, `content:schedule`,
      `content:event-attachments`, `content:new-year` and `content:site-config` (the Apply setup
      issue in step 3 needs that last one), plus the `review:*` labels the entry pull requests
      carry. The issue forms ask GitHub to apply these labels; GitHub silently drops a label that
      does not exist yet, and the workflows are triggered by the label, so a submission before this
      step just sits there.

The initial commit GitHub made when it created the repository has already triggered **Build &
Deploy** — look for it in the Actions tab. If it went red because it ran before you set the Pages
source, re-run it (or push any commit); otherwise wait for the green tick. Your site is now at
`https://<owner>.github.io/<repo>/`. The build works out `url` and `baseurl` on its own: the domain
root for an `<owner>.github.io` repository or when a `CNAME` file is present, `/<repo>` otherwise —
neither is something the configurator asks you for.

Expect a Dependabot pull request or two within minutes of creating the repository
(`.github/dependabot.yml` ships with the template and keeps the toolchain current). They are not
part of the launch, and on a brand-new copy their checks come back **red** — `Validate Content`
fails any pull request while `_data/site.yml` still names the template's repository, so it fails
every pull request until you have been through step 3. That is the copy, not something you broke:
configure the site first, then merge them once their checks come back green.

## 3. Configure the site

Two paths, same result — both run the same code (`assets/js/configurator/core.js`) and write the
same seven files:

| Path | How | Good for |
|---|---|---|
| Browser | Open `/setup/` on your deployed site | No terminal. Copy each generated file into GitHub's editor at the end. |
| Browser → pull request | Open `/setup/`, then paste its files into an **Apply setup** issue | No terminal, and no hand-editing files: the answer comes back as a reviewable pull request. |
| Terminal | `npm ci && npm run setup` | Anyone with a checkout. Writes the files directly; `npm run setup -- --preset <id> --yes` skips every prompt. |

Both write `_data/site.yml`, `_data/theme.yml`, `_data/schema.yml`, `_data/navigation.yml`,
`_config.yml`, `.github/ISSUE_TEMPLATE/new-entry.yml` and `.github/ISSUE_TEMPLATE/config.yml`.
Four starting presets ship: AI use case
catalog, cohort/program portal, resource library, and blank.

### The no-terminal path, end to end

The browser wizard hands you finished files but cannot commit them, and pasting six of them into
GitHub's file editor is where a launch usually goes wrong. Instead:

1. Open **Issues → New issue → Apply setup (creates PR)**.
2. Paste `_data/site.yml`, `_data/theme.yml` and `_data/schema.yml` from the wizard's review step
   into the three boxes (the **Copy** button on each file). You only paste three —
   `_data/navigation.yml`, `_config.yml`, the submission form and the issue chooser are rebuilt from them, so they
   cannot end up out of step with what you pasted.
3. Tick **Remove the demo content** if you are ready to lose the sample entries (step 4).
4. Submit. Within a minute the automation replies with a pull request; review the diff and merge.
   The pull request's checks (`Validate Content`, `Quality`) are dispatched by the workflow itself
   and appear on the pull request as **(dispatch)** statuses; a second set of runs, triggered by
   the pull request event, may sit at "action required" — that is GitHub asking for approval to
   run workflows for a bot-authored pull request, not a failure, and the dispatched runs are the
   ones that matter. Merge once they are green (**Squash and merge** keeps the history to one
   commit).

If something is wrong — a typo in the YAML, a colour pair that fails contrast, a schema field with
no key — the automation says so as a comment on the issue instead of opening a broken pull request.
Edit the issue and it tries again. The workflow only runs for repository owners, members and
collaborators, so the form is safe to leave enabled on a public repository.

The wizard asks for your repository as `owner/repo` and writes it to `github.repository` in
`_data/site.yml`. Get this right: it drives the submit form's issue links, every "Suggest an edit"
link, the footer's "Report a problem with the site" link, and the contact links in the issue chooser. The `Validate Content` check fails any
pull request where `github.repository` still names the template's repository, so a copy that skips
this step will not merge.

Merge the pull request (or commit and push, on the other two paths). Wait for `Build & Deploy`,
then look at the site.

## 4. Remove the demo content

The template ships with **ten worked examples**, a sample events calendar, a sample cohort and a
sample resource library, so the site looks real before you have content. They are fictional
organizations — Baytown Metro, Prairie Ridge County, Lakeshore City — and they stay live on your
public site until you delete them.

Until they are gone, every page carries a **Demo content** banner saying so. That banner is driven
by one line, `demo: true` in `_data/site.yml`, and it goes away when the content does. Leave it up
while the samples are there: it is the only thing telling a visitor that "Baytown Metro Health
District" is not a real health department.

Three ways to clear it, all of which do the same thing:

| How | What happens |
|---|---|
| `npm run eject:samples` | Removes it all, sets `demo: false` and switches the `governance` module off. `--dry-run` first if you want to see the list. |
| The **Apply setup** issue (step 3) | Tick **Remove the demo content**; it arrives in the same pull request as your configuration. |
| `npm run setup` | Offers it as the last question, when you changed the entry model or picked a different preset. |

What "all of it" means: every entry folder whose front matter says `sample: true` (never one you
wrote), each `_data/cohorts/<year>.yml` together with its `cohorts/<year>/` page, and the rows in
`_data/events.yml` and `_data/resources.yml` — those two files stay, emptied, with their header
comments intact, so you still have somewhere to put your own. The sample screenshots' records
leave `_data/derivatives.json` with them (the responsive-image manifest `derive_images --check`
verifies on every pull request). `_data/governance.yml` is different:
it is a worked example of a review process and its policies, not rows to empty,
so the ejector sets `governance: false` in `_data/site.yml` and leaves the file for you to rewrite
(the checklist in step 8 has a line for it). `_data/metrics.json` — the sample submission and
review figures shown on the governance page — is deleted; your monthly **Catalog metrics** run
writes yours, or run it from the Actions tab whenever you like (see
[configuration.md](configuration.md#_datametricsjson)).

To see exactly what would go before you run anything:

```sh
npm run eject:samples -- --dry-run
```

No terminal and not ready for the Apply setup issue? Search your repository on GitHub for
`sample: true` (the search box at the top of the repository, scoped to "In this repository") — the
results are the same list of folders. Delete them with the **⋯** menu → **Delete directory**, in
one pull request so one click undoes the lot, then set `demo: false` in `_data/site.yml`.

Keep one sample until you have published your own first entry. An empty catalog is harder to
sanity-check than a catalog with one thing in it, and step 6 gives you a real entry to replace it
with.

## 5. Optional repository settings

Neither is needed to launch; both are worth knowing about before you tell anyone about the site.

- **`SUBMISSIONS_OPEN`** (Settings → Secrets and variables → Actions → **Variables**). Set it to
  `false` and the issue-driven workflows only run for issues opened by the repository owner, an
  organization member or a collaborator. Anyone can still open the issue — it just does not
  scaffold a pull request, so you triage by hand. Delete the variable to reopen.
- **`CONTENT_BOT_TOKEN`** (Settings → Secrets and variables → Actions → **Secrets**). A
  fine-grained personal access token with `contents: write` and `pull requests: write` on this
  repository. Without it, the content workflows open their pull requests with the default
  `GITHUB_TOKEN`, then dispatch `Validate Content` and `Quality` against the branch themselves
  and report the results as **(dispatch)** statuses on the pull request; the runs GitHub starts
  for the pull-request event park at "action required" until a maintainer approves them. Supply
  this secret and the workflows use it instead, so every generated pull request arrives with
  its checks running the ordinary way, no approval needed.

## 6. Publish a test entry

Walk the real path, as a submitter would:

1. Open `/submit/` on your site, fill it in with something obviously fake ("Test entry — delete
   me"), and press the button at the end. A GitHub issue form opens in a new tab with your answers
   already filled in.
2. Attach a screenshot by dragging an image onto the issue body — this is the only step where
   files can be added, and it is why the form hands you off to GitHub rather than submitting for
   you.
3. Submit the issue. Within a minute the **New entry from issue** workflow comments on it with a
   link to a pull request containing `catalog/<slug>/index.md` and your screenshot.
   - Nothing happened? Check the issue carries the `content:new-entry` label (step 2), and the
     Actions tab for a failed run.
   - The workflow comments the error back on the issue when scaffolding fails. Editing the issue
     re-runs it.
   - A field whose answer matches its `escalate_on` list in `_data/schema.yml` (protected data on
     screen, for instance) adds the `review:data-governance` label — expected on a test entry that
     answers those questions honestly.
4. Review the pull request against the checklist in its body. The scaffold writes
   `review_status: Under review`; the last item on the checklist is to set it to the approved value
   (`Reviewed & approved` in the shipped schema) — edit the file on the pull request's branch and
   commit — then **merge**.

## 7. Check it went live

`Build & Deploy` runs on the merge; give it a couple of minutes, then confirm all four:

- [ ] The entry page renders at `/catalog/<slug>/`, screenshot and all.
- [ ] It appears on `/catalog/`, and filtering by one of its values keeps it on screen.
- [ ] `/search.json` contains its title (open the URL and search the page).
- [ ] The home page stat line counts it.

Then delete the test entry the way you will delete a real one: remove `catalog/<slug>/` in a pull
request and merge. That is the whole removal mechanism — see
[incidents.md](incidents.md) for what to do when deleting the folder is not enough.

## 8. Before you tell anyone

- [ ] Sample entries deleted — searching your repository for `sample: true` (the search box at the
      top of the repository, scoped to "In this repository") finds nothing left under `catalog/`
- [ ] `_data/site.yml` → `github.repository` is your repository
- [ ] `_data/site.yml` → `footer.links` point at your organization and your own copy of the
      maintainer guide, not the template's
- [ ] `organization.contact_email` and `submit.fallback_email` are inboxes somebody reads
- [ ] `submit.review_note` says what your organization must not be sent (protected health
      information, credentials, non-public data)
- [ ] `submit.turnaround` is a promise you can keep — it is shown to every submitter
- [ ] Sample data cleared from `_data/events.yml`, `_data/cohorts/` and `_data/resources.yml`, or
      those modules turned off in `_data/site.yml`
- [ ] `_data/governance.yml` rewritten in your own words — review steps, criteria, roles and
      policies are yours, not the template's — and `governance: true` set again in
      `_data/site.yml`; or the module left off until it is
- [ ] `.github/CODEOWNERS`, `MAINTAINERS.md` and `SUPPORT.md` name your own people and your own
      contact routes — they ship carrying the template author's, and a template update never
      overwrites them, so nobody else will fix them for you
- [ ] Branch protection on `main`: require a pull request before merging
      (see [SECURITY.md](../SECURITY.md), "What you should still do")
- [ ] Private vulnerability reporting is enabled and its chooser link opens while signed out; or
      the documented `organization.contact_email` fallback has been tested
- [ ] You have opened one test submission yourself and merged it (steps 6–7)
- [ ] Someone other than you has merged a pull request, so the process survives your holiday

## Where to go next

- [Maintainer guide](admin-guide.md) — reviewing submissions, editing entries, cohorts and events
- [Configuration reference](configuration.md) — every key in `_data/*.yml`
- [Content model](content-model.md) — when the shipped fields are not your fields
- [When something has to come down](incidents.md) — takedowns and data spills
- [Upgrading](upgrading.md) — a new template release is out (they are announced at
  <https://github.com/crypticpy/phct/releases>): what is yours, what is the template's, and how to
  take the update without losing your configuration or content
- [Operations and handoff](maintaining.md) — handing the site to a successor, or something broke:
  the routine schedule, rollback, backup and restore, and the ownership-transfer checklist
- [SUPPORT.md](../SUPPORT.md) — reporting a bug in the template itself, and what response to expect
