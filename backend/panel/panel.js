'use strict';
(async () => {
  const el = (id) => document.getElementById(id);
  const message = el('message');
  const request = async (url, data) => {
    const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!response.ok) {
      if (response.status === 429) throw new Error('尝试次数过多，请一分钟后再试。');
      if (response.status === 400) throw new Error('请使用 24–128 位、含大小写字母数字和符号的新密码。');
      throw new Error('密码不正确或登录已过期，请重新登录。');
    }
    return response.json();
  };
  const showLogin = () => { el('login').hidden = false; el('controls').hidden = true; };
  const refresh = async () => {
    const data = await request('/local/status');
    el('count').textContent = String(data.archive.count);
    el('last').textContent = data.archive.lastSync ? new Date(data.archive.lastSync).toLocaleString() : '尚未同步';
    el('login').hidden = true; el('controls').hidden = false;
    message.textContent = data.archive.count ? '私人档案已就绪。查询覆盖已存档的一年内封禁记录。' : '服务已就绪，尚无记录。请连接油猴，在论坛同步一次。';
  };
  el('login').onsubmit = async (event) => {
    event.preventDefault();
    try { await request('/auth/login', { password: el('password').value }); el('password').value = ''; await refresh(); }
    catch (e) { message.textContent = e.message; }
  };
  el('refresh').onclick = () => refresh().catch((e) => { showLogin(); message.textContent = e.message; });
  el('pair').onclick = async () => {
    const target = window.open('about:blank', '_blank');
    if (target) target.opener = null;
    try {
      const data = await request('/local/pair', {});
      const url = `https://www.nodeseek.com/ruling#ns-seek-pair=${encodeURIComponent(data.code)}`;
      if (target) target.location = url; else location.assign(url);
    } catch (error) { target?.close(); message.textContent = error.message; }
  };
  el('generate').onclick = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    el('new-password').value = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_') + '!Aa1';
    message.textContent = '已生成复杂密码。请先复制并保存，再点击更换。';
  };
  el('copy').onclick = async () => {
    try { if (!el('new-password').value) throw new Error(); await navigator.clipboard.writeText(el('new-password').value); message.textContent = '新密码已复制，请保存在密码管理器中。'; }
    catch { message.textContent = '未能复制，请使用密码管理器保存新密码。'; }
  };
  el('rotate').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await request('/auth/password', { currentPassword: el('current-password').value, newPassword: el('new-password').value });
      el('rotate').reset(); message.textContent = '密码已更换，所有旧登录和油猴密钥已撤销。请点击连接油猴重新配对。';
    } catch (e) { message.textContent = e.message; }
  };
  el('logout').onclick = async () => {
    try { await request('/auth/logout', {}); showLogin(); message.textContent = '已退出。已配对的油猴仍可查询，需要撤销时请更换密码。'; }
    catch (e) { message.textContent = e.message; }
  };
  try {
    const code = new URLSearchParams(location.hash.slice(1)).get('setup');
    history.replaceState(null, '', '/');
    if (code) await request('/local/session', { code });
    await refresh();
  } catch { showLogin(); message.textContent = '请输入专属访问密码。'; }
})();
