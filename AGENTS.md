# Instructions for AI agents

You are probably here because someone handed you a copy of this repository and asked
you to set it up as their organization's catalog. That is this template's expected
deployment path, and this file is your runbook. Two situations, two routes:

- **You are configuring a copy for an organization** (a repo created via "Use this
  template", or a fork being turned into a real site) → read on. Ignore CLAUDE.md's
  "keep it organization-agnostic" rule — that rule governs the template itself, and
  your job is the opposite: make this copy thoroughly *theirs*.
- **You are contributing to the template itself** (`crypticpy/phct`) → stop here and
  read `CLAUDE.md` and `CONTRIBUTING.md` instead. Everything below assumes a copy.

## The one rule that keeps upgrades working

`.phct/ownership.yml` is the contract between this copy and the upstream template.
Files listed under `ownership.deployment` (all `_data/*.yml`, `catalog/**`,
`assets/images/**`, `README.md`, `_config.yml`, …) are **yours**: edit them freely,
the template updater never touches them. Everything else — `_layouts/`, `_includes/`,
`_plugins/`, `scripts/`, `test/`, `quality/`, `.github/workflows/` — is
**template-owned**: local edits there will conflict with or be overwritten by the
`update-phct` upgrade workflow. If a customization seems to need a template-owned
file, it almost always actually needs a `_data/*.yml` key that already exists — check
`docs/configuration.md` before touching template code. Files under
`ownership.generated` (`.github/ISSUE_TEMPLATE/new-entry.yml`,
`assets/js/configurator/defaults.generated.js`, `_config.yml`'s synced fields) are
rebuilt by `npm run generate` — never hand-edit them.

The second rule, inherited from the template: `_data/schema.yml` defines the entry
content model, and every layout, script and workflow reads field definitions from it.
Never hardcode a field name anywhere; to add a per-entry attribute, add a schema
field.

## What to find out before you change anything

Interview your user (or mine their request) for these; every one maps to a file you
own:

1. **Organization** — name, short name, URL, contact email → `_data/site.yml`.
2. **What the catalog holds** — the entry noun ("use case", "resource", "project"),
   its fields, which are required/facets → `_data/schema.yml`. Four presets exist:
   `ai-use-cases`, `cohort-portal`, `resource-library`, `blank`.
3. **Which modules** — events calendar? cohort/program-year pages? resource library?
   governance page? → `_data/site.yml` `modules:`.
4. **Branding** — colors (they must pass the contrast checks), fonts, logo, imagery →
   `_data/theme.yml`, `assets/images/`.
5. **The repository** — final `owner/repo` on GitHub → `_data/site.yml`
   `github.repository`. Content submission, "edit this page" links and the
   `Validate Content` CI check all depend on it; the check *fails every PR* while it
   still names the template's repository.
6. **Submissions** — open to the public now, or launch closed? → `_data/site.yml`
   `submit.accepting`.

Don't guess at answers you don't have — configure what you know, and leave the
shipped defaults (they are deliberately safe) with a note to the user about what you
left unset.

## The setup sequence

With a terminal and Node 22 (`npm run doctor` reports the exact toolchain):

```sh
npm ci
npm run setup            # interactive configurator; --preset <id> --yes to skip prompts
npm run generate         # rebuild generated files (setup runs it; rerun after any schema edit)
npm run validate         # the same gate CI runs on every PR — must pass before you commit
```

`npm run setup` writes the seven configuration files consistently
(`_data/site.yml`, `_data/theme.yml`, `_data/schema.yml`, `_data/navigation.yml`,
`_config.yml`, both issue templates). You can also edit the `_data/*.yml` files
directly — they are commented for exactly that — but then `npm run generate` and
`npm run validate` are on you. `npm run doctor` diagnoses a toolchain that can't run
the gate.

When the user's answers are in place:

```sh
npm run eject:samples -- --dry-run   # list the demo content (fictional orgs) first
npm run eject:samples                # remove it, set demo: false
```

Keep one sample entry until a real one exists — an empty catalog is harder to verify.

## What you cannot do from the terminal

Four GitHub settings gate the whole content pipeline, and they need a human (or an
agent with repo-admin API access). Tell your user about them explicitly if you can't
set them yourself — a copy that skips these looks fine and silently fails on the
first submission (details in `docs/launch.md` §2):

1. Settings → Pages → Source → **GitHub Actions**.
2. Settings → Actions → General → **Allow GitHub Actions to create and approve pull
   requests** (every content workflow fails its last step without it).
3. Run the **Bootstrap labels** workflow once from the Actions tab (issue forms rely
   on labels that GitHub silently drops if they don't exist).
4. Settings → Security → enable **Private vulnerability reporting** (or keep
   `organization.contact_email` current — `SECURITY.md` falls back to it).

## If the account runs AI code-review bots

Content pull requests — the ones the intake workflows scaffold from submission
issues — are catalog data, not platform code, and the maintainers who merge them are
often not coders. An AI code-review bot commenting on those PRs is noise at best; at
worst its unresolved threads block the merge when the branch ruleset requires
conversation resolution.

Every scaffolded content PR carries two machine-readable markers from the moment it
is created: a label (`content:new-entry`, `content:new-event`, `content:new-year`,
`content:schedule`, or `content:event-attachments`) and a fixed title prefix
(`Add entry:`, `Add event:`, `Scaffold cohort`, `Update cohort`, or
`Update attachments for event`). Use whichever marker the installed bot's skip
mechanism understands.

For **Sourcery** specifically: its current review product is configured in the web
dashboard, not in the repository — app.sourcery.ai → Review Settings → **Ignore
title keywords**, where the five title prefixes above belong. Enter them
**without the trailing colon** (`Add entry`, `Add event`, …): the field matches
keywords as whole words, case-insensitively, and a keyword carrying punctuation
does not match reliably (verified 2026-08: colon-less keywords skip the review,
colon-suffixed ones were still reviewed). The template also
ships a `.sourcery.yaml` with `ignore_labels`, but that key belongs to Sourcery's
legacy bot and the review product does not honor it (verified 2026-08: a labeled
content PR with the file present was still reviewed). Keep the file — it is
harmless and documents intent — but do not rely on it alone. If the organization
has installed a *different* review bot (CodeRabbit, Copilot code review, Codex,
Greptile, …), research that bot's skip mechanism — check whether it is an in-repo
config file or a dashboard setting, and whether it filters by label or by title —
and configure the same exemption. Leave the bots on for everything else: template
update PRs and hand-written code changes are exactly what they are good at.

## If you were asked to apply an edit request

This section is not part of the setup runbook. Once the site is live, readers ask for
changes through the **Suggest an edit** link on each entry page, which opens an issue
labelled `content:edit-request`. If a maintainer assigned you one, follow
[`docs/edit-requests.md`](docs/edit-requests.md) exactly: change only what the issue
asks, open a pull request that says `Closes #N`, and leave the merge to a person.

## Verifying your work

- `npm run validate` — YAML parse + front-matter + file-size gate; the minimum bar.
- `npm test` and `npm run test:ruby` — the full suites, if the toolchain allows.
- A push to the default branch triggers **Build & Deploy**; PRs get
  `Validate Content` and `Quality` (accessibility + Lighthouse). Trust the CI
  verdicts over your own inference — they run the real browser audits.
- Report to your user what you verified and what you could not.

## Where the depth is

| Question | Read |
|---|---|
| The full human launch walkthrough | `docs/launch.md` |
| Every `_data/*.yml` key | `docs/configuration.md` |
| Schema fields, facets, card/search semantics | `docs/content-model.md` |
| Running the catalog day to day (issues → PRs) | `docs/admin-guide.md` |
| Applying a reader's edit request to an entry | `docs/edit-requests.md` |
| Taking template updates later | `docs/upgrading.md` |
| How the repo family fits together | `docs/ecosystem.md` |
