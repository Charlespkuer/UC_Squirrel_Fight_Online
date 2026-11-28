#!/usr/bin/env node
'use strict';
// 风险警告 / 自动封禁的人工复核与解封入口（只改 accounts / account_watch / banned_ips）。
// 用法：
//   node server/admin-enforcement.js --list
//   node server/admin-enforcement.js --unban 40
//   node server/admin-enforcement.js --unban-ip 203.0.113.7
// 群主解封后，玩家可直接用原账号登录；账号封禁为永久，IP 封禁默认 7 天。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);
function pickDb() {
  const explicit = opt('--db', '');
  if (explicit) return path.resolve(explicit);
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(path.join(process.env.DATA_DIR, 'ssdz.db'));
  candidates.push('/var/lib/ssdz/ssdz.db', path.join(ROOT, 'save', 'online', 'ssdz.db'));
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 ssdz.db，请用 --db 指定');
}
function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_watch (
    account_id INTEGER PRIMARY KEY, status TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0,
    reasons TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '{}',
    warned_at INTEGER NOT NULL DEFAULT 0, warn_until INTEGER NOT NULL DEFAULT 0,
    evidence_at INTEGER NOT NULL DEFAULT 0, banned_at INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
      account_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enforcement_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '{}',
      ip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);`);
}
function find(db, text) {
  const q = String(text || '').trim();
  if (!q) return null;
  return db.prepare(`SELECT a.id,a.name,a.tag FROM accounts a LEFT JOIN player_ids p ON p.account_id=a.id
    WHERE a.id=? OR a.name=? OR (a.name||'#'||a.tag)=? OR CAST(p.player_id AS TEXT)=?
    ORDER BY a.id LIMIT 2`).all(Number(q) || 0, q, q, q);
}
function fmt(t) { return t ? new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'; }
function usage() {
  console.log('用法：node server/admin-enforcement.js --list [--json]');
  console.log('      node server/admin-enforcement.js --unban 40');
  console.log('      node server/admin-enforcement.js --unban-ip 203.0.113.7');
  console.log('      --db <file>  指定数据库（默认 DATA_DIR/ssdz.db 或 /var/lib/ssdz/ssdz.db）');
}
const dbPath = pickDb();
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=10000');
ensure(db);
const now = Date.now();

if (has('--help') || has('-h')) { usage(); db.close(); process.exit(0); }

if (has('--unban')) {
  const rows = find(db, opt('--unban', ''));
  if (!rows || !rows.length) throw new Error('找不到账号：' + opt('--unban', ''));
  if (rows.length > 1) throw new Error('账号不唯一：' + rows.map((r) => r.id + ':' + r.name).join(','));
  const a = rows[0];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE accounts SET banned=0, ban_reason=\'\' WHERE id=?').run(Number(a.id));
    db.prepare('DELETE FROM account_watch WHERE account_id=?').run(Number(a.id));
    db.prepare('DELETE FROM banned_ips WHERE account_id=?').run(Number(a.id));
    db.prepare('INSERT INTO enforcement_log(account_id,action,reason,evidence,ip,created_at) VALUES (?,?,?,?,?,?)')
      .run(Number(a.id), 'unban', '群主人工解封', '{}', '', now);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  console.log(JSON.stringify({ ok: true, action: 'unban', account: { id: Number(a.id), name: a.name, tag: a.tag } }, null, 2));
  db.close();
  process.exit(0);
}

if (has('--unban-ip')) {
  const ip = String(opt('--unban-ip', '')).trim();
  if (!ip) throw new Error('--unban-ip 缺少 IP');
  const r = db.prepare('DELETE FROM banned_ips WHERE ip=?').run(ip);
  db.prepare('INSERT INTO enforcement_log(account_id,action,reason,evidence,ip,created_at) VALUES (?,?,?,?,?,?)')
    .run(0, 'unban_ip', '群主人工解封 IP', '{}', ip, now);
  console.log(JSON.stringify({ ok: true, action: 'unban-ip', ip, removed: Number(r.changes) }, null, 2));
  db.close();
  process.exit(0);
}

const watches = db.prepare(`SELECT w.*,a.name,a.tag FROM account_watch w JOIN accounts a ON a.id=w.account_id ORDER BY w.updated_at DESC`).all();
const ips = db.prepare('SELECT * FROM banned_ips ORDER BY until DESC').all();
const out = {
  db: dbPath,
  warnings: watches.filter((w) => w.status === 'warned').map((w) => ({
    accountId: Number(w.account_id), name: w.name, tag: w.tag, score: Number(w.score),
    reasons: JSON.parse(w.reasons || '[]'), warnedAt: Number(w.warned_at), warnUntil: Number(w.warn_until),
    active: Number(w.warn_until) > now,
  })),
  bannedAccounts: watches.filter((w) => w.status === 'banned').map((w) => ({
    accountId: Number(w.account_id), name: w.name, tag: w.tag, reason: String(w.ban_reason || ''),
    bannedAt: Number(w.banned_at),
  })),
  bannedIps: ips.map((r) => ({ ip: r.ip, until: Number(r.until), reason: String(r.reason || ''), accountId: Number(r.account_id), active: Number(r.until) > now })),
};
if (has('--json')) { console.log(JSON.stringify(out, null, 2)); db.close(); process.exit(0); }
console.log('库：' + dbPath);
console.log('\n=== 警告中 ===');
if (!out.warnings.length) console.log('（无）');
for (const w of out.warnings) console.log(`#${w.accountId} ${w.name}#${w.tag} score=${w.score} until ${fmt(w.warnUntil)} ${w.active ? 'ACTIVE' : 'expired'}\n  ${w.reasons.join('；')}`);
console.log('\n=== 已自动封禁账号 ===');
if (!out.bannedAccounts.length) console.log('（无）');
for (const b of out.bannedAccounts) console.log(`#${b.accountId} ${b.name}#${b.tag} at ${fmt(b.bannedAt)}\n  ${b.reason}`);
console.log('\n=== 封禁 IP ===');
if (!out.bannedIps.length) console.log('（无）');
for (const i of out.bannedIps) console.log(`${i.ip} until ${fmt(i.until)} ${i.active ? 'ACTIVE' : 'expired'} account=#${i.accountId}`);
db.close();
