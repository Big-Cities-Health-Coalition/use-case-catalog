# Documentation

Twenty-four documents, four different readers. Find your row.

| Page | Who it is for | When to read it |
|---|---|---|
| [launch.md](launch.md) | Someone who just created a repository from the template | First. Start to finish, about 40 minutes, ends with an entry you published yourself. |
| [../AGENTS.md](../AGENTS.md) | An AI coding agent handed a copy to configure | The agent-facing setup runbook: the interview checklist, the ownership contract, and the settings only a human can click. |
| [configuration.md](configuration.md) | Whoever owns `_data/*.yml` | When you want to change a setting and need to know the key, or what a key does. |
| [content-model.md](content-model.md) | Whoever decides what an entry holds | When the shipped fields are not your fields — designing a schema, adding a field type, choosing a taxonomy people will actually filter by. |
| [search.md](search.md) | Whoever owns the taxonomy | When search finds the wrong thing, or nothing — synonyms, tag aliases, the facet landing pages and the A–Z directory, all from `_data/search.yml`. |
| [admin-guide.md](admin-guide.md) | The maintainer of a live site | Day to day: reviewing submissions, editing and removing entries, site problem reports, screenshots, cohorts and events, troubleshooting. |
| [edit-requests.md](edit-requests.md) | The maintainer, or the coding agent they assign | When a **Suggest an edit** issue (`content:edit-request`) arrives: how to turn it into a pull request that says `Closes #N`, and what a person checks before merging. |
| [contributor-guide.md](contributor-guide.md) | Someone at a member organization with something to share | Before submitting: what the form asks, what reviewers check hardest, how long review takes, and what happens after an entry is live. Linked from the site's Governance page. |
| [upgrading.md](upgrading.md) | The maintainer of a fork | When a new template release is out: what is yours, what is the template's, and the merge recipe that keeps the two apart. |
| [release-readiness-plan.md](release-readiness-plan.md) | PHCT and BCHC release maintainers | The parent audit, remediation, release train, and protected downstream-update plan for preparing the wider BCHC demo and keeping future releases synchronized. |
| [polish-and-publish-plan.md](polish-and-publish-plan.md) | Release owners and implementation reviewers | The remaining executable sequence for parent interface polish, open-source publication, the final protected BCHC update, wider-demo proof, and later handoff. |
| [release-readiness-status.md](release-readiness-status.md) | Release owners, reviewers, and BCHC sponsors | Dated verification evidence, defects fixed during the audit, remaining human/live-repository blockers, and the final go/no-go rule. |
| [incidents.md](incidents.md) | The maintainer, under pressure | The day something is public that should not be: a takedown request, a leaked screenshot, a credential in an entry. |
| [glossary.md](glossary.md) | Anyone hitting a word they do not use this way | Entry, slug, facet, card slot, module, preset, scaffold. |
| [decisions.md](decisions.md) | Someone changing the template | Before arguing with a choice — the reasoning is here, not in the commit log. |
| [images.md](images.md) | Someone wondering why a screenshot has five siblings | The responsive-image pipeline: `npm run images`, what gets committed and why, and how to use `picture.html` in a template. |
| [compare.md](compare.md) | Someone changing the compare tray or the print brief | How the shortlist, `/compare/` and the print stylesheet fit together, and the one rule that keeps them schema-driven. |
| [performance.md](performance.md) | Release maintainers and performance contributors | The supported catalog ceiling, deterministic 0–1,000-entry fixture matrix, enforced budgets, current evidence, and the condition for raising the ceiling. |
| [supply-chain.md](supply-chain.md) | Release and security maintainers | Dependency vulnerability and license gates, exception rules, CodeQL, and the CycloneDX release SBOM. |
| [maintaining.md](maintaining.md) | Primary, backup, and incoming maintainers | Routine schedule, parent release train, BCHC update, rollback, backup/restore, ownership transfer, and escalation. |
| [design-system.md](design-system.md) | Someone building UI | Tokens, component classes, browser support. Pair it with `/styleguide/` on the running site. |
| [design-brief.md](design-brief.md) | Nobody, urgently | Historical: the 2026 brief that produced the current design. Kept because it explains intent; `design-system.md` is what shipped. |
| [ecosystem.md](ecosystem.md) | Anyone asking "which repository is which" | The map of the repository family: the template, the BCHC deployment, what is archived, and which settings make each behave differently. |
| [roadmap.md](roadmap.md) | Someone asking "what was built, and when" | A build log of the v1.0/v1.1 phases, all complete. |

Outside this folder: [README](../README.md) (what the template is),
[CONTRIBUTING](../CONTRIBUTING.md) (working on the template itself),
[ARCHITECTURE](../ARCHITECTURE.md) (how the pieces fit),
[SECURITY](../SECURITY.md) (the trust model behind the issue-to-pull-request pipeline),
[SUPPORT](../SUPPORT.md) (where to ask, and what response to expect),
[MAINTAINERS](../MAINTAINERS.md) (who owns which decision — replace it with your own people when
you adopt the template),
[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) (licenses and attribution for bundled files),
[CODE_OF_CONDUCT](../CODE_OF_CONDUCT.md) (how contributors and reviewers engage).

**Submitting an entry?** Almost none of this is for you — use the **Submit** page on the site,
and read [contributor-guide.md](contributor-guide.md) if you want to know what review will
ask. If the Submit page leaves you guessing, that is a bug in the page; please open an issue.
