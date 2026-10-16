'use strict';
const fs=require('node:fs');const path=require('node:path');
const REASONS={verification_required:'论坛需要浏览器验证',login_required:'论坛登录失效',login_or_verification_required:'需要登录或完成论坛验证',rate_limited:'论坛限速',network_error:'网络异常',browser_unavailable:'专用浏览器不可用',resource_limit:'VPS 内存不足',format_error:'论坛接口格式变化',forum_error:'论坛服务异常'};
function createNotifications({stateDir,fetcher=fetch,now=Date.now}={}) {
  const file=path.join(stateDir,'notifications.json');
  let config={enabled:false,token:'',chatId:'',lastEvent:null,lastSentAt:null,lastError:null};
  if(fs.existsSync(file)) {
    try {const value=JSON.parse(fs.readFileSync(file,'utf8'));if(typeof value.enabled==='boolean'&&typeof value.token==='string'&&typeof value.chatId==='string')config={...config,...value};}catch{/* Invalid configuration stays disabled. */}
  }
  const persist=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(config),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const status=()=>({enabled:config.enabled,configured:!!config.token&&!!config.chatId,lastSentAt:config.lastSentAt,lastError:config.lastError});
  function configure(value) {
    if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['enabled','token','chatId','clear'].includes(k))||typeof value.enabled!=='boolean')throw new Error('invalid_body');
    if(value.clear===true){config={enabled:false,token:'',chatId:'',lastEvent:null,lastSentAt:null,lastError:null};persist();return status();}
    const token=value.token===undefined||value.token===''?config.token:value.token;
    const chatId=value.chatId===undefined||value.chatId===''?config.chatId:value.chatId;
    if(typeof token!=='string'||typeof chatId!=='string'||(token&&!/^\d{6,15}:[A-Za-z0-9_-]{30,128}$/.test(token))||(chatId&&!/^[1-9]\d{0,15}$/.test(chatId))||(value.enabled&&(!token||!chatId)))throw new Error('invalid_body');
    config={...config,enabled:value.enabled,token,chatId,lastError:null};persist();return status();
  }
  let serial=Promise.resolve();
  function send(text) {
    const token=config.token,chatId=config.chatId;
    const task=serial.then(async()=>{
      try {
        const r=await fetcher('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,link_preview_options:{is_disabled:true}})});
        if(!r.ok){await r.body?.cancel().catch(()=>{});throw new Error(r.status===429?'rate_limited':r.status===401?'invalid_token':'delivery_failed');}
        const reader=r.body.getReader();const chunks=[];let bytes=0;
        try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536)throw new Error('delivery_failed');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
        if(JSON.parse(Buffer.concat(chunks).toString('utf8')).ok!==true)throw new Error('delivery_failed');
        config.lastSentAt=now();config.lastError=null;
      }catch(error){config.lastError=['rate_limited','invalid_token','delivery_failed'].includes(error.message)?error.message:'network_error';}
      persist();return status();
    });serial=task.catch(()=>{});return task;
  }
  async function event(type,value) {
    if(!['blocked','recovered'].includes(type)||!Number.isSafeInteger(value.incidentAt))return;
    const key=type+':'+value.incidentAt;
    if(!config.enabled||!config.token||!config.chatId||config.lastEvent===key)return;
    config.lastEvent=key;persist();
    const date=value.lastSuccessAt?new Date(value.lastSuccessAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚无';
    await send(type==='blocked'?`NS Seek 采集已暂停：${REASONS[value.code]||'需要检查'}。\n最近成功：${date}（北京时间）\n请登录私人面板处理：https://ns.042804.xyz:8443/`:`NS Seek 采集已恢复，已成功读取论坛。\n最近成功：${date}（北京时间）\nhttps://ns.042804.xyz:8443/`);
  }
  let lastTest=null;
  return{status,configure,event,test:async()=>{
    if(!config.enabled||!config.token||!config.chatId)throw new Error('invalid_body');
    if(lastTest!==null&&now()-lastTest<60000)throw new Error('rate_limited');lastTest=now();
    return send('NS Seek 测试提醒：通知连接已建立。今后只在采集异常和恢复时通知，不发送账号、Cookie 或封禁记录。');
  }};
}
module.exports={createNotifications,REASONS};
