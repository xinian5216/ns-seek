'use strict';
const { DatabaseSync } = require('node:sqlite');
const YEAR = 365 * 86400000;
function id(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) throw new Error('invalid_record');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid_record');
  return n;
}
function text(value, max = 200) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid_record');
  return value;
}
function clean(row) {
  const keys = ['id', 'target_member_id', 'target_member_name', 'admin_member_name', 'created_at', 'post_id', 'request'];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((k) => !keys.includes(k))) throw new Error('invalid_record');
  const detail = typeof row.request === 'string' ? row.request : JSON.stringify(row.request ?? {});
  if (detail.length > 20000) throw new Error('invalid_record');
  let request;
  try { request = JSON.parse(detail); } catch { throw new Error('invalid_record'); }
  const date = text(row.created_at, 100);
  // An explicit zone is required: do not interpret server-local timestamps differently.
  const eventTime = Date.parse(date);
  if (!Number.isFinite(eventTime) || !/(?:Z|[+-]\d\d:\d\d)$/i.test(date)) throw new Error('invalid_record');
  const suspend = request?.suspend;
  const ban = !!suspend && typeof suspend === 'object' && !Array.isArray(suspend);
  const banDetail = ban ? { status: suspend.status, value: suspend.value, reason: text(suspend.reason ?? request.coin?.reason, 2000) } : null;
  return { id: id(row.id), target_member_id: ban ? String(id(row.target_member_id)) : '',
    target_member_name: ban ? text(row.target_member_name) : '', admin_member_name: ban ? text(row.admin_member_name) : '',
    created_at: new Date(eventTime).toISOString(), post_id: ban && row.post_id != null && Number(row.post_id) > 0 ? id(row.post_id) : null,
    request: ban ? JSON.stringify({ suspend: banDetail }) : '{}', event_time: eventTime, ban };
}
function openStore(file, { now = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY, target_member_id TEXT NOT NULL, target_member_name TEXT NOT NULL,
      admin_member_name TEXT NOT NULL, created_at TEXT NOT NULL, post_id INTEGER, request TEXT NOT NULL,
      event_time INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
  // Local prerelease schema migration: remove ineligible records immediately.
  if (!db.prepare('PRAGMA table_info(records)').all().some((c) => c.name === 'event_time')) {
    db.exec('ALTER TABLE records ADD COLUMN event_time INTEGER NOT NULL DEFAULT 0');
    for (const raw of db.prepare('SELECT * FROM records').all()) {
      const { event_time, ...row } = raw;
      try {
        const r = clean(row);
        if (!r.ban) db.prepare('DELETE FROM records WHERE id=?').run(r.id);
        else db.prepare('UPDATE records SET event_time=?,request=? WHERE id=?').run(r.event_time, r.request, r.id);
      } catch { db.prepare('DELETE FROM records WHERE id=?').run(raw.id); }
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS records_uid_id ON records(target_member_id,id DESC); CREATE INDEX IF NOT EXISTS records_time ON records(event_time);');
  const get = (key) => db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
  const set = (key, value) => db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const has = (n) => !!db.prepare('SELECT id FROM probes WHERE id=?').get(n);
  const cutoff = () => now() - YEAR;
  function purge() {
    const result = db.prepare('DELETE FROM records WHERE event_time<? OR event_time>?').run(cutoff(), now() + 300000);
    db.prepare('DELETE FROM probes WHERE checked_at<?').run(new Date(cutoff()).toISOString());
    if (result.changes) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return result.changes;
  }
  purge();
  function plan() {
    const latestId = Number(get('observedLatestId') || 0);
    let nextId = get('descendingNextId') === undefined ? latestId : Number(get('descendingNextId'));
    while (nextId > 0 && has(nextId)) nextId -= 1;
    return { nextId, latestId, remainingUpperBound: nextId, direction: 'descending', retentionBoundaryReached: get('retentionBoundaryReached') === 'true' };
  }
  function status() {
    const range = db.prepare('SELECT COUNT(*) AS count,MIN(id) AS firstId,MAX(id) AS lastId FROM records WHERE event_time>=? AND event_time<=?').get(cutoff(), now() + 300000);
    const checkedIds = db.prepare('SELECT COUNT(*) AS n FROM probes').get().n;
    return { ...range, ...plan(), emptyIds: checkedIds, checkedIds,
      lastSync: get('lastSync') || null, recentSeeded: get('recentSeeded') === 'true', retentionDays: 365, completeHistory: false };
  }
  function ingest(body) {
    if (!body || !['page', 'id'].includes(body.kind) || !Array.isArray(body.records) || body.records.length > 20 ||
        Object.keys(body).some((k) => !['kind', 'records', 'requestedId', 'page', 'lastPage'].includes(k))) throw new Error('invalid_record');
    if (body.page !== undefined || body.lastPage !== undefined) {
      if (body.kind !== 'page' || !Number.isInteger(body.page) || !Number.isInteger(body.lastPage) ||
          body.page < 1 || body.lastPage > 100 || body.page > body.lastPage) throw new Error('invalid_record');
    }
    const rows = body.records.map(clean);
    const requested = body.kind === 'id' ? id(body.requestedId) : null;
    if (requested && (rows.length > 1 || rows.some((r) => r.id !== requested))) throw new Error('invalid_record');
    let known = 0; let accepted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const pending = plan().nextId;
      let latest = Number(get('observedLatestId') || 0);
      for (const r of rows) {
        if (has(r.id)) known += 1;
        latest = Math.max(latest, r.id);
        db.prepare('INSERT OR REPLACE INTO probes VALUES(?,?)').run(r.id, new Date(now()).toISOString());
        if (!r.ban || r.event_time < cutoff() || r.event_time > now() + 300000) continue;
        const previous = db.prepare('SELECT target_member_id FROM records WHERE id=?').get(r.id);
        if (previous && previous.target_member_id !== r.target_member_id) throw new Error('conflicting_record');
        db.prepare(`INSERT INTO records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          target_member_name=excluded.target_member_name, admin_member_name=excluded.admin_member_name,
          created_at=excluded.created_at, post_id=excluded.post_id,request=excluded.request,event_time=excluded.event_time`).run(
          r.id,r.target_member_id,r.target_member_name,r.admin_member_name,r.created_at,r.post_id,r.request,r.event_time);
        accepted += 1;
      }
      set('observedLatestId', latest);
      if (requested && !rows.length) db.prepare('INSERT OR REPLACE INTO probes VALUES(?,?)').run(requested, new Date(now()).toISOString());
      // Only the current descending cursor can advance. A failed HTTP request never enters here.
      if (requested && requested === pending) {
        const old = rows.length === 1 && rows[0].event_time < cutoff();
        const streak = old ? Number(get('oldStreak') || 0) + 1 : 0;
        set('oldStreak', streak);
        set('descendingNextId', streak >= 20 ? 0 : Math.max(0, requested - 1));
        if (streak >= 20) set('retentionBoundaryReached', 'true');
      }
      if (body.page !== undefined && body.page === body.lastPage) set('recentSeeded', 'true');
      set('lastSync', new Date(now()).toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    purge();
    return { accepted, allKnown: rows.length > 0 && known === rows.length, archive: status() };
  }
  function query(uid, before, limit) {
    uid = String(id(uid)); before = before == null ? Number.MAX_SAFE_INTEGER : id(before) - 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_record');
    const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE target_member_id=? AND event_time>=? AND event_time<=?').get(uid,cutoff(),now()+300000).n;
    const rows = db.prepare('SELECT id,target_member_id,target_member_name,admin_member_name,created_at,post_id,request FROM records WHERE target_member_id=? AND id<=? AND event_time>=? AND event_time<=? ORDER BY id DESC LIMIT ?').all(uid,before,cutoff(),now()+300000,limit+1);
    const more = rows.length > limit; if (more) rows.pop();
    return { records: rows,total,nextBeforeId: more ? rows.at(-1).id : null,archive: status() };
  }
  return { ingest,query,status,plan,purge,close: () => db.close() };
}
module.exports = { openStore,clean,id,YEAR };
