/**
 * Step 5 — review and publish.
 *
 * Renders every file the configurator owns and hands it to the admin to copy,
 * download, or paste — into the Apply setup issue, or into GitHub's web
 * editor — followed by the optional issue forms the change adds or retires,
 * which `npm run generate` would otherwise have to write or delete. Nothing is
 * written from here.
 */

import {
  githubDeleteFileUrl,
  githubEditFileUrl,
  githubNewFileUrl,
  OPTIONAL_ISSUE_FORMS,
  optionalFormChanges,
  optionalFormPath,
  prefillNoticeIfTooLong,
  renderFiles,
  setupFormsEnabled,
  validateSchema,
} from '../core.js';
import { OPTIONAL_FORM_SOURCES } from '../defaults.generated.js';
import { el } from '../dom.js';
import { announce } from '../wizard/errors.js';
import { buildConfig, currentConfig, state } from '../wizard/state.js';

const FILE_HELP = {
  '_data/site.yml': 'Branding, contact details and module toggles.',
  '_data/theme.yml': 'Colors, fonts and corner rounding.',
  '_data/schema.yml': 'The entry content model — fields, filters and cards.',
  '_data/navigation.yml': 'The header navigation, derived from your modules.',
  '_config.yml':
    'Jekyll build settings. Only the title and description lines change — if you have customised this file, edit those two lines on GitHub instead of pasting the whole thing.',
  '.github/ISSUE_TEMPLATE/new-entry.yml':
    'The GitHub issue form contributors fill in. Generated from the schema.',
  '.github/ISSUE_TEMPLATE/config.yml':
    'The issue chooser and private security-reporting routes. Generated from the repository and branch.',
};

/**
 * A "Copy" button for one rendered file's contents. The result shows as a
 * transient button label for sighted users and is announced through a
 * visually-hidden polite live region beside it, so a screen-reader user hears
 * "Copied" (or the fallback) without focus moving.
 * @param {string} text file contents to copy.
 * @returns {HTMLElement} the button and its status region.
 */
function copyButton(text) {
  const button = el('button', { type: 'button', class: 'btn-secondary', text: 'Copy' });
  const status = el('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  button.addEventListener('click', async () => {
    let result;
    try {
      await navigator.clipboard.writeText(text);
      result = 'Copied';
    } catch {
      result = 'Press Ctrl/Cmd+C';
    }
    button.textContent = result;
    status.textContent = result === 'Copied' ? 'Copied to the clipboard.' : 'Copy failed. Press Ctrl/Cmd+C.';
    window.setTimeout(() => {
      button.textContent = 'Copy';
      status.textContent = '';
    }, 2000);
  });
  return el('span', { class: 'contents' }, [button, status]);
}

/**
 * A "Download" button that saves one rendered file via an object URL,
 * revoked a second after the click so the download has time to start.
 * @param {string} relative the file's repo-relative path; only its basename is used for the download filename.
 * @param {string} text file contents.
 * @returns {HTMLButtonElement}
 */
function downloadButton(relative, text) {
  const button = el('button', { type: 'button', class: 'btn-secondary', text: 'Download' });
  button.addEventListener('click', () => {
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: relative.split('/').pop() });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return button;
}

/**
 * One file to commit: its path, what it is for, the Copy and Download buttons,
 * a link into GitHub, and a scrollable preview.
 * @param {{relative: string, text: string, help: string, eyebrow?: string,
 *   link: {href: string, text: string}|null}} file
 * @returns {HTMLElement}
 */
function fileCard({ relative, text, help, eyebrow = 'File', link }) {
  return el('section', { class: 'card' }, [
    el('div', { class: 'card-header flex flex-wrap items-start justify-between gap-3' }, [
      el('div', { class: 'min-w-0 flex-1 basis-64' }, [
        el('span', { class: 'eyebrow', text: eyebrow }),
        el('p', { class: 'card-title font-mono', text: relative }),
        el('p', { class: 'field-help', text: help }),
      ]),
      // No `shrink-0`: the three buttons are 351px of max-content and a
      // 390px viewport leaves 342px inside the header's padding, so a
      // rigid row pushed the whole page 18px wide. Shrinking lets them
      // wrap instead; at desktop widths there is room and nothing moves.
      el('div', { class: 'flex flex-wrap gap-2' }, [
        copyButton(text),
        downloadButton(relative, text),
        link
          ? el('a', {
              class: 'btn-primary',
              href: link.href,
              target: '_blank',
              rel: 'noopener',
              text: link.text,
            })
          : el('span', { class: 'chip-neutral', text: 'Set a repository to get a GitHub link' }),
      ]),
    ]),
    // max-h in line units so the clamp ends on a line boundary; long lines
    // scroll sideways inside the card rather than clipping.
    el('div', { class: 'max-h-[calc(0.75rem*1.625*12+2rem)] overflow-auto' }, [
      el('pre', { class: 'w-max min-w-full px-6 py-4 text-xs leading-relaxed text-brand-ink' }, [
        el('code', { text }),
      ]),
    ]),
  ]);
}

/**
 * One issue form to delete: the change switched off the setting it follows.
 * @param {string} relative the form's repository-relative path.
 * @param {string} when the setting, as OPTIONAL_ISSUE_FORMS names it.
 * @param {string} repository `owner/repo`, or empty.
 * @param {string} branch the branch the site builds from.
 * @returns {HTMLElement}
 */
function deleteCard(relative, when, repository, branch) {
  return el('section', { class: 'card' }, [
    el('div', { class: 'card-header flex flex-wrap items-start justify-between gap-3' }, [
      el('div', { class: 'min-w-0 flex-1 basis-64' }, [
        el('span', { class: 'eyebrow', text: 'Delete' }),
        el('p', { class: 'card-title font-mono', text: relative }),
        el('p', {
          class: 'field-help',
          text: `${when} is off, so GitHub's New issue page should stop offering this form. Delete the file.`,
        }),
      ]),
      repository
        ? el('a', {
            class: 'btn-primary',
            href: githubDeleteFileUrl(repository, branch, relative),
            target: '_blank',
            rel: 'noopener',
            text: 'Delete on GitHub',
          })
        : el('span', { class: 'chip-neutral', text: 'Set a repository to get a GitHub link' }),
    ]),
  ]);
}

/** @returns {string} the setting an optional form follows, by its path. */
function formWhen(relative) {
  return OPTIONAL_ISSUE_FORMS.find((form) => optionalFormPath(form.file) === relative)?.when ?? 'its setting';
}

/**
 * The publish step for the optional forms, e.g. "Your changes also add 4 issue
 * forms to GitHub's New issue page. …"
 * @param {{add: object, remove: object}} changes from optionalFormChanges.
 * @returns {string}
 */
function formChangeStep(changes) {
  const count = (n) => `${n} issue form${n === 1 ? '' : 's'}`;
  const added = Object.keys(changes.add).length;
  const removed = Object.keys(changes.remove).length;
  const what =
    added && removed
      ? `add ${count(added)} to GitHub's New issue page and take ${removed} off it`
      : added
        ? `add ${count(added)} to GitHub's New issue page`
        : `take ${count(removed)} off GitHub's New issue page`;
  const how = [
    added ? 'press "Create on GitHub" on each new form and commit it unchanged' : '',
    removed ? 'press "Delete on GitHub" on each form to remove and commit the deletion' : '',
  ]
    .filter(Boolean)
    .join(', and ');
  return `Your changes also ${what}. They are listed after the files: ${how}.`;
}

/** The three set-up jobs this wizard cannot do, in the order they matter. */
const MANUAL_STEPS = [
  [
    'Delete the sample entries',
    'This wizard writes configuration, never content. The example entries under `catalog/` ship with the template and stay on your site until you delete those folders.',
  ],
  [
    'Run the "Bootstrap labels" workflow once',
    'The Actions tab → Bootstrap labels → Run workflow. It creates the labels the submission workflows watch for; until it has run, a new submission issue does nothing.',
  ],
  [
    'Let Actions open pull requests',
    'Settings → Actions → General → Workflow permissions: tick "Allow GitHub Actions to create and approve pull requests". Without it, a submission issue fails instead of opening a PR.',
  ],
];

/**
 * The card listing what still has to be done by hand after the files land.
 * @param {string} repository `owner/repo`, or empty.
 * @param {string} branch the branch the site builds from.
 * @returns {HTMLElement}
 */
function manualStepsCard(repository, branch) {
  const launchGuide = repository
    ? `https://github.com/${repository}/blob/${branch}/docs/launch.md`
    : 'https://github.com/crypticpy/phct/blob/main/docs/launch.md';
  return el('section', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('p', { class: 'card-title', text: 'Three things this wizard cannot do for you' }),
      el('p', {
        class: 'section-lead mt-1',
        text: 'Pasting the files above configures the site. These three jobs are done in GitHub itself, and the site is not really live until they are.',
      }),
    ]),
    el(
      'ol',
      { class: 'list-decimal space-y-3 px-10 py-5 text-sm text-brand-ink' },
      MANUAL_STEPS.map(([title, detail]) =>
        el('li', {}, [
          el('span', { class: 'font-semibold', text: title }),
          el('span', { class: 'block text-brand-muted', text: detail }),
        ])
      )
    ),
    el('p', { class: 'border-t border-brand-line px-6 py-4 text-sm' }, [
      el('a', {
        class: 'font-medium underline decoration-brand-accent underline-offset-2',
        href: launchGuide,
        target: '_blank',
        rel: 'noopener',
        text: 'The launch checklist walks through all three',
      }),
      el('span', { class: 'text-brand-muted', text: ' — docs/launch.md in your repository.' }),
    ]),
  ]);
}

/**
 * @returns {{body: HTMLElement}} step 5 body — publish instructions plus every
 *   rendered file with copy/download/"Open on GitHub" actions. Re-validates the
 *   schema and, on failure, shows the problems via `announce()` instead of
 *   rendering the files.
 */
export function renderReview() {
  const config = buildConfig();
  const errors = validateSchema(config.schema);
  if (errors.length > 0) {
    announce(errors);
    return {
      body: el('div', { class: 'card p-6' }, [
        el('p', {
          class: 'text-sm text-brand-ink',
          text: 'Fix the problems listed above on the "Entry model" step, then come back here.',
        }),
      ]),
    };
  }
  announce([]);

  const files = renderFiles(config, { url: '', baseurl: '' });
  const repository = String(state.answers.repository || '').trim();
  const branch = String(state.answers.branch || 'main').trim() || 'main';

  // The Apply setup issue is the path docs/launch.md recommends: three files
  // pasted into a form, and the automation opens the pull request (and runs
  // `npm run generate`). The file-by-file editor route below it is the
  // fallback for a copy whose labels or workflows are not in place yet, and
  // the only route on a finished site: the form only exists while the live
  // site has setup forms on. Nothing runs `generate` on that route, so the
  // optional issue forms the change adds or retires are listed after the files
  // to create or delete by hand, rendered from the same sources generate uses.
  const formChanges = optionalFormChanges(currentConfig.site, config.site, OPTIONAL_FORM_SOURCES);
  const formCount = Object.keys(formChanges.add).length + Object.keys(formChanges.remove).length;
  const applySetupOffered = setupFormsEnabled(currentConfig.site);
  const applySetupUrl = repository
    ? `https://github.com/${repository}/issues/new?template=apply-setup.yml`
    : '';
  const publishLead = applySetupOffered
    ? [
        el('span', { text: 'Easiest: open the ' }),
        applySetupUrl
          ? el('a', {
              class: 'font-medium underline decoration-brand-accent underline-offset-2',
              href: applySetupUrl,
              target: '_blank',
              rel: 'noopener',
              text: 'Apply setup issue',
            })
          : el('span', { text: 'Apply setup issue (Issues → New issue → Apply setup)' }),
        el('span', {
          text: ` and paste _data/site.yml, _data/theme.yml and _data/schema.yml into its three boxes — the automation opens a pull request with all seven files${
            formCount ? ' and the issue form changes listed at the end' : ''
          }. Or paste each file into GitHub's editor:`,
        }),
      ]
    : [
        el('span', {
          text: "Paste each file into GitHub's editor. This site has switched the Apply setup issue off.",
        }),
      ];
  // A success moment before the working document: every check passed, so say so.
  // The illustration comes from a <template> setup/index.md only renders when the
  // image file exists (and with the site's baseurl already applied), so a copy
  // without the artwork gets the text banner alone.
  const doneArt = document.getElementById('wizard-complete-art');
  const banner = el('div', { class: 'card flex items-center gap-5 px-6 py-5' }, [
    ...(doneArt
      ? [el('div', { class: 'h-24 w-24 shrink-0', 'aria-hidden': 'true' }, [doneArt.content.cloneNode(true)])]
      : []),
    el('div', { class: 'min-w-0' }, [
      el('p', { class: 'card-title', text: 'Your configuration is ready' }),
      el('p', {
        class: 'mt-1 text-sm text-brand-muted',
        text: 'Every check passed. Publish the files below and the site rebuilds with these settings.',
      }),
    ]),
  ]);

  const body = el('div', { class: 'space-y-6' }, [
    banner,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('p', { class: 'card-title', text: 'How to publish these changes' }),
        el('p', { class: 'section-lead mt-1' }, publishLead),
      ]),
      el('ol', { class: 'list-decimal space-y-2 px-10 py-5 text-sm text-brand-ink' }, [
        el('li', { text: 'Press Copy on a file below.' }),
        el('li', { text: 'Press "Open on GitHub" — it opens that file in GitHub\'s web editor.' }),
        el('li', {
          text: 'Select everything in the editor (Ctrl/Cmd+A), paste, then press "Commit changes".',
        }),
        el('li', {
          text: 'Repeat for each file. The site rebuilds automatically, usually within a minute or two.',
        }),
        formCount
          ? el('li', {
              text: formChangeStep(formChanges),
            })
          : null,
      ]),
      el('p', {
        class: 'border-t border-brand-line px-6 py-4 text-xs text-brand-muted',
        text: 'GitHub cannot pre-fill its editor for files that already exist, so the copy-and-paste step is unavoidable. Download works too if you prefer to commit from your own machine.',
      }),
    ]),
    ...Object.entries(files).map(([relative, text]) =>
      fileCard({
        relative,
        text,
        help: FILE_HELP[relative] || '',
        link: repository
          ? { href: githubEditFileUrl(repository, branch, relative), text: 'Open on GitHub' }
          : null,
      })
    ),
    ...Object.entries(formChanges.add).map(([relative, text]) => {
      const prefilled = githubNewFileUrl(repository, branch, relative, text);
      const tooLong = prefillNoticeIfTooLong(prefilled);
      return fileCard({
        relative,
        text,
        eyebrow: 'New file',
        help: `An issue form GitHub's New issue page needs now that ${formWhen(relative)} is on.${
          tooLong ? ' Too long to pre-fill: paste it into the new file.' : ''
        }`,
        link: repository
          ? {
              href: tooLong ? githubNewFileUrl(repository, branch, relative, '') : prefilled,
              text: 'Create on GitHub',
            }
          : null,
      });
    }),
    ...Object.entries(formChanges.remove).map(([relative, when]) =>
      deleteCard(relative, when, repository, branch)
    ),
    manualStepsCard(repository, branch),
  ]);
  return { body };
}
