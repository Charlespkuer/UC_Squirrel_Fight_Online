// campaign-data.js — 征战（四人组队副本）的静态数据
(function () {
  'use strict';

  // `State.genAI` 用 Math.random 抽装备/宠物。首领数值必须每局一致：
  // 否则同一只 BOSS 每场强弱不同，既没法做 4 人平衡，也没法复算。
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

  // 征战首领：武器/技能/固定循环沿用原版 bossConfig + campaignNpcs 的形态。
  // ⚠ `bias` 不是原版数值（原版只有等级/技能/宠物帧，没有属性表）：它按当前伤害公式标定，
  // 同等级单人胜率 ≤15%、四人队 ≥30%；改战斗公式后必须重跑 `test-online-campaign` 再调。
  const BOSSES = [
    {
      id: 'campaign_hare', bossId: 1, mcFrame: 1, name: '暗御狡兔', bigName: '狡兔',
      level: 35, unlockLevel: 35, rewardExpRatio: 1,

      pet: { level: [6, 10], grades: [55, 28, 13, 4] },
      bias: { power: 2.0, agility: 1.3, speed: 1.43, hp: 3.2 },
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

      pet: { level: [8, 13], grades: [45, 30, 18, 7] },
      bias: { power: 2.4, agility: 0.9, speed: 1.155, hp: 3.2 },
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

      pet: { level: [12, 18], grades: [30, 32, 25, 13] },
      bias: { power: 1.2, agility: 1.5, speed: 1.265, hp: 5.6 },
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
      // 幻兽等级期望 ≈19.0（16~24；1★ 封顶 10、2★ 封顶 20）。
      // 高星权重也随首领提高，否则低星幻兽会被自己的等级上限压回 10 级。
      pet: { level: [16, 24], grades: [8, 24, 40, 28] },
      bias: { power: 3.0, agility: 1.1, speed: 1.10, hp: 4.8 },
      weapons: [{ id: 2, level: 12 }],
      skills: [{ id: 14, level: 12 }, { id: 16, level: 10 }, { id: 5, level: 10 }, { id: 10, level: 10 }],
      castable: [14], pattern: ['weapon', 'skill', 'common', 'skill'], mech: [],
      type: '征战首领 · 猿将',
      patternDesc: '猿将重击：大榔头 → 小宇宙爆发 → 普攻 → 小宇宙爆发（高生命、高减伤）',
      desc: '四只已开放首领中最厚、最重的一只。',
    },
  ];


  const LOCKED_BOSS = Object.freeze({
    id: 'campaign_leopard', bossId: 5, mcFrame: 5, name: '豹王', bigName: '豹王',
    level: 70, locked: true, type: '征战首领 · 豹王',
    patternDesc: '暂未开放', desc: '原版 `checkIsCampaigning` 写着「豹王暂未开放」，这里保持锁定。',
  });

  const TICKET_PROP = 87;
  const TICKET_SHOP_PRICE = 200;
  const PARTY_SIZE = 4;
  const MIN_LEVEL = 20;
  const ENTRY_CUP_COST = 0;

  // · 随机幻兽×1（2026-11-07 起替代原「孵化点×400」：奖池生成时就把种类/星级/等级
  // 35→60 提升，见 `BOSSES[].pet`。幻兽栏满时服务端仍折回 400 孵化点，见
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

  const PET_PRIZE_FALLBACK = Object.freeze({
    key: 'hatch_points', kind: 'hatch', name: '孵化点', count: 400, weight: 0, value: 400,
  });
  const PET_DEFAULT = Object.freeze({ level: [7, 11], grades: [55, 28, 13, 4] });

  const BY_ID = Object.fromEntries(BOSSES.map((b) => [b.id, b]));

  function bossList() {

    return BOSSES.concat([LOCKED_BOSS]);
  }

  function bossFor(id) {
    const key = String(id || '');
    return BY_ID[key] || BOSSES.find((b) => String(b.bossId) === key) || null;
  }

  // 把一只首领做成战斗体。`State` 由调用方传进来（浏览器/服务端各有一份）。
  function buildFoe(State, bossId) {
    const boss = bossFor(bossId);
    if (!boss) return null;
    const level = Math.max(1, Math.min(State.MAX_PLAYER_LEVEL || 90, boss.level));

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
      // 被色诱/脱装后 Sim 会回退到 baseStats；必须与缩放后的三维一致，
      // 否则 BOSS 被卸装时面板会突然掉回未缩放的同级玩家。
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

  // 掷骰：服务端给每个队员各掷一次，用 (成员, 房间) 定种子，事后可复算。
  function diceValue(seed, index) {
    let t = (Number(seed) ^ (Number(index) * 0x9E3779B9)) >>> 0;
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const v = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    return Math.floor(v * 100);
  }


  function rewardRandom(seed, index) {
    return mulberry32((Number(seed) ^ Math.imul(Number(index) + 1, 0x9E3779B9)) >>> 0)();
  }

  function petTable() {
    const gd = (typeof GData !== 'undefined' && GData) ? GData : (globalThis && globalThis.GData);
    return gd && Array.isArray(gd.PETS) && gd.PETS.length ? gd : null;
  }
  function petSkillName(skillId) {
    const gd = petTable();
    const info = gd && gd.PET_SKILLS && gd.PET_SKILLS[Number(skillId)];
    return info ? String(info.name || '') : '';
  }


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

  // 原版 `rollDatas`：一局 3~5 份奖品，每份 4 个座位各掷一次，点数最高者得。
  // 助战/人机赢了不发货（那一份作废，见服务端 `applyPrize` 只在 `winnerKind === 'player'`
  // 不能因为“整局没有真人赢家”就把第一份硬塞给点数更低的真人。
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
