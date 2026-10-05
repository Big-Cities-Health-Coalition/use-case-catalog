/**
 * Step 3 — module toggles. One checkbox per key in `site.modules`; navigation
 * and the home page adapt to them at build time.
 */

import { el } from '../dom.js';
import { save, state } from '../wizard/state.js';

const MODULE_HELP = {
  catalog: 'The browsable, filterable catalog of entries. This is the core of the site.',
  submit: 'A public submission form that opens a GitHub issue, which maintainers turn into a pull request.',
  carousel: 'A featured-entries carousel on the home page.',
  stats: 'Headline numbers (entry counts, contributing organizations) on the home page.',
  events: 'An events calendar rendered from _data/events.yml.',
  cohorts: 'Cohort / program-year pages with timelines and materials.',
  resources: 'A separate curated resource library from _data/resources.yml.',
  governance:
    'A governance & policies page — review process, roles, licensing, privacy, accessibility — from _data/governance.yml. It ships as a worked example; removing the demo content switches it off until you have rewritten it.',
  status:
    'A "Check your submission" page where submitters type the number GitHub gave their submission and see how far it has got. Needs a public repository.',
};

/** @returns {{body: HTMLElement}} step 3 body. */
export function renderModules() {
  const body = el('fieldset', { class: 'space-y-3' }, [
    el('legend', { class: 'section-title', text: 'Modules' }),
    el('p', {
      class: 'section-lead',
      text: 'Turn sections of the site on or off. Navigation and the home page adapt automatically.',
    }),
    ...Object.keys(state.answers.modules).map((key) => {
      const id = `module-${key}`;
      const input = el('input', {
        id,
        type: 'checkbox',
        class: 'mt-1 h-4 w-4 rounded border-brand-line text-brand-primary focus:ring-brand-primary',
      });
      input.checked = Boolean(state.answers.modules[key]);
      input.addEventListener('change', () => {
        state.answers.modules[key] = input.checked;
        save();
      });
      return el(
        'div',
        { class: 'flex items-start gap-3 rounded-xl border border-brand-line bg-surface-card px-4 py-3' },
        [
          input,
          el('div', {}, [
            el('label', { class: 'field-label capitalize', for: id, text: key }),
            el('p', { class: 'field-help', text: MODULE_HELP[key] || '' }),
          ]),
        ]
      );
    }),
  ]);
  return { body };
}
