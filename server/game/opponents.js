'use strict';
// 服务端候选票据：玩家只交 opaque ID，面板、来源、账号与用途由服务端保管。
const crypto = require('node:crypto');
const runtime = require('./runtime');
const snapshots = require('./snapshot');
const settlement = require('./settlement');
const battle = require('./battle');
const vip = require('./vip');
const { fighterFromSnapshot } = require('./fighter');
const { config } = require('../config');
const visibility = require('./visibility');
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

function buildRandomFoe(S, myLevel) {
  const lo = Math.max(1, myLevel - 1);
  const hi = Math.min(S.MAX_PLAYER_LEVEL, myLevel + 3);
  const level = lo + Math.floor(Math.random() * (hi - lo + 1));
  const foe = S.genAI(level, '', { levelJitter: 0, statScale: S.RANDOM_FOE_SCALE || 1.08 });
  // `randomAIName` 现在保证 «前缀 + 核心 + 称号» 不超过 7 个汉字（称号只在放得下时追加），
  // 这里不再事后裁剪 —— 否则会把「尾巴达人的师兄」这种刚好 7 个字、战场能完整显示的
  return foe;
}

function describe(value, withFighter) {
  const player = value.source === 'player';
  const out = {
    snapshotId: value.id, source: value.source, player, bot: !player,
    kind: value.kind,
    // 真实快照号：查看 / 开战用它就不依赖内存 offer（10 分钟 TTL，服务重启即丢）。
    snapshotRef: String(value.playerSnapshotId || ''),

    practice: value.practice != null ? !!value.practice : false,
    botId: String(value.botId || ''),
    accountId: value.accountId, name: value.name, tag: value.tag,
    level: value.fighter.level, score: value.score != null ? Number(value.score) : null,
    // VIP 是账号的实时状态，不能跟战斗快照一起冻结；列表里直接带上，省一次查询。
    vipLevel: Math.max(0, Number(value.vipLevel) || 0),
    historical: !!value.historical, expiresAt: value.expiresAt,
    // 列表里只写最短的标记：AI 生成的写「AI」，真人只写昵称（昵称已全服唯一）。
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
  if (value.accountId && Number(value.accountId) !== Number(owner)
    && visibility.isHidden(value.accountId) && !visibility.isHidden(owner))
    throw error('NOT_FOUND', '对手不可挑战');
  return { ...value, fighter: fighterFromSnapshot(value.fighter), public: describe(value, false) };
}
// 直接用原始快照号开打：查看过的那颗快照在内存 offer 过期 / 服务重启后仍能继续战斗。
// 只接受同等级段（与随机池同一口径）、非本人、未封禁账号的快照。
function resolveSnapshotRef(id, owner, meLevel, kind) {
  const snap = snapshots.snapshotById(String(id));
  if (!snap) throw error('NOT_FOUND', '对手快照已失效，请刷新列表');
  if (Number(snap.accountId) === Number(owner)) throw error('BAD_REQUEST', '不能挑战自己的快照');
  const acc = db.get('SELECT name, tag, banned FROM accounts WHERE id = ?', Number(snap.accountId));
  if (!acc || Number(acc.banned)) throw error('NOT_FOUND', '对手不可挑战');
  if (visibility.isHidden(snap.accountId) && !visibility.isHidden(owner)) throw error('NOT_FOUND', '对手不可挑战');
  const level = Number(snap.level) || 0;
  if (meLevel && Math.abs(level - Number(meLevel)) > config.opponentLevelSpread)
    throw error('BAD_REQUEST', '对手快照不在匹配范围，请刷新列表');
  const fighter = fighterFromSnapshot(snap.fighter);
  const name = String(acc.name || fighter.name || '');
  return {
    fighter,
    public: {
      snapshotId: String(snap.id), snapshotRef: String(snap.id), source: 'player', player: true, bot: false,
      kind: String(kind || 'random'), practice: false, botId: '',
      accountId: Number(snap.accountId), name, tag: String(acc.tag || ''),
      level: level || fighter.level, score: null, vipLevel: vip.levelOf(Number(snap.accountId)),
      historical: false, display: name,
    },
  };
}
// offer 与原始快照号都从这里进：随机页的「查看」保存原始快照号后，开战不再受 offer 生命周期影响。
function resolveTarget(id, owner, kind, meLevel) {
  const key = String(id || '');
  if (!key) return null;
  return isOffer(key) ? resolve(key, owner, kind) : resolveSnapshotRef(key, owner, meLevel, kind);
}

function randomPlayers(owner, level, excluded) {
  const viewerHidden = visibility.isHidden(owner);
  const params = [Number(owner), Math.max(1,level-config.opponentLevelSpread),
    Math.min(90,level+config.opponentLevelSpread), Date.now()-config.opponentIdleDays*86400000];
  if (!viewerHidden) params.push(Date.now());
  const rows = db.all(`SELECT b.id,b.account_id,b.level,b.revision,b.is_current,a.name,a.tag,
      sv.vip_level AS vip_level, sv.vip_until AS vip_until
    FROM battle_snapshots b JOIN accounts a ON a.id=b.account_id
    LEFT JOIN saves sv ON sv.account_id=b.account_id AND sv.mode=b.mode
    WHERE b.mode='classic' AND b.account_id<>? AND b.level BETWEEN ? AND ? AND a.banned=0
      AND b.revision = (SELECT MAX(x.revision) FROM battle_snapshots x
        WHERE x.account_id=b.account_id AND x.mode=b.mode AND x.level=b.level)
      AND (a.last_seen>=? OR EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id=a.id))
      AND ${visibility.hiddenSqlFor('b.account_id', viewerHidden)}
    ORDER BY b.account_id,b.level`,
    ...params);
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
    result.push({snapshotId:r.id,accountId,name:r.name,tag:r.tag,level:r.level,
      historical:!r.is_current,vipLevel:vip.levelAt(r.vip_level,r.vip_until)});
  }
  return result.map(row=>({row,order:Math.random()})).sort((a,b)=>a.order-b.order).map(x=>x.row);
}

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

// 天梯抽取权重：积分差 0 → 1，差 `opponentRatingSpread` 分（默认 200）→ `opponentRatingWeightFloor`
// （默认 1/5），更远也保底 1/5。权重只影响抽中概率，候选本身不再被积分差排除。
function ratingWeight(myScore, foeScore) {
  const spread = Math.max(1, Number(config.opponentRatingSpread) || 200);
  const floor = Math.min(1, Math.max(0, Number(config.opponentRatingWeightFloor) || 0.2));
  const diff = Math.abs((Number(foeScore) || 0) - (Number(myScore) || 0));
  if (diff >= spread) return floor;
  return 1 - (1 - floor) * (diff / spread);
}

// 按权重不放回抽取：权重越接近，被抽中的概率越高；同一次抽取不会重复池内条目。
function weightedPick(pool, count, weightOf, rng) {
  const want = Math.max(0, Math.floor(Number(count) || 0));
  const rand = typeof rng === 'function' ? rng : Math.random;
  const left = pool.slice(), out = [];
  while (out.length < want && left.length) {
    let total = 0;
    const weights = new Array(left.length);
    for (let i = 0; i < left.length; i++) {
      weights[i] = Math.max(0, Number(weightOf(left[i])) || 0);
      total += weights[i];
    }
    let pick = left.length - 1;
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < left.length; i++) {
        r -= weights[i];
        if (r < 0) { pick = i; break; }
      }
    } else {
      pick = 0;
    }
    out.push(left.splice(pick, 1)[0]);
  }
  return out;
}

// 天梯人机候选：把指定的人机行生成成票据，战斗体当场用 State.genAI。
function addBots(accountId, save, chosen, want, pool) {
  if (want <= 0 || !Array.isArray(pool) || !pool.length) return;
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

function averageBotScore(bots) {
  let sum = 0, count = 0;
  for (const bot of bots || []) { sum += Number(bot.score) || 0; count += 1; }
  return count ? sum / count : config.rankBotBaseScore;
}

// 天梯抽取池：本赛区全部人机签 + 全部真人（最近打过的真人已由 snapshots.candidates 排除）。
// 真人按与挑战者的积分差取权重；300 分以上人机按 0 分、以下按池里人机平均分取权重。
function rankCandidates(accountId, save, o, level) {
  const division = settlement.divisionOf(level);
  if (!division) return [];
  const myScore = Number(o.myScore) || 0;
  const chosen = [];
  const list = snapshots.candidates('classic', {
    excludeAccountId: accountId, level, week: settlement.weekKey(),
    minLevel: division.lo, maxLevel: division.hi,
    recentIds: o.recentIds || [],
  });
  const realPool = [], seen = new Set([Number(accountId)]);
  for (const row of list) {
    if (seen.has(row.accountId)) continue;
    seen.add(row.accountId);
    realPool.push(row);
  }
  const botPool = settlement.botsFor(division.key);
  const botScore = myScore >= config.rankRealMatchScoreLimit ? 0 : averageBotScore(botPool);
  const botWeight = ratingWeight(myScore, botScore);
  const pool = [];
  let botWeightSum = 0, realWeightSum = 0;
  for (const row of realPool) {
    const weight = ratingWeight(myScore, row.score);
    pool.push({ bot: false, row, weight });
    realWeightSum += weight;
  }
  for (const bot of botPool) {
    pool.push({ bot: true, row: bot, weight: botWeight });
    botWeightSum += botWeight;
  }
  if (!pool.length) return [];
  const picked = weightedPick(pool, 1, (entry) => entry.weight)[0];
  if (picked.bot) {
    const bots = [];
    addBots(accountId, save, bots, 1, [picked.row]);
    if (bots.length) chosen.push(bots[0]);
  } else {
    const snap = snapshots.snapshotById(picked.row.snapshotId);
    if (snap && snap.fighter) chosen.push(issue(accountId, 'rank', snap.fighter, {
      source: 'player', accountId: picked.row.accountId, name: picked.row.name, tag: picked.row.tag,
      score: picked.row.score || 0, historical: !!picked.row.historical, playerSnapshotId: snap.id,
      vipLevel: picked.row.vipLevel,
    }));
  }
  // 选中的真人快照刚好失效：从同池人机补一个，避免空候选。
  if (!chosen.length && botPool.length) {
    const bots = [];
    addBots(accountId, save, bots, 1, [botPool[0]]);
    chosen.push(...bots);
  }
  chosen.poolReal = realPool.length;
  chosen.poolBots = botPool.length;
  chosen.botChance = botWeightSum + realWeightSum > 0 ? botWeightSum / (botWeightSum + realWeightSum) : 0;
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
      vipLevel: row.vipLevel,
    }));
  };

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

// 征战随机匹配的助战队友：与随机挑战同一套抽签——
// 等级相近的真人快照各占 1 个签，再混入 `randomBotSlots` 个空签；
// 快照队友只作为战斗体参战，不写对方账号、不发奖。
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
  candidates, resolve, resolveTarget, isOffer, buildRandomFoe, forgetAccount, drawRandomPool, drawTeammates,
  randomPlayers, ratingWeight, weightedPick,
};
