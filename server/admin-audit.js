#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

function options(args) {
  const out = { days: 7, limit: 30, ip: '', account: '' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    if (!['--days', '--limit', '--ip', '--account'].includes(key) || i + 1 >= args.length) throw new Error('Unknown or incomplete option: ' + key);
    out[key.slice(2)] = args[++i];
  }
  for (const [key, max] of [['days', 3650], ['limit', 500]]) {
    out[key] = Number(out[key]);
    if (!Number.isInteger(out[key]) || out[key] < 1 || out[key] > max) throw new Error('Invalid --' + key);
  }
  if (out.ip && !net.isIP(out.ip)) throw new Error('Invalid --ip');
  if (out.account.length > 32) throw new Error('Invalid --account');
  return out;
}

function report(handle, o) {
  const cutoff = Date.now() - o.days * 86400000, where = ['e.created_at >= ?'], params = [cutoff];
  const all = (sql, values = []) => handle.prepare(sql).all(...values);
  if (o.ip) { where.push('e.ip = ?'); params.push(o.ip); }
  if (o.account) { where.push("(CAST(a.id AS TEXT) = ? OR a.name || '#' || a.tag = ?)"); params.push(o.account, o.account); }
  const from = 'FROM security_events e LEFT JOIN accounts a ON a.id = e.account_id WHERE ' + where.join(' AND ');

  let devRows = [];
  try { devRows = all('SELECT account_id,label,note,created_at FROM dev_accounts ORDER BY created_at DESC'); } catch (_) {}
  const devMap = new Map(devRows.map((r) => [Number(r.account_id), String(r.label || 'dev')]));
  const withDev = (rows) => rows.map((r) => Object.assign({}, r, { dev: devMap.get(Number(r.accountId)) || null }));
  // 注册设备/IP 是独立留档字段（v12）；老库还没迁移时不要让整个审计失败。
  let registrations = [];
  try {
    registrations = all(`SELECT a.id AS accountId, a.name || '#' || a.tag AS account,
        a.reg_ip AS regIp, substr(a.reg_device_hash,1,12) AS fingerprint,
        a.reg_platform AS platform, a.reg_provider AS provider, a.reg_at AS regAt
      FROM accounts a WHERE a.reg_at >= ?
      ${o.ip ? 'AND a.reg_ip = ?' : ''}
      ${o.account ? "AND (CAST(a.id AS TEXT)=? OR a.name || '#' || a.tag=?)" : ''}
      ORDER BY a.reg_at DESC LIMIT ?`,
      [cutoff, ...(o.ip ? [o.ip] : []), ...(o.account ? [o.account, o.account] : []), o.limit]);
  } catch (_) { registrations = []; }
  return {
    days: o.days,
    policy: { deviceProtocol: 3, allowBrowserDevices: config.allowBrowserDevices, securityRetentionDays: config.securityRetentionDays },
    devAccounts: devRows.map((r) => ({ accountId: Number(r.account_id), label: String(r.label || ''), note: String(r.note || ''), createdAt: Number(r.created_at) })),
    registrations,
    summary: all('SELECT e.event,e.outcome,COUNT(*) AS count,COUNT(DISTINCT e.ip) AS ips,COUNT(DISTINCT e.account_id) AS accounts ' + from + ' GROUP BY e.event,e.outcome ORDER BY e.event,e.outcome', params),
    sharedIps: all(`SELECT ip,COUNT(DISTINCT account_id) AS accounts,MAX(last_seen) AS lastSeen
      FROM account_ips WHERE last_seen >= ? ${o.ip ? 'AND ip = ?' : ''}
      GROUP BY ip HAVING COUNT(DISTINCT account_id) > 1 ORDER BY accounts DESC,lastSeen DESC LIMIT ?`,
    [cutoff, ...(o.ip ? [o.ip] : []), o.limit]),
    accountIps: withDev(all(`SELECT p.account_id AS accountId,a.name || '#' || a.tag AS account,p.ip,p.first_seen AS firstSeen,p.last_seen AS lastSeen,p.logins,
      (SELECT COUNT(*) FROM account_devices d WHERE d.account_id=a.id) AS devices
      FROM account_ips p JOIN accounts a ON a.id=p.account_id WHERE p.last_seen >= ?
      ${o.ip ? 'AND p.ip = ?' : ''} ${o.account ? "AND (CAST(a.id AS TEXT)=? OR a.name || '#' || a.tag=?)" : ''}
      ORDER BY p.last_seen DESC LIMIT ?`, [cutoff, ...(o.ip ? [o.ip] : []), ...(o.account ? [o.account, o.account] : []), o.limit])),
    devices: withDev(all(`SELECT d.account_id AS accountId,a.name || '#' || a.tag AS account,substr(d.device_hash,1,12) AS fingerprint,
      d.platform,d.provider,d.weak,d.bound_at AS boundAt,d.last_seen AS lastSeen,d.last_ip AS lastIp
      FROM account_devices d JOIN accounts a ON a.id=d.account_id WHERE d.last_seen >= ?
      ${o.ip ? 'AND d.last_ip = ?' : ''} ${o.account ? "AND (CAST(a.id AS TEXT)=? OR a.name || '#' || a.tag=?)" : ''}
      ORDER BY d.last_seen DESC LIMIT ?`, [cutoff, ...(o.ip ? [o.ip] : []), ...(o.account ? [o.account, o.account] : []), o.limit])),
    events: withDev(all("SELECT e.id,e.event,e.outcome,e.account_id AS accountId,a.name || '#' || a.tag AS account,substr(e.device_hash,1,12) AS fingerprint,e.ip,e.reason,e.created_at AS at "
      + from + ' ORDER BY e.id DESC LIMIT ?', [...params, o.limit])),
  };
}

function main(args) {
  const o = options(args);
  if (o.help) { console.log('node server/admin-audit.js [--days 7] [--limit 30] [--ip ADDRESS] [--account ID|NAME#TAG]'); return; }
  const file = path.join(config.dataDir, 'ssdz.db');
  if (!fs.existsSync(file)) throw new Error('No existing server database at ' + file);
  const handle = new DatabaseSync(file, { readOnly: true });
  try { console.log(JSON.stringify(report(handle, o), null, 2)); } finally { handle.close(); }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('[admin-audit] ' + e.message); process.exitCode = 1; }
}
module.exports = { report, options };
