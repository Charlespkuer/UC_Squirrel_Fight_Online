'use strict';
// Device headers are client claims, not hardware attestation. Store only hashes.
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
  const hash = crypto.createHash('sha256').update(platform + '\0' + id).digest('hex');
  /* 创作者设备（服务器主人）：允许浏览器/安装标识，也允许一个设备持多个测试号。
   * 只按设备指纹认，不按 IP —— IP 会被 NAT/动态地址影响，无法保证“只有我的设备”。 */
  const creator = config.creatorDevices.includes(hash);
  if (!creator && ((platform === 'browser' && provider !== 'installation')
    || (!weak && PROVIDERS[platform] !== provider) || (weak && !config.allowBrowserDevices))) {
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
    /* 创作者设备允许“一台设备多个测试号”：不抢绑、不报 DEVICE_BOUND；
     * 如果这个账号原本就绑在这台设备上，照常刷新 last_seen / last_ip。 */
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
  /* 登录已有账号不占“创建额度”，所以这里只登记设备-账号关系，不再拦 DEVICE_BOUND；
   * 注册时的 3 账号上限在 `server/api/account.js` 按 accounts.reg_device_hash 统计。 */
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

/** 登录前查：这台设备 / 这个 IP 以前是否在这个账号上出现过。
 *  `accounts.reg_*` 是不会被保留期清掉的注册锚点；历史表用来判断“最近是否见过”。 */
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

/** 新设备/新地点登录：写一条未读的 `login_alert` 消息，客户端登录后弹一次。
 *  这里只提醒，不阻止登录；同一台设备/同一个 IP 第二次不会重复提醒。 */
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

/** 未读登录提醒（给 /api/state 随登录一起下发）。 */
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

/* `authorize()` 在**每个已登录请求**上都会跑。以前它无条件做三组写入：
 *  · account_devices.last_seen / last_ip（每次请求）
 *  · account_ips 的 upsert（每次请求）
 *  · accounts.ip（每次请求）
 * 设备绑定在登录时已经验证过，IP 也不该因为「同一个 IP 发了两条请求」而反复落库。
 * 现在只在「会话没有设备绑定（旧令牌迁移）」或「IP 真的变了」时写；
 * 同一 IP 的 `last_seen` 最多 6 小时刷新一次，保留审计价值但不再放大 WAL。 */
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

/** 会话校验 + 设备迁移。规则（2026-11 用户口径）：
 *  · 同一账号可以在新手机/新网络登录，不再返回 DEVICE_MISMATCH；
 *  · 新设备未绑定任何账号 → 绑定到当前账号并发一条登录提醒；
 *  · 同一设备可以登录多个账号（注册额度由 api/account.js 按 3 个/设备、3 个/IP 限制）；
 *  · IP 变化只提醒，不阻止。
 * 旧会话（没有 device_hash）仍按「迁移到当前设备」处理。 */
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
        /* 只对「这个账号从没见过的 IP」提醒；同一地点网络抖动不反复弹。 */
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
    version: 2,
    required: true,
    allowBrowserDevices: config.allowBrowserDevices,
    nativeRequired: !config.allowBrowserDevices,
    /* 2026-11：账号可跨设备/跨网络登录；同一设备最多创建 3 个账号。 */
    crossDeviceLogin: 'allowed-with-alert',
    oneAccountPerDevice: false,
    accountsPerDevice: config.accountsPerDevice,
    accountsPerIp: config.accountsPerIp,
    singleSessionPerAccount: true,
  };
}

module.exports = { fromRequest, bind, authorize, observeIp, knownLogin, alertLogin, unreadAlerts, audit, policy };
