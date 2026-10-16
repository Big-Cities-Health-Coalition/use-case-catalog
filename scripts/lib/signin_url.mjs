/**
 * `submit.signin_url` in _data/site.yml: the address of the optional
 * "Sign in with GitHub" service (services/github-signin/). The submit page
 * opens `<origin>/api/login` in a popup and accepts the token only from that
 * origin, so the value must be exactly an origin — https, or plain http for a
 * loopback address while testing locally — with nothing after it but an
 * optional trailing slash. A path would be silently ignored by the page, and a
 * plain-http address would hand the token over an unencrypted connection.
 * Used by scripts/validate.mjs.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @param {unknown} value the `submit.signin_url` value as parsed from YAML
 * @returns {string} '' when the value is blank or usable, otherwise the problem
 */
export function signinUrlProblem(value) {
  if (value === undefined || value === null || value === '' || value === false) return '';
  if (typeof value !== 'string')
    return 'must be a web address in quotes, like "https://catalog-signin.vercel.app".';
  const text = value.trim();
  if (text === '') return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return `${JSON.stringify(text)} is not a web address. Use the sign-in service's address, like "https://catalog-signin.vercel.app".`;
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    return `${JSON.stringify(text)} must start with https:// — the sign-in token must not travel unencrypted.`;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return `${JSON.stringify(text)} must be just the service's address, with no path or query — use ${JSON.stringify(url.origin)}.`;
  }
  return '';
}
