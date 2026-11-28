'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function bool(v, fallback) {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

function float(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

const config = {

  port: int(process.env.PORT, 3100, 1, 65535),
  bind: process.env.BIND || '127.0.0.1',

  wwwRoot: process.env.WWW_ROOT ? path.resolve(process.env.WWW_ROOT) : path.join(ROOT),
  serveStatic: bool(process.env.SERVE_STATIC, true),
  // 可选静态资源前缀（COS/CDN）。设置后 `/images|/js|/css|/audio` 301 过去，
  // `/api` 仍直连本机，登录/IP 追踪不受影响。
  assetBase: process.env.ASSET_BASE ? String(process.env.ASSET_BASE).trim().replace(/\/+$/, '') : '',


  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'save', 'online'),
  gameRoot: process.env.GAME_ROOT ? path.resolve(process.env.GAME_ROOT) : ROOT,


  timezone: process.env.TZ_NAME || 'Asia/Shanghai',
  season: process.env.SEASON || '',

  // 每日费用阶梯：前 10 场免费、11-20 每场 5、21-30 每场 10、第 31 场起每场 20 封顶。
  // `rankDailyLimit = 0` 表示不限次数；想恢复上限就设成正数。
  rankDailyLimit: int(process.env.RANK_DAILY_LIMIT, 0, 0, 200),
  rankFreePlays: int(process.env.RANK_FREE_PLAYS, 10, 0, 200),
  rankPaidCost: int(process.env.RANK_PAID_COST, 5, 0, 1000),
  rankLateFrom: int(process.env.RANK_LATE_FROM, 20, 0, 200),
  rankLateCost: int(process.env.RANK_LATE_COST, 10, 0, 1000),
  rankCapFrom: int(process.env.RANK_CAP_FROM, 30, 0, 500),
  rankCapCost: int(process.env.RANK_CAP_COST, 20, 0, 10000),
  rankWinCup: int(process.env.RANK_WIN_CUP, 3, 0, 100),
  rankLoseCup: int(process.env.RANK_LOSE_CUP, 1, 0, 100),
  rankRobCup: int(process.env.RANK_ROB_CUP, 3, 0, 100),
  rankRobChance: Number(process.env.RANK_ROB_CHANCE || 0.25),
  rankLoseExp: int(process.env.RANK_LOSE_EXP, 10, 0, 100000),
  rankWeeklyCup: int(process.env.RANK_WEEKLY_CUP, 50, 0, 10000),
  rankWeeklyTop: int(process.env.RANK_WEEKLY_TOP, 30, 1, 100000),


  rankDivisions: [
    { key: 'd30', lo: 30, hi: 39, frame: 1, label: '30级-39级' },
    { key: 'd40', lo: 40, hi: 49, frame: 2, label: '40级-49级' },
    { key: 'd50', lo: 50, hi: 59, frame: 3, label: '50级-59级' },
    { key: 'd60', lo: 60, hi: 69, frame: 4, label: '60级-69级' },
    { key: 'd70', lo: 70, hi: 79, frame: 5, label: '70级-79级' },
    { key: 'd80', lo: 80, hi: 90, frame: 6, label: '80级-90级' },
  ],
  rankBotBaseScore: int(process.env.RANK_BOT_BASE_SCORE, 300, 0, 100000),
  rankBotPerLevel: int(process.env.RANK_BOT_PER_LEVEL, 3, 1, 10),
  rankBotScale: Number(process.env.RANK_BOT_SCALE || 1.08),
  rankBotFloor: int(process.env.RANK_BOT_FLOOR, 50, 0, 100000),

  rankRealRecentMatches: int(process.env.RANK_REAL_RECENT_MATCHES, 5, 0, 50),
  rankIntegralStart: int(process.env.RANK_INTEGRAL_START, 0, 0, 100000),
  rankIntegralFloor: int(process.env.RANK_INTEGRAL_FLOOR, 0, 0, 100000),


  opponentsPerRefresh: int(process.env.OPPONENTS_PER_REFRESH, 3, 1, 20),

  randomBotSlots: int(process.env.RANDOM_BOT_SLOTS, 30, 1, 200),
  randomRealRecentRefreshes: int(process.env.RANDOM_REAL_RECENT_REFRESHES, 10, 0, 100),
  opponentLevelSpread: int(process.env.OPPONENT_LEVEL_SPREAD, 3, 0, 90),
  // 天梯候选按积分差加权：差 0 权重 1，差 `opponentRatingSpread` 分降到 `opponentRatingWeightFloor`，
  // 差更大也保持这个下限（只降低抽中概率，不再硬性排除）。
  opponentRatingSpread: int(process.env.OPPONENT_RATING_SPREAD, 200, 1, 20000),
  opponentRatingWeightFloor: float(process.env.OPPONENT_RATING_WEIGHT_FLOOR, 0.2, 0.01, 1),
  opponentRefreshCooldownMs: int(process.env.OPPONENT_REFRESH_MS, 3000, 0, 600000),
  opponentIdleDays: int(process.env.OPPONENT_IDLE_DAYS, 14, 0, 3650),

  // 达到此积分后，人机参与匹配时按 0 分计算权重。
  rankRealMatchScoreLimit: int(process.env.RANK_REAL_MATCH_SCORE_LIMIT, 300, 0, 100000),

  // 快照
  snapshotsPerLevel: int(process.env.SNAPSHOTS_PER_LEVEL, 3, 1, 50),


  campaignMinLevel: int(process.env.CAMPAIGN_MIN_LEVEL, 35, 1, 90),

  campaignDailyLimit: int(process.env.CAMPAIGN_DAILY_LIMIT, 3, 1, 100),
  campaignPartySize: int(process.env.CAMPAIGN_PARTY_SIZE, 4, 2, 8),
  campaignRoomTtlMs: int(process.env.CAMPAIGN_ROOM_TTL_MS, 15 * 60 * 1000, 60000, 86400000),
  // 真人匹配最长等待：5 分钟凑不满 4 人就判失败，不扣门票、不扣每日次数。
  // 玩家报名后可以离开界面，由客户端 watcher 轮询结果。
  campaignMatchWaitMs: int(process.env.CAMPAIGN_MATCH_WAIT_MS, 5 * 60 * 1000, 5000, 3600000),
  // 随机匹配立即开打：助战座位抽 3 个（等级相近的玩家快照，抽不到就人机）。
  campaignRandomTeammates: int(process.env.CAMPAIGN_RANDOM_TEAMMATES, 3, 1, 7),
  // 兼容旧环境变量；新逻辑不再按“到点少人开打”。保留字段只为旧部署脚本不报错。
  campaignFillMs: int(process.env.CAMPAIGN_FILL_MS, 45000, 5000, 600000),
  campaignTicketProp: int(process.env.CAMPAIGN_TICKET_PROP, 87, 0, 9999),
  campaignDiceMax: int(process.env.CAMPAIGN_DICE_MAX, 100, 1, 100000),
  campaignHouseCut: Number(process.env.CAMPAIGN_HOUSE_CUT || 0.1),


  // 原版 ssfight 没有好友数量上限（`getFriends` 整份读入、4 行/页翻页；抓包见过 142 人）。
  // 这里的 50 是联机服务端已有的防滥用安全线：好友页把每个好友的战斗体随列表下发，
  // 上限也锁 50：再往上必须同步改 `js/state.js`（服务端动作要经过它），并把好友页
  friendLimit: int(process.env.FRIEND_LIMIT, 50, 1, 50),


  // 每日抽奖单次金松果价：服务端扣费与客户端展示共用；客户端从 /api/meta 读。
  lotteryPrice: int(process.env.LOTTERY_PRICE, 25, 1, 100000),

  apprenticeCap: int(process.env.APPRENTICE_CAP, 3, 1, 10),
  apprenticeTributeExpRate: Number(process.env.APPRENTICE_TRIBUTE_EXP_RATE || 0.10),
  apprenticeTributeGoldRate: Number(process.env.APPRENTICE_TRIBUTE_GOLD_RATE || 0.10),
  apprenticeRecruitCost: int(process.env.APPRENTICE_RECRUIT_COST, 10, 0, 100000),
  apprenticeRecruitEnergy: int(process.env.APPRENTICE_RECRUIT_ENERGY, 10, 0, 100000),
  apprenticeLeaveCost: int(process.env.APPRENTICE_LEAVE_COST, 20, 0, 100000),

  // 论坛：每日额度 / 容量硬上限 / 列表页大小 / 旧帖保留期。
  // 折合约 0.3 KB/条。默认 3 万帖 + 30 万回复的硬上限 ≈ 100 MB 正文占用，
  forumDailyPostLimit: int(process.env.FORUM_DAILY_POST_LIMIT, 20, 0, 1000),
  forumDailyReplyLimit: int(process.env.FORUM_DAILY_REPLY_LIMIT, 100, 0, 5000),
  forumMaxPosts: int(process.env.FORUM_MAX_POSTS, 30000, 100, 10000000),
  forumMaxReplies: int(process.env.FORUM_MAX_REPLIES, 300000, 100, 100000000),
  forumMaxRepliesPerPost: int(process.env.FORUM_MAX_REPLIES_PER_POST, 2000, 10, 100000),
  forumWarnPercent: int(process.env.FORUM_WARN_PERCENT, 80, 1, 100),
  forumPageSize: int(process.env.FORUM_PAGE_SIZE, 15, 5, 50),
  forumRetentionDays: int(process.env.FORUM_RETENTION_DAYS, 0, 0, 3650),
  forumAdminLogRetentionDays: int(process.env.FORUM_ADMIN_LOG_RETENTION_DAYS, 365, 7, 3650),

  forumGlobalPostsPerMin: int(process.env.FORUM_GLOBAL_POSTS_PER_MIN, 60, 1, 100000),
  forumGlobalRepliesPerMin: int(process.env.FORUM_GLOBAL_REPLIES_PER_MIN, 300, 1, 100000),

  forumFounderPlayerIds: String(process.env.FORUM_FOUNDER_PLAYER_IDS || '100000').split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0),

  // 安全
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
  actionRatePerMin: int(process.env.ACTION_RATE_PER_MIN, 240, 1, 100000),
  // 登录后只读接口按账号限流：客户端红点 60s 一次、页面按需拉取，正常玩远低于这个值。
  readRatePerMin: int(process.env.READ_RATE_PER_MIN, 300, 1, 1000000),
  // 同一账号两次动作的最小间隔：连点器不能把动作入口打成连发；
  // 与 240 次/分叠加（只算真正执行成功的动作，失败请求不占间隔，见 http.pace）。
  actionIntervalMs: int(process.env.ACTION_INTERVAL_MS, 80, 0, 60000),
  fightRatePerMin: int(process.env.FIGHT_RATE_PER_MIN, 60, 1, 10000),
  // 同一账号每分钟拉取对手候选的上限：客户端「换一批」远低于这个值；
  // 测试套件会用连续拉取找真人快照，可用环境变量放宽。
  opponentsRatePerMin: int(process.env.OPPONENTS_RATE_PER_MIN, 60, 1, 100000),
  // 同一账号两次开战的最小间隔：连点器/脚本不能把战斗入口当连发按钮。
  // 正常客户端一场战斗的播放远长于这个值；同一 idemKey 的断线重试不拦（见 http.pace）。
  fightIntervalMs: int(process.env.FIGHT_INTERVAL_MS, 2000, 0, 600000),
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 90 * 24 * 3600 * 1000, 60000, 365 * 86400000),
  allowOrigin: process.env.ALLOW_ORIGIN || '*',
  adminToken: process.env.ADMIN_TOKEN || '',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  allowBrowserDevices: bool(process.env.ALLOW_BROWSER_DEVICES, false),

  creatorDevices: String(process.env.CREATOR_DEVICES || '').split(',')
    .map((s) => s.trim().toLowerCase()).filter((s) => /^[a-f0-9]{64}$/.test(s)),

  ownerIps: String(process.env.OWNER_IPS || '').split(',')
    .map((s) => s.trim()).filter(Boolean),
  // 主人面板默认还要过创作者设备：只按 IP 会被同一 NAT / 本机反代放大成“谁都能看”。
  // 明确只信 IP（本地开发/单人服务器）时在 owner.env 里设 OWNER_IP_ONLY=true。
  ownerIpOnly: bool(process.env.OWNER_IP_ONLY, false),
  // 保守的初始注册阀值；须按实际机器压测结果调整。0 表示不设上限。
  registrationLimit: int(process.env.REGISTRATION_LIMIT, 1000, 0, 10000000),

  accountsPerDevice: int(process.env.ACCOUNTS_PER_DEVICE, 3, 1, 100),
  accountsPerIp: int(process.env.ACCOUNTS_PER_IP, 3, 0, 100),

  accountDailyLimit: int(process.env.ACCOUNT_DAILY_LIMIT, 5, 0, 1000),


  combatRetentionDays: int(process.env.COMBAT_RETENTION_DAYS, 7, 1, 3650),
  // 非天梯战斗只保留一个很短的重试窗口（客户端会本地缓存普通战斗录像）；
  combatMinorRetentionMinutes: int(process.env.COMBAT_MINOR_RETENTION_MINUTES, 60, 1, 10080),
  securityRetentionDays: int(process.env.SECURITY_RETENTION_DAYS, 90, 1, 3650),

  maintenanceIntervalMs: int(process.env.MAINTENANCE_INTERVAL_MS, 6 * 60 * 60 * 1000, 60 * 1000, 7 * 86400000),
  actionLogRetentionDays: int(process.env.ACTION_LOG_RETENTION_DAYS, 14, 1, 3650),
  messageRetentionDays: int(process.env.MESSAGE_RETENTION_DAYS, 30, 1, 3650),
  dailyCountsRetentionDays: int(process.env.DAILY_COUNTS_RETENTION_DAYS, 35, 1, 3650),
  chestRetentionDays: int(process.env.CHEST_RETENTION_DAYS, 30, 1, 3650),
  rankAwardRetentionDays: int(process.env.RANK_AWARD_RETENTION_DAYS, 90, 7, 3650),
  friendMessageRetentionDays: int(process.env.FRIEND_MESSAGE_RETENTION_DAYS, 180, 7, 3650),
  friendRequestRetentionDays: int(process.env.FRIEND_REQUEST_RETENTION_DAYS, 30, 1, 3650),
  campaignRoomRetentionDays: int(process.env.CAMPAIGN_ROOM_RETENTION_DAYS, 2, 1, 30),
  accountIpRetentionDays: int(process.env.ACCOUNT_IP_RETENTION_DAYS, 180, 7, 3650),
  // 自动备份：默认 6 小时一次，保留 7 天；路径默认在 dataDir/backup/auto。
  backupEnabled: bool(process.env.BACKUP_ENABLED, true),
  backupIntervalMs: int(process.env.BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000, 60 * 1000, 30 * 86400000),
  backupRetentionDays: int(process.env.BACKUP_RETENTION_DAYS, 7, 1, 365),
  backupMaxFiles: int(process.env.BACKUP_MAX_FILES, 56, 2, 5000),
  logLevel: process.env.LOG_LEVEL || 'info',
  // 打请求行（方法/路径/状态/耗时）—— 排查「客户端连没连上」时开，默认关。
  logRequests: bool(process.env.LOG_REQUESTS, false),
  dev: bool(process.env.DEV, false),
};

config.backupDir = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(config.dataDir, 'backup', 'auto');

// 赛季标识：YYYY-MM（按服务端时区算）。
function seasonId(nowMs) {
  if (config.season) return config.season;
  const d = new Date(nowMs || Date.now());
  const parts = seasonFormatter().formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month');
}

let dateFormatterCache = null;
function dateFormatter() {
  if (!dateFormatterCache) {
    dateFormatterCache = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return dateFormatterCache;
}

let seasonFormatterCache = null;
function seasonFormatter() {
  if (!seasonFormatterCache) {
    seasonFormatterCache = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit',
    });
  }
  return seasonFormatterCache;
}

// 日期串在请求里被调用很多次（每日重置、任务、天梯次数）。Intl formatter 每次新建约 0.03ms，
// 而同一秒内的结果必然相同；缓存 1 秒既不影响零点换日，也避免重复构造。
let localDateCache = { at: 0, key: '' };
function localDate(nowMs) {
  if (nowMs == null) {
    const t = Date.now();
    if (localDateCache.at && t - localDateCache.at < 1000) return localDateCache.key;
    const key = dateFormatter().format(new Date(t));
    localDateCache = { at: t, key };
    return key;
  }
  return dateFormatter().format(new Date(nowMs));
}

module.exports = { config, seasonId, localDate };
