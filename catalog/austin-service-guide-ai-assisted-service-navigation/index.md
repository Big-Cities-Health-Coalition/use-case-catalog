---
layout: entry
render_with_liquid: false
title: "Austin Service Guide — AI-assisted service navigation"
slug: austin-service-guide-ai-assisted-service-navigation
published: "2026-10-15"
featured: false
thumbnail: ""
organization: Austin Public Health
solution_type:
  - Application or software
  - Generative AI tool
sharing: Open-source code
use_case_category: Administrative & task automation
area:
  - Access to and linkage with care
  - Communications and community engagement
stage: Pilot
summary: Residents describe their situation in a short chat and get a ranked plan of local services they may qualify for, with hours, documents to bring, and a map.
impact: ""
review_status: Under review
ai_role: Both
ai_types:
  - Chat assistant
  - Agents & automation
  - Translation
  - Rules-based (no ML)
ai_tools:
  - OpenAI Responses API (tool calling)
  - Python / FastAPI
  - React / TypeScript / Material UI
  - Leaflet / OpenStreetMap
  - Claude Code (AI pair programmer)
platform:
  - Desktop or local
vendor: ""
expertise: Developer
readiness:
  - Needs customization
repo_url: "https://github.com/coa-chrisc/austin-service-guide"
demo_url: ""
docs_url: "https://github.com/coa-chrisc/austin-service-guide/blob/main/docs/PRIVACY.md"
resources: []
screenshots:
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/01.png"
    alt: Landing page headline with a Get Started button and a note not to share names or ID numbers.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/02.png"
    alt: Grid of life-event cards such as New Baby, Lost a Job, Housing Crisis and Aging Parent.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/03.png"
    alt: Chat intake where the assistant skips facts already given and asks about monthly income.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/04.png"
    alt: Personal plan that starts with Caritas of Austin, with call, directions and documents to bring.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/05.png"
    alt: Service directory searched for behind on rent, with category filters and service cards.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/06.png"
    alt: Map of Austin with color-coded service pins and a searchable list of locations.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/07.png"
    alt: Service page showing eligibility, documents needed, how to apply, contact details and hours.
  - src: "/catalog/austin-service-guide-ai-assisted-service-navigation/screenshots/08.png"
    alt: Staff dashboard with session trends and language mix, using generated demo data only.
deck_pdf: ""
also_deployed_by: []
license: Apache 2.0
access_terms: ""
portability: "Partially — with rework"
portability_notes: "The web app (React) and API (FastAPI) run anywhere Python and Node run. The AI layer calls OpenAI's Responses API through one module (backend/app/services/ai.py); a team using Azure OpenAI or another model with tool calling would swap that module. Without an API key the app runs a scripted intake, so it can be demonstrated with no AI vendor at all. The service catalog is YAML files; replacing them with your own services is the main customization."
reused_from: []
cost_band: No new spend
run_cost: "Under $10k/yr"
procurement:
  - No procurement needed
approvals:
  - Not yet reviewed
equity_note: "Built for residents who don't know which program to ask for. No account is needed. The AI notice is translated into Spanish, Vietnamese, Chinese and Arabic, and the model can switch the conversation language, but those translations are machine-generated and have not been reviewed by people. The scripted demo flow is English only. Residents without internet access, or who are uncomfortable with AI, are not served by this tool and still need phone and in-person navigation. Eligibility rules are simplified: a service whose rules the intake can't confirm is shown with a 'check eligibility' note instead of being hidden."
no_pii_attestation: true
data_sensitivity:
  - Public data only
  - Personal information (PII)
data_sources:
  - "Austin-area service catalog: 87 services compiled from public program websites"
  - Resident answers typed during the intake (held in memory for 24 hours)
audience: Public-facing
data_governance_notes: "Demo: no database. Sessions are held in server memory and deleted 24 hours after they start. Before any typed message is stored or sent to the model, pattern-based redaction removes Social Security numbers, card numbers, emails, phone numbers, street addresses, dates of birth and ID numbers. Calls to OpenAI use store=false. A real deployment still needs staff authentication, a data processing agreement with OpenAI, zero-data-retention approval, and a records-retention decision. See docs/PRIVACY.md in the repository."
security_review: ""
contact_name: Christopher Collins
contact_title: ""
contact_email: "christopher.collins@austintexas.gov"
submitter_github: coa-chrisc
---

## Problem
Residents often need help before they know which program, department, nonprofit or phone number to look for. Someone who just lost a job may qualify for food, rent, health coverage and job-training help from a dozen providers, and a directory with 87 entries doesn't tell them where to start.

## Approach
A resident picks a life event, such as losing a job, a new baby or an aging parent, or just starts typing. An AI assistant asks a few short questions: household size, ZIP code, housing, work, income range, insurance and immediate needs. It skips questions the resident has already answered. The model uses tools to search the catalog, record the profile, check for crisis language and run the matching engine.

Matching is rules-based, not left to the model. Each service declares the eligibility conditions it requires (veteran, older adult, has children, and so on). A service the resident clearly doesn't qualify for is dropped; one the intake can't confirm is ranked lower and marked "check eligibility". Crisis services (domestic violence, suicide risk, homelessness) skip the queue and lead the plan. The plan shows one starting service per need, with phone, directions, hours and documents to bring, followed by the rest.

Residents can also browse a searchable directory and a map, and share their plan by text, email, QR code or print. A staff console shows aggregate demand and language data. In the demo that console uses generated data.

### How resident information is kept from the model
Residents don't create accounts, and the intake never needs a name, Social Security number, address, phone number or date of birth. If someone types one anyway:

- The backend removes it **before** the message is stored or sent to OpenAI, replaces it with a placeholder such as `[phone removed]`, and tells the resident it was removed. Redaction uses fixed patterns, not AI. It covers Social Security numbers, payment cards (checksum-verified), emails, phone numbers, street addresses, dates of birth and ID/member numbers. It deliberately leaves ZIP codes, ages, household counts and dollar amounts, which the intake needs.
- The redactor never logs the removed values, only their types.
- The model is told never to ask for or repeat these details.
- Every OpenAI call is made with `store=false`.
- The greeting says the guide uses AI from OpenAI and asks residents not to share names or ID numbers. It does not promise confidentiality.
- Sessions live only in server memory and are deleted after 24 hours. Share links say when they expire.

Limits, stated plainly: pattern matching does not catch names, addresses without a house number, or numbers spelled out in words. Sensitive situations described in plain language, such as health conditions or immigration status, pass through on purpose, because they are often what the resident needs help with. The full account is in [docs/PRIVACY.md](https://github.com/coa-chrisc/austin-service-guide/blob/main/docs/PRIVACY.md).

## Time and resources
Built by Austin Public Health IT staff using an AI pair programmer. The first working version took two days (April 2026). Voice intake was added in May 2026 (see the companion voice entry). A bug-fix and privacy pass came in October 2026. Software cost was zero beyond existing staff time. Running it with live AI costs only OpenAI API usage, and without an API key it runs a scripted intake for free.

## Results
The demo was shown to the Austin Public Health Commission to make the case for AI-assisted service navigation concrete. It is a pilot demonstration and has not been used with real residents. Its value so far is showing that a working resident-facing prototype, admin console included, can be built in days rather than months, and giving leaders something real to react to.

## Lessons learned
- **Don't let the model decide eligibility.** Early versions led a housed renter's plan with homeless shelters. We moved eligibility into explicit rules that a reviewer can read and test, and kept the model for conversation.
- **Keep identifiers out at the boundary.** Removing identifiers before anything is stored or sent is simpler to verify than trusting the model to ignore them.
- **Be honest in the interface.** We removed a "confidential" claim from the greeting because typed text goes to an AI vendor. The notice now says what happens instead.
- **A scripted fallback makes demos reliable.** Without an API key, the app runs a scripted intake, so a live presentation doesn't depend on a network or a vendor.

## How to reuse this
Fork the repository and replace the YAML files in `backend/app/data/services/` with your jurisdiction's services. Each file holds one service: eligibility conditions, documents, hours and locations. Branding comes from one `brand.config.json`. Run it without a key to demo the scripted flow, and add an OpenAI (or Azure OpenAI) key for the live assistant. Before using it with real residents, work through the "What a real deployment still needs" list in `docs/PRIVACY.md`: staff authentication, vendor agreements, zero data retention, and a retention policy.
