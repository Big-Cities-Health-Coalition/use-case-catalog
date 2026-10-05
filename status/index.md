---
layout: default
title: "Check your submission"
summary: "Look up where your submission stands using the number GitHub gave it."
permalink: /status/
---
{%- comment -%}
  "Check your submission": a submitter types the number GitHub gave their
  submission and assets/js/status-page.js reads the issue from GitHub's public
  API, showing its title, date and stage. The stage comes from the issue's
  `status:*` label (see assets/js/lib/submission-status.js for the contract).
  The issue automation links here as /status/?n=<number>.

  Part of the `status` module: _plugins/modules.rb drops this page when
  `modules.status` is false in _data/site.yml. A site.yml written before the
  module existed has no `status` key at all, which is not `false`, so the page
  builds there too; every link to it below and in the footer tests `== false`
  for the same reason. Copy comes from site.yml's optional `status:` block.

  The repository is site.yml's `github.repository`, the same key the submit
  page sends issues to. With none (the showcase examples, a fork not set up
  yet) there is nothing to look up, and the page says so instead of offering a
  form that can only fail.

  Data attributes read by assets/js/status-page.js are listed at the top of
  that file.
{%- endcomment -%}
{%- assign cfg = site.data.site -%}
{%- assign st_cfg = cfg.status -%}
{%- assign st_repo = cfg.github.repository | default: '' -%}
{%- assign st_heading = st_cfg.heading | default: page.title -%}
{%- assign st_intro = st_cfg.intro | default: 'Already sent us something? Enter its number to see where it is in the review.' -%}
{%- assign st_label = st_cfg.label | default: 'Submission number' -%}
{%- assign st_hint = st_cfg.hint | default: 'GitHub gave your submission a number when you sent it, like #42. It is in the title of your submission on GitHub and in every email GitHub sends you about it.' -%}
{%- assign st_button = st_cfg.button | default: 'Check status' -%}
{%- assign st_turnaround = cfg.submit.turnaround | default: '' -%}
{%- assign st_mine_url = 'https://github.com/' | append: st_repo | append: '/issues?q=is%3Aissue%20author%3A%40me' -%}

<section class="max-w-prose">
  <span class="eyebrow">Contribute</span>
  <h1 class="page-title mt-2">{{ st_heading }}</h1>
  <p class="mt-4 text-lg text-brand-muted">{{ st_intro }}</p>
</section>

{%- if st_repo == '' %}
<p class="mt-8 flex max-w-xl items-start gap-1.5 rounded-lg border border-brand-line bg-surface-base p-4 text-sm text-brand-ink">
  {% include icon.html name='warning' size='sm' class='mt-0.5 shrink-0' %}<span>This site has no catalog repository behind it, so there are no submissions to look up. On a published catalog this page finds a submission by its number and shows how far it has got.</span>
</p>
{%- else %}

{%- comment -%}
  Without scripts the form cannot ask GitHub anything (a GET form cannot put
  the number into the path of the issue's address), so the reader is pointed
  straight at GitHub: the address pattern, and the list of their own issues.
{%- endcomment %}
<noscript>
  <div class="mt-8 max-w-xl rounded-lg border border-brand-line bg-surface-base p-4 text-sm text-brand-ink">
    <p class="font-semibold">JavaScript is off, so this page cannot look a number up for you.</p>
    <p class="mt-2 text-brand-muted">Your submission is on GitHub at <span class="break-all font-mono text-xs">github.com/{{ st_repo }}/issues/</span> followed by its number. Or <a class="font-semibold text-brand-primary underline underline-offset-2 hover:no-underline" href="{{ st_mine_url }}">see every submission you have made</a>, after signing in to GitHub.</p>
  </div>
</noscript>

<div class="mt-8 max-w-xl" data-status-app data-repo="{{ st_repo }}">
  <form class="card p-6" action="{{ '/status/' | relative_url }}" method="get" data-status-form>
    <div class="field">
      <label class="field-label" for="status-number">{{ st_label }}</label>
      <p class="field-help" id="status-number-hint">{{ st_hint }}</p>
      <div class="flex flex-col gap-3 pt-1 sm:flex-row sm:items-start">
        <input class="field-input sm:max-w-[12rem]" id="status-number" name="n" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-describedby="status-number-hint" data-status-input>
        <button type="submit" class="btn-primary shrink-0">{{ st_button }}</button>
      </div>
      <p class="field-error" id="status-number-error" data-status-error hidden>{% include icon.html name='warning' size='sm' class='mt-0.5 shrink-0' %}<span data-status-error-text></span></p>
    </div>
  </form>

  {%- comment -%}
    Outside the result container on purpose: it is emptied and hidden between
    lookups, and a hidden role="status" region is not announced.
  {%- endcomment %}
  <p class="sr-only" role="status" aria-live="polite" data-status-live></p>
  <div class="mt-6" data-status-result hidden></div>

  <p class="mt-6 text-sm text-brand-muted">Lost the number? <a class="font-medium text-brand-primary underline-offset-2 hover:underline" href="{{ st_mine_url }}">See every submission you have made on GitHub</a>. You will need to be signed in.</p>

  {%- comment -%}
    Stage names and what each one means for the submitter. Rendered here so the
    turnaround promise stays the one site.yml makes on the submit page; the
    script reads them as text. One step of the progress list, cloned per step.
  {%- endcomment %}
  <template data-status-step><li class="progress-step status-step" data-state="upcoming"><span class="progress-dot" aria-hidden="true"><span class="progress-num" data-step-num></span>{% include icon.html name='check' size='xs' class='progress-check' %}</span><span class="pt-0.5"><span class="sr-only" data-step-state></span><span data-step-label></span></span></li></template>
  <template data-status-stage="received" data-label="Received">Your submission is in the queue. A maintainer will turn it into a draft page and send it for review.{% if st_turnaround != '' %} {{ st_turnaround }}{% endif %}</template>
  <template data-status-stage="in-review" data-label="In review">A draft page is ready and the reviewers are reading it. You don't need to do anything now. If they have a question, GitHub will email you.</template>
  <template data-status-stage="changes-requested" data-label="Changes requested">The reviewers have a question or a change for you. Open your submission on GitHub to read their comment, then reply there.</template>
  <template data-status-stage="published" data-label="Published">Your submission is live on the site. Thank you for sharing it.</template>
  <template data-status-stage="declined" data-label="Not published">This submission won't be published. The last comment on GitHub explains why, and you can reply there if you have questions.</template>
  <template data-status-stage="closed" data-label="Closed">This submission is closed. The last comment on GitHub says what happened.</template>
</div>
<script type="module" src="{{ '/assets/js/status-page.js' | relative_url }}"></script>
{%- endif %}
