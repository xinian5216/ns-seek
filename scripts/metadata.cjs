'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
const header = source.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)[0] + '\n';
assert.equal(source.match(/@version\s+(\S+)/)[1], require('../package.json').version);
if (process.argv.includes('--write')) fs.writeFileSync('ns-seek.meta.js', header);
assert.equal(fs.readFileSync('ns-seek.meta.js', 'utf8'), header, 'Run npm run build to refresh metadata');
console.log('Version and update metadata match.');
