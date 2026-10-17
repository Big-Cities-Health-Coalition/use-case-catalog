/**
 * `submit.uploads_url`, the switch for file uploads on /submit/: the address
 * check `npm run validate` applies (scripts/lib/uploads_url.mjs), its
 * dependency on `submit.signin_url`, and the key surviving a run of either
 * configurator, which has no question for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as jsYaml from 'js-yaml';

import { uploadsUrlProblem } from '../../scripts/lib/uploads_url.mjs';
import { applyAnswers, answersFromConfig } from '../../assets/js/configurator/answers.js';
import { defaultConfig } from '../../assets/js/configurator/default-config.js';
import { renderFiles } from '../../assets/js/configurator/render-files.js';

const SIGNIN = 'https://catalog-signin.vercel.app';

test('blank, missing or off is fine, with or without a sign-in service', () => {
  for (const value of [undefined, null, '', '   ', false]) {
    assert.equal(uploadsUrlProblem(value, ''), '', String(value));
    assert.equal(uploadsUrlProblem(value, SIGNIN), '', String(value));
  }
});

test('the upload service’s https origin is accepted next to a sign-in service', () => {
  for (const value of [
    'https://catalog-uploads.vercel.app',
    'https://catalog-uploads.vercel.app/',
    ' https://uploads.example.org:8443 ',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]) {
    assert.equal(uploadsUrlProblem(value, SIGNIN), '', value);
  }
});

test('an address without a sign-in service is a problem: only signed-in submitters can upload', () => {
  for (const signin of [undefined, null, '', '   ', false])
    assert.match(
      uploadsUrlProblem('https://catalog-uploads.vercel.app', signin),
      /needs submit\.signin_url: uploads work only for signed-in submitters/,
      String(signin)
    );
});

test('the same address rules as signin_url apply, worded for the upload service', () => {
  const cases = {
    'http://catalog-uploads.vercel.app': /must start with https/,
    'javascript:alert(1)': /must start with https/,
    'catalog-uploads.vercel.app': /not a web address.*upload service's address/,
    'https://catalog-uploads.vercel.app/api/upload':
      /no path or query — use "https:\/\/catalog-uploads\.vercel\.app"/,
    'https://catalog-uploads.vercel.app/?x=1': /no path or query/,
    'https://user:pass@catalog-uploads.vercel.app': /no path or query/,
  };
  for (const [value, pattern] of Object.entries(cases))
    assert.match(uploadsUrlProblem(value, SIGNIN), pattern, value);
  assert.match(uploadsUrlProblem(42, SIGNIN), /in quotes/);
  assert.match(uploadsUrlProblem(['https://a.example'], SIGNIN), /in quotes/);
  // The address problem is reported before the missing sign-in one.
  assert.match(uploadsUrlProblem('http://x.example', ''), /must start with https/);
});

test('a hand-set uploads_url survives the configurators, which never ask about it', () => {
  const base = defaultConfig();
  base.site.submit = {
    ...base.site.submit,
    signin_url: SIGNIN,
    uploads_url: 'https://catalog-uploads.vercel.app',
  };
  const config = applyAnswers(base, { ...answersFromConfig(base), siteName: 'Renamed' });
  const site = jsYaml.load(renderFiles(config)['_data/site.yml']);
  assert.equal(site.submit.uploads_url, 'https://catalog-uploads.vercel.app');
  assert.equal(site.submit.signin_url, SIGNIN);
});
