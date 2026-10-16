'use strict';
(async () => {
  const el = id => document.getElementById(id);
  const image = el('screen'); const message = el('message');
  let ready = false; let previous; let busyFrame = false; let queue = Promise.resolve(); let wheelAt = 0;
  const request = async (route,value) => {
    const response = await fetch(route,{method:value === undefined ? 'GET' : 'POST',credentials:'same-origin',cache:'no-store',
      headers:value === undefined ? {} : {'Content-Type':'application/json'},body:value === undefined ? undefined : JSON.stringify(value),signal:AbortSignal.timeout(30000)});
    if (response.status === 401) { ready = false; location.assign('/'); throw new Error('登录已过期，请重新登录面板。'); }
    if (!response.ok) throw new Error(response.status === 409 ? '请先暂停自动采集，再控制浏览器。' : '浏览器暂时没有回应，请稍后重试。');
    return response;
  };
  const frame = async () => {
    if (!ready || document.hidden || busyFrame) return;
    busyFrame = true;
    try {
      const response = await request('/owner/browser/frame');
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      image.src = url;
      el('connection').textContent='画面已连接 · '+new Date().toLocaleTimeString()+' · 可切换适应窗口／原始大小';
      if (previous) URL.revokeObjectURL(previous); previous = url;
    } catch (error) { el('connection').textContent='画面刷新失败：'+error.message; }
    finally { busyFrame = false; }
  };
  const action = value => {
    if (!ready) return;
    queue = queue.then(() => request('/owner/browser/action',value)).then(() => frame()).catch(error => { message.textContent = error.message; });
  };
  const point = event => {
    const bounds = image.getBoundingClientRect();
    return {x:Math.min(1099,Math.max(0,(event.clientX-bounds.left)*1100/bounds.width)),y:Math.min(759,Math.max(0,(event.clientY-bounds.top)*760/bounds.height))};
  };
  image.onclick = event => { image.focus(); action({type:'click',...point(event)}); };
  image.addEventListener('wheel',event => {
    event.preventDefault(); if (Date.now()-wheelAt < 150) return; wheelAt=Date.now();
    action({type:'wheel',...point(event),deltaY:Math.max(-1500,Math.min(1500,event.deltaY))});
  },{passive:false});
  const keys = new Set(['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End','PageUp','PageDown']);
  image.onkeydown = event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (keys.has(event.key)) { event.preventDefault(); action({type:'key',key:event.key,modifiers:event.shiftKey?8:0}); }
    else if (event.key.length === 1 && !event.isComposing) { event.preventDefault(); action({type:'text',text:event.key}); }
  };
  image.onpaste = event => { const text=event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); action({type:'text',text:text.slice(0,4096)}); } };
  el('paste').onsubmit = event => { event.preventDefault(); const value=el('text').value; el('text').value=''; if (value) { action({type:'text',text:value}); image.focus(); } };
  el('fit').onclick=()=>{const natural=el('screen-wrap').classList.toggle('natural');el('fit').textContent=natural?'适应窗口':'切换原始大小';};
  el('home').onclick = () => action({type:'navigate',page:'home'});
  el('ruling').onclick = () => action({type:'navigate',page:'ruling'});
  el('enable').onclick = async () => {
    el('enable').disabled=true;
    try { await request('/owner/automation/enable',{}); ready=false; location.assign('/'); }
    catch (error) { message.textContent=error.message; el('enable').disabled=false; }
  };
  try {
    await request('/owner/automation/pause',{}); ready=true;
    message.textContent='采集已暂停。请在画面中正常登录或验证，完成后点击「验证并启用自动同步」。';
    const refresh = async () => { await frame(); if (ready) setTimeout(refresh,1000); };
    await refresh();
  } catch (error) { message.textContent=error.message; }
  window.addEventListener('pagehide',() => { ready=false; if(previous)URL.revokeObjectURL(previous); });
})();
