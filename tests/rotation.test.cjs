'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {rotateCredentials,runRotation}=require('../backend/rotate.cjs');const {hashPassword,verifyPassword}=require('../backend/password.cjs');
const {createApp}=require('../backend/server.cjs');const {openStore}=require('../backend/store.cjs');
const token=()=>crypto.randomBytes(32).toString('base64url');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-rotation-'));t.after(()=>{const actual=fs.realpathSync(dir);assert.ok(actual.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(actual).startsWith('ns-rotation-'));fs.rmSync(actual,{recursive:true,force:true});});return dir;}
async function serve(t,secrets){const store=openStore(':memory:');const app=createApp({store,...secrets});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{if(app.server.listening)await new Promise(r=>app.server.close(r));store.close();});return{app,base:'http://127.0.0.1:'+app.server.address().port};}
test('SSH rotation persists all new keys, retains origin, stores only a hash and revokes every old capability after restart',async t=>{
 const dir=fixture(t),first=token()+'!Aa1',second=token()+'!Aa2';
 const previous={queryToken:token(),syncToken:token(),adminToken:token(),passwordHash:hashPassword(first),publicOrigin:'https://ns.042804.xyz:8443'};
 const file=path.join(dir,'secrets.json'),note=path.join(dir,'access.txt');fs.writeFileSync(file,JSON.stringify(previous),{mode:0o600});
 const before=await serve(t,previous);
 const request=async(base,route,value,headers={})=>{const r=await fetch(base+route,{method:value===undefined?'GET':'POST',headers:{...(value!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:value===undefined?undefined:JSON.stringify(value)});await r.text();return r;};
 const login=await request(before.base,'/auth/login',{password:first});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];const pairCode=before.app.setupCode();
 await new Promise(r=>before.app.server.close(r));
 const updated=rotateCredentials({stateDir:dir,accessFile:note,password:second});const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(updated,saved);assert.equal(saved.publicOrigin,previous.publicOrigin);assert.equal(verifyPassword(second,saved.passwordHash),true);assert.equal(verifyPassword(first,saved.passwordHash),false);assert.ok(!fs.readFileSync(file,'utf8').includes(second));assert.ok(fs.readFileSync(note,'utf8').includes(second));
 if(process.platform!=='win32')assert.equal(fs.statSync(note).mode&0o777,0o600);
 const after=await serve(t,saved);
 assert.equal((await request(after.base,'/auth/login',{password:first})).status,401);assert.equal((await request(after.base,'/auth/login',{password:second})).status,200);
 for(const key of ['queryToken','syncToken','adminToken']){assert.notEqual(saved[key],previous[key]);assert.equal((await request(after.base,'/v1/status',undefined,{Authorization:'Bearer '+previous[key]})).status,401);}
 assert.equal((await request(after.base,'/local/status',undefined,{Cookie:cookie})).status,401);assert.equal((await request(after.base,'/local/session',{code:pairCode})).status,401);
 assert.equal((await request(after.base,'/v1/status',undefined,{Authorization:'Bearer '+saved.queryToken})).status,200);
});
test('non-root command has no effects; service is stopped before credential writes and restarted on failure',()=>{
 const calls=[],options={uid:1000,stop:()=>calls.push('stop'),start:()=>calls.push('start'),rotate:()=>calls.push('rotate')};
 assert.throws(()=>runRotation(options),/root_required/);assert.deepEqual(calls,[]);
 runRotation({...options,uid:0});assert.deepEqual(calls,['stop','rotate','start']);calls.length=0;
 assert.throws(()=>runRotation({...options,uid:0,rotate:()=>{calls.push('failed');throw new Error('synthetic');}}),/synthetic/);assert.deepEqual(calls,['stop','failed','start']);
});
test('invalid replacement cannot change the credential file or create a plaintext file',t=>{
 const dir=fixture(t),file=path.join(dir,'secrets.json'),note=path.join(dir,'access.txt');const value={queryToken:token(),syncToken:token(),adminToken:token()};fs.writeFileSync(file,JSON.stringify(value));
 assert.throws(()=>rotateCredentials({stateDir:dir,accessFile:note,password:'weak'}),/weak_password/);assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(value));assert.equal(fs.existsSync(note),false);
});
