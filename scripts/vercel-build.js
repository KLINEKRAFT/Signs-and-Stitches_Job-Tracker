// Vercel "build": copies the static files into dist/ and writes config.js from
// the API_URL environment variable. No bundling, no dependencies.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const FILES = ['index.html', 'styles.css', 'api.js', 'options.js', 'app.js', 'logo.png', 'favicon.png', 'robots.txt'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
FILES.forEach((f) => fs.copyFileSync(path.join(root, f), path.join(out, f)));

const url = (process.env.API_URL || '').trim();
if (url) {
  fs.writeFileSync(path.join(out, 'config.js'),
    'window.APP_CONFIG = ' + JSON.stringify({ API_URL: url }, null, 2) + ';\n');
  console.log('config.js written from API_URL');
} else if (fs.existsSync(path.join(root, 'config.js'))) {
  fs.copyFileSync(path.join(root, 'config.js'), path.join(out, 'config.js'));
  console.log('config.js copied from the project folder');
} else {
  console.warn('No API_URL set: the site will run in demo mode.');
}
console.log('Built ' + FILES.length + ' files into dist/');
