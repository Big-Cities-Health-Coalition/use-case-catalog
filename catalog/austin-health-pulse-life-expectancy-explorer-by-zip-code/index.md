---
layout: entry
render_with_liquid: false
title: "Austin Health Pulse — life expectancy explorer by ZIP code"
slug: austin-health-pulse-life-expectancy-explorer-by-zip-code
published: "2026-10-15"
featured: false
thumbnail: ""
organization: Austin Public Health
solution_type:
  - Dashboard or visualization
  - Data pipeline or integration
sharing: Open-source code
use_case_category: Coding & brainstorming
area:
  - Chronic disease and injury prevention
  - Epidemiology and surveillance
  - Communications and community engagement
stage: Pilot
summary: An interactive map and calculator showing how life expectancy and health indicators differ across Travis County's 63 ZIP codes, with an 11.6-year gap between the longest- and shortest-lived.
impact: "Built in about 12 staff hours, against a typical agency estimate of 6–8 weeks"
review_status: Under review
ai_role: AI helped build it
ai_types: []
ai_tools:
  - Claude (AI pair programmer)
  - React / TypeScript / Vite
  - Tailwind CSS
  - Leaflet / OpenStreetMap
  - Recharts
  - Python / pandas / geopandas
platform:
  - Desktop or local
vendor: ""
expertise: Developer
readiness:
  - Needs customization
repo_url: "https://github.com/coa-chrisc/austin-health-pulse"
demo_url: "https://coa-chrisc.github.io/austin-health-pulse/"
docs_url: "https://github.com/coa-chrisc/austin-health-pulse/blob/main/data/README.md"
resources: []
screenshots:
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/01.png"
    alt: Map of Travis County ZIP codes shaded red to green by life expectancy, from 75.3 to 86.8 years.
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/02.png"
    alt: "ZIP 78702 lookup: 76.8 years, 3.1 below the county average, beside the 11.6-year county gap."
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/03.png"
    alt: Ranking strip of all ZIPs plus gauges for poverty, uninsured, diabetes, hypertension and obesity.
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/04.png"
    alt: Lifespan estimator with sliders for smoking, exercise, diet, BMI, sleep and stress.
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/05.png"
    alt: Factors with the most years to gain and a button to find Austin services that can help.
  - src: "/catalog/austin-health-pulse-life-expectancy-explorer-by-zip-code/screenshots/06.png"
    alt: Radar chart comparing three ZIP codes across eight health and social indicators.
deck_pdf: ""
also_deployed_by: []
license: Apache 2.0
access_terms: ""
portability: "Yes — platform-agnostic"
portability_notes: A fully static site with no backend, database or API keys. It is hosted on GitHub Pages but runs from any static web host. The Python pipeline pulls national public sources (CDC USALEEP, ACS, CDC PLACES), so another U.S. county can regenerate the data by changing the county and ZIP list. Violent crime comes from the City of Austin open data portal and would need a local equivalent.
reused_from: []
cost_band: No new spend
run_cost: No ongoing cost
procurement:
  - No procurement needed
approvals:
  - Not yet reviewed
equity_note: "Made to show residents and policymakers that health outcomes in Travis County track neighborhood conditions. Life expectancy data is from 2010–2015 and is shown with its standard error. Small-population ZIP codes are suppressed where estimates are unreliable (for example, the university campus ZIP). ZIP averages hide differences within a ZIP. The calculator uses national cohort studies that may not reflect every population equally, and it says its results are population averages, not predictions. The interface is English only."
no_pii_attestation: true
data_sensitivity:
  - Public data only
data_sources:
  - "CDC USALEEP life expectancy at birth by census tract (2010–2015)"
  - American Community Survey 5-year estimates for poverty and uninsured rates (2022)
  - CDC PLACES estimates for diabetes / hypertension / obesity / asthma (2023)
  - "City of Austin Open Data: APD crime reports (UCR Part 1 violent)"
  - Census ZCTA boundaries and ZCTA-to-tract relationship file
  - NCHS U.S. life tables (calculator)
audience: Public-facing
data_governance_notes: "Public aggregate data only. Tract-level life expectancy is rolled up to ZIP code areas using population-weighted averages. Rates are suppressed for ZIP codes under 1,000 residents. The calculator runs entirely in the browser; the 'find services' link sends only the factor categories (for example, diet or physical activity), never the resident's answers."
security_review: ""
contact_name: Christopher Collins
contact_title: ""
contact_email: "christopher.collins@austintexas.gov"
submitter_github: coa-chrisc
---

## Problem
Life expectancy in Travis County differs by more than 11 years between ZIP codes a few miles apart. That gap is well documented in public datasets, but those datasets are hard for residents, commissioners and community partners to explore. We wanted a tool anyone could open at a community event or on their phone to see their own neighborhood in context.

## Approach
A static web app with three modes:

- **Check your neighborhood:** enter a ZIP code to see life expectancy against the county average, where it ranks among all ZIPs, and gauges for poverty, uninsured rate, diabetes, hypertension and obesity.
- **Explore the map:** a choropleth of every Travis County ZIP code, switchable across eight indicators.
- **Compare ZIP codes:** two or three ZIPs side by side in a radar chart and a table.

A personal lifespan estimator applies effect sizes from large published cohort studies (smoking, activity, diet, BMI, sleep, stress) to the U.S. life table. It shows which factors have the most years to gain and can hand off to the companion [Austin Service Guide](/catalog/austin-service-guide-ai-assisted-service-navigation/) with only those factor categories, so the resident's answers never leave the page. A kiosk mode rotates key facts on screen at events.

A Python pipeline pulls the public sources, rolls tract data up to ZIP codes with population weights, suppresses unreliable small-population estimates, and writes static JSON. The site needs no server.

## Time and resources
Built by Austin Public Health IT staff in about 12 hours (three four-hour sessions), using Claude as an AI pair programmer. That covers the pipeline, all three modes, the calculators, kiosk mode and the deployment workflow. Loaded staff cost was about $1.5K, against a typical agency estimate of 250–400 hours ($50K–$100K). Hosting on GitHub Pages is free and all data is public.

## Results
A working public-facing prototype that shows the county's life expectancy gap at a glance, demonstrated to the Austin Public Health Commission. It shows how AI-assisted development can turn a public dataset into something residents can use in days rather than months, and lets the department test the idea with the community before committing to a production build.

## Lessons learned
- **Check the data, not just the code.** A review pass found a campus ZIP code with too few residents for stable rates, and a few missing values that displayed as zero. We added population-based suppression and an "N/A" state.
- **Say what the numbers are.** Showing the data vintage (2010–2015), standard errors and "population average, not a prediction" alongside the results keeps a persuasive tool honest.
- **Static is durable.** No backend means nothing to patch and no hosting cost. Third-party map tiles are the exception: our original basemap provider started requiring an API key, and we switched to OpenStreetMap.
- **Link insight to action.** The handoff from "factors with the most years to gain" to local services makes the data useful to the person looking at it.

## How to reuse this
Fork the repository. To use another county, change the ZIP code list in `app/src/lib/constants.ts` and the county filter in the pipeline. Then run `scripts/export_frontend_json.py` and `scripts/prepare_geojson.py` to regenerate the data. USALEEP, ACS and CDC PLACES cover the whole U.S.; replace the Austin crime source with your own or drop that indicator. Enable GitHub Pages (Source: GitHub Actions) and the included workflow lints, tests, builds and deploys on every push.
