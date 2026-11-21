#!/usr/bin/env node
/**
 * Builds the installable userscript:
 *   dist/reddit-truth-auditor.user.js  - metadata block + readable (unminified) bundle
 *   dist/reddit-truth-auditor.meta.js  - metadata block only (cheap update checks)
 *
 *   node userscript/build.mjs           one-off build
 *   node userscript/build.mjs --watch   rebuild on change
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const RAW = 'https://raw.githubusercontent.com/pjvjay/reddit-truth-auditor/main/dist';

const meta = {
  name: 'Reddit Truth Auditor',
  namespace: 'https://github.com/pjvjay/reddit-truth-auditor',
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  homepageURL: pkg.homepage,
  supportURL: pkg.bugs.url,
  icon: 'https://www.reddit.com/favicon.ico',
  match: ['https://www.reddit.com/*', 'https://reddit.com/*', 'https://old.reddit.com/*', 'https://new.reddit.com/*', 'https://sh.reddit.com/*'],
  grant: ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_xmlhttpRequest', 'GM_addStyle', 'GM_registerMenuCommand', 'GM_info'],
  // Known endpoints are listed so most users never see a permission prompt; "*" lets users point the
  // script at their own community server or OpenAI-compatible endpoint (Tampermonkey asks once per new domain).
  connect: ['api.openai.com', 'api.tavily.com', 'openrouter.ai', 'localhost', '127.0.0.1', '*'],
  'run-at': 'document-idle',
  noframes: '',
  updateURL: `${RAW}/reddit-truth-auditor.meta.js`,
  downloadURL: `${RAW}/reddit-truth-auditor.user.js`,
};

function metadataBlock() {
  const width = Math.max(...Object.keys(meta).map((k) => k.length)) + 2;
  const lines = ['// ==UserScript=='];
  for (const [k, v] of Object.entries(meta)) {
    for (const value of Array.isArray(v) ? v : [v]) lines.push(`// @${k.padEnd(width)}${value}`.trimEnd());
  }
  lines.push('// ==/UserScript==');
  return `${lines.join('\n')}\n`;
}

const HEADER = `${metadataBlock()}
/*
 * Reddit Truth Auditor v${pkg.version} - ${pkg.homepage}
 * Built from userscript/src (readable, unminified). License: ${pkg.license}.
 * Privacy: ${pkg.homepage}/blob/main/docs/privacy.md
 */`;

const options = {
  entryPoints: [resolve(root, 'userscript/src/index.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  charset: 'utf8',
  legalComments: 'none',
  minify: false,
  loader: { '.css': 'text', '.json': 'json' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: { js: HEADER },
  outfile: resolve(root, 'dist/reddit-truth-auditor.user.js'),
  logLevel: 'info',
};

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/reddit-truth-auditor.meta.js'), metadataBlock());

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching userscript/src …');
} else {
  await esbuild.build(options);
}
