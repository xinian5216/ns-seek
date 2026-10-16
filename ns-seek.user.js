// ==UserScript==
// @name         NS 管理记录快捷查看 · 独立维护版
// @namespace    https://github.com/xinian5216/ns-seek
// @version      1.0.0
// @description  在 NodeSeek 楼层内按需查询公开管理记录，查询前提示第三方数据传输。
// @match        https://www.nodeseek.com/post-*
// @license      MIT
// @homepageURL  https://github.com/xinian5216/ns-seek
// @supportURL   https://github.com/xinian5216/ns-seek/issues
// @updateURL    https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.meta.js
// @downloadURL  https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.user.js
// @grant        GM_xmlhttpRequest
// @connect      api.xxboxx.de
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Based on NS 管理记录快捷查看 0.5.0 (MIT): https://api.xxboxx.de/ns-seek.user.js
// Modifications Copyright (c) 2026 xinian5216. See LICENSE and THIRD_PARTY.md.
(function () {
  'use strict';

  const API = 'https://api.xxboxx.de';
  const FLOOR = '.post-list-content, .post, .post-item, article, .topic-content';
  const TIMEOUT = 15000;
  const MAX_ROWS = 5000;
  let modal;
  let current;
  let active;
  let generation = 0;
  let cooldownUntil = 0;
  let scheduled = false;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function button(text, callback) {
    const node = el('button', text);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
  }

  function cancel() {
    generation += 1;
    if (active) active.abort();
    active = null;
  }

  function createModal() {
    if (modal) return modal;
    const host = el('div');
    host.id = 'ns-seek-host';
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style', `
      :host { color-scheme: light dark; }
      dialog { width:min(760px,calc(100vw - 40px)); box-sizing:border-box;
        max-height:85dvh; padding:18px; border:1px solid #8886; border-radius:12px;
        background:light-dark(#fff,#202124); color:light-dark(#202124,#eee);
        font:14px/1.7 system-ui,sans-serif; overflow:auto; }
      dialog::backdrop { background:#0007; }
      header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      h2 { margin:0; font-size:18px; overflow-wrap:anywhere; }
      p,article { overflow-wrap:anywhere; }
      button { font:inherit; padding:4px 12px; border:1px solid #8888; border-radius:6px;
        cursor:pointer; background:light-dark(#f4f5f6,#303134); color:inherit; }
      button:focus-visible,a:focus-visible { outline:3px solid #4285f4; outline-offset:2px; }
      button:disabled { opacity:.6; cursor:wait; }
      article { border-top:1px solid #8885; padding:12px 0; }
      a { color:light-dark(#0969da,#8ab4f8); }
      .notice { background:light-dark(#f6f8fa,#292a2d); padding:10px; border-radius:6px; }
    `);
    const dialog = el('dialog');
    dialog.setAttribute('aria-labelledby', 'title');
    const title = el('h2', '管理记录');
    title.id = 'title';
    const close = button('关闭', () => dialog.close());
    const header = el('header');
    header.append(title, close);
    const content = el('div');
    content.setAttribute('aria-live', 'polite');
    const source = el('p', '来源：api.xxboxx.de 的第三方公开记录索引。收录可能延迟或不完整，以论坛原记录为准。', 'notice');
    dialog.append(header, source, content);
    root.append(style, dialog);
    document.body.append(host);
    dialog.addEventListener('close', () => {
      cancel();
      content.replaceChildren();
      if (current?.trigger.isConnected) current.trigger.focus();
      current = null;
    });
    dialog.addEventListener('cancel', () => cancel());
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    modal = { dialog, title, content };
    return modal;
  }

  function showPrompt(user, trigger) {
    cancel();
    const ui = createModal();
    current = { ...user, trigger };
    ui.title.textContent = `${user.name} 的管理记录`;
    const note = el('p', `继续将向 ${API} 发送此账号的 UID（${user.uid}）。服务方可获知你的访问 IP 和查询目标。本脚本不读取论坛 Cookie，不保存查询历史。`);
    const query = button('同意并查询', () => runQuery());
    query.dataset.action = 'query';
    ui.content.replaceChildren(note, query);
    if (!ui.dialog.open) ui.dialog.showModal();
    query.focus();
  }

  function request(uid) {
    let handle;
    let timer;
    let rejectRequest;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      // An explicit timer also covers managers where anonymous/fetch mode ignores timeout.
      timer = setTimeout(() => {
        finish(new Error('请求超时，请稍后手动重试。'));
        handle?.abort();
      }, TIMEOUT);
      try {
        handle = GM_xmlhttpRequest({
          method: 'GET',
          url: `${API}/v1/user?q=${encodeURIComponent(`uid:${uid}`)}`,
          anonymous: true,
          redirect: 'error',
          headers: { Accept: 'application/json', Referer: '' },
          onload: (response) => {
            if (response.finalUrl && new URL(response.finalUrl).origin !== API) {
              finish(new Error('接口跳转到未授权地址，已拒绝结果。'));
              return;
            }
            if (response.responseText.length > 4 * 1024 * 1024) {
              finish(new Error('接口返回过大，已停止处理。'));
              return;
            }
            let data;
            try { data = JSON.parse(response.responseText); } catch {
              finish(new Error(`接口返回非 JSON 数据（HTTP ${response.status}）。`));
              return;
            }
            if (response.status === 429 || data?.error === 'rate_limited') {
              const header = (response.responseHeaders || '').match(/^retry-after:\s*(\d+)\s*$/im);
              const seconds = Math.max(1, Math.min(86400, Number(data?.retry_after || header?.[1]) || 60));
              cooldownUntil = Date.now() + seconds * 1000;
              finish(new Error(`查询过快，请约 ${seconds} 秒后手动重试。`));
              return;
            }
            if (response.status < 200 || response.status >= 300 || data?.ok !== true) {
              finish(new Error(`查询失败（HTTP ${response.status}），请稍后重试。`));
              return;
            }
            if (typeof data.found !== 'boolean' ||
                (data.found && (!Array.isArray(data.records) || data.records.some((r) => !r || typeof r !== 'object' || Array.isArray(r))))) {
              finish(new Error('接口数据格式已变化，请检查脚本更新。'));
              return;
            }
            finish(null, data);
          },
          onerror: () => finish(new Error('网络请求失败，请检查连接和脚本的跨域权限。')),
          ontimeout: () => finish(new Error('请求超时，请稍后手动重试。')),
          onabort: () => finish(new Error('请求已取消。')),
        });
      } catch {
        finish(new Error('无法发起请求，请使用支持 GM_xmlhttpRequest 的油猴管理器。'));
      }
    });
    return {
      promise,
      abort: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectRequest(new Error('请求已取消。'));
        handle?.abort();
      },
    };
  }

  function safePost(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://www.nodeseek.com' || url.username || url.password ||
          !/^\/post-\d+(?:-\d+)?\/?$/.test(url.pathname)) return null;
      // Remove any server-supplied query string or fragment.
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  }

  function recordNode(row) {
    const article = el('article');
    const category = { punish: '⚠️ 处罚', reward: '🎉 奖励', manage: '📝 管理' }[row.category] || '📝 管理';
    article.append(el('strong', `${category} · #${String(row.id ?? '-')}`));
    if (row.time) article.append(el('div', `时间：${row.time}`));
    article.append(el('div', `原因：${row.reason || '-'}`));
    const actions = Array.isArray(row.actions) ? row.actions.map(String).join('；') : '-';
    article.append(el('div', `处理：${actions || '-'}`));
    if (row.admin) article.append(el('div', `管理员：${row.admin}`));
    const href = safePost(row.post_url);
    if (href) {
      const a = el('a', '查看论坛原帖');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.referrerPolicy = 'no-referrer';
      article.append(a);
    }
    return article;
  }

  function render(data) {
    const content = modal.content;
    content.replaceChildren();
    if (!data.found) {
      content.append(el('p', '此索引未找到该账号的管理记录；这不代表该账号从未受到管理处理。'));
      return;
    }
    const rows = data.records.slice(0, MAX_ROWS);
    const total = Number(data.user?.total);
    const incomplete = data.truncated || data.records.length > MAX_ROWS || (Number.isFinite(total) && total > rows.length);
    content.append(el('p', `接口返回 ${data.records.length} 条记录${incomplete ? '（结果可能被截断，非全部记录）' : ''}。每次显示 30 条。`));
    if (data.freshness?.latest_record) content.append(el('p', `索引最新记录时间：${data.freshness.latest_record}`));
    const list = el('div');
    let shown = 0;
    const more = button('显示更多', () => append());
    function append() {
      const next = rows.slice(shown, shown + 30);
      list.append(...next.map(recordNode));
      shown += next.length;
      more.hidden = shown >= rows.length;
      more.textContent = `显示更多（剩余 ${rows.length - shown} 条）`;
    }
    content.append(list, more);
    append();
  }

  async function runQuery() {
    if (!current) return;
    cancel();
    const ticket = generation;
    const user = current;
    const retry = () => {
      const b = button('重试查询', () => runQuery());
      b.dataset.action = 'query';
      return b;
    };
    if (Date.now() < cooldownUntil) {
      modal.content.replaceChildren(el('p', `查询限速中，请 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后重试。`), retry());
      return;
    }
    modal.content.replaceChildren(el('p', '加载中…关闭窗口可取消请求。'));
    active = request(user.uid);
    try {
      const data = await active.promise;
      if (ticket === generation && modal.dialog.open) render(data);
    } catch (error) {
      if (ticket === generation && modal.dialog.open) modal.content.replaceChildren(el('p', error.message), retry());
    } finally {
      if (ticket === generation) active = null;
    }
  }

  function findUser(menu) {
    const floor = menu.closest(FLOOR) || menu.parentElement;
    if (!floor) return null;
    for (const link of floor.querySelectorAll('a[href*="/space/"]')) {
      // Never borrow an author from a nested floor, quote, or comment body.
      if (link.closest('blockquote, .quote, .comment-content, .post-content')) continue;
      if (floor.matches(FLOOR) && link.closest(FLOOR) !== floor) continue;
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        const match = url.pathname.match(/^\/space\/(\d+)\/?$/);
        const name = link.textContent.trim();
        if (url.origin === location.origin && match && name && name.length <= 100) return { name, uid: match[1] };
      } catch { /* Ignore malformed links. */ }
    }
    return null;
  }

  function injectButtons() {
    for (const menu of document.querySelectorAll('.comment-menu')) {
      if (menu.querySelector('[data-ns-seek-button]')) continue;
      const user = findUser(menu);
      if (!user) continue; // Retry when asynchronously loaded author markup arrives.
      const b = button('⚖️ 管理记录', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const latest = findUser(menu); // Supports reused floor nodes after navigation.
        if (latest) showPrompt(latest, b);
      });
      b.dataset.nsSeekButton = '1';
      b.style.cssText = 'margin-left:6px;padding:1px 6px;font:inherit;font-size:12px;cursor:pointer;border:1px solid #8888;border-radius:8px;background:transparent;color:inherit';
      menu.append(b);
    }
  }

  injectButtons();
  new MutationObserver((mutations) => {
    if (scheduled || !mutations.some((mutation) => mutation.addedNodes.length)) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      injectButtons();
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
