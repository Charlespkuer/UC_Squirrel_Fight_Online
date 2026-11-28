'use strict';
// server/auth.js — 账号、密码、会话
// 但必须在 TLS 后面，见 docs/服务器与部署.md。

const crypto = require('node:crypto');
const db = require('./db');
const devices = require('./device');
const dev = require('./dev');
const battle = require('./game/battle');
const enforcement = require('./game/enforcement');
const forum = require('./game/forum');
const nickname = require('../js/nickname');
const { clientIp } = require('./http');
const { config } = require('./config');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_BYTES = 32;

function now() { return Date.now(); }

function scryptHash(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
}

function bannedError(reason, extra) {
  const e = new Error(reason || '账号已被封禁');
  e.code = 'FORBIDDEN';
  if (extra) e.extra = enforcement.banExtra(extra);
  return e;
}
function blockedIpError(ban) {
  return bannedError('此网络因关联账号违规已被封禁。解封请加 QQ 群 ' + enforcement.QQ_GROUP + ' 联系群主。', ban);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 名字校验：最多 7 个汉字（英文/数字按 1/3 个汉字计，最多 21 个），
function normalizeName(raw) {
  const out = nickname.check(raw);
  if (!out.ok) throw Object.assign(new Error(out.reason), { code: 'BAD_REQUEST' });
  return out.name;
}

// 登录键里的纯数字会先按账号编号 / 玩家号解析（见 findAccount），所以昵称与这两类编号必须互斥：
// 纯数字昵称不能等于已有编号；新分配的编号也要跳过已有昵称。前导 0 也要拦，否则 "0682" 与 682 同键。
function numericNameConflict(name) {
  const text = String(name == null ? '' : name);
  if (!/^\d+$/.test(text)) return '';
  if (text.length > 1 && text.charAt(0) === '0') return '纯数字昵称不能以 0 开头';
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return '';
  if (db.get('SELECT 1 AS x FROM accounts WHERE id = ?', value)) return '这个昵称和账号编号重复了，换一个吧';
  if (db.get('SELECT 1 AS x FROM player_ids WHERE player_id = ?', value)) return '这个昵称和玩家号重复了，换一个吧';
  return '';
}

function nameTaken(name) {
  return !!db.get('SELECT 1 AS x FROM accounts WHERE name = ? COLLATE NOCASE LIMIT 1', String(name))
    || !!numericNameConflict(name);
}

function nameAvailable(raw) {
  let name = '';
  try { name = normalizeName(raw); }
  catch (e) { return { available: false, name: '', taken: [], reason: e.message }; }
  const rows = db.all('SELECT tag FROM accounts WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 5', name);
  const conflict = rows.length ? '' : numericNameConflict(name);
  return {
    available: rows.length === 0 && !conflict, name,
    taken: rows.map((r) => String(r.tag)),
    reason: rows.length ? '这个昵称已经被占用了' : conflict,
  };
}

// 新账号 id / 玩家号：从 sqlite_sequence 与 MAX 之后取，跳过任何与昵称同号的数字（含自己的昵称）。
function nextNumber(table, column, floor, name) {
  const seq = db.get('SELECT seq FROM sqlite_sequence WHERE name = ?', table);
  const max = db.get('SELECT MAX(' + column + ') AS m FROM ' + table);
  let next = Math.max(Number(seq && seq.seq) || 0, Number(max && max.m) || 0, Number(floor) - 1) + 1;
  const wanted = String(name == null ? '' : name).toLowerCase();
  for (let i = 0; i < 1000; i++, next++) {
    const text = String(next);
    if (text.toLowerCase() === wanted) continue;
    if (db.get('SELECT 1 AS x FROM accounts WHERE name = ? COLLATE NOCASE', text)) continue;
    return next;
  }
  throw Object.assign(new Error('编号分配失败，请稍后再试'), { code: 'SERVER' });
}

function normalizePassword(raw) {
  const pass = String(raw == null ? '' : raw);
  const length = [...pass].length;
  if (length < 6) throw Object.assign(new Error('密码至少 6 位'), { code: 'BAD_REQUEST' });
  if (length > 128) throw Object.assign(new Error('密码太长'), { code: 'BAD_REQUEST' });

  if (!/[A-Za-z]/.test(pass) || !/[0-9]/.test(pass)) {
    throw Object.assign(new Error('密码必须同时包含字母和数字'), { code: 'BAD_REQUEST' });
  }
  return pass;
}

function newTag() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function newRecoveryCode() {

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

function publicAccount(row) {
  if (!row) return null;
  // 论坛管理员在资料里带一个只读标识；顺便幂等补齐默认词/创始管理员。
  // bootstrap 内部有 meta 标记，正常路径只多一次索引查询。
  forum.bootstrap();
  const forumRole = forum.roleOf(row.id);
  return {
    accountId: Number(row.id),
    playerId: Number((db.get('SELECT player_id FROM player_ids WHERE account_id = ?', Number(row.id)) || {}).player_id || 0),
    name: String(row.name),
    tag: String(row.tag),
    // 昵称已全服唯一（2026-11）：显示名不再拼 #tag；tag 仍保留给老存档/旧输入兼容。
    display: String(row.name),
    createdAt: Number(row.created_at),
    banned:!!Number(row.banned),
    // 开发者测试账号：由服务端 dev_accounts 登记册决定，客户端只读。
    dev: dev.isDev(row.id),
    // 论坛身份：客户端据此显示「管理员」徽标与「管理」入口；写操作仍由服务端复核。
    forumRole,
    forumAdmin: !!forumRole,
  };
}

function findAccount(key) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = db.get('SELECT a.* FROM accounts a JOIN player_ids p ON p.account_id=a.id WHERE p.player_id=?', Number(raw)) ||
      (Number(raw) < 100000 ? db.get('SELECT * FROM accounts WHERE id = ?', Number(raw)) : null);
    if (byId) return byId;
  }
  const m = raw.match(/^(.*)#(\d{1,4})$/);
  if (m) {
    return db.get('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE AND tag = ?', m[1].trim(), m[2].padStart(4, '0')) || null;
  }
  const rows = db.all('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 2', raw);
  return rows.length === 1 ? rows[0] : null;
}

function findAccountStrict(key) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return db.get('SELECT a.* FROM accounts a JOIN player_ids p ON p.account_id=a.id WHERE p.player_id=?', Number(raw)) || null;
  const m = raw.match(/^(.*)#(\d{1,4})$/);
  if (m) return db.get('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE AND tag = ?', m[1].trim(), m[2].padStart(4, '0')) || null;
  // 昵称已全服唯一，纯昵称就是合法查找键；老账号里若还有历史重名，
  // 这里会拿到 2 行并返回 null，仍要求用旧格式「名字#编号」区分。
  const rows = db.all('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 2', raw);
  return rows.length === 1 ? rows[0] : null;
}

// 注册：昵称全服唯一（大小写不敏感；老账号的历史重名不追改，新注册不再产生）。
// tag 仍保留，社交搜索/旧输入「名字#编号」继续兼容，但界面显示只用昵称。
function register({ name, password, ip, device }) {
  const blocked = enforcement.ipBanFor(ip);
  if (blocked) throw blockedIpError(blocked);
  const cleanName = normalizeName(name);
  const pass = normalizePassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(pass, salt);
  const recovery = newRecoveryCode();
  const recoveryHash = sha256(recovery);
  const ts = now();
  return db.tx(() => {
    const conflict = numericNameConflict(cleanName);
    if (conflict || nameTaken(cleanName)) {
      throw Object.assign(new Error(conflict || '这个昵称已经被占用了，换一个吧'), { code: 'CONFLICT' });
    }
    // tag 只在同名里唯一；最多试 40 次，避免 09xx 段被占满时死循环。
    let tag = null;
    for (let i = 0; i < 40; i++) {
      const candidate = i === 0 ? newTag() : String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const dup = db.get('SELECT 1 AS x FROM accounts WHERE name = ? AND tag = ?', cleanName, candidate);
      if (!dup) { tag = candidate; break; }
    }
    if (!tag) tag = String(db.get('SELECT COUNT(*) AS c FROM accounts WHERE name = ?', cleanName).c + 1).padStart(4, '0');
    // 显式分配 id / 玩家号（跳过多余数字），不再依赖 AUTOINCREMENT 的下一号。
    const id = nextNumber('accounts', 'id', 1, cleanName);
    // findAccount 只把 100000 以下的纯数字当账号 id；超出就会和玩家号抢键。
    if (id >= 100000) throw Object.assign(new Error('账号编号已用尽'), { code: 'UNAVAILABLE' });
    db.run(
      `INSERT INTO accounts (id, name, tag, pass_hash, pass_salt, recovery_hash, created_at, last_seen, device, ip,
                             reg_ip, reg_device_hash, reg_platform, reg_provider, reg_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, cleanName, tag, hash, salt, recoveryHash, ts, ts, '', String(ip || ''),
      String(ip || ''), String((device && device.hash) || ''), String((device && device.platform) || ''), String((device && device.provider) || ''), ts
    );
    const row = db.get('SELECT * FROM accounts WHERE id = ?', id);
    db.run('INSERT INTO player_ids(account_id, player_id) VALUES (?, ?)', id, nextNumber('player_ids', 'player_id', 100000, cleanName));
    devices.bind(row.id, device, ip);
    return { account: row, recoveryCode: recovery };
  });
}

function verifyPassword(row, password) {
  if (!row) return false;
  try {
    const hash = scryptHash(password, row.pass_salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.pass_hash, 'hex'));
  } catch (_) { return false; }
}

// 把一个旧令牌记成“被顶掉”的墓碑：旧客户端下次请求能拿到明确原因。
function rememberKick(tokenHash, accountId, reason, ts) {
  db.run('INSERT OR REPLACE INTO session_kicks(token_hash, account_id, reason, created_at) VALUES (?,?,?,?)',
    String(tokenHash), Number(accountId), String(reason || ''), Number(ts) || now());
}

function revokeAllSessions(accountId, reason) {
  const id = Number(accountId), ts = now();
  const rows = db.all('SELECT token_hash FROM sessions WHERE account_id = ?', id);
  for (const row of rows) rememberKick(row.token_hash, id, reason, ts);
  const r = db.run('DELETE FROM sessions WHERE account_id = ?', id);
  return Number(r.changes || 0);
}

function issueSession(accountId, { ua, ip, device } = {}) {
  if (!device || !device.hash) throw Object.assign(new Error('签发会话缺少设备绑定'), { code: 'DEVICE_REQUIRED' });
  // 创作者设备不落 account_devices（一台设备多个测试号），所以不能要求绑定行存在。
  if (!device.creator) {
    const binding = db.get('SELECT account_id FROM account_devices WHERE device_hash = ? AND account_id = ?', device.hash, Number(accountId));
    if (!binding) throw Object.assign(new Error('设备与账号不匹配'), { code: 'DEVICE_BOUND' });
  }

  const kicked = revokeAllSessions(accountId, 'other_device');
  const token = crypto.randomBytes(SESSION_BYTES).toString('base64url');
  const ts = now();
  db.run(
    'INSERT INTO sessions (token_hash, account_id, created_at, last_seen, expires_at, ua, ip, device_hash) VALUES (?,?,?,?,?,?,?,?)',
    sha256(token), accountId, ts, ts, ts + config.sessionTtlMs, String(ua || '').slice(0, 200), String(ip || ''), device.hash
  );
  return { token, kicked };
}

function revokeSession(token) {
  if (!token) return false;
  const r = db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  return Number(r.changes || 0) > 0;
}

function sessionFromRequest(req) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s) {
    // 旧会话被新登录顶掉时留了墓碑：把原因带回去，客户端能提示“账号已在其他设备登录”。
    const kick = db.get('SELECT reason, created_at FROM session_kicks WHERE token_hash = ?', sha256(token));
    if (kick) req.__authKicked = { reason: String(kick.reason || ''), at: Number(kick.created_at) || 0 };
    return null;
  }
  if (Number(s.expires_at) < now()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    return null;
  }
  const account = db.get('SELECT * FROM accounts WHERE id = ?', Number(s.account_id));
  if (!account) return null;
  if (Number(account.banned)) throw bannedError('账号已被封禁：' + (account.ban_reason || '违规'), { status: 'banned', reason: account.ban_reason || '违规' });
  const device = devices.authorize(req, s, account, clientIp(req));
  return { session: s, account, token, device };
}

const TOUCH_INTERVAL_MS = 60 * 1000;
function touchSession(session, nowMs) {
  const ts = nowMs || now();
  const last = Number(session.last_seen) || 0;
  const expires = Number(session.expires_at) || 0;

  if (ts - last < TOUCH_INTERVAL_MS && expires - ts > Math.min(config.sessionTtlMs, 5 * 60 * 1000)) return false;
  db.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?',
    ts, ts + config.sessionTtlMs, session.token_hash);
  db.run('UPDATE accounts SET last_seen = ? WHERE id = ?', ts, Number(session.account_id));
  session.last_seen = ts;
  session.expires_at = ts + config.sessionTtlMs;
  return true;
}

function login({ name, password, ip, device }) {
  const blocked = enforcement.ipBanFor(ip);
  if (blocked) throw blockedIpError(blocked);
  const row = findAccount(name);
  if (!row) throw Object.assign(new Error('没有这个账号'), { code: 'AUTH' });
  if (!verifyPassword(row, password)) throw Object.assign(new Error('密码不对'), { code: 'AUTH' });
  if (Number(row.banned)) throw bannedError('账号已被封禁：' + (row.ban_reason || '违规'), { status: 'banned', reason: row.ban_reason || '违规' });
  devices.bind(row.id, device, ip);
  db.run('UPDATE accounts SET last_seen = ? WHERE id = ?', now(), Number(row.id));
  return row;
}

function recover({ recoveryCode, password, ip, device }) {
  const blocked = enforcement.ipBanFor(ip);
  if (blocked) throw blockedIpError(blocked);
  const hash = sha256(String(recoveryCode || '').trim().toUpperCase());
  const row = db.get('SELECT * FROM accounts WHERE recovery_hash = ?', hash);
  if (!row) throw Object.assign(new Error('恢复码无效'), { code: 'AUTH' });
  if (Number(row.banned)) throw bannedError('账号已被封禁：' + (row.ban_reason || '违规'), { status: 'banned', reason: row.ban_reason || '违规' });
  devices.bind(row.id, device, ip);
  if (password) {
    const pass = normalizePassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const newHash = scryptHash(pass, salt);
    const newRecovery = newRecoveryCode();
    db.run('UPDATE accounts SET pass_hash = ?, pass_salt = ?, recovery_hash = ? WHERE id = ?',
      newHash, salt, sha256(newRecovery), Number(row.id));
    revokeAllSessions(row.id, 'password_reset');
    return { account: db.get('SELECT * FROM accounts WHERE id = ?', Number(row.id)), recoveryCode: newRecovery };
  }
  return { account: row, recoveryCode: null };
}

// 修改密码：校验当前密码后换新 salt/hash；除当前会话外的其它设备会话全部撤销。
// 恢复码保持不变（找回入口仍可用）；没有另发令牌，调用方的 Bearer 继续有效。
function changePassword(accountId, currentPassword, newPassword, keepToken) {
  const id = Number(accountId);
  const row = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!row) throw Object.assign(new Error('账号不存在'), { code: 'AUTH' });
  if (typeof currentPassword !== 'string' || !verifyPassword(row, currentPassword)) {
    throw Object.assign(new Error('当前密码不正确'), { code: 'FORBIDDEN' });
  }
  const pass = normalizePassword(newPassword);
  if (pass === currentPassword) throw Object.assign(new Error('新密码不能与当前密码相同'), { code: 'BAD_REQUEST' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(pass, salt);
  db.tx(() => {
    db.run('UPDATE accounts SET pass_hash = ?, pass_salt = ? WHERE id = ?', hash, salt, id);
    const keepHash = keepToken ? sha256(keepToken) : '';
    const rows = db.all('SELECT token_hash FROM sessions WHERE account_id = ?' + (keepHash ? ' AND token_hash <> ?' : ''),
      ...(keepHash ? [id, keepHash] : [id]));
    for (const row of rows) rememberKick(row.token_hash, id, 'password_changed', now());
    if (keepHash) db.run('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?', id, keepHash);
    else db.run('DELETE FROM sessions WHERE account_id = ?', id);
  });
  return { ok: true, changed: true };
}

// 同一事务里同步存档显示名与当前防守快照，避免首页/战报还显示旧名字。
function changeName(accountId, rawName) {
  const id = Number(accountId);
  const row = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!row) throw Object.assign(new Error('账号不存在'), { code: 'AUTH' });
  const name = normalizeName(rawName);
  if (name.toLowerCase() === String(row.name).toLowerCase()) {
    throw Object.assign(new Error('新昵称与当前昵称相同'), { code: 'BAD_REQUEST' });
  }
  return db.tx(() => {
    // 事务内再查一次：重名判定与写入之间不能插进另一个改名。
    const conflict = numericNameConflict(name);
    if (conflict || nameTaken(name)) {
      throw Object.assign(new Error(conflict || '这个昵称已经被占用了，换一个吧'), { code: 'CONFLICT' });
    }
    db.run('UPDATE accounts SET name = ? WHERE id = ?', name, id);
    const save = require('./game/store').rename(id, name);
    return { account: db.get('SELECT * FROM accounts WHERE id = ?', id), name, save };
  });
}

function deleteAccount(accountId, password) {
  const id = Number(accountId);
  const account = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!account) throw Object.assign(new Error('账号不存在'), { code: 'AUTH' });
  if (typeof password !== 'string' || password.length > 128 || !verifyPassword(account, password)) {
    throw Object.assign(new Error('当前密码不正确，账号未注销'), { code: 'FORBIDDEN' });
  }
  const store = require('./game/store');
  const anon = '已注销玩家';
  const anonymize = fighter => {
    if (!fighter) return;
    fighter.name = anon;
    for (const key of ['tag', 'display', 'accountId', 'remoteId', 'snapshotId']) delete fighter[key];
  };
  db.tx(() => {
    const friendOwners = new Set(db.all('SELECT account_id FROM friendships WHERE friend_id = ?', id).map(r => Number(r.account_id)));
    const relations = db.all('SELECT * FROM apprenticeships WHERE master_id = ? OR prentice_id = ?', id, id);
    const combats = db.all('SELECT * FROM combats WHERE attacker_id = ? OR defender_id = ?', id, id);
    const combatIds = new Set(combats.map(r => String(r.id)));
    for (const row of combats) {
      const side = Number(row.attacker_id) === id ? 0 : 1;
      const survivor = side === 0 ? Number(row.defender_id) : Number(row.attacker_id);
      if (!survivor || survivor === id) { db.run('DELETE FROM combats WHERE id = ?', row.id); continue; }
      const repro = row.repro ? store.decode(row.repro) : null;
      let result = null;
      if (repro) {
        if (side === 0) { if (repro.me) repro.me.name = anon; }
        else if (repro.foe) repro.foe.name = anon;
        try { result = battle.simulate(Number(row.seed), repro.me, repro.foe); } catch (_) { result = null; }
      } else {
        result = store.decode(row.result);
        if (Array.isArray(result.names)) result.names[side] = anon;
      }
      const settled = JSON.parse(row.settlement || '{}'), packet = settled.__packet || settled.__meta;
      if (packet) {
        anonymize(side === 0 ? packet.me : packet.foe);
        if (side === 1 && packet.opponent) {
          packet.opponent = { source: 'player', player: true, bot: false, deleted: true, accountId: 0,
            name: anon, tag: '', display: anon, snapshotId: '', kind: row.kind, practice: false };
        }
      }
      const summary = repro && result
        ? { winner: result.winner, maxHp: result.maxHp, names: result.names }
        : result;
      const hash = result
        ? crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex')
        : row.hash;
      db.run('UPDATE combats SET attacker_id = ?, defender_id = ?, snapshot_id = ?, idem_key = ?, result = ?, repro = ?, hash = ?, settlement = ? WHERE id = ?',
        side === 0 ? 0 : row.attacker_id, side === 1 ? 0 : row.defender_id,
        side === 1 ? '' : row.snapshot_id, side === 0 ? '' : row.idem_key,
        store.encode(summary || {}), repro ? store.encode(repro) : null, hash, JSON.stringify(settled), row.id);
    }
// 仅清理社交/战绩字段，直接写回保留他人的资源、属性与已结算奖励。
    for (const row of db.all('SELECT account_id, mode, payload FROM saves WHERE account_id <> ?', id)) {
      const save = store.decode(row.payload), before = JSON.stringify(save), owner = Number(row.account_id);
      const matches = item => item && (Number(item.accountId || item.remoteId) === id);
      if (Array.isArray(save.friends)) save.friends = save.friends.filter(f => !matches(f) && !(friendOwners.has(owner) && f.name === account.name));
      if (save.friendMessages && friendOwners.has(owner)) delete save.friendMessages[account.name];
      if (matches(save.master) || relations.some(r => Number(r.prentice_id) === owner && Number(r.master_id) === id)) save.master = null;
      if (Array.isArray(save.prentices)) save.prentices = save.prentices.filter(p => !matches(p)
        && !(p.name === account.name && relations.some(r => Number(r.master_id) === owner && Number(r.prentice_id) === id)));
      for (const entry of save.battles || []) {
        const online = entry.online || {};
        if (Number(online.opponentId) !== id && !combatIds.has(String(online.combatId || ''))) continue;
        anonymize(entry.foe);
        if (entry.result && Array.isArray(entry.result.names)) entry.result.names[1] = anon;
        online.opponentId = 0; online.snapshotId = ''; online.deleted = true;
      }
      if (JSON.stringify(save) !== before) db.run('UPDATE saves SET payload = ?, revision = revision + 1, updated_at = ? WHERE account_id = ? AND mode = ?',
        store.encode(save), now(), owner, row.mode);
    }
    for (const row of db.all('SELECT * FROM messages WHERE account_id <> ?', id)) {
      const payload = JSON.parse(row.payload || '{}');
      if (Number(payload.fromId) === id) { db.run('DELETE FROM messages WHERE id = ?', row.id); continue; }
      if (Number(row.from_id) === id) db.run('UPDATE messages SET from_id = 0, from_name = ?, text = ? WHERE id = ?', '', '【已注销玩家】的历史战斗记录', row.id);
    }
    const rooms = db.all('SELECT DISTINCT r.* FROM campaign_rooms r LEFT JOIN campaign_members m ON m.room_id = r.id WHERE r.host_id = ? OR m.account_id = ?', id, id);
    db.run('DELETE FROM campaign_members WHERE account_id = ?', id);
    for (const room of rooms) {
      const members = db.all('SELECT account_id FROM campaign_members WHERE room_id = ? ORDER BY seat, joined_at', room.id);
      if (!members.length) { db.run('DELETE FROM campaign_rooms WHERE id = ?', room.id); continue; }
      let records = []; try { records = store.decode(room.combat_ids); } catch (_) {}
      if (Array.isArray(records)) records = records.filter(r => !r || Number(r.accountId) !== id);
      db.run('UPDATE campaign_rooms SET host_id = ?, combat_ids = ? WHERE id = ?',
        Number(room.host_id) === id ? members[0].account_id : room.host_id, JSON.stringify(records), room.id);
      if (room.status === 'waiting') members.forEach((m, seat) => db.run('UPDATE campaign_members SET seat = ? WHERE room_id = ? AND account_id = ?', seat, room.id, m.account_id));
    }
    db.run('DELETE FROM friendships WHERE account_id = ? OR friend_id = ?', id, id);
    // master_id 在人机师父改造后不再有外键（master_id=0 表示人机师父），必须显式清理。
    db.run('DELETE FROM apprenticeships WHERE prentice_id = ? OR master_id = ?', id, id);
    db.run('DELETE FROM friend_messages WHERE to_id = ? OR from_id = ?', id, id);
    db.run('DELETE FROM action_log WHERE account_id = ?', id);
    db.run('DELETE FROM rank_awards WHERE account_id = ?', id);
    db.run("UPDATE security_events SET device_hash = '', ip = '' WHERE account_id = ?", id);
    db.run('DELETE FROM accounts WHERE id = ?', id);
  });
  require('./game/opponents').forgetAccount(id);
  return { ok: true, deleted: true };
}

module.exports = {
  register, login, recover, changePassword, changeName, deleteAccount, findAccount, findAccountStrict, publicAccount,
  issueSession, revokeSession, sessionFromRequest, touchSession,
  normalizeName, normalizePassword, nameTaken, nameAvailable, verifyPassword, sha256,
};
