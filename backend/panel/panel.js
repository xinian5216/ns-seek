'use strict';
(async () => {
  const el = (id) => document.getElementById(id);
  const message = el('message');
  let refreshing = false;
  let poll;
  let clearCode;
  let manualConfigured = false;
  const request = async (url, data) => {
    const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      if (response.status === 429) throw new Error('尝试次数过多，请一分钟后再试。');
      if (response.status === 400) throw new Error('请使用 24–128 位、含大小写字母数字和符号的新密码。');
      if (response.status === 401) throw Object.assign(new Error('密码不正确或登录已过期，请重新登录。'), { auth: true });
      throw new Error('服务暂时未能完成请求，请稍后刷新。');
    }
    return response.json();
  };
  const showLogin = () => { clearTimeout(poll); el('login').hidden = false; el('controls').hidden = true; el('pair-code').value = ''; el('pair-fallback').hidden = true; };
  const refresh = async (manual = false) => {
    if (refreshing) return;
    refreshing = true; el('refresh').disabled = true; el('refresh').textContent = '正在刷新…';
    try {
    const data = await request('/local/status');
    el('count').textContent = String(data.archive.count);
    el('last').textContent = data.archive.lastSync ? new Date(data.archive.lastSync).toLocaleString() : '尚未同步';
    el('login').hidden = true; el('controls').hidden = false;
    const auto = data.automation;
    el('automation').hidden = !auto?.available;
    if (!manualConfigured) { el('manual').open = !auto?.available; manualConfigured = true; }
    if (auto?.available) {
      const reasons = {verification_required:'需要你完成论坛验证，采集已暂停',login_required:'论坛登录失效，采集已暂停',login_or_verification_required:'需要论坛登录或浏览器验证，采集已暂停',rate_limited:'论坛限速，采集已暂停',network_error:'网络异常，采集已暂停',browser_unavailable:'专用浏览器暂不可用，采集已暂停',resource_limit:'VPS 可用内存不足，采集已暂停',format_error:'接口格式发生变化，采集已暂停',forum_error:'论坛服务异常，采集已暂停'};
      el('auto-state').textContent = auto.blocked ? reasons[auto.blocked] || '采集已暂停，请检查浏览器' : auto.running ? 'VPS 正在自动采集，电脑可以关闭' : auto.enabled ? '已启用，等待下次自动采集' : '自动采集尚未启用／已手动暂停';
      const phase = auto.stage === 'recent' ? `正在读取第 ${auto.page} 页。` : auto.stage === 'history' ? `正在补采编号 ${auto.recordId}。` : auto.stage === 'verify' ? '正在验证历史读取入口。' : '';
      const date = value => value ? new Date(value).toLocaleString() : '尚无';
      el('auto-detail').textContent = `${phase}最近成功采集：${date(auto.lastSuccessAt)}。${auto.nextRunAt !== null ? `下次计划：${date(auto.nextRunAt)}。` : ''}${auto.resumeAfter ? `最早可手动恢复：${date(auto.resumeAfter)}。` : ''}${auto.blocked ? '请打开 VPS 浏览器处理，再点击验证并启用。' : ''}`;
      el('auto-count').textContent = `已检查 ${data.archive.checkedIds ?? 0} 个记录编号，保留 ${data.archive.count} 条一年内封禁／解封。`;
    }
    const sync = data.sync || { state: 'idle', paired: data.paired };
    const states = { idle: sync.paired ? '已配对，尚未开始同步' : '等待油猴配对，尚未开始同步', running: '正在同步', stopped: '已手动停止，可在论坛继续', completed: '本次同步已完成', error: '同步遇到错误，已停止' };
    el('sync-state').textContent = sync.stale ? '暂未收到脚本回应，不能确认仍在运行' : states[sync.state] || '等待同步';
    const errors = { login: '论坛登录状态需要确认。', challenge: '论坛要求浏览器验证。', rate_limit: '论坛已限速，请稍后手动继续。', format: '接口数据格式不匹配。', network: '网络或服务连接异常。', unknown: '请在论坛同步弹窗查看具体错误。' };
    const phase = sync.stage === 'recent' ? `读取最近记录${sync.page ? `：第 ${sync.page} 页` : ''}` : sync.stage === 'history' ? `补采历史${sync.recordId ? `：编号 ${sync.recordId}` : ''}` : sync.stage === 'verify' ? '验证历史读取入口' : '';
    el('sync-detail').textContent = sync.stale ? '超过 45 秒未收到回应，标签页可能关闭、休眠或网络中断。请到论坛检查。' : sync.state === 'error' ? errors[sync.errorCode] || errors.unknown : sync.state === 'running' ? `${phase}。请保持论坛同步标签页运行。` : sync.state === 'idle' ? '连接成功后，还需在论坛弹窗点击「同步档案」。没有弹窗时，可通过油猴菜单打开。' : '进度已保存。查询范围以实际已存档记录为准。';
    el('sync-count').textContent = `已检查 ${data.archive.checkedIds ?? data.archive.emptyIds ?? 0} 个记录编号；保留 ${data.archive.count} 条一年内封禁／解封。检查数量增加但封禁数量不变，也可能是在正常过滤其他记录。`;
    const stamp = new Date().toLocaleTimeString();
    el('refreshed').textContent = `状态更新于 ${stamp} · 每 5 秒自动刷新`;
    if (manual) message.textContent = `档案状态已刷新（${stamp}）。`;
    } finally { refreshing = false; el('refresh').disabled = false; el('refresh').textContent = '刷新档案状态'; }
  };
  const refreshError = (error) => { if (error.auth) showLogin(); else el('sync-state').textContent = '状态刷新失败，不能确认同步进度'; message.textContent = error.auth ? error.message : '无法刷新状态，请检查网络后重试。'; };
  const schedule = () => { clearTimeout(poll); if (el('controls').hidden) return; poll = setTimeout(async () => { if (!document.hidden) { try { await refresh(); } catch (e) { refreshError(e); } } schedule(); }, 5000); };
  el('login').onsubmit = async (event) => {
    event.preventDefault();
    try { await request('/auth/login', { password: el('password').value }); el('password').value = ''; await refresh(); schedule(); message.textContent = '登录成功。请按下方同步状态操作。'; }
    catch (e) { message.textContent = e.message; }
  };
  el('refresh').onclick = () => refresh(true).catch(refreshError);
  for (const [id,route] of [['auto-enable','enable'],['auto-pause','pause']]) {
    el(id).onclick = async () => {
      el(id).disabled = true;
      try { await request(`/owner/automation/${route}`,{}); await refresh(); message.textContent = route === 'enable' ? '已提交自动采集检查，运行状态会持续更新。电脑无需保持开机。' : '自动采集已暂停，已存档记录保留。'; }
      catch (error) { message.textContent = error.message; }
      finally { el(id).disabled = false; }
    };
  }
  el('pair').onclick = async () => {
    el('pair').disabled = true; message.textContent = '正在生成连接码，随后将在当前标签页前往论坛…';
    try {
      const data = await request('/local/pair', {});
      const url = `https://www.nodeseek.com/ruling#ns-seek-pair=${encodeURIComponent(data.code)}`;
      location.assign(url);
    } catch (error) { message.textContent = error.message; }
    finally { el('pair').disabled = false; }
  };
  el('copy-pair').onclick = async () => {
    el('copy-pair').disabled = true;
    try {
      const data = await request('/local/pair', {});
      clearTimeout(clearCode); el('pair-code').value = data.code;
      clearCode = setTimeout(() => { el('pair-code').value = ''; el('pair-fallback').hidden = true; }, 300000);
      try { await navigator.clipboard.writeText(data.code); message.textContent = '一次性连接码已复制。请前往论坛，通过油猴菜单打开「私人档案同步」，粘贴并配对。'; }
      catch { el('pair-fallback').hidden = false; el('pair-code').select(); message.textContent = '浏览器未允许自动复制，请复制下方一次性码，粘贴到论坛的脚本同步弹窗。'; }
    } catch (e) { message.textContent = e.message; }
    finally { el('copy-pair').disabled = false; }
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
    await refresh(); schedule(); message.textContent = '服务已连接。请查看下方采集状态；VPS 自动采集启用后无需保持电脑运行。';
  } catch { showLogin(); message.textContent = '请输入专属访问密码。'; }
})();
