---
layout: entry
render_with_liquid: false
title: Voice intake assistant for service navigation
slug: voice-intake-assistant-for-service-navigation
published: "2026-10-15"
featured: false
thumbnail: ""
organization: Austin Public Health
solution_type:
  - Generative AI tool
  - Application or software
sharing: Open-source code
use_case_category: Administrative & task automation
area:
  - Access to and linkage with care
  - Communications and community engagement
stage: "Idea / exploring"
summary: "Residents can talk instead of type: a realtime voice assistant asks the intake questions, matches services from the catalog, and builds the same service plan as the text chat."
impact: ""
review_status: Under review
ai_role: Both
ai_types:
  - Speech & transcription
  - Chat assistant
  - Agents & automation
ai_tools:
  - OpenAI Realtime API (gpt-realtime-2) over WebRTC
  - OpenAI transcription (gpt-4o-mini-transcribe)
  - Python / FastAPI
  - React / TypeScript
  - Claude Code (AI pair programmer)
  - OpenAI Codex (AI pair programmer)
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
  - src: "/catalog/voice-intake-assistant-for-service-navigation/screenshots/01.png"
    alt: "Choice between voice and text chat; the voice option says audio is sent to OpenAI."
  - src: "/catalog/voice-intake-assistant-for-service-navigation/screenshots/02.png"
    alt: Voice bar in the listening state with the resident's words transcribed live.
  - src: "/catalog/voice-intake-assistant-for-service-navigation/screenshots/03.png"
    alt: "Assistant speaking and naming matched services: WIC, Caritas, Capital IDEA and the food bank."
  - src: "/catalog/voice-intake-assistant-for-service-navigation/screenshots/04.png"
    alt: Finished voice conversation with a Your plan is ready banner and a See my plan button.
  - src: "/catalog/voice-intake-assistant-for-service-navigation/screenshots/05.png"
    alt: Plan built from the voice session, starting with the Austin Public Health WIC program.
deck_pdf: ""
also_deployed_by: []
license: Apache 2.0
access_terms: ""
portability: "Partially — with rework"
portability_notes: "Voice depends on OpenAI's Realtime API: the browser opens a WebRTC connection straight to OpenAI using a short-lived token from the backend. Moving to another realtime speech provider means rewriting the browser hook (frontend/src/hooks/useRealtimeVoiceSession.ts) and the token endpoint. The tools the voice model calls are the same backend functions the text chat uses, so matching, plans and the catalog carry over unchanged."
reused_from:
  - austin-service-guide-ai-assisted-service-navigation
cost_band: No new spend
run_cost: "Under $10k/yr"
procurement:
  - No procurement needed
approvals:
  - Not yet reviewed
equity_note: "Voice helps residents who find typing hard: low literacy, low vision, limited dexterity, or a phone as their only device. The realtime model can speak several languages, but its translations have not been reviewed by people. It needs a microphone, a modern browser and a steady connection, so it is an option alongside text chat, not a replacement. Speech recognition can be less accurate for some accents and noisy settings; the resident sees the transcript as it is written, so mistakes are visible."
no_pii_attestation: true
data_sensitivity:
  - Personal information (PII)
data_sources:
  - Austin-area service catalog (shared with the text guide)
  - Resident speech streamed to OpenAI (transcripts held in server memory for 24 hours)
audience: Public-facing
data_governance_notes: "Audio goes directly from the browser to OpenAI, so it cannot be filtered before OpenAI hears it. Transcripts are redacted (SSNs, cards, emails, phones, addresses, dates of birth, ID numbers) when they sync back to the backend, so the stored conversation and anything later sent to the text model are clean. Realtime tracing is turned off. The Realtime API has no store=false option, so retention follows the account's OpenAI data policy; a real deployment needs zero-data-retention approval that covers Realtime. See docs/PRIVACY.md."
security_review: ""
contact_name: Christopher Collins
contact_title: ""
contact_email: "christopher.collins@austintexas.gov"
submitter_github: coa-chrisc
---

## Problem
A text chat still asks residents to read and type. For people with low literacy, low vision or limited dexterity, or for someone on a phone in a stressful moment, talking is easier. We wanted to see whether the same intake could run as a natural spoken conversation without building a separate system.

## Approach
Voice is a second front door to the [Austin Service Guide](/catalog/austin-service-guide-ai-assisted-service-navigation/). The resident chooses voice or text. The voice option says up front that audio is sent to OpenAI.

- The browser gets a short-lived token from our backend, so the real API key never leaves the server. It then opens a WebRTC connection directly to OpenAI's Realtime API.
- The voice model calls the **same tools** as the text chat: record profile facts, search the catalog, run the rules-based matching engine, finish the intake. Eligibility logic, crisis handling and plans are therefore shared, not duplicated.
- Each exchange is transcribed live on screen, so the resident can see what was heard. Transcripts sync back to the backend and become part of the same session, so a resident can switch between voice and text.
- When the intake finishes, the resident gets the same ranked plan as the text chat.

**About the screenshots:** they show a simulated session. A scripted stand-in for the voice connection played a fictional conversation through the real interface and the real backend tools, so the matches and plan shown are what the app produces. No live audio was recorded.

### How resident information is kept from the model
Voice has weaker protections than text, and we say so:

- Audio streams straight from the browser to OpenAI, so **it cannot be redacted before OpenAI hears it**. If a resident reads out a Social Security number, the voice and transcription models receive it.
- The voice instructions tell the model never to ask for or repeat names, Social Security numbers, addresses, phone numbers, dates of birth or ID numbers, and to steer the conversation back if they come up.
- Resident transcripts are redacted with the same pattern-based filter as typed text when they sync to the backend. The stored conversation, and anything later sent to the text model, never holds the raw identifiers. The browser also replaces its on-screen copy with the redacted version.
- The assistant's own transcripts are redacted for SSNs, cards, dates of birth, ID numbers and emails. Phone numbers and addresses are left in because the assistant reads out service contact details.
- Realtime tracing is turned off. The Realtime API has no `store=false` option, so a real deployment needs a zero-data-retention agreement that covers it.
- Sessions are deleted from server memory after 24 hours.

The full account, including limits, is in [docs/PRIVACY.md](https://github.com/coa-chrisc/austin-service-guide/blob/main/docs/PRIVACY.md).

## Time and resources
Built by Austin Public Health IT staff with an AI pair programmer over three days in May 2026, on top of the existing text guide. Because voice reuses the guide's tools and matching, the work was mostly the browser connection, turn-taking and transcript handling. The only running cost is OpenAI Realtime usage, which is billed by the amount of audio. Voice is off unless an API key is configured.

## Results
**Status: agency-validated functional prototype (pilot-ready).** Austin Public Health built voice intake on top of the text guide in three days and tested it internally against the same backend tools, matching and plans. It was presented with the text guide to the Austin Public Health Commission. A supervised pilot with residents has not started yet. Voice has the larger privacy gap of the two front doors (see above), so closing that gap comes before any pilot.

## Multi-city white-label readiness
Voice inherits everything city-specific from the [Austin Service Guide](/catalog/austin-service-guide-ai-assisted-service-navigation/): the service YAML files, branding and rules-based matching. Another city that adapts the guide gets voice in the same step. The voice-specific parts are:

- **Settings:** model, voice and on/off are environment variables (`OPENAI_REALTIME_*`, `DEMO_MODE`). Voice stays off until a key is configured.
- **Speech provider:** the browser connection is one hook (`frontend/src/hooks/useRealtimeVoiceSession.ts`) plus the backend token endpoint. Moving to another realtime speech provider means rewriting those two pieces. The tools the model calls stay the same.

Container images and cloud deployment templates are not in the repository yet. BCHC's plan for them is in the catalog's [Launchpad architecture roadmap](https://github.com/Big-Cities-Health-Coalition/use-case-catalog/blob/main/docs/bchc/LAUNCHPAD_ARCHITECTURE.md).

## Lessons learned
- **Share the tools, not just the prompt.** Pointing the voice model at the same backend functions as the text chat kept eligibility and crisis logic in one tested place.
- **Voice changes the privacy model.** With text you can filter before the model sees anything; with direct-to-vendor audio you can't. Tell residents before the microphone turns on, and get retention terms that cover realtime audio.
- **Show the transcript.** A visible live transcript lets residents catch recognition errors and builds trust in what was heard.
- **Turn-taking is most of the work.** Greeting timing, microphone locking while the assistant speaks, and finishing cleanly after the last answer took more effort than the AI integration itself.

## How to reuse this
Start from the Austin Service Guide entry. Voice comes with it. Set `OPENAI_API_KEY` and `DEMO_MODE=false`, and choose a voice and model with the `OPENAI_REALTIME_*` settings. The browser side is a single hook (`useRealtimeVoiceSession.ts`). Before real use, review the voice section of `docs/PRIVACY.md` with your privacy office, especially the audio retention terms.
