'use strict';
// server/game/backup.js — 自动整库备份
// 一次误操作或迁移失败就只能靠临时手工副本。这里用 SQLite 的
// `VACUUM INTO` 做一致性快照（不直接 cp 正在写的 db+wal），并做：

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');
const { config } = require('../config');

function stamp(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function verify(file) {
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    return String((row && row.integrity_check) || '') === 'ok';
  } finally {
    check.close();
  }
}

function prune(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^ssdz-\d{8}-\d{6}\.db$/.test(n)); } catch (_) { return; }
  const files = names.map((name) => {
    const file = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(file); } catch (_) {}
    return st ? { file, name, at: st.mtimeMs, size: st.size } : null;
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  const cutoff = now - config.backupRetentionDays * 86400000;
  for (const f of files) {
    const tooMany = files.indexOf(f) >= config.backupMaxFiles;
    if (f.at < cutoff || tooMany) {
      try { fs.unlinkSync(f.file); } catch (e) { console.warn('[backup] prune failed', f.name, e && e.message); }
    }
  }
}

function run(nowMs) {
  if (!config.backupEnabled) return null;
  const now = Number(nowMs) || Date.now();
  const dir = config.backupDir;
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  const name = 'ssdz-' + stamp(now) + '.db';
  const file = path.join(dir, name);
  const tmp = file + '.tmp';
  try { fs.unlinkSync(tmp); } catch (_) {}
  try {
    db.backupTo(tmp);
    if (!verify(tmp)) throw new Error('备份完整性检查失败');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  const size = fs.statSync(file).size;
  prune(dir, now);
  console.log('[backup] ' + file + ' (' + size + ' bytes)');
  return { file, name, bytes: size, at: now };
}

let timer = null;
function startScheduler() {
  if (timer || !config.backupEnabled) return timer;
  try { run(); } catch (e) { console.warn('[backup] startup failed', e && e.message); }
  timer = setInterval(() => {
    try { run(); } catch (e) { console.warn('[backup] failed', e && e.message); }
  }, config.backupIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { run, startScheduler, stopScheduler, prune, verify };
