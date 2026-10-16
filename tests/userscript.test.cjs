'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
const floor = (name = '测试用户', uid = '123456', extra = '') => `<article><header><a href="/space/${uid}">${name}</a></header>${extra}<div class="comment-menu"></div></article>`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const row = (overrides = {}) => ({ id: 1, target_member_id: 123456, target_member_name: '已改名',
  post_id: 999999, admin_member_name: '测试管理员', created_at: '2026-01-01T00:00:00Z',
  request: JSON.stringify({ coin: { coin_diff: -1, reason: '测试原因' } }), ...overrides });
const page = (rows = [row()], total = rows.length) => ({ success: true, data: rows, total });

function setup(t, html = floor(), options = {}) {
  const dom = new JSDOM(html, { url: 'https://www.nodeseek.com/post-999999-1', runScripts: 'outside-only', pretendToBeVisual: true });
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
  const requests = [];
  w.fetch = (url, init) => new Promise((resolve, reject) => {
    const req = { url, init, aborted: false, at: now, respond(data, status = 200, extras = {}) {
      if (!options.ignoreAbort) init.signal.removeEventListener('abort', abort);
      resolve({ status, ok: status >= 200 && status < 300, url: new URL(url, w.location.origin).href,
        redirected: false, headers: new Headers(extras.headers), text: async () => JSON.stringify(data), ...extras });
    }, fail() { reject(new w.TypeError('Network failure')); } };
    const abort = () => { req.aborted = true; if (!options.ignoreAbort) reject(new w.DOMException('Aborted', 'AbortError')); };
    init.signal.addEventListener('abort', abort, { once: true });
    if (init.signal.aborted) abort();
    requests.push(req);
  });
  w.eval(source);
  const root = () => w.document.querySelector('#ns-seek-host')?.shadowRoot;
  return { w, requests, root,
    open: (index = 0) => w.document.querySelectorAll('[data-ns-seek-button]')[index].click(),
    query: () => root().querySelector('[data-action="query"]').click(),
    stop: () => root().querySelector('[data-action="stop"]').click(),
    text: () => root().textContent,
    async advance(ms = 1200) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
      await tick();
    },
  };
}

test('no request until explicit query; same-origin login fetch without target UID or custom credentials', (t) => {
  const s = setup(t);
  assert.equal(s.requests.length, 0);
  s.open();
  assert.equal(s.requests.length, 0);
  s.query();
  assert.equal(s.requests.length, 1);
  const r = s.requests[0];
  assert.equal(r.url, '/api/admin/ruling/page-1');
  assert.equal(r.init.credentials, 'same-origin');
  assert.equal(r.init.mode, 'same-origin');
  assert.equal(r.init.redirect, 'error');
  assert.equal(r.init.referrerPolicy, 'no-referrer');
  assert.equal(r.init.cache, 'no-store');
  assert.deepEqual(Object.keys(r.init.headers), ['Accept']);
  assert.equal(s.w.localStorage.length, 0);
  assert.equal(s.w.sessionStorage.length, 0);
});

test('exact UID matching handles renamed users; same-name accounts and missing UID are not attributed', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row(), row({ id: 2, target_member_id: 9, target_member_name: '测试用户' }),
    row({ id: 3, target_member_id: null }), row({ id: 4, target_member_id: '00123456' })]));
  await tick();
  assert.equal(s.root().querySelectorAll('article').length, 2);
  assert.match(s.text(), /缺少有效 UID/);
  assert.match(s.text(), /匹配 2 条/);
});

test('remote fields and user names render as text; hostile IDs cannot create links', async (t) => {
  const payload = '<img src=x onerror=alert(1)>';
  const s = setup(t, floor('&lt;img src=x onerror=alert(1)&gt;')); s.open(); s.query();
  s.requests[0].respond(page([row({ id: payload, post_id: 'https://evil.example/', admin_member_name: payload,
    created_at: payload, request: JSON.stringify({ coin: { reason: payload, coin_diff: -1 }, postSummary: { title: payload } }) })]));
  await tick();
  assert.match(s.text(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(s.root().querySelectorAll('img,script,iframe,a').length, 0);
});

test('links are constructed only from numeric IDs and point to forum originals', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row({ post_url: 'javascript:alert(1)', ruling_url: 'https://evil.example/' })]));
  await tick();
  const links = [...s.root().querySelectorAll('a')];
  assert.deepEqual(links.map((a) => a.href), ['https://www.nodeseek.com/post-999999-1', 'https://www.nodeseek.com/ruling#/id-1']);
  assert.ok(links.every((a) => a.rel === 'noopener noreferrer' && a.referrerPolicy === 'no-referrer'));
});

test('compound actions are decoded from the JSON document inside request', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row({ request: JSON.stringify({ coin: { coin_diff: -10, reason: '版规' },
    stardust: { stardust_diff: 5 }, postSummary: { title: '新标题', category: 'tech', rank: 1, locked: true, award: false },
    suspend: { value: 7 }, hideComment: { status: true }, pinComment: { status: false } }) })]));
  await tick();
  for (const value of ['鸡腿 -10', '星辰 +5', '标题设为 新标题', '移动版块：tech', '阅读权限设为 1', '锁定帖子', '撤销推荐阅读', '禁言：7 天', '隐藏内容', '取消置顶']) assert.ok(s.text().includes(value), value);
});

test('unparseable details preserve matching record and link, rather than silently hiding it', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row({ request: '{broken' })]));
  await tick();
  assert.equal(s.root().querySelectorAll('article').length, 1);
  assert.match(s.text(), /明细无法解析/);
});

test('malformed non-text fields cannot throw during rendering or discard matching records', async (t) => {
  const s = setup(t); s.open(); s.query();
  const invalid = { toString: 'invalid' };
  s.requests[0].respond(page([row({ admin_member_name: invalid, created_at: invalid,
    request: JSON.stringify({ suspend: { value: invalid } }) })]));
  await tick();
  assert.equal(s.root().querySelectorAll('article').length, 1);
  assert.match(s.text(), /禁言：天数未提供/);
});

test('five-page batches stop without auto-continuation; pacing also applies across batches', async (t) => {
  const s = setup(t); s.open(); s.query();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(s.requests.length, i + 1);
    s.requests[i].respond(page([row({ id: i + 1 })], 200));
    await tick();
    if (i < 4) { await s.advance(1199); assert.equal(s.requests.length, i + 1); await s.advance(1); }
  }
  assert.match(s.text(), /第 1–5 页/);
  assert.equal(s.requests.length, 5);
  s.query();
  assert.equal(s.requests.length, 5);
  await s.advance(1200);
  assert.equal(s.requests.length, 6);
  assert.equal(s.requests[5].url, '/api/admin/ruling/page-6');
  assert.ok(s.requests.slice(1).every((r, i) => r.at - s.requests[i].at >= 1200));
});

test('never reads page 101 even when server total is larger than the readable range', async (t) => {
  const s = setup(t); s.open();
  for (let i = 0; i < 100; i += 1) {
    if (i % 5 === 0) s.query();
    if (i > 0) await s.advance(1200);
    assert.equal(s.requests.length, i + 1);
    s.requests[i].respond(page([row({ id: i + 1, target_member_id: 9 })], 50000));
    await tick();
  }
  await s.advance(100000);
  assert.equal(s.requests.length, 100);
  assert.match(s.text(), /100 页读取上限/);
  assert.match(s.text(), /不保证覆盖全部历史/);
  assert.equal(s.root().querySelector('[data-action="query"]'), null);
});

test('stop during pacing keeps completed pages and resumes the unfinished page', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row()], 100));
  await tick(); s.stop();
  await s.advance(5000);
  assert.equal(s.requests.length, 1);
  assert.equal(s.root().querySelectorAll('article').length, 1);
  s.query();
  assert.equal(s.requests[1].url, '/api/admin/ruling/page-2');
});

test('new query aborts old fetch and ignores stale response even if fetch ignores cancellation', async (t) => {
  const s = setup(t, floor('甲', '111') + floor('乙', '222'), { ignoreAbort: true });
  s.open(0); s.query(); s.open(1); s.query();
  await s.advance(1200);
  assert.equal(s.requests[0].aborted, true);
  s.requests[1].respond(page([row({ target_member_id: 222, request: JSON.stringify({ coin: { reason: '乙的记录' } }) })]));
  s.requests[0].respond(page([row({ target_member_id: 111, request: JSON.stringify({ coin: { reason: '甲的旧结果' } }) })]));
  await tick();
  assert.match(s.text(), /乙的记录/);
  assert.doesNotMatch(s.text(), /甲的旧结果/);
});

test('close aborts request, clears results and restores focus', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.root().querySelector('dialog').close();
  await tick();
  assert.equal(s.requests[0].aborted, true);
  assert.equal(s.root().querySelector('[aria-live]').textContent, '');
  assert.equal(s.w.document.activeElement.dataset.nsSeekButton, '1');
});

test('rate limit blocks further clicks and reopening; no automatic retry when cooldown expires', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond({}, 429, { headers: new Headers({ 'Retry-After': '120' }) });
  await tick();
  assert.match(s.text(), /120 秒/);
  s.query(); s.open(); s.query();
  assert.equal(s.requests.length, 1);
  await s.advance(120000);
  assert.equal(s.requests.length, 1);
  s.query();
  assert.equal(s.requests.length, 2);
});

test('Retry-After HTTP date is honored', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond({}, 429, { headers: new Headers({ 'Retry-After': new Date(1120000).toUTCString() }) });
  await tick();
  assert.match(s.text(), /120 秒/);
});

for (const [name, data, status, extras, message] of [
  ['login required', {}, 401, {}, /登录/],
  ['browser challenge', {}, 403, {}, /浏览器验证/],
  ['ambiguous server 500', {}, 500, {}, /HTTP 500.*可能/],
  ['HTTP failure', {}, 503, {}, /HTTP 503/],
  ['non-JSON response', {}, 200, { text: async () => '<html>Login</html>' }, /非 JSON/],
  ['schema drift', { ok: true, records: [] }, 200, {}, /格式已变化/],
  ['missing total', { success: true, data: [] }, 200, {}, /格式已变化/],
  ['invalid row', page([null]), 200, {}, /格式已变化/],
  ['server rejection', { success: false, message: 'permission denied' }, 200, {}, /未允许/],
  ['cross-origin result', page(), 200, { url: 'https://evil.example/' }, /跳转/],
  ['same-origin login redirect', page(), 200, { redirected: true }, /跳转/],
  ['oversized response', {}, 200, { text: async () => 'x'.repeat(1024 * 1024 + 1) }, /过大/],
]) test(`stops on ${name} without auto-retry`, async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(data, status, extras);
  await tick();
  assert.match(s.text(), message);
  await s.advance(100000);
  assert.equal(s.requests.length, 1);
});

test('timeout aborts the fetch', async (t) => {
  const s = setup(t); s.open(); s.query();
  await s.advance(15000);
  assert.equal(s.requests[0].aborted, true);
  assert.match(s.text(), /超时/);
});

test('timeout also covers a stalled response body', async (t) => {
  const s = setup(t); s.open(); s.query();
  const signal = s.requests[0].init.signal;
  s.requests[0].respond({}, 200, { text: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new s.w.DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  await tick(); await s.advance(15000);
  assert.equal(signal.aborted, true);
  assert.match(s.text(), /超时/);
});

test('network failure preserves completed pages and retries failed page only after explicit click', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row()], 40));
  await tick(); await s.advance();
  s.requests[1].fail(); await tick();
  assert.match(s.text(), /网络请求失败/);
  assert.match(s.text(), /第 1–1 页/);
  assert.equal(s.root().querySelectorAll('article').length, 1);
  s.query(); await s.advance();
  assert.equal(s.requests[2].url, '/api/admin/ruling/page-2');
});

test('changing total warns about moving pages and deduplicates repeated matching IDs', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([row()], 40)); await tick(); await s.advance();
  s.requests[1].respond(page([row()], 41)); await tick();
  assert.equal(s.root().querySelectorAll('article').length, 1);
  assert.match(s.text(), /总数发生变化/);
});

test('empty results are scoped to completed pages and never presented as clean history', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page([], 0)); await tick();
  assert.match(s.text(), /已读取范围内未找到/);
  assert.match(s.text(), /不代表.*从未/);
  assert.match(s.text(), /不保证覆盖全部历史/);
});

test('matching results display in local batches without additional network calls', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(page(Array.from({ length: 20 }, (_, id) => row({ id: id + 1 })), 40));
  await tick(); await s.advance();
  s.requests[1].respond(page(Array.from({ length: 20 }, (_, id) => row({ id: id + 21 })), 40));
  await tick();
  assert.equal(s.root().querySelectorAll('article').length, 30);
  [...s.root().querySelectorAll('button')].find((b) => b.textContent.startsWith('显示更多')).click();
  assert.equal(s.root().querySelectorAll('article').length, 40);
  assert.equal(s.requests.length, 2);
});

test('late author and dynamically loaded floors get exactly one button', async (t) => {
  const s = setup(t, '<article><header></header><div class="comment-menu"></div></article>');
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 0);
  s.w.document.querySelector('header').innerHTML = '<a href="/space/123">12</a>';
  await new Promise((resolve) => setTimeout(resolve, 40));
  s.w.document.body.insertAdjacentHTML('beforeend', floor('带 空格 用户名', '999'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 2);
});

test('ignores external, quoted and nested authors; recycled floor uses updated UID', async (t) => {
  const s = setup(t, '<article><a href="https://evil.example/space/1">伪造</a><blockquote><a href="/space/2">引用</a></blockquote><div class="comment-menu"></div>' + floor('内层', '3') + '</article>');
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 1);
  const link = s.w.document.querySelector('header a');
  link.href = '/space/4'; link.textContent = '更新用户';
  s.open(); s.query();
  s.requests[0].respond(page([row({ target_member_id: 4 })])); await tick();
  assert.match(s.text(), /匹配 1 条/);
});
