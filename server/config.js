'use strict';
/* ============================================================
 * server/config.js — 运行期配置（全部可用环境变量覆盖）
 * ============================================================ */

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

const config = {
  /* HTTP */
  port: int(process.env.PORT, 3100, 1, 65535),
  bind: process.env.BIND || '127.0.0.1',
  /* 静态目录：联机版网页版直接由本服务发（部署时可交给 Caddy）。 */
  wwwRoot: process.env.WWW_ROOT ? path.resolve(process.env.WWW_ROOT) : path.join(ROOT),
  serveStatic: bool(process.env.SERVE_STATIC, true),

  /* 数据 */
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'save', 'online'),
  gameRoot: process.env.GAME_ROOT ? path.resolve(process.env.GAME_ROOT) : ROOT,

  /* 赛季 / 时区：每日重置按 Asia/Shanghai */
  timezone: process.env.TZ_NAME || 'Asia/Shanghai',
  season: process.env.SEASON || '',                 // 空 = 按 YYYY-MM 自动算

  /* 天梯每日场次（2026-11 用户口径：**不限上限**；前 10 场免费、11-20 每场 5 金松果、
   * 21 场起每场 10 金松果）。`rankDailyLimit = 0` 表示不限次数；想恢复上限就设成正数。 */
  rankDailyLimit: int(process.env.RANK_DAILY_LIMIT, 0, 0, 200),
  rankFreePlays: int(process.env.RANK_FREE_PLAYS, 10, 0, 200),
  rankPaidCost: int(process.env.RANK_PAID_COST, 5, 0, 1000),   // 第 11-20 场每场 5 金松果
  rankLateFrom: int(process.env.RANK_LATE_FROM, 20, 0, 200),   // 从第 21 场（played=20）起
  rankLateCost: int(process.env.RANK_LATE_COST, 10, 0, 1000),  // 第 21 场起每场 10 金松果
  rankWinCup: int(process.env.RANK_WIN_CUP, 3, 0, 100),
  rankLoseCup: int(process.env.RANK_LOSE_CUP, 1, 0, 100),
  rankRobCup: int(process.env.RANK_ROB_CUP, 3, 0, 100),
  rankRobChance: Number(process.env.RANK_ROB_CHANCE || 0.25),   // 主动获胜抢杯几率
  rankLoseExp: int(process.env.RANK_LOSE_EXP, 10, 0, 100000),
  rankWeeklyCup: int(process.env.RANK_WEEKLY_CUP, 50, 0, 10000),
  rankWeeklyTop: int(process.env.RANK_WEEKLY_TOP, 30, 1, 100000),

  /* 天梯赛区（原版 text7585「每10级一个赛区」，榜 f8 的 6 帧标签）：
   * 30-39 / 40-49 / 50-59 / 60-69 / 70-79 / 80-90。
   * 每个赛区固定 30 个人机（80-90 是 11 个等级 → 33 个），人机也进榜、也参与结算；
   * 每周一玩家积分减半、人机回到 `rankBotBaseScore`，人机积分另有 50 的硬下限。 */
  rankDivisions: [
    { key: 'd30', lo: 30, hi: 39, frame: 1, label: '30级-39级' },
    { key: 'd40', lo: 40, hi: 49, frame: 2, label: '40级-49级' },
    { key: 'd50', lo: 50, hi: 59, frame: 3, label: '50级-59级' },
    { key: 'd60', lo: 60, hi: 69, frame: 4, label: '60级-69级' },
    { key: 'd70', lo: 70, hi: 79, frame: 5, label: '70级-79级' },
    { key: 'd80', lo: 80, hi: 90, frame: 6, label: '80级-90级' },
  ],
  rankBotBaseScore: int(process.env.RANK_BOT_BASE_SCORE, 300, 0, 100000),  // 人机每周一回到 300 分
  rankBotPerLevel: int(process.env.RANK_BOT_PER_LEVEL, 3, 1, 10),          // 每个等级 3 个人机
  rankBotScale: Number(process.env.RANK_BOT_SCALE || 1.08),                // 与随机对手同一成长系数
  rankBotFloor: int(process.env.RANK_BOT_FLOOR, 50, 0, 100000),            // 人机积分硬下限
  /* 同一真人至少相隔 N 场才会再匹配到（用户 2026-11 口径：5 场）。 */
  rankRealRecentMatches: int(process.env.RANK_REAL_RECENT_MATCHES, 5, 0, 50),
  rankIntegralStart: int(process.env.RANK_INTEGRAL_START, 0, 0, 100000),
  rankIntegralFloor: int(process.env.RANK_INTEGRAL_FLOOR, 0, 0, 100000),

  /* 匹配 */
  opponentsPerRefresh: int(process.env.OPPONENTS_PER_REFRESH, 3, 1, 20),
  /* 随机挑战的「真人签 + 人机签」：每个可匹配真人占 1 个签，另外固定放 N 个空签
   * （抽到空签才用当前 genAI 算法造对手）。默认 30 个空签 → 单个真人每页约 3/31 ≈ 9.7%。
   * 真人被抽到后由 battle.js 的 random_refresh_exclusions 冷却 10 次刷新。 */
  randomBotSlots: int(process.env.RANDOM_BOT_SLOTS, 30, 1, 200),
  randomRealRecentRefreshes: int(process.env.RANDOM_REAL_RECENT_REFRESHES, 10, 0, 100),
  opponentLevelSpread: int(process.env.OPPONENT_LEVEL_SPREAD, 3, 0, 90),
  opponentRatingSpread: int(process.env.OPPONENT_RATING_SPREAD, 200, 0, 20000),
  opponentRefreshCooldownMs: int(process.env.OPPONENT_REFRESH_MS, 3000, 0, 600000),
  opponentIdleDays: int(process.env.OPPONENT_IDLE_DAYS, 14, 0, 3650),
  /* 天梯真人段起点（2026-11 用户口径：500 → 300）：同赛区真人 + 人机补位。
   * 到 N 分以后**人机候选位的权重降到 1/rankBotWeightDivisor**（默认 1/3），
   * 让高分玩家更容易匹配到真人；真人仍按每页名额先补满，人机只按缩小后的权重补位。
   * 以前 ≥N 分没有真人就回落一场「不计分的人机」，现在人机按正常天梯规则结算。 */
  rankRealMatchScoreLimit: int(process.env.RANK_REAL_MATCH_SCORE_LIMIT, 300, 0, 100000),
  /* 300 分以后人机候选位的权重分母：3 = 300 分前权重的 1/3（用户 2026-11 口径）。 */
  rankBotWeightDivisor: int(process.env.RANK_BOT_WEIGHT_DIVISOR, 3, 1, 50),

  /* 快照 */
  snapshotsPerLevel: int(process.env.SNAPSHOTS_PER_LEVEL, 3, 1, 50),

  /* 征战（4 人组队） */
  campaignMinLevel: int(process.env.CAMPAIGN_MIN_LEVEL, 35, 1, 90),
  /* 每天最多参加几次征战。原版是周二/四/六 21:00-23:00 + 每天 5 次；
   * 本服去掉时间窗，改成每天 3 次（用户 2026-11 口径）。 */
  campaignDailyLimit: int(process.env.CAMPAIGN_DAILY_LIMIT, 3, 1, 100),
  campaignPartySize: int(process.env.CAMPAIGN_PARTY_SIZE, 4, 2, 8),
  campaignRoomTtlMs: int(process.env.CAMPAIGN_ROOM_TTL_MS, 15 * 60 * 1000, 60000, 86400000),
  /* 真人匹配最长等待：5 分钟凑不满 4 人就判失败，**不扣门票、不扣每日次数**。
   * 玩家报名后可以离开界面，由客户端 watcher 轮询结果。 */
  campaignMatchWaitMs: int(process.env.CAMPAIGN_MATCH_WAIT_MS, 5 * 60 * 1000, 5000, 3600000),
  /* 随机匹配立即开打：助战座位抽 3 个（等级相近的玩家快照，抽不到就人机）。 */
  campaignRandomTeammates: int(process.env.CAMPAIGN_RANDOM_TEAMMATES, 3, 1, 7),
  /* 兼容旧环境变量；新逻辑不再按“到点少人开打”。保留字段只为旧部署脚本不报错。 */
  campaignFillMs: int(process.env.CAMPAIGN_FILL_MS, 45000, 5000, 600000),
  campaignTicketProp: int(process.env.CAMPAIGN_TICKET_PROP, 87, 0, 9999),
  campaignDiceMax: int(process.env.CAMPAIGN_DICE_MAX, 100, 1, 100000),
  campaignHouseCut: Number(process.env.CAMPAIGN_HOUSE_CUT || 0.1),

  /* 好友 */
  /* 原版 ssfight **没有好友数量上限**（`getFriends` 整份读入、4 行/页翻页；抓包见过 142 人）。
   * 这里的 50 是联机服务端**已有的防滥用安全线**：好友页把每个好友的战斗体随列表下发，
   * 50 是当前一次响应的预算（`server/api/social.js` 按这个数嵌 fighter）。
   * 单机版 `State.FRIEND_LIMIT` 用同一个数，避免出现「服务端 50 / 客户端 20」两套口径。
   * 上限也锁 50：再往上必须同步改 `js/state.js`（服务端动作要经过它），并把好友页
   * 改成分页/懒加载，不能只调环境变量。 */
  friendLimit: int(process.env.FRIEND_LIMIT, 50, 1, 50),

  /* 师徒：原版「师父每天得到徒弟经验的 10%」（ssfight text7843）；金松果没有原版数值，
   * 按用户 2026-10-29 口径固定为徒弟昨日金松果的 10%。只有真人徒弟产生日供。 */
  apprenticeCap: int(process.env.APPRENTICE_CAP, 3, 1, 10),
  apprenticeTributeExpRate: Number(process.env.APPRENTICE_TRIBUTE_EXP_RATE || 0.10),
  apprenticeTributeGoldRate: Number(process.env.APPRENTICE_TRIBUTE_GOLD_RATE || 0.10),
  apprenticeRecruitCost: int(process.env.APPRENTICE_RECRUIT_COST, 10, 0, 100000),
  apprenticeRecruitEnergy: int(process.env.APPRENTICE_RECRUIT_ENERGY, 10, 0, 100000),
  apprenticeLeaveCost: int(process.env.APPRENTICE_LEAVE_COST, 20, 0, 100000),

  /* 论坛：每日额度 / 容量硬上限 / 列表页大小 / 旧帖保留期。
   * 实测（2026-11，本机 SQLite，UTF-8 标题+正文）：1 万帖 + 3 万回复 ≈ 5.9 MB，
   * 折合约 0.3 KB/条。默认 3 万帖 + 30 万回复的硬上限 ≈ 100 MB 正文占用，
   * 相对服务器 50 GB 磁盘很小；真正的风险是刷屏把论坛糟蹋掉，所以还有
   * 每日 20 帖 / 100 回复 + 每分钟滑窗 + 账号注册额度三道闸。
   * `forumRetentionDays=0` 表示不自动删旧帖；设成正数后由 maintenance.js 清理。 */
  forumDailyPostLimit: int(process.env.FORUM_DAILY_POST_LIMIT, 20, 0, 1000),
  forumDailyReplyLimit: int(process.env.FORUM_DAILY_REPLY_LIMIT, 100, 0, 5000),
  forumMaxPosts: int(process.env.FORUM_MAX_POSTS, 30000, 100, 10000000),
  forumMaxReplies: int(process.env.FORUM_MAX_REPLIES, 300000, 100, 100000000),
  forumMaxRepliesPerPost: int(process.env.FORUM_MAX_REPLIES_PER_POST, 2000, 10, 100000),
  forumWarnPercent: int(process.env.FORUM_WARN_PERCENT, 80, 1, 100),
  forumPageSize: int(process.env.FORUM_PAGE_SIZE, 15, 5, 50),
  forumRetentionDays: int(process.env.FORUM_RETENTION_DAYS, 0, 0, 3650),
  forumAdminLogRetentionDays: int(process.env.FORUM_ADMIN_LOG_RETENTION_DAYS, 365, 7, 3650),
  /* 全服论坛写速率（所有账号合计），防止批量小号绕开单账号限流。 */
  forumGlobalPostsPerMin: int(process.env.FORUM_GLOBAL_POSTS_PER_MIN, 60, 1, 100000),
  forumGlobalRepliesPerMin: int(process.env.FORUM_GLOBAL_REPLIES_PER_MIN, 300, 1, 100000),
  /* 创始管理员按玩家编号（player_ids.player_id）认；逗号分隔。
   * 默认 100000 是服务器主人的第一个账号。只在论坛第一次初始化时种入一次。 */
  forumFounderPlayerIds: String(process.env.FORUM_FOUNDER_PLAYER_IDS || '100000').split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0),

  /* 安全 */
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
  actionRatePerMin: int(process.env.ACTION_RATE_PER_MIN, 240, 1, 100000),
  fightRatePerMin: int(process.env.FIGHT_RATE_PER_MIN, 60, 1, 10000),
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 90 * 24 * 3600 * 1000, 60000, 365 * 86400000),
  allowOrigin: process.env.ALLOW_ORIGIN || '*',
  adminToken: process.env.ADMIN_TOKEN || '',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  allowBrowserDevices: bool(process.env.ALLOW_BROWSER_DEVICES, false),
  /* 创作者设备白名单：只认设备指纹 `sha256(platform + '\0' + id)`，不认 IP（IP 会被 NAT/动态地址影响）。
   * 命中的设备可以绕过浏览器端限制、注册名额与「一台设备一个账号」的绑定，用于服务器主人
   * 在同一台机器上批量建测试号；逗号分隔，非法项忽略。 */
  creatorDevices: String(process.env.CREATOR_DEVICES || '').split(',')
    .map((s) => s.trim().toLowerCase()).filter((s) => /^[a-f0-9]{64}$/.test(s)),
  /* 服务器主人的公网 IP：只用于「设置 → 一键同步更改」这类自更新按钮的可见性。
   * 只认 TCP 对端地址（`clientIp`；TRUST_PROXY=false 时不看 X-Forwarded-For），
   * 逗号分隔，IPv4 / IPv6 都可以；空 = 所有人都不显示。 */
  ownerIps: String(process.env.OWNER_IPS || '').split(',')
    .map((s) => s.trim()).filter(Boolean),
  /* 保守的初始注册阀值；须按实际机器压测结果调整。0 表示不设上限。 */
  registrationLimit: int(process.env.REGISTRATION_LIMIT, 1000, 0, 10000000),
  /* 一台设备 / 一个 IP 最多能**创建**几个账号（登录已有账号不占额度）。
   * 设备按 x-device-id 指纹认；IP 是注册时的来源地址。创作者设备不受限。
   * `ACCOUNTS_PER_IP=0` 表示只限设备、不按 IP 限（共享 NAT 的服可这样关掉）。 */
  accountsPerDevice: int(process.env.ACCOUNTS_PER_DEVICE, 3, 1, 100),
  accountsPerIp: int(process.env.ACCOUNTS_PER_IP, 3, 0, 100),

  /* 审计 */
  combatRetentionDays: int(process.env.COMBAT_RETENTION_DAYS, 7, 1, 3650),
  /* 非天梯战斗只保留一个很短的重试窗口（客户端会本地缓存普通战斗录像）；
   * 天梯战报才按 combatRetentionDays 保留。 */
  combatMinorRetentionMinutes: int(process.env.COMBAT_MINOR_RETENTION_MINUTES, 60, 1, 10080),
  securityRetentionDays: int(process.env.SECURITY_RETENTION_DAYS, 90, 1, 3650),
  /* 追加型表的保留期：这些表以前只增不删（action_log / messages / ratings / chests …），
   * 好友服跑久了会拖慢启动与查询。见 `server/game/maintenance.js`。 */
  maintenanceIntervalMs: int(process.env.MAINTENANCE_INTERVAL_MS, 6 * 60 * 60 * 1000, 60 * 1000, 7 * 86400000),
  actionLogRetentionDays: int(process.env.ACTION_LOG_RETENTION_DAYS, 14, 1, 3650),
  messageRetentionDays: int(process.env.MESSAGE_RETENTION_DAYS, 90, 1, 3650),
  dailyCountsRetentionDays: int(process.env.DAILY_COUNTS_RETENTION_DAYS, 35, 1, 3650),
  chestRetentionDays: int(process.env.CHEST_RETENTION_DAYS, 30, 1, 3650),
  rankAwardRetentionDays: int(process.env.RANK_AWARD_RETENTION_DAYS, 90, 7, 3650),
  friendMessageRetentionDays: int(process.env.FRIEND_MESSAGE_RETENTION_DAYS, 180, 7, 3650),
  friendRequestRetentionDays: int(process.env.FRIEND_REQUEST_RETENTION_DAYS, 30, 1, 3650),
  campaignRoomRetentionDays: int(process.env.CAMPAIGN_ROOM_RETENTION_DAYS, 2, 1, 30),
  accountIpRetentionDays: int(process.env.ACCOUNT_IP_RETENTION_DAYS, 180, 7, 3650),
  /* 自动备份：默认 6 小时一次，保留 7 天；路径默认在 dataDir/backup/auto。 */
  backupEnabled: bool(process.env.BACKUP_ENABLED, true),
  backupIntervalMs: int(process.env.BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000, 60 * 1000, 30 * 86400000),
  backupRetentionDays: int(process.env.BACKUP_RETENTION_DAYS, 7, 1, 365),
  backupMaxFiles: int(process.env.BACKUP_MAX_FILES, 56, 2, 5000),
  logLevel: process.env.LOG_LEVEL || 'info',
  /** 打请求行（方法/路径/状态/耗时）—— 排查「客户端连没连上」时开，默认关。 */
  logRequests: bool(process.env.LOG_REQUESTS, false),
  dev: bool(process.env.DEV, false),
};

/* 备份目录放在 DATA_DIR 下，systemd 的 ReadWritePaths 已覆盖整个 /var/lib/ssdz。 */
config.backupDir = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(config.dataDir, 'backup', 'auto');

/** 赛季标识：YYYY-MM（按服务端时区算）。 */
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

/* 日期串在请求里被调用很多次（每日重置、任务、天梯次数）。Intl formatter 每次新建约 0.03ms，
 * 而同一秒内的结果必然相同；缓存 1 秒既不影响零点换日，也避免重复构造。 */
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
