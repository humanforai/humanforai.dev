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

// Agent Skills discovery v0.2.0: the index carries a content digest of the
// SKILL.md artifact — compute it from the real file bytes so they never drift.
const crypto = require('node:crypto');
const skillPath = path.join(__dirname, 'public', 'skills', 'hire-a-human', 'SKILL.md');
const indexPath = path.join(__dirname, 'public', '.well-known', 'agent-skills', 'index.json');
const digest = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex');
const skillsIndex = fs.readFileSync(indexPath, 'utf8').replace(/"sha256:(?:auto|[0-9a-f]{64})"/, JSON.stringify(digest));
fs.writeFileSync(indexPath, skillsIndex);
console.log(`agent-skills index digest → ${digest.slice(0, 20)}…`);
