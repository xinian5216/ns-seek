'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const files = execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let privateValues = [];
const stateDir = path.resolve(process.env.NS_SEEK_STATE_DIR || '.private');
const privateFile = path.join(stateDir, 'secrets.json');
if (fs.existsSync(privateFile)) {
  const value = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
  privateValues = [value.queryToken, value.syncToken, value.adminToken, ...Object.values(value.passwordHash || {})]
    .filter((v) => typeof v === 'string' && v.length >= 20);
}
for (const file of files) {
  assert.ok(!/(?:^|\/)(?:Cookies|History|Login Data|Local State|Preferences|DevToolsActivePort|automation\.json|Singleton[^/]*)$/i.test(file), `Private browser or scheduler state is tracked: ${file}`);
  assert.ok(!/(?:^|\/)\.private(?:\/|$)|(?:^|\/)(?:secrets\.json|connect-url\.txt|\.env(?:\..*)?)$|\.(?:sqlite(?:-[^/]*)?|db(?:-[^/]*)?|pem|key|pid|har|log)$/i.test(file), `Private file is tracked: ${file}`);
  const bytes = fs.readFileSync(file);
  assert.ok(!/(?:^|\/)notifications\.json$/i.test(file), `Private notification settings are tracked: ${file}`);
  assert.ok(privateValues.every((value) => !bytes.includes(Buffer.from(value))), `A private local credential is present in tracked file: ${file}`);
}
console.log(`Public file allowlist checked (${files.length} tracked files); private runtime files and credentials are excluded.`);
