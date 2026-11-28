'use strict';
// server/game/enforcement.js — 账号风险分级、警告与自动封禁
// 只读检测 + 两级处置：先警告并给 24h 观察期；观察期内继续出现脚本证据才封号/IP。
// 测试号（dev/sim/hidden）不参与自动处置；手动解封见 server/admin-enforcement.js。

const db = require('../db');

const QQ_GROUP = process.env.ENFORCEMENT_QQ_GROUP || '1128710765';
const ENABLED = process.env.ENFORCEMENT_ENABLED !== '0';
const DRY_RUN = process.env.ENFORCEMENT_DRY_RUN === '1';
const GRACE_MS = Math.max(60 * 1000, Number(process.env.ENFORCEMENT_GRACE_MS) || 24 * 60 * 60 * 1000);
const SCAN_MS = Math.max(30 * 1000, Number(process.env.ENFORCEMENT_SCAN_MS) || 5 * 60 * 1000);
const IP_BAN_MS = Math.max(60 * 60 * 1000, Number(process.env.ENFORCEMENT_IP_BAN_MS) || 7 * 24 * 60 * 60 * 1000);
const WARN_SCORE = Math.max(1, Number(process.env.ENFORCEMENT_WARN_SCORE) || 6);
const IP_ESCALATE_MIN = Math.max(1, Number(process.env.ENFORCEMENT_IP_ESCALATE_MIN) || 1);
const IP_ESCALATE_WINDOW_MS = Math.max(60 * 60 * 1000, Number(process.env.ENFORCEMENT_IP_ESCALATE_WINDOW_MS) || 24 * 60 * 60 * 1000);
const IP_BAN_REPEAT_MS = Math.max(IP_BAN_MS, Number(process.env.ENFORCEMENT_IP_BAN_REPEAT_MS) || 30 * 86400000);
const UA_RE = /Python-urllib|HeadlessChrome|curl\/|Go-http-client|python-requests/i;

function ensureSchema() {
  db.handle().exec(`
    CREATE TABLE IF NOT EXISTS account_watch (
      account_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'warned',
      score INTEGER NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '{}',
      warned_at INTEGER NOT NULL DEFAULT 0,
      warn_until INTEGER NOT NULL DEFAULT 0,
      evidence_at INTEGER NOT NULL DEFAULT 0,
      banned_at INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_account_watch_status ON account_watch(status, warn_until);
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip TEXT PRIMARY KEY,
      until INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      account_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_banned_ips_until ON banned_ips(until);
    CREATE TABLE IF NOT EXISTS enforcement_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '{}',
      ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
}
ensureSchema();

const now = () => Date.now();
function json(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function shortUa(value) {
  const ua = String(value || '');
  if (/Python-urllib/i.test(ua)) return 'Python-urllib（非游戏客户端）';
  if (/HeadlessChrome/i.test(ua)) return 'HeadlessChrome（无头浏览器）';
  if (/curl\//i.test(ua)) return 'curl（命令行客户端）';
  if (/Go-http-client/i.test(ua)) return 'Go-http-client（脚本客户端）';
  return ua.slice(0, 60);
}
function log(accountId, action, reason, evidence, ip) {
  db.run('INSERT INTO enforcement_log(account_id,action,reason,evidence,ip,created_at) VALUES (?,?,?,?,?,?)',
    Number(accountId), String(action), String(reason || ''), JSON.stringify(evidence || {}), String(ip || ''), now());
}
function excludedIds(at) {
  const ids = new Set();
  for (const r of db.all('SELECT account_id FROM dev_accounts')) ids.add(Number(r.account_id));
  for (const r of db.all('SELECT account_id FROM simulated_accounts')) ids.add(Number(r.account_id));
  for (const r of db.all('SELECT account_id FROM hidden_accounts WHERE hidden_until > ?', at)) ids.add(Number(r.account_id));
  return ids;
}
function writeWatch(accountId, risk, at) {
  const until = at + GRACE_MS;
  db.run(`INSERT INTO account_watch(account_id,status,score,reasons,evidence,warned_at,warn_until,evidence_at,banned_at,ban_reason,updated_at)
          VALUES (?,?,?,?,?,?,?,?,0,'',?)
          ON CONFLICT(account_id) DO UPDATE SET
            status='warned', score=excluded.score, reasons=excluded.reasons, evidence=excluded.evidence,
            warned_at=excluded.warned_at, warn_until=excluded.warn_until, evidence_at=excluded.evidence_at,
            banned_at=0, ban_reason='', updated_at=excluded.updated_at`,
    Number(accountId), 'warned', risk.score, JSON.stringify(risk.reasons), JSON.stringify(risk.evidence),
    at, until, risk.evidenceAt, at);
  log(accountId, 'warn', risk.reasons.join('；'), risk.evidence, '');
}
function clearWatch(accountId, at) {
  db.run('DELETE FROM account_watch WHERE account_id = ?', Number(accountId));
  log(accountId, 'clear', '观察期结束且未再出现脚本证据', {}, '');
}
function banText(risk) {
  const detail = (risk.reasons || []).slice(0, 4).join('；');
  return `自动封禁：检测到自动化脚本/多开行为（${detail}）。解封请加 QQ 群 ${QQ_GROUP} 联系群主。`;
}
function banAccount(accountId, risk, at) {
  const id = Number(accountId);
  const reason = banText(risk);
  const evidence = JSON.stringify(risk.evidence || {});
  const ips = db.all(`SELECT ip FROM account_ips WHERE account_id = ? AND ip <> ''
                      ORDER BY last_seen DESC, logins DESC LIMIT 3`, id);
  db.tx(() => {
    db.run('UPDATE accounts SET banned = 1, ban_reason = ? WHERE id = ?', reason, id);
    const sessions = db.all('SELECT token_hash FROM sessions WHERE account_id = ?', id);
    for (const s of sessions) {
      db.run('INSERT OR REPLACE INTO session_kicks(token_hash,account_id,reason,created_at) VALUES (?,?,?,?)',
        String(s.token_hash), id, 'banned', at);
    }
    db.run('DELETE FROM sessions WHERE account_id = ?', id);
    for (const row of ips) {
      const ip = String(row.ip || '');
      if (!ip || ip === '127.0.0.1' || ip === '::1') continue;
      db.run(`INSERT INTO banned_ips(ip,until,reason,account_id,created_at) VALUES (?,?,?,?,?)
              ON CONFLICT(ip) DO UPDATE SET until=excluded.until, reason=excluded.reason,
                account_id=excluded.account_id, created_at=excluded.created_at`,
        ip, at + IP_BAN_MS, reason, id, at);
    }
    db.run(`UPDATE account_watch SET status='banned', banned_at=?, ban_reason=?, evidence=?, updated_at=?
            WHERE account_id = ?`, at, reason, evidence, at, id);
    log(id, 'ban', reason, risk.evidence, ips.map((x) => x.ip).join(','));
  });
  return { accountId: id, reason, ips: ips.map((x) => x.ip) };
}

function evaluate(at) {
  const excluded = excludedIds(at);
  const uaRows = db.all(`SELECT account_id, ua, MAX(last_seen) last_seen FROM sessions
    WHERE expires_at > ? AND ua <> '' AND (ua LIKE '%Python-urllib%' OR ua LIKE '%HeadlessChrome%' OR ua LIKE '%curl/%' OR ua LIKE '%Go-http-client%')
    GROUP BY account_id`, at);
  const uaMap = new Map(uaRows.map((r) => [Number(r.account_id), r]));
  const devRows = db.all(`SELECT account_id, COUNT(*) total,
      SUM(CASE WHEN bound_at >= ? THEN 1 ELSE 0 END) d1h,
      SUM(CASE WHEN bound_at >= ? THEN 1 ELSE 0 END) d24h,
      MAX(bound_at) last_bound
    FROM account_devices GROUP BY account_id`, at - 3600000, at - 86400000);
  const devMap = new Map(devRows.map((r) => [Number(r.account_id), r]));
  const burstRows = db.all(`SELECT account_id, CAST(created_at / 1000 AS INTEGER) sec,
      COUNT(*) n, MAX(created_at) last
    FROM action_log WHERE created_at >= ?
    GROUP BY account_id, sec HAVING n >= 5`, at - 3600000);
  const burstMap = new Map();
  for (const r of burstRows) {
    const id = Number(r.account_id), cur = burstMap.get(id) || { count: 0, max: 0, last: 0 };
    cur.count++; cur.max = Math.max(cur.max, Number(r.n) || 0); cur.last = Math.max(cur.last, Number(r.last) || 0);
    burstMap.set(id, cur);
  }
  const accounts = db.all(`SELECT a.id,a.name,a.tag,a.banned FROM accounts a
    WHERE a.banned = 0 AND NOT EXISTS (SELECT 1 FROM dev_accounts d WHERE d.account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM simulated_accounts s WHERE s.account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM hidden_accounts h WHERE h.account_id=a.id AND h.hidden_until > ?)`, at);
  const out = [];
  for (const a of accounts) {
    const id = Number(a.id);
    if (excluded.has(id)) continue;
    const ua = uaMap.get(id), dev = devMap.get(id) || { total: 0, d1h: 0, d24h: 0, last_bound: 0 };
    const burst = burstMap.get(id);
    let score = 0; const reasons = []; let evidenceAt = 0;
    const evidence = {};
    if (ua) {
      score += 6;
      reasons.push('会话客户端为 ' + shortUa(ua.ua));
      evidenceAt = Math.max(evidenceAt, Number(ua.last_seen) || 0);
      evidence.ua = String(ua.ua).slice(0, 160);
    }
    if (Number(dev.total) > 20) {
      score += 6;
      reasons.push('累计绑定 ' + Number(dev.total) + ' 个设备标识（浏览器弱标识可被脚本批量生成）');
      evidenceAt = Math.max(evidenceAt, Number(dev.last_bound) || 0);
      evidence.devicesTotal = Number(dev.total);
    }
    if (Number(dev.d1h) >= 5 || Number(dev.d24h) >= 20) {
      score += 4;
      const n = Number(dev.d1h) >= 5 ? Number(dev.d1h) : Number(dev.d24h);
      reasons.push('过去 1 小时/24 小时新增 ' + n + ' 个设备绑定');
      evidenceAt = Math.max(evidenceAt, Number(dev.last_bound) || 0);
      evidence.devices1h = Number(dev.d1h); evidence.devices24h = Number(dev.d24h);
    }
    if (burst && burst.count) {
      score += 3;
      reasons.push('过去 1 小时出现 ' + burst.count + ' 个秒级批量操作（同一秒 ≥5 次）');
      evidenceAt = Math.max(evidenceAt, burst.last);
      evidence.bursts = burst.count; evidence.burstMax = burst.max;
    }
    if (score >= WARN_SCORE && reasons.length) out.push({ accountId: id, name: a.name, tag: a.tag, score, reasons, evidenceAt, evidence });
  }
  return out.sort((a, b) => b.score - a.score || a.accountId - b.accountId);
}

function escalateIps(at, dry, risks) {
  const out = [];
  const riskById = new Map((risks || []).map((r) => [Number(r.accountId), r]));
  const isLoopback = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || /^127\./.test(ip);
  const accountIps = new Map();
  const addIp = (id, ip) => {
    const value = String(ip || '').trim();
    if (!value || isLoopback(value)) return;
    if (!accountIps.has(id)) accountIps.set(id, new Set());
    accountIps.get(id).add(value);
  };
  for (const row of db.all("SELECT account_id, ip FROM account_ips WHERE ip <> ''")) addIp(Number(row.account_id), row.ip);
  const allAccounts = db.all('SELECT id, name, created_at, reg_at, reg_ip, ip, banned FROM accounts');
  for (const a of allAccounts) { addIp(Number(a.id), a.reg_ip); addIp(Number(a.id), a.ip); }
  const banned = db.all(`SELECT a.id, a.name, a.reg_at, a.created_at, w.banned_at, w.warned_at, w.ban_reason
    FROM accounts a LEFT JOIN account_watch w ON w.account_id = a.id
    WHERE a.banned = 1`);
  const byIp = new Map();
  for (const a of banned) {
    const id = Number(a.id);
    const marks = [Number(a.banned_at) || 0, Number(a.warned_at) || 0].filter((t) => t > 0);
    const firstAt = marks.length ? Math.min(...marks) : (Number(a.reg_at) || Number(a.created_at) || 0);
    if (!firstAt) continue;
    for (const ip of (accountIps.get(id) || [])) {
      const cur = byIp.get(ip) || { ip, count: 0, firstAt, ids: [] };
      cur.count++;
      cur.firstAt = Math.min(cur.firstAt, firstAt);
      cur.ids.push(id);
      byIp.set(ip, cur);
    }
  }
  for (const [ip, info] of byIp) {
    const prior = db.get('SELECT until FROM banned_ips WHERE ip = ?', ip);
    if (prior && Number(prior.until) > at) continue; // 已经在封，不反复续期
    const newAccounts = [];
    for (const a of allAccounts) {
      if (Number(a.banned)) continue;
      const created = Math.max(Number(a.created_at) || 0, Number(a.reg_at) || 0);
      if (created <= info.firstAt || created < at - IP_ESCALATE_WINDOW_MS) continue;
      if ((accountIps.get(Number(a.id)) || new Set()).has(ip)) newAccounts.push(Number(a.id));
    }
    const scriptIds = newAccounts.filter((id) => riskById.has(id));
    if (!scriptIds.length || scriptIds.length < IP_ESCALATE_MIN) continue;
    const until = at + (prior ? IP_BAN_REPEAT_MS : IP_BAN_MS);
    const days = Math.max(1, Math.round((until - at) / 86400000));
    const reason = '关联账号被警告/封禁后同一 IP 继续注册脚本账号：新注册 ' + newAccounts.length +
      ' 个，其中 ' + scriptIds.length + ' 个命中脚本证据；封禁 ' + days + ' 天。解封请加 QQ 群 ' + QQ_GROUP + ' 联系群主。';
    const evidence = { bannedAccounts: info.count, firstBanAt: info.firstAt, newAccounts, scriptAccounts: scriptIds, ip };
    if (dry) { out.push({ ip, reason, evidence, dry: true }); continue; }
    db.run(`INSERT INTO banned_ips(ip,until,reason,account_id,created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(ip) DO UPDATE SET until=excluded.until, reason=excluded.reason,
              account_id=excluded.account_id, created_at=excluded.created_at`,
      ip, until, reason, info.ids[0] || 0, at);
    log(0, 'ban_ip', reason, evidence, ip);
    out.push({ ip, until, reason, evidence });
  }
  return out;
}

function scan(opts) {
  const at = now();
  const dry = !!(opts && opts.dry) || DRY_RUN;
  const risks = evaluate(at);
  const byId = new Map(risks.map((r) => [r.accountId, r]));
  const watches = new Map(db.all('SELECT * FROM account_watch').map((r) => [Number(r.account_id), r]));
  const result = { at, candidates: risks, warned: [], banned: [], cleared: [], ipBanned: [], dry };
  const all = new Set([...byId.keys(), ...watches.keys()]);
  for (const id of all) {
    const risk = byId.get(id);
    const w = watches.get(id);
    if (w && w.status === 'banned') continue;
    if (w && w.status === 'warned') {
      const warnedAt = Number(w.warned_at) || 0;
      if (at >= Number(w.warn_until)) {
        // 24h 观察期结束：期间又出现脚本证据才封；完全停了就清掉警告。
        const newEvidence = !!risk && risk.score >= WARN_SCORE && risk.evidenceAt > warnedAt + 60 * 1000;
        if (newEvidence) result.banned.push(dry ? { accountId: id, dry: true, risk } : banAccount(id, risk, at));
        else if (!dry) { clearWatch(id, at); result.cleared.push(id); }
        else result.cleared.push(id);
      }
      continue;
    }
    if (risk && risk.score >= WARN_SCORE) {
      if (!dry) { writeWatch(id, risk, at); result.warned.push({ accountId: id, score: risk.score, reasons: risk.reasons }); }
      else result.warned.push({ accountId: id, score: risk.score, reasons: risk.reasons, dry: true });
    }
  }
  result.ipBanned = escalateIps(at, dry, risks);
  // 先算升级再清理过期行，过期 IP 的再次违规才能按“重复”延长。
  if (!dry) db.run('DELETE FROM banned_ips WHERE until <= ?', at);
  return result;
}

function statusFor(accountId) {
  const id = Number(accountId);
  if (!id) return null;
  const account = db.get('SELECT banned, ban_reason FROM accounts WHERE id = ?', id);
  const w = db.get('SELECT * FROM account_watch WHERE account_id = ?', id);
  if (account && Number(account.banned)) {
    const until = db.get('SELECT MAX(until) until FROM banned_ips WHERE account_id = ?', id);
    return { status: 'banned', reason: String((w && w.ban_reason) || account.ban_reason || '违规'), qq: QQ_GROUP, until: Number(until && until.until) || 0 };
  }
  if (!w || w.status !== 'warned') return null;
  if (Number(w.warn_until) <= now()) return null;
  return {
    status: 'warned', score: Number(w.score), reasons: json(w.reasons, []), qq: QQ_GROUP,
    warnedAt: Number(w.warned_at), warnUntil: Number(w.warn_until),
    graceHours: Math.round(GRACE_MS / 3600000), ipBanDays: Math.round(IP_BAN_MS / 86400000),
  };
}
function ipBanFor(ip) {
  const value = String(ip || '');
  if (!value) return null;
  const row = db.get('SELECT ip,until,reason FROM banned_ips WHERE ip = ? AND until > ?', value, now());
  return row ? { status: 'banned', ip: value, until: Number(row.until), reason: String(row.reason || ''), qq: QQ_GROUP } : null;
}
function banExtra(ban) {
  if (!ban) return null;
  return { ban: { status: ban.status || 'banned', reason: String(ban.reason || '违规'), until: Number(ban.until) || 0, qq: QQ_GROUP, ip: ban.ip || '' } };
}

function warnAccount(accountId, score, reasons, evidence) {
  const at = now();
  const list = (Array.isArray(reasons) ? reasons : [reasons]).map((x) => String(x || '').trim()).filter(Boolean);
  writeWatch(Number(accountId), {
    score: Math.max(1, Number(score) || WARN_SCORE),
    reasons: list.length ? list : ['人工风险警告'],
    evidence: evidence && typeof evidence === 'object' ? evidence : {},
    evidenceAt: at,
  }, at);
  log(accountId, 'warn_manual', list.join('；'), evidence || {}, '');
  return statusFor(accountId);
}

function alerts(accountId) {
  const status = statusFor(accountId);
  return status ? [status] : [];
}

function health() {
  const at = now();
  const count = (sql, ...args) => Number((db.get(sql, ...args) || {}).n) || 0;
  return {
    enabled: ENABLED,
    dryRun: DRY_RUN,
    warned: count("SELECT COUNT(*) n FROM account_watch WHERE status = 'warned' AND warn_until > ?", at),
    banned: count('SELECT COUNT(*) n FROM accounts WHERE banned = 1'),
    bannedIps: count('SELECT COUNT(*) n FROM banned_ips WHERE until > ?', at),
  };
}

let timer = null;
function startScheduler() {
  if (!ENABLED || timer) return;
  const run = () => { try { const r = scan(); if (r.warned.length || r.banned.length || r.ipBanned.length) console.log('[enforcement] warn=' + r.warned.length + ' ban=' + r.banned.length + ' ip=' + r.ipBanned.length); } catch (e) { console.error('[enforcement] scan failed', e && e.message); } };
  timer = setInterval(run, SCAN_MS);
  timer.unref();
  const boot = setTimeout(run, 5000);
  if (boot.unref) boot.unref();
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  QQ_GROUP, GRACE_MS, IP_BAN_MS, IP_ESCALATE_MIN, IP_ESCALATE_WINDOW_MS, IP_BAN_REPEAT_MS, WARN_SCORE, evaluate, scan, escalateIps, statusFor, ipBanFor, banExtra,
  startScheduler, stopScheduler, banAccount, warnAccount, clearWatch, alerts, health,
};
