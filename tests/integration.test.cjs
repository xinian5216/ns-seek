'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { openStore } = require('../backend/store.cjs');
const { createApp } = require('../backend/server.cjs');

test('browser collector -> real loopback HTTP -> SQLite -> user lookup completes without forum credentials leaving browser', async (t) => {
  const store = openStore(':memory:', { now: () => Date.parse('2026-10-16T12:00:00Z') });
  const keys = { queryToken: crypto.randomBytes(32).toString('base64url'), syncToken: crypto.randomBytes(32).toString('base64url') };
  const app = createApp({ store, ...keys });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const dom = new JSDOM('<article><header><a href="/space/123">合成用户</a></header><div class="comment-menu"></div></article>',
    { url: 'https://www.nodeseek.com/post-123-1', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await new Promise((resolve) => app.server.close(resolve)); store.close(); });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const menus = new Map();
  w.GM_getValue = () => keys;
  w.GM_setValue = () => {};
  w.GM_deleteValue = () => {};
  w.GM_registerMenuCommand = (name, callback) => menus.set(name, callback);
  const uploads = [];
  w.GM_xmlhttpRequest = (details) => {
    assert.equal(new URL(details.url).origin, 'https://ns.042804.xyz:8443');
    assert.equal(details.anonymous, true);
    assert.equal(details.headers.Cookie, undefined);
    const controller = new AbortController();
    if (details.data && new URL(details.url).pathname === '/v1/ingest') uploads.push(JSON.parse(details.data));
    fetch(origin + new URL(details.url).pathname + new URL(details.url).search, {
      method: details.method, headers: details.headers, body: details.data, signal: controller.signal,
    }).then(async (response) => details.onload({ status: response.status, finalUrl: details.url, responseText: await response.text() }))
      .catch(() => details.onerror());
    return { abort: () => controller.abort() };
  };
  let forumCalls = 0;
  w.fetch = async (url, init) => {
    forumCalls += 1;
    assert.equal(url, '/api/admin/ruling/page-1');
    assert.equal(init.credentials, 'same-origin');
    return { ok: true, status: 200, url: 'https://www.nodeseek.com' + url, redirected: false, headers: new Headers(),
      text: async () => JSON.stringify({ success: true, total: 1, data: [{ id: 1, target_member_id: 123,
        target_member_name: '合成旧名', admin_member_name: '合成管理员', created_at: '2026-10-16T00:00:00Z', post_id: 123,
        request: '{"suspend":{"status":true,"value":7},"coin":{"coin_diff":-1,"reason":"集成测试合成原因"}}', extra_private_field: 'must not be archived' }] }) };
  };
  w.eval(fs.readFileSync('ns-seek.user.js', 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.fail('Integration step did not complete');
  };
  menus.get('私人档案同步')();
  const root = w.document.querySelector('#ns-seek-host').shadowRoot;
  await waitFor(() => root.textContent.includes('Cookie 留在浏览器内'));
  root.querySelector('[data-action="recent"]').click();
  await waitFor(() => root.textContent.includes('同步已完成'));
  assert.equal(store.status().count, 1);
  assert.equal(uploads[0].records[0].extra_private_field, undefined);
  w.document.querySelector('[data-ns-seek-button]').click();
  await waitFor(() => root.textContent.includes('查询完成'));
  assert.match(root.textContent, /集成测试合成原因/);
  assert.equal(root.querySelectorAll('article').length, 1);
  assert.equal(forumCalls, 1, 'query must read local DB rather than reread forum');
});
