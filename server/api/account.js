'use strict';

const db = require('../db');
const auth = require('../auth');
const devices = require('../device');
const quota = require('../account-quota');
const store = require('../game/store');
const settlement = require('../game/settlement');
const snapshots = require('../game/snapshot');
const visibility = require('../game/visibility');
const enforcement = require('../game/enforcement');
const { fail, clientIp, rateLimit } = require('../http');
const { config } = require('../config');

function profileOf(account) {
  const pub = auth.publicAccount(account);

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
    hidden: visibility.isHidden(account.id),
    hiddenUntil: visibility.hiddenUntil(account.id),
    enforcement: enforcement.statusFor(account.id),
    hasSave: !!save,
    save: save ? {
      level: Number(save.level), name: String(save.name), power: Number(save.power),
      agility: Number(save.agility), speed: Number(save.speed), hp: Number(save.hp),
      gold: Number(save.gold), goldCup: Number(save.gold_cup),
      // 天梯积分以 ratings 为唯一真值：`rating` 就是刚读到的本周行，不再二次查询。
      integral: Number(rating.score) || 0,
      revision: Number(save.revision), updatedAt: Number(save.updated_at),
    } : null,
    daily: settlement.rankDailyStatus(account.id),
  };
}

// 某台设备上创建的账号数：新账号看 `reg_device_hash`；旧账号没有这个字段时
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
    // 本次登录顶掉了几个旧设备会话：客户端据此提示“其他设备已下线”。
    kickedSessions: Number(kicked) || 0,
    profile: profileOf(account),
  };
}

function authenticate(ctx, event, fn) {
  const { req, body } = ctx, ip = clientIp(req);
  let device, accountId;
  if (event === 'login') accountId = (auth.findAccount(body.name) || {}).id;
  else if (event === 'recover') accountId = (db.get('SELECT id FROM accounts WHERE recovery_hash = ?', auth.sha256(String(body.recoveryCode || '').trim().toUpperCase())) || {}).id;
  try {
    device = devices.fromRequest(req);

    const known = event !== 'register' && accountId ? devices.knownLogin(accountId, device, ip) : null;
    // 每日注册额度先于内存滑窗：已经用完 5 次时直接给明确的 429，
    // 不要让人先看到“请求太频繁”。真正的原子检查仍在事务内（见 register）。
    if (event === 'register') quota.assertAllowed(ip, 'register');

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
      if (!info.device.creator && config.registrationLimit && Number(db.get('SELECT COUNT(*) AS n FROM accounts').n) >= config.registrationLimit)
        throw fail('UNAVAILABLE', '服务器注册名额已满，请稍后再试');

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
      // 同一 IP 每天最多注册 5 次。检查与记账都在本事务内：
      // 并发注册由 SQLite 的写事务串行化，不会一起越过上限。
      const ip = String(info.ip || '');
      quota.assertAllowed(ip, 'register');
      const out = auth.register({ name: ctx.body.name, password: ctx.body.password, ...info });
      store.createSave(out.account.id, out.account.name);
      settlement.ensureRating(out.account.id);
      quota.consume(ip, 'register');
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
    // 同一 IP 每天最多注销 5 次。密码错 / 账号不存在时事务回滚，
    const ip = clientIp(ctx.req);
    try {
      return db.tx(() => {
        quota.assertAllowed(ip, 'delete');
        const out = auth.deleteAccount(ctx.account.id, ctx.body.password);
        quota.consume(ip, 'delete');
        return out;
      });
    } catch (e) {
      devices.audit('delete_account', 'denied', { accountId: ctx.account.id, device: ctx.auth && ctx.auth.device, ip, reason: e.code || 'SERVER' });
      throw e;
    }
  },


  changePassword(ctx) {
    rateLimit('change-password:' + ctx.account.id, 10, 60 * 1000);
    const keepToken = ctx.auth && ctx.auth.token ? String(ctx.auth.token) : '';
    return auth.changePassword(ctx.account.id, ctx.body.password, ctx.body.newPassword, keepToken);
  },

  // 设置页「修改昵称」：全服唯一；同时改存档显示名与当前防守快照。
  // 返回 patch/rev/summary，客户端沿用动作流水线更新镜像。
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

  // 客户端启动时拉的动作白名单 + 服务器信息。
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
        rankCapFrom: config.rankCapFrom,
        rankCapCost: config.rankCapCost,
        rankWinCup: config.rankWinCup,
        rankLoseCup: config.rankLoseCup,
        rankRobCup: config.rankRobCup,
        rankRobChance: config.rankRobChance,
        rankWeeklyCup: config.rankWeeklyCup,
        rankWeeklyTop: config.rankWeeklyTop,
        rankIntegralStart: config.rankIntegralStart,
        rankRealMatchScoreLimit: config.rankRealMatchScoreLimit,
        opponentRatingSpread: config.opponentRatingSpread,
        opponentRatingWeightFloor: config.opponentRatingWeightFloor,
        rankRealRecentMatches: config.rankRealRecentMatches,
        rankBotBaseScore: config.rankBotBaseScore,
        rankBotFloor: config.rankBotFloor,
        friendLimit: config.friendLimit,
        accountsPerDevice: config.accountsPerDevice,
        accountsPerIp: config.accountsPerIp,
        accountDailyLimit: config.accountDailyLimit,
        campaignMinLevel: config.campaignMinLevel,
        campaignPartySize: config.campaignPartySize,
        snapshotsPerLevel: config.snapshotsPerLevel,
        lotteryPrice: config.lotteryPrice,
        playerLevelCap: 90,
      },
      actions: defs.actions,
      serverOnly: defs.serverOnly,
      battleKinds: defs.battle && defs.battle.kinds,
    };
  },


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

      daily: quota.status(ip),
    };
  },

  // 校验昵称是否可用（注册页即时提示用）；与 `auth.register` 共用同一条判定。
  checkName(ctx) {
    const out = auth.nameAvailable(ctx.query.name);
    return { ok: true, available: out.available, name: out.name, taken: out.taken, reason: out.reason };
  },
};
