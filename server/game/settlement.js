'use strict';
// server/game/settlement.js — 天梯结算 / 赛区 / 人机 / 周重置 / 周奖励
// （到 0/下限或 100000 上限时压成 0）。所以双方不再零和 —— 被挑战的人不会被反复刷分
// · 换周时冻结上周日 23:59 的最终名次（rank_finals），下周按这份快照发前 30 名周奖。

const db = require('../db');
const visibility = require('./visibility');
const { config, localDate } = require('../config');

const DIVISIONS = Object.freeze((config.rankDivisions || []).map((d) => Object.freeze({
  key: String(d.key), lo: Number(d.lo), hi: Number(d.hi), frame: Number(d.frame), label: String(d.label || ''),
})));

// 进程内缓存：同一周只补一次人机。服务端是单进程（见 db.js 的 WAL 说明），
// 所以不需要跨进程失效；换周时 `weekKey()` 变化会让缓存自动失效。
let botsReadyWeek = '';
// 换周过程里会回调 `ensureBots`；用这个标记避免“补人机 → 再换周”的递归。
let rolling = false;

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

// 一周的标识（周一为起点，按服务端时区）。天梯积分挂在周上：换周时减半。
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
  // 一周只会变一次；同一 5 秒内所有请求共用结果，省掉每次 new Intl + formatToParts。
  // 不缓存太久：周一 00:00 的换周结算最多延迟 5 秒，而不是一分钟。
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

function metaGet(key) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', String(key));
  return row ? String(row.value) : '';
}

function metaSet(key, value) {
  db.run('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key), String(value));
}

function weeksBetween(from, to) {
  const a = Date.parse(String(from) + 'T00:00:00Z');
  const b = Date.parse(String(to) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / (7 * 86400000)));
}

function previousWeekKey(week) {
  const t = Date.parse(String(week || '') + 'T00:00:00Z');
  if (!Number.isFinite(t)) return '';
  return new Date(t - 7 * 86400000).toISOString().slice(0, 10);
}

// 换周前按旧周实时数据算一份“周日 23:59 的最终名次”；不能复用 `divisionRows()`，
// 它一进来就先 `ensureBots()`，会把人机分数先重置成新周。
function finalRows(week, division, includeHidden) {
  const hiddenSql = visibility.hiddenSqlFor('r.account_id', includeHidden);
  const hiddenParams = visibility.hiddenParamsFor(includeHidden);
  const players = db.all(
    `SELECT r.account_id, r.score, r.wins, r.losses, a.name, a.tag, sv.level
       FROM ratings r
       JOIN accounts a ON a.id = r.account_id
       JOIN saves sv ON sv.account_id = r.account_id AND sv.mode = 'classic'
      WHERE r.season = ? AND a.banned = 0
        AND sv.level BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = r.account_id)
        AND ${hiddenSql}`,
    week, division.lo, division.hi, ...hiddenParams
  );
  const rows = players.map((r) => ({
    bot: false, botId: '', accountId: Number(r.account_id), name: String(r.name),
    tag: String(r.tag || ''), level: Number(r.level) || 0,
    score: Number(r.score) || 0, wins: Number(r.wins) || 0, losses: Number(r.losses) || 0,
  }));
  for (const b of db.all('SELECT * FROM rank_bots WHERE division = ? ORDER BY idx ASC', String(division.key))) {
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

// 把旧周每个真人的最终名次落进 `rank_finals`：`rank` 是普通视角（不含隐身），
// `rank_hidden` 是隐身视角（含隐身）；领奖时按当时是否隐身取对应的一份。
function captureWeekFinals(week) {
  const stamp = Date.now();
  db.tx(() => {
    for (const div of DIVISIONS) {
      const all = finalRows(week, div, true);
      const visible = finalRows(week, div, false);
      const allIndex = new Map();
      all.forEach((r, i) => { if (!r.bot) allIndex.set(Number(r.accountId), i); });
      const visibleIndex = new Map();
      visible.forEach((r, i) => { if (!r.bot) visibleIndex.set(Number(r.accountId), i); });
      for (const row of all) {
        if (row.bot) continue;
        const id = Number(row.accountId);
        const ai = allIndex.get(id);
        const vi = visibleIndex.has(id) ? visibleIndex.get(id) : null;
        const rankAll = ai != null ? ai + 1 : 0;
        const rankVisible = vi != null ? vi + 1 : rankAll;
        const played = Math.max(0, Number(row.wins) || 0) + Math.max(0, Number(row.losses) || 0);
        const botAfterAll = ai != null && all.slice(ai + 1).some((r) => r.bot);
        const botAfterVisible = vi != null ? visible.slice(vi + 1).some((r) => r.bot) : botAfterAll;
        db.run(
          `INSERT INTO rank_finals
             (account_id, week, division, rank, rank_hidden, played, surpassed_bot, surpassed_bot_hidden, score, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(account_id, week) DO UPDATE SET
             division = excluded.division, rank = excluded.rank, rank_hidden = excluded.rank_hidden,
             played = excluded.played, surpassed_bot = excluded.surpassed_bot,
             surpassed_bot_hidden = excluded.surpassed_bot_hidden, score = excluded.score,
             created_at = excluded.created_at`,
          id, String(week), String(div.key), rankVisible, rankAll, played,
          botAfterVisible ? 1 : 0, botAfterAll ? 1 : 0, Number(row.score) || 0, stamp
        );
      }
    }
  });
}

function rollWeekIfNeeded(week) {
  const w = week || weekKey();
  const previous = metaGet('rank_week');
  if (previous === w) return 0;
  if (rolling) return 0;
  rolling = true;
  try {
    // 先按旧周的积分/人机分数记下“上周最终排名”，再改积分、重置人机。
    if (previous) {
      if (previous === previousWeekKey(w)) captureWeekFinals(previous);
      metaSet('rank_award_mode', 'final');
    }
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

        db.run('DELETE FROM ratings WHERE account_id = ? AND season < ?', id, w);
        rolled += 1;
      }
      metaSet('rank_week', w);
    });
    resetBots(w);
    return rolled;
  } finally {
    rolling = false;
  }
}

// 所有天梯读写入口的周检查：每周只搬一次数据（`meta.rank_week` 是幂等标记）。
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
    invalidateDivisionRows();
    row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), w);
  }
  return row;
}

function ratingOf(accountId, week) {
  const row = ensureRating(accountId, week);
  return Number(row.score) || config.rankIntegralStart;
}

function scoreOf(accountId, week) {
  const row = db.get('SELECT score FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), week || weekKey());
  return row ? Math.max(0, Number(row.score) || 0) : 0;
}

// 把权威天梯积分写进存档镜像。登录、摘要、幂等重试返回的 `save` 都必须走这一条，
// 否则调用方会看到「ratings 0 分 / 存档里还是旧 1500」的两份数。
function syncIntegral(accountId, save) {
  if (save && typeof save === 'object') save.integral = ratingOf(accountId);
  return save;
}

const BOT_NAMES = Object.freeze([
  '松果见习生', '橡子巡逻员', '树洞守卫', '月光拾荒者', '雾林邮差', '坚果学徒',
  '古树见习', '溪谷哨兵', '星屑旅人', '雪原新兵', '苔原猎手', '树冠信使',
]);

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

function resetBots(w) {
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
  invalidateDivisionRows();
  return w;
}

function ensureBots(week) {
  const w = week || weekKey();
  // 读榜入口都从这里进来：必须先结算换周，再重置人机，否则旧周的人机分数
  // 会被新周 300 分覆盖，`captureWeekFinals` 就记不下真实的周日 23:59 名次。
  if (!rolling && metaGet('rank_week') !== w) weekTick();
  // `botsFor` / `botById` / `divisionRows` 每次读榜都会进来；同一周重复跑
  // 用一行 `week` 做廉价的「别处是否重置过」校验，测试/运维手改库也能生效。
  if (botsReadyWeek === w) {
    const row = db.get('SELECT week FROM rank_bots LIMIT 1');
    if (row && String(row.week) === w) return w;
    botsReadyWeek = '';
  }
  return resetBots(w);
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

function applyBotResult(botId, playerWin, botDelta) {
  const bot = botById(botId);
  if (!bot) return null;
  const delta = Math.round(Number(botDelta) || 0);
  const floor = Math.max(0, Number(config.rankBotFloor) || 0);
  const score = Math.max(floor, Math.min(MAX_SCORE, Math.round(Number(bot.score) + delta)));
  db.run('UPDATE rank_bots SET score = ?, wins = wins + ?, losses = losses + ?, updated_at = ? WHERE id = ?',
    score, playerWin ? 0 : 1, playerWin ? 1 : 0, Date.now(), String(bot.id));
  invalidateDivisionRows();
  return { id: String(bot.id), score, wins: Number(bot.wins) + (playerWin ? 0 : 1), losses: Number(bot.losses) + (playerWin ? 1 : 0) };
}

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

function compareRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (!!a.bot !== !!b.bot) return a.bot ? 1 : -1;
  if (a.bot) return String(a.botId).localeCompare(String(b.botId));
  return Number(a.accountId) - Number(b.accountId);
}

// 名次只用于展示：同一请求里 profile / ladder / 领奖会重复算整赛区。
// 2 秒 TTL + 写路径显式失效；隐身视角的行集合不同，单独一份缓存。
const DIVISION_TTL_MS = 2000;
const divisionCache = new Map();
function invalidateDivisionRows() { divisionCache.clear(); }

// `viewerAccountId` 决定看不看得到隐身账号：隐身账号看全榜（含所有隐身），
// 普通视角排除隐身。省略时按普通视角处理，保持旧调用/旧测试的默认行为。
function divisionRows(division, viewerAccountId) {
  const d = division || null;
  if (!d) return [];
  const w = ensureBots();
  const viewerHidden = viewerAccountId != null && visibility.isHidden(viewerAccountId);
  const cacheKey = w + '|' + String(d.key) + '|' + (viewerHidden ? 1 : 0);
  const cached = divisionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DIVISION_TTL_MS) return cached.rows;
  const hiddenSql = visibility.hiddenSqlFor('r.account_id', viewerHidden);
  const hiddenParams = visibility.hiddenParamsFor(viewerHidden);
  const players = db.all(
    `SELECT r.account_id, r.score, r.wins, r.losses, a.name, a.tag, sv.level
       FROM ratings r
       JOIN accounts a ON a.id = r.account_id
       JOIN saves sv ON sv.account_id = r.account_id AND sv.mode = 'classic'
      WHERE r.season = ? AND a.banned = 0
        AND sv.level BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = r.account_id)
        AND ${hiddenSql}`,
    w, d.lo, d.hi, ...hiddenParams
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
  if (divisionCache.size >= 32) divisionCache.delete(divisionCache.keys().next().value);
  divisionCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

function rankOf(accountId) {
  const row = db.get('SELECT * FROM ratings WHERE account_id = ? AND season = ?', Number(accountId), weekKey());
  if (!row) return 0;
  const div = divisionOfAccount(accountId);
  if (!div) return 0;
  const rows = divisionRows(div, accountId);
  const i = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  return i >= 0 ? i + 1 : 0;
}

// 一次算齐自己与候选真人的赛区名次：天梯匹配页要同时显示双方名次，不能每人间隔一次全表扫描。
// 名次口径跟 viewers 自己的榜一致：隐身看全榜，普通玩家看不到隐身，取不到名次时按 0 返回。
function rankPositions(accountId, accountIds) {
  const div = divisionOfAccount(accountId);
  if (!div) return { rank: 0, ranks: new Map() };
  const want = new Set((accountIds || []).map((id) => Number(id)).filter((id) => id > 0));
  const rows = divisionRows(div, accountId);
  const ranks = new Map();
  let mine = 0;
  rows.forEach((row, i) => {
    if (row.bot) return;
    const id = Number(row.accountId);
    if (id === Number(accountId)) mine = i + 1;
    if (want.has(id)) ranks.set(id, i + 1);
  });
  return { rank: mine, ranks };
}

function clampScore(score) {
  return Math.max(config.rankIntegralFloor, Math.min(MAX_SCORE, Math.round(Number(score) || 0)));
}

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

// 兼容旧接口：主动方赢 +mag / 输 -mag；不处理上下限。
function integralDelta(attackerScore, defenderScore, attackerWin, roll) {
  const mag = integralMagnitude(attackerScore, defenderScore, roll);
  return attackerWin ? mag : -mag;
}

// 防守方已经贴在下限（真人 0 / 人机 50）或上限 100000 时压成 0。
function rankDefenderDelta(defenderScore, attackerWin, floor) {
  const foe = Math.round(Number(defenderScore) || 0);
  const lo = Number.isFinite(Number(floor)) ? Number(floor) : config.rankIntegralFloor;
  if (attackerWin) return foe - 1 >= lo ? -1 : 0;
  return foe + 1 <= MAX_SCORE ? 1 : 0;
}

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

// 天梯人机败场只扣正常积分差的一半，向上取整；传进来的已是夹过 0 分下限的负值。
function rankBotLoseDelta(attackerDelta) {
  const loss = Math.ceil(Math.max(0, -Math.round(Number(attackerDelta) || 0)) / 2);
  return loss ? -loss : 0;
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

function refundDaily(accountId, kind, n) {
  const date = localDate();
  const amount = Math.max(0, Math.round(Number(n) || 0));
  if (amount > 0) {
    db.run('UPDATE daily_counts SET count = MAX(0, count - ?) WHERE account_id = ? AND kind = ? AND date = ?',
      amount, Number(accountId), String(kind), date);
  }
  return todayCount(accountId, kind);
}

function rankCostAt(played) {
  const n = Math.max(0, Math.floor(Number(played) || 0));
  if (n < config.rankFreePlays) return 0;
  if (n >= config.rankCapFrom) return config.rankCapCost;
  return n >= config.rankLateFrom ? config.rankLateCost : config.rankPaidCost;
}

// 天梯当日状态：已打几场、还剩几场、这一场要不要花金松果（含档位起点，给错误文案用）。
function rankDailyStatus(accountId) {
  const played = todayCount(accountId, 'rank');
  const limit = Math.max(0, Math.floor(Number(config.rankDailyLimit) || 0));
  const unlimited = limit <= 0;
  const freeLeft = Math.max(0, config.rankFreePlays - played);
  const cost = rankCostAt(played);
  const cap = played >= config.rankCapFrom;
  const late = !cap && played >= config.rankLateFrom;
  return {
    played,
    limit,
    unlimited,
    left: unlimited ? null : Math.max(0, limit - played),
    freeLeft,
    cost,
    tier: cost === 0 ? 'free' : (cap ? 'cap' : (late ? 'late' : 'paid')),
    tierStart: cost === 0 ? 0 : (cap ? config.rankCapFrom + 1 : (late ? config.rankLateFrom + 1 : config.rankFreePlays + 1)),
    date: localDate(),
  };
}

// 由已经算好的 rows / myIdx 生成领奖状态；`rankAwardStatus` 和 `/api/ladder` 共用，
// 避免同一请求把整个赛区排名算两遍。
function awardStatusFrom(accountId, week, rating, div, rows, myIdx) {
  const rank = myIdx >= 0 ? myIdx + 1 : 0;
  const played = Math.max(0, Number(rating.wins) || 0) + Math.max(0, Number(rating.losses) || 0);
  const surpassedBot = myIdx >= 0 && rows.slice(myIdx + 1).some((r) => r.bot);
  const claimed = db.get('SELECT * FROM rank_awards WHERE account_id = ? AND week = ?', Number(accountId), week);
  return {
    week, season: week, rank, played, surpassedBot,
    score: Math.max(0, Number(rating && rating.score) || 0),
    division: div ? { key: div.key, lo: div.lo, hi: div.hi, frame: div.frame, label: div.label } : null,
    eligible: played > 0 && rank > 0 && rank <= config.rankWeeklyTop && surpassedBot,
    cups: config.rankWeeklyCup,
    claimed: !!claimed,
    claimedCups: claimed ? Number(claimed.cups) : 0,
  };
}

function legacyAwardStatus(accountId, week) {
  const rating = ensureRating(accountId, week);
  const div = divisionOfAccount(accountId);
  const rows = div ? divisionRows(div, accountId) : [];
  const myIdx = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  return Object.assign({ mode: 'legacy' }, awardStatusFrom(accountId, week, rating, div, rows, myIdx));
}

// 新口径：只认换周时落下的上周最终名次；本周怎么打都不会改变上周的领奖资格。
function finalAwardStatus(accountId, currentWeek) {
  const week = previousWeekKey(currentWeek);
  const row = db.get('SELECT * FROM rank_finals WHERE account_id = ? AND week = ?', Number(accountId), week);
  const claimed = db.get('SELECT * FROM rank_awards WHERE account_id = ? AND week = ?', Number(accountId), week);
  const hidden = visibility.isHidden(accountId);
  const rank = row ? Math.max(0, Number(hidden ? row.rank_hidden : row.rank) || 0) : 0;
  const played = row ? Math.max(0, Number(row.played) || 0) : 0;
  const surpassedBot = !!(row && (hidden ? row.surpassed_bot_hidden : row.surpassed_bot));
  const div = row ? DIVISIONS.find((d) => String(d.key) === String(row.division)) : divisionOfAccount(accountId);
  return {
    mode: 'final',
    week,
    season: week,
    currentWeek,
    rank,
    played,
    surpassedBot,
    score: row ? Math.max(0, Number(row.score) || 0) : 0,
    division: div ? { key: div.key, lo: div.lo, hi: div.hi, frame: div.frame, label: div.label } : null,
    eligible: played > 0 && rank > 0 && rank <= config.rankWeeklyTop && surpassedBot,
    cups: config.rankWeeklyCup,
    claimed: !!claimed,
    claimedCups: claimed ? Number(claimed.cups) : 0,
    noRecord: !row,
    msg: !row ? '上周没有参加天梯赛，暂时没有金杯奖励。'
      : (rank > config.rankWeeklyTop ? '上周最终排名没有进入赛区前' + config.rankWeeklyTop + '名，暂时没有金杯奖励。'
        : (!surpassedBot ? '上周最终排名还没有超过任何一个赛区人机，暂时没有金杯奖励。' : '')),
  };
}

function rankAwardStatus(accountId) {
  weekTick();
  const week = weekKey();
  const out = metaGet('rank_award_mode') === 'final'
    ? finalAwardStatus(accountId, week)
    : legacyAwardStatus(accountId, week);
  out.final = out.mode === 'final';
  // 隐身只作为展示标记；排名与领奖按「隐身看全榜」的口径正常计算。
  if (visibility.isHidden(accountId)) out.hidden = true;
  return out;
}

function claimRankAward(accountId) {
  const status = rankAwardStatus(accountId);
  const week = status.week;
  const final = status.mode === 'final';
  const top = config.rankWeeklyTop;
  const label = final ? '上周最终排名' : '本周';
  if (!(status.played > 0)) {
    return { ok: false, msg: (final ? '上周' : '本周') + '还没有参加天梯赛，先打一场再来领奖吧。', rank: 0, week };
  }
  if (!(status.rank > 0) || status.rank > top) {
    return { ok: false, msg: label + '没有进入赛区前' + top + '名，暂时没有金杯奖励。', rank: status.rank, week };
  }
  if (!status.surpassedBot) {
    return { ok: false, msg: (final ? '上周最终排名' : '') + '还没有超过任何一个赛区人机，暂时没有金杯奖励。', rank: status.rank, week };
  }
  if (status.claimed) {
    return { ok: false, msg: (final ? '上周' : '本周') + '的天梯奖励已经领取过了。', already: true, rank: status.rank, week };
  }
  try {
    db.run('INSERT INTO rank_awards (account_id, week, rank, cups, created_at) VALUES (?,?,?,?,?)',
      Number(accountId), week, status.rank, config.rankWeeklyCup, Date.now());
  } catch (_) {
    // 并发重试：唯一键已存在就是领过了，不再发第二份。
    return { ok: false, msg: (final ? '上周' : '本周') + '的天梯奖励已经领取过了。', already: true, rank: status.rank, week };
  }
  return {
    ok: true, rank: status.rank, cups: config.rankWeeklyCup, week,
    msg: final
      ? '恭喜上周最终排名进入赛区前' + top + '名，成功获得' + config.rankWeeklyCup + '个金杯奖励！'
      : '恭喜进入赛区前' + top + '名，成功获得' + config.rankWeeklyCup + '个金杯奖励！',
  };
}

function ladder(accountId, limit) {
  ensureBots();
  const week = weekKey();
  const mine = ensureRating(accountId, week);
  const div = divisionOfAccount(accountId);
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const hidden = visibility.hiddenInfo(accountId);
  const meBase = {
    score: Number(mine.score) || 0, wins: Number(mine.wins) || 0, losses: Number(mine.losses) || 0,
    streak: Number(mine.streak) || 0, rank: 0, level: levelOf(accountId),
    hidden: !!hidden, hiddenUntil: hidden ? hidden.until : 0,
  };
  if (!div) {
    return {
      week, season: week, division: null, frame: 0, label: '', top: [], me: meBase,
      hidden: !!hidden, hiddenUntil: hidden ? hidden.until : 0,
      award: rankAwardStatus(accountId),
    };
  }
  const rows = divisionRows(div, accountId);
  const myIdx = rows.findIndex((r) => !r.bot && r.accountId === Number(accountId));
  const top = rows.slice(0, n).map((r) => Object.assign({}, r));
  return {
    week, season: week,
    division: { key: div.key, lo: div.lo, hi: div.hi, frame: div.frame, label: div.label },
    frame: div.frame, label: div.label,
    top, me: Object.assign({}, meBase, { rank: myIdx >= 0 ? myIdx + 1 : 0 }),
    hidden: !!hidden, hiddenUntil: hidden ? hidden.until : 0,
    award: rankAwardStatus(accountId),
  };
}

module.exports = {
  DIVISIONS, divisionOf, divisionOfAccount, levelOf,
  ensureRating, ratingOf, scoreOf, syncIntegral, rankOf, rankPositions, integralDelta, rankDeltaPair, rankBotLoseDelta, rankDefenderDelta,
  clampScore,
  todayCount, bumpDaily, refundDaily, rankDailyStatus, weekKey, weekTick, rollWeekIfNeeded,
  previousWeekKey, captureWeekFinals, finalRows,
  rankAwardStatus, claimRankAward,
  ensureBots, botPlan, botsFor, botById, applyBotResult, divisionRows, invalidateDivisionRows,
  recentRealOpponents, ladder,
};
