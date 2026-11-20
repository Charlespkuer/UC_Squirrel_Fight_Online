'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { config } = require('./config');
const { fail } = require('./http');

const PROVIDERS = { windows: 'machine-guid', android: 'android-id', ios: 'keychain' };
let writes = 0;

function fromRequest(req) {
  const h = req.headers || {}, id = h['x-device-id'], platform = h['x-device-platform'], provider = h['x-device-provider'];
  if (!id || !platform || !provider) throw fail('DEVICE_REQUIRED', '请更新原生客户端并重新登录（缺少设备标识）');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(id)
    || typeof platform !== 'string' || !['windows', 'android', 'ios', 'browser'].includes(platform)
    || typeof provider !== 'string' || !['machine-guid', 'android-id', 'keychain', 'installation'].includes(provider)) {
    throw fail('DEVICE_UNSUPPORTED', '设备标识格式不受支持，请更新客户端');
  }
  const weak = platform === 'browser' || provider === 'installation';
  // 安卓客户端在 ANDROID_ID 不可用时退回本安装随机标识：仍按原生设备处理，
  // 不能因为服务端关了浏览器设备就把它一起拒绝（否则那批玩家无法登录）。
  const nativeFallback = platform === 'android' && provider === 'installation';
  const hash = crypto.createHash('sha256').update(platform + '\0' + id).digest('hex');

  const creator = config.creatorDevices.includes(hash);
  if (!creator && ((platform === 'browser' && provider !== 'installation')
    || (!weak && PROVIDERS[platform] !== provider) || (weak && !config.allowBrowserDevices && !nativeFallback))) {
    throw fail('DEVICE_UNSUPPORTED', '请使用新版原生客户端登录，此服务器不接受浏览器安装标识');
  }
  return { hash, platform, provider, weak, creator };
}

function audit(event, outcome, { accountId, device, ip, reason } = {}) {
  const owner = accountId && db.get('SELECT id FROM accounts WHERE id = ?', Number(accountId));
  db.run('INSERT INTO security_events(event,outcome,account_id,device_hash,ip,reason,created_at) VALUES (?,?,?,?,?,?,?)',
    event, outcome, owner ? Number(accountId) : null, device ? device.hash : '', String(ip || ''), String(reason || ''), Date.now());
  if (++writes % 100 === 0) db.run('DELETE FROM security_events WHERE created_at < ?', Date.now() - config.securityRetentionDays * 86400000);
}

function bind(accountId, device, ip) {
  const id = Number(accountId), ts = Date.now();
  if (device.creator) {

    const own = db.get('SELECT account_id FROM account_devices WHERE device_hash = ? AND account_id = ?', device.hash, id);
    if (own) db.run('UPDATE account_devices SET last_seen = ?, last_ip = ? WHERE device_hash = ? AND account_id = ?',
      ts, String(ip || ''), device.hash, id);
    return;
  }
  const own = db.get('SELECT account_id FROM account_devices WHERE device_hash = ? AND account_id = ?', device.hash, id);
  if (own) {
    db.run('UPDATE account_devices SET last_seen = ?, last_ip = ? WHERE device_hash = ? AND account_id = ?',
      ts, String(ip || ''), device.hash, id);
    return;
  }
  // 登录已有账号不占“创建额度”，所以这里只登记设备-账号关系，不再拦 DEVICE_BOUND；
  // 注册时的 3 账号上限在 `server/api/account.js` 按 accounts.reg_device_hash 统计。
  db.run('INSERT OR IGNORE INTO account_devices(device_hash,account_id,platform,provider,weak,bound_at,last_seen,last_ip) VALUES (?,?,?,?,?,?,?,?)',
    device.hash, id, device.platform, device.provider, device.weak ? 1 : 0, ts, ts, String(ip || ''));
  audit('device_bind', 'ok', { accountId: id, device, ip });
}

function observeIp(accountId, device, ip, login) {
  const id = Number(accountId), ts = Date.now();
  const account = db.get('SELECT ip FROM accounts WHERE id = ?', id);
  if (!account) return;
  if (account.ip && account.ip !== ip) audit('ip_change', 'ok', { accountId: id, device, ip });
  db.run(`INSERT INTO account_ips(account_id,ip,first_seen,last_seen,logins) VALUES (?,?,?,?,?)
    ON CONFLICT(account_id,ip) DO UPDATE SET last_seen=excluded.last_seen,logins=logins+excluded.logins`,
    id, String(ip || ''), ts, ts, login ? 1 : 0);
  db.run('UPDATE accounts SET ip = ? WHERE id = ?', String(ip || ''), id);
}

const PLATFORM_LABEL = { windows: 'Windows', android: 'Android', ios: 'iOS', browser: '浏览器' };

function whenText(ms) {
  const d = new Date(Number(ms) || Date.now());
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (_) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function knownLogin(accountId, device, ip) {
  const id = Number(accountId);
  const d = device || {};
  const hash = String(d.hash || '');
  const nextIp = String(ip || '');
  const account = db.get('SELECT reg_ip, reg_device_hash FROM accounts WHERE id = ?', id);
  const deviceRow = hash ? db.get('SELECT 1 AS x FROM account_devices WHERE account_id = ? AND device_hash = ?', id, hash) : null;
  const ipRow = nextIp ? db.get('SELECT 1 AS x FROM account_ips WHERE account_id = ? AND ip = ?', id, nextIp) : null;
  return {
    device: !!(deviceRow || (account && account.reg_device_hash && String(account.reg_device_hash) === hash)),
    ip: !!(ipRow || (account && account.reg_ip && String(account.reg_ip) === nextIp)),
  };
}

// 新设备/新地点登录：写一条未读的 `login_alert` 消息，客户端登录后弹一次。
function alertLogin(accountId, device, ip, flags) {
  const f = flags || {};
  if (!f.newDevice && !f.newIp) return null;
  const d = device || {};
  const id = 'm_' + crypto.randomBytes(10).toString('base64url');
  const where = [];
  if (f.newDevice) where.push('新设备（' + (PLATFORM_LABEL[d.platform] || d.platform || '未知设备') + '）');
  if (f.newIp) where.push('新地点' + (ip ? '（IP ' + String(ip).slice(0, 64) + '）' : ''));
  if (!where.length) return null;
  const text = '安全提醒：你的账号于 ' + whenText() + ' 在' + where.join('、') +
    '登录。如非本人操作，请立即修改密码。';
  const payload = {
    kind: 'login_alert', newDevice: !!f.newDevice, newIp: !!f.newIp,
    platform: String(d.platform || ''), provider: String(d.provider || ''),
    deviceHash: String(d.hash || '').slice(0, 12), ip: String(ip || ''), at: Date.now(),
  };
  db.run(
    'INSERT INTO messages (id, account_id, kind, text, payload, created_at) VALUES (?,?,?,?,?,?)',
    id, Number(accountId), 'login_alert', text, JSON.stringify(payload), Date.now()
  );
  audit('login_alert', 'ok', {
    accountId, device, ip,
    reason: [f.newDevice ? 'new_device' : '', f.newIp ? 'new_ip' : ''].filter(Boolean).join(','),
  });
  return { id, text, payload };
}

function unreadAlerts(accountId) {
  const rows = db.all(
    `SELECT id, text, payload, created_at FROM messages
      WHERE account_id = ? AND kind = 'login_alert' AND read_at IS NULL
      ORDER BY created_at DESC LIMIT 5`,
    Number(accountId)
  );
  return rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
    return { id: String(row.id), text: String(row.text || ''), payload, createdAt: Number(row.created_at) };
  });
}

// 现在只在「会话没有设备绑定（旧令牌迁移）」或「IP 真的变了」时写；
const IP_REFRESH_MS = 6 * 60 * 60 * 1000;
const ipSeen = new Map();

function shouldRefreshIp(accountId, ip, ts) {
  const id = Number(accountId);
  const rec = ipSeen.get(id);
  const refresh = !rec || rec.ip !== ip || ts - rec.at >= IP_REFRESH_MS;
  if (refresh) ipSeen.set(id, { ip, at: ts });
  while (ipSeen.size > 10000) ipSeen.delete(ipSeen.keys().next().value);
  return refresh;
}

// · 新设备未绑定任何账号 → 绑定到当前账号并发一条登录提醒；
// 旧会话（没有 device_hash）仍按「迁移到当前设备」处理。
function authorize(req, session, account, ip) {
  let device;
  try {
    device = fromRequest(req);
    const id = Number(account.id);
    const ts = Date.now();
    const currentIp = String(account.ip || '');
    const nextIp = String(ip || '');
    const legacy = !session.device_hash;
    const deviceChanged = !!session.device_hash && session.device_hash !== device.hash;
    const ipChanged = currentIp !== nextIp;
    const seenIp = ipChanged && (!!db.get('SELECT 1 AS x FROM account_ips WHERE account_id = ? AND ip = ?', id, nextIp)
      || String(account.reg_ip || '') === nextIp);
    const refreshIp = !legacy && !deviceChanged && !ipChanged && shouldRefreshIp(id, nextIp, ts);
    if (!legacy && !deviceChanged && !ipChanged && !refreshIp) return device;

    let alert = null;
    db.tx(() => {
      if (legacy || deviceChanged) {
        const own = db.get('SELECT 1 AS x FROM account_devices WHERE device_hash = ? AND account_id = ?', device.hash, id);
        if (!own) {
          bind(id, device, ip);
          alert = { newDevice: true, newIp: false };
        }
        db.run('UPDATE sessions SET device_hash = ? WHERE token_hash = ?', device.hash, session.token_hash);
        session.device_hash = device.hash;
        if (legacy) audit('session_migrate', 'ok', { accountId: id, device, ip });
      }
      if (ipChanged) {
        observeIp(id, device, ip, false);

        if (!seenIp) {
          alert = alert || { newDevice: false, newIp: false };
          alert.newIp = true;
        }
      } else if (refreshIp) {
        db.run('UPDATE account_ips SET last_seen = ? WHERE account_id = ? AND ip = ?', ts, id, nextIp);
      }
      if (alert) alertLogin(id, device, ip, alert);
    });
    return device;
  } catch (e) {
    audit('session', 'denied', { accountId: account.id, device, ip, reason: e.code || 'SERVER' });
    throw e;
  }
}

function policy() {
  return {
    version: 3,
    required: true,
    allowBrowserDevices: config.allowBrowserDevices,
    nativeRequired: !config.allowBrowserDevices,
    androidInstallation: true,

    crossDeviceLogin: 'allowed-with-alert',
    oneAccountPerDevice: false,
    accountsPerDevice: config.accountsPerDevice,
    accountsPerIp: config.accountsPerIp,
    singleSessionPerAccount: true,
  };
}

module.exports = { fromRequest, bind, authorize, observeIp, knownLogin, alertLogin, unreadAlerts, audit, policy };
