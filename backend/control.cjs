'use strict';
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const operation = process.argv[2];
  if (!['open', 'stop'].includes(operation)) throw new Error('Choose open or stop');
  const stateDir = path.resolve(process.env.NS_SEEK_STATE_DIR || path.join(__dirname, '../.private'));
  const { adminToken } = JSON.parse(fs.readFileSync(path.join(stateDir, 'secrets.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:18765/local/${operation}`, { method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local control request failed');
  const result = await response.json();
  if (operation === 'open') fs.writeFileSync(path.join(stateDir, 'connect-url.txt'), `http://127.0.0.1:18765/#setup=${result.code}`, { mode: 0o600 });
  console.log(operation === 'open' ? 'Local panel connection prepared.' : 'Local service stopped.');
})().catch(() => { console.error('Could not control local service. Check it is running and uses this state directory.'); process.exitCode = 1; });
