'use strict';
/* ============================================================
 * tools/seed-test-account.cjs — 给「开发者测试账号」补一段可信的成长史
 * ------------------------------------------------------------
 * 作用（一次事务，可回滚）：
 *   1. 把指定 player_id 的账号从当前等级 **按游戏规则** 推到目标等级；
 *   2. 每一级写一条 battle_snapshots（装备/武技随等级真实变化）；
 *   3. 发一批测试用消耗品（金松果 / 卷轴 / 碎片 / 宝箱 …）；
 *   4. 在 dev_accounts 里登记为开发者测试账号。
 *
 * 写法约束：
 *   · 全部走 State 的公开 API（gainExp / chooseWS / doUpgrade / composeGear /
 *     mergeGears / wear），不手改 weapons / skills / gears 数组；
 *   · Math.random 换成固定种子，同一 player_id + 目标等级可复现；
 *   · 改库前先导出一份 JSON 备份；不满足前置条件直接退出。
 *
 * 用法：
 *   SSDZ_SEED_TEST=1 node tools/seed-test-account.cjs --player 100000 --level 40 --apply
 *   SSDZ_SEED_TEST=1 node tools/seed-test-account.cjs --player 100000 --level 40 --dry-run
 * 服务器上跑（用服务器自己的游戏代码）：
 *   sudo -n env SSDZ_SEED_TEST=1 SSDZ_ROOT=/opt/ssdz DATA_DIR=/var/lib/ssdz \
 *     node /tmp/seed-test-account.cjs --player 100000 --level 40 --apply
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }
function die(msg) { console.error('[seed-test] ' + msg); process.exit(1); }

if (process.env.SSDZ_SEED_TEST !== '1') die('拒绝执行：需要显式 SSDZ_SEED_TEST=1');

const ROOT = path.resolve(process.env.SSDZ_ROOT || path.join(__dirname, '..'));
process.env.GAME_ROOT = ROOT;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'save', 'online'));
const PLAYER_ID = Number(arg('--player', '100000'));
const TARGET = Number(arg('--level', '40'));
const APPLY = flag('--apply');
const DRY = flag('--dry-run') || !APPLY;

const db = require(path.join(ROOT, 'server', 'db.js'));
db.open({ dir: DATA_DIR });
const runtime = require(path.join(ROOT, 'server', 'game', 'runtime.js'));
const store = require(path.join(ROOT, 'server', 'game', 'store.js'));
const battle = require(path.join(ROOT, 'server', 'game', 'battle.js'));
const { fighterFromState } = require(path.join(ROOT, 'server', 'game', 'fighter.js'));
runtime.boot();

if (!Number.isInteger(PLAYER_ID) || PLAYER_ID <= 0) die('bad --player');
if (!Number.isInteger(TARGET) || TARGET < 6 || TARGET > 90) die('--level 必须在 6~90');

const account = db.get(
  'SELECT a.*, p.player_id FROM accounts a JOIN player_ids p ON p.account_id = a.id WHERE p.player_id = ?',
  PLAYER_ID
);
if (!account) die('找不到 player_id=' + PLAYER_ID + ' 的账号');
const row = store.getRow(account.id);
if (!row) die('账号没有经典存档');
const before = store.decode(row.payload);
const START = Math.max(1, Number(before.level) || 1);
if (START >= TARGET) die(`账号已经是 ${START} 级，目标 ${TARGET} 级不高于现状`);
if (START < 2) die('账号等级过低，先正常玩到 2 级以上再补成长史');

/* ---------------- 测试账号的消耗品清单 ----------------
 * 只放「消耗型」道具；转生果（13）故意不给：误用会把等级重置回 1 级。
 * 每项不超过 State.PROP_HARD_CAP（9999）。 */
const GRANT = {
  1: 999,    // 小体力药剂
  2: 999,    // 大体力药剂
  3: 999,    // 大力丸
  4: 999,    // 敏捷丸
  5: 999,    // 速度丸
  7: 999,    // 经验丸
  10: 99, 11: 99, 12: 99,   // 属性转化丸
  16: 99, 17: 99, 18: 99, 19: 99, // 永久属性道具
  21: 999,   // 技能卷轴
  22: 999,   // 武器卷轴
  23: 999,   // 挑战书
  24: 999, 25: 999, 26: 999, // 白/绿/蓝碎片
  36: 99,    // 英雄帖
  37: 99,    // 属性书
  38: 99,    // 红包
  39: 99,    // 勇气徽章
  41: 99, 42: 99, 43: 99, 44: 99, // 超级药丸
  45: 999, 46: 999, // 果实种子
  47: 99, 48: 99,   // 天使/恶魔果实
  50: 99,    // 抽奖卷
  51: 999,   // 属性碎片
  79: 99,    // 魔法袋
  80: 99,    // 黑色卡片
  82: 99,    // 召唤证
  87: 99,    // 征战令
  90: 99,    // 金宝箱
};
const GRANT_GOLD = 500000;

/* ---------------- 成长模拟 ---------------- */
const SKILL_HINTS = ['必杀', '连击', '暴击', '吸血', '反击', '闪避', '护体', '致命', '狂暴', '幸运', '力王', '敏捷', '速度'];
function choiceScore(c) {
  const n = String((c && c.name) || '');
  const at = SKILL_HINTS.findIndex((k) => n.includes(k));
  return at < 0 ? 0 : 100 - at * 4;
}
function extSlots(quality) { return quality >= 3 ? 2 : quality === 2 ? 1 : 0; }

const gearPickCache = new Map();
function gearPool(api, quality, level) {
  const key = quality + ':' + level;
  if (!gearPickCache.has(key)) {
    const ids = [];
    gearMap.each((k, v) => {
      const gi = api.gearInst(Number(k));
      if (gi && gi.quality === quality && gi.useLevel <= level) ids.push(gi.id);
    });
    ids.sort((a, b) => a - b);
    gearPickCache.set(key, ids);
  }
  return gearPickCache.get(key);
}

/** 每个部位当前最好的一件（不一定是已穿戴的那件）。 */
function bestByType(api, level) {
  const best = new Map();
  for (const g of api.myGears().filter((x) => x.useLevel <= level)) {
    const cur = best.get(g.type);
    if (!cur || g.quality > cur.quality || (g.quality === cur.quality && g.abilityVal > cur.abilityVal)) best.set(g.type, g);
  }
  return best;
}

function wearBest(api, level) {
  for (const g of bestByType(api, level).values()) if (!g.used) api.wear(g.key);
}

function gearPass(api, save, level) {
  /* 掉落节奏：每级最多 1 件，品质跟当前等级能穿的上限走（白→绿→蓝→紫），
   * 9 级以前靠新手白装，10 级起才持续有掉落。 */
  const drop = level >= 10 && (level <= 20 || level % 2 === 0);
  if (drop) {
    const quality = level >= 20 ? 3 : level >= 16 ? 2 : level >= 12 ? 1 : 0;
    const pool = gearPool(api, quality, level);
    if (pool.length) {
      const id = pool[Math.floor(Math.random() * pool.length)];
      api.addGear(id, api.randomExt(extSlots(quality), quality >= 3 ? 3 : 2));
    }
  }
  /* 不做自动融合：正常玩家会把同品质备件留着以后合，这里保留背包里的备件，
   * 让测试时还能自己试「装备融合」；穿戴只挑每个部位当前最好的一件。 */
  wearBest(api, level);
  bump.at(-1).bag = (save.gears || []).length;
}

const bump = [];   // 每级一行，报告用

function upgradePass(api, save, level, acquired, at) {
  for (const kind of ['weapon', 'skill']) {
    const list = kind === 'weapon' ? api.myWeapons() : api.mySkills();
    for (const item of list) {
      const acq = acquired.get(kind + ':' + item.id) || level;
      /* 兴趣系数 0.55~1.04：不同武技的养成速度不一样，避免 40 级全部同一等级。 */
      const interest = 0.55 + ((item.id * 37) % 50) / 100;
      const want = Math.max(1, Math.min(13, 1 + Math.floor((level - acq) * interest / 2.4)));
      let guard = 0;
      while (item.level < want && guard++ < 6) {
        const info = api.upgradeInfo(kind, item.id);
        if (!info || info.max) break;
        if (Number(info.levelLimit) > level) break;
        if (Number(save.goldPoint) < info.coin) break;
        if ((Number(save.props[info.bookId]) || 0) < info.book) break;
        const r = api.doUpgrade(kind, item.id);
        if (!r.ok) break;
        item.level++;
        at.upgrades++;
      }
    }
  }
}

function simulate(payload) {
  const snaps = [];
  const seed = (0x5eed0000 ^ (PLAYER_ID * 2654435761) ^ (TARGET * 97)) >>> 0;
  const out = battle.withSeed(seed, () => runtime.withState(payload, ({ api, save }) => {
    /* 模拟期的“工作资金”：升级要花金松果与卷轴，先垫足，最后一次性改写为最终发放量。 */
    save.goldPoint = Math.max(Number(save.goldPoint) || 0, 3000000);
    for (const id of [21, 22, 23, 24, 25, 26]) save.props[id] = Math.max(Number(save.props[id]) || 0, 9999);
    save.earnHistory = [];

    const acquired = new Map();
    for (const w of api.myWeapons()) acquired.set('weapon:' + w.id, START);
    for (const s of api.mySkills()) acquired.set('skill:' + s.id, START);

    for (let level = START + 1; level <= TARGET; level++) {
      const at = { level, wins: 0, upgrades: 0, merges: 0 };
      bump.push(at);
      /* 1) 经验：按“同级对手”的挑战经验折算成胜场，金松果按每胜 4 个建模。 */
      const need = Math.max(1, GData.nextExp(level - 1) - Number(save.exp || 0));
      const perWin = Math.max(1, api.challengeExp(level - 1, level - 1));
      const wins = Math.max(1, Math.ceil(need / perWin));
      at.wins = wins;
      save.allWins = Number(save.allWins || 0) + wins;
      save.goldPoint += wins * 4;
      const ups = api.gainExp(need, { noTrack: true });
      if (!ups.length || Number(save.level) !== level) throw new Error(`第 ${level} 级升级失败（当前 ${save.level}）`);

      /* 2) 升级奖励的三选一：按偏好挑一个，挑不动才用随机兜底。 */
      while (api.pendingWS()) {
        const choices = api.currentWSChoices().slice().sort((a, b) => choiceScore(b) - choiceScore(a));
        let picked = false;
        for (const c of choices) {
          const r = api.chooseWS(c.kind, c.id);
          if (r.ok) { acquired.set(c.kind + ':' + c.id, level); picked = true; break; }
        }
        if (!picked) {
          const r = api.chooseWSRandom();
          if (!r.ok) throw new Error('第 ' + level + ' 级的武技三选一无法结算');
        }
      }

      /* 3) 已学会的武技按“想练到几级”逐级尝试，失败留到下一级继续。 */
      upgradePass(api, save, level, acquired, at);

      /* 4) 装备：掉落 → 融合备用件 → 每个部位穿当前最好的。 */
      gearPass(api, save, level);

      const fighter = fighterFromState({ useProps: false });
      if (fighter.level !== level) throw new Error('快照等级不符：' + fighter.level + ' != ' + level);
      snaps.push(fighter);
    }

    /* 5) 最终发放：测试用消耗品 + 金松果；清掉模拟期的收益流水与 30 级提示。 */
    save.goldPoint = GRANT_GOLD;
    for (const [id, count] of Object.entries(GRANT)) {
      save.props[id] = Math.max(Number(save.props[id]) || 0, count);
    }
    save.earnHistory = [];
    save.supportPrompt = false;
    save.supportPromptShown = true;
    save.allFails = Math.max(Number(save.allFails) || 0, Math.round(Number(save.allWins || 0) * 0.12));
    save.savedAt = Date.now();

    const finalFighter = fighterFromState({ useProps: false });
    if (JSON.stringify(finalFighter) !== JSON.stringify(snaps[snaps.length - 1])) {
      throw new Error('最终面板与目标等级快照不一致');
    }
    return { payload: null, finalFighter };
  }));
  return { payload: out.payload, snaps, finalFighter: out.value.finalFighter };
}

const result = simulate(before);
const after = result.payload;
const snaps = result.snaps;

/* ---------------- 一致性检查 ---------------- */
if (!after) die('模拟没有产出存档');
if (Number(after.level) !== TARGET) die('模拟后等级不对：' + after.level);
const levels = snaps.map((s) => s.level);
for (let i = 0; i < levels.length; i++) if (levels[i] !== START + 1 + i) die('快照等级不连续：' + levels.join(','));
const final = result.finalFighter;
if (!final.gears.length) die('40 级没有任何已穿戴装备');
if (final.weapons.length + final.skills.length > (runtime.withState(after, ({ api }) => api.wsLimit()).value)) die('武技数量超过上限');

const report = {
  playerId: PLAYER_ID,
  accountId: Number(account.id),
  display: account.name + '#' + account.tag,
  from: START, to: TARGET,
  snapshotsAdded: snaps.length,
  final: {
    level: final.level,
    stats: { power: final.power, agility: final.agility, speed: final.speed, hp: final.maxHp },
    weapons: final.weapons.length, skills: final.skills.length,
    gears: final.gears.length,
    gearsOwned: (after.gears || []).length,
    worn: final.gears.map((g) => g.id),
    gold: after.goldPoint,
    props: Object.keys(GRANT).length,
  },
  milestones: snaps.filter((s) => [10, 12, 16, 20, 25, 30, 35, 40].includes(s.level)).map((s) => ({
    level: s.level,
    ws: s.weapons.length + s.skills.length,
    maxWsLevel: Math.max(0, ...s.weapons.map((w) => w.level), ...s.skills.map((x) => x.level)),
    gears: s.gears.length,
    bag: (bump.find((b) => b.level === s.level) || {}).bag || 0,
    stats: [s.power, s.agility, s.speed, s.maxHp],
  })),
};
console.log(JSON.stringify({ dryRun: DRY, report }, null, 1));

if (DRY) {
  const preview = path.resolve(arg('--preview', path.join('out', `seed-preview-${PLAYER_ID}.json`)));
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, JSON.stringify({ report, snapshots: snaps }, null, 1));
  console.log('[seed-test] dry-run：未改数据库；预览写入 ' + preview);
  process.exit(0);
}

/* ---------------- 备份 ---------------- */
const snapshotRows = db.all('SELECT * FROM battle_snapshots WHERE account_id = ? AND mode = ?', account.id, 'classic');
const backupDir = path.resolve(arg('--backup-dir', path.join(DATA_DIR, 'backups')));
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `account-${PLAYER_ID}-before-${Date.now()}.json`);
fs.writeFileSync(backupFile, JSON.stringify({
  exportedAt: new Date().toISOString(),
  account: { id: Number(account.id), name: account.name, tag: account.tag, playerId: PLAYER_ID },
  save: { revision: Number(row.revision), summary: store.summaryOf(before), payload: before },
  snapshots: snapshotRows.map((r) => ({
    id: r.id, level: Number(r.level), revision: Number(r.revision), isCurrent: !!Number(r.is_current),
    source: r.source, createdAt: Number(r.created_at), fighter: JSON.parse(Buffer.from(r.json).toString('utf8')),
  })),
}, null, 1));
console.log('[seed-test] 备份：' + backupFile);

/* ---------------- 落库（单事务） ---------------- */
const sum = store.summaryOf(after);
const now = Date.now();
db.tx(() => {
  const current = store.getRow(account.id);
  if (Number(current.revision) !== Number(row.revision)) throw new Error('写入期间存档被改动，请重试');
  db.run('CREATE TABLE IF NOT EXISTS dev_accounts (account_id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT \'\', note TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL)');
  db.run('UPDATE battle_snapshots SET is_current = 0 WHERE account_id = ? AND mode = ?', account.id, 'classic');
  for (const f of snaps) {
    const revision = Number(db.get(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM battle_snapshots WHERE account_id = ? AND mode = ? AND level = ?',
      account.id, 'classic', f.level
    ).n);
    db.run(
      `INSERT INTO battle_snapshots (id, account_id, mode, level, revision, is_current, json, summary, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      's_' + crypto.randomBytes(9).toString('base64url'), account.id, 'classic', f.level, revision,
      f.level === TARGET ? 1 : 0, Buffer.from(JSON.stringify(f)),
      `${f.name}|${f.level}|${f.power}/${f.agility}/${f.speed}/${f.maxHp}`, 'dev-seed', now + f.level
    );
  }
  db.run(
    `UPDATE saves SET revision = ?, payload = ?, level = ?, name = ?, power = ?, agility = ?, speed = ?, hp = ?,
       gold = ?, gold_cup = ?, integral = ?, updated_at = ? WHERE account_id = ? AND mode = 'classic'`,
    Number(row.revision) + 1, store.encode(after), sum.level, sum.name, sum.power, sum.agility, sum.speed, sum.hp,
    sum.gold, sum.goldCup, sum.integral, now, account.id
  );
  db.run(
    `INSERT INTO dev_accounts (account_id, label, note, created_at) VALUES (?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET label = excluded.label, note = excluded.note`,
    account.id, 'developer-test', `Seeded progression ${START}->${TARGET} on ${new Date(now).toISOString()}`, now
  );
});
console.log('[seed-test] 完成：' + report.display + ' ' + START + ' → ' + TARGET + ' 级，写入 ' + snaps.length + ' 条快照');
