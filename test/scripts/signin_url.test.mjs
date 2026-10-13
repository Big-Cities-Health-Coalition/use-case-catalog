/**
 * `submit.signin_url`, the switch for "Sign in with GitHub" on /submit/: the
 * address check `npm run validate` applies (scripts/lib/signin_url.mjs), and
 * the key surviving a run of either configurator, which has no question for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as jsYaml from 'js-yaml';

import { signinUrlProblem } from '../../scripts/lib/signin_url.mjs';
import { applyAnswers, answersFromConfig } from '../../assets/js/configurator/answers.js';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';
import { renderFiles } from '../../assets/js/configurator/render-files.js';

test('blank, missing or off is fine: the feature is simply not on', () => {
  for (const value of [undefined, null, '', '   ', false])
    assert.equal(signinUrlProblem(value), '', String(value));
});

test('the sign-in service’s https origin is accepted, with or without a trailing slash', () => {
  for (const value of [
    'https://catalog-signin.vercel.app',
    'https://catalog-signin.vercel.app/',
    'https://signin.example.org:8443',
    ' https://catalog-signin.vercel.app ',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]) {
    assert.equal(signinUrlProblem(value), '', value);
  }
});

test('anything the page would mangle or that would carry the token unencrypted is refused', () => {
  const cases = {
    'http://catalog-signin.vercel.app': /must start with https/,
    'ftp://catalog-signin.vercel.app': /must start with https/,
    'javascript:alert(1)': /must start with https/,
    'catalog-signin.vercel.app': /not a web address/,
    'https://catalog-signin.vercel.app/api/login':
      /no path or query — use "https:\/\/catalog-signin\.vercel\.app"/,
    'https://catalog-signin.vercel.app/?x=1': /no path or query/,
    'https://catalog-signin.vercel.app/#top': /no path or query/,
    'https://user:pass@catalog-signin.vercel.app': /no path or query/,
  };
  for (const [value, pattern] of Object.entries(cases)) assert.match(signinUrlProblem(value), pattern, value);
  assert.match(signinUrlProblem(42), /in quotes/);
  assert.match(signinUrlProblem(['https://a.example']), /in quotes/);
});

test('a hand-set signin_url survives the configurators, which never ask about it', () => {
  // Set by hand here rather than read from this repository's _data/site.yml,
  // which a deployment owns: it may leave the key out or point it at its own
  // service.
  const base = defaultConfig();
  base.site.submit = { ...base.site.submit, signin_url: 'https://catalog-signin.vercel.app' };
  const config = applyAnswers(base, { ...answersFromConfig(base), siteName: 'Renamed' });
  const site = jsYaml.load(renderFiles(config)['_data/site.yml']);
  assert.equal(site.submit.signin_url, 'https://catalog-signin.vercel.app');
});
