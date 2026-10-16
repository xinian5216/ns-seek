'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync('ns-seek.user.js', 'utf8');
const floor = (name = '测试用户', uid = '123456', extra = '') => `<article><header><a href="/space/${uid}">${name}</a></header>${extra}<div class="comment-menu"></div></article>`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

function setup(t, html = floor()) {
  const dom = new JSDOM(html, { url: 'https://www.nodeseek.com/post-999999-1', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const requests = [];
  const timers = [];
  const nativeSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => {
    if (ms === 15000) timers.push(callback);
    return nativeSetTimeout(callback, ms, ...args);
  };
  w.GM_xmlhttpRequest = (details) => {
    const req = { details, aborted: false, respond(data, status = 200, extras = {}) {
      details.onload({ status, responseText: JSON.stringify(data), finalUrl: details.url, ...extras });
    } };
    requests.push(req);
    return { abort() { req.aborted = true; details.onabort(); } };
  };
  w.eval(source);
  const root = () => w.document.querySelector('#ns-seek-host')?.shadowRoot;
  const open = (index = 0) => w.document.querySelectorAll('[data-ns-seek-button]')[index].click();
  const query = () => root().querySelector('[data-action="query"]').click();
  return { w, requests, timers, root, open, query, text: () => root().textContent };
}

const found = (records, more = {}) => ({ ok: true, found: true, user: { total: records.length }, records, ...more });
const record = (overrides = {}) => ({ id: 1, category: 'punish', time: '2026-01-01T00:00:00Z', reason: '测试原因', actions: ['扣 1 鸡腿'], admin: '测试管理员', ...overrides });

test('no request before explicit consent; UID only; anonymous allowlisted request', (t) => {
  const s = setup(t);
  assert.equal(s.requests.length, 0);
  s.open();
  assert.equal(s.requests.length, 0);
  assert.match(s.text(), /访问 IP/);
  s.query();
  assert.equal(s.requests.length, 1);
  const r = s.requests[0].details;
  assert.equal(r.url, 'https://api.xxboxx.de/v1/user?q=uid%3A123456');
  assert.equal(r.method, 'GET');
  assert.equal(r.anonymous, true);
  assert.equal(r.redirect, 'error');
  assert.equal(r.headers.Referer, '');
  assert.deepEqual(Object.keys(r.headers).sort(), ['Accept', 'Referer']);
  assert.equal(s.w.localStorage.length, 0);
});

test('remote content and username render as plain text, never HTML', async (t) => {
  const s = setup(t, floor('&lt;img src=x onerror=alert(1)&gt;'));
  s.open(); s.query();
  const payload = '<img src=x onerror=alert(1)>';
  s.requests[0].respond(found([record({ id: payload, reason: payload, admin: payload, actions: [payload], time: payload })]));
  await tick();
  assert.match(s.text(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(s.root().querySelectorAll('img,script,iframe').length, 0);
});

test('only canonical forum post links survive; strip tracking parameters', async (t) => {
  const s = setup(t); s.open(); s.query();
  const urls = ['javascript:alert(1)', 'https://evil.example/post-1', 'https://www.nodeseek.com.evil.example/post-1',
    'https://www.nodeseek.com@evil.example/post-1', 'https://www.nodeseek.com/redirect?to=x',
    'https://u:p@www.nodeseek.com/post-1', 'https://www.nodeseek.com/post-123-1?tracking=x#fragment'];
  s.requests[0].respond(found(urls.map((post_url) => record({ post_url }))));
  await tick();
  const links = s.root().querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://www.nodeseek.com/post-123-1');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

test('new query cancels prior request and ignores stale response', async (t) => {
  const s = setup(t, floor('甲', '111') + floor('乙', '222'));
  s.open(0); s.query();
  s.open(1); s.query();
  assert.equal(s.requests[0].aborted, true);
  s.requests[1].respond(found([record({ reason: '乙的记录' })]));
  s.requests[0].respond(found([record({ reason: '甲的旧结果' })]));
  await tick();
  assert.match(s.text(), /乙的记录/);
  assert.doesNotMatch(s.text(), /甲的旧结果/);
});

test('closing clears displayed data, aborts network request and restores focus', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.root().querySelector('dialog').close();
  assert.equal(s.requests[0].aborted, true);
  s.requests[0].respond(found([record()]));
  await tick();
  assert.equal(s.root().querySelector('[aria-live]').textContent, '');
  assert.equal(s.w.document.activeElement.dataset.nsSeekButton, '1');
});

test('rate limit blocks subsequent requests and never auto-retries', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond({ ok: false, error: 'rate_limited', retry_after: 60 }, 429);
  await tick();
  assert.match(s.text(), /60 秒/);
  s.query();
  assert.equal(s.requests.length, 1);
  s.open(); s.query();
  assert.equal(s.requests.length, 1);
});

test('Retry-After header honored when response omits retry_after', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond({ ok: false }, 429, { responseHeaders: 'Retry-After: 120\r\n' });
  await tick();
  assert.match(s.text(), /120 秒/);
});

for (const [name, data, status, extras, message] of [
  ['invalid JSON', {}, 502, { responseText: '<html>Bad gateway</html>' }, /非 JSON/],
  ['schema drift', { ok: true, found: true, rows: [] }, 200, {}, /数据格式/],
  ['invalid row', found([null]), 200, {}, /数据格式/],
  ['HTTP error', { ok: true, found: false }, 503, {}, /HTTP 503/],
  ['redirect', { ok: true, found: false }, 200, { finalUrl: 'https://evil.example/' }, /未授权/],
  ['oversized response', {}, 200, { responseText: 'x'.repeat(4 * 1024 * 1024 + 1) }, /过大/],
]) test(`handles ${name}`, async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(data, status, extras);
  await tick();
  assert.match(s.text(), message);
});

test('explicit timeout aborts the request even if manager timeout is ignored', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.timers[0]();
  await tick();
  assert.equal(s.requests[0].aborted, true);
  assert.match(s.text(), /超时/);
});

test('network error is readable and can be retried manually', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].details.onerror();
  await tick();
  assert.match(s.text(), /网络请求失败/);
  s.query();
  assert.equal(s.requests.length, 2);
});

test('empty index never claims account has never been moderated', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond({ ok: true, found: false });
  await tick();
  assert.match(s.text(), /不代表.*从未/);
});

test('large results render in local batches; truncation warning is visible', async (t) => {
  const s = setup(t); s.open(); s.query();
  s.requests[0].respond(found(Array.from({ length: 65 }, (_, id) => record({ id })), { truncated: true }));
  await tick();
  assert.equal(s.root().querySelectorAll('article').length, 30);
  assert.match(s.text(), /非全部记录/);
  const more = [...s.root().querySelectorAll('button')].find((b) => b.textContent.startsWith('显示更多'));
  more.click(); assert.equal(s.root().querySelectorAll('article').length, 60);
  more.click(); assert.equal(s.root().querySelectorAll('article').length, 65);
  assert.equal(more.hidden, true);
  assert.equal(s.requests.length, 1);
});

test('late author and dynamically appended floors get exactly one button', async (t) => {
  const s = setup(t, '<article><header></header><div class="comment-menu"></div></article>');
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 0);
  s.w.document.querySelector('header').innerHTML = '<a href="/space/123">12</a>';
  await tick();
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 1);
  s.w.document.body.insertAdjacentHTML('beforeend', floor('带 空格 用户名', '999'));
  await tick(); await tick();
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 2);
});

test('ignores external, quoted and nested authors; supports recycled floor nodes', async (t) => {
  const s = setup(t, '<article><a href="https://evil.example/space/1">伪造</a><blockquote><a href="/space/2">引用</a></blockquote><div class="comment-menu"></div>' + floor('内层', '3') + '</article>');
  assert.equal(s.w.document.querySelectorAll('[data-ns-seek-button]').length, 1);
  const link = s.w.document.querySelector('header a');
  link.href = '/space/4'; link.textContent = '更新用户';
  s.open(); s.query();
  assert.match(s.requests[0].details.url, /uid%3A4$/);
});
