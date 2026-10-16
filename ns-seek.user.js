// ==UserScript==
// @name         NS 管理记录快捷查看 · 独立维护版
// @namespace    https://github.com/xinian5216/ns-seek
// @version      1.1.0
// @description  使用论坛当前登录状态读取站内管理记录，在本地按 UID 筛选，无第三方查询服务。
// @match        https://www.nodeseek.com/post-*
// @license      MIT
// @homepageURL  https://github.com/xinian5216/ns-seek
// @supportURL   https://github.com/xinian5216/ns-seek/issues
// @updateURL    https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.meta.js
// @downloadURL  https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.user.js
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Based on NS 管理记录快捷查看 0.5.0 (MIT): https://api.xxboxx.de/ns-seek.user.js
// Modifications Copyright (c) 2026 xinian5216. See LICENSE and THIRD_PARTY.md.
(function () {
  'use strict';

  if (location.origin !== 'https://www.nodeseek.com') return;
  const FLOOR = '.post-list-content, .post, .post-item, article, .topic-content';
  const TIMEOUT = 15000;
  const PAGE_SIZE = 20;
  const MAX_PAGES = 100;
  const BATCH_PAGES = 5;
  const PAGE_DELAY = 1200;
  let modal;
  let current;
  let active;
  let generation = 0;
  let cooldownUntil = 0;
  let nextRequestAt = 0;
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
    if (active) {
      nextRequestAt = Date.now() + PAGE_DELAY;
      active.abort();
    }
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
    const source = el('p', '来源：NodeSeek 站内管理记录，使用你当前的论坛登录状态。仅检查已读取的页，不保证覆盖全部历史。', 'notice');
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
    current = { ...user, trigger, rows: [], seen: new Set(), nextPage: 1, pages: 0,
      total: null, lastPage: MAX_PAGES, ended: false, changed: false, skipped: 0,
      visible: 30, busy: false, status: '' };
    ui.title.textContent = `${user.name} 的管理记录`;
    const note = el('p', `将读取论坛管理记录并在本地筛选 UID ${user.uid}，不会向第三方查询。浏览器自动携带论坛登录状态，无需填写 Cookie。每轮最多读取 5 页，页间至少等待 1.2 秒；更早记录需手动继续，最多 100 页。`);
    const query = button('查询最近 5 页', () => runQuery());
    query.dataset.action = 'query';
    ui.content.replaceChildren(note, query);
    if (!ui.dialog.open) ui.dialog.showModal();
    query.focus();
  }

  function wait(signal, delay) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('请求已取消。')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function request(page, signal) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) throw new Error('页码超出查询范围。');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT);
    try {
      nextRequestAt = Date.now() + PAGE_DELAY;
      const response = await fetch(`/api/admin/ruling/page-${page}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== location.origin)) {
        throw new Error('论坛请求发生跳转，已拒绝结果，请先确认登录状态。');
      }
      if (response.status === 429) {
        const value = response.headers.get('Retry-After');
        const seconds = /^\d+$/.test(value || '') ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
        const delay = Math.max(1, Math.min(86400, Number.isFinite(seconds) ? Math.ceil(seconds) : 60));
        cooldownUntil = Date.now() + delay * 1000;
        throw new Error(`论坛限速，请约 ${delay} 秒后手动继续。`);
      }
      if ([401, 403, 500].includes(response.status)) {
        throw new Error(`论坛返回 HTTP ${response.status}，可能未登录、需要浏览器验证或服务异常。请先打开论坛管理记录页确认，再手动继续。`);
      }
      if (!response.ok) throw new Error(`论坛请求失败（HTTP ${response.status}），请稍后手动继续。`);
      if (Number(response.headers.get('Content-Length')) > 1024 * 1024) throw new Error('接口返回过大，已停止处理。');
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('接口返回过大，已停止处理。');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('论坛返回非 JSON 页面，请先确认登录状态或完成浏览器验证。'); }
      if (data?.success === false) throw new Error('论坛未允许此次读取，请确认登录状态或稍后手动继续。');
      if (data?.success !== true || !Array.isArray(data.data) || data.data.length > PAGE_SIZE ||
          data.data.some((r) => !r || typeof r !== 'object' || Array.isArray(r)) ||
          !Number.isSafeInteger(data.total) || data.total < 0) {
        throw new Error('论坛接口数据格式已变化，请检查脚本更新。');
      }
      return data;
    } catch (error) {
      if (timedOut) throw new Error('请求超时，请稍后手动继续。');
      if (signal.aborted) throw new Error('请求已取消。');
      if (error instanceof TypeError) throw new Error('网络请求失败或跳转被拒绝，请检查连接与论坛登录状态。');
      throw error;
    } finally {
      nextRequestAt = Date.now() + PAGE_DELAY;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function numericId(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const normalized = String(value).replace(/^0+/, '');
    return /^[1-9]\d*$/.test(normalized) ? normalized : null;
  }

  function normalizeRow(row) {
    let detail;
    try { detail = typeof row.request === 'string' ? JSON.parse(row.request) : row.request; } catch { /* Preserve the record even if details cannot be parsed. */ }
    const actions = [];
    let score = 0;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      actions.push('操作明细无法解析，请查看论坛原记录');
      detail = {};
    }
    for (const [key, field, unit] of [['coin', 'coin_diff', '鸡腿'], ['stardust', 'stardust_diff', '星辰']]) {
      const value = detail[key]?.[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        actions.push(`${unit} ${value > 0 ? '+' : ''}${value}`);
        if (value < 0) score = -1;
        else if (value > 0 && score === 0) score = 1;
      }
    }
    const summary = detail.postSummary;
    if (summary && typeof summary === 'object') {
      if (typeof summary.title === 'string') actions.push(`标题设为 ${summary.title}`);
      if (typeof summary.category === 'string') actions.push(`移动版块：${summary.category}`);
      if (typeof summary.rank === 'number') actions.push(`阅读权限设为 ${summary.rank}`);
      if (typeof summary.locked === 'boolean') actions.push(summary.locked ? '锁定帖子' : '解锁帖子');
      if (typeof summary.award === 'boolean') actions.push(summary.award ? '推荐阅读' : '撤销推荐阅读');
    }
    if (typeof detail.hideComment?.status === 'boolean') actions.push(detail.hideComment.status ? '隐藏内容' : '恢复内容');
    if (typeof detail.pinComment?.status === 'boolean') actions.push(detail.pinComment.status ? '置顶' : '取消置顶');
    if (detail.suspend && typeof detail.suspend === 'object') {
      if (detail.suspend.status === false) actions.push('解除禁言');
      else {
        const days = detail.suspend.value;
        const valid = (typeof days === 'number' && Number.isFinite(days) && days >= 0) ||
          (typeof days === 'string' && /^\d+$/.test(days));
        actions.push(valid ? `禁言：${days} 天` : '禁言：天数未提供');
        score = -1;
      }
    }
    const postId = numericId(row.post_id);
    const id = numericId(row.id);
    return {
      id: id || '-', category: score < 0 ? 'punish' : score > 0 ? 'reward' : 'manage',
      reason: typeof detail.coin?.reason === 'string' ? detail.coin.reason : '-',
      actions: actions.length ? actions : ['操作类型未识别，请查看论坛原记录'],
      time: typeof row.created_at === 'string' ? row.created_at : typeof row.createdAt === 'string' ? row.createdAt : '',
      admin: typeof row.admin_member_name === 'string' ? row.admin_member_name : '',
      post_url: postId ? `https://www.nodeseek.com/post-${postId}-1` : null,
      ruling_url: id ? `https://www.nodeseek.com/ruling#/id-${id}` : null,
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
    if (row.ruling_url) {
      const a = el('a', ' 查看论坛原记录');
      a.href = row.ruling_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.referrerPolicy = 'no-referrer';
      article.append(a);
    }
    return article;
  }

  function render() {
    const state = current;
    if (!state) return;
    const content = modal.content;
    content.replaceChildren();
    content.append(el('p', `已检查最新记录的第 1–${state.pages} 页，匹配 ${state.rows.length} 条。未读取的页和更早历史不在结果内。`));
    if (state.pages === 0) content.firstChild.textContent = '尚未完成任何页的读取。';
    if (state.status) content.append(el('p', state.status, 'notice'));
    if (state.pages > 0 && state.rows.length === 0) content.append(el('p', '已读取范围内未找到该账号的记录，不代表该账号从未受到管理处理。'));
    if (state.changed) content.append(el('p', '读取期间记录总数发生变化，分页可能移动；去重不能保证没有遗漏，可稍后重新查询。', 'notice'));
    if (state.skipped) content.append(el('p', `${state.skipped} 条记录缺少有效 UID，无法判断归属，结果可能不完整。`, 'notice'));
    if (state.total > MAX_PAGES * PAGE_SIZE) content.append(el('p', '记录总量超出论坛的 100 页读取上限，较早记录无法通过此方式检查。', 'notice'));
    const list = el('div');
    list.append(...state.rows.slice(0, state.visible).map(recordNode));
    content.append(list);
    if (state.visible < state.rows.length) {
      content.append(button(`显示更多已匹配记录（剩余 ${state.rows.length - state.visible} 条）`, () => {
        state.visible += 30;
        render();
      }));
    }
    if (state.busy) {
      const stop = button('停止本轮', () => {
        cancel();
        state.busy = false;
        state.status = '已停止，保留本轮已完成的页；可手动继续。';
        render();
      });
      stop.dataset.action = 'stop';
      content.append(stop);
    } else if (!state.ended) {
      const next = button(state.pages ? `从第 ${state.nextPage} 页继续（最多 5 页）` : '重新读取最近 5 页', () => runQuery());
      next.dataset.action = 'query';
      content.append(next);
    }
  }

  async function runQuery() {
    if (!current) return;
    cancel();
    const ticket = generation;
    const state = current;
    if (state.ended) return;
    if (Date.now() < cooldownUntil) {
      state.status = `论坛限速中，请 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后手动继续。`;
      render();
      return;
    }
    const controller = new AbortController();
    active = controller;
    state.busy = true;
    try {
      for (let count = 0; count < BATCH_PAGES && !state.ended; count += 1) {
        state.status = `正在读取第 ${state.nextPage} 页…可停止本轮或关闭窗口。`;
        render();
        const delay = nextRequestAt - Date.now();
        if (delay > 0) await wait(controller.signal, delay);
        if (ticket !== generation || controller.signal.aborted) return;
        const data = await request(state.nextPage, controller.signal);
        if (ticket !== generation || current !== state || !modal.dialog.open) return;
        if (state.total !== null && state.total !== data.total) state.changed = true;
        state.total = data.total;
        state.lastPage = Math.min(MAX_PAGES, Math.max(1, Math.ceil(data.total / PAGE_SIZE)));
        for (const row of data.data) {
          const uid = numericId(row.target_member_id);
          if (!uid) { state.skipped += 1; continue; }
          if (uid !== numericId(state.uid)) continue;
          const id = numericId(row.id);
          if (id && state.seen.has(id)) continue;
          if (id) state.seen.add(id);
          state.rows.push(normalizeRow(row));
        }
        state.pages += 1;
        state.nextPage += 1;
        state.ended = data.data.length === 0 || state.nextPage > state.lastPage;
        render();
      }
      state.status = state.ended ? '已到当前接口可读取的范围末尾；不保证覆盖全部历史。' : '本轮已完成，继续检查更早记录需手动点击。';
    } catch (error) {
      if (ticket === generation && current === state) state.status = error.message;
    } finally {
      if (ticket === generation && current === state) {
        active = null;
        state.busy = false;
        render();
      }
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
