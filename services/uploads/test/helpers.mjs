/**
 * Shared fixtures for the upload service tests: a throwaway App key, the
 * environment, sample files, and a fake GitHub that answers the calls the
 * service makes and records every one of them. No network.
 */
import { generateKeyPairSync } from 'node:crypto';

export const SERVICE = 'https://uploads.example.app';
export const SITE = 'https://acme.github.io';
export const OWNER = 'acme';
export const REPO = 'catalog-uploads';
export const USER_TOKEN = 'ghu_' + 'U'.repeat(36);
export const INSTALL_TOKEN = 'ghs_' + 'I'.repeat(36);
export const USER_ID = 4242;
export const INSTALLATION_ID = 77;
export const SET = 'abcdefghijklmnopqrstuvwx23';
export const NOW = Date.parse('2026-10-16T12:00:00Z');

export const { privateKey: PRIVATE_PEM, publicKey: PUBLIC_KEY } = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    publicKey: pair.publicKey,
  };
})();

export const ENV = Object.freeze({
  UPLOADS_APP_ID: '123456',
  UPLOADS_APP_PRIVATE_KEY: PRIVATE_PEM,
  UPLOADS_REPO: `${OWNER}/${REPO}`,
  ALLOWED_ORIGIN: SITE,
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A body of `size` bytes that starts with `head`.
 * @param {number[]|string} head
 * @param {number} [size]
 * @returns {Uint8Array}
 */
export function file(head, size = 64) {
  const start = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head);
  const bytes = new Uint8Array(Math.max(size, start.length)).fill(0x41);
  bytes.set(start, 0);
  return bytes;
}

export const png = (size) => file(PNG_SIGNATURE, size);

/** @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
export function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A request to the service, from the catalog site unless told otherwise.
 * @param {string} method
 * @param {{body?: BodyInit, headers?: Record<string,string|null>, query?: string}} [options]
 */
export function request(method, { body, headers = {}, query = '' } = {}) {
  const all = {
    Origin: SITE,
    Authorization: `Bearer ${USER_TOKEN}`,
    'Content-Type': 'application/octet-stream',
    'X-Upload-Set': SET,
    'X-Upload-Kind': 'image',
    ...headers,
  };
  for (const [name, value] of Object.entries(all)) if (value === null) delete all[name];
  return new Request(`${SERVICE}/api/upload${query}`, { method, body, headers: all, duplex: 'half' });
}

/**
 * A fake api.github.com. `routes` override any default by `METHOD /path`; an
 * override returning undefined falls through to the default.
 * @param {{user?: object, refs?: string[], routes?: Record<string, Function>, now?: () => number}} [options]
 */
export function fakeGitHub({ user, refs = [], routes = {}, now = () => NOW } = {}) {
  const state = { refs: new Set(refs), calls: [] };
  const theUser = user ?? { id: USER_ID, login: 'octo', created_at: '2015-01-01T00:00:00Z' };
  const base = `/repos/${OWNER}/${REPO}`;
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = parsed.pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { url: String(url), method, path, body, headers: init.headers ?? {} };
    call.auth = call.headers.Authorization;
    state.calls.push(call);
    const override = routes[`${method} ${path}`];
    if (override) {
      const answer = await override(call, state);
      if (answer !== undefined) return answer;
    }
    if (method === 'GET' && path === '/user') {
      return call.auth === `Bearer ${USER_TOKEN}`
        ? json(200, theUser)
        : json(401, { message: 'Bad credentials' });
    }
    if (method === 'GET' && path === `${base}/installation`) return json(200, { id: INSTALLATION_ID });
    if (method === 'POST' && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return json(201, { token: INSTALL_TOKEN, expires_at: new Date(now() + 60 * 60 * 1000).toISOString() });
    }
    const matching = `${base}/git/matching-refs/heads/`;
    if (method === 'GET' && path.startsWith(matching)) {
      const prefix = `refs/heads/${path.slice(matching.length)}`;
      return json(
        200,
        [...state.refs]
          .filter((ref) => ref.startsWith(prefix))
          .map((ref) => ({ ref, object: { sha: 'c'.repeat(40) } }))
      );
    }
    if (method === 'POST' && path === `${base}/git/blobs`) return json(201, { sha: 'b'.repeat(40) });
    if (method === 'POST' && path === `${base}/git/trees`) return json(201, { sha: 'd'.repeat(40) });
    if (method === 'POST' && path === `${base}/git/commits`) return json(201, { sha: 'c'.repeat(40) });
    if (method === 'POST' && path === `${base}/git/refs`) {
      if (state.refs.has(body.ref)) return json(422, { message: 'Reference already exists' });
      state.refs.add(body.ref);
      return json(201, { ref: body.ref });
    }
    const refPath = `${base}/git/refs/heads/`;
    if (method === 'DELETE' && path.startsWith(refPath)) {
      const ref = `refs/heads/${path.slice(refPath.length)}`;
      if (!state.refs.delete(ref)) return json(422, { message: 'Reference does not exist' });
      return new Response(null, { status: 204 });
    }
    return json(404, { message: 'Not Found' });
  };
  impl.state = state;
  impl.calls = state.calls;
  return impl;
}

/** The ref name a file is stored under. */
export const branch = (sha256, set = SET, id = USER_ID) => `refs/heads/u/${id}/${set}/${sha256}`;
