'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {id} = require('./store.cjs');
const RECENT_INTERVAL = 6 * 60 * 60 * 1000;
const HISTORY_INTERVAL = 15 * 60 * 1000;
const ERRORS = ['verification_required','login_required','login_or_verification_required','rate_limited','forum_error','format_error','network_error','browser_unavailable','resource_limit'];
function packet(row) {
  const number = id(row?.id);
  let request;
  try { request = typeof row.request === 'string' ? JSON.parse(row.request) : row.request; }
  catch { throw new Error('format_error'); }
  const suspend = request?.suspend;
  if (!suspend || typeof suspend !== 'object' || Array.isArray(suspend)) return {id:number,created_at:row.created_at,request:'{}'};
  return {id:number,target_member_id:String(id(row.target_member_id)),target_member_name:typeof row.target_member_name === 'string' ? row.target_member_name : '',
    admin_member_name:typeof row.admin_member_name === 'string' ? row.admin_member_name : '',created_at:row.created_at,
    post_id:row.post_id != null && Number(row.post_id) > 0 ? id(row.post_id) : null,
    request:JSON.stringify({suspend,coin:{reason:request.coin?.reason}})};
}
function createAutomation({store,browser,stateDir,now = Date.now,delay = 1200,maxHistory = 200,schedule = true,resources = () => true} = {}) {
  const file = path.join(stateDir,'automation.json');
  let state = {enabled:false,blocked:null,resumeAfter:0,nextRecentAt:0,nextHistoryAt:0,lastRunAt:null,lastSuccessAt:null};
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file,'utf8'));
      state.enabled = saved.enabled === true;
      state.blocked = ERRORS.includes(saved.blocked) ? saved.blocked : null;
      for (const key of ['resumeAfter','nextRecentAt','nextHistoryAt','lastRunAt','lastSuccessAt']) {
        if (Number.isSafeInteger(saved[key]) && saved[key] >= 0) state[key] = saved[key];
      }
    } catch { state.enabled = false; }
  }
  let running = null; let controller; let timer; let closed = false;
  let current = {stage:'none',page:null,recordId:null};
  const persist = () => { fs.writeFileSync(file + '.tmp',JSON.stringify(state),{mode:0o600}); fs.renameSync(file + '.tmp',file); };
  function nextTime() {
    if (!state.enabled || state.blocked || running) return null;
    return Math.min(state.nextRecentAt,store.plan().nextId > 0 ? state.nextHistoryAt : Infinity);
  }
  function status() {
    return {available:true,...state,running:!!running,...current,nextRunAt:nextTime(),recentIntervalHours:6,historyIntervalMinutes:15};
  }
  function arm() {
    clearTimeout(timer);
    if (!schedule || closed) return;
    const due = nextTime();
    if (due === null) return;
    timer = setTimeout(() => { run().catch(() => {}); },Math.max(100,Math.min(30000,due - now())));
    timer.unref?.();
  }
  const wait = (signal) => new Promise((resolve,reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { signal.removeEventListener('abort',abort); resolve(); };
    const timeout = setTimeout(done,delay);
    const abort = () => { clearTimeout(timeout); signal.removeEventListener('abort',abort); reject(signal.reason); };
    signal.addEventListener('abort',abort,{once:true});
  });
  async function collect(signal) {
    if (!resources()) throw new Error('resource_limit');
    const recentDue = state.nextRecentAt <= now();
    const fetchOne = async (kind,number) => {
      signal.throwIfAborted();
      if (!resources()) throw new Error('resource_limit');
      const value = await browser.read(kind,number,signal);
      await wait(signal); // Sequential pacing after every completed response, before the next request.
      signal.throwIfAborted();
      return value;
    };
    if (recentDue) {
      const overlap = store.status().recentSeeded;
      let lastPage = 100;
      for (let page = 1; page <= lastPage; page++) {
        current = {stage:'recent',page,recordId:null};
        const data = await fetchOne('page',page);
        lastPage = Math.min(100,Math.max(1,Math.ceil(data.total / 20)));
        const result = store.ingest({kind:'page',records:data.data.map(packet),page,lastPage});
        if (!data.data.length || (overlap && result.allKnown)) break;
      }
      state.nextRecentAt = now() + RECENT_INTERVAL;
      state.lastSuccessAt = now(); persist();
    }
    let plan = store.plan();
    if (plan.nextId > 0 && state.nextHistoryAt <= now()) {
      current = {stage:'verify',page:null,recordId:plan.latestId};
      const check = await fetchOne('id',plan.latestId);
      if (check.data.length !== 1 || Number(check.data[0].id) !== plan.latestId) throw new Error('format_error');
      store.ingest({kind:'id',requestedId:plan.latestId,records:check.data.map(packet)});
      plan = store.plan();
      for (let count = 0; plan.nextId > 0 && count < maxHistory; count++) {
        current = {stage:'history',page:null,recordId:plan.nextId};
        const data = await fetchOne('id',plan.nextId);
        const result = store.ingest({kind:'id',requestedId:plan.nextId,records:data.data.map(packet)});
        if (result.archive.nextId >= plan.nextId) throw new Error('format_error');
        plan = result.archive;
      }
      state.nextHistoryAt = now() + HISTORY_INTERVAL;
      state.lastSuccessAt = now(); persist();
    }
  }
  function run() {
    if (running || closed || !state.enabled || state.blocked) return running || Promise.resolve();
    const due = nextTime();
    if (due !== null && due > now()) { arm(); return Promise.resolve(); }
    clearTimeout(timer); controller = new AbortController();
    const signal = controller.signal;
    state.lastRunAt = now(); persist();
    running = (async () => {
      try { await collect(signal); }
      catch (error) {
        if (!signal.aborted) {
          state.blocked = ERRORS.includes(error.message) ? error.message : 'format_error';
          state.resumeAfter = state.blocked === 'rate_limited' ? now() + (error.retryAfter || 60) * 1000 : 0;
          persist();
        }
      } finally { running = null; current = {stage:'none',page:null,recordId:null}; arm(); }
    })();
    return running;
  }
  function enable() {
    if (state.resumeAfter > now()) throw new Error('rate_limited');
    state.enabled = true; state.blocked = null; state.resumeAfter = 0; state.nextRecentAt = 0;
    persist(); run().catch(() => {}); return status();
  }
  function pause() {
    state.enabled = false; clearTimeout(timer); controller?.abort(); persist(); return status();
  }
  async function close() { closed = true; clearTimeout(timer); controller?.abort(); await running; }
  arm();
  return {status,enable,pause,run,close};
}
module.exports = {createAutomation,packet,RECENT_INTERVAL,HISTORY_INTERVAL};
