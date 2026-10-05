/**
 * The issue-form element id for a schema field key.
 *
 * GitHub's new-issue page prefills an issue form from the query string, one
 * `?<element id>=<answer>` per question, and the /submit/ page hands its
 * answers over that way. But the page reads some parameters itself before it
 * looks for an element: `?body=` is the plain issue body, `?title=` the issue
 * title, `?labels=` applies labels, `?template=` picks the form, and so on. An
 * element whose id is one of those never receives its answer (confirmed live
 * for `body`: the question showed its default text instead). So a field keyed
 * like one of them gets the id `entry_<key>` in the form, and the handoff sends
 * its answer under that same name. Every other key is its own id, unchanged.
 *
 * Only the id changes. The question's label, which is what GitHub renders as
 * the `### <label>` heading the scaffolder reads back, and the front matter key
 * the entry is saved under both stay as they are.
 *
 * One implementation, loaded two ways, which is why it has no import or
 * export: a classic deferred script on /submit/ (listed before handoff.js in
 * submit/index.md), and a side-effect import in issue-template.js (the
 * generator, for both wizards and `npm run generate`) and schema-validate.js
 * (which rejects a key that would repeat a remapped id, such as `entry_body`
 * beside `body`). Either way it sets `globalThis.PHCTIssueForm`. The no-script
 * route on /submit/ names its controls with the `issue_form_id` Liquid filter
 * (_plugins/theme_filters.rb), whose copy of the list and prefix
 * test/plugins/theme_filters_test.rb keeps equal to this file's.
 */
(function (root) {
  'use strict';

  /** Parameters GitHub's new-issue page claims for itself. */
  const RESERVED_PARAMS = Object.freeze([
    'title',
    'body',
    'labels',
    'assignees',
    'milestone',
    'projects',
    'template',
  ]);

  /** What a reserved key is prefixed with to make its element id. */
  const PREFIX = 'entry_';

  /**
   * @param {string} key a schema field key
   * @returns {string} the element id in the issue form, and the query parameter that prefills it
   */
  function issueFormId(key) {
    const id = String(key);
    return RESERVED_PARAMS.indexOf(id) === -1 ? id : PREFIX + id;
  }

  root.PHCTIssueForm = Object.freeze({ RESERVED_PARAMS: RESERVED_PARAMS, issueFormId: issueFormId });
})(globalThis);
