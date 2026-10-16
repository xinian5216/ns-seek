'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const fault = () => new Error('browser_unavailable');
function createManagedBrowser({browser,service = async verb => {
  await execute('/usr/bin/systemctl',['--no-ask-password',verb,'ns-seek-browser.service'],{timeout:30000,maxBuffer:4096});
},delay = ms => new Promise(r=>setTimeout(r,ms)),manualIdleMs = 10*60*1000} = {}) {
  let manual = false; let awake = false; let timer; let closed = false;
  let serial = Promise.resolve();
  const ordered = fn => { const task=serial.then(fn); serial=task.catch(()=>{}); return task; };
  const status = () => ({mode:'on_demand',awake,manual});
  const reset = () => browser.disconnect?.();
  async function start() {
    if(closed) throw fault();
    try{await service('start');}catch{throw fault();}
    const deadline=Date.now()+20000;
    for(let n=0;n<25&&Date.now()<deadline;n++) {
      try { const info=await browser.info(); if(info.onForum) {awake=true;return;} }
      catch { reset(); }
      await delay(400);
    }
    throw fault();
  }
  const sleep = () => ordered(async()=>{
    if(manual) return;
    clearTimeout(timer);reset();
    try {await service('stop');awake=false;} catch {throw fault();}
  });
  const touch = () => {
    clearTimeout(timer);
    timer=setTimeout(()=>{manual=false;sleep().catch(()=>{});},manualIdleMs);timer.unref?.();
  };
  return {
    status,
    wake:()=>ordered(async()=>{clearTimeout(timer);await start();}),
    sleep,
    manual:()=>{manual=true;touch();return ordered(start);},
    automatic:()=>{manual=false;clearTimeout(timer);},
    info:()=>browser.info(),read:(...args)=>browser.read(...args),
    frame:async()=>{if(!manual)throw fault();touch();return browser.frame();},
    action:async value=>{if(!manual)throw fault();touch();return browser.action(value);},
    close:async()=>{closed=true;manual=false;clearTimeout(timer);await sleep();browser.close();}
  };
}
module.exports={createManagedBrowser};
