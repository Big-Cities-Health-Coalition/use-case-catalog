/**
 * `submit.uploads_url` in _data/site.yml: the address of the optional upload
 * service (services/uploads/) that lets signed-in submitters attach screenshots
 * and a PDF deck on /submit/. It follows the same address rules as
 * `submit.signin_url` (scripts/lib/signin_url.mjs) — the submitter's sign-in
 * token is sent to it, so it must be an https origin with nothing after it —
 * and it needs `signin_url`, because only signed-in submitters can upload.
 * Used by scripts/validate.mjs.
 */
import { signinUrlProblem } from './signin_url.mjs';

/**
 * @param {unknown} value the `submit.uploads_url` value as parsed from YAML
 * @param {unknown} signinUrl the `submit.signin_url` value beside it
 * @returns {string} '' when the value is blank or usable, otherwise the problem
 */
export function uploadsUrlProblem(value, signinUrl) {
  if (value === undefined || value === null || value === '' || value === false) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  if (typeof value !== 'string')
    return 'must be a web address in quotes, like "https://catalog-uploads.vercel.app".';
  // Same address rules, worded for this key.
  const problem = signinUrlProblem(value)
    .replaceAll('sign-in service', 'upload service')
    .replaceAll('catalog-signin', 'catalog-uploads');
  if (problem) return problem;
  const signin = typeof signinUrl === 'string' ? signinUrl.trim() : '';
  if (signin === '')
    return 'needs submit.signin_url: uploads work only for signed-in submitters, so set the sign-in service address too (or leave uploads_url blank).';
  return '';
}
