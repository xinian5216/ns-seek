'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
// Guardrails complement (and do not replace) code review and a full-history secret scan.
for (const pattern of [/\.innerHTML\s*=/, /\bdocument\.cookie\b/, /\blocalStorage\b/, /\bsessionStorage\b/,
  /\beval\s*\(/, /\bnew Function\b/, /\bsendBeacon\s*\(/, /@require\b/, /@resource\b/, /@connect\s+\*/,
  /GM_xmlhttpRequest/, /OWNER_KEY/, /X-NSSeek-Key/, /limit=100000/, /@connect\s+\S+/,
  /\bcredentials:\s*['"]include['"]/, /\bXMLHttpRequest\b/, /\bWebSocket\b/]) {
  assert.ok(!pattern.test(source), `Privacy guard rejected ${pattern}`);
}
assert.deepEqual([...source.matchAll(/@grant\s+(\S+)/g)].map((m) => m[1]), ['none']);
assert.match(source, /credentials:\s*'same-origin'/);
assert.match(source, /mode:\s*'same-origin'/);
assert.match(source, /redirect:\s*'error'/);
assert.match(source, /referrerPolicy:\s*'no-referrer'/);
assert.equal([...source.matchAll(/\bfetch\s*\(/g)].length, 1);
assert.match(source, /fetch\(`\/api\/admin\/ruling\/page-\$\{page\}`/);
assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/xinian5216\/ns-seek\/main\/ns-seek\.meta\.js/);
console.log('Privacy and update-source guardrails passed.');
