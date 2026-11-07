'use strict';
/* ============================================================
 * server/api/account.js — 账号与会话
 * ============================================================ */

const db = require('../db');
const auth = require('../auth');
const devices = require('../device');
const store = require('../game/store');
const settlement = require('../game/settlement');
const snapshots = require('../game/snapshot');
const { fail, clientIp, rateLimit } = require('../http');
const { config } = require('../config');

function profileOf(account) {
  const pub = auth.publicAccount(account);
  /* 天梯积分按周重置（2026-11）：`ratings.season` 存的是本周周一日期。 */
  const week = settlement.weekKey();
  const rating = settlement.ensureRating(account.id, week);
  const save = db.get('SELECT account_id, level, name, power, agility, speed, hp, gold, gold_cup, integral, revision, updated_at FROM saves WHERE account_id = ? AND mode = ?',
    Number(account.id), 'classic');
  return {
    account: pub,
    season: week,
    week,
    rating: {
      score: Number(rating.score), wins: Number(rating.wins), losses: Number(rating.losses),
      streak: Number(rating.streak), rank: settlement.rankOf(account.id),
    },
    hasSave: !!save,
    save: save ? {
      level: Number(save.level), name: String(save.name), power: Number(save.power),
      agility: Number(save.agility), speed: Number(save.speed), hp: Number(save.hp),
      gold: Number(save.gold), goldCup: Number(save.gold_cup),
      /* 天梯积分以 ratings 为唯一真值：`rating` 就是刚读到的本周行，不再二次查询。 */
      integral: Number(rating.score) || 0,
      revision: Number(save.revision), updatedAt: Number(save.updated_at),
    } : null,
    daily: settlement.rankDailyStatus(account.id),
  };
}

/** 某台设备上**创建**的账号数：新账号看 `reg_device_hash`；旧账号没有这个字段时
 *  退回它当前绑定的 `account_devices` 行（V12 迁移后的兼容口径）。 */
function createdOnDevice(deviceHash) {
  const hash = String(deviceHash || '');
  if (!hash) return 0;
  return Number(db.get(
    `SELECT COUNT(*) AS n FROM accounts a
      WHERE a.reg_device_hash = ?
         OR (a.reg_device_hash = '' AND EXISTS (
              SELECT 1 FROM account_devices d WHERE d.account_id = a.id AND d.device_hash = ?))`,
    hash, hash
  ).n) || 0;
}

function sessionPayload(account, token, kicked) {  return {
    ok: true,
    token,
    /* 本次登录顶掉了几个旧设备会话：客户端据此提示“其他设备已下线”。 */
    kickedSessions: Number(kicked) || 0,
    profile: profileOf(account),
  };
}

/** Binding + account changes + session issue commit together; failures log no secrets. */
function authenticate(ctx, event, fn) {
  const { req, body } = ctx, ip = clientIp(req);
  let device, accountId;
  if (event === 'login') accountId = (auth.findAccount(body.name) || {}).id;
  else if (event === 'recover') accountId = (db.get('SELECT id FROM accounts WHERE recovery_hash = ?', auth.sha256(String(body.recoveryCode || '').trim().toUpperCase())) || {}).id;
  try {
    device = devices.fromRequest(req);
    /* 登录/找回前先记下这台设备与 IP 是否在这个账号上出现过；
     * fn 内部会 bind/observeIp，之后再查就查不到“新”了。 */
    const known = event !== 'register' && accountId ? devices.knownLogin(accountId, device, ip) : null;
    /* 创作者设备只在注册时豁免限流；登录/找回仍保留限流，避免设备指纹泄露后被拿来撞库。 */
    if (!(device.creator && event === 'register')) {
      rateLimit(event + ':' + ip, event === 'register' ? 6 : event === 'recover' ? 10 : 30, event === 'login' ? 60000 : 3600000);
    }
    return db.tx(() => {
      const out = fn({ ip, device }), account = out.account;
      accountId = account.id;
      devices.observeIp(account.id, device, ip, true);
      devices.audit(event, 'ok', { accountId, device, ip });
      if (known && (!known.device || !known.ip)) {
        devices.alertLogin(account.id, device, ip, { newDevice: !known.device, newIp: !known.ip });
      }
      const issued = auth.issueSession(account.id, { ua: req.headers['user-agent'], ip, device });
      return Object.assign(sessionPayload(account, issued.token, issued.kicked), out.recoveryCode ? { recoveryCode: out.recoveryCode } : {});
    });
  } catch (e) {
    devices.audit(event, 'denied', { accountId, device, ip, reason: e.code || 'SERVER' });
    throw e;
  }
}

module.exports = {
  register(ctx) {
    return authenticate(ctx, 'register', info => {
      // authenticate holds the write transaction across this check and registration.
      if (!info.device.creator && config.registrationLimit && Number(db.get('SELECT COUNT(*) AS n FROM accounts').n) >= config.registrationLimit)
        throw fail('UNAVAILABLE', '服务器注册名额已满，请稍后再试');
      /* 一台设备 / 一个 IP 最多创建 3 个账号（创作设备不受限）。只统计**创建**，
       * 登录已有账号不占额度；这样同一设备可以切换自己已有的 3 个号。 */
      if (!info.device.creator) {
        const byDevice = createdOnDevice(info.device.hash);
        if (config.accountsPerDevice > 0 && byDevice >= config.accountsPerDevice) {
          throw fail('DEVICE_ACCOUNT_LIMIT', '此设备最多创建 ' + config.accountsPerDevice +
            ' 个账号（当前 ' + byDevice + '/' + config.accountsPerDevice + '），请直接登录已有账号');
        }
        const ip = String(info.ip || '');
        if (config.accountsPerIp > 0 && ip) {
          const byIp = Number(db.get('SELECT COUNT(*) AS n FROM accounts WHERE reg_ip = ?', ip).n) || 0;
          if (byIp >= config.accountsPerIp) {
            throw fail('DEVICE_ACCOUNT_LIMIT', '此网络最多创建 ' + config.accountsPerIp +
              ' 个账号（当前 ' + byIp + '/' + config.accountsPerIp + '），请直接登录已有账号');
          }
        }
      }
      const out = auth.register({ name: ctx.body.name, password: ctx.body.password, ...info });
      store.createSave(out.account.id, out.account.name);
      settlement.ensureRating(out.account.id);
      return out;
    });
  },

  login(ctx) {
    return authenticate(ctx, 'login', info => {
      const account = auth.login({ name: ctx.body.name, password: ctx.body.password, ...info });
      settlement.ensureRating(account.id);
      return { account };
    });
  },

  recover(ctx) {
    return authenticate(ctx, 'recover', info => auth.recover({ recoveryCode: ctx.body.recoveryCode, password: ctx.body.password, ...info }));
  },

  logout(ctx) {
    auth.revokeSession(ctx.auth && ctx.auth.token);
    return { ok: true };
  },

  deleteAccount(ctx) {
    rateLimit('delete-account:' + ctx.account.id, 5, 60 * 1000);
    return auth.deleteAccount(ctx.account.id, ctx.body.password);
  },

  /** 设置页「修改密码」：当前密码 + 新密码；只保留当前设备的会话。 */
  changePassword(ctx) {
    rateLimit('change-password:' + ctx.account.id, 10, 60 * 1000);
    const keepToken = ctx.auth && ctx.auth.token ? String(ctx.auth.token) : '';
    return auth.changePassword(ctx.account.id, ctx.body.password, ctx.body.newPassword, keepToken);
  },

  /** 设置页「修改昵称」：全服唯一；同时改存档显示名与当前防守快照。
   *  返回 patch/rev/summary，客户端沿用动作流水线更新镜像。 */
  changeName(ctx) {
    rateLimit('change-name:' + ctx.account.id, 5, 60 * 1000);
    const out = auth.changeName(ctx.account.id, ctx.body && ctx.body.name);
    const save = out.save || {};
    return {
      ok: true,
      name: out.name,
      account: auth.publicAccount(out.account),
      rev: save.rev,
      patch: save.patch,
      summary: save.summary,
    };
  },

  profile(ctx) {
    return { ok: true, profile: profileOf(ctx.account) };
  },

  /** 客户端启动时拉的动作白名单 + 服务器信息。 */
  meta(ctx) {
    const defs = require('../game/actions').DEFS;
    const runtime = require('../game/runtime').boot();
    return {
      ok: true,
      version: 1,
      gameVersion: runtime.simVersion,
      levelCap: runtime.levelCap,
      devicePolicy: devices.policy(),
      season: settlement.weekKey(),
      serverTime: Date.now(),
      timezone: config.timezone,
      season_id: settlement.weekKey(),
      limits: {
        rankDaily: config.rankDailyLimit,
        rankFree: config.rankFreePlays,
        rankPaidCost: config.rankPaidCost,
        rankLateFrom: config.rankLateFrom,
        rankLateCost: config.rankLateCost,
        rankWinCup: config.rankWinCup,
        rankLoseCup: config.rankLoseCup,
        rankRobCup: config.rankRobCup,
        rankRobChance: config.rankRobChance,
        rankWeeklyCup: config.rankWeeklyCup,
        rankWeeklyTop: config.rankWeeklyTop,
        rankIntegralStart: config.rankIntegralStart,
        rankRealMatchScoreLimit: config.rankRealMatchScoreLimit,
        rankBotWeightDivisor: config.rankBotWeightDivisor,
        rankRealRecentMatches: config.rankRealRecentMatches,
        rankBotBaseScore: config.rankBotBaseScore,
        rankBotFloor: config.rankBotFloor,
        friendLimit: config.friendLimit,
        accountsPerDevice: config.accountsPerDevice,
        accountsPerIp: config.accountsPerIp,
        campaignMinLevel: config.campaignMinLevel,
        campaignPartySize: config.campaignPartySize,
        snapshotsPerLevel: config.snapshotsPerLevel,
        playerLevelCap: 90,
      },
      actions: defs.actions,
      serverOnly: defs.serverOnly,
      battleKinds: defs.battle && defs.battle.kinds,
    };
  },

  /** 当前设备/网络的注册额度（设置页显示 x/y 用）。只统计**创建**账号，
   *  登录已有账号不占额度；创作者设备返回 creator=true。 */
  deviceQuota(ctx) {
    const device = devices.fromRequest(ctx.req);
    const ip = clientIp(ctx.req);
    const created = createdOnDevice(device.hash);
    const ipCreated = ip ? (Number(db.get('SELECT COUNT(*) AS n FROM accounts WHERE reg_ip = ?', ip).n) || 0) : 0;
    return {
      ok: true,
      created,
      limit: config.accountsPerDevice,
      ipCreated,
      ipLimit: config.accountsPerIp,
      creator: !!device.creator,
    };
  },

  /** 校验昵称是否可用（注册页即时提示用）；与 `auth.register` 共用同一条判定。 */
  checkName(ctx) {
    const out = auth.nameAvailable(ctx.query.name);
    return { ok: true, available: out.available, name: out.name, taken: out.taken, reason: out.reason };
  },
};
