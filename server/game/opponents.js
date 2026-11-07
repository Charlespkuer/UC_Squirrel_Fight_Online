'use strict';
/* 服务端候选票据：玩家只交 opaque ID，面板、来源、账号与用途由服务端保管。 */
const crypto = require('node:crypto');
const runtime = require('./runtime');
const snapshots = require('./snapshot');
const settlement = require('./settlement');
const battle = require('./battle');
const { fighterFromSnapshot } = require('./fighter');
const { config } = require('../config');
const db = require('../db');

const offers = new Map();
const TTL = 10 * 60 * 1000;
const OWNER_LIMIT = Math.max(24, config.opponentsPerRefresh * 8);

function error(code, text) { const e = new Error(text); e.code = code; return e; }
function prune(owner) {
  const now = Date.now();
  for (const [id, value] of offers) if (value.expiresAt <= now) offers.delete(id);
  const mine = [...offers].filter(([, value]) => value.owner === owner);
  for (const [id] of mine.slice(0, Math.max(0, mine.length - OWNER_LIMIT))) offers.delete(id);
  while (offers.size > 20000) offers.delete(offers.keys().next().value);
}

/** 与单机随机挑战相同的等级范围、State.genAI、装备/武技与幻兽规则。 */
function buildRandomFoe(S, myLevel) {
  const lo = Math.max(1, myLevel - 1);
  const hi = Math.min(S.MAX_PLAYER_LEVEL, myLevel + 3);
  const level = lo + Math.floor(Math.random() * (hi - lo + 1));
  const foe = S.genAI(level, '', { levelJitter: 0, statScale: S.RANDOM_FOE_SCALE || 1.08 });
  /* `randomAIName` 现在保证 «前缀 + 核心 + 称号» 不超过 7 个汉字（称号只在放得下时追加），
   * 这里不再事后裁剪 —— 否则会把「尾巴达人的师兄」这种刚好 7 个字、战场能完整显示的
   * 原版风味名字也削成「尾巴达人」。 */
  return foe;
}

/**
 * 列表条目。`withFighter` 时把**战斗体一起带回去**。
 *
 * 为什么要带：原版 `randomfriends.do` 一次响应就给了整页所需（名字/等级/三维/装备），
 * 客户端刷新只发**一个**请求（`MainMovie.as:2699-2704`）。我们以前是「列表 + 每个对手
 * 再来一次 `/api/fighter`」，4 次串行往返，刷新肉眼可见地慢。一页只有 3 个，带回来
 * 也就几 KB（gzip 后 1~2 KB），比多跑 3 个 RTT 划算得多。
 */
function describe(value, withFighter) {
  const player = value.source === 'player';
  const out = {
    snapshotId: value.id, source: value.source, player, bot: !player,
    kind: value.kind,
    /* 天梯人机：**所有分段**都按正常天梯规则结算（人机作为防守方固定 ±1）；
     * 300 分以后只是候选位权重降到 1/3，见 `rankCandidates`。 */
    practice: value.practice != null ? !!value.practice : false,
    botId: String(value.botId || ''),
    accountId: value.accountId, name: value.name, tag: value.tag,
    level: value.fighter.level, score: value.score != null ? Number(value.score) : null,
    historical: !!value.historical, expiresAt: value.expiresAt,
    /* 列表里只写最短的标记：AI 生成的写「AI」，真人只写昵称（昵称已全服唯一）。
     * 以前是 `名字（AI对手）`，又长又会挤到名字右边（用户 2026-10 口径）。 */
    display: player ? value.name : value.name + ' AI',
  };
  if (withFighter) out.fighter = fighterFromSnapshot(value.fighter);
  return out;
}

function issue(owner, kind, fighter, meta) {
  const value = {
    ...meta, owner: Number(owner), kind, id: 'o_' + crypto.randomBytes(15).toString('base64url'),
    fighter: fighterFromSnapshot(fighter), expiresAt: Date.now() + TTL,
  };
  offers.set(value.id, value);
  return describe(value, true);
}

function isOffer(id) { return String(id).startsWith('o_'); }
function forgetAccount(accountId) {
  const id = Number(accountId);
  for (const [key, value] of offers) if (value.owner === id || value.accountId === id) offers.delete(key);
}
function resolve(id, owner, kind) {
  const value = offers.get(String(id));
  if (!value || value.expiresAt <= Date.now()) {
    offers.delete(String(id));
    throw error('NOT_FOUND', '对手候选已过期，请刷新列表');
  }
  if (value.owner !== Number(owner)) throw error('FORBIDDEN', '这个对手不属于当前账号');
  if (kind && value.kind !== kind) throw error('BAD_REQUEST', '对手用途不匹配，请刷新列表');
  return { ...value, fighter: fighterFromSnapshot(value.fighter), public: describe(value, false) };
}

/* Every account has one chance in the roster, regardless of snapshot count.
 * First draw the same level distribution as the game's random AI (-1..+3),
 * then select its closest available level and the latest revision at that level. */
function randomPlayers(owner, level, excluded) {
  const rows = db.all(`SELECT b.id,b.account_id,b.level,b.revision,b.is_current,a.name,a.tag
    FROM battle_snapshots b JOIN accounts a ON a.id=b.account_id
    WHERE b.mode='classic' AND b.account_id<>? AND b.level BETWEEN ? AND ? AND a.banned=0
      AND (a.last_seen>=? OR EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id=a.id))
    ORDER BY b.account_id,b.level,b.revision DESC`,
    Number(owner), Math.max(1,level-config.opponentLevelSpread),
    Math.min(90,level+config.opponentLevelSpread), Date.now()-config.opponentIdleDays*86400000);
  const groups = new Map(), banned = new Set(excluded.map(Number));
  for (const r of rows) {
    const id=Number(r.account_id); if (banned.has(id)) continue;
    if (!groups.has(id)) groups.set(id,new Map());
    const levels=groups.get(id), lv=Number(r.level);
    if (!levels.has(lv)) levels.set(lv,r);
  }
  const result=[];
  for (const [accountId, levels] of groups) {
    const lo=Math.max(1,level-1), hi=Math.min(90,level+3);
    const target=lo+Math.floor(Math.random()*(hi-lo+1));
    const choices=[...levels.values()];
    const best=Math.min(...choices.map(r=>Math.abs(r.level-target)));
    const nearest=choices.filter(r=>Math.abs(r.level-target)===best);
    const r=nearest[Math.floor(Math.random()*nearest.length)];
    result.push({snapshotId:r.id,accountId,name:r.name,tag:r.tag,level:r.level,historical:!r.is_current});
  }
  return result.map(row=>({row,order:Math.random()})).sort((a,b)=>a.order-b.order).map(x=>x.row);
}

/**
 * 随机挑战的「真人签 + 人机签」抽签。
 *  - 每个可匹配真人（`randomPlayers` 已按等级 / recentIds 过滤）占 **1 个签**；
 *  - 另外固定放 `botSlots` 个**空签**——抽到空签才用当前 `buildRandomFoe` / `genAI` 造对手，
 *    所以这 30 个“人机”不需要是具体账号，只是权重位；
 *  - 洗匀后取前 `limit` 个；真人一人最多一签，因此同一页不会重复同一位真人。
 * `rng` 参数只给回归用例注入确定性随机流用。
 */
function drawRandomPool(realRows, limit, botSlots, rng) {
  const want = Math.max(0, Math.floor(Number(limit) || 0));
  const bots = Math.max(1, Math.floor(Number(botSlots) || 30));
  const pool = realRows.slice().concat(new Array(bots).fill(null));
  const rand = typeof rng === 'function' ? rng : Math.random;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, want);
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** 天梯人机候选：从本赛区人机池里随机抽，战斗体当场用 State.genAI 生成。
 *  `want` 是「抽完后整页一共几个候选」，300 分以后的名额由 `botSlotsFor` 缩小。 */
function addBots(accountId, save, division, chosen, want) {
  if (want <= 0) return;
  const pool = shuffle(settlement.botsFor(division.key));
  runtime.withState(save, ({ api: S }) => {
    for (const bot of pool) {
      if (chosen.length >= want) break;
      const level = Math.max(1, Number(bot.level) || 1);
      const seed = battle.randomSeed();
      const fighter = battle.withSeed(seed, () => S.genAI(level, '', {
        levelJitter: 0, statScale: config.rankBotScale || S.RANDOM_FOE_SCALE || 1.08,
      }));
      if (!fighter) continue;
      fighter.level = level;
      fighter.name = String(bot.name);
      chosen.push(issue(accountId, 'rank', fighter, {
        source: 'bot', accountId: 0, name: String(bot.name), tag: '', historical: false,
        practice: false, botId: String(bot.id),
        score: Number(bot.score) || 0,
      }));
    }
  });
}

/** 天梯候选页里人机候选位的个数（用户 2026-11 口径）：
 *  · 300 分**以前**：把真人之外的空位全用赛区人机补满（本赛区 30 个人机池里随机抽）；
 *  · 300 分**以后**：人机权重降到 `1/rankBotWeightDivisor`（默认 1/3，四舍五入）——
 *    空 3 位 → 1 个人机、空 2 位 → 1 个、空 1 位 → 0 个，真人永远排在前面。
 *  人机不再因为「300 分以上」被整体排除：它照样按正常天梯规则结算，只是出现得更少。 */
function botSlotsFor(free, myScore) {
  const n = Math.max(0, Math.floor(Number(free) || 0));
  if (!n) return 0;
  if (Number(myScore) < config.rankRealMatchScoreLimit) return n;
  const divisor = Math.max(1, Number(config.rankBotWeightDivisor) || 3);
  return Math.max(0, Math.round(n / divisor));
}

/** 天梯候选：只看**自己赛区**。真人按等级/积分/最近 5 场筛完先补满，
 *  剩下的候选位按 `botSlotsFor` 的权重用赛区人机补（300 分以后降到 1/3）。 */
function rankCandidates(accountId, save, o, level) {
  const division = settlement.divisionOf(level);
  if (!division) return [];
  const myScore = Number(o.myScore) || 0;
  const limit = config.opponentsPerRefresh;
  const chosen = [], accounts = new Set([Number(accountId)]);
  const list = snapshots.candidates('classic', {
    excludeAccountId: accountId, level, week: settlement.weekKey(),
    minLevel: division.lo, maxLevel: division.hi,
    ratingSpread: config.opponentRatingSpread, myScore,
    recentIds: o.recentIds || [],
  });
  for (const row of list) {
    if (chosen.length >= limit) break;
    if (accounts.has(row.accountId)) continue;
    const snap = snapshots.snapshotById(row.snapshotId);
    if (!snap || !snap.fighter) continue;
    accounts.add(row.accountId);
    chosen.push(issue(accountId, 'rank', snap.fighter, {
      source: 'player', accountId: row.accountId, name: row.name, tag: row.tag,
      score: row.score || 0, historical: !!row.historical, playerSnapshotId: snap.id,
    }));
  }
  const bots = botSlotsFor(limit - chosen.length, myScore);
  if (bots > 0) addBots(accountId, save, division, chosen, chosen.length + bots);
  prune(Number(accountId));
  return chosen;
}

function candidates(accountId, save, options) {
  const o = options || {}, kind = o.kind || 'rank';
  if (kind !== 'random' && kind !== 'rank') throw error('BAD_REQUEST', '未知的对手用途');
  const level = Math.max(1, Number(save.level) || 1);
  if (kind === 'rank') return rankCandidates(accountId, save, o, level);
  const limit = config.opponentsPerRefresh;
  const chosen = [], accounts = new Set([Number(accountId)]);
  const list = randomPlayers(accountId, level, o.recentIds || []);
  const addPlayer = (row) => {
    if (accounts.has(row.accountId) || (o.recentIds || []).includes(row.accountId)) return;
    const snap = snapshots.snapshotById(row.snapshotId);
    if (!snap || !snap.fighter) return;
    accounts.add(row.accountId);
    chosen.push(issue(accountId, kind, snap.fighter, {
      source: 'player', accountId: row.accountId, name: row.name, tag: row.tag,
      score: row.score || 0, historical: !!row.historical, playerSnapshotId: snap.id,
    }));
  };
  /* 随机挑战：把真人签混进 `randomBotSlots` 个空签里抽；抽到空签的位子才用当前
   * `buildRandomFoe` 造 bot（显示口径与以前完全一样）。rank 不走这个池子。 */
  const slots = drawRandomPool(list, limit, config.randomBotSlots);
  for (const row of slots) { if (chosen.length >= limit) break; if (row) addPlayer(row); }
  if (chosen.length < limit) {
    const seed = battle.randomSeed();
    runtime.withState(save, ({ api: S }) => battle.withSeed(seed, () => {
      while (chosen.length < limit) {
        const fighter = buildRandomFoe(S, level);
        chosen.push(issue(accountId, kind, fighter, {
          source: 'bot', accountId: 0, name: fighter.name, tag: '', historical: false, practice: false,
        }));
      }
    }));
  }
  prune(Number(accountId));
  return chosen;
}

/**
 * 征战随机匹配的助战队友：与随机挑战**同一套抽签**——
 * 等级相近的真人快照各占 1 个签，再混入 `randomBotSlots` 个空签；
 * 抽到空签就用 `buildRandomFoe` 造人机。返回 `{kind:'snapshot'|'bot', fighter,...}`。
 * 快照队友只作为战斗体参战，不写对方账号、不发奖。
 */
function drawTeammates(owner, save, level, count, excluded) {
  const want = Math.max(0, Math.floor(Number(count) || 0));
  if (!want) return [];
  const skip = new Set((excluded || []).map(Number));
  const rows = randomPlayers(Number(owner), Math.max(1, Number(level) || 1), []).filter((r) => !skip.has(Number(r.accountId)));
  const slots = drawRandomPool(rows, want, config.randomBotSlots);
  const out = [];
  const used = new Set();
  for (const row of slots) {
    if (out.length >= want) break;
    if (!row || used.has(Number(row.accountId))) continue;
    const snap = snapshots.snapshotById(row.snapshotId);
    if (!snap || !snap.fighter) continue;
    used.add(Number(row.accountId));
    out.push({
      kind: 'snapshot', accountId: Number(row.accountId), snapshotId: String(row.snapshotId),
      name: String(row.name || snap.fighter.name || '助战'), tag: String(row.tag || ''),
      level: Math.max(1, Number(snap.fighter.level) || Number(row.level) || 1),
      fighter: fighterFromSnapshot(snap.fighter),
    });
  }
  if (out.length < want) {
    runtime.withState(save, ({ api: S }) => {
      while (out.length < want) {
        const fighter = buildRandomFoe(S, Math.max(1, Number(level) || 1));
        out.push({
          kind: 'bot', accountId: 0, snapshotId: '', name: String(fighter.name || '助战'),
          tag: '', level: Math.max(1, Number(fighter.level) || 1), fighter,
        });
      }
    });
  }
  return out.slice(0, want);
}

module.exports = {
  candidates, resolve, isOffer, buildRandomFoe, forgetAccount, drawRandomPool, drawTeammates, botSlotsFor,
};
