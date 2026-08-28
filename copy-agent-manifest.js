/**
 * Functions predeploy: keep function-served files single-sourced.
 * public/ is the editable source. Copies ship to:
 *   - functions/agent.json           (the api function serves /agent.json
 *                                     for traffic analytics)
 *   - public/.well-known/agent.json  (static discovery endpoint)
 *   - functions/pages/               (the api function serves / and 404s
 *                                     with markdown content negotiation —
 *                                     index/404 in both .html and .md)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, 'public', 'agent.json');
for (const dest of [
  path.join(__dirname, 'functions', 'agent.json'),
  path.join(__dirname, 'public', '.well-known', 'agent.json'),
]) {
  fs.copyFileSync(src, dest);
  console.log(`agent.json copied → ${path.relative(__dirname, dest)}`);
}

const pagesDir = path.join(__dirname, 'functions', 'pages');
fs.mkdirSync(pagesDir, { recursive: true });
for (const name of ['index.html', 'index.md', '404.html', '404.md']) {
  fs.copyFileSync(path.join(__dirname, 'public', name), path.join(pagesDir, name));
  console.log(`${name} copied → ${path.relative(__dirname, path.join(pagesDir, name))}`);
}
