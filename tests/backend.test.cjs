'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openStore } = require('../backend/store.cjs');
const { createApp } = require('../backend/server.cjs');
const raw = (id, uid = 123, extra = {}) => ({ id, target_member_id: uid, target_member_name: '合成测试用户',
  admin_member_name: '测试管理员', created_at: '2026-10-16T00:00:00Z', post_id: 123, request: '{"suspend":{"status":true,"value":7},"coin":{"coin_diff":-1,"reason":"合成原因"}}', ...extra });
const token = () => crypto.randomBytes(32).toString('base64url');
async function setup(t, options = {}) {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') });
  const keys = { queryToken: token(), syncToken: token(), adminToken: token() };
  const app = createApp({ store, ...keys, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, scope, body, headers = {}) {
    const r = await fetch(origin + route, { method: body !== undefined ? 'POST' : 'GET',
      headers: { ...(scope ? { Authorization: `Bearer ${keys[scope + 'Token']}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, headers: r.headers, value: await r.json() };
  }
  async function session() {
    const r = await request('/local/session', null, { code: app.setupCode() });
    return r.headers.get('set-cookie').split(';')[0];
  }
  return { store, app, keys, origin, request, session };
}

test('SQLite archive persists, indexes UID and supports renamed accounts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-seek-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ns-seek-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const file = path.join(dir, 'archive.sqlite');
  let store = openStore(file, { now: () => Date.parse('2026-10-16T12:00:00Z') });
  store.ingest({ kind: 'page', records: [raw(1, 123, { target_member_name: '旧名' }), raw(2, '123', { target_member_name: '新名' }), raw(3, 456, { target_member_name: '旧名' })] });
  store.close(); store = openStore(file, { now: () => Date.parse('2026-10-16T12:00:00Z') });
  assert.deepEqual(store.query(123, null, 50).records.map((r) => r.id), [2, 1]);
  assert.equal(store.query(123, null, 50).total, 2);
  store.close();
});

test('duplicate records are idempotent; keyset pagination has no repeated rows', (t) => {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') }); t.after(() => store.close());
  const body = { kind: 'page', records: [raw(1), raw(2), raw(3)] };
  assert.equal(store.ingest(body).allKnown, false);
  assert.equal(store.ingest(body).allKnown, true);
  const a = store.query(123, null, 2);
  assert.deepEqual(a.records.map((r) => r.id), [3, 2]);
  assert.deepEqual(store.query(123, a.nextBeforeId, 2).records.map((r) => r.id), [1]);
  assert.equal(store.status().count, 3);
});

test('Descending ID resume advances past known records and confirmed empty responses', (t) => {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') }); t.after(() => store.close());
  store.ingest({ kind: 'page', records: [raw(3), raw(4)] });
  assert.equal(store.plan().nextId, 2);
  store.ingest({ kind: 'id', requestedId: 2, records: [] });
  assert.equal(store.plan().nextId, 1);
  store.ingest({ kind: 'id', requestedId: 1, records: [raw(1)] });
  assert.equal(store.plan().nextId, 0);
  assert.equal(store.status().completeHistory, false);
});

test('partial recent seed is not marked ready before its last page is archived', (t) => {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') }); t.after(() => store.close());
  store.ingest({ kind: 'page', records: [raw(2)], page: 1, lastPage: 2 });
  assert.equal(store.status().recentSeeded, false);
  store.ingest({ kind: 'page', records: [raw(1)], page: 2, lastPage: 2 });
  assert.equal(store.status().recentSeeded, true);
});

test('unknown fields, Cookie payloads, invalid UID/JSON and mismatched ID are rejected atomically', (t) => {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') }); t.after(() => store.close());
  for (const record of [raw(1, 123, { cookie: 'not-a-real-cookie' }), raw(1, null), raw(1, 123, { request: 'broken' })]) {
    assert.throws(() => store.ingest({ kind: 'page', records: [raw(2), record] }), /invalid_record/);
    assert.equal(store.status().count, 0);
  }
  assert.throws(() => store.ingest({ kind: 'id', requestedId: 2, records: [raw(1)] }), /invalid_record/);
  store.ingest({ kind: 'page', records: [raw(1)] });
  assert.throws(() => store.ingest({ kind: 'page', records: [raw(2), raw(1, 999)] }), /conflicting_record/);
  assert.equal(store.status().count, 1);
});

test('health is public but records, status, setup secrets and files are protected', async (t) => {
  const s = await setup(t);
  assert.equal((await s.request('/health')).status, 200);
  for (const p of ['/v1/status', '/v1/user?uid=123', '/local/status', '/.private/secrets.json', '/../../secrets.json']) assert.equal((await s.request(p)).status, 401);
  assert.equal((await s.request('/v1/status', null, undefined, { Authorization: 'Bearer ' + 'é'.repeat(43) })).status, 401);
});

test('read credentials cannot ingest, pair, issue admin sessions or request sync plans', async (t) => {
  const s = await setup(t);
  for (const [p, data] of [['/v1/ingest', { kind: 'page', records: [] }], ['/local/pair', {}], ['/local/open', {}], ['/v1/sync-plan', undefined]]) assert.equal((await s.request(p, 'query', data)).status, 403);
  assert.equal((await s.request('/v1/ingest', 'sync', { kind: 'page', records: [raw(1)] })).status, 200);
  assert.equal((await s.request('/v1/user?uid=123', 'sync')).status, 403);
  assert.equal((await s.request('/v1/user?uid=123', 'query')).value.records.length, 1);
});

test('pairing needs local admin session; codes are one-use and never return admin token', async (t) => {
  const s = await setup(t);
  const cookie = await s.session();
  assert.ok(cookie.startsWith('ns_seek_session='));
  const pair = await s.request('/local/pair', null, {}, { Cookie: cookie, Origin: s.origin });
  assert.equal(pair.status, 200);
  const claim = await s.request('/pair/claim', null, { code: pair.value.code });
  assert.equal(claim.value.queryToken, s.keys.queryToken);
  assert.equal(claim.value.syncToken, s.keys.syncToken);
  assert.equal(claim.value.adminToken, undefined);
  assert.equal((await s.request('/pair/claim', null, { code: pair.value.code })).status, 401);
});

test('expired pairing and setup codes are refused', async (t) => {
  let now = 1000000;
  const s = await setup(t, { now: () => now });
  const setupCode = s.app.setupCode();
  const cookie = await s.session();
  const pair = await s.request('/local/pair', null, {}, { Cookie: cookie });
  now += 300001;
  assert.equal((await s.request('/local/session', null, { code: setupCode })).status, 401);
  assert.equal((await s.request('/pair/claim', null, { code: pair.value.code })).status, 401);
});

test('Host rebinding, foreign origins, CORS preflight and unauthorized writes are denied', async (t) => {
  const s = await setup(t);
  assert.equal((await s.request('/v1/status', 'query', undefined, { Origin: 'https://evil.example' })).status, 403);
  const spoof = await new Promise((resolve, reject) => {
    const request = http.get(s.origin + '/health', { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject);
  });
  assert.equal(spoof, 403);
  const preflight = await fetch(s.origin + '/v1/ingest', { method: 'OPTIONS', headers: { Origin: 'https://www.nodeseek.com' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const cookie = await s.session();
  assert.equal((await s.request('/local/pair', null, {}, { Cookie: cookie, Origin: 'https://www.nodeseek.com' })).status, 401);
});

test('loopback bridge can authenticate despite browser cross-site metadata, without enabling native CORS', async (t) => {
  const s = await setup(t);
  const r = await s.request('/v1/status', 'query', undefined, { Origin: 'https://www.nodeseek.com', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('malformed records, query parameters and oversized bodies fail closed', async (t) => {
  const s = await setup(t);
  assert.equal((await s.request('/v1/user?uid=123&uid=456', 'query')).status, 400);
  assert.equal((await s.request('/v1/user?uid=123&url=https://evil.example', 'query')).status, 400);
  assert.equal((await s.request('/v1/ingest', 'sync', { kind: 'page', records: [raw(1, 123, { request: 'x'.repeat(600000) })] })).status, 400);
  assert.equal(s.store.status().count, 0);
});

test('panel has a restrictive CSP, HttpOnly session and does not embed credentials', async (t) => {
  const s = await setup(t);
  const page = await fetch(s.origin + '/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.ok(!html.includes(s.keys.queryToken) && !html.includes(s.keys.adminToken));
  const session = await s.request('/local/session', null, { code: s.app.setupCode() });
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});

test('public password login, rotation and restart persistence revoke all old capabilities', async (t) => {
  const { hashPassword, verifyPassword } = require('../backend/password.cjs');
  const first = token() + '!Aa1'; const second = token() + '!Aa2';
  let saved;
  const s = await setup(t, { publicOrigin: 'https://ns.042804.xyz:8443', passwordHash: hashPassword(first), persist: (v) => { saved = v; } });
  assert.equal((await s.request('/auth/login', null, { password: 'wrong' })).status, 401);
  const login = await s.request('/auth/login', null, { password: first });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /; Secure/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const pair = await s.request('/local/pair', null, {}, { Cookie: cookie });
  assert.equal((await s.request('/auth/password', null, { currentPassword: 'wrong', newPassword: second }, { Cookie: cookie })).status, 401);
  assert.equal((await s.request('/auth/password', null, { currentPassword: first, newPassword: 'weak' }, { Cookie: cookie })).status, 400);
  const changed = await s.request('/auth/password', null, { currentPassword: first, newPassword: second }, { Cookie: cookie });
  assert.equal(changed.status, 200); assert.equal(changed.value.rePairRequired, true);
  assert.ok(verifyPassword(second, saved.passwordHash)); assert.ok(!verifyPassword(first, saved.passwordHash));
  assert.ok(!JSON.stringify(saved).includes(second));
  for (const role of ['query', 'sync']) assert.equal((await s.request('/v1/status', role)).status, 401);
  assert.equal((await s.request('/local/open', 'admin', {})).status, 401);
  assert.equal((await s.request('/local/status', null, undefined, { Cookie: cookie })).status, 401);
  assert.equal((await s.request('/pair/claim', null, { code: pair.value.code })).status, 401);
  assert.equal((await s.request('/auth/login', null, { password: first })).status, 401);
  assert.equal((await s.request('/auth/login', null, { password: second })).status, 200);
});

test('password guesses are rate limited and foreign-origin login is denied', async (t) => {
  const { hashPassword } = require('../backend/password.cjs');
  const s = await setup(t, { publicOrigin: 'https://ns.042804.xyz:8443', passwordHash: hashPassword(token() + '!Aa1') });
  assert.equal((await s.request('/auth/login', null, { password: 'bad' }, { Origin: 'https://evil.example' })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await s.request('/auth/login', null, { password: 'bad' })).status, 401);
  assert.equal((await s.request('/auth/login', null, { password: 'bad' })).status, 429);
});

test('only recent ban/unban records persist, expiry applies before purge and cleanup removes them', (t) => {
  const { YEAR } = require('../backend/store.cjs');
  let clock = Date.parse('2026-10-16T00:00:00Z');
  const s = openStore(':memory:', { now: () => clock }); t.after(() => s.close());
  const stamp = (ms) => new Date(ms).toISOString();
  const recent = raw(5, 123, { created_at: stamp(clock) });
  const cutoff = raw(4, 123, { created_at: stamp(clock - YEAR) });
  const old = raw(3, 123, { created_at: stamp(clock - YEAR - 1) });
  const coin = raw(2, 123, { created_at: stamp(clock), request: '{"coin":{"coin_diff":1,"reason":"must not store"}}' });
  const unban = raw(1, 123, { created_at: stamp(clock), request: '{"suspend":{"status":false}}' });
  assert.equal(s.ingest({ kind: 'page', records: [recent, cutoff, old, coin, unban] }).accepted, 3);
  assert.deepEqual(s.query(123, null, 50).records.map((r) => r.id), [5,4,1]);
  assert.equal(s.plan().latestId, 5);
  clock += 1;
  assert.equal(s.query(123, null, 50).total, 2, 'expired records cannot be read while waiting for hourly cleanup');
  assert.equal(s.purge(), 1);
  clock += YEAR;
  assert.equal(s.status().count, 0); assert.equal(s.purge(), 2);
});

test('descending history stops only after 20 consecutive valid expired records, never an empty ID', (t) => {
  const clock = Date.parse('2026-10-16T00:00:00Z');
  const s = openStore(':memory:', { now: () => clock }); t.after(() => s.close());
  s.ingest({ kind: 'page', records: [raw(50, 123, { created_at: new Date(clock).toISOString() })] });
  assert.equal(s.plan().nextId, 49);
  for (let n = 49; n >= 40; n--) s.ingest({ kind: 'id', requestedId: n, records: [raw(n,123,{created_at:'2020-01-01T00:00:00Z'})] });
  s.ingest({ kind: 'id', requestedId: 39, records: [] });
  assert.equal(s.plan().retentionBoundaryReached, false);
  for (let n = 38; n >= 19; n--) s.ingest({ kind: 'id', requestedId: n, records: [raw(n,123,{created_at:'2020-01-01T00:00:00Z'})] });
  assert.equal(s.plan().nextId, 0); assert.equal(s.plan().retentionBoundaryReached, true);
  assert.equal(s.status().count, 1); assert.equal(s.status().completeHistory, false);
});

test('sync progress is authenticated, numeric only, ephemeral and marked stale after lost heartbeat', async (t) => {
  let clock = 100000;
  const s = await setup(t, { now: () => clock });
  const progress = { state: 'running', stage: 'recent', page: 2 };
  assert.equal((await s.request('/v1/progress', null, progress)).status, 401);
  assert.equal((await s.request('/v1/progress', 'query', progress)).status, 403);
  assert.equal((await s.request('/v1/progress', 'sync', { ...progress, cookie: 'synthetic' })).status, 400);
  assert.equal((await s.request('/v1/progress', 'sync', { ...progress, errorCode: 'arbitrary personal text' })).status, 400);
  assert.equal((await s.request('/v1/progress', 'sync', progress)).status, 200);
  let status = (await s.request('/v1/status', 'query')).value;
  assert.equal(status.sync.state, 'running'); assert.equal(status.sync.stale, false);
  clock += 45001;
  status = (await s.request('/v1/status', 'query')).value;
  assert.equal(status.sync.stale, true); assert.equal(status.archive.count, 0);
  assert.equal((await s.request('/v1/progress', 'sync', {state:'completed',stage:'recent'})).status, 200);
  assert.equal((await s.request('/v1/status','query')).value.sync.stale, false);
});
