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

  // 每只首领的奖励表（按 2026-11 图片逐项落地）：一局仍从本表抽 3~5 份 `rollDatas`，
  // 每份 4 个座位掷骰、点数最高者得。表内各项等概率，抽中后不重复。
  // `setIds` 用 gearSetMap 的套装 id：仙鹤 17 / 熊猫 18 / 浣熊 19 / 犀牛 28 /
  // 幕府 29 / 勇者 30 / 诅咒 31 / 机器猫 49 / 深海 48 / 狂战 51。
  const PURPLE = (sets, affixMax, label) => ({ kind: 'gear', quality: 3, setIds: sets, affixMax, name: label, value: 300 });
  const GEM = (level) => ({ kind: 'prop', id: 100 + Number(level), count: 1, name: level + '级宝石', value: Number(level) >= 4 ? 600 : 300 });
  const SHARDS = (n) => ({ kind: 'prop', id: 26, count: n, name: '蓝色碎片', value: n * 10 });
  const FRUIT = (id, name) => ({ kind: 'prop', id, count: 1, name, value: 200 });
  const GOLD = (n) => ({ kind: 'gold', gold: n, name: '金松果', value: n });

  const BOSS_REWARDS = {
    1: [
      { kind: 'pet_random', grade: 1, name: '任意1级1星幻兽', value: 400 },
      { kind: 'pet', petId: 14, name: '1级哈哈小丑', value: 400 },
      { kind: 'pet', petId: 29, name: '1级稻草人', value: 400 },
      { kind: 'pet', petId: 28, name: '1级招财熊猫', value: 400 },
      PURPLE([17, 18, 28], 2, '紫色装备（仙鹤/熊猫/犀牛）'),
      GEM(3),
      SHARDS(100),
      GOLD(150),
    ],
    2: [
      { kind: 'pet_random', grade: 1, name: '任意1级1星幻兽', value: 400 },
      { kind: 'pet_random', grade: 2, name: '任意1级2星幻兽', value: 400 },
      { kind: 'pet', petId: 18, name: '1级跳神娃娃', value: 400 },
      { kind: 'pet', petId: 16, name: '1级百战鳄鱼', value: 400 },
      { kind: 'pet', petId: 26, name: '1级铁嘴蜂', value: 400 },
      PURPLE([29, 30], 3, '紫色装备（幕府/勇者）'),
      PURPLE([31, 19], 3, '紫色装备（诅咒/浣熊）'),
      GEM(3),
      SHARDS(150),
      GOLD(200),
      FRUIT(47, '天使果实'),
      FRUIT(48, '恶魔果实'),
    ],
    3: [
      { kind: 'pet_random', grade: 3, name: '任意1级3星幻兽', value: 400 },
      { kind: 'pet', petId: 25, name: '1级哇哇', value: 400 },
      { kind: 'pet', petId: 27, name: '1级铃音海豚', value: 400 },
      PURPLE([31, 19], 3, '紫色装备（诅咒/浣熊）'),
      PURPLE([49, 48], 3, '紫色装备（机器猫/深海）'),
      GEM(3),
      SHARDS(200),
      GOLD(250),
      FRUIT(47, '天使果实'),
      FRUIT(48, '恶魔果实'),
    ],
    4: [
      { kind: 'pet_random', grade: 3, name: '任意1级3星幻兽', value: 400 },
      { kind: 'pet', petId: 32, name: '1级仙玲', value: 400 },
      { kind: 'pet', petId: 30, name: '1级酷法', value: 400 },
      { kind: 'pet', petId: 31, name: '1级神灯', value: 400 },
      PURPLE([31, 19], 3, '紫色装备（诅咒/浣熊）'),
      PURPLE([49, 48], 3, '紫色装备（机器猫/深海）'),
      PURPLE([51], 3, '紫色狂战装备'),
      GEM(3),
      GEM(4),
      SHARDS(250),
      GOLD(300),
    ],
  };

  const PET_PRIZE_FALLBACK = Object.freeze({
    key: 'hatch_points', kind: 'hatch', name: '孵化点', count: 400, value: 400,
  });

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


  function petTable() {
    const gd = (typeof GData !== 'undefined' && GData) ? GData : (globalThis && globalThis.GData);
    return gd && Array.isArray(gd.PETS) && gd.PETS.length ? gd : null;
  }
  function petSkillName(skillId) {
    const gd = petTable();
    const info = gd && gd.PET_SKILLS && gd.PET_SKILLS[Number(skillId)];
    return info ? String(info.name || '') : '';
  }


  function bossRewards(boss) {
    const id = Number(boss && boss.bossId) || 1;
    return BOSS_REWARDS[id] || BOSS_REWARDS[1];
  }

  function petDefOf(petId) {
    const gd = petTable();
    if (!gd) return null;
    return gd.PETS.find((p) => Number(p.id) === Number(petId)) || null;
  }

  function petPrizeOf(petId, level) {
    const def = petDefOf(petId);
    if (!def) return null;
    const lv = Math.max(1, Math.min(Number(def.maxLevel) || 1, Number(level) || 1));
    return {
      id: Number(def.id), name: String(def.name || '幻兽'), grade: Number(def.grade) || 1,
      maxLevel: Math.max(1, Number(def.maxLevel) || 1), leadership: Number(def.leadership) || 0,
      skillId: Number(def.skillId) || 0, skillName: petSkillName(def.skillId),
      level: lv, exp: 0,
    };
  }

  function randomPetPrize(grade, seed, index) {
    const gd = petTable();
    if (!gd) return null;
    const rand = mulberry32((Number(seed) ^ Math.imul(Number(index) + 1, 0x9E3779B9) ^ 0x5F356495) >>> 0);
    const pool = gd.PETS.filter((p) => Number(p.grade) === Number(grade));
    const list = pool.length ? pool : gd.PETS;
    const def = list[Math.floor(rand() * list.length)];
    return def ? petPrizeOf(def.id, 1) : null;
  }

  // 用种子把本首领奖励表洗一遍：一局抽 3~5 份且不重复，公开 rollDatas 可复算。
  function rewardOrder(seed, n) {
    const rand = mulberry32((Number(seed) ^ 0x85EBCA6B) >>> 0);
    const list = Array.from({ length: Math.max(0, Number(n) || 0) }, (_, i) => i);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  // 紫装奖励：按 `setIds` + 随机部位先定下具体装备 id（分奖页图标与实发一致）；
  // 词条在发奖时按 `affixMax` 掷 1~N 星。
  function gearPrize(template, seed, index) {
    const rand = mulberry32((Number(seed) ^ Math.imul(Number(index) + 1, 0x9E3779B9) ^ 0x2F6E2B1) >>> 0);
    const part = Math.floor(rand() * 4);
    const gmap = (typeof gearMap !== 'undefined' && gearMap) || (globalThis && globalThis.gearMap);
    const smap = (typeof gearSetMap !== 'undefined' && gearSetMap) || (globalThis && globalThis.gearSetMap);
    if (!gmap || !smap) return Object.assign({}, template);
    const allow = new Set((template.setIds || []).map(Number));
    const ids = [];
    gmap.each((key, def) => {
      if (!def || Number(def.type) !== part) return;
      const setId = parseInt(def.setId, 10);
      if (allow.size && !allow.has(setId)) return;
      const set = smap.getValue(setId);
      if (!set || Number(set.quality) !== 3) return;
      ids.push(parseInt(key, 10));
    });
    if (!ids.length) return Object.assign({}, template);
    ids.sort((a, b) => a - b);
    return Object.assign({}, template, { gearId: ids[Math.floor(rand() * ids.length)] });
  }

  function pickReward(seed, index, boss) {
    const pool = bossRewards(boss);
    const order = rewardOrder(seed, pool.length);
    const template = pool[order[index % order.length]];
    if (template.kind === 'pet_random') {
      const pet = randomPetPrize(template.grade, seed, index);
      if (!pet) return PET_PRIZE_FALLBACK;
      return Object.assign({}, template, { kind: 'pet', pet });
    }
    if (template.kind === 'pet' && template.petId) {
      const pet = petPrizeOf(template.petId, 1);
      if (!pet) return PET_PRIZE_FALLBACK;
      return Object.assign({}, template, { pet });
    }
    if (template.kind === 'gear') return gearPrize(template, seed, index);
    return Object.assign({}, template);
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
    const pool = bossRewards(boss);
    const count = Math.min(pool.length, 3 + (Math.abs(Math.floor(Number(seed) || 0)) % 3));
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
    BOSS_REWARDS, bossRewards, PET_PRIZE_FALLBACK, randomPetPrize, rewardPlan, rewardValue,
  };

  if (typeof window !== 'undefined') window.CampaignData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
