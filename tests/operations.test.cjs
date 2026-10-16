'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {createManagedBrowser}=require('../backend/managed-browser.cjs');
const {createNotifications}=require('../backend/notifications.cjs');
const {createApp}=require('../backend/server.cjs');const {openStore}=require('../backend/store.cjs');
function state(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-ops-'));t.after(()=>{const actual=fs.realpathSync(dir);assert.ok(actual.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(actual).startsWith('ns-ops-'));fs.rmSync(actual,{recursive:true,force:true});});return dir;}
const credentials=()=>({enabled:true,token:'123456789:'+crypto.randomBytes(28).toString('base64url'),chatId:'123456789'});
test('managed browser starts only on demand, sleeps after a batch, and preserves manual ownership',async t=>{
 const calls=[];let connected=false;
 const raw={info:async()=>({onForum:connected}),disconnect:()=>calls.push('disconnect'),close:()=>calls.push('close'),frame:async()=>Buffer.from('synthetic')};
 const browser=createManagedBrowser({browser:raw,service:async verb=>{calls.push(verb);connected=verb==='start'},delay:async()=>{}});t.after(()=>browser.close());
 assert.equal(browser.status().awake,false);await browser.wake();assert.equal(browser.status().awake,true);
 await browser.sleep();assert.equal(browser.status().awake,false);
 await browser.manual();await browser.sleep();assert.equal(browser.status().awake,true);assert.equal(browser.status().manual,true);assert.equal((await browser.frame()).toString(),'synthetic');
 browser.automatic();await browser.sleep();assert.equal(browser.status().awake,false);await assert.rejects(browser.frame(),/browser_unavailable/);
 assert.deepEqual(calls.filter(x=>['start','stop'].includes(x)),['start','stop','start','stop']);
});
test('lifecycle command failures have fixed errors and never report successful sleep',async()=>{
 const browser=createManagedBrowser({browser:{info:async()=>({onForum:true}),close:()=>{}},service:async verb=>{if(verb==='stop')throw new Error('private output');}});
 await browser.wake();await assert.rejects(browser.sleep(),/^Error: browser_unavailable$/);assert.equal(browser.status().awake,true);
});

test('abandoned manual control closes the browser after its idle lease',async t=>{
 let stops=0;const b=createManagedBrowser({browser:{info:async()=>({onForum:true}),close:()=>{}},service:async verb=>{if(verb==='stop')stops++},manualIdleMs:5});t.after(()=>b.close());
 await b.manual();await new Promise(r=>setTimeout(r,25));assert.equal(b.status().manual,false);assert.equal(b.status().awake,false);assert.equal(stops,1);
});
test('notifications are opt-in, private, deduplicated across restarts and limited to safe fixed messages',async t=>{
 const dir=state(t),calls=[];const fetcher=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ok:true}));};
 const n=createNotifications({stateDir:dir,fetcher,now:()=>100000});const incident={incidentAt:90000,code:'login_required',lastSuccessAt:80000,cookie:'synthetic-private',record:'synthetic-record'};
 await n.event('blocked',incident);assert.equal(calls.length,0);
 const secret=credentials();n.configure(secret);assert.equal(JSON.stringify(n.status()).includes(secret.token),false);
 await n.event('blocked',incident);await n.event('blocked',incident);assert.equal(calls.length,1);
 const resumed=createNotifications({stateDir:dir,fetcher,now:()=>100001});await resumed.event('blocked',incident);assert.equal(calls.length,1);
 await resumed.event('recovered',incident);assert.equal(calls.length,2);
 const data=JSON.parse(calls[0].init.body);assert.equal(data.chat_id,secret.chatId);assert.match(data.text,/登录失效/);assert.doesNotMatch(data.text,/synthetic/);assert.equal(calls[0].init.redirect,'error');
 assert.equal(new URL(calls[0].url).origin,'https://api.telegram.org');assert.equal(resumed.status().lastError,null);
 resumed.configure({enabled:false,clear:true});assert.equal(fs.readFileSync(path.join(dir,'notifications.json'),'utf8').includes(secret.token),false);
});
test('invalid destinations and notification errors cannot expose upstream payloads or credentials',async t=>{
 const dir=state(t);let count=0;const n=createNotifications({stateDir:dir,now:()=>100000,fetcher:async()=>{count++;throw new Error('secret-token-upstream-body');}});
 for(const value of [{...credentials(),chatId:'-123'}, {...credentials(),endpoint:'https://example.invalid'}, {...credentials(),token:'invalid'}, {...credentials(),chatId:123}])assert.throws(()=>n.configure(value),/invalid_body/);
 n.configure(credentials());const r=await n.test();assert.equal(r.lastError,'network_error');assert.doesNotMatch(JSON.stringify(r),/secret-token/);await assert.rejects(n.test(),/rate_limited/);assert.equal(count,1);
});
test('notification settings require owner session; all API tokens are denied and GET never returns secrets',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const n=createNotifications({stateDir:state(t)});const secret=credentials();
 const keys={queryToken:crypto.randomBytes(32).toString('base64url'),syncToken:crypto.randomBytes(32).toString('base64url'),adminToken:crypto.randomBytes(32).toString('base64url')};
 const app=createApp({store,...keys,notifications:n});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));
 const base='http://127.0.0.1:'+app.server.address().port;
 for(const token of Object.values(keys)){const r=await fetch(base+'/owner/notifications',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,403);await r.json();}
 const setup=await fetch(base+'/local/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:app.setupCode()})});const cookie=setup.headers.get('set-cookie').split(';')[0];await setup.json();
 const saved=await fetch(base+'/owner/notifications',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(secret)});assert.equal(saved.status,200);assert.doesNotMatch(await saved.text(),new RegExp(secret.token));
 const result=await fetch(base+'/owner/notifications',{headers:{Cookie:cookie}});assert.equal(result.status,200);const text=await result.text();assert.ok(!text.includes(secret.token)&&!text.includes(secret.chatId));
});
