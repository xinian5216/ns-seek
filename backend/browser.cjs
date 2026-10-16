'use strict';
const FORUM = 'https://www.nodeseek.com';
const WIDTH = 1100;
const HEIGHT = 760;
const fault = (code) => new Error(code);
const KEYS = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
function validateAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('invalid_body');
  const fields = { navigate: ['type','page'], click: ['type','x','y'], wheel: ['type','x','y','deltaY'], text: ['type','text'], key: ['type','key','modifiers'] }[value.type];
  if (!Array.isArray(fields) || Object.keys(value).some(k => !fields.includes(k))) throw fault('invalid_body');
  if (value.type === 'navigate' && !['home','ruling'].includes(value.page)) throw fault('invalid_body');
  if (['click','wheel'].includes(value.type) && ![value.x,value.y].every(Number.isFinite)) throw fault('invalid_body');
  if (['click','wheel'].includes(value.type) && (value.x < 0 || value.y < 0 || value.x >= WIDTH || value.y >= HEIGHT)) throw fault('invalid_body');
  if (value.type === 'wheel' && (!Number.isFinite(value.deltaY) || Math.abs(value.deltaY) > 2000)) throw fault('invalid_body');
  if (value.type === 'text' && (typeof value.text !== 'string' || !value.text.length || value.text.length > 4096)) throw fault('invalid_body');
  if (value.type === 'key' && (!Object.hasOwn(KEYS,value.key) || (value.modifiers !== undefined && (!Number.isInteger(value.modifiers) || value.modifiers < 0 || value.modifiers > 15)))) throw fault('invalid_body');
  return value;
}
function decodeForum(result, kind, number) {
  if (!result || result.error) throw fault(result?.error || 'network_error');
  if (result.status === 403) throw fault('verification_required');
  if (result.status === 401) throw fault('login_required');
  if (result.status === 429) {
    const error = fault('rate_limited');
    error.retryAfter = Math.max(60,Math.min(86400,Number(result.retryAfter) || 60)); throw error;
  }
  if (result.status !== 200) throw fault('forum_error');
  if (!result.json) throw fault('login_or_verification_required');
  const data = result.value;
  if (data?.success !== true) throw fault('login_or_verification_required');
  if (!Array.isArray(data.data) || data.data.length > (kind === 'page' ? 20 : 1) ||
      data.data.some(r => !r || typeof r !== 'object' || Array.isArray(r)) ||
      (kind === 'page' && (!Number.isSafeInteger(data.total) || data.total < 0)) ||
      (kind === 'id' && data.data.some(r => Number(r.id) !== number))) throw fault('format_error');
  return data;
}
function createBrowser({ fetcher = fetch, Socket = WebSocket } = {}) {
  let socket; let connecting; let sequence = 0; let stopped = false;
  const pending = new Map();
  function rejectAll() {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fault('browser_unavailable')); }
    pending.clear();
  }
  async function connect() {
    if (stopped) throw fault('browser_unavailable');
    if (socket?.readyState === 1) return;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const response = await fetcher('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) });
        const targets = await response.json();
        if (!response.ok || !Array.isArray(targets)) throw fault('browser_unavailable');
        const target = targets.find(t => t.type === 'page' && String(t.url).startsWith(FORUM + '/')) || targets.find(t => t.type === 'page');
        if (!target || !/^ws:\/\/127\.0\.0\.1:9222\/devtools\/page\/[A-Za-z0-9_-]+$/.test(target.webSocketDebuggerUrl)) throw fault('browser_unavailable');
        const ws = new Socket(target.webSocketDebuggerUrl); socket = ws;
        await new Promise((resolve,reject) => {
          const timeout = setTimeout(() => { ws.close(); reject(fault('browser_unavailable')); },5000);
          ws.onopen = () => { clearTimeout(timeout); resolve(); };
          ws.onerror = () => { clearTimeout(timeout); reject(fault('browser_unavailable')); };
        });
        ws.onmessage = ({data}) => {
          try {
            const message = JSON.parse(data); const item = pending.get(message.id); if (!item) return;
            clearTimeout(item.timer); pending.delete(message.id);
            message.error ? item.reject(fault('browser_unavailable')) : item.resolve(message.result);
          } catch { /* Never log a browser payload. */ }
        };
        ws.onclose = rejectAll;
        await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:false});
        await send('Network.setCacheDisabled',{cacheDisabled:true});
      } catch { socket?.close(); socket = null; throw fault('browser_unavailable'); }
    })();
    try { await connecting; } finally { connecting = null; }
  }
  function send(method,params = {}) {
    return new Promise((resolve,reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(fault('browser_unavailable')); },22000);
      pending.set(id,{resolve,reject,timer});
      try { socket.send(JSON.stringify({id,method,params})); }
      catch { clearTimeout(timer); pending.delete(id); reject(fault('browser_unavailable')); }
    });
  }
  const call = async (method,params) => { await connect(); return send(method,params); };
  async function info() {
    const result = await call('Runtime.evaluate',{expression:'({origin:location.origin,path:location.pathname})',returnByValue:true});
    const value = result.result?.value;
    return { ready:true, onForum:value?.origin === FORUM, width:WIDTH,height:HEIGHT };
  }
  async function frame() {
    const result = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if (typeof result.data !== 'string' || result.data.length > 8 * 1024 * 1024) throw fault('browser_unavailable');
    return Buffer.from(result.data,'base64');
  }
  async function action(value) {
    validateAction(value);
    if (value.type === 'navigate') return call('Page.navigate',{url:FORUM + (value.page === 'ruling' ? '/ruling' : '/')});
    if (value.type === 'text') return call('Input.insertText',{text:value.text});
    if (value.type === 'key') {
      const params = {key:value.key,windowsVirtualKeyCode:KEYS[value.key],modifiers:value.modifiers || 0};
      await call('Input.dispatchKeyEvent',{...params,type:'keyDown'});
      return call('Input.dispatchKeyEvent',{...params,type:'keyUp'});
    }
    const point = {x:value.x,y:value.y};
    if (value.type === 'wheel') return call('Input.dispatchMouseEvent',{...point,type:'mouseWheel',deltaX:0,deltaY:value.deltaY});
    await call('Input.dispatchMouseEvent',{...point,type:'mousePressed',button:'left',clickCount:1});
    return call('Input.dispatchMouseEvent',{...point,type:'mouseReleased',button:'left',clickCount:1});
  }
  async function read(kind,number,signal) {
    if (!['page','id'].includes(kind) || !Number.isSafeInteger(number) || number < 1 || (kind === 'page' && number > 100)) throw fault('format_error');
    signal?.throwIfAborted();
    const route = `/api/admin/ruling/${kind}-${number}`;
    const expression = `(async()=>{if(location.pathname.toLowerCase().startsWith('/signin'))return {error:'login_required'};if(location.origin!==${JSON.stringify(FORUM)})return {error:'login_or_verification_required'};try{const r=await fetch(${JSON.stringify(route)},{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});const base={status:r.status,retryAfter:r.headers.get('Retry-After')};if(r.status!==200)return base;if(!(r.headers.get('Content-Type')||'').includes('json'))return {...base,json:false};if(Number(r.headers.get('Content-Length'))>1048576)return {error:'format_error'};const t=await r.text();if(t.length>1048576)return {error:'format_error'};try{return {...base,json:true,value:JSON.parse(t)}}catch{return {error:'format_error'}}}catch{return {error:'network_error'}}})()`;
    const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    signal?.throwIfAborted();
    return decodeForum(result.result?.value,kind,number);
  }
  return {info,frame,action,read,close:() => { stopped = true; rejectAll(); socket?.close(); }};
}
module.exports = {createBrowser,validateAction,decodeForum,FORUM,WIDTH,HEIGHT};
