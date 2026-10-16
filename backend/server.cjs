'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store.cjs');
const { hashPassword, verifyPassword } = require('./password.cjs');
const VERSION = require('../package.json').version;
const random = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createApp({ store, queryToken = random(), syncToken = random(), adminToken = random(), passwordHash = null,
  publicOrigin = null, persist = () => {}, now = Date.now } = {}) {
  if (publicOrigin && !/^https:\/\/ns\.042804\.xyz(?::8443)?$/.test(publicOrigin)) throw new Error('Invalid public origin');
  const setupCodes = new Map();
  const pairCodes = new Map();
  const sessions = new Map();
  const limits = new Map();
  let paired = false;
  let collector = { state: 'idle', stage: 'none', receivedAt: null, page: null, recordId: null, errorCode: null };
  const syncStatus = () => ({ ...collector, paired, stale: collector.state === 'running' && now() - collector.receivedAt > 45000 });
  let loginWindow = { start: 0, count: 0 };
  const sessionCookie = (code, maxAge = 28800) => `ns_seek_session=${code}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${publicOrigin ? '; Secure' : ''}`;
  function issue(map, ttl) {
    for (const [key, entry] of map) if (entry.expires <= now()) map.delete(key);
    if (map.size >= 20) map.delete(map.keys().next().value);
    const code = random();
    map.set(code, { expires: now() + ttl });
    return code;
  }
  function consume(map, code) {
    const entry = map.get(code);
    if (!entry || entry.expires <= now()) { map.delete(code); return false; }
    map.delete(code);
    return true;
  }
  function reply(res, status, data, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('invalid_body');
    const chunks = [];
    let size = 0;
    let oversized = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512 * 1024) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    }
    if (oversized) throw new Error('invalid_body');
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
    return value;
  }
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    const origin = `http://${host}`;
    try {
      if (req.headers.host !== host || (req.headers.origin && ![origin, publicOrigin, 'https://www.nodeseek.com'].filter(Boolean).includes(req.headers.origin))) {
        reply(res, 403, { ok: false, error: 'origin_denied' }); return;
      }
      if (req.method === 'OPTIONS') {
        reply(res, 403, { ok: false, error: 'browser_cross_site_denied' }); return;
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin) { reply(res, 403, { ok: false, error: 'origin_denied' }); return; }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)ns_seek_session=([A-Za-z0-9_-]+)/)?.[1];
      const session = sessions.get(cookie);
      const local = !!session && session.expires > now() && (!req.headers.origin || [origin, publicOrigin].includes(req.headers.origin));
      const scope = equal(token, adminToken) ? 'admin' : equal(token, syncToken) ? 'sync' : equal(token, queryToken) ? 'query' : local ? 'local' : 'none';
      if (['sync', 'query'].includes(scope)) paired = true;
      const minute = Math.floor(now() / 60000);
      const bucket = limits.get(scope) || { minute, count: 0 };
      if (bucket.minute !== minute) { bucket.minute = minute; bucket.count = 0; }
      bucket.count += 1; limits.set(scope, bucket);
      if (bucket.count > (scope === 'none' ? 60 : 480)) { reply(res, 429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '60' }); return; }
      if (req.method === 'GET' && url.pathname === '/health' && !url.search) {
        reply(res, 200, { ok: true, service: 'ns-seek-local', version: VERSION }); return;
      }
      if (req.method === 'GET' && ['/', '/panel.js', '/panel.css'].includes(url.pathname) && !url.search) {
        const file = { '/': 'panel.html', '/panel.js': 'panel.js', '/panel.css': 'panel.css' }[url.pathname];
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.end(fs.readFileSync(path.join(__dirname, 'panel', file))); return;
      }
      if (req.method === 'POST' && url.pathname === '/local/session') {
        const value = await body(req);
        if (Object.keys(value).length !== 1 || !consume(setupCodes, value.code)) { reply(res, 401, { ok: false, error: 'setup_expired' }); return; }
        const sessionCode = issue(sessions, 8 * 60 * 60 * 1000);
        reply(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessionCode) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const value = await body(req);
        if (now() - loginWindow.start >= 60000) loginWindow = { start: now(), count: 0 };
        if (++loginWindow.count > 5) { reply(res, 429, { ok: false, error: 'login_rate_limited' }, { 'Retry-After': '60' }); return; }
        if (!verifyPassword(value.password, passwordHash)) { reply(res, 401, { ok: false, error: 'login_failed' }); return; }
        reply(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(issue(sessions, 8 * 60 * 60 * 1000)) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/pair/claim') {
        const value = await body(req);
        if (Object.keys(value).length !== 1 || !consume(pairCodes, value.code)) { reply(res, 401, { ok: false, error: 'pair_expired' }); return; }
        paired = true;
        reply(res, 200, { ok: true, queryToken, syncToken }); return;
      }
      if (scope === 'none') { reply(res, 401, { ok: false, error: 'unauthorized' }); return; }
      if (req.method === 'POST' && url.pathname === '/auth/password' && local && !url.search) {
        const value = await body(req);
        if (passwordHash && !verifyPassword(value.currentPassword, passwordHash)) { reply(res, 401, { ok: false, error: 'current_password_failed' }); return; }
        const updatedHash = hashPassword(value.newPassword);
        const updated = { queryToken: random(), syncToken: random(), adminToken: random(), passwordHash: updatedHash, publicOrigin };
        persist(updated);
        ({ queryToken, syncToken, adminToken, passwordHash } = updated);
        sessions.clear(); pairCodes.clear(); setupCodes.clear(); paired = false;
        collector = { state: 'idle', stage: 'none', receivedAt: null, page: null, recordId: null, errorCode: null };
        reply(res, 200, { ok: true, rePairRequired: true }, { 'Set-Cookie': sessionCookie(issue(sessions, 8 * 60 * 60 * 1000)) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout' && local) {
        sessions.delete(cookie);
        reply(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/local/open' && scope === 'admin' && !url.search) {
        await body(req);
        reply(res, 200, { ok: true, code: issue(setupCodes, 5 * 60 * 1000) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/local/stop' && scope === 'admin' && !url.search) {
        await body(req);
        reply(res, 200, { ok: true });
        setImmediate(() => server.close()); return;
      }
      if (req.method === 'GET' && url.pathname === '/local/status' && local && !url.search) {
        reply(res, 200, { ok: true, paired, sync: syncStatus(), archive: store.status() }); return;
      }
      if (req.method === 'POST' && url.pathname === '/local/pair' && local) {
        await body(req);
        reply(res, 200, { ok: true, code: issue(pairCodes, 5 * 60 * 1000) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/status' && ['query', 'sync'].includes(scope) && !url.search) {
        reply(res, 200, { ok: true, sync: syncStatus(), archive: store.status() }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/progress' && scope === 'sync' && !url.search) {
        const value = await body(req);
        if (Object.keys(value).some((k) => !['state', 'stage', 'page', 'recordId', 'errorCode'].includes(k)) ||
            !['running', 'stopped', 'completed', 'error'].includes(value.state) ||
            !['none', 'recent', 'verify', 'history'].includes(value.stage) ||
            (value.page != null && (!Number.isInteger(value.page) || value.page < 1 || value.page > 100)) ||
            (value.recordId != null && (!Number.isSafeInteger(value.recordId) || value.recordId < 1)) ||
            (value.errorCode != null && !['login', 'challenge', 'rate_limit', 'format', 'network', 'unknown'].includes(value.errorCode))) throw new Error('invalid_record');
        collector = { state: value.state, stage: value.stage, page: value.page ?? null, recordId: value.recordId ?? null,
          errorCode: value.errorCode ?? null, receivedAt: now() };
        paired = true;
        reply(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync-plan' && scope === 'sync' && !url.search) {
        reply(res, 200, { ok: true, ...store.plan() }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/ingest' && scope === 'sync' && !url.search) {
        reply(res, 200, { ok: true, ...store.ingest(await body(req)) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/user' && scope === 'query') {
        if ([...url.searchParams.keys()].some((k) => !['uid', 'before', 'limit'].includes(k)) ||
            ['uid', 'before', 'limit'].some((k) => url.searchParams.getAll(k).length > 1)) throw new Error('invalid_record');
        reply(res, 200, { ok: true, ...store.query(url.searchParams.get('uid'), url.searchParams.get('before'), Number(url.searchParams.get('limit') || 50)) }); return;
      }
      reply(res, 403, { ok: false, error: 'route_or_scope_denied' });
    } catch (error) {
      if (!res.headersSent) reply(res, ['invalid_record', 'conflicting_record', 'invalid_body', 'weak_password'].includes(error.message) || error instanceof SyntaxError ? 400 : 500,
        { ok: false, error: ['invalid_record', 'conflicting_record', 'invalid_body', 'weak_password'].includes(error.message) ? error.message : 'request_failed' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return { server, setupCode: () => issue(setupCodes, 5 * 60 * 1000) };
}

if (require.main === module) {
  const stateDir = path.resolve(process.env.NS_SEEK_STATE_DIR || path.join(__dirname, '../.private'));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const secretsFile = path.join(stateDir, 'secrets.json');
  if (!fs.existsSync(secretsFile)) fs.writeFileSync(secretsFile, JSON.stringify({ queryToken: random(), syncToken: random(), adminToken: random() }), { mode: 0o600, flag: 'wx' });
  const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  if (![secrets.queryToken, secrets.syncToken, secrets.adminToken].every((v) => /^[A-Za-z0-9_-]{43}$/.test(v)) || new Set([secrets.queryToken, secrets.syncToken, secrets.adminToken]).size !== 3) throw new Error('Invalid local credential file');
  const publicOrigin = process.env.NS_SEEK_PUBLIC_ORIGIN || secrets.publicOrigin || null;
  if (publicOrigin && !secrets.passwordHash) throw new Error('Public service requires an initialized password');
  const store = openStore(path.join(stateDir, 'archive.sqlite'));
  const persist = (value) => {
    const temporary = secretsFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, secretsFile);
  };
  const app = createApp({ store, ...secrets, publicOrigin, persist });
  const maintenance = setInterval(() => store.purge(), 60 * 60 * 1000);
  maintenance.unref();
  app.server.once('close', () => { clearInterval(maintenance); store.close(); });
  app.server.on('error', () => { console.error('Local service could not start; check port 18765.'); store.close(); process.exitCode = 1; });
  app.server.listen(18765, '127.0.0.1', () => {
    fs.writeFileSync(path.join(stateDir, 'connect-url.txt'), `${publicOrigin || 'http://127.0.0.1:18765'}/#setup=${app.setupCode()}`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'server.pid'), String(process.pid));
    console.log('NS Seek local service ready on 127.0.0.1:18765.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.server.close());
}
module.exports = { createApp };
