#!/usr/bin/env node
'use strict';
// server/admin-visibility.js — 临时隐身账号的运维入口（只改 hidden_accounts）。
// 用法：
//   node server/admin-visibility.js --list
//   node server/admin-visibility.js --set SK-666,SK-777,cassius --days 7 --reason "测试期隐身"
//   node server/admin-visibility.js --clear SK-666
// 默认库：DATA_DIR/ssdz.db → /var/lib/ssdz/ssdz.db → 仓库 save/online/ssdz.db。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TZ = process.env.TZ_NAME || 'Asia/Shanghai';

function parseArgs(argv) {
  const out = { db: '', list: false, set: '', clear: '', days: 7, until: '', reason: '', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length) throw new Error(a + ' 缺少值'); return argv[++i]; };
    if (a === '--db') out.db = need();
    else if (a === '--list') out.list = true;
    else if (a === '--set') out.set = need();
    else if (a === '--clear') out.clear = need();
    else if (a === '--days') out.days = Number(need());
    else if (a === '--until') out.until = need();
    else if (a === '--reason') out.reason = need();
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function usage() {
  return [
    '临时隐身账号（不改存档/天梯分数；hidden_until 到点自动失效）',
    '',
    '  node server/admin-visibility.js --list [--json]',
    '  node server/admin-visibility.js --set SK-666,SK-777 --days 7 --reason "测试期隐身"',
    '  node server/admin-visibility.js --set SK-666 --until "2026-11-26T11:20:00+08:00"',
    '  node server/admin-visibility.js --clear SK-666,SK-777',
    '',
    '  --db <file>   指定库；默认 DATA_DIR/ssdz.db → /var/lib/ssdz/ssdz.db → save/online/ssdz.db',
    '  --json        机器可读输出',
  ].join('\n');
}

function pickDb(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('数据库不存在：' + path.resolve(explicit));
    return path.resolve(explicit);
  }
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(path.join(process.env.DATA_DIR, 'ssdz.db'));
  candidates.push('/var/lib/ssdz/ssdz.db');
  candidates.push(path.join(ROOT, 'save', 'online', 'ssdz.db'));
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 ssdz.db，试过：' + candidates.join('、') + '；请用 --db 指定');
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hidden_accounts (
    account_id   INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    hidden_until INTEGER NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_hidden_until ON hidden_accounts(hidden_until)');
}

function findAccounts(db, text) {
  const q = String(text || '').trim();
  if (!q) return [];
  const rows = db.prepare(
    `SELECT a.id, a.name, a.tag, p.player_id
       FROM accounts a LEFT JOIN player_ids p ON p.account_id = a.id
      WHERE a.id = ? OR a.name = ? OR (a.name || '#' || a.tag) = ? OR CAST(p.player_id AS TEXT) = ?
      ORDER BY a.id`
  ).all(Number(q) || 0, q, q, q);
  const seen = new Set();
  return rows.filter((r) => {
    const id = Number(r.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function fmt(t) {
  if (!t) return '-';
  try {
    return new Date(Number(t)).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
  } catch (_) { return new Date(Number(t)).toISOString(); }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return; }
  const db = new DatabaseSync(pickDb(opts.db));
  db.exec('PRAGMA busy_timeout=10000');
  ensureTable(db);
  const now = Date.now();

  if (opts.clear) {
    const names = String(opts.clear).split(',').map((x) => x.trim()).filter(Boolean);
    let changed = 0;
    for (const name of names) {
      const found = findAccounts(db, name);
      if (!found.length) throw new Error('找不到账号：' + name);
      if (found.length > 1) throw new Error('账号不唯一：' + name + ' → ' + found.map((r) => r.id + ':' + r.name).join(','));
      changed += Number(db.prepare('DELETE FROM hidden_accounts WHERE account_id = ?').run(Number(found[0].id)).changes) || 0;
      console.log('cleared', found[0].id, found[0].name + '#' + found[0].tag);
    }
    console.log('cleared rows', changed);
    db.close();
    return;
  }

  if (opts.set) {
    let until = 0;
    if (opts.until) {
      until = Date.parse(opts.until);
      if (!Number.isFinite(until)) throw new Error('--until 不是合法时间：' + opts.until);
    } else {
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('--days 必须在 1~365');
      until = now + Math.round(days * 86400000);
    }
    if (until <= now) throw new Error('隐身截止时间必须晚于当前时间');
    const names = String(opts.set).split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.length) throw new Error('--set 至少给一个账号');
    const targets = [];
    for (const name of names) {
      const found = findAccounts(db, name);
      if (!found.length) throw new Error('找不到账号：' + name);
      if (found.length > 1) throw new Error('账号不唯一：' + name + ' → ' + found.map((r) => r.id + ':' + r.name).join(','));
      targets.push(found[0]);
    }
    const reason = String(opts.reason || '').slice(0, 200);
    const stamp = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const st = db.prepare(
        `INSERT INTO hidden_accounts (account_id, hidden_until, reason, created_at, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           hidden_until = excluded.hidden_until,
           reason = excluded.reason,
           updated_at = excluded.updated_at`
      );
      for (const row of targets) st.run(Number(row.id), until, reason, stamp, stamp);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    console.log(JSON.stringify({
      ok: true, until, untilText: fmt(until), reason,
      accounts: targets.map((r) => ({ id: Number(r.id), playerId: Number(r.player_id) || 0, name: r.name, tag: r.tag })),
    }, null, 2));
    db.close();
    return;
  }

  // list
  const rows = db.prepare(
    `SELECT h.account_id, h.hidden_until, h.reason, h.created_at, h.updated_at,
            a.name, a.tag, p.player_id, s.level
       FROM hidden_accounts h
       JOIN accounts a ON a.id = h.account_id
       LEFT JOIN player_ids p ON p.account_id = h.account_id
       LEFT JOIN saves s ON s.account_id = h.account_id AND s.mode = 'classic'
      ORDER BY h.hidden_until DESC, h.account_id`
  ).all();
  const out = rows.map((r) => ({
    accountId: Number(r.account_id), playerId: Number(r.player_id) || 0,
    name: String(r.name), tag: String(r.tag), level: Number(r.level) || 1,
    until: Number(r.hidden_until) || 0, untilText: fmt(r.hidden_until),
    active: (Number(r.hidden_until) || 0) > now,
    reason: String(r.reason || ''),
    createdAt: Number(r.created_at) || 0, updatedAt: Number(r.updated_at) || 0,
  }));
  if (opts.json) console.log(JSON.stringify({ ok: true, now, accounts: out }, null, 2));
  else {
    console.log('库：' + pickDb(opts.db) + '（只读列表）');
    if (!out.length) console.log('（没有隐身账号）');
    for (const r of out) {
      console.log(
        String(r.accountId).padStart(5), (r.name + '#' + r.tag).padEnd(20),
        'Lv' + String(r.level).padEnd(3), r.active ? 'ACTIVE' : 'expired',
        'until ' + r.untilText, r.reason ? '· ' + r.reason : ''
      );
    }
    console.log('active', out.filter((r) => r.active).length, '/ total', out.length);
  }
  db.close();
}

try { main(); } catch (e) {
  console.error('[admin-visibility] ' + ((e && e.message) || e));
  process.exitCode = 1;
}
