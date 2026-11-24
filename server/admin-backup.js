#!/usr/bin/env node
'use strict';
// 独立进程备份：读服务端 SQLite，VACUUM INTO 一致性快照 + integrity_check + 保留期清理。
// 由 ssdz-backup.timer 调用；不加载游戏内核，不阻塞 API 事件循环。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || '/var/lib/ssdz';
const DB = path.join(DATA, 'ssdz.db');
const DIR = process.env.BACKUP_DIR || path.join(DATA, 'backup', 'auto');
const KEEP_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 7);
const KEEP_FILES = Math.max(2, Number(process.env.BACKUP_MAX_FILES) || 56);

function stamp(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function verify(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return String((row && row.integrity_check) || '') === 'ok';
  } finally {
    db.close();
  }
}

function prune(now) {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => /^ssdz-\d{8}-\d{6}\.db$/.test(n)); } catch (_) { return; }
  const files = names.map((name) => {
    const file = path.join(DIR, name);
    try { return { file, name, at: fs.statSync(file).mtimeMs }; } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  const cutoff = now - KEEP_DAYS * 86400000;
  files.forEach((f, index) => {
    if (f.at >= cutoff && index < KEEP_FILES) return;
    try { fs.unlinkSync(f.file); } catch (e) { console.warn('[backup] prune failed', f.name, e && e.message); }
  });
}

function main() {
  if (!fs.existsSync(DB)) throw new Error('数据库不存在：' + DB);
  const now = Date.now();
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.chmodSync(DIR, 0o700); } catch (_) {}
  const file = path.join(DIR, 'ssdz-' + stamp(now) + '.db');
  const tmp = file + '.tmp-' + process.pid;
  try { fs.unlinkSync(tmp); } catch (_) {}
  let db = null;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    db.exec('VACUUM INTO ' + quote(tmp));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  } finally {
    if (db) db.close();
  }
  try {
    if (!verify(tmp)) throw new Error('备份完整性检查失败');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  prune(now);
  console.log('[backup] ' + file + ' (' + fs.statSync(file).size + ' bytes)');
}

try { main(); } catch (e) {
  console.error('[backup] ' + ((e && e.message) || e));
  process.exitCode = 1;
}
