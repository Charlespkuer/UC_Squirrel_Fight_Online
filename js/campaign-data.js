/* ============================================================
 * campaign-data.js — 征战（四人组队副本）的静态数据
 * ------------------------------------------------------------
 * 原版取证：`MainMovie.as:12274 showCampaign()` / `:12291 showCampaignPage(page)`；
 * `MainMovie.as:19152 bossConfig` 有 5 条，但 `checkIsCampaigning` 明确写着
 * **「豹王暂未开放」**，`campaignNpcs` 也只配了狡兔 / 狼王 / 妖狐 / 猿将四只。
 * 所以这里同样只接**原版已开放**的四只，第 5 格按原版留「未开放」。
 *
 * 门票是**征战令**（道具 87；本服道具商店每天出售、每天限购 1 个，200 金松果；
 * 原版是周二/四/六限时、每天限购 2 个）；
 * 界面文案取自素材里的真实文本框：
 *   「报名需扣除1个征战令」「正在等待队友，凑够人数后自动开始挑战。。。」
 *   「LV:」「BOSS」「领导力需求：」「1/4」
 *
 * 本文件同时被浏览器和服务端加载（服务端 `runtime.js` 的 SCRIPTS 里有它），
 * 所以**不许碰 DOM**，只放常量与纯函数。
 * ============================================================ */
(function () {
  'use strict';

  /* `State.genAI` 用 Math.random 抽装备/宠物。首领数值必须每局一致：
   * 否则同一只 BOSS 每场强弱不同，既没法做 4 人平衡，也没法复算。
   * 这里用固定种子包住 genAI（与 `server/game/battle.js` 的 withSeed 同一套 PRNG）。 */
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function random() {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function withSeed(seed, fn) {
    const old = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = old; }
  }

  /* 征战首领：武器/技能/固定循环沿用原版 bossConfig + campaignNpcs 的形态，
   * 四只的等级是原版配置值（35/40/50/60），不随版本浮动。
   *
   * ⚠ `bias` 不是原版数值：原版只有等级/技能/宠物帧，没有属性表，服务端
   *   `joinCopy.do` 的 `combats` 抓包也没留下 BOSS 面板。2026-11 用户报
   *   「四雄像单人档」后按 **4 人共享血量** 重标：以同等级 `genAI` 玩家为 1.0，
   *   hp ×3.3~5.6（四名队员分摊同一条血），力/敏/速 ×1.0~1.55。
   *   实测（同等级玩家、固定随机流）：单人胜率 3~7%，4 人队 64~77%、
   *   平均 2.7~3.0 人过关；+5 级队 86~92%。
   *
   * 2026-11-05 用户口径：**四雄在当前基础上 力/敏/速 +10%、血 +20%**
   *   （= 下面每个 bias 的 power/agility/speed ×1.10、hp ×1.20，数值照乘写死，
   *   不在运行期再乘一次，免得以后调档时两层乘数找不到出处）。
   *   重测（同一套固定随机流，见 `tools/test-online-campaign.cjs` 的四雄用例）：
   *   4 人队 35%~75%（改档前 70%~95%）、单人 0~5%、平均 2.6~3.4 人上场；
   *   +5 级队 55%~100%。
   *   塔里的 `tower-data.js` 有自己的一份 `CAMPAIGN_BOSSES`（旧 1.20/3.00/... 档），
   *   改这里不影响无尽塔 60/70/80/90 的强度。 */
  const BOSSES = [
    {
      id: 'campaign_hare', bossId: 1, mcFrame: 1, name: '暗御狡兔', bigName: '狡兔',
      level: 35, unlockLevel: 35, rewardExpRatio: 1,
      /* 奖池「随机幻兽」档：等级区间 + 星级权重（1★~4★，权重不必相加为 100）。
       * 等级会被幻兽自身的 maxLevel 截断，所以低星档的实际期望略低于区间中值。
       * 这只首领的期望 ≈8 级（6~10），与同等级 AI 幻兽的量级一致。 */
      pet: { level: [6, 10], grades: [55, 28, 13, 4] },
      bias: { power: 1.21, agility: 1.375, speed: 1.43, hp: 3.96 },
      weapons: [{ id: 8, level: 10 }],
      skills: [{ id: 2, level: 10 }, { id: 11, level: 10 }, { id: 23, level: 10 }],
      castable: [23], pattern: ['weapon', 'skill', 'weapon', 'common'], mech: ['freeze'],
      type: '征战首领 · 狡兔',
      patternDesc: '狡兔三窟：菜刀 → 幸运一击 → 菜刀 → 普攻（高速、高闪避）',
      desc: '敏捷与速度极高，靠闪避与幸运一击打爆发；每第 3 次行动前冻结对手 1 回合。',
    },
    {
      id: 'campaign_wolf', bossId: 2, mcFrame: 2, name: '暗御狼王', bigName: '狼王',
      level: 40, unlockLevel: 40, rewardExpRatio: 1.1,
      /* 幻兽等级期望 ≈10.1（8~13）。 */
      pet: { level: [8, 13], grades: [45, 30, 18, 7] },
      bias: { power: 1.705, agility: 1.21, speed: 1.155, hp: 4.56 },
      weapons: [{ id: 12, level: 11 }],
      skills: [{ id: 9, level: 11 }, { id: 10, level: 11 }, { id: 24, level: 11 }, { id: 14, level: 10 }],
      castable: [14], pattern: ['weapon', 'skill', 'weapon', 'common'], mech: ['freeze'],
      type: '征战首领 · 狼王',
      patternDesc: '狼王扑杀：狼牙棒 → 小宇宙爆发 → 狼牙棒 → 普攻（高力量）',
      desc: '力量最高，暴击与反击都很硬；每第 3 次行动前冻结对手 1 回合。',
    },
    {
      id: 'campaign_fox', bossId: 3, mcFrame: 3, name: '暗御妖狐', bigName: '妖狐',
      level: 50, unlockLevel: 50, rewardExpRatio: 1.15,
      /* 幻兽等级期望 ≈13.5（12~18）。 */
      pet: { level: [12, 18], grades: [30, 32, 25, 13] },
      bias: { power: 1.54, agility: 1.43, speed: 1.265, hp: 6.72 },
      weapons: [{ id: 7, level: 12 }],
      skills: [{ id: 8, level: 12 }, { id: 15, level: 12 }, { id: 6, level: 10 }, { id: 16, level: 10 }],
      castable: [8, 15], pattern: ['skill', 'weapon', 'skill', 'common'], mech: [],
      type: '征战首领 · 妖狐',
      patternDesc: '妖狐魅影：色诱之术 → 通灵召唤 → 色诱之术 → 普攻（控制与消耗）',
      desc: '色诱与通灵交替，擅长拖慢并消耗对手。',
    },
    {
      id: 'campaign_ape', bossId: 4, mcFrame: 4, name: '暗御猿将', bigName: '猿将',
      level: 60, unlockLevel: 60, rewardExpRatio: 1.2,
      /* 幻兽等级期望 ≈19.0（16~24；1★ 封顶 10、2★ 封顶 20）。
       * 高星权重也随首领提高，否则低星幻兽会被自己的等级上限压回 10 级。 */
      pet: { level: [16, 24], grades: [8, 24, 40, 28] },
      bias: { power: 1.705, agility: 1.21, speed: 1.10, hp: 6.48 },
      weapons: [{ id: 2, level: 12 }],
      skills: [{ id: 14, level: 12 }, { id: 16, level: 10 }, { id: 5, level: 10 }, { id: 10, level: 10 }],
      castable: [14], pattern: ['weapon', 'skill', 'common', 'skill'], mech: [],
      type: '征战首领 · 猿将',
      patternDesc: '猿将重击：大榔头 → 小宇宙爆发 → 普攻 → 小宇宙爆发（高生命、高减伤）',
      desc: '四只已开放首领中最厚、最重的一只。',
    },
  ];

  /* 第 5 格：原版 bossConfig 里有、但 `checkIsCampaigning` 写着「暂未开放」。 */
  const LOCKED_BOSS = Object.freeze({
    id: 'campaign_leopard', bossId: 5, mcFrame: 5, name: '豹王', bigName: '豹王',
    level: 70, locked: true, type: '征战首领 · 豹王',
    patternDesc: '暂未开放', desc: '原版 `checkIsCampaigning` 写着「豹王暂未开放」，这里保持锁定。',
  });

  const TICKET_PROP = 87;          // 征战令
  const TICKET_SHOP_PRICE = 200;   // 商店价（本服每天出售、每天限购 1 个）
  const PARTY_SIZE = 4;            // 界面「1/4」
  const MIN_LEVEL = 20;            // 原版：可报名的最低等级（低于此不开门）
  const ENTRY_CUP_COST = 0;

  /* 2026-11 用户口径（方案 A）：保留原版 200 金松果票价，把收益拉回原版量级。
   * 原版 `rollDatas`：一局 3~5 份奖品，每份 4 人掷骰、最高者得；类型含
   * 道具 / 幻兽 / 装备。这里照这个结构，但换成当前数据模型能直接入账的高价值档：
   *   · 金松果 200（等价票价）
   *   · 天使果实（原版商店 200 金松果）
   *   · 蓝色碎片×20（两次随机蓝装合成）
   *   · 技能/武器卷轴×25（升级材料）
   *   · 紫色装备×1（按部位/品质从 GEAR_BASE 抽）
   *   · 随机幻兽×1（2026-11-07 起替代原「孵化点×400」：奖池生成时就把种类/星级/等级
   *     掷定并写进 `prize.pet`，分奖页直接显示那只幻兽的原版头像；等级期望随首领
   *     35→60 提升，见 `BOSSES[].pet`。幻兽栏满时服务端仍折回 400 孵化点，见
   *     `server/game/campaign.js` 的 applyPrize）
   * 权重按“单份期望约 210 金松果等值”配；一局 3~5 份，四人各约 200。
   * 价值是**估算**：金松果/天使果实按商店价，其余按碎片合成/材料量级折算。
   * 原版具体掉率没有抓包，这里只保证结构和期望，不冒充原版逐项概率。 */
  const REWARD_POOL = Object.freeze([
    { key: 'gold', kind: 'gold', name: '金松果', gold: 200, weight: 30, value: 200 },
    { key: 'angel_fruit', kind: 'prop', id: 47, count: 1, name: '天使果实', weight: 15, value: 200 },
    { key: 'blue_shards', kind: 'prop', id: 26, count: 20, name: '蓝色碎片', weight: 20, value: 200 },
    { key: 'skill_scrolls', kind: 'prop', id: 21, count: 25, name: '技能卷轴', weight: 10, value: 150 },
    { key: 'weapon_scrolls', kind: 'prop', id: 22, count: 25, name: '武器卷轴', weight: 10, value: 150 },
    { key: 'purple_gear', kind: 'gear', quality: 3, name: '紫色装备', weight: 10, value: 300 },
    { key: 'random_pet', kind: 'pet', name: '幻兽', weight: 5, value: 400 },
  ]);
  const REWARD_WEIGHT = REWARD_POOL.reduce((sum, p) => sum + p.weight, 0);
  /* 幻兽表缺失 / 幻兽栏满 / 旧数据时的等价兜底：仍是原版的 400 孵化点。 */
  const PET_PRIZE_FALLBACK = Object.freeze({
    key: 'hatch_points', kind: 'hatch', name: '孵化点', count: 400, weight: 0, value: 400,
  });
  const PET_DEFAULT = Object.freeze({ level: [7, 11], grades: [55, 28, 13, 4] });

  const BY_ID = Object.fromEntries(BOSSES.map((b) => [b.id, b]));

  function bossList() {
    /* 界面 5 格：前 4 格是已开放首领，第 5 格是锁定的豹王。 */
    return BOSSES.concat([LOCKED_BOSS]);
  }

  function bossFor(id) {
    const key = String(id || '');
    return BY_ID[key] || BOSSES.find((b) => String(b.bossId) === key) || null;
  }

  /**
   * 把一只首领做成战斗体。`State` 由调用方传进来（浏览器/服务端各有一份）。
   * 数值基线用 `State.genAI(level, name)` 同等级的玩家曲线，再乘上 boss 自己的 bias ——
   * 这样它天然落在「同等级高配玩家」的量级上，不会像塔里那样随层数膨胀。
   */
  function buildFoe(State, bossId) {
    const boss = bossFor(bossId);
    if (!boss) return null;
    const level = Math.max(1, Math.min(State.MAX_PLAYER_LEVEL || 90, boss.level));
    /* 固定种子：同一只 BOSS 每局的面板一样（装备/宠物/随机成长都锁死）。
     * 种子只跟 bossId 走，所以四位首领各自稳定、互不串味。 */
    const seed = (0xC0FFEE ^ Math.imul(Number(boss.bossId) || 1, 2654435761)) >>> 0;
    const base = withSeed(seed, () => State.genAI(level, '', {
      name: boss.name, levelJitter: 0, gearSelfLevel: true,
    }));
    const bias = boss.bias || { power: 1, agility: 1, speed: 1, hp: 1 };
    const power = Math.max(1, Math.round(base.power * (bias.power || 1)));
    const agility = Math.max(1, Math.round(base.agility * (bias.agility || 1)));
    const speed = Math.max(1, Math.round(base.speed * (bias.speed || 1)));
    const hp = Math.max(1, Math.round(base.hp * (bias.hp || 1)));
    const foe = {
      name: boss.name,
      level,
      npcType: null,
      power, agility, speed, hp,
      /* 被色诱/脱装后 Sim 会回退到 baseStats；必须与缩放后的三维一致，
       * 否则 BOSS 被卸装时面板会突然掉回未缩放的同级玩家。 */
      baseStats: { power, agility, speed, hp },
      weapons: boss.weapons.map((w) => ({ id: w.id, level: Math.max(1, Math.min(15, w.level)) })),
      skills: boss.skills.map((k) => ({ id: k.id, level: Math.max(1, Math.min(15, k.level)) })),
      pattern: Array.isArray(boss.pattern) ? boss.pattern.slice() : [],
      castable: Array.isArray(boss.castable) ? boss.castable.slice() : undefined,
      mech: Array.isArray(boss.mech) ? boss.mech.slice() : [],
      effects: {},
      gears: [],
      wears: null,
      pets: [],
      campaign: { id: boss.id, bossId: boss.bossId, mcFrame: boss.mcFrame, bigName: boss.bigName, level },
      bossKind: 'campaign',
    };
    foe.maxHp = foe.hp;
    return foe;
  }

  /** 掷骰：服务端给每个队员各掷一次，用 (成员, 房间) 定种子，事后可复算。
   *  原版分奖页的两位数字框最多显示 `99`（截图里未掷时就是 `00`），所以点数取 0~99。 */
  function diceValue(seed, index) {
    let t = (Number(seed) ^ (Number(index) * 0x9E3779B9)) >>> 0;
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const v = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    return Math.floor(v * 100);
  }

  /** 一份奖品的加权抽取；用 (seed, index) 定死，事后可复算。 */
  function rewardRandom(seed, index) {
    return mulberry32((Number(seed) ^ Math.imul(Number(index) + 1, 0x9E3779B9)) >>> 0)();
  }
  /** 幻兽字典由 `js/gamedata.js` 提供；本文件在它之前加载，所以调用时再懒取。 */
  function petTable() {
    const gd = (typeof GData !== 'undefined' && GData) ? GData : (globalThis && globalThis.GData);
    return gd && Array.isArray(gd.PETS) && gd.PETS.length ? gd : null;
  }
  function petSkillName(skillId) {
    const gd = petTable();
    const info = gd && gd.PET_SKILLS && gd.PET_SKILLS[Number(skillId)];
    return info ? String(info.name || '') : '';
  }

  /**
   * 掷一只「征战幻兽」：星级按首领的权重、等级按首领的区间，全部由 (seed, index) 定死。
   * 结果会写进 `prize.pet` 随公开 `rollDatas` 一起下发，所以分奖页看到的是**最终**
   * 那只幻兽，而不是中奖后再随机。等级会被幻兽自身 `maxLevel` 截断。
   */
  function randomPetPrize(boss, seed, index) {
    const gd = petTable();
    if (!gd) return null;
    const conf = (boss && boss.pet) || PET_DEFAULT;
    const rand = mulberry32((Number(seed) ^ Math.imul(Number(index) + 1, 0x9E3779B9) ^ 0x5F356495) >>> 0);
    const weights = (Array.isArray(conf.grades) ? conf.grades : PET_DEFAULT.grades)
      .slice(0, 4).map((n) => Math.max(0, Number(n) || 0));
    const total = weights.reduce((n, w) => n + w, 0);
    let grade = 1;
    if (total > 0) {
      let roll = rand() * total;
      for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];
        if (roll < 0) { grade = i + 1; break; }
      }
    }
    const pool = gd.PETS.filter((p) => Number(p.grade) === grade);
    const list = pool.length ? pool : gd.PETS;
    const def = list[Math.floor(rand() * list.length)];
    if (!def) return null;
    const range = Array.isArray(conf.level) ? conf.level : PET_DEFAULT.level;
    const lo = Math.max(1, Math.round(Number(range[0]) || 1));
    const hi = Math.max(lo, Math.round(Number(range[1]) || lo));
    const maxLevel = Math.max(1, Number(def.maxLevel) || 1);
    const level = Math.max(1, Math.min(maxLevel, lo + Math.floor(rand() * (hi - lo + 1))));
    return {
      id: Number(def.id), name: String(def.name || '幻兽'), grade: Number(def.grade) || grade,
      maxLevel, leadership: Number(def.leadership) || 0,
      skillId: Number(def.skillId) || 0, skillName: petSkillName(def.skillId),
      level, exp: 0,
    };
  }

  function pickReward(seed, index, boss) {
    let roll = rewardRandom(seed, index) * REWARD_WEIGHT;
    let prize = REWARD_POOL[REWARD_POOL.length - 1];
    for (const entry of REWARD_POOL) {
      roll -= entry.weight;
      if (roll < 0) { prize = entry; break; }
    }
    if (prize.kind !== 'pet') return prize;
    const pet = randomPetPrize(boss, seed, index);
    if (!pet) return PET_PRIZE_FALLBACK;
    return Object.assign({}, prize, { pet });
  }

  /**
   * 原版 `rollDatas`：一局 3~5 份奖品，每份 4 个座位各掷一次，点数最高者得。
   * 当前有助战人机：人机赢了不发货；若整局没有真人赢，则第一份保底改判给
   * 真人里点数最高者，避免“赢了还全被助战抢走”。4 个真人时每人期望约 1 份。
   * `boss` 只影响「随机幻兽」档的种类/等级，其他奖品与旧版逐位兼容。
   */
  function rewardPlan(seed, seats, boss) {
    const list = (Array.isArray(seats) ? seats : []).slice(0, 4).map((s, i) => ({
      seat: Number.isFinite(Number(s && s.seat)) ? Number(s.seat) : i,
      accountId: Number(s && s.accountId) || 0,
      kind: String((s && s.kind) || 'empty'),
    }));
    const count = 3 + (Math.abs(Math.floor(Number(seed) || 0)) % 3);
    const prizes = [];
    for (let i = 0; i < count; i++) {
      const prize = pickReward(seed, i, boss);
      const rolls = list.map((s, seat) => ({
        seat, accountId: s.accountId, kind: s.kind,
        point: diceValue((Number(seed) ^ Math.imul(i + 1, 0x9E3779B9)) >>> 0, seat),
      }));
      let win = null;
      for (const r of rolls) if (!win || r.point > win.point) win = r;
      prizes.push({
        index: i, prize, rolls,
        winnerSeat: win ? win.seat : -1,
        winnerAccountId: win ? win.accountId : 0,
        winnerKind: win ? win.kind : 'empty',
        discarded: !win || win.kind !== 'player',
      });
    }
    if (!prizes.some((p) => p.winnerKind === 'player')) {
      const real = list.filter((s) => s.kind === 'player');
      if (real.length && prizes.length) {
        const first = prizes[0];
        let best = null;
        for (const r of first.rolls) if (r.kind === 'player' && (!best || r.point > best.point)) best = r;
        if (best) {
          first.winnerSeat = best.seat;
          first.winnerAccountId = best.accountId;
          first.winnerKind = 'player';
          first.discarded = false;
          first.forced = true;
        }
      }
    }
    return { count, prizes };
  }
  function rewardValue(reward) {
    return Number(reward && reward.value) || 0;
  }

  const api = {
    BOSSES, LOCKED_BOSS, BY_ID, bossList, bossFor, buildFoe, diceValue,
    TICKET_PROP, TICKET_SHOP_PRICE, PARTY_SIZE, MIN_LEVEL, ENTRY_CUP_COST,
    REWARD_POOL, PET_PRIZE_FALLBACK, randomPetPrize, rewardPlan, rewardValue,
  };

  if (typeof window !== 'undefined') window.CampaignData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
