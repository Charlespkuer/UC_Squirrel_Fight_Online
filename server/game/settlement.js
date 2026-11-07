'use strict';
/* ============================================================
 * server/game/settlement.js — 天梯结算 / 赛区 / 人机 / 周重置 / 周奖励
 * ------------------------------------------------------------
 * 数值口径：基础规则参考原版《松鼠数据表》，积分档位为 2026-11 用户定制口径，不是 ELO。
 *   · 每日场次**不限**；前 10 场免费，第 11~20 场每场 5 金松果，第 21 场起每场 10 金松果；
 *   · 主动获胜 3 金杯、失败 1 金杯；被动方（防守）获胜 3 金杯、失败 1 金杯；
 *   · 积分档位（2026-11 用户口径，按**主动方**相对**被动方**的积分差）：
 *       主动方高于被动方 0-50 / 51-100 / 101-200 / 201-500 / 501+
 *         → ±14~17 / ±10~15 / ±7~12 / ±5~10 / ±1~2；
 *       主动方低于被动方 1-50 / 51-100 / 101-300 / 301+
 *         → ±15~18 / ±16~19 / ±17~20 / ±20~25；
 *     每场只掷一次，**只对挑战方生效**：主动方赢加、输减（0/100000 边界压缩实际变化量）；
 *     被动方（真人或人机）**固定 ±1 分**：挑战方赢 → 防守方 -1，挑战方输 → 防守方 +1
 *     （到 0/下限或 100000 上限时压成 0）。所以双方不再零和 —— 被挑战的人不会被反复刷分
 *     或打掉大段积分（用户 2026-11 口径）。
 *   · 主动获胜有几率抢对方 3 金杯（防守方真实扣掉，金杯仍零和）；
 *   · 赛区前 30 名每周 50 金杯（服务端按周记录，防重复领取）。
 *
 * **赛区（2026-11 用户口径，对齐原版 `text7585`「每10级一个赛区」）**：
 *   · 30-39 / 40-49 / 50-59 / 60-69 / 70-79 / 80-90 共 6 个赛区；
 *   · 玩家只能看自己赛区的榜、只能和自己赛区的人/人机打；
 *   · 积分**每周一 00:00 减半**：`ratings.season` 直接存周一日期，换周时把上一周的
 *     分数除以 2（隔了几周就除几次）写进新行；
 *   · 每个赛区每级 3 个人机（80-90 共 33 个），人机也进榜、也参与积分结算，
 *     每周一 00:00 回到 300 分，且积分有 **50 的硬下限**；玩家要进前 30 必须至少超过一个人机。
 *     300 分以后人机候选位的权重降到 1/3（`config.rankBotWeightDivisor`，见 `opponents.js`）。
 * ============================================================ */

const db = require('../db');
const { config, localDate } = require('../config');

/* ---------------- 赛区 ---------------- */

const DIVISIONS = Object.freeze((config.rankDivisions || []).map((d) => Object.freeze({
  key: String(d.key), lo: Number(d.lo), hi: Number(d.hi), frame: Number(d.frame), label: String(d.label || ''),
})));

/* 进程内缓存：同一周只补一次人机。服务端是单进程（见 db.js 的 WAL 说明），
 * 所以不需要跨进程失效；换周时 `weekKey()` 变化会让缓存自动失效。 */
let botsReadyWeek = '';

/** 等级 → 赛区；30 级以下没有赛区（天梯也打不了）。 */
function divisionOf(level) {
  const lv = Math.floor(Number(level) || 0);
  return DIVISIONS.find((d) => lv >= d.lo && lv <= d.hi) || null;
}

function levelOf(accountId) {
  const row = db.get('SELECT level FROM saves WHERE account_id = ? AND mode = ?', Number(accountId), 'classic');
  return Math.max(0, Number(row && row.level) || 0);
}

function divisionOfAccount(accountId) {
  return divisionOf(levelOf(accountId));
}

/* ---------------- 周 / 积分 ---------------- */

/** 一周的标识（周一为起点，按服务端时区）。天梯积分挂在周上：换周时减半。 */
let weekFormatterCache = null;
let weekCache = { at: 0, key: '' };
function weekFormatter() {
  if (!weekFormatterCache) {
    weekFormatterCache = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    });
  }
  return weekFormatterCache;
}
function weekKey(nowMs) {
  /* 一周只会变一次；同一 5 秒内所有请求共用结果，省掉每次 new Intl + formatToParts。
   * 不缓存太久：周一 00:00 的换周结算最多延迟 5 秒，而不是一分钟。 */
  if (nowMs == null) {
    const t = Date.now();
    if (weekCache.at && t - weekCache.at < 5 * 1000) return weekCache.key;
    const key = weekKeyOf(t);
    weekCache = { at: t, key };
    return key;
  }
  return weekKeyOf(nowMs);
}

function weekKeyOf(nowMs) {
  const parts = weekFormatter().formatToParts(new Date(nowMs || Date.now()));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = Number(get('year')), m = Number(get('month')), d = Number(get('day'));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')] || 1;
  const base = Date.UTC(y, m - 1, d) - (dow - 1) * 86400000;
  const dt = new Date(base);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

/* ---------------- 周结算（每周一 00:00：玩家积分减半，人机回到 300） ---------------- */

function metaGet(key) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', String(key));
  return row ? String(row.value) : '';
}

function metaSet(key, value) {
  db.run('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key), String(value));
}

/** 两个周标识之间隔了几周（都是周一日期，至少按 1 周算）。 */
function weeksBetween(from, to) {
  const a = Date.parse(String(from) + 'T00:00:00Z');
  const b = Date.parse(String(to) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / (7 * 86400000)));
}

/**
 * 本周第一次访问时做一次周结算：
 *  · 上周有分、本周还没露面的玩家 → 新行 = ⌊上周分 / 2^n⌋（n = 隔了几周），胜负清零；
 *  · 人机由 `ensureBots()` 统一回到 300（带 50 硬下限）；
 *  · 写 `meta.rank_week`，同一周不再重复搬数据。
 */
function rollWeekIfNeeded(week) {
  const w = week || weekKey();
  if (metaGet('rank_week') === w) return 0;
  let rolled = 0;
  db.tx(() => {
    const owners = db.all('SELECT account_id, MAX(season) AS last FROM ratings WHERE season < ? GROUP BY account_id', w);
    for (const owner of owners) {
      const id = Number(owner.account_id);
      if (db.get('SELECT 1 AS x FROM ratings WHERE account_id = ? AND season = ?', id, w)) continue;
      const prev = db.get('SELECT score FROM ratings WHERE account_id = ? AND season = ?', id, String(owner.last));
      const div = Math.pow(2, weeksBetween(owner.last, w));
      const score = clampScore(Math.floor((Number(prev && prev.score) || 0) / div));
      db.run('INSERT INTO ratings (account_id, season, score, wins, losses, streak, best_rank, updated_at) VALUES (?,?,?,0,0,0,0,?)',
        id, w, score, Date.now());
      /* 换周后只留本周行：`ratings` 以前每个账号每周一行、只增不删，`MAX(season) GROUP BY`
       * 的搬迁查询会随历史线性变慢。旧周的分数已经折算进本周，没有回查需求。 */
      db.run('DELETE FROM ratings WHERE account_id = ? AND season < ?', id, w);
      rolled += 1;
    }
    metaSet('rank_week', w);
  });
  ensureBots(w);
  return rolled;
}

/** 所有天梯读写入口的周检查：每周只搬一次数据（`meta.rank_week` 是幂等标记）。 */
function weekTick() {
  const w = weekKey();
  if (metaGet('rank_week') === w) return 0;
  return rollWeekIfNeeded(w);
}

function ensureRating(accountId, week) {
  weekTick();
  const w = week || weekKey();
  let row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), w);
  if (!row) {
    db.run('INSERT INTO ratings (account_id, season, score, wins, losses, streak, best_rank, updated_at) VALUES (?,?,?,0,0,0,0,?)',
      Number(accountId), w, config.rankIntegralStart, Date.now());
    row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), w);
  }
  return row;
}

function ratingOf(accountId, week) {
  const row = ensureRating(accountId, week);
  return Number(row.score) || config.rankIntegralStart;
}

/** 只读别人的分：没有本周行就是 0（不替别人建行）。 */
function scoreOf(accountId, week) {
  const row = db.get('SELECT score FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), week || weekKey());
  return row ? Math.max(0, Number(row.score) || 0) : 0;
}

/** 把权威天梯积分写进存档镜像。登录、摘要、幂等重试返回的 `save` 都必须走这一条，
 *  否则调用方会看到「ratings 0 分 / 存档里还是旧 1500」的两份数。 */
function syncIntegral(accountId, save) {
  if (save && typeof save === 'object') save.integral = ratingOf(accountId);
  return save;
}

/* ---------------- 赛区人机 ---------------- */

const BOT_NAMES = Object.freeze([
  '松果见习生', '橡子巡逻员', '树洞守卫', '月光拾荒者', '雾林邮差', '坚果学徒',
  '古树见习', '溪谷哨兵', '星屑旅人', '雪原新兵', '苔原猎手', '树冠信使',
]);

/** 固定的赛区人机名册：每个等级 3 个，名字带等级后缀（榜上只有三列，靠等级区分）。 */
function botPlan() {
  const out = [];
  let idx = 0;
  for (const d of DIVISIONS) {
    for (let lv = d.lo; lv <= d.hi; lv++) {
      for (let k = 0; k < config.rankBotPerLevel; k++) {
        idx += 1;
        out.push({
          id: 'bot:' + d.key + ':' + lv + ':' + k,
          division: d.key, level: lv, idx,
          name: BOT_NAMES[(idx - 1) % BOT_NAMES.length] + '·' + lv,
        });
      }
    }
  }
  return out;
}

/** 每周一次：人机分数回到 300、胜负清零；缺的行补上。幂等。 */
function ensureBots(week) {
  const w = week || weekKey();
  /* `botsFor` / `botById` / `divisionRows` 每次读榜都会进来；同一周重复跑
   * “UPDATE + 全表 SELECT + 99 条 INSERT OR IGNORE”没有意义。
   * 用一行 `week` 做廉价的「别处是否重置过」校验，测试/运维手改库也能生效。 */
  if (botsReadyWeek === w) {
    const row = db.get('SELECT week FROM rank_bots LIMIT 1');
    if (row && String(row.week) === w) return w;
    botsReadyWeek = '';
  }
  const base = config.rankBotBaseScore;
  db.tx(() => {
    db.run('UPDATE rank_bots SET week = ?, score = ?, wins = 0, losses = 0, updated_at = ? WHERE week <> ?',
      w, base, Date.now(), w);
    const have = new Set(db.all('SELECT id FROM rank_bots').map((r) => String(r.id)));
    for (const bot of botPlan()) {
      if (have.has(bot.id)) continue;
      db.run(
        `INSERT OR IGNORE INTO rank_bots (id, division, level, idx, name, week, score, wins, losses, updated_at)
         VALUES (?,?,?,?,?,?,?,0,0,?)`,
        bot.id, bot.division, bot.level, bot.idx, bot.name, w, base, Date.now()
      );
    }
  });
  botsReadyWeek = w;
  return w;
}

function botsFor(divisionKey) {
  ensureBots();
  return db.all('SELECT * FROM rank_bots WHERE division = ? ORDER BY idx ASC', String(divisionKey));
}

function botById(id) {
  const key = String(id || '');
  if (!key) return null;
  ensureBots();
  return db.get('SELECT * FROM rank_bots WHERE id = ?', key) || null;
}

/** 人机结算：人机作为**防守方**和真人一样只固定 ±1（`rankDefenderDelta` 的结果）。
 *  `botDelta` 是已算好的带符号变化量（挑战方赢 → -1，挑战方输 → +1）；
 *  人机积分有 `rankBotFloor`（默认 50）的硬下限，玩家怎么看都不会低于它。 */
function applyBotResult(botId, playerWin, botDelta) {
  const bot = botById(botId);
  if (!bot) return null;
  const delta = Math.round(Number(botDelta) || 0);
  const floor = Math.max(0, Number(config.rankBotFloor) || 0);
  const score = Math.max(floor, Math.min(MAX_SCORE, Math.round(Number(bot.score) + delta)));
  db.run('UPDATE rank_bots SET score = ?, wins = wins + ?, losses = losses + ?, updated_at = ? WHERE id = ?',
    score, playerWin ? 0 : 1, playerWin ? 1 : 0, Date.now(), String(bot.id));
  return { id: String(bot.id), score, wins: Number(bot.wins) + (playerWin ? 0 : 1), losses: Number(bot.losses) + (playerWin ? 1 : 0) };
}

/** 最近的真人对手（同一个人至少隔 `rankRealRecentMatches` 场才会再匹配到）。
 *  先取最近 N 场天梯（人机场也算一场），再从中挑出真人 —— 这样「相隔 5 场」是**按场次**算的。 */
function recentRealOpponents(accountId, limit) {
  const n = Math.max(0, Math.floor(Number(limit) || 0));
  if (!n) return [];
  const rows = db.all(
    `SELECT defender_id FROM combats
      WHERE attacker_id = ? AND kind = 'rank'
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    Number(accountId), n
  );
  return [...new Set(rows.map((r) => Number(r.defender_id)).filter((id) => id > 0))];
}

/* ---------------- 赛区榜 ---------------- */

function compareRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (!!a.bot !== !!b.bot) return a.bot ? 1 : -1;   // 同分同胜场：真人排在人机前面
  if (a.bot) return String(a.botId).localeCompare(String(b.botId));
  return Number(a.accountId) - Number(b.accountId);
}

/** 一个赛区的完整榜（真人当前周行 + 该赛区人机），按名次排好。 */
function divisionRows(division) {
  const d = division || null;
  if (!d) return [];
  const w = ensureBots();
  const players = db.all(
    `SELECT r.account_id, r.score, r.wins, r.losses, a.name, a.tag, sv.level
       FROM ratings r
       JOIN accounts a ON a.id = r.account_id
       JOIN saves sv ON sv.account_id = r.account_id AND sv.mode = 'classic'
      WHERE r.season = ? AND a.banned = 0
        AND sv.level BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = r.account_id)`,
    w, d.lo, d.hi
  );
  const rows = players.map((r) => ({
    bot: false, botId: '', accountId: Number(r.account_id), name: String(r.name),
    tag: String(r.tag || ''), level: Number(r.level) || 0,
    score: Number(r.score) || 0, wins: Number(r.wins) || 0, losses: Number(r.losses) || 0,
  }));
  for (const b of botsFor(d.key)) {
    rows.push({
      bot: true, botId: String(b.id), accountId: 0, name: String(b.name), tag: '',
      level: Number(b.level), score: Number(b.score) || 0,
      wins: Number(b.wins) || 0, losses: Number(b.losses) || 0,
    });
  }
  rows.sort(compareRows);
  rows.forEach((row, i) => { row.rank = i + 1; });
  return rows;
}

/** 我的赛区名次（1 起，含人机）。30 级以下 / 本周没有行 → 0。 */
function rankOf(accountId) {
  const row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), weekKey());
  if (!row) return 0;
  const div = divisionOfAccount(accountId);
  if (!div) return 0;
  const rows = divisionRows(div);
  const i = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  return i >= 0 ? i + 1 : 0;
}

function clampScore(score) {
  return Math.max(config.rankIntegralFloor, Math.min(MAX_SCORE, Math.round(Number(score) || 0)));
}

/** 积分变化档（2026-11 用户口径）。正数 = 主动方涨。
 *  只按**主动方（挑战者）相对于被动方（防守方）**的积分差取档；
 *  主动方赢 +mag、输 -mag；防守方**固定 ±1**（见 `rankDeltaPair` / `rankDefenderDelta`）。
 *  可选 `roll` 传入 0~1 的随机数，便于测试边界；默认 Math.random()。 */
const MAX_SCORE = 100000;

function integralMagnitude(attackerScore, defenderScore, roll) {
  const diff = Math.round(Number(attackerScore) || 0) - Math.round(Number(defenderScore) || 0);
  let lo, hi;
  if (diff >= 0) {
    if (diff <= 50) { lo = 14; hi = 17; }
    else if (diff <= 100) { lo = 10; hi = 15; }
    else if (diff <= 200) { lo = 7; hi = 12; }
    else if (diff <= 500) { lo = 5; hi = 10; }
    else { lo = 1; hi = 2; }
  } else {
    const ahead = -diff;
    if (ahead <= 50) { lo = 15; hi = 18; }
    else if (ahead <= 100) { lo = 16; hi = 19; }
    else if (ahead <= 300) { lo = 17; hi = 20; }
    else { lo = 20; hi = 25; }
  }
  const r = typeof roll === 'function' ? Number(roll()) : (roll == null ? Math.random() : Number(roll));
  const t = Number.isFinite(r) ? Math.max(0, Math.min(0.999999999, r)) : 0;
  return lo + Math.floor(t * (hi - lo + 1));
}

/** 兼容旧接口：主动方赢 +mag / 输 -mag；不处理上下限。 */
function integralDelta(attackerScore, defenderScore, attackerWin, roll) {
  const mag = integralMagnitude(attackerScore, defenderScore, roll);
  return attackerWin ? mag : -mag;
}

/** 防守方（真人或赛区人机）的固定变化（用户 2026-11 口径）：
 *  挑战方赢 → 防守方 **-1**；挑战方输 → 防守方 **+1**；
 *  防守方已经贴在下限（真人 0 / 人机 50）或上限 100000 时压成 0。
 *  `floor` 不传就用 `rankIntegralFloor`（真人）；赛区人机传 `rankBotFloor`。 */
function rankDefenderDelta(defenderScore, attackerWin, floor) {
  const foe = Math.round(Number(defenderScore) || 0);
  const lo = Number.isFinite(Number(floor)) ? Number(floor) : config.rankIntegralFloor;
  if (attackerWin) return foe - 1 >= lo ? -1 : 0;
  return foe + 1 <= MAX_SCORE ? 1 : 0;
}

/** 一场战斗的双方变化（用户 2026-11 口径）：**积分得失只对挑战方生效**。
 *  · 主动方：按积分差掷一次档位 ±mag，赢不超过 100000、输不低于 `rankIntegralFloor`；
 *  · 被动方（真人或人机）：固定 ±1（`rankDefenderDelta`），到边界压成 0；
 *  · 两边不再零和 —— 被挑战的人不会被反复挑战刷分或打掉大段积分。
 *  `defenderFloor` 只给赛区人机传 `rankBotFloor`；真人防守方走默认下限。 */
function rankDeltaPair(attackerScore, defenderScore, attackerWin, roll, defenderFloor) {
  const my = Math.round(Number(attackerScore) || 0);
  const foe = Math.round(Number(defenderScore) || 0);
  const desired = integralMagnitude(my, foe, roll);
  const attackerDelta = attackerWin
    ? Math.max(0, Math.min(desired, MAX_SCORE - my))
    : -Math.max(0, Math.min(desired, my - config.rankIntegralFloor));
  return {
    magnitude: desired,
    attackerDelta,
    defenderDelta: rankDefenderDelta(foe, attackerWin, defenderFloor),
  };
}

function todayCount(accountId, kind) {
  const row = db.get('SELECT count FROM daily_counts WHERE account_id = ? AND kind = ? AND date = ?',
    Number(accountId), String(kind), localDate());
  return row ? Number(row.count) : 0;
}

function bumpDaily(accountId, kind, n) {
  const date = localDate();
  db.run(
    `INSERT INTO daily_counts (account_id, kind, date, count) VALUES (?,?,?,?)
     ON CONFLICT(account_id, kind, date) DO UPDATE SET count = count + excluded.count`,
    Number(accountId), String(kind), date, Math.max(0, Math.round(Number(n) || 0))
  );
  return todayCount(accountId, kind);
}

/** 退回一次每日计数（退票/房间过期用）；不会低于 0。 */
function refundDaily(accountId, kind, n) {
  const date = localDate();
  const amount = Math.max(0, Math.round(Number(n) || 0));
  if (amount > 0) {
    db.run('UPDATE daily_counts SET count = MAX(0, count - ?) WHERE account_id = ? AND kind = ? AND date = ?',
      amount, Number(accountId), String(kind), date);
  }
  return todayCount(accountId, kind);
}

/** 下一场要多少金松果：前 10 场免费、11-20 场 5 金、21 场起 10 金。
 *  每日次数**不限**（用户 2026-11 口径），所以这里不再有「打满就免费/`limit`」的分支。 */
function rankCostAt(played) {
  const n = Math.max(0, Math.floor(Number(played) || 0));
  if (n < config.rankFreePlays) return 0;
  return n >= config.rankLateFrom ? config.rankLateCost : config.rankPaidCost;
}

/** 天梯当日状态：已打几场、还剩几场、这一场要不要花金松果（含档位起点，给错误文案用）。
 *  `limit = 0` / `unlimited: true` 表示**不限次数**，此时 `left` 为 null。 */
function rankDailyStatus(accountId) {
  const played = todayCount(accountId, 'rank');
  const limit = Math.max(0, Math.floor(Number(config.rankDailyLimit) || 0));
  const unlimited = limit <= 0;
  const freeLeft = Math.max(0, config.rankFreePlays - played);
  const cost = rankCostAt(played);
  const late = played >= config.rankLateFrom;
  return {
    played,
    limit,
    unlimited,
    left: unlimited ? null : Math.max(0, limit - played),
    freeLeft,
    cost,
    tier: cost === 0 ? 'free' : (late ? 'late' : 'paid'),
    tierStart: cost === 0 ? 0 : (late ? config.rankLateFrom + 1 : config.rankFreePlays + 1),
    date: localDate(),
  };
}

/** 周奖励：本赛区前 30 名，并且至少超过一个人机；一周一次。 */
function rankAwardStatus(accountId) {
  const week = weekKey();
  const rating = ensureRating(accountId, week);
  const div = divisionOfAccount(accountId);
  const rows = div ? divisionRows(div) : [];
  const myIdx = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  const played = Math.max(0, Number(rating.wins) || 0) + Math.max(0, Number(rating.losses) || 0);
  const surpassedBot = myIdx >= 0 && rows.slice(myIdx + 1).some((r) => r.bot);
  const claimed = db.get('SELECT * FROM rank_awards WHERE account_id = ? AND week = ?', Number(accountId), week);
  return {
    week, season: week, rank, played, surpassedBot,
    division: div ? { key: div.key, lo: div.lo, hi: div.hi, frame: div.frame, label: div.label } : null,
    eligible: played > 0 && rank > 0 && rank <= config.rankWeeklyTop && surpassedBot,
    cups: config.rankWeeklyCup,
    claimed: !!claimed,
    claimedCups: claimed ? Number(claimed.cups) : 0,
  };
}

function claimRankAward(accountId) {
  const week = weekKey();
  const rating = ensureRating(accountId, week);
  const played = Math.max(0, Number(rating.wins) || 0) + Math.max(0, Number(rating.losses) || 0);
  if (played <= 0) return { ok: false, msg: '本周还没有参加天梯赛，先打一场再来领奖吧。', rank: 0 };
  const div = divisionOfAccount(accountId);
  const rows = div ? divisionRows(div) : [];
  const myIdx = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  if (!(rank > 0) || rank > config.rankWeeklyTop) {
    return { ok: false, msg: '本周没有进入赛区前' + config.rankWeeklyTop + '名，暂时没有金杯奖励。', rank };
  }
  if (!rows.slice(myIdx + 1).some((r) => r.bot)) {
    return { ok: false, msg: '还没有超过任何一个赛区人机，暂时没有金杯奖励。', rank };
  }
  const exists = db.get('SELECT * FROM rank_awards WHERE account_id = ? AND week = ?', Number(accountId), week);
  if (exists) return { ok: false, msg: '本周的天梯奖励已经领取过了。', already: true, rank };
  try {
    db.run('INSERT INTO rank_awards (account_id, week, rank, cups, created_at) VALUES (?,?,?,?,?)',
      Number(accountId), week, rank, config.rankWeeklyCup, Date.now());
  } catch (_) {
    /* 并发重试：唯一键已存在就是领过了，不再发第二份。 */
    return { ok: false, msg: '本周的天梯奖励已经领取过了。', already: true, rank };
  }
  return { ok: true, rank, cups: config.rankWeeklyCup, msg: '恭喜进入赛区前' + config.rankWeeklyTop + '名，成功获得' + config.rankWeeklyCup + '个金杯奖励！' };
}

/** 赛区榜（前 N 名 + 我）。30 级以下返回空榜。 */
function ladder(accountId, limit) {
  ensureBots();
  const week = weekKey();
  const mine = ensureRating(accountId, week);
  const div = divisionOfAccount(accountId);
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const meBase = {
    score: Number(mine.score) || 0, wins: Number(mine.wins) || 0, losses: Number(mine.losses) || 0,
    streak: Number(mine.streak) || 0, rank: 0, level: levelOf(accountId),
  };
  if (!div) return { week, season: week, division: null, frame: 0, label: '', top: [], me: meBase };
  const rows = divisionRows(div);
  const myIdx = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  const top = rows.slice(0, n).map((r) => Object.assign({}, r));
  return {
    week, season: week,
    division: { key: div.key, lo: div.lo, hi: div.hi, frame: div.frame, label: div.label },
    frame: div.frame, label: div.label,
    top, me: Object.assign({}, meBase, { rank: myIdx >= 0 ? myIdx + 1 : 0 }),
  };
}

module.exports = {
  DIVISIONS, divisionOf, divisionOfAccount, levelOf,
  ensureRating, ratingOf, scoreOf, syncIntegral, rankOf, integralDelta, rankDeltaPair, rankDefenderDelta,
  clampScore,
  todayCount, bumpDaily, refundDaily, rankDailyStatus, weekKey, weekTick, rollWeekIfNeeded,
  rankAwardStatus, claimRankAward,
  ensureBots, botPlan, botsFor, botById, applyBotResult, divisionRows,
  recentRealOpponents, ladder,
};
