'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {openStore}=require('../backend/store.cjs');
const {createAutomation,packet,RECENT_INTERVAL,HISTORY_INTERVAL}=require('../backend/automation.cjs');
const {validateAction,decodeForum}=require('../backend/browser.cjs');
const raw=n=>({id:n,target_member_id:123,target_member_name:'合成用户',admin_member_name:'合成管理员',created_at:'2026-10-16T00:00:00Z',post_id:123,request:'{"suspend":{"status":true,"value":7},"coin":{"reason":"合成原因"}}'});
function setup(t,options={}){
 let clock=Date.parse('2026-10-16T12:00:00Z');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-seek-auto-'));
 const store=openStore(':memory:',{now:()=>clock});const calls=[];
 const browser={read:async(kind,n)=>{calls.push([kind,n]);return kind==='page'?{success:true,total:1,data:[raw(5)]}:{success:true,data:[raw(n)]};}};
 const auto=createAutomation({store,browser,stateDir:dir,now:()=>clock,delay:0,maxHistory:2,schedule:false,...options});
 t.after(async()=>{await auto.close();store.close();const resolved=fs.realpathSync(dir);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('ns-seek-auto-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return{auto,store,browser,calls,dir,advance:ms=>{clock+=ms},now:()=>clock};
}
test('server automation schedules six-hour updates, bounded history continuation and persistent resume',async t=>{
 const s=setup(t);assert.equal(s.auto.status().enabled,false);s.auto.enable();await s.auto.run();
 assert.deepEqual(s.calls,[['page',1],['id',5],['id',4],['id',3]]);
 assert.equal(s.store.plan().nextId,2);assert.equal(s.auto.status().nextRecentAt,s.now()+RECENT_INTERVAL);assert.equal(s.auto.status().nextRunAt,s.now()+HISTORY_INTERVAL);
 await s.auto.run();assert.equal(s.calls.length,4);
 s.advance(HISTORY_INTERVAL);await s.auto.run();assert.deepEqual(s.calls.slice(4),[['id',5],['id',2],['id',1]]);
 assert.equal(s.store.plan().nextId,0);assert.equal(s.auto.status().nextRunAt,s.now()+RECENT_INTERVAL-HISTORY_INTERVAL);
 const persisted=JSON.parse(fs.readFileSync(path.join(s.dir,'automation.json'),'utf8'));assert.equal(persisted.enabled,true);assert.equal(persisted.blocked,null);
 const restarted=createAutomation({store:s.store,browser:s.browser,stateDir:s.dir,now:s.now,schedule:false});t.after(()=>restarted.close());assert.equal(restarted.status().nextRunAt,s.auto.status().nextRunAt);
});
test('verification failures stop automation without periodic retries until owner resumes',async t=>{
 const s=setup(t);s.browser.read=async()=>{s.calls.push('request');throw new Error('verification_required');};
 s.auto.enable();await s.auto.run();assert.equal(s.auto.status().blocked,'verification_required');assert.equal(s.auto.status().nextRunAt,null);
 s.advance(2*RECENT_INTERVAL);await s.auto.run();assert.equal(s.calls.length,1);assert.equal(s.store.status().checkedIds,0);
 const restarted=createAutomation({store:s.store,browser:s.browser,stateDir:s.dir,now:s.now,schedule:false});t.after(()=>restarted.close());await restarted.run();assert.equal(s.calls.length,1);
});
test('pause prevents late responses from writing; low memory stops before any forum request',async t=>{
 const s=setup(t);let resolve;s.browser.read=()=>new Promise(r=>{resolve=r});s.auto.enable();const running=s.auto.run();s.auto.pause();resolve({success:true,total:1,data:[raw(5)]});await running;
 assert.equal(s.auto.status().enabled,false);assert.equal(s.store.status().count,0);
 const low=setup(t,{resources:()=>false});low.auto.enable();await low.auto.run();assert.equal(low.auto.status().blocked,'resource_limit');assert.equal(low.calls.length,0);
});
test('ordinary rows lose all identity fields before storage; browser controls cannot execute arbitrary code',()=>{
 const row={...raw(1),request:'{"coin":{"reason":"ordinary"}}',cookie:'synthetic'};
 assert.deepEqual(packet(row),{id:1,created_at:row.created_at,request:'{}'});
 for(const value of [{type:'evaluate',expression:'unsafe'},{type:'navigate',page:'http://127.0.0.1/'},{type:'text',text:'a',cookie:'synthetic'},{type:'click',x:1200,y:0},{type:'key',key:'F12'}])assert.throws(()=>validateAction(value),/invalid_body/);
 assert.equal(validateAction({type:'text',text:'合成文字'}).type,'text');
});
test('browser collection treats challenges, login, rate limits and changed fields as failures',()=>{
 for(const [response,message] of [[{status:403},'verification_required'],[{status:401},'login_required'],[{status:429,retryAfter:120},'rate_limited'],[{status:200,json:false},'login_or_verification_required'],[{status:200,json:true,value:{success:true,data:[raw(2)]}},'format_error']])assert.throws(()=>decodeForum(response,'id',1),new RegExp(message));
 assert.equal(decodeForum({status:200,json:true,value:{success:true,total:1,data:[raw(1)]}},'page',1).data.length,1);
});

test('a durable incident sends one failure event and recovery only after successful collection',async t=>{
 const events=[];const s=setup(t,{onEvent:async(type,value)=>events.push({type,...value})});
 const original=s.browser.read;let fail=true;let wakes=0,sleeps=0;s.browser.wake=async()=>{wakes++};s.browser.sleep=async()=>{sleeps++};
 s.browser.read=async(...args)=>{if(fail)throw new Error('login_required');return original(...args)};
 s.auto.enable();await s.auto.run();assert.equal(events.length,1);assert.equal(events[0].type,'blocked');assert.equal(sleeps,1);
 s.advance(60000);s.auto.enable();await s.auto.run();assert.equal(events.length,1);assert.equal(sleeps,2);
 fail=false;s.advance(60000);s.auto.enable();await s.auto.run();assert.equal(events.length,2);assert.equal(events[1].type,'recovered');assert.equal(events[0].incidentAt,events[1].incidentAt);assert.equal(wakes,3);assert.equal(sleeps,3);
 assert.equal(s.auto.status().incidentAt,null);assert.equal(s.auto.status().lastRecentSuccessAt,s.now());
});
