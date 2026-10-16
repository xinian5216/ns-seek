'use strict';
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const {execFileSync}=require('node:child_process');const {hashPassword}=require('./password.cjs');
function prepare(file,value,owner) {
  const temp=file+'.rotate-'+crypto.randomBytes(8).toString('hex');
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,value);if(owner&&process.platform!=='win32')fs.fchownSync(fd,owner.uid,owner.gid);fs.fsyncSync(fd);}catch(error){fs.closeSync(fd);fs.unlinkSync(temp);throw error;}
  fs.closeSync(fd);
  return temp;
}
function rotateCredentials({stateDir,accessFile,password=crypto.randomBytes(32).toString('base64url')+'!Aa1'}={}) {
  const file=path.join(stateDir,'secrets.json');const stat=fs.statSync(file);
  const previous=JSON.parse(fs.readFileSync(file,'utf8'));
  if(![previous.queryToken,previous.syncToken,previous.adminToken].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)))throw new Error('invalid_credentials');
  const next={queryToken:crypto.randomBytes(32).toString('base64url'),syncToken:crypto.randomBytes(32).toString('base64url'),adminToken:crypto.randomBytes(32).toString('base64url'),passwordHash:hashPassword(password),publicOrigin:previous.publicOrigin||null};
  let secretTemp,noteTemp;
  try {
    secretTemp=prepare(file,JSON.stringify(next),stat);
    noteTemp=prepare(accessFile,'NS Seek 私人访问资料\n访问地址：https://ns.042804.xyz:8443/\n访问密码：'+password+'\n旧会话和所有旧 API 密钥已撤销，请重新连接油猴。\n此文件仅 root 可读，请保存在密码管理器。\n');
    fs.renameSync(noteTemp,accessFile);noteTemp=null;
    fs.renameSync(secretTemp,file);secretTemp=null;
    return next;
  }finally{for(const temp of [secretTemp,noteTemp])if(temp)fs.unlinkSync(temp);}
}
function runRotation({uid,stop,start,rotate}) {
  if(uid!==0)throw new Error('root_required');
  stop();
  try{rotate();}catch(error){try{start();}catch{/* Keep the original failure private. */}throw error;}
  start();
}
if(require.main===module){
  try {
    if(process.argv.length!==2)throw new Error('invalid_arguments');
    runRotation({uid:process.getuid?.(),stop:()=>execFileSync('/usr/bin/systemctl',['stop','ns-seek.service'],{timeout:60000,stdio:'ignore'}),
      start:()=>execFileSync('/usr/bin/systemctl',['start','ns-seek.service'],{timeout:30000,stdio:'ignore'}),
      rotate:()=>rotateCredentials({stateDir:'/var/lib/ns-seek',accessFile:'/root/ns-seek-access.txt'})});
    console.log('访问密码和全部 API 密钥已轮换，旧会话已撤销。新密码仅保存于 /root/ns-seek-access.txt；请用 root 查看并保存，然后重新连接油猴。');
  }catch(error){console.error(error.message==='root_required'?'仅允许在 VPS 上以 root 执行。':'轮换未能完成。请检查服务状态；凭据如已写入，新密码保存在 /root/ns-seek-access.txt。没有输出密码或密钥。');process.exitCode=1;}
}
module.exports={rotateCredentials,runRotation};
