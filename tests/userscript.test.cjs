'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
const floor = (name = '测试用户', uid = '123', extra = '') => `<article><header><a href="/space/${uid}">${name}</a></header>${extra}<div class="comment-menu"></div></article>`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const raw = (id = 1, extra = {}) => ({ id, target_member_id: 123, target_member_name: '合成用户', admin_member_name: '合成管理员',
  created_at: '2026-10-16T00:00:00Z', post_id: 123, request: '{"suspend":{"status":true,"value":7},"coin":{"coin_diff":-1,"reason":"合成原因"}}', ...extra });
const archive = (extra = {}) => ({ count: 1, nextId: 1, latestId: 5, lastSync: null, completeHistory: false, ...extra });
const queryResult = (records = [raw()], extra = {}) => ({ ok: true, records, total: records.length, nextBeforeId: null, archive: archive(), ...extra });

function setup(t, { html = floor(), paired = true, url = 'https://www.nodeseek.com/post-999999-1', ignoreAbort = false, beforeReady } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  let now = 1000000;
  let timerId = 0;
  const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, due: now + ms }); return id; };
  w.clearTimeout = (id) => timers.delete(id);
  const keys = { queryToken: crypto.randomBytes(32).toString('base64url'), syncToken: crypto.randomBytes(32).toString('base64url') };
  const storage = new Map(paired ? [['local-credentials-v1', keys]] : []);
  const menus = new Map();
  w.GM_getValue = (key, defaultValue) => storage.has(key) ? storage.get(key) : defaultValue;
  w.GM_setValue = (key, value) => storage.set(key, value);
  w.GM_deleteValue = (key) => storage.delete(key);
  w.GM_registerMenuCommand = (name, cb) => menus.set(name, cb);
  const requests = [];
  const reports = [];
  w.GM_xmlhttpRequest = (details) => {
    if (details.url.endsWith('/v1/progress')) { reports.push(JSON.parse(details.data)); queueMicrotask(() => details.onload({status:200,finalUrl:details.url,responseText:'{"ok":true}'})); return {abort(){}}; }
    const req = { details, aborted: false, respond(data, status = 200, extras = {}) {
      details.onload({ status, finalUrl: details.url, responseText: JSON.stringify(data), ...extras });
    } };
    requests.push(req);
    return { abort() { req.aborted = true; if (!ignoreAbort) details.onabort(); } };
  };
  const forum = [];
  w.fetch = (url, init) => new Promise((resolve, reject) => {
    const req = { url, init, at: now, aborted: false, respond(data, status = 200, extras = {}) {
      init.signal.removeEventListener('abort', abort);
      resolve({ status, ok: status >= 200 && status < 300, url: new URL(url, w.location.origin).href, redirected: false,
        headers: new Headers(extras.headers), text: async () => JSON.stringify(data), ...extras });
    } };
    const abort = () => { req.aborted = true; if (!ignoreAbort) reject(new w.DOMException('Aborted', 'AbortError')); };
    init.signal.addEventListener('abort', abort, { once: true });
    if (init.signal.aborted) abort();
    forum.push(req);
  });
  w.eval(source);
  beforeReady?.(w);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const root = () => w.document.querySelector('#ns-seek-host')?.shadowRoot;
  return { w, keys, storage, menus, requests, reports, forum, root,
    open: (index = 0) => w.document.querySelectorAll('[data-ns-seek-button]')[index].click(),
    click: (action) => root().querySelector(`[data-action="${action}"]`).click(),
    text: () => root().textContent,
    async advance(ms = 1200) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now && timers.has(id)) { timers.delete(id); timer.callback(); } await tick(); },
    async sync() { menus.get('私人档案同步')(); requests.at(-1).respond({ ok: true, archive: archive() }); await tick(); },
  };
}

test('a user click queries the fixed local archive without reading the forum', (t) => {
  const s = setup(t);
  assert.equal(s.requests.length, 0); assert.equal(s.forum.length, 0);
  s.open();
  assert.equal(s.requests.length, 1); assert.equal(s.forum.length, 0);
  const r = s.requests[0].details;
  assert.equal(r.url, 'https://ns.042804.xyz:8443/v1/user?uid=123');
  assert.equal(r.headers.Authorization, `Bearer ${s.keys.queryToken}`);
  assert.equal(r.anonymous, true); assert.equal(r.redirect, 'error'); assert.equal(r.headers.Referer, '');
  assert.equal(s.w.localStorage.length, 0);
});

test('unpaired user sees setup guidance without sending requests or exposing credentials', (t) => {
  const s = setup(t, { paired: false }); s.open();
  assert.match(s.text(), /尚未连接/);
  assert.equal(s.requests.length, 0); assert.equal(s.forum.length, 0);
  assert.ok(!s.text().includes(s.keys.queryToken));
});

test('pair code is removed from URL; long-term keys stay in GM storage and are not rendered', async (t) => {
  const code = crypto.randomBytes(32).toString('base64url');
  const s = setup(t, { paired: false, url: 'https://www.nodeseek.com/ruling#ns-seek-pair=' + code, beforeReady(w) { w.history.replaceState(null, '', '/ruling#/p-1'); } });
  assert.equal(s.w.location.hash, '#/p-1');
  assert.equal(JSON.parse(s.requests[0].details.data).code, code);
  assert.equal(s.requests[0].details.url, 'https://ns.042804.xyz:8443/pair/claim');
  assert.equal(s.requests[0].details.headers.Authorization, undefined);
  s.requests[0].respond({ ok: true, ...s.keys }); await tick();
  assert.equal(s.storage.get('local-credentials-v1').queryToken, s.keys.queryToken);
  assert.equal(s.requests[1].details.url, 'https://ns.042804.xyz:8443/v1/status');
  assert.ok(!s.text().includes(s.keys.queryToken) && !s.text().includes(s.keys.syncToken));
});

test('hostile response content renders as text; returned URLs cannot control links', async (t) => {
  const s = setup(t); s.open();
  const payload = '<img src=x onerror=alert(1)>';
  s.requests[0].respond(queryResult([raw(1, { admin_member_name: payload, created_at: payload,
    request: JSON.stringify({ coin: { coin_diff: -1, reason: payload }, postSummary: { title: payload } }),
    post_url: 'https://evil.example/', ruling_url: 'javascript:alert(1)' })])); await tick();
  assert.match(s.text(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(s.root().querySelectorAll('img,script,iframe').length, 0);
  assert.ok([...s.root().querySelectorAll('a')].every((a) => a.href.startsWith('https://www.nodeseek.com/') && a.rel === 'noopener noreferrer'));
});

test('UID mismatch and invalid archive status are rejected without displaying another user', async (t) => {
  const s = setup(t); s.open();
  s.requests[0].respond(queryResult([raw(1, { target_member_id: 456 })])); await tick();
  assert.match(s.text(), /格式不匹配/); assert.equal(s.root().querySelectorAll('article').length, 0);
  s.click('query'); s.requests[1].respond(queryResult([], { archive: { count: {} } })); await tick();
  assert.match(s.text(), /状态格式不匹配/);
});

test('query pagination uses keyset cursor without re-reading forum pages', async (t) => {
  const s = setup(t); s.open(); s.requests[0].respond(queryResult([raw(3)], { nextBeforeId: 3, total: 2 })); await tick();
  s.click('query'); assert.match(s.requests[1].details.url, /&before=3$/);
  s.requests[1].respond(queryResult([raw(2)], { total: 2 })); await tick();
  assert.equal(s.root().querySelectorAll('article').length, 2); assert.equal(s.forum.length, 0);
});

test('closing aborts a pending local request, clears results and restores focus', async (t) => {
  const s = setup(t); s.open(); s.root().querySelector('dialog').close(); await tick();
  assert.equal(s.requests[0].aborted, true);
  assert.equal(s.root().querySelector('[aria-live]').textContent, '');
  assert.equal(s.w.document.activeElement.dataset.nsSeekButton, '1');
});

test('switching user ignores stale responses even if manager ignores cancellation', async (t) => {
  const s = setup(t, { html: floor('甲', '123') + floor('乙', '456'), ignoreAbort: true });
  s.open(); s.open(1);
  s.requests[1].respond(queryResult([raw(2, { target_member_id: 456 })]));
  s.requests[0].respond(queryResult([raw(1)])); await tick();
  assert.equal(s.root().querySelectorAll('article').length, 1);
  assert.match(s.text(), /#2/); assert.doesNotMatch(s.text(), /#1/);
});

for (const [name, status, extras, expected] of [
  ['connection expiry', 401, {}, /过期/], ['rate limit', 429, {}, /过快/],
  ['redirect', 200, { finalUrl: 'https://evil.example/' }, /跳转/],
  ['invalid JSON', 200, { responseText: '<html></html>' }, /格式错误/],
]) test(`local ${name} fails without forum fallback`, async (t) => {
  const s = setup(t); s.open(); s.requests[0].respond({}, status, extras); await tick();
  assert.match(s.text(), expected); assert.equal(s.forum.length, 0);
});

test('local timeout cancels GM request', async (t) => {
  const s = setup(t); s.open(); await s.advance(15000);
  assert.match(s.text(), /超时/); assert.equal(s.requests[0].aborted, true);
});

test('recent sync uses forum login, whitelists record fields and writes with a separate sync token', async (t) => {
  const s = setup(t); await s.sync();
  assert.equal(s.forum.length, 0);
  s.click('recent');
  const f = s.forum[0];
  assert.equal(f.url, '/api/admin/ruling/page-1');
  assert.equal(f.init.credentials, 'same-origin'); assert.equal(f.init.mode, 'same-origin'); assert.equal(f.init.redirect, 'error');
  f.respond({ success: true, data: [raw(5, { cookie: 'synthetic', unused: 'not archived' })], total: 1 }); await tick();
  const write = s.requests.at(-1).details;
  assert.equal(write.url, 'https://ns.042804.xyz:8443/v1/ingest');
  assert.equal(write.headers.Authorization, `Bearer ${s.keys.syncToken}`);
  const payload = JSON.parse(write.data);
  assert.equal(payload.records[0].cookie, undefined); assert.equal(payload.records[0].unused, undefined);
  assert.deepEqual(Object.keys(payload.records[0]).sort(), ['id', 'target_member_id', 'target_member_name', 'admin_member_name', 'created_at', 'post_id', 'request'].sort());
  s.requests.at(-1).respond({ ok: true, allKnown: false, archive: archive() }); await tick();
  assert.match(s.text(), /同步已完成/);
});

test('recent sync stops on existing overlap; forum pacing is enforced', async (t) => {
  const s = setup(t); await s.sync(); s.click('recent');
  s.forum[0].respond({ success: true, data: [raw(5)], total: 40 }); await tick();
  s.requests.at(-1).respond({ ok: true, allKnown: false, archive: archive() }); await tick();
  await s.advance(1199); assert.equal(s.forum.length, 1);
  await s.advance(1); assert.equal(s.forum.length, 2);
  s.forum[1].respond({ success: true, data: [raw(4)], total: 40 }); await tick();
  s.requests.at(-1).respond({ ok: true, allKnown: true, archive: archive() }); await tick();
  await s.advance(100000); assert.equal(s.forum.length, 2); assert.match(s.text(), /同步已完成/);
});

test('history probes a known ID before archiving older IDs, checkpoints empty IDs and resumes', async (t) => {
  const s = setup(t); await s.sync(); s.click('history');
  assert.equal(s.requests.at(-1).details.headers.Authorization, `Bearer ${s.keys.syncToken}`);
  s.requests.at(-1).respond({ ok: true, nextId: 4, latestId: 5 }); await tick();
  assert.equal(s.forum[0].url, '/api/admin/ruling/id-5');
  s.forum[0].respond({ success: true, data: [raw(5)] }); await tick();
  s.requests.at(-1).respond({ ok: true, archive: archive() }); await tick(); await s.advance();
  assert.equal(s.forum[1].url, '/api/admin/ruling/id-4');
  s.forum[1].respond({ success: true, data: [] }); await tick();
  assert.deepEqual(JSON.parse(s.requests.at(-1).details.data), { kind: 'id', records: [], requestedId: 4 });
  s.requests.at(-1).respond({ ok: true, archive: archive({ nextId: 3 }) }); await tick();
  s.click('stop'); await s.advance(10000); assert.equal(s.forum.length, 2);
  s.click('history'); s.requests.at(-1).respond({ ok: true, nextId: 3, latestId: 5 }); await tick();
  s.forum[2].respond({ success: true, data: [raw(5)] }); await tick();
  s.requests.at(-1).respond({ ok: true, archive: archive({ nextId: 3 }) }); await tick(); await s.advance();
  assert.equal(s.forum[3].url, '/api/admin/ruling/id-3');
});

test('failed ID capability check does not mark history as empty or start enumeration', async (t) => {
  const s = setup(t); await s.sync(); s.click('history');
  s.requests.at(-1).respond({ ok: true, nextId: 1, latestId: 5 }); await tick();
  s.forum[0].respond({ success: true, data: [] }); await tick();
  assert.match(s.text(), /未通过验证/);
  assert.equal(s.requests.filter((r) => r.details.url.endsWith('/ingest')).length, 0);
  await s.advance(10000); assert.equal(s.forum.length, 1);
});

test('mismatched record ID and missing UID stop collection without a false checkpoint', async (t) => {
  const s = setup(t); await s.sync(); s.click('history');
  s.requests.at(-1).respond({ ok: true, nextId: 1, latestId: 5 }); await tick();
  s.forum[0].respond({ success: true, data: [raw(99)] }); await tick();
  assert.match(s.text(), /格式已变化/);
  assert.equal(s.requests.filter((r) => r.details.url.endsWith('/ingest')).length, 0);
});

for (const [name, status, extras, expected] of [
  ['login required', 401, {}, /登录/], ['challenge', 403, {}, /验证/], ['ambiguous 500', 500, {}, /HTTP 500/],
  ['non-JSON', 200, { text: async () => '<html>Login</html>' }, /非 JSON/],
  ['redirect', 200, { redirected: true }, /跳转/],
  ['rate limit', 429, { headers: new Headers({ 'Retry-After': '120' }) }, /120 秒/],
]) test(`forum ${name} stops sync without retry or false archive progress`, async (t) => {
  const s = setup(t); await s.sync(); s.click('recent');
  s.forum[0].respond({}, status, extras); await tick();
  assert.match(s.text(), expected);
  await s.advance(200000); assert.equal(s.forum.length, 1);
  assert.equal(s.requests.filter((r) => r.details.url.endsWith('/ingest')).length, 0);
});

test('forum timeout and closing sync abort collection', async (t) => {
  const s = setup(t); await s.sync(); s.click('recent'); await s.advance(15000);
  assert.match(s.text(), /超时/); assert.equal(s.forum[0].aborted, true);
  s.click('recent'); await s.advance(1200);
  s.root().querySelector('dialog').close(); await tick(); assert.equal(s.forum[1].aborted, true);
});

test('disconnect removes private credentials from GM storage', (t) => {
  const s = setup(t); s.menus.get('断开私人连接')();
  assert.equal(s.storage.has('local-credentials-v1'), false);
  s.open(); assert.equal(s.requests.length, 0);
});

test('dynamic authors get one button and quoted/external/nested authors are ignored', async (t) => {
  const s = setup(t, { html: '<article><a href="https://evil.example/space/1">伪造</a><blockquote><a href="/space/2">引用</a></blockquote><div class="comment-menu"></div>' + floor('内层', '3') + '</article>' });
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 1);
  s.w.document.body.insertAdjacentHTML('beforeend', floor('新增', '456'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 2);
});

test('ordinary moderation events send no names, UID or operation details to the archive', async (t) => {
  const s = setup(t); await s.sync(); s.click('recent');
  const row = raw(5, { request: '{"coin":{"coin_diff":-1,"reason":"ordinary event"}}' });
  s.forum[0].respond({ success: true, total: 1, data: [row] }); await tick();
  const sent = JSON.parse(s.requests.at(-1).details.data).records[0];
  assert.deepEqual(sent, { id: 5, created_at: row.created_at, request: '{}' });
});

test('unpaired sync cannot collect; one-time code fallback pairs without a popup', async (t) => {
  const s = setup(t, { paired: false, url: 'https://www.nodeseek.com/ruling#/p-1' });
  await tick();
  assert.match(s.text(), /尚未配对/);
  assert.equal(s.root().querySelector('[data-action="all"]'), null);
  assert.equal(s.forum.length, 0);
  const code = crypto.randomBytes(32).toString('base64url');
  s.root().querySelector('input').value = code;
  s.click('pair');
  assert.equal(JSON.parse(s.requests[0].details.data).code, code);
  s.requests[0].respond({ ok: true, ...s.keys }); await tick();
  s.requests[1].respond({ ok: true, archive: archive() }); await tick();
  assert.ok(s.root().querySelector('[data-action="all"]'));
  assert.equal(s.forum.length, 0);
  assert.ok(!s.text().includes(code));
});

test('sync reports activity, errors and cancellation without sending forum data in progress', async (t) => {
  const s = setup(t); await s.sync(); s.click('recent'); await tick();
  assert.equal(s.reports[0].state, 'running');
  await s.advance(10000);
  assert.ok(s.reports.length >= 2);
  s.forum[0].respond({}, 429, { headers: new Headers({'Retry-After':'60'}) }); await tick(); await tick();
  assert.equal(s.reports.at(-1).state, 'error');
  assert.equal(s.reports.at(-1).errorCode, 'rate_limit');
  assert.ok(s.reports.every(r => Object.keys(r).every(k=>['state','stage','page','recordId','errorCode'].includes(k))));
  await s.advance(60000); s.click('recent'); await tick(); s.click('stop'); await tick(); await tick();
  assert.equal(s.reports.at(-1).state, 'stopped');
});
