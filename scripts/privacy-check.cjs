'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
for (const pattern of [/\.innerHTML\s*=/, /\bdocument\.cookie\b/, /\blocalStorage\b/, /\bsessionStorage\b/,
  /\beval\s*\(/, /\bnew Function\b/, /\bsendBeacon\s*\(/, /@require\b/, /@resource\b/, /@connect\s+\*/,
  /OWNER_KEY/, /X-NSSeek-Key/, /\bcredentials:\s*['"]include['"]/, /\bXMLHttpRequest\b/, /\bWebSocket\b/]) assert.ok(!pattern.test(source), `Privacy guard rejected ${pattern}`);
assert.deepEqual([...source.matchAll(/@connect\s+(\S+)/g)].map((m) => m[1]), ['ns.042804.xyz']);
assert.deepEqual([...source.matchAll(/@grant\s+(\S+)/g)].map((m) => m[1]).sort(), ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_registerMenuCommand'].sort());
assert.match(source, /const LOCAL = 'https:\/\/ns\.042804\.xyz:8443'/);
assert.match(source, /credentials:\s*'same-origin'/);
assert.match(source, /mode:\s*'same-origin'/);
assert.match(source, /anonymous:\s*true/);
assert.match(source, /redirect:\s*'error'/);
assert.match(source, /referrerPolicy:\s*'no-referrer'/);
assert.equal([...source.matchAll(/\bfetch\s*\(/g)].length, 1);
assert.match(source, /fetch\(`\/api\/admin\/ruling\/\$\{kind\}-\$\{value\}`/);
assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/xinian5216\/ns-seek\/main\/ns-seek\.meta\.js/);
const server = fs.readFileSync('backend/server.cjs', 'utf8');
assert.match(server, /listen\(18765, '127\.0\.0\.1'/);
assert.doesNotMatch(server, /Access-Control-Allow-Origin/);
assert.doesNotMatch(server, /console\.(?:log|error)\([^\n]*(?:Token|req\.|secrets|setupCode|connect-url)/);
console.log('Forum-only collection, fixed HTTPS origin, scopes and credential guardrails passed.');
