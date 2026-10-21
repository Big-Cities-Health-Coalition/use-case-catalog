# From Static Catalog to Managed Single-Tenant Launchpad: Technical Roadmap

This is BCHC's plan for moving from a catalog that *describes* reusable public health tools to a
service that *deploys* them for member cities. Each part is marked with where it stands today, so a
reader can tell what they can inspect now from what is planned.

| Status | Meaning |
|---|---|
| **Built** | Running today; the code is in a public repository linked below. |
| **In progress** | Being built now in the named repository; not yet merged. |
| **Planned** | Designed here; no code yet. Parts marked *grant-funded* depend on the funding this roadmap supports. |

Last reviewed: 2026-10-21. This page is updated as each item changes status.

## 1. Current state

### The catalog (Built)

This repository. A Jekyll site on GitHub Pages with no server, database or CMS login.

- **Schema-driven.** One file, [`_data/schema.yml`](../../_data/schema.yml), defines every field an
  entry has. The submission form, the issue template, the cards, filters, search index and the
  validator all derive from it, so the content model changes in one place.
- **GitHub as the CMS.** A member submits through the site's form or a GitHub issue; automation
  drafts the entry as a pull request; a maintainer reviews it against the published criteria and
  merges. Every change to every entry is in the repository's history.
- **Gated.** Front-matter, file-size, accessibility (pa11y, WCAG 2 AA) and Lighthouse checks run in
  CI on every pull request.

### The Austin Public Health reference apps

Three catalog entries come from Austin Public Health, all Apache 2.0:

| App | Repository | What is built | Status |
|---|---|---|---|
| Austin Health Pulse | [coa-chrisc/austin-health-pulse](https://github.com/coa-chrisc/austin-health-pulse) | Static site on aggregate public data; geography and data sources are configured in two files; deploys from a GitHub Actions workflow to any static host | **Built** |
| Austin Service Guide | [coa-chrisc/austin-service-guide](https://github.com/coa-chrisc/austin-service-guide) | FastAPI + React; services as one YAML file each; branding in one theme file; every model call through one module; settings as environment variables; scripted mode with no AI key | **Built** |
| Voice intake | same repository as the Service Guide | Realtime voice front door sharing the guide's tools and matching | **Built** |
| Stateless sessions, pre-model PII guard, text-only voice pipeline | coa-chrisc/austin-service-guide | Remove server-side session storage; block identifiers before any model call; transcribe and redact speech before the reasoning model sees it, with raw audio streaming off by default | **In progress** |
| Container images and cloud templates | both repositories | `Dockerfile` and infrastructure-as-code per app (section 3) | **In progress** |

Each entry's page states the app's current privacy design and its limits. Those pages, and each
app's `docs/PRIVACY.md`, are the authority for what the code does today; this roadmap is not.

## 2. Managed single-tenant deployment model (Planned)

Most member health departments can't stand up a new web application quickly: hosting, security
review and central IT queues take longer than the build. The Launchpad lets BCHC run that work once,
while keeping each city's data separate.

```
                 ┌──────────────────────────────────────────┐
                 │         BCHC control plane (shared)       │
                 │  onboarding · config review · releases ·  │
                 │  deploy pipeline · monitoring · runbooks  │
                 │         holds NO resident data            │
                 └───────┬──────────────┬──────────────┬─────┘
                         │ deploy       │ deploy       │ deploy
                 ┌───────▼──────┐ ┌─────▼────────┐ ┌───▼──────────┐
                 │ City A       │ │ City B       │ │ City C       │
                 │ own account/ │ │ own account/ │ │ own account/ │
                 │ subscription │ │ subscription │ │ project      │
                 │ own keys,    │ │ own keys,    │ │ own keys,    │
                 │ own model    │ │ own model    │ │ own model    │
                 │ agreements   │ │ agreements   │ │ agreements   │
                 └──────────────┘ └──────────────┘ └──────────────┘
```

- **One tenant per city.** Each partner city gets its own isolated deployment: its own cloud
  account, subscription or project, network boundary, secrets and logs. There is no shared database
  and no pooled data across cities. A fault or a breach in one tenant does not reach another.
- **The control plane holds configuration, not residents.** BCHC's shared layer stores each city's
  reviewed configuration (branding, service catalog, settings), runs the release and deploy
  pipeline, and watches health checks. It never receives resident sessions or model traffic.
- **The city keeps the agreements.** Model-provider contracts, data processing agreements and
  retention approvals are held by the city (or by BCHC on the city's behalf, per a written agreement),
  so the legal relationship matches where the data lives.
- **Same release, every city.** A fix is made once in the app's repository, released, and rolled
  to each tenant by the pipeline, with a per-city approval before production.

Open design questions, to be settled before build: who holds the cloud account during managed
hosting (BCHC or the city), the incident-response split between BCHC and city IT, and the cost model.

## 3. Direct-to-infrastructure multi-cloud portability (In progress)

Managed hosting is an on-ramp, not a lock-in. Every app in the Launchpad will ship what a city's own
IT team needs to run it without BCHC:

- **One container image** per app, built from a `Dockerfile` in the app's repository, configured only
  through environment variables and mounted config files.
- **Infrastructure-as-code templates for three clouds**, each pairing a managed container runtime
  with that cloud's own model service, so a city can keep model traffic inside the cloud it already
  has agreements with:

| Cloud | Container runtime | Model service |
|---|---|---|
| AWS | ECS Fargate | Amazon Bedrock |
| Microsoft Azure | Azure Container Apps | Azure OpenAI |
| Google Cloud | Cloud Run | Vertex AI |

- **Model-agnostic code.** The Service Guide already routes every model call through one module
  (`backend/app/services/ai.py`); the provider adapters for Bedrock, Azure OpenAI and Vertex AI go
  there.
- **Exit path.** Because the image, templates and config are the same ones BCHC runs, moving from
  managed hosting to a city's own cloud is a redeploy with the city's own credentials, not a
  migration project.

Static apps such as Austin Health Pulse need none of this: they run from any static web host today.

## 4. Human-in-the-loop AI onboarding pipeline (Planned, grant-funded)

The slowest part of bringing a new city onto the Service Guide is the service catalog: dozens of
programs, each with eligibility rules, documents, hours and locations, usually spread across
spreadsheets, PDFs and web pages. The onboarding pipeline turns that material into the app's
service schema, and **no rule reaches residents without a named city subject-matter expert (SME)
approving it.**

```
 city source files ──► AI extraction ──► schema validation ──► SME review ──► publish to tenant
 (spreadsheets,         (draft records,    (required fields,     (approve /      (versioned config,
  PDFs, web pages)       each field cited   allowed values,       edit / reject   deploys through the
                         to its source)     conflicts flagged)    every record)   control plane)
```

1. **Extract.** An onboarding agent reads the city's source material and drafts one record per
   service in the same schema the app uses. Every extracted field carries a citation to the source
   page or cell it came from.
2. **Validate.** Deterministic checks reject records with missing required fields, values outside
   the schema's allowed options, or conflicts with other records (two different hours for the same
   site, for example).
3. **Review.** A municipal SME sees each draft beside its source and approves, edits or rejects it.
   Eligibility rules get a mandatory sign-off: the model's draft is never published on its own.
   Who approved what, and when, is recorded.
4. **Publish.** Approved records become a versioned config change for that city's tenant and deploy
   through the same pipeline as any other release. Withdrawing a rule is the same path in reverse.

The model drafts and the SME decides. That matches how the Service Guide already works at run time:
eligibility comes from explicit rules a reviewer can read and test, never from the model's judgment.
