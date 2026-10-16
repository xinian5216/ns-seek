// ==UserScript==
// @name         NS 管理记录快捷查看 · 独立维护版
// @namespace    https://github.com/xinian5216/ns-seek
// @version      1.2.1
// @description  登录浏览器同步记录到私人 SQLite，点击用户直接查私人档案，无第三方查询服务。
// @match        https://www.nodeseek.com/post-*
// @match        https://www.nodeseek.com/ruling*
// @license      MIT
// @homepageURL  https://github.com/xinian5216/ns-seek
// @supportURL   https://github.com/xinian5216/ns-seek/issues
// @updateURL    https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.meta.js
// @downloadURL  https://raw.githubusercontent.com/xinian5216/ns-seek/main/ns-seek.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      ns.042804.xyz
// @run-at       document-start
// @noframes
// ==/UserScript==

// Based on NS 管理记录快捷查看 0.5.0 (MIT): https://api.xxboxx.de/ns-seek.user.js
// Modifications Copyright (c) 2026 xinian5216. See LICENSE and THIRD_PARTY.md.
(function () {
  'use strict';

  if (location.origin !== 'https://www.nodeseek.com') return;
  // Capture before the forum replaces its hash with the pagination route.
  const initialPairCode = new URLSearchParams(location.hash.slice(1)).get('ns-seek-pair');
  if (initialPairCode) history.replaceState(null, '', `${location.pathname}${location.search}`);
  let booted = false;
  function boot() {
  if (booted) return;
  booted = true;
  const FLOOR = '.post-list-content, .post, .post-item, article, .topic-content';
  const TIMEOUT = 15000;
  const PAGE_SIZE = 20;
  const MAX_PAGES = 100;
  const PAGE_DELAY = 1200;
  const LOCAL = 'https://ns.042804.xyz:8443';
  const STORAGE_KEY = 'local-credentials-v1';
  let modal;
  let current;
  let active;
  let generation = 0;
  let cooldownUntil = 0;
  let nextRequestAt = 0;
  let scheduled = false;
  let stopReporter = null;
  let reportQueue = Promise.resolve();

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
    if (stopReporter) { stopReporter('stopped'); stopReporter = null; }
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
    const source = el('p', '来源：你的私人封禁档案（最近 365 天）。先同步后查询，档案不保证覆盖完整历史；同步时需保持本标签页打开。', 'notice');
    dialog.append(header, source, content);
    root.append(style, dialog);
    document.body.append(host);
    dialog.addEventListener('close', () => {
      cancel();
      content.replaceChildren();
      if (current?.trigger?.isConnected) current.trigger.focus();
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
    current = { mode: 'user', ...user, trigger, rows: [], seen: new Set(), nextBeforeId: null,
      total: 0, archive: null, visible: 30, busy: false, status: '' };
    ui.title.textContent = `${user.name} 的管理记录`;
    if (!ui.dialog.open) ui.dialog.showModal();
    if (!credentials()) {
      ui.content.replaceChildren(el('p', '尚未连接私人档案。请先登录私人面板，在私人面板点击「连接油猴」。'), button('打开私人面板', () => openLocal()));
    } else runQuery();
  }

  function credentials() {
    const value = GM_getValue(STORAGE_KEY, null);
    return value && ['queryToken', 'syncToken'].every((key) => /^[A-Za-z0-9_-]{43}$/.test(value[key])) ? value : null;
  }

  function openLocal() { location.assign(`${LOCAL}/`); }

  function validArchive(value) {
    if (!value || !['count', 'nextId', 'latestId'].every((k) => Number.isSafeInteger(value[k]) && value[k] >= 0) ||
        (value.lastSync !== null && typeof value.lastSync !== 'string')) throw new Error('私人档案状态格式不匹配。');
    return value;
  }

  function backendRequest(route, method = 'GET', data, signal) {
    if (!/^(?:\/pair\/claim|\/v1\/(?:status|sync-plan|ingest|progress)|\/v1\/user\?uid=\d+(?:&before=\d+)?)$/.test(route)) return Promise.reject(new Error('私人请求路径被拒绝。'));
    const keys = credentials();
    if (route !== '/pair/claim' && !keys) return Promise.reject(new Error('尚未连接私人服务，请通过私人面板连接油猴。'));
    const token = /\/v1\/(?:ingest|sync-plan)$/.test(route) ? keys?.syncToken : keys?.queryToken;
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { finish(new Error('操作已取消。')); handle?.abort(); };
      const timer = setTimeout(() => { finish(new Error('私人服务响应超时，请确认服务已启动。')); handle?.abort(); }, TIMEOUT);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        handle = GM_xmlhttpRequest({ method, url: `${LOCAL}${route}`, anonymous: true, redirect: 'error',
          headers: { Accept: 'application/json', Referer: '', ...(token && route !== '/pair/claim' ? { Authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json' } : {}) }, data: data ? JSON.stringify(data) : undefined,
          onload: (response) => {
            try {
              if (response.finalUrl && new URL(response.finalUrl).origin !== LOCAL) throw new Error('私人服务发生跳转，已拒绝结果。');
              if (response.status === 401) throw new Error('私人连接已过期，请在私人面板重新连接油猴。');
              if (response.status === 429) throw new Error('私人服务请求过快，请稍后手动重试。');
              if (response.status !== 200 || typeof response.responseText !== 'string' || response.responseText.length > 2 * 1024 * 1024) throw new Error('私人服务返回异常，请检查版本和服务状态。');
              const result = JSON.parse(response.responseText);
              if (result?.ok !== true) throw new Error('私人服务未完成操作。');
              finish(null, result);
            } catch (error) { finish(error instanceof SyntaxError ? new Error('私人服务数据格式错误。') : error); }
          }, onerror: () => finish(new Error('无法连接私人服务，请先启动 NS Seek 私人服务并允许油猴访问 ns.042804.xyz。')),
          onabort: () => finish(new Error('操作已取消。')),
        });
      } catch { finish(new Error('无法发起私人请求，请检查油猴权限。')); }
    });
  }

  function wait(signal, delay) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('请求已取消。')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function forumRequest(kind, value, signal) {
    if (!['page', 'id'].includes(kind) || !Number.isSafeInteger(value) || value < 1 || (kind === 'page' && value > MAX_PAGES)) throw new Error('读取范围被拒绝。');
    if (Date.now() < cooldownUntil) throw new Error(`论坛限速中，请 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后手动继续。`);
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await wait(signal, delay);
    if (signal.aborted) throw new Error('操作已取消。');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT);
    try {
      nextRequestAt = Date.now() + PAGE_DELAY;
      const response = await fetch(`/api/admin/ruling/${kind}-${value}`, {
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
      if (data?.success !== true || !Array.isArray(data.data) || data.data.length > (kind === 'page' ? PAGE_SIZE : 1) ||
          data.data.some((r) => !r || typeof r !== 'object' || Array.isArray(r)) ||
          (kind === 'page' && (!Number.isSafeInteger(data.total) || data.total < 0)) ||
          (kind === 'id' && data.data.some((r) => Number(r.id) !== value))) {
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
      reason: typeof detail.suspend?.reason === 'string' ? detail.suspend.reason : typeof detail.coin?.reason === 'string' ? detail.coin.reason : '-',
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
    if (state.archive) {
      content.append(el('p', `私人已存档 ${state.archive.count} 条记录。最近同步：${state.archive.lastSync || '尚未同步'}。`));
      content.append(el('p', `历史补采进度：下一个待检查编号 ${state.archive.nextId}，当前已知最新编号 ${state.archive.latestId}。档案不保证完整。`));
    }
    if (state.status) content.append(el('p', state.status, 'notice'));
    if (state.mode === 'sync' && !credentials()) {
      content.append(el('p', '尚未配对，暂时不能同步。请在私人面板点击「连接油猴」。如果自动连接失败，复制面板的一次性连接码并粘贴到下面。'));
      content.append(button('打开私人面板', () => openLocal()));
      const code = el('input'); code.type = 'password'; code.autocomplete = 'off'; code.maxLength = 100;
      code.placeholder = '粘贴一次性连接码（不是访问密码）'; code.setAttribute('aria-label', '一次性连接码');
      code.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:10px 0;padding:8px';
      const connect = button('使用连接码配对', () => { const value = code.value.trim(); code.value = ''; connectWithCode(value); });
      connect.dataset.action = 'pair'; content.append(code, connect); return;
    }
    if (state.mode === 'user') {
      if (state.archive) content.append(el('p', state.total ? `此 UID 已归档 ${state.total} 条，当前载入 ${state.rows.length} 条。` : '私人档案未找到该账号的记录，不代表该账号从未受到管理处理。'));
      const list = el('div');
      list.append(...state.rows.slice(0, state.visible).map(recordNode));
      content.append(list);
      if (state.visible < state.rows.length) content.append(button('显示更多已载入记录', () => { state.visible += 30; render(); }));
    }
    if (state.busy) {
      const stop = button('停止', () => {
        cancel();
        state.busy = false;
        state.status = '已停止，已写入私人的记录和补采进度会保留，可手动继续。';
        render();
      });
      stop.dataset.action = 'stop';
      content.append(stop);
    } else if (state.mode === 'sync') {
      for (const [mode, label] of [['all', '同步档案（最近记录＋历史续传）'], ['recent', '仅同步最近记录'], ['history', '继续补采历史']]) {
        const b = button(label, () => runSync(mode));
        b.dataset.action = mode; content.append(b);
      }
      content.append(el('p', '首次历史补采可能持续数小时。可随时停止；关闭或离开此标签页会停止。论坛验证、限速或异常会立即停止，不自动重试。'));
    } else {
      const next = button(state.nextBeforeId ? '读取下一批档案' : '重新查询私人档案', () => runQuery());
      next.dataset.action = 'query'; content.append(next);
      content.append(button('同步档案', () => showSync()));
    }
  }

  async function runQuery() {
    if (!current || current.mode !== 'user') return;
    cancel();
    const ticket = generation;
    const state = current;
    const controller = new AbortController();
    active = controller;
    state.busy = true;
    state.status = '正在查询私人档案…'; render();
    try {
      const before = state.nextBeforeId;
      const data = await backendRequest(`/v1/user?uid=${numericId(state.uid)}${before ? `&before=${before}` : ''}`, 'GET', undefined, controller.signal);
      if (ticket !== generation || current !== state) return;
      if (!Array.isArray(data.records) || data.records.length > 100 || !data.archive ||
          data.records.some((r) => !r || numericId(r.target_member_id) !== numericId(state.uid))) throw new Error('私人查询数据格式不匹配。');
      if (!before) { state.rows = []; state.seen.clear(); }
      for (const row of data.records) {
        const id = numericId(row.id);
        if (!id || state.seen.has(id)) continue;
        state.seen.add(id); state.rows.push(normalizeRow(row));
      }
      state.nextBeforeId = numericId(data.nextBeforeId);
      state.total = data.total;
      state.archive = validArchive(data.archive);
      state.status = '查询完成。结果来自已存档记录，历史覆盖取决于同步进度。';
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

  async function showSync() {
    cancel();
    const ui = createModal();
    const state = { mode: 'sync', status: '正在读取私人状态…', archive: null, busy: false };
    current = state;
    ui.title.textContent = '私人档案同步';
    if (!ui.dialog.open) ui.dialog.showModal();
    render();
    try {
      const result = await backendRequest('/v1/status');
      if (current !== state) return;
      state.archive = validArchive(result.archive);
      state.status = '一年内封禁记录会同步到私人数据库；论坛 Cookie 留在浏览器内。点击下方按钮后才开始读取论坛。';
    } catch (error) { if (current === state) { state.status = error.message; if (/连接已过期/.test(error.message)) GM_deleteValue(STORAGE_KEY); } }
    if (current === state) render();
  }

  function archivePacket(row) {
    const id = numericId(row.id);
    const uid = numericId(row.target_member_id);
    if (!id) throw new Error('记录缺少有效编号或 UID，已停止同步，未将其当作空记录。');
    let detail;
    try { detail = typeof row.request === 'string' ? JSON.parse(row.request) : row.request; }
    catch { throw new Error('记录操作格式异常，已停止同步。'); }
    const ban = detail?.suspend && typeof detail.suspend === 'object' && !Array.isArray(detail.suspend);
    if (!ban) return { id: Number(id), created_at: row.created_at, request: '{}' };
    if (!uid) throw new Error('封禁记录缺少有效 UID，已停止同步。');
    return { id: Number(id), target_member_id: uid,
      target_member_name: typeof row.target_member_name === 'string' ? row.target_member_name : '',
      admin_member_name: typeof row.admin_member_name === 'string' ? row.admin_member_name : '',
      created_at: typeof row.created_at === 'string' ? row.created_at : '',
      post_id: numericId(row.post_id) ? Number(row.post_id) : null,
      request: JSON.stringify({ suspend: detail.suspend, coin: { reason: detail.coin?.reason } }) };
  }

  async function runSync(mode) {
    if (current?.mode !== 'sync' || !['all', 'recent', 'history'].includes(mode)) return;
    if (!credentials()) { current.status = '尚未配对，请先连接私人面板。'; render(); return; }
    cancel();
    const state = current;
    const ticket = generation;
    const controller = new AbortController();
    active = controller; state.busy = true;
    let live = { state: 'running', stage: mode === 'history' ? 'verify' : 'recent' };
    let heartbeat;
    const report = (value) => { reportQueue = reportQueue.then(() => backendRequest('/v1/progress', 'POST', value)).catch(() => {}); };
    const beat = () => { report({ ...live }); heartbeat = setTimeout(beat, 10000); };
    beat();
    stopReporter = (ending, errorCode = null) => { clearTimeout(heartbeat); report({ ...live, state: ending, errorCode }); };
    const progress = (text) => {
      if (ticket !== generation || current !== state || controller.signal.aborted) throw new Error('操作已取消。');
      state.status = text; render();
    };
    const save = async (kind, rows, requestedId, paging = {}) => {
      const result = await backendRequest('/v1/ingest', 'POST', { kind, records: rows.map(archivePacket), ...(kind === 'id' ? { requestedId } : paging) }, controller.signal);
      if (ticket !== generation) throw new Error('操作已取消。');
      state.archive = validArchive(result.archive);
      return result;
    };
    try {
      if (mode !== 'history') {
        let lastPage = MAX_PAGES;
        const stopOnOverlap = state.archive?.recentSeeded === true;
        for (let page = 1; page <= lastPage; page += 1) {
          live = { state: 'running', stage: 'recent', page };
          progress(`正在同步最近记录：第 ${page} 页…`);
          const data = await forumRequest('page', page, controller.signal);
          if (ticket !== generation) return;
          lastPage = Math.min(MAX_PAGES, Math.max(1, Math.ceil(data.total / PAGE_SIZE)));
          const result = await save('page', data.data, undefined, { page, lastPage });
          if (!data.data.length || (stopOnOverlap && result.allKnown)) break;
        }
      }
      if (mode !== 'recent') {
        let plan = await backendRequest('/v1/sync-plan', 'GET', undefined, controller.signal);
        if (!plan.latestId) throw new Error('请先同步最近记录，取得当前记录范围。');
        const upper = plan.latestId;
        live = { state: 'running', stage: 'verify', recordId: upper };
        progress('正在验证按记录编号读取接口…');
        const probe = await forumRequest('id', upper, controller.signal);
        if (probe.data.length !== 1 || Number(probe.data[0].id) !== upper) throw new Error('按编号读取接口未通过验证，已保留最近记录，未开始历史补采。');
        await save('id', probe.data, upper);
        while (plan.nextId > 0) {
          live = { state: 'running', stage: 'history', recordId: plan.nextId };
          if (!Number.isSafeInteger(plan.nextId) || plan.nextId < 1) throw new Error('私人续传进度异常。');
          progress(`正在补采历史编号 ${plan.nextId} / ${upper}…可停止后续传。`);
          const data = await forumRequest('id', plan.nextId, controller.signal);
          if (ticket !== generation) return;
          const result = await save('id', data.data, plan.nextId);
          if (result.archive.nextId >= plan.nextId) throw new Error('私人续传进度未推进，已停止。');
          plan = result.archive;
        }
      }
      progress('本次同步已完成。仅代表当前可读取、已同步的范围，不保证完整历史。');
      stopReporter?.('completed'); stopReporter = null;
    } catch (error) {
      if (ticket === generation && current === state) {
        state.status = error.message;
        const code = /限速/.test(error.message) ? 'rate_limit' : /401|登录/.test(error.message) ? 'login' : /403|验证/.test(error.message) ? 'challenge' : /格式|编号|UID/.test(error.message) ? 'format' : /网络|超时|连接/.test(error.message) ? 'network' : 'unknown';
        stopReporter?.('error', code); stopReporter = null;
      }
    } finally {
      if (ticket === generation && current === state) { active = null; state.busy = false; render(); }
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

  GM_registerMenuCommand('私人档案同步', () => showSync());
  GM_registerMenuCommand('打开私人面板', () => openLocal());
  GM_registerMenuCommand('断开私人连接', () => { cancel(); GM_deleteValue(STORAGE_KEY); if (modal?.dialog.open) modal.dialog.close(); });
  function connectWithCode(pairCode) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(pairCode)) { if (current) { current.status = '连接码格式不正确，请从私人面板重新复制。'; render(); } return; }
    const ui = createModal();
    ui.title.textContent = '连接私人档案';
    ui.content.replaceChildren(el('p', '正在验证私人的一次性连接码…'));
    ui.dialog.showModal();
    backendRequest('/pair/claim', 'POST', { code: pairCode }).then((result) => {
      if (!['queryToken', 'syncToken'].every((key) => /^[A-Za-z0-9_-]{43}$/.test(result[key]))) throw new Error('私人连接数据格式不匹配。');
      GM_setValue(STORAGE_KEY, { queryToken: result.queryToken, syncToken: result.syncToken });
      return showSync();
    }).catch(async (error) => { await showSync(); if (current) { current.status = error.message; render(); } });
  }
  if (initialPairCode) connectWithCode(initialPairCode);
  else if (location.pathname === '/ruling') showSync();

  injectButtons();
  new MutationObserver((mutations) => {
    if (scheduled || !mutations.some((mutation) => mutation.addedNodes.length)) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      injectButtons();
    });
  }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
