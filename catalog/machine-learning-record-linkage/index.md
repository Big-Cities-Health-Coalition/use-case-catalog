---
layout: entry
render_with_liquid: false
title: Machine learning record linkage
slug: machine-learning-record-linkage
published: "2026-10-05"
featured: false
thumbnail: ""
organization: "Public Health – Seattle & King County"
solution_type:
  - "AI/ML model"
sharing: "Open-source code"
use_case_category: "Administrative & task automation"
area:
  - "Data modernization and informatics"
stage: "In production"
summary: "Efficient and accurate way to link identities across datasets"
impact: ""
review_status: Under review
ai_role: "AI is part of the solution"
ai_types: []
ai_tools:
  - "R"
platform:
  - "Desktop or local"
vendor: ""
expertise: "Analyst or data scientist"
readiness:
  - "Needs customization"
repo_url: "https://github.com/PHSKC-APDE/hyrule"
demo_url: ""
docs_url: ""
resources: []
screenshots: []
deck_pdf: ""
also_deployed_by: []
license: "GPL / AGPL"
access_terms: ""
portability: "Yes — platform-agnostic"
portability_notes: "Runs on a desktop or laptop; could be deployed into any VM or adapted for platforms such as Databricks."
reused_from: []
cost_band: "No new spend"
run_cost: "No ongoing cost"
procurement:
  - "Grant funded"
approvals:
  - "None required"
equity_note: ""
no_pii_attestation: true
data_sensitivity:
  - "Personal information (PII)"
data_sources: []
audience: "Internal staff"
data_governance_notes: ""
security_review: ""
contact_name: "Alastair Matheson"
contact_title: "Data Modernization Director"
contact_email: "alastair.matheson@kingcounty.gov"
submitter_github: ""
---

## Problem
We need to link records across systems (and deduplicate within systems) all the time, so have built up various methodologies. However, a research grant needed to link data across 12 administrative data systems with over 6m unique identifiers, which was more than existing methods could handle efficiently. Therefore, we needed a new way to link records.

## Approach
We build on some work being done at the state department of health to implement a machine learning-based linkage model. Key enhancements included adding a screener regression model that quickly classifies obvious matches and non-matches, flexibility in the variables used to match, and a network/cluster analysis to catch over-linked individuals.

## Time and resources
The only cost for the work was staff time, which was paid for by the grant. The model can run on local laptops with no issues up to several million records.

Initial development took approximately 3 months of a data scientist working at full time, and we have spent an additional ~250 hours adding enhancements and improving performance. 

## Results
The linkage performs well both in terms of accuracy and computational need. 

We compared match results with output from Splink (Python package) and our existing integrated data hub, which uses Informatica. In both cases, the ML linkage was generally slightly more accurate across a range of metrics.

The process is also very efficient, able run from end-to-end (including refreshing and cleaning data) in about 5 hours.

## Lessons learned
With dedicate time and focus, it is possible to build linkage systems that compete or outperform commercial offerings.

## How to reuse this
Other organizations could fork the GitHub repo and start applying the process relatively quickly. Most time will be spent preparing datasets for linkage and building a testing/training dataset with your specific data.
