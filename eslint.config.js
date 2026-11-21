import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'userscript/reddit-truth-auditor.user.js'] },
  js.configs.recommended,
  {
    files: ['userscript/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        __VERSION__: 'readonly',
        GM_getValue: 'readonly', GM_setValue: 'readonly', GM_deleteValue: 'readonly', GM_listValues: 'readonly',
        GM_xmlhttpRequest: 'readonly', GM_addStyle: 'readonly', GM_registerMenuCommand: 'readonly', GM_info: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['userscript/build.mjs', 'userscript/test/unit/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
];
