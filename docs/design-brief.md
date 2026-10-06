# Design brief — "Quiet Instrument"

Synthesized from the phase-0 persona panel (product-design principal, civic digital-service UX/a11y lead, information designer, staff front-end engineer + technical writer). This is the reference every UI change in phases 2–4 is checked against, and the rubric the review panel scores with.

> **Amended in v1.4.0 (design pass).** The brief below is the phase-0 original and still
> governs *what* the catalog spends its ink on. Three of its surface rules were revised once
> the tool was working and the question became whether it was pleasant to look at, and
> `docs/design-system.md` is the current authority for those: (1) headings are a serif
> (now distributed as PHCT Serif, a renamed derivative of Source Serif 4) over the sans body — the one typographic gesture that keeps a page of
> controls and facts from reading as a spreadsheet; (2) cards are raised by `shadow-e0`
> (a 1px `ink/10` ring + faint ambient) instead of a `line` border, and a third ground,
> `surface_tint`, gives bands and panels an edge without a border; (3) "Featured" is an
> `ink` pill with the star in `accent`, not an orange pill — `accent` still means Featured
> and nothing else, it just no longer shouts. The hero and footer are a `primary_dark →
> primary` gradient with one masked dot-grid texture; nothing else on the page is decorated.

## Direction

The catalog is a **working tool, not a brochure**. It spends its ink on the data an evaluator needs — *what is it, who runs it, could my team reuse it* — and nothing on decoration a template cannot make meaningful. Structure comes from one hairline (`line`) and disciplined spacing rather than shadow, gradient and colour. Colour appears only where it means something: one interactive hue, one taxonomy hue, one caution hue. Because the visual system is neutral, the same template re-skins convincingly for an event calendar or a resource library.

## Principles

1. Every pixel of a card must reduce someone's decision time.
2. Hairlines and spacing carry structure; shadow only signals "floating above".
3. Colour is semantic — interactive (`primary`), taxonomy (`secondary`), caution (`warn`), featured (`accent`). Nothing else earns a hue.
4. Filters serve results; results are never below the fold.
5. Degrade honestly: no real screenshot means a text-first card, not a fake graphic. Empty blocks disappear; they never leave labelled voids.
6. Never colour- or icon-only: every indicator has visible or screen-reader text.
7. The schema is the data model, not the voice — user-facing wording is plain language (`prompt`, `option_meta.description`).

## System

**Type** (heading font / body font from `theme.yml`): Display 40/44 (−0.02em) · H1 32/38 · H2 24/30 · H3 20/26 · Card title 18/24 · Body 16/26 · Small 14/22 · Micro 12/16 · Eyebrow 11/16 at 0.12em tracking (not 0.28em). Body measure ~68 characters, set in rem as `theme.yml → type.measure` (the CSS `ch` unit is the width of "0", so 65ch renders ~88 characters). Sentence case everywhere; ALL-CAPS only for the single eyebrow.

**Spacing**: 4px base; use only 4/8/12/16/24/32/48/64/96. Card padding 20 (mobile) / 24 (desktop); grid gutter 24; section rhythm 64/96. Inside a card: 8 between related lines, 16 between blocks.

**Radius**: keep the `sharp|soft|round` scale. Cards `lg`, inputs/thumbnails `md`, chips and buttons full pill; nested elements one step down from their parent.

**Elevation**: E0 = `border-brand-line`, no shadow — the default for all cards. E1 (hover) = `0 1px 2px ink/6%, 0 8px 16px -8px ink/12%`. E2 = sticky bars, sheets, popovers only. Never shadow chips, inputs or badges; never stack E1 inside E1.

**Colour tokens** (`_data/theme.yml`): `primary` interactive only (links, active facet, primary button, focus ring — never a decorative fill) · `primary_dark` headings + hero/footer ground · `secondary` taxonomy identity as a dot/icon, never tinted-on-tinted text (default darkened to `#0F6357`) · `accent` "Featured" only · `warn` (new, `#B45309`) PII/PHI indicators and validation · `ink` body · `muted` secondary text at ≥14px · `line` dividers · `line_strong` (new, `#7C8A9B`) borders of interactive controls (≥3:1) · `surface`/`card` grounds · `on_dark` text over `primary_dark`. Light mode only.

**Motion**: 120ms state, 180ms hover/expand, 240ms sheet; easing `cubic-bezier(0.2,0,0,1)`; animate only `transform`/`opacity`. Card hover = border → `primary/40` + 1px lift; no image zoom. Result re-render = 120ms opacity fade, never a reflow animation. Under `prefers-reduced-motion`: transforms and slides become instant, colour/opacity transitions stay, carousel autoplay off. Focus ring appears instantly, always.

## Catalog card

```
┌──────────────────────────────────────┐ ~320px
│ [screenshot 16:9 — band omitted if none]  ★ Featured
├──────────────────────────────────────┤
│ CHICAGO DPH · PILOT                  │  meta line (≤2 segments, weight order)
│ Permit Application Intake Triage     │  h3, 18/24, 2 lines max — the ONLY link
│ ↗ Cuts brief turnaround 3 days → 1 hr│  card:line (impact), semibold
│ LLM workflow that reads daily ESSENCE│  summary, 2-line clamp, muted
│ alerts and drafts a triage note…     │
│ ▪ Epi & surveillance ▪ Data  +2      │  ONE chip family (card:chip, 2 chips + "+n")
├──────────────────────────────────────┤
│ 🎓 Analyst   🛡 PHI   🔒 Internal  🚀 Ready │ signal strip: card:icon fields, ≤4 glyphs total, monochrome
└──────────────────────────────────────┘    (`warn` tone only for sensitivity), each with sr-only "Label: value"
```
Slot caps are enforced by the template, not the schema: 1 badge field (over the image, or inline in the meta line when there is no image), 1 chip family, ≤4 icon glyphs (a multiselect shows ≤2 then "+n"), ≤2 meta segments. Overflow truncates in `weight` order. Cards are `<li>` in a `<ul>`; the title link gets an `after:absolute after:inset-0` hit area; chips stay outside the link. Compact **list row** variant: title · chip family · signal strip · stage, for schemas/lists with many entries.

Not on the card: platform, AI tools, vendor, data sources, contact, links, gallery, AI role.

## Filter & browse

Desktop: 264–280px sticky left rail beside results (results never below the fold). Facet fields grouped by schema `groups` in order; first group open, others collapsed, any group with an active filter force-opens. `select` → single-choice pills (`aria-pressed`), `multiselect`/`list` → any-of pills, boolean → toggle. Live counts `(12)`; zero-count options dim and sort last but never disappear. ≤8 visible per facet, sorted count-desc, then "Show all N".

Results header (sticky): `24 use cases` *of 112* · active-filter pills with `aria-label="Remove filter: Pilot"` · Clear all · Sort (Newest · Recently updated · A–Z · Organization; Relevance when a query is present) · grid/list toggle. Mobile (< lg): a sticky "Filters (2)" button opens a `role="dialog" aria-modal` sheet with the same groups, focus trap, Esc closes, focus returns to trigger, footer "Show 24 results / Clear". Pill targets ≥44px under lg.

State: `?area=hr-workforce,it-ops&stage=pilot&q=triage&sort=az`; `pushState` on toggles, debounced `replaceState` while typing; restored on load; Back undoes. One `role="status"` announces once per change (≥500ms debounce): "12 of 40 use cases. Filters: Pilot, Chicago." Empty state names the cause and offers one-tap removal of each active filter, then "Clear all filters" which returns focus to the results heading.

Search: `role="combobox"` + `aria-expanded/controls/activedescendant`, `listbox`/`option`, arrow keys; first Esc closes, second clears; a failed `search.json` load shows a status message and retries, never silently disables.

## Entry page

```
Home / Use cases / Service Request Routing
┌────────────────────────────────────────────┬──────────────────┐
│ SOURCE CODE · PILOT                        │ REUSE THIS       │ sticky
│ Service Request Routing Assistant          │ ▸ View code      │
│ ↗ One-line impact, 20px                    │ ▸ Live demo      │
│ Philadelphia DPH · published Mar 2026 · updated … │ ▸ Deck (PDF)│
│ ┌────────────────────────────────────────┐ │ ▸ Other resources│
│ │ FACT STRIP — bordered grid, group order│ │ ✉ Contact        │
│ │ 🎓 Analyst │ 🚀 Ready │ 🛡 PHI, De-id │ 🔒 Internal │ │ ⧉ Copy citation │
│ └────────────────────────────────────────┘ │ Details (section)│
│ [ gallery: thumbnails → <dialog> lightbox ]│  AI role, types, │
│ On this page: Problem · Approach · …       │  tools, platform,│
│ ## Problem … ## Approach … ## Lessons      │  data sources    │
│                                            │ Provenance       │
│ ── Related (same area / AI type) ────────  │  Suggest an edit │
│ [3 list rows]                              │                  │
└────────────────────────────────────────────┴──────────────────┘
```
Reading order (and DOM order): breadcrumb → h1 → impact → provenance → fact strip ("Is this reusable for us?") → gallery → TOC (only when ≥3 h2) → body (`--measure`) → sidebar (`aside`) → related. On mobile the fact strip and reuse actions come **before** the prose. Fact-strip items are a `<dl>`: icon `aria-hidden` + visible text (`option_meta.short` with the full value in `title`/sr-only). Gallery: `<dialog>` lightbox, arrow keys, captions from `alt`. Layout degrades by emptying blocks (a 5-field schema collapses the strip to one meta line and the sidebar to Links + Provenance).

## Home

Above the fold: one sentence saying what the collection is and who it is for, a search box that submits into `/catalog/?q=`, and 3–4 **browse-by** tiles built from the lowest-`weight` facet fields. Then featured/recent cards, then an honest stat line computed from the schema (`112 use cases · 24 organizations · 41 with source code`). Never invent numbers the schema cannot source.

## Submit

One page, not a multi-page wizard (survives Back, slow devices, locked-down browsers): a `<section>` per schema group with a visible number, a sticky "Step 2 of 6" rail (IntersectionObserver), and a **live card preview** pinned beside the form (desktop) / collapsible above it (mobile) that updates on `input` — contributors see exactly how their entry will look. Labels use `prompt`; help text sits above the input; `option_meta.description` renders under each option. Validate on blur for format, fully on submit; never disable the submit button — jump to the first problem; error summary `role="alert" tabindex=-1` with links + inline `aria-invalid` messages ("We need a name for your solution."). Autosave to localStorage (debounced 1s) with "Saved just now — this stays on this device" and "Clear draft". Primary action "Review and send on GitHub" (opens GitHub with the issue prefilled), equal-weight "Email it instead", plus "Copy as Markdown". Warn before the 7,000-character URL limit instead of silently dropping the write-up. Screenshots: "You'll attach pictures on the next screen — blur anything showing real people's data" plus a one-sentence alt-text field. After submit: inline confirmation naming the next three steps, turnaround, and who to email.

## Accessibility acceptance checklist (automated where possible)

1. axe/pa11y clean on `/`, `/catalog/`, an entry, `/submit/`, `/setup/` at 390 and 1400.
2. One `h1` per page; no skipped levels. 3. All text ≥4.5:1 (chips, badges, footer). 4. Control borders/focus rings ≥3:1. 5. Visible focus on every interactive element. 6. Tab order = visual order. 7. Skip link → `#main-content`. 8. Card = one heading link, name ≤10 words. 9. Targets ≥24×24, ≥44×44 under lg. 10. Every input has a programmatic label; `for` never targets a fieldset. 11. Help text via `aria-describedby`. 12. Required conveyed beyond `*`. 13. Errors: summary + inline + `aria-invalid`; focus moves to summary. 14. Filter results announced once per change. 15. Filter state round-trips through the URL; Back undoes it. 16. Mobile filter sheet traps focus, Esc closes, focus returns. 17. Search dropdown keyboard-navigable. 18. Every `img` has alt; decorative art `aria-hidden`. 19. New-tab links say so. 20. 200% zoom / 320px width: no horizontal scroll. 21. `prefers-reduced-motion` honoured. 22. Usable with JS disabled (all entries render). 23. `lang` on `<html>`, unique `<title>`. 24. Carousel has prev/next labels and is not the only path to content. 25. HTML validates (no nested interactive elements). 26. Selected, current and complete states stay distinguishable under `forced-colors: active` (High Contrast Mode drops shadows and gradients — see the "Forced colours" section of `docs/design-system.md`).

## Review rubric (used by the persona panel at each checkpoint)

Severity: **P1** blocks release (unusable path, WCAG A/AA failure on a primary path, security/supply-chain exposure, a hardcoded field key, a documented command that doesn't work) · **P2** must fix before v1 (below the bar: inconsistency, missing test/lint/doc, avoidable perf cost) · **P3** nice to have. Ship at P1 = P2 = 0. Every finding carries `file:line` + a one-line fix.

| Dimension | Yes/no checks | 3 | 5 |
|---|---|---|---|
| Visual design & craft | tokens only; one grid + heading scale; presets look deliberate; empty/single/long/no-image states designed; card hierarchy readable in 2s | consistent, generic | a stranger can name the point of view; every state feels authored |
| Interaction & usability | URL state restored; feedback <100ms; submit says what happens next; works at 360px one-thumb; works with JS off / `search.json` 404 | works, some guessing | nobody asks "did that do anything?" |
| Accessibility | axe+pa11y 0 violations; full keyboard incl. carousel/pills/search/nav/sheet; live regions; ≥4.5:1 across presets; correct semantics | automated pass, manual snags | screen-reader walkthrough catalog→filter→entry→submit with no dead ends |
| Front-end code & perf | no file >500 lines / no duplicated logic; every failure path user-visible; no string `innerHTML` for content; Lighthouse a11y ≥95 (CI fails below), perf ≥90 (CI warns below) with subset fonts; unit tests on pure logic | lints clean, ~90 | budgets in CI; every pure function tested; modules ≤ ~250 lines |
| Architecture & maintainability | zero field keys outside `schema.yml`; one source of truth per value; includes prefix their assigns; non-catalog preset needs zero template edits; schema change flows through generate → forms → validator → search | mostly schema-driven | adding a field type = schema + one renderer; parity test proves it |
| Documentation & DX | non-technical adopter live in 15 min; every documented command verified in CI; screenshots current; JSDoc on every export, YARD on every public Ruby method; CONTRIBUTING + ARCHITECTURE explain *why* | accurate reference | docs are the reason to pick this template |

## Baseline engineering findings (folded into the roadmap)

P1: `core.js defaultConfig()` is a hand-kept JS copy of `_data/*.yml` (phase 1: generate from YAML + parity test) · 1.9 MB unsubsetted TTF fonts (phase 4: latin woff2 + preload) · no lint/tests (phase 5) · workflows lack `permissions:` and pin third-party actions by tag (phase 1, quick) · `site.css` build output tracked (phase 4) · `thumbnails.yml` calls `magick` on an IM6 runner (phase 1, alongside screenshots). P2: `entry.html` dead `demo` assign + hardcoded `demo_url`/`embed_url` iframe, `contains 'contact'` heuristic, badge tone from loop index (phase 2) · include-scope leaks `entry/schema/fields/f/v/entries` (phase 2: prefix) · `innerHTML` in `filters.js`/`search.js` (phase 2) · `include_cached` unused (phase 2) · `search.js` memoizes a failed load (phase 2) · nav rendered twice in `header.html` (phase 2) · `core.js`/`setup-page.js`/`presets.js` > 500 lines (phase 1 split; barrel re-export keeps imports stable).
