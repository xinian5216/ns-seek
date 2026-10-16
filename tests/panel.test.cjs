'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setTimeout(r,5));
const initial=()=>({ok:true,paired:false,archive:{count:0,lastSync:null,checkedIds:0},sync:{state:'idle',stage:'none',paired:false}});
async function setup(t){
 const dom=new JSDOM(fs.readFileSync('backend/panel/panel.html','utf8'),{url:'https://ns.042804.xyz:8443/',runScripts:'outside-only',pretendToBeVisual:true});
 t.after(()=>dom.window.close());const w=dom.window;
 const timers=new Map();let sequence=0;
 w.setTimeout=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;};w.clearTimeout=id=>timers.delete(id);
 w.AbortSignal=global.AbortSignal;
 let data=initial();let pending;const code=crypto.randomBytes(32).toString('base64url');
 w.fetch=async route=>{if(route==='/local/status'&&pending)return pending();return{ok:true,status:200,json:async()=>route==='/local/pair'?{ok:true,code}:data};};
 w.eval(fs.readFileSync('backend/panel/panel.js','utf8'));await tick();
 return {w,code,timers,el:id=>w.document.getElementById(id),data:v=>{data=v},pending:v=>{pending=v}};
}
test('panel refresh gives visible feedback and polls without changing pairing into automatic collection',async t=>{
 const s=await setup(t);assert.match(s.el('sync-state').textContent,/等待油猴配对/);
 assert.match(s.el('refreshed').textContent,/5 秒/);
 const next=initial();next.paired=true;next.sync.paired=true;s.data(next);
 let resolve;s.pending(()=>new Promise(r=>{resolve=r}));const completion=s.el('refresh').onclick();
 assert.equal(s.el('refresh').disabled,true);assert.match(s.el('refresh').textContent,/正在刷新/);
 resolve({ok:true,status:200,json:async()=>next});await completion;
 assert.equal(s.el('refresh').disabled,false);assert.match(s.el('message').textContent,/已刷新/);assert.match(s.el('sync-state').textContent,/已配对，尚未开始/);
 s.pending(null);next.sync={state:'running',stage:'recent',page:3,paired:true};next.archive.checkedIds=60;s.data(next);
 await [...s.timers.values()].find(x=>x.ms===5000).fn();
 assert.match(s.el('sync-state').textContent,/正在同步/);assert.match(s.el('sync-detail').textContent,/第 3 页/);assert.match(s.el('sync-count').textContent,/60 个/);
 next.sync.stale=true;await s.el('refresh').onclick();assert.match(s.el('sync-state').textContent,/不能确认/);
});
test('network refresh failures preserve login and clipboard fallback exposes only a short-lived pairing code',async t=>{
 const s=await setup(t);s.pending(()=>Promise.reject(new Error('offline')));await s.el('refresh').onclick();
 assert.equal(s.el('controls').hidden,false);assert.match(s.el('sync-state').textContent,/刷新失败/);
 s.pending(null);await s.el('copy-pair').onclick();
 assert.equal(s.el('pair-fallback').hidden,false);assert.equal(s.el('pair-code').value,s.code);
 await [...s.timers.values()].find(x=>x.ms===300000).fn();assert.equal(s.el('pair-code').value,'');assert.equal(s.el('pair-fallback').hidden,true);
});

test('panel distinguishes browser sleep, collection failure, and configured but failed notifications',async t=>{
 const s=await setup(t);const next=initial();next.automation={available:true,enabled:true,running:false,blocked:'login_required',browser:{awake:false,manual:false},nextRunAt:null};
 next.notifications={enabled:true,configured:true,lastError:'network_error',lastSentAt:null};s.data(next);await s.el('refresh').onclick();
 assert.match(s.el('auto-state').textContent,/登录失效/);assert.match(s.el('auto-detail').textContent,/已休眠/);assert.match(s.el('notify-status').textContent,/连接 Telegram 失败/);assert.equal(s.el('notify-token').value,'');
});
