// ESLint flat config. Two environments: browser IIFEs/modules under assets/js and
// Node ESM under scripts/, test/ and services/. Style is Prettier's job; this catches bugs.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '_site/**',
      'node_modules/**',
      'vendor/**',
      '.claude/**',
      'assets/js/lunr.min.js',
      'assets/css/site.css',
    ],
  },
  js.configs.recommended,
  {
    files: ['assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, lunr: 'readonly' },
    },
  },
  // The search worker is worker-scope code: self/importScripts/postMessage
  // instead of window.
  {
    files: ['assets/js/search-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.worker, lunr: 'readonly' },
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'test/**/*.mjs',
      'services/**/*.mjs',
      'eslint.config.js',
      'tailwind.config.js',
      'postcss.config.js',
    ],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  // test/a11y/** drives a browser from Node: the bodies of `page.evaluate()`
  // callbacks are browser code living inside a Node module, so both sets of
  // globals are legitimately in scope in one file.
  {
    files: ['test/a11y/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // This release probe is a Node CLI whose page.evaluate() callbacks run in Chrome.
  {
    files: ['scripts/interaction_performance.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // quality/ is CommonJS (its own package.json): pa11y-ci and Lighthouse CI require() their configs.
  {
    files: ['quality/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  // yaml.mjs deliberately matches control characters to decide when to quote.
  { files: ['scripts/lib/yaml.mjs'], rules: { 'no-control-regex': 'off' } },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
    },
  },
];
