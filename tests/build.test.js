// The Vercel build copies a fixed list of files. Make sure it covers every
// local file index.html loads, so nothing goes missing in production.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('vercel build ships every file index.html references', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => r !== 'config.js');
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'vercel-build.js')], { cwd: ROOT, env: Object.assign({}, process.env, { API_URL: 'https://example.com/exec' }) });
    const dist = path.join(ROOT, 'dist');
    refs.forEach((r) => assert.ok(fs.existsSync(path.join(dist, r)), 'dist is missing ' + r));
    assert.match(fs.readFileSync(path.join(dist, 'config.js'), 'utf8'), /https:\/\/example\.com\/exec/);
  } finally {
    fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  }
});
