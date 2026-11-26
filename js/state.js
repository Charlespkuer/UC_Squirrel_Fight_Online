// state.js — 玩家状态、存档、养成系统（武器/技能/装备/道具/关卡）

(function () {
  'use strict';


  const testMode = typeof location !== 'undefined' && /(?:^|[?&])(?:test=[12]|qa=1)(?:&|$)/.test(location.search || '');
  // `window.__SSDZ_ONLINE__` 由 scripts/index-online.html 在加载本文件之前置位。
  // ② 存档不落本地（save/load 变空操作，权威在服务端）；
  // ③ 不能切界面（switchMode 直接拒绝）。
  const ONLINE = typeof window !== 'undefined' && !!window.__SSDZ_ONLINE__;
  // 服务端运行时也走 `ONLINE`，但每日任务必须由服务端生成并落库；客户端只读服务端
  // 下发的 `quests`，不能自己 `questState()` 重摇（否则两端题面不一致、领奖必失败）。
  const SERVER = typeof window !== 'undefined' && !!window.__SSDZ_SERVER__;
  const ONLINE_RULES = ONLINE || (typeof window !== 'undefined' && !!window.__SSDZ_ONLINE_COMBAT__);
  const SAVE_KEY = testMode ? 'ssdz_test_save_v1' : 'ssdz_save_v1';
  // 双界面独立存档：经典/现代各一份进度，同一条文件/localStorage 记录里放两个槽位。
  const UI_MODE_KEY = 'ssdz_ui_mode';
  const SAVE_SLOTS = ['modern', 'classic'];
  const BATTLE_HISTORY_LIMIT = 50;
  const DEFAULT_SAVE_SLOT = 'classic';
  const ENERGY_INTERVAL = 5 * 60 * 1000;
  const ENERGY_HARD_CAP = 999;
  // 单个道具的数量上限：任何来源（掉落、礼包、任务、商店、调试）都不会超过它。
  const PROP_HARD_CAP = 9999;
  // 这三个编号在原版里是货币/经验值（挂进背包也用不掉），存档里出现就直接忽略。
  const CURRENCY_PROP_IDS = [8, 15, 40];

  const BLACK_PROP_IDS = Object.freeze([77, 78, 80, 89]);
  // 联机版金宝箱固定 10 点属性 + 非属性其它奖励；离线版仍按单箱 6/8/10/12 点。
  // 71~90 每级 1 个，联机账号累计 20 个（见 applyLevelUps / beginChest）。
  const MAX_PLAYER_LEVEL = 90;

  const RANDOM_FOE_SCALE = 1.08;
  const FREE_POINT_RANDOM = 2;
  // 联机金宝箱的固定收益：10 点基础属性（自动随机分配）+ 1 件非属性其它奖励。
  const CHEST_FIXED_POINTS = 10;
  // 原版宝石附加属性总档：1~7 级 = 3/5/8/12/17/23/30（= (n²+n+4)/2）。
  // 镶嵌时随机分到各条词条，单条最多 12 档（`getAttachment(id, star, count-1)` 的 12 档表）。
  const GEM_AFFIX_TOTALS = Object.freeze([3, 5, 8, 12, 17, 23, 30]);
  const GEM_AFFIX_CAP = 12;
  // 到这一级时给玩家一次「自愿支持作者」的提示（一次性，落存档；不换取任何游戏内好处）。
  const SUPPORT_PROMPT_LEVEL = 30;

  const STAT_KEYS = ['power', 'agility', 'speed', 'hp'];
  const STAT_NAMES = { power: '力量', agility: '敏捷', speed: '速度', hp: '生命' };
  const STAT_FIELDS = { power: 'power', agility: 'agility', speed: 'speed', hp: 'maxHp' };
  const STAT_GAIN = { power: 1, agility: 1, speed: 1, hp: 5 };
  // 离线版永久属性点硬上限 651（378 成长 + 20×12 金宝箱 + 29 神迹 + 4 天梯永久丸）；
  // 联机版不设总上限（见 statCapRoom）。
  const STAT_HARD_CAP = 651;

  const HP_PER_STAT = 5;

  const SHARE_KEYS = ['power', 'agility', 'speed'];
  const STAT_SHARE_MIN = 0.25;

  const RESOLUTIONS = [
    { key: 'auto', label: '自动（跟随窗口）', height: 0 },
    { key: '690', label: '1170 × 690', height: 690 },
    { key: '720', label: '1280 × 720', height: 720 },
    { key: '810', label: '1440 × 810', height: 810 },
    { key: '900', label: '1600 × 900', height: 900 },
    { key: '1080', label: '1920 × 1080', height: 1080 },
  ];
  const RESOLUTION_KEYS = RESOLUTIONS.map((r) => r.key);

  const UIMODES = ONLINE
    ? [{ key: 'classic', label: '经典' }]
    : [
      { key: 'modern', label: '现代' },
      { key: 'classic', label: '经典' },
    ];
  const UIMODE_KEYS = UIMODES.map((m) => m.key);
  // 联机客户端的体力/倒计时只认服务端时间锚 + 单调时钟；
  // 服务端（SERVER）和单机仍用本机时钟。改手机时间不能多恢复体力。
  function nowMs() {
    if (ONLINE && !SERVER && typeof window !== 'undefined' &&
        typeof window.__ssdzServerNow === 'function') {
      const v = Number(window.__ssdzServerNow());
      if (Number.isFinite(v) && v > 0) return v;
    }
    return Date.now();
  }
  function energyCapForLevel(level) {
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.round(Number(level) || 1)));
    let cap = GData.NEW_PLAYER.maxEnergy;
    for (let i = 2; i <= lv; i++) cap += i <= 3 ? 3 : i <= 20 ? 2 : 1;
    return cap;
  }
  // 联机版升级静默奖励：2~10 级每次 1 瓶、11~20 级 2 瓶，按十级递增（90 级 9 瓶）。
  function levelStaminaPotion(level) {
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.round(Number(level) || 1)));
    return lv < 2 ? 0 : Math.ceil(lv / 10);
  }
  let S = null;
  let otherSlot = null; // 另一个界面的完整存档（切换时交换）
  let saveMode = readUiModePref();

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const integer = (value, fallback, min) => Number.isFinite(Number(value)) && value !== null
    ? Math.max(min == null ? 0 : min, Math.floor(Number(value))) : fallback;

  function normalizeItems(items, map) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).map((item) => {
      const parts = String(item).split(/[:,]/);
      const id = Number(parts[0]);
      if (!map.getValue(id) || seen.has(id)) return null;
      seen.add(id);
      return id + ':' + Math.min(15, integer(parts[1], 1, 1));
    }).filter(Boolean);
  }

  // 联机版金宝箱是「固定 10 点基础属性 + 1 件非属性其它奖励」；旧档/旧版本的
  // 单项结果在联机读档时迁成同一形状。离线版仍保留原来的单项结果。
  function chestOtherDefaultReward() {
    const p = propMap.getValue(105);
    if (p) return { kind: 'prop', id: 105, count: 1, name: p.name };
    return { kind: 'gold', count: 500, name: '金松果' };
  }
  function normalizeChestReward(raw, allowPoints) {
    if (!object(raw)) return null;
    const kind = String(raw.kind);
    if (!['prop', 'points', 'gold', 'hatch', 'gear'].includes(kind)) return null;
    if (!allowPoints && kind === 'points') return null;
    const count = Math.min(1000000, integer(raw.count, 0));
    if (!(count > 0)) return null;
    const out = { kind, count, name: String(raw.name || '') };
    if (kind === 'prop' || kind === 'gear') {
      out.id = integer(raw.id, 0);
      if (!(kind === 'prop' ? propMap.getValue(out.id) : gearMap.getValue(out.id))) return null;
    }
    return out;
  }
  function normalizeChestPending(raw) {
    if (!object(raw) || Number(raw.propId) !== 90) return null;
    if (ONLINE) {
      let reward = null;
      if (raw.points != null) {
        reward = normalizeChestReward(raw.reward, false);
      } else {
        const legacy = normalizeChestReward(raw.reward, true);
        if (legacy) reward = legacy.kind === 'points' ? chestOtherDefaultReward() : legacy;
      }
      if (!reward) return null;
      return { propId: 90, points: CHEST_FIXED_POINTS, pointsGain: normalizePointGain(raw.pointsGain), reward };
    }
    const reward = normalizeChestReward(raw.reward, true);
    if (!reward) return null;
    return { propId: 90, reward };
  }

  // 每日成长按关卡各记一份：键 = 关卡号（1..36），值 = 当天通关整轮的次数。
  // 旧存档的全局 `count` 不折算到每关 —— 它是惩罚项，宁可归零也不让 36 关一起变难。
  function normalizeChallengeCounts(raw) {
    const out = {};
    if (!object(raw)) return out;
    const max = GData.STAGE_TYPES.length * 6;
    for (const key of Object.keys(raw)) {
      const stageId = Math.floor(Number(key));
      if (!(stageId >= 1 && stageId <= max)) continue;
      const n = Math.max(0, integer(raw[key], 0));
      if (n > 0) out[stageId] = n;
    }
    return out;
  }

  function normalizeSave(raw) {
    const next = Object.assign(clone(GData.NEW_PLAYER), raw);
    const now = nowMs();

    let recruitEnergyRefund = 0;
    next.level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(next.level, GData.NEW_PLAYER.level, 1)));
    for (const key of ['power', 'agility', 'speed', 'maxHp']) {
      next[key] = integer(next[key], GData.NEW_PLAYER[key], 1);
    }
    const legacyFreePoints = Math.min(100000, Math.max(0, integer(raw.freePoints, 0)));
    if (legacyFreePoints > 0) allocateRandomPointsTo(next, legacyFreePoints);
    delete next.freePoints;
    delete next.pointUndo;
    for (const key of ['exp', 'energy', 'goldPoint', 'goldCup', 'dailyWins', 'allWins', 'dailyFails', 'allFails', 'reborn', 'joinRankCount', 'lotteryFree', 'woodRecord', 'woodCount', 'woodDamage']) {
      next[key] = integer(next[key], GData.NEW_PLAYER[key]);
    }
    next.levelFrozen = raw.levelFrozen === true || Number(raw.levelFrozen) === 1 ? 1 : 0;
    next.woodBest = normalizeWoodBest(raw.woodBest);
    next.chestPending = normalizeChestPending(raw.chestPending);
    next.levelChests = Math.min(MAX_PLAYER_LEVEL - 70, Math.max(0, integer(raw.levelChests, 0)));
    next.blackCardsWeek = (() => {
      const src = object(raw.blackCardsWeek) ? raw.blackCardsWeek : {};
      return {
        week: typeof src.week === 'string' ? src.week : '',
        count: Math.max(0, Math.min(3, integer(src.count, 0))),
      };
    })();
    // 联机版无尽塔周奖励账：只做形状清洗；换周重置由服务端 `claimEndlessTower`
    // 按 Asia/Shanghai 的周一键判断，客户端读档不能按本机时钟把服务端账抹掉。
    next.towerWeek = (() => {
      const tr = (typeof window !== 'undefined' && window.TowerRewards) || null;
      if (tr && typeof tr.normalizeWeek === 'function') return tr.normalizeWeek(raw.towerWeek);
      const src = object(raw.towerWeek) ? raw.towerWeek : {};
      const week = typeof src.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.week) ? src.week : '';
      return { week, tickets: Math.max(0, Math.min(10, integer(src.tickets, 0))), runs: [] };
    })();
    next.blackTowerLayer = Math.max(0, integer(raw.blackTowerLayer, 0));
    next.blackBox100 = raw.blackBox100 === true;
// 体力上限由等级直接决定（满级 90 级 = 200），再叠上超级松鼠的增量；旧档的旧曲线超额值在这里被收回。
    {
      const v = object(raw.vip) ? raw.vip : {};
// 体力上限的 +60 只在「读档时 VIP 仍在有效期」才给；capApplied 另有含义
// （特权 5 的装备格子是首次开通永久生效，所以不能拿它来判断体力）
      const vipOn = Number(v.until) > now;
      next.maxEnergy = energyCapForLevel(next.level) + (vipOn ? VIP_ENERGY_BONUS : 0);
    }
    next.energy = Math.min(ENERGY_HARD_CAP, next.energy);
    next.integral = next.integral == null ? null : integer(next.integral, 0);
    next.rankCupClaimWeek = typeof raw.rankCupClaimWeek === 'string' ? raw.rankCupClaimWeek : '';
    next.goldCupToday = Math.max(0, integer(next.goldCupToday, 0, 0));
    next.goldCupDate = validLocalDate(next.goldCupDate) ? next.goldCupDate : '';

    next.rankPurchases = (() => {
      const src = object(raw.rankPurchases) ? raw.rankPurchases : {};
      const out = {};
      for (const key of Object.keys(src)) {
        const n = integer(src[key], 0);
        if (/^\d+$/.test(key) && n > 0) out[key] = n;
      }
      return out;
    })();
    next.rankPurchaseTotals = (() => {
      const src = object(raw.rankPurchaseTotals) ? raw.rankPurchaseTotals : {};
      const out = {};
      for (const key of Object.keys(src)) {
        const n = integer(src[key], 0);
        if (/^\d+$/.test(key) && n > 0) out[key] = n;
      }
      return out;
    })();

    next.rankMonthPurchases = (() => {
      const src = object(raw.rankMonthPurchases) ? raw.rankMonthPurchases : {};
      const out = {};
      for (const key of Object.keys(src)) {
        const n = integer(src[key], 0);
        if (/^\d+$/.test(key) && n > 0) out[key] = n;
      }
      return out;
    })();
    next.rankPurchaseMonth = typeof raw.rankPurchaseMonth === 'string' ? raw.rankPurchaseMonth : '';
    // 永久属性货的累计额度账：`rankStatUsed` 是四件商品合计已兑换次数，
    // `rankStatMigrated` 保证月度旧账只搬一次（服务端读档不会重置它）。
    next.rankStatUsed = Math.max(0, integer(raw.rankStatUsed, 0));
    next.rankStatMigrated = raw.rankStatMigrated === true;
    // 一次性迁移标记：把改版前按周账里的狂战件数搬进月度账（只做一次）。
    next.rankBerserkMigrated = raw.rankBerserkMigrated === true;
    // 旧存档最多 12 个汉字，保留原样；新昵称在注册时已按 7 个字收口。
    {
      const rawName = typeof next.name === 'string' ? next.name.trim() : '';
      const rules = typeof window !== 'undefined' && window.NicknameRules;
      next.name = rawName
        ? (rules && typeof rules.truncate === 'function' ? (rules.truncate(rawName, 36) || '小松鼠') : rawName.slice(0, 20))
        : '小松鼠';
    }
    next.lastEnergyTs = Number(next.lastEnergyTs) > 0 ? Math.min(now, integer(next.lastEnergyTs, now, 1)) : now;
    next.upgradeFails = (() => {
      const src = object(raw.upgradeFails) ? raw.upgradeFails : {};
      const out = {};
      for (const key of Object.keys(src)) {
        if (!/^[ws]\d+$/.test(key)) continue;
        const v = integer(src[key], 0);
        if (v > 0) out[key] = Math.min(999, v);
      }
      return out;
    })();
    next.trueUpgrades = (object(raw.trueUpgrades) && raw.trueUpgrades.date === localDate())
      ? { date: raw.trueUpgrades.date, count: Math.max(0, integer(raw.trueUpgrades.count, 0)) }
      : { date: localDate(), count: 0 };
    next.earnHistory = (Array.isArray(raw.earnHistory) ? raw.earnHistory : [])
      .filter((d) => object(d) && validLocalDate(d.date))
      .slice(-EARN_DAYS)
      .map((d) => ({ date: d.date, exp: Math.max(0, integer(d.exp, 0)), gold: Math.max(0, integer(d.gold, 0)) }));
    next.weapons = normalizeItems(next.weapons, weaponsMap);
    next.skills = normalizeItems(next.skills, skillsMap);
    for (const key of ['props', 'propsStates']) {
      const source = object(next[key]) ? next[key] : {};
      next[key] = {};
      for (const id of Object.keys(source)) {
        if (CURRENCY_PROP_IDS.includes(Number(id))) continue;
        const count = Math.min(PROP_HARD_CAP, integer(source[id], 0));
        if (propMap.getValue(id) && count > 0) next[key][id] = count;
      }
    }
    const usedSlots = new Set(), gearKeys = new Set();
    next.gears = (Array.isArray(next.gears) ? next.gears : [])
      .map((g) => migrateLegacyOrangeGear(g))
      .filter((g) => object(g) && gearMap.getValue(g.id)).map((g, index) => {
      const info = gearInst(g.id);
      let key = typeof g.key === 'string' && g.key ? g.key : 'legacy_' + index;
      if (gearKeys.has(key)) key += '_' + index;
      gearKeys.add(key);
      const used = g.used === true && info.useLevel <= next.level && !usedSlots.has(info.type);
      if (used) usedSlots.add(info.type);
      // attr：本件装备的主属性点（基准 ±5% 的 roll 结果）。老档没这个字段时按基准值补。
      const entry = { id: info.id, key, used, ext: normalizeExt(g.ext),
        attr: integer(g.attr, 0, 0) || info.attrBase };
      if (g.orange === true) entry.orange = true;

      if (g.starred === true) entry.starred = true;
      const gemLv = g.gem && gemLevel(g.gem.id);
      if (gemLv) entry.gem = { id: 100 + gemLv, units: normalizeGemUnits(g.gem.units, entry.ext, gemLv) };
      return entry;
    });
    // 5 级换装教程的一次性白装。新档显式 false；旧档没有字段时按「已经升过 5 级 / 已有装备 /
    // 旧引导里已经记过 gearsGift」迁移，防止每次打开游戏都把教程奖励重发一遍。
    if (raw.starterGearGiven === true) next.starterGearGiven = true;
    else if (raw.starterGearGiven === false) next.starterGearGiven = false;
    else next.starterGearGiven = Number(next.level) > 5
      || (Array.isArray(next.gears) && next.gears.length > 0)
      || !!(raw.tutorial && raw.tutorial.gearsGift === true);
    next.stages = object(next.stages) ? next.stages : {};
// 升级「三选一」还没选的组：只保留合法的 {kind,id}，并且不能是已经拥有的
    {
      const owned = new Set([
        ...(next.weapons || []).map((w) => 'w' + parseInt(w)),
        ...(next.skills || []).map((s) => 's' + parseInt(s)),
      ]);
      const picks = [];
      for (const group of Array.isArray(next.wsPicks) ? next.wsPicks : []) {
        if (!Array.isArray(group)) continue;
        const seen = new Set();
        const list = [];
        for (const c of group) {
          if (!object(c) || (c.kind !== 'weapon' && c.kind !== 'skill')) continue;
          const id = Number(c.id);
          const def = (c.kind === 'weapon' ? weaponsMap : skillsMap).getValue(id);
          const code = (c.kind === 'weapon' ? 'w' : 's') + id;
          if (!def || seen.has(code) || owned.has(code)) continue;
          seen.add(code);
          list.push({ kind: c.kind, id, name: def.name, remark: def.remark || '', type: def.type || '' });
        }
        if (list.length) picks.push(list);
        if (picks.length >= 40) break;
      }
      next.wsPicks = picks;
    }
    // 天使/恶魔果实：已经抽出的 1 个随机结果必须原样保留（大退重进不重抽）；
    {
      const rawFruit = object(next.fruitChoices) ? next.fruitChoices : {};
      const owned = new Set([
        ...(next.weapons || []).map((w) => 'w' + parseInt(w)),
        ...(next.skills || []).map((s) => 's' + parseInt(s)),
      ]);
      const fruitChoices = {};
      for (const id of [47, 48]) {
        const p = rawFruit[id];
        if (!object(p) || !Array.isArray(p.options)) continue;
        const mode = p.mode === 'lose' ? 'lose' : 'gain';
        const list = [];
        for (const c of p.options) {
          if (!object(c) || (c.kind !== 'weapon' && c.kind !== 'skill')) continue;
          const num = Number(c.id);
          const def = (c.kind === 'weapon' ? weaponsMap : skillsMap).getValue(num);
          if (!def) continue;
          // 「师父驾到」不进任何果实池；老存档里已经抽出的该候选直接作废。
          if (c.kind === 'skill' && num === MASTER_SKILL_ID) continue;
          const code = (c.kind === 'weapon' ? 'w' : 's') + num;
          if (mode === 'gain' && owned.has(code)) continue;
          if (mode === 'lose' && !owned.has(code)) continue;
          list.push({ kind: c.kind, id: num, name: def.name, remark: def.remark || '', type: def.type || '' });
        }
        if (list.length) fruitChoices[id] = { mode, options: list.slice(0, 1), at: Number(p.at) || 0 };
      }
      next.fruitChoices = fruitChoices;
    }
    // 服务端待确认的果实候选同样不能保留「师父驾到」；否则旧候选还会在弹窗里出现。
    if (object(next.__onlineFruitChoices)) {
      const online = {};
      for (const id of [47, 48]) {
        const p = next.__onlineFruitChoices[id];
        if (!object(p) || !Array.isArray(p.options)) continue;
        const options = p.options.filter((c) => !(c && c.kind === 'skill' && Number(c.id) === MASTER_SKILL_ID));
        if (options.length) online[id] = Object.assign({}, p, { options });
      }
      next.__onlineFruitChoices = online;
    }

    {
      const rawSeen = object(next.fruitSeen) ? next.fruitSeen : {};
      const fruitSeen = {};
      for (const id of [47, 48]) {
        const list = Array.isArray(rawSeen[id]) ? rawSeen[id] : [];
        const out = [];
        for (const code of list) {
          if (typeof code !== 'string' || !/^[ws]\d+$/.test(code) || out.indexOf(code) >= 0) continue;
          out.push(code);
          if (out.length >= 500) break;
        }
        fruitSeen[id] = out;
      }
      next.fruitSeen = fruitSeen;
    }
    const savedRuns = object(next.stageRuns) ? next.stageRuns : {};
    next.stageRuns = {};
    for (const id of Object.keys(savedRuns)) {
      const run = savedRuns[id];
      if (!npcOf(Number(id), 1) || !object(run)) continue;
      next.stageRuns[id] = { npcIndex: Math.min(3, integer(run.npcIndex, 1, 1)), revives: Math.min(2, integer(run.revives, 0)), needsRevive: run.needsRevive === true, masterOnly: run.masterOnly === true, masterFree: run.masterFree === true };
      if (Number.isFinite(Number(run.carryHp))) next.stageRuns[id].carryHp = Math.max(0, Math.min(1, Number(run.carryHp)));
      // 徒弟战败后留给师父的那一场：对手剩余血量比例（见 stagePrenticeLost）。
      if (run.foeCarryHp != null && Number.isFinite(Number(run.foeCarryHp))) next.stageRuns[id].foeCarryHp = Math.max(0, Math.min(1, Number(run.foeCarryHp)));
    }
    // `stages` 必须像 `stageRuns` 一样重建一个新对象：直接原地改会让
    // `runOnSave` 的 before/after 共用同一份 `stages`，diff 认为没变 → 服务端已通关、
    const savedStages = object(next.stages) ? next.stages : {};
    next.stages = {};
    for (const id of Object.keys(savedStages)) {
      const progress = savedStages[id];
      if (!npcOf(Number(id), 1) || !object(progress)) continue;
      if (!next.stageRuns[id] && (progress.keep === true || (!object(raw.stageRuns) && progress.passed !== true && Number(progress.npcIndex) > 1))) {
        next.stageRuns[id] = { npcIndex: Math.min(3, integer(progress.npcIndex, 1, 1)), revives: Math.min(2, integer(progress.revives, 0)), needsRevive: progress.revive === true };
      }
      next.stages[id] = { npcIndex: Math.min(3, integer(progress.npcIndex, 1, 1)), passed: progress.passed === true };
      if (next.stages[id].passed) next.stages[id].npcIndex = 3;
    }
    next.wears = object(next.wears) ? next.wears : {};
// 师徒：旧存档只有 {name, level}，补齐属性/武器技能/日贡字段
    next.master = object(next.master) && typeof next.master.name === 'string' ? {
      name: next.master.name.slice(0, 20),
      level: integer(next.master.level, 1, 1),
      power: Number.isFinite(Number(next.master.power)) ? Number(next.master.power) : null,
      agility: Number.isFinite(Number(next.master.agility)) ? Number(next.master.agility) : null,
      speed: Number.isFinite(Number(next.master.speed)) ? Number(next.master.speed) : null,
      hp: Number.isFinite(Number(next.master.hp)) ? Number(next.master.hp) : null,
      weapons: Array.isArray(next.master.weapons) ? next.master.weapons.slice(0, 20) : [],
      skills: Array.isArray(next.master.skills) ? next.master.skills.slice(0, 20) : [],
      // 真人师父 / 人机师父的来源标记必须保留：注销、出师、逐出都按它清理。
      accountId: Math.max(0, integer(next.master.accountId, 0)),
      tag: String(next.master.tag || '').slice(0, 12),
      bot: next.master.bot === true,
    } : null;
    // 没有师父就不能保留「师父驾到」：无主技能在读档时统一清掉。
    if (!next.master) {
      next.skills = next.skills.filter((entry) => Number(String(entry).split(':')[0]) !== MASTER_SKILL_ID);
    }
    next.prentices = (Array.isArray(next.prentices) ? next.prentices : [])
      .filter((p) => object(p) && typeof p.name === 'string')
      .slice(0, 3)
      .map((p) => ({
        name: p.name.slice(0, 20),
        level: integer(p.level, 1, 1),
        exp: integer(p.exp, 0),
        power: integer(p.power, 0, 0), agility: integer(p.agility, 0, 0),
        speed: integer(p.speed, 0, 0), hp: integer(p.hp, 0, 0),
        weapons: Array.isArray(p.weapons) ? p.weapons.slice(0, 20) : [],
        skills: Array.isArray(p.skills) ? p.skills.slice(0, 20) : [],
        // 收徒时存下的装备快照：关卡「徒弟先上阵」要用它给徒弟穿装备。
        gears: normalizeFoeGears(p.gears),

        accountId: Math.max(0, integer(p.accountId, 0)),
        realId: Math.max(0, integer(p.realId, 0)),
        tag: String(p.tag || '').slice(0, 12),
        bot: p.bot === true,
        since: validLocalDate(p.since) ? p.since : localDate(),
        joinedAt: Number(p.joinedAt) > 0 ? Number(p.joinedAt) : localDateTime(validLocalDate(p.since) ? p.since : localDate(), 0, 0),
        lastExpDate: typeof p.lastExpDate === 'string' ? p.lastExpDate : '',
        tributeClaimedDate: validLocalDate(p.tributeClaimedDate) ? p.tributeClaimedDate : '',
      }));
    if (object(next.recruitChallenge) && next.recruitChallenge.fee === 10 && typeof next.recruitChallenge.token === 'string') {
      next.goldPoint += 10;
      recruitEnergyRefund = Math.max(0, Number(next.recruitChallenge.energyFee) || 0);
    }
    next.recruitChallenge = null;
    if (recruitEnergyRefund) next.energy = Math.min(next.maxEnergy || ENERGY_HARD_CAP, next.energy + recruitEnergyRefund);
    next.masterKickDate = typeof next.masterKickDate === 'string' ? next.masterKickDate : '';
    // 村庄建筑（祭坛 / 神迹 / 幻兽牧场）：老档没有这个字段 → 按原版"每个建筑 1 级"补一份。
    {
      const raw2 = object(raw.buildings) ? raw.buildings : {};
      next.buildings = {};
      for (const key of ['altar', 'miracle', 'beast']) {
        const b = object(raw2[key]) ? raw2[key] : {};
        const add = object(b.add) ? b.add : {};
        const upgrading = b.upgrading === true && Number(b.doneAt) > 0;
        next.buildings[key] = {
          level: Math.max(1, Math.min(BUILDING_MAX_LEVEL, integer(b.level, 1, 1))),
          upgrading: upgrading,
          doneAt: upgrading ? Math.max(0, integer(b.doneAt, 0)) : 0,
          buffId: Math.max(0, Math.min(3, integer(b.buffId, 0))),
          buffDate: validLocalDate(b.buffDate) ? b.buffDate : '',
          add: key === 'miracle'
            ? { power: Math.max(0, integer(add.power, 0)), agility: Math.max(0, integer(add.agility, 0)), speed: Math.max(0, integer(add.speed, 0)), hp: Math.max(0, integer(add.hp, 0)) }
            : null,
          addType: Number.isFinite(Number(b.addType)) ? Number(b.addType) : -1,
        };
      }
      // ⚠ 这里不结算升级完成：结算必须发生在"进村庄"时（原版 `showHomeLand` → `checkUpgraded`），
    }

    ensurePetTables();
    {
      next.hatchPoint = Math.max(0, integer(raw.hatchPoint, 1000, 0, 9999999));
      next.petsCapacity = Math.max(1, Math.min(PET_MAX_CAPACITY, integer(raw.petsCapacity, 6, 1)));
      const seenKeys = new Set();
      next.pets = (Array.isArray(raw.pets) ? raw.pets : []).filter((p) => object(p)).slice(0, PET_MAX_CAPACITY).map((p) => {
        const def = PET_BY_ID.get(Number(p.id));
        if (!def) return null;
        let key = typeof p.key === 'string' && p.key ? p.key.slice(0, 40) : '';
        if (!key || seenKeys.has(key)) key = 'pet' + def.id + '_' + (seenKeys.size + 1);
        seenKeys.add(key);
        const level = Math.max(1, Math.min(def.maxLevel, integer(p.level, 1, 1)));
        return {
          key, id: def.id, name: def.name, grade: def.grade, maxLevel: def.maxLevel,
          leadership: def.leadership, skillId: def.skillId,
          level, exp: Math.max(0, integer(p.exp, 0)), nextExp: petNextExp(level),
        };
      }).filter(Boolean);
      const keys = new Set(next.pets.map((p) => p.key));
      next.petsTeam = [...new Set((Array.isArray(raw.petsTeam) ? raw.petsTeam : []).map(String))]
        .filter((k) => keys.has(k)).slice(0, 3);
    }
// 超级松鼠（原版 VIP）：旧档没有这个字段，补一份未开通的默认值。
    {
      const v = object(raw.vip) ? raw.vip : {};
      next.vip = {
        level: Math.max(1, Math.min(VIP_MAX_LEVEL, integer(v.level, 1) || 1)),
        exp: Math.max(0, integer(v.exp, 0)),
        until: Math.max(0, integer(v.until, 0)),
        capAdded: Math.max(0, integer(v.capAdded, 0)),
        capApplied: v.capApplied === true,
        lastDaily: typeof v.lastDaily === 'string' ? v.lastDaily : '',
      };
    }
    next.battles = normalizeBattleHistory(next.battles).map(compactOnlineBattle);
    // WebView 每次启动都是新的数据目录，localStorage 不跨次启动保留，于是每次打开游戏
    // 落进存档就跟着 save/progress.json 走，换机器同步也一致（红点不会再重复亮）。
    // 形状只做浅校验：非负整数、不超过当前时间（未来时间会让红点再也不亮）。
    next.msgSeenAt = Math.min(Date.now(), integer(next.msgSeenAt, 0, 0));
// 好友：只保留名字合法的条目，等级夹在 1~满级；500 是防滥用安全线（原版无上限，见 FRIEND_LIMIT）

    const friendNames = new Set();
    next.friends = (Array.isArray(raw.friends) ? raw.friends : []).filter((f) => object(f) && typeof f.name === 'string' && f.name.trim())
      .filter((f) => {
        const name = String(f.name).trim().slice(0, 20);
        if (!name || friendNames.has(name)) return false;
        friendNames.add(name);
        return true;
      })
      .slice(0, FRIEND_LIMIT).map((f) => ({
        name: String(f.name).trim().slice(0, 20),
        accountId: Math.max(0, integer(f.accountId != null ? f.accountId : f.remoteId, 0)),
        remoteId: Math.max(0, integer(f.remoteId != null ? f.remoteId : f.accountId, 0)),
        snapshotId: typeof f.snapshotId === 'string' ? f.snapshotId.slice(0, 80) : '',
        level: Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(f.level, 1, 1))),
        power: integer(f.power, GData.NEW_PLAYER.power, 1),
        agility: integer(f.agility, GData.NEW_PLAYER.agility, 1),
        speed: integer(f.speed, GData.NEW_PLAYER.speed, 1),
        hp: integer(f.hp, GData.NEW_PLAYER.maxHp, 1),
        note: typeof f.note === 'string' ? f.note.slice(0, 12) : '',
        since: validLocalDate(f.since) ? f.since : localDate(),
      }));
    next.dailyClaimDate = typeof next.dailyClaimDate === 'string' ? next.dailyClaimDate : '';

    next.loginStreak = Math.max(0, integer(next.loginStreak, 0, 0));

    next.friendMessages = {};
    if (object(raw.friendMessages)) {
      for (const name of Object.keys(raw.friendMessages).slice(0, FRIEND_LIMIT)) {
        const list = Array.isArray(raw.friendMessages[name]) ? raw.friendMessages[name] : [];
        const clean = list.filter((m) => object(m) && typeof m.text === 'string' && m.text.trim())
          .slice(-50)
          .map((m) => ({
            text: String(m.text).trim().slice(0, 80),
            at: Math.max(0, Math.min(Date.now(), integer(m.at, 0, 0))),
          }));
        if (clean.length) next.friendMessages[String(name).trim().slice(0, 20)] = clean;
      }
    }
    next.quests = object(raw.quests) && Array.isArray(raw.quests.list) && typeof raw.quests.date === 'string' ? clone(raw.quests) : null;
    next.dailyCounters = object(raw.dailyCounters) && typeof raw.dailyCounters.date === 'string' ? clone(raw.dailyCounters) : null;
    next.dailyStatsDate = typeof next.dailyStatsDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next.dailyStatsDate) ? next.dailyStatsDate : '';

    next.challengeDaily = object(raw.challengeDaily) && validLocalDate(raw.challengeDaily.date)
      ? { date: raw.challengeDaily.date, counts: normalizeChallengeCounts(raw.challengeDaily.counts) }
      : null;
    next.shopPurchaseDate = typeof next.shopPurchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next.shopPurchaseDate) ? next.shopPurchaseDate : '';
    next.shopPurchases = {};
    if (object(raw.shopPurchases)) for (const id of Object.keys(raw.shopPurchases)) {
      if (propMap.getValue(id)) next.shopPurchases[id] = integer(raw.shopPurchases[id], 0);
    }
// 本机偏好（音乐音量/静音、分辨率、全面屏）也写进存档：换浏览器或换机器同步后设置还在。
    next.settings = normalizeSettings(raw.settings);
// 无尽挑战塔：浅校验（深校验在 tower.js 懒做）。进行中的战斗令牌一律作废——
    {
      const runShape = (r) => {
        if (!object(r)) return null;
        const layer = Math.floor(Number(r.layer));
        if (!Number.isFinite(layer) || layer < 1 || !Array.isArray(r.plan) || !r.plan.length) return null;
        const copy = Object.assign({}, r);
        delete copy.attempt;
        // 待选增益 / 排队中的下一批 / 上一场失利的必选窗都要跟着存档走：
        // 深校验（无效 id、层号/场次对不上）在 tower.js 的 normalizeRun 里做。
        // 对局进度存在本机 TowerLocal，但同一份 state.js 仍是塔的兼容层。
        copy.choices = Array.isArray(copy.choices) ? copy.choices : null;
        copy.choiceQueue = Array.isArray(copy.choiceQueue) ? copy.choiceQueue : [];
        return copy;
      };
      const tw = object(raw.tower) ? raw.tower : {};
      next.tower = {
        maxLayer: Math.max(0, integer(tw.maxLayer, 0)),
        // （玩家视角＝「重进游戏后那次免费重试没了」）。层号与日期都要像存档里其它进度一样留着。
        retry: (object(tw.retry) && Math.floor(Number(tw.retry.layer)) >= 1)
          ? { layer: Math.floor(Number(tw.retry.layer)), date: typeof tw.retry.date === 'string' ? tw.retry.date : '' }
          : null,
        run: runShape(tw.run),
      };
      const en = object(raw.endless) ? raw.endless : {};
      next.endless = {
        best: Math.max(0, integer(en.best, 0)), weekBest: Math.max(0, integer(en.weekBest, 0)),
        weekKey: typeof en.weekKey === 'string' ? en.weekKey : '',
        bestLayer: Math.max(0, integer(en.bestLayer, 0)),
        // 勇者剧本的独立纪录：联机版不开放勇者入口，但塔的「所有模式最高」汇总仍读这三项；
        heroBest: Math.max(0, integer(en.heroBest, 0)),
        heroWeekBest: Math.max(0, integer(en.heroWeekBest, 0)),
        heroBestLayer: Math.max(0, integer(en.heroBestLayer, 0)),
        shieldDate: typeof en.shieldDate === 'string' ? en.shieldDate : '',
        // 剧情的「只播一次」记账必须跟着存档走。
        // ⚠ 以后往 `endless()` 上加字段（尤其是各种「已经播过 / 已经给过」的计数）时，
        // 记得一起加到这里，否则它就是「重载即清零」的易失字段。
        storySeen: (() => {
          const src = object(en.storySeen) ? en.storySeen : {};
          const out = {};
          for (const k of Object.keys(src)) if (src[k] === true || src[k] === 1) out[String(k)] = true;
          return out;
        })(),
        // 剧情 / 挑战模式的开关（默认剧情模式）：同样不能在重载后被打回默认。
        storyOn: en.storyOn !== false,
// 最近一局战报只展示既有结算，重载后不能丢失，也不能再次发奖。
        lastSummary: object(en.lastSummary) && en.lastSummary.version === 1
          ? Object.assign({}, en.lastSummary) : null,
        run: runShape(en.run),
      };
    }
    clampPermanentStats(next);
    return stripModernBlackContent(next);
  }

  // 存档里的本机偏好；缺字段/坏值一律回落到默认值。
  function normalizeSettings(raw) {
    const st = object(raw) ? raw : {};
    const volume = Number(st.volume);
    return {
      volume: Number.isFinite(volume) && st.volume !== null && st.volume !== '' ? Math.max(0, Math.min(1, volume)) : 1,
      muted: st.muted === true,
      resolution: RESOLUTION_KEYS.includes(String(st.resolution)) ? String(st.resolution) : 'auto',
      fullscreen: st.fullscreen === true,
      // 安卓沉浸模式：默认隐藏状态栏（桌面/网页没有这个开关的实际效果）；
      // 显式关闭过才保持 false。旧档没有这个字段时按 true 迁移，解决状态栏常驻。
      hideStatusBar: st.hideStatusBar !== false,

      showSkip: st.showSkip !== false,
      backgroundRun: st.backgroundRun === true,
      uiMode: UIMODE_KEYS.includes(String(st.uiMode)) ? String(st.uiMode) : 'classic',
    };
  }
  // 当前偏好（没有存档时给默认值，读到的对象就是存档里的那一份）。
  function settings() {
    if (!S) return normalizeSettings(null);
    if (!object(S.settings)) S.settings = normalizeSettings(null);
    return S.settings;
  }

  function setSettings(patch) {
    const st = settings();
    if (object(patch)) for (const key of Object.keys(patch)) st[key] = patch[key];
    S.settings = normalizeSettings(st);
    save();
    return S.settings;
  }

  function readUiModePref() {

    if (ONLINE) return 'classic';
    try {
      const v = localStorage.getItem(UI_MODE_KEY);
      return SAVE_SLOTS.includes(String(v)) ? String(v) : null;
    } catch (e) { return null; }
  }
  function writeUiModePref(mode) {
    if (!SAVE_SLOTS.includes(String(mode))) return;
    try { localStorage.setItem(UI_MODE_KEY, String(mode)); } catch (e) {}
  }

  function rememberUiMode() {
    const mode = (S && object(S.settings) && validSaveMode(S.settings.uiMode))
      ? String(S.settings.uiMode) : slotMode();
    if (S) {
      S.settings = normalizeSettings(S.settings);
      S.settings.uiMode = mode;
    }
    saveMode = mode;
    writeUiModePref(mode);
    return mode;
  }
  function validSaveMode(mode) { return SAVE_SLOTS.includes(String(mode)); }
  // 旧档没有槽位标记时，按存档里的 settings.uiMode 认领。
  function playerMode(raw) {
    try { return normalizeSettings(object(raw) ? raw.settings : null).uiMode; }
    catch (e) { return 'classic'; }
  }

  function explicitPlayerMode(raw) {
    const m = object(raw) && object(raw.settings) ? String(raw.settings.uiMode) : '';
    return validSaveMode(m) ? m : null;
  }
  function slotMode() { return validSaveMode(saveMode) ? saveMode : DEFAULT_SAVE_SLOT; }
  function otherMode(mode) { return mode === 'modern' ? 'classic' : 'modern'; }

  function blackGearEnabled() { return slotMode() === 'classic'; }
  function isBlackGearId(id) {
    const gi = gearInst(Number(id));
    return !!gi && Number(gi.quality) === 5;
  }
  function isBlackPropId(id) { return BLACK_PROP_IDS.includes(Number(id)); }

  function canSocketGem(gear) {
    if (!gear) return false;
    // 原始存档实例只有 id/orange，没有 quality；必须经 gearQuality 把 q4/q5 也从 gearMap 读出来。
    const q = gearQuality(gear);
    return gear.orange === true || q === 4 || q === 5 || isBlackGearId(gear.id);
  }

  function stripModernBlackContent(slot) {
    if (!slot || !object(slot) || !object(slot.settings) || slot.settings.uiMode !== 'modern') return slot;
    slot.gears = (Array.isArray(slot.gears) ? slot.gears : []).filter((g) => !isBlackGearId(g && g.id));
    if (object(slot.props)) for (const id of BLACK_PROP_IDS) delete slot.props[id];
    slot.blackCardsWeek = { week: '', count: 0 };
    slot.blackTowerLayer = 0;
    slot.blackBox100 = false;
    if (slot.chestPending && object(slot.chestPending.reward)) {
      const rw = slot.chestPending.reward;
      if ((rw.kind === 'prop' && isBlackPropId(rw.id)) || (rw.kind === 'gear' && isBlackGearId(rw.id))) {
        slot.chestPending = null;
      }
    }
    return slot;
  }
  function stripDualFields(raw) {
    const out = Object.assign({}, object(raw) ? raw : {});
    delete out.__dualMode;
    delete out.__dualOther;
    delete out.__dualSaves;
    return out;
  }
  function normalizeSlot(raw) {
    if (!object(raw)) return null;
    const slot = normalizeSave(stripDualFields(raw));
    delete slot.__dualMode;
    delete slot.__dualOther;
    delete slot.__dualSaves;
    return slot;
  }
  // 双槽存档的槽位：顶层永远是当前写出的界面（旧工具/测试直接改顶层字段也有效），
  // 另一界面只存在 `__dualOther` 里。兼容短暂出现过的 `__dualSaves` 旧格式。
  function dualSlots(raw) {
    if (!object(raw) || (!object(raw.__dualOther) && !object(raw.__dualSaves))) return null;
    const top = normalizeSlot(raw);
    if (!top) return null;
    const topMode = explicitPlayerMode(raw) || (validSaveMode(raw.__dualMode) ? String(raw.__dualMode) : null)
      || playerMode(raw) || slotMode();
    const slots = { [topMode]: top };
    if (object(raw.__dualOther)) {
      const other = normalizeSlot(raw.__dualOther);
      if (other) slots[otherMode(topMode)] = other;
    } else if (object(raw.__dualSaves)) {
      const old = raw.__dualSaves;
      for (const mode of SAVE_SLOTS) {
        if (mode === topMode) continue;
        const slot = normalizeSlot(old[mode]);
        if (slot) slots[mode] = slot;
      }
    }
    return { slots, topMode };
  }
  // 读一条双槽存档；返回 true=当前界面有进度，false=当前界面没有（但另一槽可能已放进 otherSlot）。
  function applyDualPayload(raw) {
    const dual = dualSlots(raw);
    if (!dual) return null;
    let mode = readUiModePref();
    if (!validSaveMode(mode)) mode = dual.topMode;
    if (!validSaveMode(mode)) mode = DEFAULT_SAVE_SLOT;
    let target = dual.slots[mode];
    let other = dual.slots[otherMode(mode)] || null;
    // 当前界面槽位不见了、另一界面还有档：直接载入另一槽，不要停在标题页。
    // 旧行为是 S=null（显示标题/新开局），玩家会看到「初始存档」；下一次启动
    // 「在初始存档与有进度的存档之间横跳」。只有两槽都没有档时才返回 false。
    if (!target && other) {
      mode = otherMode(mode);
      target = other;
      other = null;
    } else if (target && other && isFreshPayload(target) && !isFreshPayload(other)) {
      // 当前槽是 1 级空档、另一槽却是有进度的档：优先把进度救出来。
      // 看到的是「初始存档」；下一次界面偏好变化又可能读回另一槽 —— 横跳。
      const oldTarget = target;
      mode = otherMode(mode);
      target = other;
      other = oldTarget;
    }
    saveMode = mode;
    writeUiModePref(mode);
    otherSlot = other;
    if (!target) { S = null; return false; }
    S = target;
    S.settings = normalizeSettings(S.settings);
    S.settings.uiMode = mode;
    return true;
  }

  function applyLegacyPayload(raw) {
    const legacy = normalizeSlot(raw);
    if (!legacy) return false;
    const explicit = explicitPlayerMode(raw);
    const pref = readUiModePref();
    const legacyMode = explicit || pref || DEFAULT_SAVE_SLOT;
    legacy.settings = normalizeSettings(legacy.settings);
    legacy.settings.uiMode = legacyMode;
    if (!validSaveMode(pref)) {
      saveMode = legacyMode;
      writeUiModePref(legacyMode);
      otherSlot = null;
      S = legacy;
      return true;
    }
    saveMode = pref;
    writeUiModePref(pref);

    saveMode = pref;
    legacy.settings.uiMode = pref;
    otherSlot = null;
    S = legacy;
    return true;
  }
  function adoptPayload(raw, opts) {
    if (!object(raw)) return false;
    const dual = applyDualPayload(raw);
    const ok = dual === null ? applyLegacyPayload(raw) : dual;
    // 上次开箱开出来、还没点「确定领取」就关掉游戏的那一包：进游戏时直接入账，
    // 导入路径会先 `deferSettle` —— 等校验/写盘都成功后由文件载入统一结算，
    if (!(opts && opts.deferSettle)) settlePendingChest();
    return ok;
  }
  // 当前界面 + 另一界面两份进度一起序列化；顶层仍是当前进度的原始字段，
  function savePayload() {
    if (!S) return S;
    clampPermanentStats();
// 所有写盘/镜像/导出都走这里；直接修改状态及未激活的另一槽也不能绕过上限。
    trimBattleHistory(S);
    if (otherSlot) trimBattleHistory(otherSlot);
    const mode = rememberUiMode();
    S.settings = normalizeSettings(S.settings);
    S.settings.uiMode = mode;
    const out = Object.assign({}, S);
    delete out.__dualMode;
    delete out.__dualOther;
    delete out.__dualSaves;
    out.__dualMode = mode;
    if (otherSlot) {
      otherSlot.settings = normalizeSettings(otherSlot.settings);
      otherSlot.settings.uiMode = otherMode(mode);
      out.__dualOther = otherSlot;
    }
    return out;
  }
  // 当前进度的完整双槽快照（字符串）。导入失败时用它把内存恢复原样，
  // 不依赖磁盘/浏览器里那份是否已经被写到一半。
  function exportPayload() {
    try { return S ? JSON.stringify(savePayload()) : ''; } catch (e) { return ''; }
  }
  // 把之前导出的快照重新载入内存。只做校验与解析，不写盘。
  // `opts.deferSettle`：联机版的开箱动作（begin/confirm）在服务端跑时
  // 必须保留 `chestPending`，否则每次动作前的读档都会先把金宝箱结果自动入账，
  function restorePayload(raw, opts) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return adoptPayload(parsed, opts);
    } catch (e) { return false; }
  }
  // 导入前把一份存档载入内存并生成规范化后的待写盘正文。
  // 调用方必须用它做成功提示与写后核对，不能拿原始 JSON 的顶层字段冒充。
  // 失败时不改内存；成功后若写盘失败，调用方用 `restorePayload` 回滚。
  function prepareImport(raw) {
    let parsed;
    try {
      // iOS/Windows 上手工转存的文件可能带 UTF-8 BOM；JSON.parse 不认。
      const text = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : raw;
      parsed = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) { return { ok: false, msg: '这个文件不是合法的 JSON' }; }
    if (!object(parsed) || Array.isArray(parsed)) return { ok: false, msg: '这不是一个存档对象' };
    const before = { S, otherSlot, saveMode };
    const beforePref = readUiModePref();
    const rollback = () => {
      S = before.S; otherSlot = before.otherSlot; saveMode = before.saveMode;
      try {
        if (beforePref) writeUiModePref(beforePref);
        else localStorage.removeItem(UI_MODE_KEY);
      } catch (e) {}
    };
    try {
      const loaded = adoptPayload(parsed, { deferSettle: true });
      if (!loaded) {
        rollback();
        return { ok: false, msg: '存档里没有当前界面可载入的进度' };
      }

      settlePendingChest({ save: false });
      S.savedAt = Date.now();
      const name = String(S.name || '小松鼠');
      const level = Math.max(1, Number(S.level) || 1);
      const mode = slotMode();
      let payload = '';
      try { payload = JSON.stringify(savePayload()); } catch (e) { payload = ''; }
      if (!payload) {
        rollback();
        return { ok: false, msg: '无法生成要写入的存档' };
      }
      return { ok: true, name, level, mode, payload };
    } catch (e) {
      rollback();
      return { ok: false, msg: '导入存档时出错：' + String((e && e.message) || e) };
    }
  }
  // 把一份存档里不会随时间/读档顺序变化的进度字段抽成指纹。
  function importFingerprint(raw) {
    let v;
    try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return ''; }
    if (!object(v)) return '';
    const arr = (x) => (Array.isArray(x) ? x.slice() : []);
    const sortedProps = (x) => {
      const out = {};
      if (object(x)) for (const key of Object.keys(x).sort()) out[key] = x[key];
      return out;
    };
    const slot = (x) => ({
      name: String(x.name || ''), level: Number(x.level) || 1,
      exp: Number(x.exp) || 0, reborn: Number(x.reborn) || 0, allWins: Number(x.allWins) || 0,
      power: Number(x.power) || 0, agility: Number(x.agility) || 0,
      speed: Number(x.speed) || 0, maxHp: Number(x.maxHp) || 0,
      energy: Number(x.energy) || 0, maxEnergy: Number(x.maxEnergy) || 0,
      goldPoint: Number(x.goldPoint) || 0, goldCup: Number(x.goldCup) || 0, integral: Number(x.integral) || 0,
      weapons: arr(x.weapons), skills: arr(x.skills), props: sortedProps(x.props),
      stages: sortedProps(x.stages),
      gears: arr(x.gears).map((g) => [Number(g && g.id) || 0, String((g && g.key) || ''),
        !!(g && g.used), Number(g && g.attr) || 0, arr(g && g.ext), g && g.gem ? [g.gem.id, 0] : null]),
      uiMode: object(x.settings) ? String(x.settings.uiMode || '') : '',
    });
    return JSON.stringify({
      slot: slot(v),
      other: object(v.__dualOther) ? slot(v.__dualOther) : null,
    });
  }
  // 写盘后核对：真正读回来的当前槽位必须和 `prepareImport` 载入的是同一份。
  function verifyImport(prepared) {
    if (!prepared || !S) return false;
    const want = importFingerprint(prepared.payload);
    if (!want) return false;
    return want === importFingerprint(savePayload());
  }

  function switchMode(mode) {

    if (ONLINE) return { ok: false, mode: 'classic', changed: false, created: false };
    const m = String(mode);
    if (!validSaveMode(m)) return { ok: false, mode: slotMode(), changed: false, created: false };
    if (m === slotMode()) return { ok: true, mode: m, changed: false, created: false };
    if (!S) {
      saveMode = m;
      writeUiModePref(m);
      return { ok: true, mode: m, changed: true, created: false };
    }
    save();
    const old = S;
    if (otherSlot) {
      const target = normalizeSlot(otherSlot);
      S = target;
      otherSlot = old;
      saveMode = m;
      writeUiModePref(m);
      S.settings = normalizeSettings(S.settings);
      S.settings.uiMode = m;
      settlePendingChest({ save: false });
      save();
      try { if (window.UI && UI.applyUiMode) UI.applyUiMode(m); } catch (e) {}
      return { ok: true, mode: m, changed: true, created: false };
    }
    saveMode = m;
    otherSlot = old;
    writeUiModePref(m);
    newGame((old && old.name) || '小松鼠', { uiMode: m });
    return { ok: true, mode: m, changed: true, created: true };
  }
  function activeUiMode() { return slotMode(); }
  function hasModeSave(mode) {
    const m = validSaveMode(mode) ? String(mode) : slotMode();
    return m === slotMode() ? !!S : !!otherSlot;
  }


  function resolutionHeight(key) {
    const row = RESOLUTIONS.find((r) => r.key === String(key));
    return row ? row.height : 0;
  }

  function debugOn(key) {
    try { return !!(window.Debug && window.Debug.enabled && window.Debug.enabled(key)); } catch (e) { return false; }
  }

  if (typeof window !== 'undefined') window.debugOn = debugOn;


// 收徒上限随师父等级变化：10 级前 1 个，10-19 级 2 个，20 级以上 3 个
  function apprenticeCap(level) {
    const lv = Number.isFinite(Number(level)) ? Number(level) : (S ? S.level : 1);
    return lv >= 20 ? 3 : lv >= 10 ? 2 : 1;
  }

  const MASTER_SKILL_ID = 13;
  const MASTER_SKILL_NAME = '师父驾到';
  // 学习技能：已有则升级，返回本次结果（供界面提示）。
  // 拜师赠送的「师父驾到」不受武器/技能总数上限限制（剧情赠予）。
  function learnSkill(id, level) {
    id = Number(id);
    const base = skillsMap.getValue(id);
    if (!base) return { ok: false, msg: '没有这个技能' };
    const lv = Math.max(1, Math.min(15, Number(level) || 1));
    const entry = S.skills.find((s) => Number(String(s).split(':')[0]) === id);
    if (entry) {
      const cur = Number(String(entry).split(':')[1]) || 1;
      if (cur >= lv) return { ok: false, msg: '已经掌握【' + base.name + '】', name: base.name, level: cur, upgraded: false };
      S.skills[S.skills.indexOf(entry)] = id + ':' + lv;
      save();
      return { ok: true, msg: '【' + base.name + '】升到 ' + lv + ' 级', name: base.name, level: lv, upgraded: true };
    }
    S.skills.push(id + ':' + lv);
    save();
    return { ok: true, msg: '学会【' + base.name + '】', name: base.name, level: lv, upgraded: false };
  }
  // 拜师：记录师父（含等级、属性快照）并自动学会师父驾到。
  function setMaster(master) {
    if (!master || !master.name) return { ok: false, msg: '师父信息无效' };
    S.master = {
      name: String(master.name).slice(0, 20),
      level: integer(master.level, 1, 1),
      power: Number.isFinite(Number(master.power)) ? Number(master.power) : null,
      agility: Number.isFinite(Number(master.agility)) ? Number(master.agility) : null,
      speed: Number.isFinite(Number(master.speed)) ? Number(master.speed) : null,
      hp: Number.isFinite(Number(master.hp)) ? Number(master.hp) : null,
      weapons: Array.isArray(master.weapons) ? master.weapons.slice() : [],
      skills: Array.isArray(master.skills) ? master.skills.slice() : [],
      // 师父身上穿的也一起记下来：经典模式挑战页右侧要把师父自己的装备贴到立绘上、
      // 「查看」要显示他穿了什么（原版这两项都来自服务端下发的 `wearsList`）。
      // ⚠ 少了这一段，「查看师父」与右侧立绘就永远是空的（`State.gearPart` 也补不回来）。
      gears: normalizeFoeGears(master.gears),

      accountId: Math.max(0, integer(master.accountId != null ? master.accountId : master.remoteId, 0)),
      tag: String(master.tag || '').slice(0, 12),
      bot: !!master.bot,
    };
    const learned = learnSkill(MASTER_SKILL_ID, 1);
    save();
    return { ok: true, master: S.master, learned };
  }

  // 师徒关系与「师父驾到」绑定：清师父必须同时移除技能；重新拜师会再学会。
  function clearMaster() {
    S.master = null;
    const at = S.skills.findIndex((s) => Number(String(s).split(':')[0]) === MASTER_SKILL_ID);
    if (at >= 0) S.skills.splice(at, 1);
    save();
    return true;
  }

  function addPrentice(foe) {
    if (!foe || !foe.name) return { ok: false, msg: '徒弟信息无效' };
    if (S.prentices.length >= apprenticeCap(S.level)) return { ok: false, msg: '收徒名额已满' };
    const realId = Math.max(0, integer(foe.accountId != null ? foe.accountId : foe.realId, 0));
    if (realId && S.prentices.some((p) => Number(p.accountId || p.realId) === realId)) return { ok: false, msg: '已经收过这个徒弟了' };
    if (S.prentices.some((p) => p.name === foe.name)) return { ok: false, msg: '已经收过这个徒弟了' };
    const row = {
      name: String(foe.name).slice(0, 20),
      level: integer(foe.level, 1, 1),
      exp: integer(foe.exp, 0),
      power: integer(foe.power, 0, 0), agility: integer(foe.agility, 0, 0),
      speed: integer(foe.speed, 0, 0), hp: integer(foe.hp, 0, 0),
      weapons: Array.isArray(foe.weapons) ? foe.weapons.slice() : [],
      skills: Array.isArray(foe.skills) ? foe.skills.slice() : [],
      // 徒弟身上穿的也记下来（「查看徒弟」要显示装备；原版由服务端下发 `wearsList`）。
      gears: normalizeFoeGears(foe.gears),
      // realId/accountId 标记真人徒弟；日供只认真人徒弟（见服务端 apprentice.js）。
      accountId: realId, realId, bot: !!foe.bot, tag: String(foe.tag || '').slice(0, 12),
      since: validLocalDate(foe.since) ? foe.since : localDate(),
      joinedAt: Date.now(), tributeClaimedDate: '',
    };
    if (!row.skills.some(skill => Number(String(skill).split(':')[0]) === MASTER_SKILL_ID)) row.skills.push(MASTER_SKILL_ID + ':1');
    S.prentices.push(row);
    save();
    return { ok: true, apprentice: row };
  }
  function removePrentice(name) {
    const i = S.prentices.findIndex((p) => p.name === name);
    if (i < 0) return false;
    S.prentices.splice(i, 1);
    save();
    return true;
  }
  // 对齐原版 `MainMovie.as`：
  // · `goHomeLand` 的服务端回包给每个建筑 `{buildingId, level, upgrading, upgraded,
  // 复刻没有服务端，所以这三套都落存档、用 `localDate()` 当天判定。
  // 建筑等级 1~30：`[等级, 碎片双倍%, 经验双倍%, 金松果双倍%, 升级金松果, 升级小时]`
  // —— 逐行照抄原版 `buildingUpInfo`（MainMovie.as:19145），不要在这里手改数值。
  const BUILDING_UP_INFO = [
    [1, 5, 5, 5, 50, 4], [2, 6, 6, 6, 60, 6], [3, 7, 7, 7, 70, 8], [4, 8, 8, 8, 80, 10],
    [5, 9, 9, 9, 90, 12], [6, 10, 10, 10, 100, 14], [7, 11, 11, 11, 110, 16], [8, 12, 12, 12, 120, 18],
    [9, 13, 13, 13, 130, 20], [10, 14, 14, 14, 140, 22], [11, 15, 15, 15, 150, 24], [12, 16, 16, 16, 160, 26],
    [13, 17, 17, 17, 170, 28], [14, 18, 18, 18, 180, 30], [15, 19, 19, 19, 190, 32], [16, 20, 20, 20, 200, 34],
    [17, 21, 21, 21, 210, 36], [18, 22, 22, 22, 220, 38], [19, 23, 23, 23, 230, 40], [20, 24, 24, 24, 240, 42],
    [21, 25, 25, 25, 250, 44], [22, 26, 26, 26, 260, 46], [23, 27, 27, 27, 270, 48], [24, 28, 28, 28, 280, 50],
    [25, 29, 29, 29, 290, 52], [26, 30, 30, 30, 300, 54], [27, 31, 31, 31, 310, 56], [28, 32, 32, 32, 320, 58],
    [29, 33, 33, 33, 330, 60], [30, 34, 34, 34, 340, 62],
  ];
  const BUILDING_MAX_LEVEL = 30;
  // 建筑 id → 存档键（原版 `buildingId`：1 祭坛 / 3 神迹 / 4 幻兽牧场）。
  const BUILDING_KEYS = ['altar', 'miracle', 'beast'];
  const BUILDING_IDS = { altar: 1, miracle: 3, beast: 4 };
  // 最低使用等级（原版服务端按等级放出 buildingInfo；客户端本身没有这张表，
  // 这里按原版攻略/建筑开放顺序落成常量）：
  const BUILDING_UNLOCK_LEVEL = { altar: 1, miracle: 30, beast: 25 };
  const WAR_UNLOCK_LEVEL = 35;

  // ⚠ 不能在这里直接读 `GData`：test-min-deps 会单独加载 state.js 检查全局挂载，
  const PETS = [];
  const PET_BY_ID = new Map();
  let PET_SKILLS = {};
  let PET_GRADE_EXP = { 1: 1000, 2: 2000, 3: 5000, 4: 10000, 5: 20000 };
  let PET_GRADE_COST = { 2: 50, 3: 100, 4: 200, 5: 500 };
  function ensurePetTables() {
    if (PETS.length) return;
    const gd = (typeof GData !== 'undefined' && GData) ? GData : null;
    if (!gd) return;
    for (const p of (Array.isArray(gd.PETS) ? gd.PETS : [])) { PETS.push(p); PET_BY_ID.set(p.id, p); }
    PET_SKILLS = gd.PET_SKILLS || {};
    PET_GRADE_EXP = gd.PET_GRADE_EXP || PET_GRADE_EXP;
    PET_GRADE_COST = gd.PET_GRADE_COST || PET_GRADE_COST;
  }
  const PET_MAX_CAPACITY = 300;
  // 幻兽解锁等级：原版提示「25级后至村庄幻兽牧场使用」
  // （MainMovie.as:1362）。随机敌人在此之前不能带幻兽。
  const PET_UNLOCK_LEVEL = 25;
  const petNextExp = (level) => Math.max(100, Math.round(100 * Math.max(1, Number(level) || 1)));
  function buildingUnlockLevel(key) {
    return Number(BUILDING_UNLOCK_LEVEL[key]) || 0;
  }
  function buildingUnlocked(key) {
    if (!BUILDING_KEYS.includes(key)) return false;
    const lv = integer(S && S.level, 1, 1);
    return lv >= buildingUnlockLevel(key);
  }

  function buildingTier(level) {
    return Math.max(1, Math.min(6, Math.ceil(Math.max(1, Number(level) || 1) / 5)));
  }

  function buildingUpInfo(level) {
    const lv = Math.max(1, Math.min(BUILDING_MAX_LEVEL, Math.round(Number(level) || 1)));
    const row = BUILDING_UP_INFO[lv - 1] || BUILDING_UP_INFO[0];
    return { level: lv, propRate: row[1], expRate: row[2], goldRate: row[3], gold: row[4], hour: row[5] };
  }
  // 神迹等级对应的累计属性点（原版每次升级给 1 个随机点，5 点生命 = 1 次；
  // 存档里按四项分开记，这里只做读取与展示）。
  function miracleRecord() {
    const b = S.buildings && S.buildings.miracle;
    const add = (b && b.add) || {};
    return {
      power: Math.max(0, integer(add.power, 0)), agility: Math.max(0, integer(add.agility, 0)),
      speed: Math.max(0, integer(add.speed, 0)), hp: Math.max(0, integer(add.hp, 0)) * 5,
    };
  }

  function settleBuildings() {
    const done = [];
    const now = Date.now();
    for (const key of BUILDING_KEYS) {
      const b = S.buildings && S.buildings[key];
      if (!b || !b.upgrading) continue;
      if (Number(b.doneAt) > now) continue;
      b.upgrading = false;
      b.doneAt = 0;
      b.level = Math.min(BUILDING_MAX_LEVEL, Math.max(1, integer(b.level, 1, 1)) + 1);
      if (key === 'miracle') {
        // 原版 `goHomeLand` 的 `attrAdd`：0 力量 / 1 敏捷 / 2 速度 / 3 生命（+5）。
        // 复刻在完成的那一刻随机一次并落存档，之后「神迹记录」读的就是它。
        const roll = Math.floor(Math.random() * 4);
        b.add = b.add || { power: 0, agility: 0, speed: 0, hp: 0 };
        if (roll === 0) b.add.power = integer(b.add.power, 0) + 1;
        else if (roll === 1) b.add.agility = integer(b.add.agility, 0) + 1;
        else if (roll === 2) b.add.speed = integer(b.add.speed, 0) + 1;
        else b.add.hp = integer(b.add.hp, 0) + 1;
        b.addType = roll;
      }
      if (key === 'beast') {
        S.hatchPoint = Math.max(0, integer(S.hatchPoint, 0) + 200);
        S.petsCapacity = Math.max(1, Math.min(PET_MAX_CAPACITY, integer(S.petsCapacity, 6, 1) + 1));
      }
      done.push({ key: key, id: BUILDING_IDS[key], level: b.level, addType: integer(b.addType, 0) });
    }

    for (const d of done) {
      if (d.key !== 'miracle') continue;
      const rec = S.buildings.miracle.add || {};

      if (d.addType === 0) S.power = integer(S.power, 1) + 1;
      else if (d.addType === 1) S.agility = integer(S.agility, 1) + 1;
      else if (d.addType === 2) S.speed = integer(S.speed, 1) + 1;
      else S.maxHp = integer(S.maxHp, 1) + 5;
      void rec;
    }
    if (done.length) save();
    return done;
  }

  function building(key) {
    if (!buildingUnlocked(key)) return null;
    const b = S.buildings && S.buildings[key];
    if (!b) return null;
    const lv = Math.max(1, Math.min(BUILDING_MAX_LEVEL, integer(b.level, 1, 1)));
    const remain = b.upgrading ? Math.max(0, Math.ceil((Number(b.doneAt) - Date.now()) / 60000)) : 0;
    return {
      key: key, id: BUILDING_IDS[key], level: lv, tier: buildingTier(lv),
      upgrading: b.upgrading === true, remainTime: remain,
      buffId: integer(b.buffId, 0), buffDate: typeof b.buffDate === 'string' ? b.buffDate : '',
      add: b.add || { power: 0, agility: 0, speed: 0, hp: 0 },
    };
  }

  function upgradeBuilding(key) {
    if (!buildingUnlocked(key)) return { ok: false, msg: '需要达到 ' + buildingUnlockLevel(key) + ' 级才能使用' + (BUILDING_LABEL[key] || '这个建筑') };
    const b = S.buildings && S.buildings[key];
    if (!b) return { ok: false, msg: '这里还没有建筑' };
    if (b.upgrading) return { ok: false, msg: '这个建筑正在升级中' };
    const lv = Math.max(1, Math.min(BUILDING_MAX_LEVEL, integer(b.level, 1, 1)));
    if (lv >= BUILDING_MAX_LEVEL) return { ok: false, msg: '建筑已达最高级！' };
    const info = buildingUpInfo(lv);
    if (integer(S.goldPoint, 0) < info.gold) return { ok: false, msg: '金松果不足（需要 ' + info.gold + ' 个）' };
    S.goldPoint = integer(S.goldPoint, 0) - info.gold;
    b.upgrading = true;
    b.doneAt = Date.now() + info.hour * 3600000;
    save();
    return { ok: true, gold: info.gold, hour: info.hour, level: lv + 1 };
  }
  // 当天是否还能在祭坛领状态（原版 `gainBuff` 一天一次，服务端判定）。
  function buildingBuffClaimed(key) {
    if (!buildingUnlocked(key)) return false;
    const b = S.buildings && S.buildings[key];
    return !!(b && b.buffDate === localDate() && integer(b.buffId, 0) > 0);
  }

  function claimBuildingBuff(key) {
    if (!buildingUnlocked(key)) return { ok: false, msg: '需要达到 ' + buildingUnlockLevel(key) + ' 级才能使用' + (BUILDING_LABEL[key] || '这个建筑') };
    const b = S.buildings && S.buildings[key];
    if (!b) return { ok: false, msg: '这里还没有建筑' };
    if (buildingBuffClaimed(key)) return { ok: false, already: true, msg: '今天已经领过了，明天再来' };
    const buffId = 1 + Math.floor(Math.random() * 3);
    b.buffId = buffId;
    b.buffDate = localDate();
    save();
    const msg = buffId === 1 ? '你获得了经验竞技场特殊状态，有几率在参加时获得双倍奖励！'
      : buffId === 2 ? '你获得了碎片竞技场特殊状态，有几率在参加时获得双倍奖励！'
        : '你获得了关卡特殊状态，有几率在挑战关卡时获得更多金松果！';
    return { ok: true, buffId: buffId, msg: msg };
  }

  function activeBuildingBuff(kind) {
    const want = kind === 'arenaExp' ? 1 : kind === 'arenaProp' ? 2 : kind === 'stageGold' ? 3 : 0;
    if (!want) return false;
    for (const key of BUILDING_KEYS) {
      if (!buildingUnlocked(key)) continue;
      const b = S.buildings && S.buildings[key];
      if (b && integer(b.buffId, 0) === want && b.buffDate === localDate()) return true;
    }
    return false;
  }

  function buildingDoubleRate(key, kind) {
    const bid = kind === 'arenaExp' ? 1 : kind === 'arenaProp' ? 2 : kind === 'stageGold' ? 3 : 0;
    if (!bid || !buildingUnlocked(key) || !activeBuildingBuff(kind)) return 0;
    const b = S.buildings && S.buildings[key];
    if (!b) return 0;
    const info = buildingUpInfo(integer(b.level, 1, 1));
    return bid === 1 ? info.expRate : bid === 2 ? info.propRate : info.goldRate;
  }
  const BUILDING_LABEL = { altar: '祭坛', miracle: '神迹', beast: '幻兽牧场' };



  function petLeadership() {
    ensurePetTables();
    const b = S.buildings && S.buildings.beast;
    const lv = Math.max(1, Math.min(BUILDING_MAX_LEVEL, integer(b && b.level, 1, 1)));
    return (lv - 1) * 3 + 7;
  }
  function petInfo(p) {
    ensurePetTables();
    if (!p) return null;
    const skill = (typeof GData !== 'undefined' && GData.petSkillInfo ? GData.petSkillInfo(p.skillId, p.level) : null) ||
      PET_SKILLS[p.skillId] || { name: '未知技能', remark: '暂无说明' };

    const nextLevel = Math.min(Math.max(1, integer(p.maxLevel, 50, 1)), Math.max(1, integer(p.level, 1, 1) + 1));
    const nextSkill = (typeof GData !== 'undefined' && GData.petSkillInfo)
      ? GData.petSkillInfo(p.skillId, nextLevel) : null;
    return {
      key: p.key, id: p.id, name: p.name, grade: p.grade, maxLevel: p.maxLevel,
      leadership: p.leadership, skillId: p.skillId, skillName: skill.name, skillRemark: skill.remark,
      skillValue: skill.value == null ? 0 : skill.value, skillTrigger: skill.trigger == null ? 0 : skill.trigger,
      skillLevelupRemark: skill.levelupRemark || '',
      skillNextValue: nextSkill && nextSkill.value != null ? nextSkill.value : (skill.value == null ? 0 : skill.value),
      level: p.level, exp: p.exp, nextExp: p.nextExp, inTeam: (S.petsTeam || []).includes(p.key),
    };
  }
  function pets() { return (S.pets || []).map(petInfo); }
  function petByKey(key) { return (S.pets || []).find((p) => p.key === String(key)) || null; }
  function petTeam() { return (S.petsTeam || []).map(petByKey).filter(Boolean).map(petInfo); }
  function randomPetDef(grade) {
    ensurePetTables();
    const pool = PETS.filter((p) => !grade || p.grade === grade);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : PETS[0];
  }

  function makePet(def, level) {
    const lv = Math.max(1, Math.min(Math.max(1, Number(def && def.maxLevel) || 1), integer(level, 1, 1)));
    return {
      key: 'pet' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      id: def.id, name: def.name, grade: def.grade, maxLevel: def.maxLevel,
      leadership: def.leadership, skillId: def.skillId,
      level: lv, exp: 0, nextExp: petNextExp(lv),
    };
  }

  function hatchPet() {
    ensurePetTables();
    if (!S || !Array.isArray(S.pets)) return { ok: false, msg: '幻兽数据还没准备好' };
    if (S.pets.length >= Math.min(PET_MAX_CAPACITY, integer(S.petsCapacity, 6, 1))) return { ok: false, msg: '幻兽存储格已满，先升级牧场或开启存储格' };
    if (integer(S.hatchPoint, 0) < 200) return { ok: false, msg: '孵化点不足（每次孵化需要200点）' };

    const roll = Math.random();
    const grade = roll < 0.55 ? 1 : roll < 0.82 ? 2 : roll < 0.95 ? 3 : 4;
    const def = randomPetDef(grade);
    const pet = makePet(def, 1);
    S.hatchPoint = integer(S.hatchPoint, 0) - 200;
    S.pets.push(pet);
    save();
    return { ok: true, pet: petInfo(pet), hatchPoint: S.hatchPoint };
  }
  // 直接发一只已经掷定的幻兽（征战「随机幻兽」奖品）：种类/等级来自服务端
  // 奖池的 `prize.pet`，这里只做字典校验与容量检查，不重新随机。
  function grantPet(spec) {
    ensurePetTables();
    if (!S || !Array.isArray(S.pets)) return { ok: false, msg: '幻兽数据还没准备好' };
    const def = PET_BY_ID.get(Number(spec && spec.id));
    if (!def) return { ok: false, msg: '没有这只幻兽' };
    if (S.pets.length >= Math.min(PET_MAX_CAPACITY, integer(S.petsCapacity, 6, 1))) {
      return { ok: false, msg: '幻兽存储格已满' };
    }
    const pet = makePet(def, Number(spec && spec.level) || 1);
    S.pets.push(pet);
    save();
    return { ok: true, pet: petInfo(pet) };
  }
  // 出战队伍：最多 3 只，领导力总和不能超过牧场等级的领导力。
  function setPetTeam(keys) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, 3);
    const petsList = list.map(petByKey).filter(Boolean);
    if (petsList.length !== list.length) return { ok: false, msg: '队伍里有幻兽不存在' };
    const need = petsList.reduce((n, p) => n + p.leadership, 0);
    const cap = petLeadership();
    if (need > cap) return { ok: false, msg: '领导力不足（需要 ' + need + ' / 当前 ' + cap + '）' };
    S.petsTeam = list;
    save();
    return { ok: true, team: petTeam(), need, cap };
  }

  function feedPet(targetKey, materialKeys) {
    const target = petByKey(targetKey);
    if (!target) return { ok: false, msg: '找不到要喂养的幻兽' };
    let mats = (Array.isArray(materialKeys) ? materialKeys : []).map(String)
      .filter((k) => k && k !== target.key).map(petByKey).filter(Boolean);
    if (!mats.length) {
      mats = (S.pets || []).filter((p) => p.key !== target.key && !(S.petsTeam || []).includes(p.key))
        .sort((a, b) => a.level - b.level || a.grade - b.grade).slice(0, 3);
    }
    mats = [...new Map(mats.map((p) => [p.key, p])).values()].slice(0, 3);
    if (!mats.length) return { ok: false, msg: '没有可消耗的幻兽（出战队伍里的不能喂）' };
    if (target.level >= target.maxLevel) return { ok: false, msg: '这只幻兽已经满级了' };
    const gold = mats.length * 20;
    if (integer(S.goldPoint, 0) < gold) return { ok: false, msg: '金松果不足（需要 ' + gold + ' 个）' };
    const gain = mats.reduce((n, p) => n + p.grade * 100 + p.level * 30, 0) + 50;
    S.goldPoint = integer(S.goldPoint, 0) - gold;
    const removed = new Set(mats.map((p) => p.key));
    S.pets = (S.pets || []).filter((p) => !removed.has(p.key));
    target.exp = Math.max(0, integer(target.exp, 0) + gain);
    let levels = 0;
    while (target.level < target.maxLevel) {
      target.nextExp = petNextExp(target.level);
      if (target.exp < target.nextExp) break;
      target.exp -= target.nextExp;
      target.level += 1;
      levels += 1;
    }
    if (target.level >= target.maxLevel) target.exp = 0;
    target.nextExp = petNextExp(target.level);
    S.petsTeam = (S.petsTeam || []).filter((k) => (S.pets || []).some((p) => p.key === k));
    save();
    return { ok: true, target: petInfo(target), gained: gain, levels, gold, materials: mats.map((p) => p.name) };
  }
  // 进化：消耗目标 + 2 只同星级非出战幻兽 + 金松果，变成高一星的随机幻兽。
  // 不给 / 不是数组时保留旧的「自动取前两只」行为，供老调用与存档脚本兼容。
  function evolvePet(targetKey, materialKeys) {
    const target = petByKey(targetKey);
    if (!target) return { ok: false, msg: '找不到要进化的幻兽' };
    if (target.grade >= 4) return { ok: false, msg: '四星幻兽已经是最高星级' };
    const nextGrade = target.grade + 1;
    let mats;
    if (Array.isArray(materialKeys)) {
      const keys = [...new Set((materialKeys || []).map(String).filter((k) => k && k !== target.key))];
      if (keys.length !== 2) return { ok: false, msg: '进化需要选择 2 只同星级材料幻兽' };
      mats = keys.map(petByKey);
      if (mats.some((p) => !p)) return { ok: false, msg: '选择的材料幻兽不存在' };
      if (mats.some((p) => p.grade !== target.grade)) return { ok: false, msg: '材料幻兽需要与目标同星级' };
      if (mats.some((p) => (S.petsTeam || []).includes(p.key))) {
        return { ok: false, msg: '出战队伍里的幻兽不能作为材料' };
      }
    } else {
      mats = (S.pets || []).filter((p) => p.key !== target.key && p.grade === target.grade && !(S.petsTeam || []).includes(p.key)).slice(0, 2);
    }
    if (mats.length < 2) return { ok: false, msg: '进化需要 2 只同星级、且不在出战队伍里的幻兽' };
    const cost = PET_GRADE_COST[nextGrade] || 200;
    if (integer(S.goldPoint, 0) < cost) return { ok: false, msg: '金松果不足（需要 ' + cost + ' 个）' };
    const def = randomPetDef(nextGrade);
    const pet = makePet(def, 1);
    const remove = new Set([target.key, ...mats.map((p) => p.key)]);
    const wasTeam = (S.petsTeam || []).includes(target.key);
    S.goldPoint = integer(S.goldPoint, 0) - cost;
    S.pets = (S.pets || []).filter((p) => !remove.has(p.key));
    S.pets.push(pet);
    S.petsTeam = (S.petsTeam || []).filter((k) => k !== target.key);
    if (wasTeam) S.petsTeam.push(pet.key);
    save();
    return { ok: true, pet: petInfo(pet), cost, materials: mats.map((p) => p.name) };
  }


  function petBattleBonus(petList) {
    ensurePetTables();
    const out = { power: 0, agility: 0, speed: 0, hp: 0 };
    for (const p of (Array.isArray(petList) ? petList : [])) {
      if (!p) continue;
      const grade = Math.max(1, Number(p.grade) || 1);
      const lv = Math.max(1, Number(p.level) || 1);
      const sid = Number(p.skillId) || 0;
      if ([1, 2, 3, 9].includes(sid)) out.power += Math.ceil(grade * 1.5 + lv / 5);
      // 都在触发时结算（装死回血 / 闪避回血 / 行动净化），不再预先加生命上限：
      else if ([4, 5, 10].includes(sid)) {  }
      else out.agility += Math.ceil(grade * 1.2 + lv / 6);
      out.speed += Math.ceil(grade / 2);
    }
    return out;
  }

  function applyPetBonuses(target, petList) {
    if (!target || target.__petBonusesApplied) return target;
    const bonus = petBattleBonus(petList);
    target.__petBonusesApplied = true;
    target.petBonus = bonus;
    for (const key of ['power', 'agility', 'speed']) target[key] = Math.max(1, Math.round((Number(target[key]) || 1) + bonus[key]));
    if (bonus.hp) {
      // ⚠ 目标可能没有 maxHp（随机 AI 的 `genAI` 以前只给 `hp`）。不能再用
      // `(Number(target.maxHp) || 1) + bonus.hp` —— 那会把敌人的上限误设成
      // 从完整血量一帧掉到 0。没有上限时把 `hp` 当作满血，再加幻兽的血量加成。
      const current = Math.max(1, Math.round(Number(target.hp) || 1));
      const max = Math.max(current, Math.round(Number(target.maxHp) || 0));
      target.maxHp = Math.max(1, max + bonus.hp);
      target.hp = Math.max(1, current + bonus.hp);
    }
    return target;
  }

  function randomPetLoadout(level, count) {
    ensurePetTables();
    if (!PETS.length) return [];
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Number(level) || 1));
    // 低等级随机敌人不能带幻兽；原版 25 级后才开放幻兽牧场。
    if (lv < PET_UNLOCK_LEVEL) return [];
    let n = Math.max(1, Math.min(3, Math.round(1 + lv / 28 + Math.random() * 0.8)));
    if (Number.isFinite(Number(count))) n = Math.max(0, Math.min(3, Number(count)));
    const out = [];
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      const grade = roll < 0.55 ? 1 : roll < 0.82 ? 2 : roll < 0.95 ? 3 : 4;
      const def = randomPetDef(grade);
      const petLevel = Math.max(1, Math.min(def.maxLevel, Math.round(1 + lv / 8 + Math.random() * 3)));
      out.push({
        key: 'foePet' + i + '_' + Math.floor(Math.random() * 1e6).toString(36),
        id: def.id, name: def.name, grade: def.grade, maxLevel: def.maxLevel,
        leadership: def.leadership, skillId: def.skillId,
        level: petLevel, exp: 0, nextExp: petNextExp(petLevel),
      });
    }
    return out;
  }

  function validLocalDate(date) { return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date); }
  function localDateTime(date, hour, minute) { const [y,m,d] = date.split('-').map(Number); return new Date(y,m-1,d,hour,minute).getTime(); }

  function yesterdayDate() {
    const [y, m, d] = localDate().split('-').map(Number);
    const date = new Date(y, m - 1, d); date.setDate(date.getDate() - 1);
    return dateKey(date);
  }

  const TRIBUTE_EXP_MIN = 0.05, TRIBUTE_EXP_MAX = 0.15;
  const TRIBUTE_GOLD_MIN = 0.05, TRIBUTE_GOLD_MAX = 0.25;
  const TRIBUTE_LEVEL_SUM_FULL = 270;
  // 与 `GData.APPRENTICE_TRIBUTE_*_CAP` 同源；服务端结算也读这份上限。
  // 最小依赖测试会单独加载 state.js，没有 GData 时退回同一组默认值。
  const tributeCapOf = (key, fallback) => Math.max(0, Math.floor(Number(
    (typeof GData !== 'undefined' && GData && GData[key]) || fallback
  )));
  const TRIBUTE_DAILY_EXP_CAP = tributeCapOf('APPRENTICE_TRIBUTE_EXP_CAP', 1000);
  const TRIBUTE_DAILY_GOLD_CAP = tributeCapOf('APPRENTICE_TRIBUTE_GOLD_CAP', 300);
  function apprenticeLevelSum(list) {
    return (Array.isArray(list) ? list : []).reduce((sum, p) => sum + Math.max(1, integer(p && p.level, 1)), 0);
  }

  function tributeLerp(sum, min, max) {
    const lo = Number(min) || 0, hi = Number(max) || 0;
    const span = (hi - lo) / TRIBUTE_LEVEL_SUM_FULL;
    const raw = lo + Math.max(0, integer(sum, 0)) * span;
    return Math.min(hi, Math.max(lo, raw));
  }

  function apprenticeTributeExpRatio(sum) { return tributeLerp(sum, TRIBUTE_EXP_MIN, TRIBUTE_EXP_MAX); }

  function apprenticeTributeGoldRatio(sum) { return tributeLerp(sum, TRIBUTE_GOLD_MIN, TRIBUTE_GOLD_MAX); }

  function apprenticeTributeRatio(sum) { return apprenticeTributeExpRatio(sum); }

  function apprenticeTributeTable(list) {
    const rows = Array.isArray(list) ? list : [];
    const date = yesterdayDate();
    const mine = earnOn(date);
    const sum = apprenticeLevelSum(rows);

    const expRatio = apprenticeTributeExpRatio(sum);
    const goldRatio = apprenticeTributeGoldRatio(sum);
    const ratio = expRatio;                                   // 兼容字段：旧界面读它显示「系数」
    const totalExp = Math.floor(mine.exp * expRatio), totalGold = Math.floor(mine.gold * goldRatio);
    const weightSum = sum || 1;
    const shares = [];
    let acc = 0, prevExp = 0, prevGold = 0;
    rows.forEach((p, i) => {
      acc += Math.max(1, integer(p && p.level, 1)) / weightSum;
      const last = i === rows.length - 1;
      const cumExp = last ? totalExp : Math.round(totalExp * acc);
      const cumGold = last ? totalGold : Math.round(totalGold * acc);
      shares.push({
        exp: Math.min(TRIBUTE_DAILY_EXP_CAP, Math.max(0, cumExp - prevExp)),
        gold: Math.min(TRIBUTE_DAILY_GOLD_CAP, Math.max(0, cumGold - prevGold)),
      });
      prevExp = cumExp; prevGold = cumGold;
    });
    const cappedExp = shares.reduce((sum, s) => sum + s.exp, 0);
    const cappedGold = shares.reduce((sum, s) => sum + s.gold, 0);
    return { date, mine, ratio, expRatio, goldRatio, totalExp: cappedExp, totalGold: cappedGold, shares };
  }
  function apprenticeDailyStatus(apprentice) {
    const p = object(apprentice) ? apprentice : null, today = localDate();
    const table = apprenticeTributeTable(S.prentices || []);
    const blank = { date: table.date, exp: 0, gold: 0, ratio: table.ratio,
      expRatio: table.expRatio, goldRatio: table.goldRatio, weight: 0, mine: table.mine,
      claimable: false, claimed: false, newApprentice: false };
    if (!p) return blank;
    if (!validLocalDate(p.since)) { p.since = today; p.joinedAt = Date.now(); save(); }
    const claimed = p.lastExpDate === today || p.tributeClaimedDate === table.date;
    if (p.since > table.date) return Object.assign({}, blank, { claimed, newApprentice: true });
    const sum = apprenticeLevelSum(S.prentices || []) || 1;
    const weight = Math.max(1, integer(p.level, 1)) / sum;
    const idx = (S.prentices || []).indexOf(p);
    const share = idx >= 0 ? table.shares[idx] : { exp: 0, gold: 0 };
    return { date: table.date, exp: share.exp, gold: share.gold, ratio: table.ratio,
      expRatio: table.expRatio, goldRatio: table.goldRatio, weight, mine: table.mine,
      claimable: !claimed && (share.exp > 0 || share.gold > 0), claimed, newApprentice: false };
  }
  function apprenticeDailyExp(apprentice) { return apprenticeDailyStatus(apprentice).exp; }
  function apprenticeDailyGold(apprentice) { return apprenticeDailyStatus(apprentice).gold; }

  function apprenticeDailyTotal() {
    const out = { exp: 0, gold: 0 };
    for (const p of S.prentices || []) {
      const daily = apprenticeDailyStatus(p);
      if (!daily.claimable) continue;
      out.exp += daily.exp; out.gold += daily.gold;
    }
    return out;
  }
  function claimApprenticeExp() {
    const today = localDate();
    let totalExp = 0, totalGold = 0, count = 0;
    for (const p of S.prentices || []) {
      const daily = apprenticeDailyStatus(p);
      if (!daily.claimable) continue;
      p.lastExpDate = today; p.tributeClaimedDate = daily.date;
      totalExp += daily.exp; totalGold += daily.gold; count++;
    }
    if (!count) return { ok: false, msg: '暂无可领取的昨日日供，新收徒需等待次日结算。' };

    if (ONLINE) {
      const cap = Math.round(Math.max(0, earnOn(yesterdayDate()).exp) * 0.10);
      totalExp = Math.min(totalExp, cap);
      totalGold = 0;
    }
    const ups = totalExp > 0 ? gainExp(totalExp, { noTrack: true }) : [];
    if (totalGold > 0) addGold(totalGold, { count: false });
    save();
    const parts = [];
    if (totalExp > 0) parts.push('经验 +' + totalExp);
    if (totalGold > 0) parts.push('金松果 +' + totalGold);
    return { ok: true, total: totalExp, gold: totalGold, count, ups,
      msg: count + ' 个徒弟昨日日供：' + (parts.join('　') || '无') };
  }
  let recruitSequence=0;
  function beginRecruitChallenge(candidate) {
    if (!object(candidate)||!candidate.name) return {ok:false,msg:'请选择收徒对象'};
    if (S.recruitChallenge) return {ok:false,msg:'收徒挑战尚未结束'};
    if (S.prentices.length>=apprenticeCap(S.level)) return {ok:false,msg:'收徒名额已满'};
    if (S.prentices.some(p=>p.name===String(candidate.name).slice(0,20))) return {ok:false,msg:'已经收过这个徒弟了'};
    if (S.goldPoint<10) return {ok:false,msg:'收徒挑战需要10金松果'};
    if (Number(S.energy) < 10) return {ok:false,msg:'体力不足10点，无法进行收徒挑战'};
    const token='recruit_'+Date.now()+'_'+(++recruitSequence);
    S.goldPoint-=10;
    // 原版 `getStudent` 先 `hasEnoughEnergy()` 再打 `fightType=2`；服务端那场战斗
    S.energy=Math.max(0,Number(S.energy)-10);
    S.recruitChallenge={token,fee:10,energyFee:10,candidate:clone(candidate)};save();
    return {ok:true,token,foe:clone(object(candidate.master)&&candidate.master.name?candidate.master:candidate)};
  }
  function cancelRecruitChallenge(token) {
    if (!S.recruitChallenge||S.recruitChallenge.token!==token)return false;
    S.goldPoint+=S.recruitChallenge.fee;
    S.energy=Math.min(Number(S.maxEnergy)||ENERGY_HARD_CAP,Number(S.energy||0)+(Number(S.recruitChallenge.energyFee)||0));
    S.recruitChallenge=null;save();return true;
  }
  function finishRecruitChallenge(token,win) {
    const run=S.recruitChallenge;if(!run||run.token!==token)return {ok:false};
    S.recruitChallenge=null;
    const added=win?addPrentice(run.candidate):null;
    tickPropStates();const exp=win?20:0,ups=gainExp(exp);save();
    return {ok:true,win,exp,gold:0,ups,recruited:added&&added.ok?added.apprentice:null,
      msg:win?(added.ok?'收【'+run.candidate.name+'】为徒！':added.msg):'收徒挑战失败，提升实力后再来。'};
  }

  function canKickToday() {
    return (S.masterKickDate || '') !== localDate();
  }
  function kickPrentice(name) {
    if (!canKickToday()) return { ok: false, msg: '今天已经踢过一个徒弟了，明天再来' };
    const i = S.prentices.findIndex((p) => p.name === name);
    if (i < 0) return { ok: false, msg: '没有这个徒弟' };
    S.prentices.splice(i, 1);
    S.masterKickDate = localDate();
    save();
    return { ok: true, msg: '已让【' + name + '】离开师门' };
  }


  // 把 S.props 里超过上限的数量收口（save 前统一调用）。
  function clampProps() {
    if (!S || !object(S.props)) return;
    for (const id of Object.keys(S.props)) {
      const count = Number(S.props[id]);
      if (!Number.isFinite(count)) { delete S.props[id]; continue; }
      if (count > PROP_HARD_CAP) S.props[id] = PROP_HARD_CAP;
      else if (count < 0) delete S.props[id];
    }
  }
  function save() {
    try {
      if (!S) return false;
      // 本地不落盘：进度只由服务端 `POST /api/action` 写库。
      // 这里仍然做收口（道具上限/永久属性上限），只是不写任何存储。
      if (ONLINE) { clampProps(); clampPermanentStats(); return true; }
      clampProps();
      clampPermanentStats();
      S.savedAt = Date.now();
      saveRevision++;
      if (storageMode() === 'file' || saveTransport) {
        fileState.dirty = true;
        writeMirror();
        scheduleFileWrite();
        return true;
      }
      localStorage.setItem(SAVE_KEY, JSON.stringify(savePayload()));
      return true;
    } catch (e) { return false; }
  }
  // 读浏览器里的存档（现在只在「没有本地服务器」或自检档时使用）。
  function load() {
    // 没有本地存档可读：进游戏走 `Net.get('/api/state')`。
    if (ONLINE) return false;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!object(parsed)) return false;
        if (!adoptPayload(parsed)) return false;
        syncDailyStats();
        if (battlePayloadNeedsTrim(parsed)) save();
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 存档：主存档 = 游戏目录下的 save/progress.json
  // · 有本地服务器：进度只写这个文件，浏览器 localStorage 不再当存档用
  // · 没有本地服务器（GitHub Pages、file://）：退回 localStorage，否则无处可存；
  const SAVE_URL = '__save';
  const LEGACY_KEY = SAVE_KEY;                       // 旧的 localStorage 存档键
  const fileState = { available: false, transportReady: false, checked: false, code: 0, fileAt: 0, fileExists: false, fileLevel: 0, fileReborn: 0, fileBackup: false, lastProbe: 0, error: '', reason: '', lastWrite: 0, lastLoad: 0, lastRead: 0, lastReadErr: '', conflict: false, dirty: false, freshLocal: false, forceWrite: false, path: 'save/progress.json' };
  let fileTimer = 0;
  let saveRevision = 0;
  let fileLoadGeneration = 0;
  let fileWriteTail = Promise.resolve();
  function queueFileWrite(write) {
    const task = fileWriteTail.then(write, write);
    fileWriteTail = task.catch(() => {});
    return task;
  }

  function payloadMaxLevel(obj) {
    if (!object(obj)) return 0;
    let lv = Math.max(0, integer(obj.level, 0, 0));
    if (object(obj.__dualOther)) lv = Math.max(lv, Math.max(0, integer(obj.__dualOther.level, 0, 0)));
    if (object(obj.__dualSaves)) {
      for (const slot of Object.values(obj.__dualSaves)) {
        if (object(slot)) lv = Math.max(lv, Math.max(0, integer(slot.level, 0, 0)));
      }
    }
    return lv;
  }
  // 旧转生档的低等级凭证：历史版本转生果会 `reborn++` 并降回 1 级。
  function payloadReborn(obj) {
    if (!object(obj)) return 0;
    return Math.max(0, integer(obj.reborn, 0, 0));
  }
  // 这是不是「刚建的新档」——只有 1 级、没打过一场、没通关过、也不是转生。
  // 用它挡住「浏览器里的 1 级空档覆盖磁盘上几十级的正式存档」。
  // ⚠ 不能只看等级：旧转生档会把等级降回 1（`reborn > 0`），那是合法存档；
  function isFreshPayload(obj) {
    if (!object(obj)) return false;
    if (payloadMaxLevel(obj) > 1) return false;
    if (Math.max(0, integer(obj.reborn, 0, 0)) > 0) return false;
    if (Math.max(0, integer(obj.allWins, 0, 0)) > 0) return false;
    if (object(obj.stages) && Object.keys(obj.stages).length) return false;
    return true;
  }

  let transportAnnounced = false;
  // 存档读写通道：默认走本地服务器的 /__save；宿主（Tauri 等）可以替换成自己的实现。
  let saveTransport = null;

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  function storageMode() { return !testMode && fileState.available ? 'file' : 'local'; }
  function forgetLegacy() {
    try { localStorage.removeItem(LEGACY_KEY); localStorage.removeItem(LEGACY_KEY + '_sync'); localStorage.removeItem(LEGACY_KEY + '_base'); localStorage.removeItem(LEGACY_KEY + '_pending'); } catch (e) {}
  }
  // 浏览器兜底档是不是「更新且等级不低于文件里这份」——换机器/双机同步后本机没跟上时，
  // 它就是玩家真正的最新进度，不能当成残留垃圾悄悄删掉（交给 fileWrite 的冲突保护处理）。
  function localSaveWorthKeeping(fileAt) {
    const local = localSaveMeta();
    if (!local) return false;
    if (local.pending && local.base === Number(fileAt)) return true;
    const fileLevel = (S && S.level) || 1;
    return local.savedAt > (Number(fileAt) || 0) + 1000 && local.level >= fileLevel;
  }
  // 收口：只有在「那份浏览器兜底档已经冗余」时才删它。
  // 读档、写档、后台补写所有路径都走这里，避免某一条路径把玩家更新的兜底档悄悄删掉。
  function forgetLegacyIfRedundant(fileAt) {
    if (localSaveWorthKeeping(fileAt)) return false;
    forgetLegacy();
    return true;
  }
  // 同步镜像：文件存档模式下，除防抖写盘之外再在 localStorage 存一份当前进度。
  // 整条链是异步的，进程被系统回收时可能只跑了一半 —— 玩家看到的就是
  // 「有时候退出会存档，有时候不会」。localStorage 是同步写，随进程一起持久化。
  function writeMirror() {
    try {
      if (typeof localStorage === 'undefined' || !S) return false;
      // 只有「旧兜底档等级更高」时才让路：那种档是另一台机器/同步服务留下的，
      // 要留给玩家手动导入。同级（正常连点几下）照写，否则文件一直写失败时镜像会停旧。
      const old = localSaveMeta();
      const fileAt = Number(fileState.fileAt) || 0;
      const payload = savePayload();
      if (old && old.savedAt > fileAt + 1000 && old.level > payloadMaxLevel(payload)) return false;
// 只探到 mtime、尚未读过文件时，不能把兜底档冒认为基于该文件的新进度。
      const base = !fileState.lastRead && fileState.fileExists ? (old && old.base != null ? old.base : '') : fileAt;
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      localStorage.setItem(SAVE_KEY + '_base', String(base));
      localStorage.setItem(SAVE_KEY + '_pending', '1');
      return true;
    } catch (e) { return false; }
  }
  // 宿主替换存档通道（Tauri 里用 Rust 端命令读写文件）。
  function setSaveTransport(t) {
    saveTransport = t && typeof t.probe === 'function' ? t : null;
    if (saveTransport && saveTransport.path) fileState.path = saveTransport.path;
    fileState.checked = false;
    fileState.available = false;
    // 移动端 `window.__TAURI__` 是异步注入的：启动早期 `fileLoad()` 可能已经因为
    // · 已经有存档文件 → 不抢写，让 Main 的 retryFileSave 读文件并重载；
    // 这里不能直接 fileLoad：玩家可能已经在本地档上操作，读文件顶掉会丢进度。
    if (saveTransport) {

      if (!transportAnnounced) {
        transportAnnounced = true;
        try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ssdz-save-transport-ready')); } catch (e) {}
      }
      setTimeout(() => {
        if (!saveTransport) return;
        void fileProbe().then((ok) => {
          if (!ok || !S || fileState.fileAt > 0) return;
          scheduleFileWrite();
        }).catch(() => {});
      }, 0);
    }
  }
  const isFileProtocol = () => typeof location !== 'undefined' && location.protocol === 'file:';
  // 浏览器 localStorage 里有没有兜底存档（boot 判断「能不能回落」时用，不改动内存状态）。
  function hasLocalSave() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  function localSaveMeta() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!object(parsed)) return null;
      const baseRaw = localStorage.getItem(SAVE_KEY + '_base');
      const base = baseRaw == null || baseRaw === '' ? null : Number(baseRaw);
      return {
        level: Math.max(1, payloadMaxLevel(parsed)),
        savedAt: Number(parsed.savedAt) || 0,
        base: Number.isFinite(base) ? base : null,
        pending: localStorage.getItem(SAVE_KEY + '_pending') === '1',
      };
    } catch (e) { return null; }
  }
  // 探一次存档通道在不在，并把「为什么不可用」记下来给界面显示。
  // 注意：只探「通道在不在」——读文件本身成功还是失败由 fileState.lastRead / lastReadErr 单独记，
  // 否则界面会把「连不上服务器」和「服务器没有存档接口」混成一句含糊的话。
  async function fileProbe() {
    if (testMode) { fileState.checked = true; fileState.available = false; fileState.code = 0; fileState.reason = '自检档不写正式存档'; return false; }
    fileState.code = 0;
    if (saveTransport) {
      try {
        const meta = await saveTransport.probe();
        fileState.available = !!meta.ok;
// 区分「通道坏了」和「通道好用、只是还没有存档文件」——
        fileState.transportReady = !!meta.ok;
        fileState.fileAt = Number(meta.savedAt) || 0;
        fileState.fileExists = meta.exists === true || fileState.fileAt > 0;
        fileState.fileLevel = Math.max(0, integer(meta.maxLevel != null ? meta.maxLevel : meta.level, 0, 0));
        fileState.fileReborn = Math.max(0, integer(meta.reborn, 0, 0));
        fileState.fileBackup = !!meta.backup;
        fileState.reason = fileState.available ? '' : (meta.msg || '存档通道不可用');
        fileState.error = '';
      } catch (e) {
        fileState.available = false;
        fileState.transportReady = false;
        fileState.reason = '存档通道出错：' + String((e && e.message) || e);
        fileState.error = fileState.reason;
      }
      fileState.checked = true;
      return fileState.available;
    }
    if (typeof fetch !== 'function') { fileState.checked = true; fileState.available = false; fileState.reason = '这个环境没有 fetch，无法读写存档文件'; return false; }
    if (isFileProtocol()) {
      fileState.checked = true; fileState.available = false;
      fileState.reason = '页面是 file:// 打开的，浏览器不允许写文件。请用启动器打开游戏（Windows：squirrel_fight.exe 或 scripts/启动游戏.cmd；macOS：scripts/启动游戏.command；也可以 node scripts/serve.js）。';
      return false;
    }
    try {
      const res = await fetch(SAVE_URL + '?meta=1', { cache: 'no-store' });
      if (!res.ok) {
        fileState.code = res.status;
        fileState.reason = res.status === 404
          ? '服务器没有 /__save 接口（HTTP 404）：可能是 python3 -m http.server、旧版 serve.js，或页面来自别的静态托管。'
          : '服务器返回 HTTP ' + res.status;
        throw new Error(fileState.reason);
      }
      const info = await res.json();
      fileState.available = !!info.ok;
      fileState.fileAt = Number(info.savedAt) || 0;
      fileState.fileExists = info.exists === true || fileState.fileAt > 0;
      fileState.fileLevel = Math.max(0, integer(info.maxLevel != null ? info.maxLevel : info.level, 0, 0));
      fileState.fileReborn = Math.max(0, integer(info.reborn, 0, 0));
      fileState.fileBackup = !!info.backup;
      fileState.reason = fileState.available ? '' : (info.msg || '服务器关闭了存档写入（--no-save？）');
      fileState.error = '';
      if (info.path) fileState.path = info.path;
    } catch (e) {
      fileState.available = false;
      if (!fileState.reason) fileState.reason = '连不上本地服务器：' + String((e && e.message) || e);
      fileState.error = fileState.reason;
    }
    fileState.checked = true;
    return fileState.available;
  }
  // 读主存档：文件优先，没有文件就把 localStorage 里的老档迁进去。
  async function fileLoad(request) {
    const generation = ++fileLoadGeneration;
    const current = () => generation === fileLoadGeneration && !(request && request.cancelled);
    if (!fileState.available) await fileProbe();
    if (!current() || !fileState.available) return false;
    fileState.lastRead = 0;
    fileState.lastReadErr = '';
    try {
      const info = saveTransport ? await saveTransport.read() : await (await fetch(SAVE_URL, { cache: 'no-store' })).json();
// 超时退回本地档后，迟到的旧读不能再改内存、镜像或读档确认状态。
      if (!current()) return false;
      fileState.fileAt = Number(info.savedAt) || 0;
      fileState.fileLevel = Math.max(fileState.fileLevel, Math.max(0, integer(info.maxLevel, 0, 0)));
      fileState.fileReborn = Math.max(fileState.fileReborn, Math.max(0, integer(info.reborn, 0, 0)));
      fileState.fileBackup = !!info.backup || !!info.recoveredFrom;
      if (info.exists && info.data) {
        let parsed = typeof info.data === 'string' ? JSON.parse(info.data) : info.data;
        if (!object(parsed)) throw new Error('存档内容不是对象');

        const local = localSaveMeta();
        if (local && local.base === fileState.fileAt && local.level >= payloadMaxLevel(parsed)
          && (local.pending || local.savedAt > fileState.fileAt + 1500)) {
          const mirror = JSON.parse(localStorage.getItem(SAVE_KEY));
          if (object(mirror)) parsed = mirror;
        }
        fileState.fileLevel = Math.max(fileState.fileLevel, payloadMaxLevel(parsed));
        fileState.fileReborn = Math.max(fileState.fileReborn, payloadReborn(parsed));
        const loaded = adoptPayload(parsed);
        fileState.lastLoad = Date.now();
        fileState.lastRead = fileState.fileAt || Date.now();
        if (!loaded) {
          // 文件是另一界面的槽位，当前界面还没有独立存档：不把别的界面进度顶进来，
          fileState.lastReadErr = '当前界面还没有独立存档';
          fileState.conflict = false;
          return false;
        }
        syncDailyStats();
        // 「存档文件更新，已跳过写入」永久挡住 —— 表现在玩家身上就是「打了半天进度没保存」。
        S.savedAt = fileState.fileAt || Number(parsed.savedAt) || Date.now();
// 文件是主存档，旧的浏览器兜底档就此退休；
        forgetLegacyIfRedundant(fileState.fileAt);
        fileState.conflict = false;
        if (battlePayloadNeedsTrim(parsed)) save();
        return true;
      }
      if (load()) {
        await fileWrite(true);
        return current();
      }
      return false;
    } catch (e) {
      if (!current()) return false;
      fileState.lastReadErr = String((e && e.message) || e);
      fileState.error = fileState.lastReadErr;
      return false;
    }
  }
  // 读存档文件的元信息（savedAt / exists）。1.2 秒内复用上一次结果：
  async function probeMeta(force) {
    const now = Date.now();
    if (!force && fileState.lastProbe && now - fileState.lastProbe < 1200) {
      return { savedAt: fileState.fileAt, exists: fileState.fileExists, maxLevel: fileState.fileLevel, reborn: fileState.fileReborn, backup: fileState.fileBackup };
    }
    const meta = saveTransport ? await saveTransport.probe()
      : await (await fetch(SAVE_URL + '?meta=1', { cache: 'no-store' })).json();
    fileState.lastProbe = now;
    fileState.fileAt = Number(meta.savedAt) || fileState.fileAt;
    fileState.fileExists = meta.exists === true || fileState.fileAt > 0;
    fileState.fileLevel = Math.max(fileState.fileLevel, Math.max(0, integer(meta.maxLevel != null ? meta.maxLevel : meta.level, 0, 0)));
    fileState.fileReborn = Math.max(fileState.fileReborn, Math.max(0, integer(meta.reborn, 0, 0)));
    fileState.fileBackup = !!meta.backup;
    return meta;
  }
  // 把当前进度写进 save/progress.json（force=true 时不检查「文件是否更新」）。
  // 防「1 级空档覆盖正式存档」：iOS 换包/桥接迟到时，启动可能先走浏览器兜底档，
  // iOS 的 `save_write` 没有 —— 这就是「存档在初始档与有进度的档之间横跳」的来源之一。
  function fileWrite(force, options) {
    const allowFreshOverwrite = fileState.forceWrite === true;
    fileState.forceWrite = false;
    return queueFileWrite(() => writeCurrentFile(force, allowFreshOverwrite, options || {}));
  }
  async function writeCurrentFile(force, allowFreshOverwrite, options) {
    if (testMode) return { ok: false, msg: '自检档不写正式存档' };
    if (options.background && !fileState.dirty) return { ok: true, msg: '存档没有变化' };
    fileState.dirty = true;
    if (!fileState.available) await fileProbe();
    if (!fileState.available) return { ok: false, msg: '存档写入不可用：' + (fileState.reason || '未知原因') };
    try {
      const meta = await probeMeta(!!force || allowFreshOverwrite);
      const fileAt = Number(meta.savedAt) || 0;
      const localAt = (S && S.savedAt) || 0;
      const writtenRevision = saveRevision;
      const payload = savePayload();
      const body = JSON.stringify(payload);
      const incomingMax = payloadMaxLevel(payload);
      const fileLevel = Math.max(fileState.fileLevel, Math.max(0, integer(meta.maxLevel != null ? meta.maxLevel : meta.level, 0, 0)));
      // 本次启动还没读过文件（iOS 原生桥晚到最常见）：磁盘上又已经是正式进度时，
      // 先别写。否则页面按兜底档/旧状态跑出来的存档会盖掉还没读进来的正式档。
      if (!allowFreshOverwrite && !fileState.lastRead && fileState.fileExists && fileLevel >= 5) {
        fileState.conflict = true;
        return { ok: false, conflict: true, msg: '本次启动还没有成功读取磁盘存档，已暂缓写入（避免覆盖正式进度）' };
      }
// 存档文件里已有别的进度（新浏览器 / 换了机器第一次打开）：不覆盖，先让玩家决定
      if (!allowFreshOverwrite && meta.exists && fileState.freshLocal && fileAt > 0) {
        fileState.conflict = true; fileState.fileAt = fileAt;
        return { ok: false, conflict: true, msg: '存档文件里已有进度（' + fmtTime(fileAt) + '），没有覆盖' };
      }
      // 新档比磁盘档低 = 多半是旧兜底档/初始档回来了，拒绝覆盖。
      // 唯一合法的降级是旧转生档（reborn 增加）；1 级档玩到 2 级再写回去同样会被这里拦住。
      const incomingReborn = payloadReborn(payload);
      if (!allowFreshOverwrite && incomingMax < fileLevel && incomingReborn <= fileState.fileReborn) {
        fileState.conflict = true;
        const what = isFreshPayload(payload) ? '全新的 1 级空档' : (incomingMax + ' 级旧档');
        return { ok: false, conflict: true, msg: '存档文件里已有 ' + fileLevel + ' 级进度，已拒绝用' + what + '覆盖' };
      }
      if (!force && !allowFreshOverwrite && fileAt > localAt + 1000) {
        fileState.conflict = true; fileState.fileAt = fileAt;
        return { ok: false, conflict: true, msg: '存档文件更新（' + fmtTime(fileAt) + '），已跳过写入' };
      }
      const out = saveTransport ? await saveTransport.write(body, { force: allowFreshOverwrite })
        : await (await fetch(SAVE_URL + (allowFreshOverwrite ? '?force=1' : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: !!options.keepalive })).json();
      if (!out || out.ok !== true) throw new Error((out && out.msg) || '写入失败');
      fileState.fileAt = Number(out.savedAt) || Date.now();
      fileState.fileExists = true;
      fileState.lastProbe = Date.now();
      fileState.lastWrite = Date.now();

      if (!fileState.lastRead) fileState.lastRead = fileState.fileAt;
      fileState.conflict = false;
      fileState.dirty = saveRevision !== writtenRevision;
      fileState.error = '';
      fileState.freshLocal = false;
      // 写成功 = 磁盘上现在就是这份档，等级/转生次数都以它为准确值。
      // 不能保留旧的 40 级水位：转生后合法回到 1 级，下一笔 2 级存档会
      fileState.fileLevel = incomingMax;
      fileState.fileReborn = incomingReborn;
      if (fileState.dirty) writeMirror();
      else {
        let confirmedMirror = false;
        try { confirmedMirror = localStorage.getItem(SAVE_KEY) === body; } catch (e) {}
        if (confirmedMirror) forgetLegacy();
        else forgetLegacyIfRedundant(fileState.fileAt);
      }
      return { ok: true, msg: '已写入 ' + fileState.path, fileAt: fileState.fileAt };
    } catch (e) {
      fileState.error = String((e && e.message) || e);
      return { ok: false, msg: '写入存档失败：' + fileState.error };
    }
  }

  function fileWriteNow() { return fileWrite(true); }
  // 存档文件的信息（系统页显示用）。
  // 安卓/桌面安装版的 Tauri 存档通道是否存在。导入存档必须走它，
  // 不能 fetch('/__save') —— tauri.localhost 没有那个 HTTP 接口。
  function hasFileTransport() { return !!saveTransport; }
  // 读当前磁盘存档原文（给“导入前备份”用）；没有通道返回 null。
  async function readFileRaw() {
    if (!saveTransport) return null;
    try { const info = await saveTransport.read(); return info && info.data ? String(info.data) : null; }
    catch (e) { return null; }
  }
  // 用导入的 JSON 原文覆盖正式存档（安装版/安卓走原生通道，带备份由调用方做）。
  function importFileRaw(raw) {
    return queueFileWrite(() => writeImportedFile(raw));
  }
  async function writeImportedFile(raw) {
    if (!saveTransport) return { ok: false, msg: '没有可用的存档通道' };
    try {
      let body = String(raw);
      const parsed = JSON.parse(body.replace(/^\uFEFF/, ''));
      if (battlePayloadNeedsTrim(parsed)) {
        for (const slot of [parsed, parsed.__dualOther,
          ...SAVE_SLOTS.map((mode) => object(parsed.__dualSaves) && parsed.__dualSaves[mode])]) {
          if (object(slot)) trimBattleHistory(slot);
        }
        body = JSON.stringify(parsed);
      }
      const out = await saveTransport.write(body, { force: true });
      // 必须明确拿到 ok:true。iOS 的旧问题就是命令返回了空对象/非预期结果，
      if (!out || out.ok !== true) return { ok: false, msg: (out && out.msg) || '原生存档通道没有确认写入成功' };
// force 导入允许合法降级；后续普通保存不能继续拿导入前的高等级水位拦新档。
      fileState.fileAt = Number(out.savedAt) || fileState.fileAt;
      fileState.fileExists = true;
      fileState.fileLevel = payloadMaxLevel(parsed);
      fileState.fileReborn = payloadReborn(parsed);
      fileState.freshLocal = false;
      fileState.lastProbe = Date.now();
      fileState.lastWrite = Date.now();
      fileState.conflict = false;
      fileState.error = '';
// 显式导入已成为主档，即使 mtime 恰与旧 base 同毫秒，也不能再恢复旧镜像。
      forgetLegacy();
      return { ok: true, savedAt: Number(out.savedAt) || 0 };
    } catch (e) {
      return { ok: false, msg: (e && e.message) || String(e) };
    }
  }
  function fileInfo() {
    return {
      mode: storageMode(), available: fileState.available, checked: fileState.checked,
      transportReady: fileState.transportReady,
      conflict: fileState.conflict, fileAt: fileState.fileAt, localAt: (S && S.savedAt) || 0,
      fileLevel: fileState.fileLevel, fileReborn: fileState.fileReborn, fileBackup: fileState.fileBackup, fileExists: fileState.fileExists,
      code: fileState.code,
      lastWrite: fileState.lastWrite, lastLoad: fileState.lastLoad,
      lastRead: fileState.lastRead, lastReadErr: fileState.lastReadErr,
      error: fileState.error,
      dirty: fileState.dirty, path: fileState.path, reason: fileState.reason,
    };
  }
  function fileLoadedThisBoot() { return fileState.lastRead > 0; }

  function scheduleFileWrite() {
    if (!S || (storageMode() !== 'file' && !saveTransport) || typeof setTimeout !== 'function') return;
    fileState.dirty = true;
    if (fileTimer) clearTimeout(fileTimer);
    fileTimer = setTimeout(() => { fileTimer = 0; void fileWrite(false, { background: true }); }, 400);
  }
  function flushFileWrite() {
    rememberUiMode();
    if (fileTimer) { clearTimeout(fileTimer); fileTimer = 0; }
    if (!S) return;
    // 先把同步镜像写掉：这一步不依赖 WebView 的异步桥（安卓上 onPause 之后的
    if (!fileState.dirty) return;
    if (storageMode() === 'file' || saveTransport) writeMirror();
    if (storageMode() !== 'file' && !saveTransport) return;
// 与防抖/立即保存共用队列、冲突保护和成功确认；隐藏事件重复到达也不并发写盘。
    return fileWrite(false, { background: true, keepalive: true });
  }
  // 原生壳（Android MainActivity.onPause）通过这个入口在切后台时立刻刷盘。
  // 不能只依赖 pagehide：Tauri Android WebView 在按 Home/被系统回收时不一定派发。
  try { if (typeof window !== 'undefined') window.__ssdzFlushSave = flushFileWrite; } catch (e) {}
  if (typeof window !== 'undefined' && window.addEventListener) {
    // 只留 `pagehide` 与「页面隐藏」两个出口：`beforeunload` 与它们重复，
    // 关页/切后台时会把同一份 360 KB 存档连发三遍（2026-10 审计）。
    window.addEventListener('pagehide', flushFileWrite);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushFileWrite(); });
    }
  }


  function newGame(name, opts) {
    const mode = validSaveMode(opts && opts.uiMode) ? String(opts.uiMode) : slotMode();
    saveMode = mode;
    writeUiModePref(mode);
    // 新角色：如果另一界面已经有进度，这一份要和它一起写进文件，不能当成"全新文件"挡住写入。
    fileState.freshLocal = !otherSlot;
    // 只有调试面板「彻底重置账号」这种玩家二次确认过的重置才允许主动把正式档降回 1 级；
    // 其它路径（启动回落、切界面、桥接迟到）一律走 fileWrite 的 1 级空档保护。
    fileState.forceWrite = !!(opts && opts.force);
    S = clone(GData.NEW_PLAYER);
    Object.assign(S, GData.initialStats());
    S.stageRuns = {};
    S.friends = [];
    // 昵称上限 7 个汉字（英文/数字按 1/3 计）；界面会先校验，这里再兜底截断，
    // 防止调试/脚本路径把超长名字写进存档。没有 `NicknameRules` 的测试环境退回旧行为。
    const rawName = typeof name === 'string' && name.trim() ? name.trim() : '小松鼠';
    const rules = typeof window !== 'undefined' && window.NicknameRules;
    S.name = rules && typeof rules.truncate === 'function'
      ? (rules.truncate(rawName, rules.MAX_UNITS) || '小松鼠')
      : rawName.slice(0, 20);
    S.newbieStartDate = localDate();
    S.debugClockOffset = 0;
    S.lastEnergyTs = Date.now();
    S.dailyStatsDate = localDate();
    S.props = { 1: 3, 2: 2, 28: 1 };
    S.settings = normalizeSettings(null);   // 新角色：音量/分辨率/全面屏的默认值也写进存档

    S.settings.uiMode = mode;
    try { if (window.UI && UI.applyUiMode) UI.applyUiMode(mode); } catch (e) {}
    const weaponId = opts && Number(opts.weaponId);
    if (Number.isSafeInteger(weaponId) && weaponsMap.getValue(weaponId)) {
      const level = Math.min(15, Math.max(1, integer(opts.weaponLevel, 1, 1)));
      S.weapons = [weaponId + ':' + level];
    }
    save();
  }
  function state() { return S; }

  const SPEED_UNLOCK_LEVEL = 10;
  const SKIP_UNLOCK_LEVEL = 20;
  const VIP_SKIP_UNLOCK_LEVEL = 10;
  function unlockedSpeed() { return !!S && Number(S.level) >= SPEED_UNLOCK_LEVEL; }
  function unlockedSkip() {
    if (!S) return false;
    const lv = Number(S.level) || 0;
    return lv >= (vipActive() ? VIP_SKIP_UNLOCK_LEVEL : SKIP_UNLOCK_LEVEL);
  }

  function skipButtonEnabled() {
    if (!S) return false;
    return settings().showSkip !== false && unlockedSkip();
  }


  function tickEnergy() {
    syncDailyStats();
    const now = nowMs();
    if (debugOn('infiniteEnergy')) { S.energy = S.maxEnergy; S.lastEnergyTs = now; return; }
    syncVipEnergyCap();
    tickVipDaily();
    const interval = ENERGY_INTERVAL / vipRegenMul();
    if (!Number.isFinite(S.lastEnergyTs) || S.lastEnergyTs <= 0 || S.lastEnergyTs > now) S.lastEnergyTs = now;
    if (S.energy >= S.maxEnergy) { S.lastEnergyTs = now; return; }
    const gain = Math.floor((now - S.lastEnergyTs) / interval);
    if (gain > 0) {
      S.energy = Math.min(S.maxEnergy, S.energy + gain);
      S.lastEnergyTs = S.energy === S.maxEnergy ? now : S.lastEnergyTs + gain * interval;
      save();
    }
  }
  function energyCountdown() {
    tickEnergy();
    if (S.energy >= S.maxEnergy) return '';

    const interval = ENERGY_INTERVAL / vipRegenMul();
    const remain = Math.max(0, interval - (nowMs() - S.lastEnergyTs));
    const m = Math.floor(remain / 60000), s = Math.floor((remain % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // 批量使用道具（目前只对药剂有意义）：一次用 count 个，返回合并结果。
  // count 传 'all' 就用背包里全部（受硬上限 999 限制）。
  function usePropMany(id, count) {
    id = parseInt(id);
    const held = S.props[id] || 0;
    if (held <= 0) return { ok: false, msg: '没有该道具', used: 0 };
    let want = count === 'all' ? held : Math.max(1, Math.floor(Number(count) || 1));
    want = Math.min(want, held);
    if (id !== 1 && id !== 2) {
      const one = useProp(id);
      return { ok: one.ok, used: one.ok ? 1 : 0, msg: one.msg };
    }
    let used = 0, stopMsg = '';
    for (let i = 0; i < want; i++) {
      const r = useProp(id);
      if (!r.ok) { stopMsg = r.msg; break; }
      used++;
    }
    const name = (propMap.getValue(id) || {}).name || '药剂';
    return {
      ok: used > 0, used,
      msg: used ? '使用 ' + name + ' ×' + used + '　体力 ' + S.energy + '/' + S.maxEnergy + '（上限 ' + ENERGY_HARD_CAP + '）'
        : (stopMsg || '无法使用'),
    };
  }
  function energyHardCap() { return ENERGY_HARD_CAP; }



  function weaponList() {
    const out = [];
    weaponsMap.each((id, v) => { if (v && +id > 0) out.push({ id: +id, name: v.name, harm: v.harm, type: v.type }); });
    return out.sort((a, b) => a.id - b.id);
  }
  function weaponInst(str) {
    const [id, rawLevel] = String(str).split(/[:,]/).map(Number);
    const level = Math.min(15, integer(rawLevel, 1, 1));
    const base = weaponsMap.getValue(id);
    if (!base) return null;
    const w = { id, level, name: base.name, type: base.type, remark: base.remark };
    const [lo, hi] = base.harm.split('-').map(Number);
    let add = 0;
    if (level <= 10) add = parseInt(base.harmAdd) * (level - 1);
    else {
      add = parseInt(base.harmAdd) * 9;
      const extra = base.harmAdd1.split('|').map(Number);
      for (let i = 0; i < level - 10 && i < extra.length; i++) add += extra[i];
    }
    w.harmLo = lo + add; w.harmHi = hi + add;
    return w;
  }
  function skillInst(str) {
    const [id, rawLevel] = String(str).split(/[:,]/).map(Number);
    const level = Math.min(15, integer(rawLevel, 1, 1));
    const base = skillsMap.getValue(id);
    if (!base) return null;
    return { id, level, name: base.name, type: base.type, remark: base.remark };
  }
  function myWeapons() { return S.weapons.map(weaponInst).filter(Boolean); }
  function mySkills() { return S.skills.map(skillInst).filter(Boolean); }


  function skillList() {
    const out = [];
    skillsMap.each((id, v) => { if (v && +id > 0) out.push({ id: +id, name: v.name, type: v.type }); });
    return out.sort((a, b) => a.id - b.id);
  }

  function setWS(kind, id, level) {
    const map = kind === 'skill' ? skillsMap : weaponsMap;
    const def = map.getValue(Number(id));
    if (!def) return { ok: false, msg: '没有这个' + (kind === 'skill' ? '技能' : '武器') };
    const lv = Math.min(15, integer(level, 1, 1));
    const arr = kind === 'skill' ? S.skills : S.weapons;
    const at = arr.findIndex((x) => Number(String(x).split(':')[0]) === Number(id));
    const entry = Number(id) + ':' + lv;
    if (at >= 0) arr[at] = entry; else arr.push(entry);
    save();
    return { ok: true, kind, id: Number(id), level: lv, name: def.name, replaced: at >= 0, total: ownedWSCount(), limit: wsLimit() };
  }

  function forgetWS(kind, id) {
    const arr = kind === 'skill' ? S.skills : S.weapons;
    const at = arr.findIndex((x) => Number(String(x).split(':')[0]) === Number(id));
    if (at < 0) return { ok: false, msg: '还没有这个' + (kind === 'skill' ? '技能' : '武器') };
    const def = (kind === 'skill' ? skillsMap : weaponsMap).getValue(Number(id));
    arr.splice(at, 1);
    if (typeof debugForgetWS === 'function') debugForgetWS(kind, id);
    save();
    return { ok: true, kind, id: Number(id), name: def ? def.name : String(id), total: ownedWSCount(), limit: wsLimit() };
  }
  const setWeapon = (id, level) => setWS('weapon', id, level);
  const setSkill = (id, level) => setWS('skill', id, level);
  const forgetWeapon = (id) => forgetWS('weapon', id);
  const forgetSkill = (id) => forgetWS('skill', id);

  function wsLimit() { return GData.wsLimit(S.level); }
  function ownedWSCount() { return S.weapons.length + S.skills.filter(s => Number(String(s).split(':')[0]) !== MASTER_SKILL_ID).length; }


  // 原版 `getNeed(level)` 直接读 upgradeMap 的 `coin` / `book`：
  // `UPGRADE_COIN` 只留给旧存档/旧调用方兜底，正常路径一律用行内 coin。
  const UPGRADE_COIN = 50;

  const UPGRADE_FAIL_BONUS = 2;

  // 成功率沿用原表 upgradeMap 的第 10~14 行：100% / 8% / 5% / 4% / 3%
  // （`showWeaponSkill3` → `upgradeWeapon(...,3,1)` 的 standard 路径）。
  // 参考里的 U 点升阶是另一条入口（`showWeaponSkill4` → `upgradeWeapon(...,3,2)`），
  const TRUE_SKILL_MAX_LEVEL = 15;
  const isTrueLevel = (level) => (Number(level) || 0) >= 10;
  const upgradeFailKey = (kind, id) => (kind === 'weapon' ? 'w' : 's') + Number(id);
  // 旧存档里的失败计数；只在普通 1~9 级升级时使用（真化线不读）。
  function upgradeFails(kind, id) {
    const m = object(S) && object(S.upgradeFails) ? S.upgradeFails : {};
    return Math.max(0, integer(m[upgradeFailKey(kind, id)], 0));
  }

  const upgradeRate = (baseRate, fails) =>
    Math.min(100, Math.max(0, integer(baseRate, 0)) + Math.max(0, integer(fails, 0)) * UPGRADE_FAIL_BONUS);
  function upgradeInfo(kind, id) {
    if (kind !== 'weapon' && kind !== 'skill') return null;
    id = Number(id);
    const list = kind === 'weapon' ? myWeapons() : mySkills();
    const it = list.find((x) => x.id === id);
    if (!it) return null;
    if (kind === 'skill' && [6, 13].includes(id)) return { max: true, fixed: true, item: it, msg: '该技能不能升级' };
    if (it.level >= TRUE_SKILL_MAX_LEVEL) return { max: true, item: it, msg: kind === 'weapon' ? '神器已达到真5上限' : '技能已达到真5上限' };
    const row = upgradeMap.getValue(it.level);
    if (!row) return { max: true };
    const baseRate = parseInt(row.rate);
    const isTrue = isTrueLevel(it.level);
    const fails = isTrue ? 0 : upgradeFails(kind, id);
    return {
      max: false, item: it, baseRate, fails, isTrue,
      rate: upgradeRate(baseRate, fails),
      coin: parseInt(row.coin) || UPGRADE_COIN,
      book: parseInt(row.book) || 0,
      levelLimit: parseInt(row.levelLimit),
      bookId: kind === 'weapon' ? 22 : 21,
    };
  }
  function doUpgrade(kind, id) {
    id = Number(id);
    const info = upgradeInfo(kind, id);
    if (!info || info.max) return { ok: false, msg: info && info.msg || '已经是最高等级了！' };
    if (!debugOn('freeUpgrade')) {
      if (S.level < info.levelLimit) return { ok: false, msg: `需要玩家等级达到${info.levelLimit}级` };
      if (S.goldPoint < info.coin) return { ok: false, msg: '金松果不足！' };
      if ((S.props[info.bookId] || 0) < info.book) return { ok: false, msg: (kind === 'weapon' ? '武器' : '技能') + '卷轴不足！' };
      S.goldPoint -= info.coin;
      if (info.book > 0) S.props[info.bookId] -= info.book;
    }

    bumpDaily('upgrade', 1, true);
    const ok = debugOn('noUpgradeFail') ? true : Math.random() * 100 < info.rate;
    if (!object(S.upgradeFails)) S.upgradeFails = {};
    const failKey = upgradeFailKey(kind, id);
    if (ok) {
      const arr = kind === 'weapon' ? S.weapons : S.skills;
      for (let i = 0; i < arr.length; i++) {
        const [wid, lv] = arr[i].split(':').map(Number);
        if (wid === id) { arr[i] = wid + ':' + (lv + 1); break; }
      }
      delete S.upgradeFails[failKey];
    } else if (!info.isTrue) {
      S.upgradeFails[failKey] = Math.min(999, info.fails + 1);
    }
    save();
    const nextRate = ok ? null : upgradeRate(info.baseRate, info.fails + 1);
    return {
      ok, rate: info.rate, fails: ok ? 0 : info.fails + 1, nextRate, isTrue: !!info.isTrue,
      msg: ok ? (info.isTrue ? '升阶成功。' : '升级成功。')
        : (info.isTrue ? '升阶失败：继续加油吧。'
          : '升级失败：继续加油吧。' + (nextRate ? '（下次成功率 ' + nextRate + '%）' : '')),
    };
  }


  let gearKeySeq = 1;
  // 旧档/网页版 32「龟甲术N%几率抵挡2次」在 ssfight 表里已改为 44「龟甲术防降属性效果+N%」；
  // 读档时按同星级迁移，避免旧装备的词条被 normalize 直接丢掉。
  const LEGACY_EXT_ID = Object.freeze({ 32: 44 });
  function normalizeExt(ext) {
    const out = [], seen = new Map();
    for (const e of (Array.isArray(ext) ? ext : [])) {
      if (!object(e)) continue;
      const id = LEGACY_EXT_ID[Number(e.id)] || Number(e.id);
      if (!attachmentMap.getValue(id)) continue;
      const level = Math.min(3, integer(e.level, 1, 1));
      const prev = seen.get(id);
      // 同名词条只留一条（取最高星）：战斗侧本来就按 id 取最大值，重复条目只会让详情页
      // 多出一行「+40% / +10%」；旧档和融合产物都在这里收口。
      if (prev) { if (level > prev.level) prev.level = level; continue; }
      const entry = { id, level };
      seen.set(id, entry);
      out.push(entry);
    }
    return out;
  }
  // 旧橙装是「紫装 id + orange:true」的实例级模拟；107 起 q4 行已按原版补齐。
  // 必须在 gearMap 过滤前执行，否则 q4 id 还不在 map 里会被丢掉。
  let orangeGearLookupCache = null;
  function orangeGearLookup() {
    if (orangeGearLookupCache) return orangeGearLookupCache;
    orangeGearLookupCache = new Map();
    try {
      gearMap.each((k, v) => {
        const set = gearSetMap.getValue(v.setId);
        if (set && Number(set.quality) === 4) orangeGearLookupCache.set(String(v.name) + '|' + Number(v.type), Number(k));
      });
    } catch (e) {}
    return orangeGearLookupCache;
  }
  function migrateLegacyOrangeGear(g) {
    if (!object(g) || g.orange !== true) return g;
    const old = gearInst(g.id);
    if (!old) return g;
    const target = orangeGearLookup().get(String(old.name) + '|' + Number(old.type));
    if (!target) return g;
    return Object.assign({}, g, { id: target, attr: gearBaseAttr(target), orange: undefined });
  }

  function gearBaseAttr(id) {
    const table = (typeof GData !== 'undefined' && GData && GData.GEAR_BASE_ATTR) || null;
    const hit = table ? table[Number(id)] : undefined;
    if (Number.isFinite(hit)) return hit;
    const g = gearMap.getValue(id);
    return g ? parseInt(g.abilities.split(',')[parseInt(g.type)]) || 0 : 0;
  }
  // 每件装备的主属性带 ±5% 的小幅随机：产出时（掉落/碎片合成/融合/商店）roll 一次写进实例，
  // 所以同名装备的数值不再完全一样。老档没有 attr 字段时按基准值算。
  // ⚠ 2026-10 用户口径：经典界面也重新启用这条随机（此前为了对齐原版 equipsArray 关掉了），
  const GEAR_ATTR_JITTER = 0.05;
  function rollGearAttr(id) {
    const base = gearBaseAttr(id);
    if (!base) return 0;
    const factor = 1 - GEAR_ATTR_JITTER + Math.random() * GEAR_ATTR_JITTER * 2;
    return Math.max(1, Math.round(base * factor));
  }
  function gearInst(id, ext, attr) {
    const g = gearMap.getValue(id);
    if (!g) return null;
    const set = gearSetMap.getValue(g.setId);
    const type = parseInt(g.type);
    const base = gearBaseAttr(id);
    const rolled = attr == null ? base : integer(attr, base, 0) || base;
    const abilityVal = rolled > 0 ? rolled : base;
    const attrName = ['敏捷', '力量', '生命', '速度'][type];
    const quality = parseInt(set ? set.quality : 0);
    // 穿戴装备的最低门槛统一为 5 级（2026-10 用户把「更换装备」从 10 级下调到 5 级；
    // 新手 5 级教程送的白装必须能当场穿上）；高品质装备原有的 25/30/50/60 使用等级继续保留。
    const setLevel = parseInt(set ? set.level : 1);
    return {
      id: parseInt(id), name: g.name, type, attrName, abilityVal, attrBase: base, quality,
      useLevel: quality === 0 ? 5 : Math.max(5, Number.isFinite(setLevel) ? setLevel : 5),
      price: parseInt(set ? set.price : 10),
      setId: parseInt(g.setId), ext: normalizeExt(ext),
    };
  }
  function myGears() {
    return S.gears.map((g) => {
      const info = gearInst(g.id, g.ext, g.attr);
      if (!info) return null;
      const out = Object.assign(info, { used: g.used, key: g.key });
      if (g.orange === true) { out.orange = true; out.quality = 4; }   // 兼容旧档的实例级橙标记
      if (g.gem && gemLevel(g.gem.id)) out.gem = { id: Number(g.gem.id), units: gemUnitsForGear(g) };
      return out;
    }).filter(Boolean).filter((g) => blackGearEnabled() || Number(g.quality) !== 5);
  }

  function gearAttrText(gear, opts) {
    if (!gear) return '';
    const value = Math.max(0, Math.round(Number(gear.abilityVal) || 0));
    const rawPct = Number(gear.attrPct);
    const hasPct = Number.isFinite(rawPct);
    const pct = hasPct ? Math.max(-99, Math.min(99, Math.round(rawPct))) : 0;
    const body = pct
      ? value + '(' + (pct >= 0 ? '+' : '-') + Math.abs(pct) + '%)'
      : String(value);
    if (!(opts && opts.name)) return body;
    return (gear.attrName ? gear.attrName + ' ' : '') + body;
  }
  function wear(gearKey) {
    const g = S.gears.find((x) => x.key === gearKey);
    if (!g) return false;
    if (!blackGearEnabled() && isBlackGearId(g.id)) return false;
    const gi = gearInst(g.id);
    if (!gi || S.level < gi.useLevel) return false;
    for (const o of S.gears) if (o.used && gearInst(o.id) && gearInst(o.id).type === gi.type) o.used = false;
    g.used = true; save(); return true;
  }
  function unwear(gearKey) {
    const g = S.gears.find((x) => x.key === gearKey);
    if (g) { g.used = false; save(); }
  }

  const GEAR_SELL_RANGE = Object.freeze([[50, 60], [65, 75], [75, 85], [95, 105], [190, 210], [550, 650]]);
  // 1.0.70 及更早客户端本地预测用这组旧区间；服务端一参路径必须回同一中点，否则每次出售都会触发整档重同步。
  const LEGACY_GEAR_SELL_RANGE = Object.freeze([[55, 60], [60, 65], [65, 70], [90, 110], [180, 220], [500, 700]]);
  const gearSellRange = (quality) => GEAR_SELL_RANGE[Math.max(0, Math.min(GEAR_SELL_RANGE.length - 1, integer(quality, 0)))] || GEAR_SELL_RANGE[0];
  const gearSellPrice = (quality) => { const [lo, hi] = gearSellRange(quality); return lo + Math.floor(Math.random() * (hi - lo + 1)); };

  function gearQuality(gear) { return gear && gear.orange === true ? 4 : (gearInst(gear.id) || {}).quality || 0; }

  function starEnabled() { return slotMode() !== 'classic'; }

  function toggleGearStar(gearKey) {
    if (!starEnabled()) return { ok: false, starred: false, msg: '经典模式没有星标' };
    const g = S.gears.find((x) => x.key === gearKey);
    if (!g) return { ok: false, msg: '装备不存在' };
    g.starred = g.starred !== true;
    save();
    return { ok: true, starred: g.starred === true,
      msg: g.starred ? '已加星标：不会被误融合或误出售' : '已取消星标' };
  }
  function isGearStarred(gear) {
    if (!starEnabled() || !gear) return false;
    if (gear.starred === true) return true;
    const key = gear.key;
    if (!key) return false;
    const g = (S.gears || []).find((x) => x.key === key);
    return !!(g && g.starred === true);
  }
  function sellGear(gearKey, randomPrice) {
    const i = S.gears.findIndex((x) => x.key === gearKey);
    if (i < 0) return 0;

    if (isGearStarred(S.gears[i])) return 0;
    // 旧客户端只传 key：返回区间中点，保证 sync 预测与服务端一致。
    // 新客户端传 true：由服务端掷随机价，页面必须走 StateCall，不能本地预测。
    const quality = gearQuality(S.gears[i]);
    const legacy = LEGACY_GEAR_SELL_RANGE[Math.max(0, Math.min(LEGACY_GEAR_SELL_RANGE.length - 1, quality))] || LEGACY_GEAR_SELL_RANGE[0];
    const gold = randomPrice === true
      ? gearSellPrice(quality)
      : Math.max(1, Math.floor((legacy[0] + legacy[1]) / 2));
    S.gears.splice(i, 1);
    addGold(gold); save();
    return gold;
  }
  // 「更换装备」页的展示顺序：穿着中 > 星标（仅现代） > 获得顺序。
  // 经典模式星标已整体移除，等价于「穿着中 > 获得顺序」。
  function gearsInDisplayOrder(list) {
    const src = Array.isArray(list) ? list : myGears();
    return src
      .map((gear, index) => ({ gear, index, rank: (gear.used ? 0 : 2) + (isGearStarred(gear) ? 0 : 1) }))
      .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
      .map((item) => item.gear);
  }

  const PROP_SELL_OVERRIDES = Object.freeze({
    48: 100,
    21: 2,
    22: 2,
  });
  const MIN_SELL_PRICE = 2;

  const BIG_ENERGY_ID = 2;
  const BIG_ENERGY_PRICE = ONLINE_RULES ? 5 : 6;
  (function applyShopPriceTuning() {
    const item = propMap && propMap.getValue ? propMap.getValue(BIG_ENERGY_ID) : null;
    if (!item) return;
    item.price = String(BIG_ENERGY_PRICE);
    if (Array.isArray(item.source) && item.source.length > 3) item.source[3] = String(BIG_ENERGY_PRICE);
  })();
  function propSellPrice(id) {
    id = Number(id);
    if (BAG_CURRENCY_PROP[id]) return 0;              // 货币类（金杯）不能卖
    // 联机版转化丸只用于转属性：允许卖 120 金会把「10 片 + 50 金」变成无上限套利。
    if (ONLINE_RULES && (GData.CONVERT_PILLS || []).includes(id)) return 0;
    if (PROP_SELL_OVERRIDES[id] != null) return PROP_SELL_OVERRIDES[id];
    const item = propMap.getValue(id);
    const price = item ? Math.max(0, Math.floor(Number(item.price) || 0)) : 0;
    return price >= MIN_SELL_PRICE ? Math.max(1, Math.floor(price / 2)) : 0;
  }
  // 背包里的「货币类显示项」：金杯（40）在原版就是货币字段 `S.goldCup`，不进 `S.props`
  // 背包里照样列出它、数量直接读货币字段（只有一个真值来源，不会出现两处对不上），
  // 但不能卖也不能使用 —— 卖价 0，动作按钮只走「查看」。
  const BAG_CURRENCY_PROP = Object.freeze({ 40: 'goldCup' });
  function isBagCurrencyProp(id) { return !!BAG_CURRENCY_PROP[Number(id)]; }
  // 背包/详情里显示的持有量：货币类读货币字段，其余读 `S.props`。
  function bagCountOf(id) {
    id = Number(id);
    const field = BAG_CURRENCY_PROP[id];
    if (field) return Math.max(0, integer(S[field], 0));
    return Math.max(0, integer(S.props[id], 0));
  }

  function sellableProps() {
    const ids = [];
    propMap.each((id) => { if (propSellPrice(id)) ids.push(Number(id)); });
    return ids.sort((a, b) => a - b);
  }

  function sellProp(id, count) {
    id = Number(id);
    const price = propSellPrice(id);
    if (!price) return { ok: false, msg: '这个道具不能卖' };
    const held = S.props[id] || 0;
    if (held < 1) return { ok: false, msg: '背包里没有这个道具' };
    const n = Math.max(1, Math.min(held, Math.round(Number(count) || 1)));
    S.props[id] = held - n;
    if (S.props[id] <= 0) {
      delete S.props[id];

      if ((id === 47 || id === 48) && S.fruitChoices) delete S.fruitChoices[id];
    }
    const gold = price * n;
    addGold(gold);
    bumpDaily('sell', n, true);
    save();
    const item = propMap.getValue(id);
    return { ok: true, sold: n, gold, price, msg: '卖出 ' + (item ? item.name : '道具') + ' ×' + n + '，获得 ' + gold + ' 金松果' };
  }

  function gemLevel(id) { id = Number(id); return id >= 101 && id <= 107 ? id - 100 : 0; }

  function gemPercent(lv) { lv = integer(lv, 0, 0); return lv > 0 ? 5 * (lv * lv - lv + 2) : 0; }
  function gemAffixTotal(lv) { lv = integer(lv, 0, 0); return lv > 0 ? GEM_AFFIX_TOTALS[Math.min(7, lv) - 1] : 0; }
  // 原版镶嵌结果随机：总档逐个掷到某条词条上，单条到 12 档后不再接；
  // 抓包实证 5 级 8+8+1 / 8+2+7 = 17，7 级 11+11+8 = 30。
  function rollGemAffixUnits(lv, count) {
    count = Math.max(0, Math.min(3, integer(count, 0, 0)));
    const units = new Array(count).fill(0);
    let left = gemAffixTotal(lv);
    while (left > 0) {
      const open = [];
      for (let i = 0; i < count; i++) if (units[i] < GEM_AFFIX_CAP) open.push(i);
      if (!open.length) break;
      units[open[Math.floor(Math.random() * open.length)]] += 1;
      left -= 1;
    }
    return units;
  }
  // 旧档没有 units：按总档平均分（7 级 3 条 = 10/10/10），保证读档后总量仍是原版。
  function evenGemAffixUnits(lv, count) {
    count = Math.max(0, Math.min(3, integer(count, 0, 0)));
    const units = new Array(count).fill(0);
    if (!count) return units;
    let left = gemAffixTotal(lv);
    for (let i = 0; left > 0 && i < 1024; i++) {
      const slot = i % count;
      if (units[slot] < GEM_AFFIX_CAP) { units[slot] += 1; left -= 1; }
    }
    return units;
  }
  function normalizeGemUnits(units, ext, lv) {
    const count = Math.max(0, Math.min(3, Array.isArray(ext) ? ext.length : 0));
    if (!count) return [];
    const total = gemAffixTotal(lv);
    if (Array.isArray(units) && units.length === count) {
      const clean = units.map((u) => integer(u, 0, 0));
      if (clean.every((u) => u <= GEM_AFFIX_CAP) && clean.reduce((a, b) => a + b, 0) <= total) return clean;
    }
    return evenGemAffixUnits(lv, count);
  }
  function gemUnitsForGear(gear) {
    const lv = gemLevel(gear && gear.gem && gear.gem.id);
    return normalizeGemUnits(gear && gear.gem && gear.gem.units, normalizeExt(gear && gear.ext), lv);
  }

  function attachmentValue(id, star, units) {
    const def = attachmentMap.getValue(Number(id));
    if (!def) return { base: 0, extra: 0, total: 0 };
    const abilities = String(def.ability || '').split(',').map(Number);
    const extras = String(def.extra || '').split(',').map(Number);
    const starIdx = Math.max(0, Math.min(abilities.length - 1, (Number(star) || 1) - 1));
    const base = Number(abilities[starIdx]) || 0;
    const unitIdx = (Number(units) || 0) - 1;
    const extra = unitIdx >= 0 && unitIdx < extras.length ? (Number(extras[unitIdx]) || 0) : 0;
    return { base, extra, total: base + extra };
  }

  const gemMergeRate = (lv) => Math.pow(0.88, Math.max(1, Math.min(6, integer(lv, 1, 1))));

  function rollGemDrop(chancePct) {
    if (S.level < 45 || Math.random() * 100 >= chancePct) return null;
    const id = Math.random() < 0.25 ? 102 : 101;
    S.props[id] = (S.props[id] || 0) + 1;
    return { id, name: propMap.getValue(id).name };
  }

  function mergeGems(id) {
    id = Number(id);
    const lv = gemLevel(id);
    if (!lv) return { ok: false, msg: '请选择宝石' };
    if (lv >= 7) return { ok: false, msg: '七级宝石已是最高等级' };
    if ((S.props[id] || 0) < 3) return { ok: false, msg: '需要 3 个同级宝石' };
    if (S.goldPoint < 10) return { ok: false, msg: '金松果不足 10 个' };
    S.props[id] -= 3; S.goldPoint -= 10;
    bumpDaily('gem', 1, true);
    if (Math.random() < gemMergeRate(lv)) {
      S.props[id + 1] = (S.props[id + 1] || 0) + 1;
      save();
      return { ok: true, success: true, msg: '合成成功：' + propMap.getValue(id + 1).name + ' ×1' };
    }
    if (Math.random() < 0.5) {
      if (lv > 1) S.props[id - 1] = (S.props[id - 1] || 0) + 1;
      save();
      return { ok: true, success: false, msg: lv > 1 ? '合成失败！一颗宝石降为 ' + propMap.getValue(id - 1).name : '合成失败！一颗宝石碎裂了' };
    }
    save();
    return { ok: true, success: false, msg: '合成失败，宝石没有变化' };
  }


  const GEM_SOCKET_COST = 0;
  const GEM_UNSOCKET_COST = 5;
  function socketGem(gearKey, gemId) {
    const g = S.gears.find((x) => x.key === gearKey);
    if (!g) return { ok: false, msg: '装备不存在' };
    if (!canSocketGem(g)) return { ok: false, msg: '只有橙色（传说）或黑色装备可以镶嵌宝石' };
    if (g.gem) return { ok: false, msg: '每件装备最多镶嵌 1 颗宝石，请先卸下原有宝石' };
    const lv = gemLevel(gemId);
    if (!lv || !(S.props[gemId] > 0)) return { ok: false, msg: '没有该宝石' };
    S.props[gemId]--;
    const ext = normalizeExt(g.ext);
    const units = rollGemAffixUnits(lv, ext.length);
    g.gem = { id: Number(gemId), units };
    const first = ext[0];
    const firstDef = first ? attachmentMap.getValue(first.id) : null;
    const firstVal = first ? attachmentValue(first.id, first.level, units[0] || 0) : null;
    const sample = firstDef && firstVal ? '，' + firstDef.name.replace('N', String(firstVal.total)) : '';
    const total = gemAffixTotal(lv), applied = units.reduce((a, b) => a + b, 0);
    const detail = !units.length ? '该装备没有附加属性，档数无法分配'
      : (applied === total ? units.join('/') : '本件可分 ' + applied + ' 档：' + units.join('/') + '；总 ' + total + ' 档');
    save();
    return { ok: true, msg: propMap.getValue(gemId).name + ' 镶嵌成功（免费）：主属性 +' + gemPercent(lv) + '%，附加属性 +' + applied + ' 档（' + detail + '）' + sample };
  }
  function unsocketGem(gearKey) {
    const g = S.gears.find((x) => x.key === gearKey);
    if (!g || !g.gem) return { ok: false, msg: '该装备没有镶嵌宝石' };
    if (S.goldPoint < GEM_UNSOCKET_COST) return { ok: false, msg: '卸下需要 ' + GEM_UNSOCKET_COST + ' 金松果' };
    S.goldPoint -= GEM_UNSOCKET_COST;
    S.props[g.gem.id] = (S.props[g.gem.id] || 0) + 1;
    delete g.gem;
    save();
    return { ok: true, msg: '已卸下宝石（−' + GEM_UNSOCKET_COST + ' 金松果），宝石放回背包' };
  }


  const GEAR_COST_BY_QUALITY = Object.freeze([30, 40, 50, 60, 200, 1000]);
  // 联机融合价单独一档：普通/优秀/杰出/卓越/传说/黑色。
  const ONLINE_FUSION_COST_BY_QUALITY = Object.freeze([30, 40, 50, 100, 200, 200]);
  const gearCostOf = (quality) => GEAR_COST_BY_QUALITY[
    Math.max(0, Math.min(GEAR_COST_BY_QUALITY.length - 1, integer(quality, 0)))] || GEAR_COST_BY_QUALITY[0];
  // 融合一次的费用 —— 唯一真值。页面（原版融合页 / DOM 融合页）必须读它；
  // 联机 30/40/50/100/200/200，单机沿用 GEAR_COST_BY_QUALITY。
  function fusionCostOf(quality) {
    const table = ONLINE_RULES ? ONLINE_FUSION_COST_BY_QUALITY : GEAR_COST_BY_QUALITY;
    return table[Math.max(0, Math.min(table.length - 1, integer(quality, 0)))] || table[0];
  }

  function composeGear(propId) {
    propId = Number(propId);
    if (S.gears.length >= gearCapacity()) return { ok: false, msg: '装备已满（' + S.gears.length + '/' + gearCapacity() + '），先卖掉或融合几件' };
    const blackSet = (typeof GData !== 'undefined' && GData.BLACK_SHARD_SET) ? Number(GData.BLACK_SHARD_SET[propId]) : 0;
    if (blackSet) {
      if (!blackGearEnabled()) return { ok: false, msg: '现代界面没有黑装内容' };
      if ((S.props[propId] || 0) < 10) return { ok: false, msg: '碎片不足10个！' };
      const cost = gearCostOf(5);
      if (S.goldPoint < cost) return { ok: false, msg: '金松果不足' + cost + '！' };
      const ids = [];
      gearMap.each((k, v) => { if (Number(v.setId) === blackSet) ids.push(Number(v.id)); });
      if (ids.length !== 4) return { ok: false, msg: '黑装数据不完整' };

      const typeOf = (id) => Number((gearMap.getValue(id) || {}).type);
      const owned = new Set((S.gears || []).filter((g) => ids.includes(Number(g.id))).map((g) => typeOf(g.id)));
      let gid = ids[Math.floor(Math.random() * ids.length)];
      if (owned.size < 4) {
        for (let tries = 0; tries < 2 && owned.has(typeOf(gid)); tries++) {
          gid = ids[Math.floor(Math.random() * ids.length)];
        }
        if (owned.has(typeOf(gid))) {
          const missing = ids.filter((id) => !owned.has(typeOf(id)));
          if (missing.length) gid = missing[Math.floor(Math.random() * missing.length)];
        }
      }
      S.props[propId] -= 10;
      if (S.props[propId] <= 0) delete S.props[propId];
      S.goldPoint -= cost;
      const g = addGear(gid, randomExtForQuality(5));
      if (!g) {
        S.props[propId] = (S.props[propId] || 0) + 10;
        S.goldPoint += cost;
        save();
        return { ok: false, msg: '合成失败：装备数据异常，材料已退回' };
      }
      bumpDaily('merge', 1, true);
      save();
      return { ok: true, gear: g };
    }
    if (![24, 25, 26].includes(propId)) return { ok: false, msg: '请选择装备碎片' };
    if ((S.props[propId] || 0) < 10) return { ok: false, msg: '碎片不足10个！' };
    const quality = { 24: 0, 25: 1, 26: 2 }[propId];
    const cost = gearCostOf(quality);
    if (S.goldPoint < cost) return { ok: false, msg: '金松果不足' + cost + '！' };
    const candidates = [];
    gearSetMap.each((k, v) => { if (parseInt(v.quality) === quality) candidates.push(parseInt(v.id)); });
    if (!candidates.length) return { ok: false, msg: '装备数据异常，请稍后再试' };
    const setId = candidates[Math.floor(Math.random() * candidates.length)];
    const gearsOfSet = [];
    gearMap.each((k, v) => { if (parseInt(v.setId) === setId) gearsOfSet.push(parseInt(v.id)); });
    if (!gearsOfSet.length) return { ok: false, msg: '装备数据异常，请稍后再试' };
    const gid = gearsOfSet[Math.floor(Math.random() * gearsOfSet.length)];
    S.props[propId] -= 10; S.goldPoint -= cost;
    const g = addGear(gid, randomExtForQuality(quality));
    if (!g) {
      S.props[propId] = (S.props[propId] || 0) + 10;
      S.goldPoint += cost;
      save();
      return { ok: false, msg: '合成失败：装备数据异常，材料已退回' };
    }
    bumpDaily('merge', 1, true);
    save();
    return { ok: true, gear: g };
  }
  function gearPart(id) {
    const def = gearMap.getValue(id);
    return def ? Number(def.type) : -1;
  }
  // 把一份对手穿戴表规整成 `[{id, ext, type}]`（`type` 缺失时按装备字典反查）。
  // 原版这些都由服务端下发；复刻的 `genAI` 抽出来的装备没有 `type`，
  function normalizeFoeGears(list) {
    return (Array.isArray(list) ? list : []).map((g) => {
      const id = Number(g && g.id != null ? g.id : g);
      if (!Number.isFinite(id) || id <= 0) return null;
      const out = {
        id: id,
        ext: Array.isArray(g && g.ext) ? g.ext.slice(0, 3) : [],
        attr: g && g.attr ? g.attr : undefined,
        type: g && g.type != null ? Number(g.type) : gearPart(id),
      };
      // 橙装与宝石是实例级字段（同 id 的紫装不是橙装）；好友/师徒快照也要带过去，
      // 否则挑战页立绘、查看装备、切磋时的装备品质会退回紫装。
      if (g && g.orange === true) out.orange = true;
      const gemLv = g && g.gem && gemLevel(g.gem.id);
      if (gemLv) out.gem = { id: 100 + gemLv, units: normalizeGemUnits(g.gem.units, normalizeExt(out.ext), gemLv) };
      return out;
    }).filter(Boolean);
  }
  function gearPartQuality(id) {
    const def = gearMap.getValue(id);
    const set = def ? gearSetMap.getValue(parseInt(def.setId)) : null;
    return set ? parseInt(set.quality) : -1;
  }

  function gearIdsOf(part, quality) {
    const out = [];
    gearMap.each((k, v) => { if (Number(v.type) === Number(part) && gearPartQuality(parseInt(v.id)) === Number(quality)) out.push(parseInt(v.id)); });
    return out;
  }
  function gearName(id) { const d = gearMap.getValue(id); return d ? d.name : ''; }
  function gearSetOf(id) { const d = gearMap.getValue(id); return d ? parseInt(d.setId) : -1; }


  const GEAR_PART_SUFFIX = /(头巾|头饰|头盔|护额|手套|拳套|拳甲|服|铠甲|衣服|鞋|短靴)$/;
  function gearSetFamily(id) {
    const d = gearMap.getValue(id);
    return d ? String(d.name).replace(GEAR_PART_SUFFIX, '') : '';
  }

  const FUSION_SAME_NAME_RATE = { 2: 0.50, 3: 0.97 };
  const FUSION_MUTANT_RATE = { 2: 0.03, 3: 0.03 };
  // 变异池按目标品质分组：48/49 深海·机器猫 q3，51 狂战 q3；
  // 45 怒战 q4，50/53 深海·机器猫 q4，52 狂战 q4；67~70 黑装四套。
  const FUSION_MUTANT_SETS = Object.freeze([48, 49, 51]);
  const FUSION_ORANGE_MUTANT_SETS = Object.freeze([45, 50, 52, 53]);
  const FUSION_BLACK_MUTANT_SETS = Object.freeze([67, 68, 69, 70]);
  // 兼容旧导出；新逻辑只读上面的数组。
  const FUSION_MUTANT_SET = 51;
  const FUSION_ORANGE_MUTANT_SET = 52;
  const fusionMutantSets = (quality) => Number(quality) === 5 ? FUSION_BLACK_MUTANT_SETS
    : Number(quality) === 4 ? FUSION_ORANGE_MUTANT_SETS : FUSION_MUTANT_SETS;
  // · 继承后仍按 50% 概率升 1 星（上限 3 星）。
  // 此时产物会保留全部必继承条目 —— 这是用户“一定继承”的硬要求，不能为了槽位数丢掉词条。
  const FUSION_EXT_INHERIT_RATE = 0.5;
  const FUSION_EXT_UPGRADE_RATE = 0.5;
  const FUSION_EXT_MAX_LEVEL = 3;

  const FUSION_EXT_SLOTS = { 1: 0, 2: 1, 3: 2, 4: 3 };
  const fusionSlots = (quality) => FUSION_EXT_SLOTS[Math.max(0, Math.min(4, integer(quality, 0)))] || 0;
  // 按目标品质随机生成词条（蓝 1 条 ≤2 星、紫/橙 2~3 条；`maxLevel` 供征战按首领压低词条星级）。
  function randomExtForQuality(quality, maxLevel) {
    const slots = fusionSlots(quality);
    const cap = Number(maxLevel) > 0 ? Math.min(3, Number(maxLevel)) : (quality >= 3 ? 3 : 2);
    return slots ? randomExt(slots, cap) : [];
  }
  // 融合产物的词条：
  // ② 剩余槽位再按 50% 概率从材料池继承，否则随机补一条；
  function mergeExt(gs, targetQuality) {
    const slots = fusionSlots(targetQuality);
    if (!slots) return [];
    if (ONLINE_RULES) {

      const sharedCounts = new Map(), sharedLevels = new Map();
      for (const g of gs) {
        const seen = new Set();
        for (const e of normalizeExt(g.ext)) {
          const id = Number(e.id);
          sharedLevels.set(id, Math.max(sharedLevels.get(id) || 0, Number(e.level) || 1));
          if (seen.has(id)) continue;
          seen.add(id);
          sharedCounts.set(id, (sharedCounts.get(id) || 0) + 1);
        }
      }
      const shared = [...sharedCounts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
      // 隐藏机制：黑装产物（3 橙→黑 / 3 黑→黑）在材料恰好有 4 个共有词条时，
      // 允许突破 3 槽生成 4 词条；其余情况仍按槽位封顶。帮助页不写这条。
      if (targetQuality === 5 && shared.length === 4) {
        return shared.map((id) => {
          let level = sharedLevels.get(id) || 1;
          if (level < FUSION_EXT_MAX_LEVEL && Math.random() < FUSION_EXT_UPGRADE_RATE) level += 1;
          return { id, level };
        });
      }
      if (shared.length > slots) {
        const out = [], rest = shared.slice();
        while (out.length < slots && rest.length) {
          const at = Math.floor(Math.random() * rest.length);
          const id = rest.splice(at, 1)[0];
          let level = sharedLevels.get(id) || 1;
          if (level < FUSION_EXT_MAX_LEVEL && Math.random() < FUSION_EXT_UPGRADE_RATE) level += 1;
          out.push({ id, level });
        }
        return out;
      }
      // 同一词条可能来自多件材料：先按 id 取最高星、只留第一次出现的位置，再按星级/材料
      // 顺序排；否则前两条会取到同一个词条，产物出现两行同名（+40% / +10%）。
      const best = new Map();
      let order = 0;
      for (const g of gs) {
        for (const entry of normalizeExt(g.ext)) {
          const id = Number(entry.id);
          const cur = best.get(id);
          if (!cur) best.set(id, { id, level: entry.level, index: order++ });
          else if (entry.level > cur.level) cur.level = entry.level;
        }
      }
      const ordered = [...best.values()].sort((a, b) => b.level - a.level || a.index - b.index);
      const inherit = entry => ({ id: entry.id, level: entry.level < 3 && Math.random() < FUSION_EXT_UPGRADE_RATE ? entry.level + 1 : entry.level });
      const first = ordered.slice(0, Math.min(2, slots));
      const out = first.map(inherit);
      const selected = new Set(first.map(e => e.index));
      const remaining = ordered.filter(e => !selected.has(e.index));
      const used = new Set(out.map(e => Number(e.id)));
      while (out.length < slots) {
        if (remaining.length) {
          const picked = remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0];
          out.push(inherit(picked)); used.add(Number(picked.id));
        } else {
          const [extra] = randomExt(1, 1, used);
          if (!extra) break;
          out.push(inherit(extra)); used.add(Number(extra.id));
        }
      }
      return out;
    }
    const level = new Map(), counts = new Map(), pool = [];
    for (const g of gs) {
      const seen = new Set();
      for (const e of normalizeExt(g.ext)) {
        const id = Number(e.id);
        level.set(id, Math.max(level.get(id) || 0, e.level));
        if (seen.has(id)) continue;
        seen.add(id);
        counts.set(id, (counts.get(id) || 0) + 1);
        pool.push(id);
      }
    }
    const inherit = (id) => {
      let lv = level.get(id) || 1;
      if (lv < FUSION_EXT_MAX_LEVEL && Math.random() < FUSION_EXT_UPGRADE_RATE) lv += 1;
      return { id, level: lv };
    };
    const out = [], used = new Set();

    const must = [...counts.entries()].filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || (level.get(b[0]) || 0) - (level.get(a[0]) || 0))
      .map(([id]) => id);
    for (const id of must) {
      if (used.has(id)) continue;
      out.push(inherit(id));
      used.add(id);
    }
    while (out.length < slots) {
      const candidates = pool.filter((id) => !used.has(id));

      if (candidates.length && Math.random() < FUSION_EXT_INHERIT_RATE) {
        const id = candidates[Math.floor(Math.random() * candidates.length)];
        out.push(inherit(id));
        used.add(id);
        continue;
      }
      const [extra] = randomExt(1, targetQuality >= 3 ? 3 : 2, used);
      if (!extra) break;
      out.push(extra);
      used.add(Number(extra.id));
    }
    return out;
  }
  // 融合产物的目标装备。名称按「三件材料的同名情况」三选一：
  // 判定顺序 = 先掷变异、再掷保名，剩下的走随机其它；这样三段的概率就是字面值。
  // ⚠ 三件同套的保底在 `familyUpgradeTarget` 里先处理；这里只服务跨套 / 无下一档的情况。
  function pickMergeTarget(gs, part, targetQuality) {
    const pool = gearIdsOf(part, targetQuality);
    if (!pool.length) return null;
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const names = gs.map((g) => gearName(g.id));
    const dup = names.filter((n) => n === names[0]).length;
    const same = dup >= 2 ? names[0] : (names[1] === names[2] ? names[1] : null);
    if (same) {
      const hit = pool.filter((id) => gearName(id) === same);
      const mutantSets = fusionMutantSets(targetQuality);
      const mutants = pool.filter((id) => mutantSets.includes(gearSetOf(id)));
      const others = pool.filter((id) => gearName(id) !== same);
      const key = dup === 3 ? 3 : 2;
      // 只有目标品质确实有变异套件时才掷变异，否则那 3% 归到「随机其它」。
      const mutantRate = mutants.length ? Math.max(0, Number(FUSION_MUTANT_RATE[key]) || 0) : 0;
      const sameRate = Math.max(0, Number(FUSION_SAME_NAME_RATE[key]) || 0);
      const roll = Math.random();
      if (mutantRate > 0 && roll < mutantRate) return { id: pick(mutants), mutant: true };
      if (hit.length && roll < mutantRate + sameRate) return { id: pick(hit), mutant: false };
      if (others.length) return { id: pick(others), mutant: false };
      if (hit.length) return { id: pick(hit), mutant: false };
    }
    return { id: pick(pool), mutant: false };
  }
  // 「同套装」判定（融合保底用）：取该 setId 下四件装备名去掉部位后缀后的公共前缀。
  // 不能直接用 `gearSetFamily(单件)`：它按单件名去后缀，"机器猫头 / 机器猫拳" 会各自成族，
  const FUSION_PART_SUFFIXES = ['头巾', '头饰', '头盔', '护额', '拳套', '拳甲', '手套', '铠甲', '短靴', '服', '鞋', '头', '拳'];
  const FUSION_SET_FAMILY = new Map();
  function stripFusionPart(name) {
    let s = String(name == null ? '' : name);
    for (const suffix of FUSION_PART_SUFFIXES) {
      if (s.length > suffix.length && s.slice(-suffix.length) === suffix) return s.slice(0, -suffix.length);
    }
    return s;
  }

  function fusionSetFamily(setId) {
    const key = Number(setId);
    if (!Number.isFinite(key)) return '';
    if (FUSION_SET_FAMILY.has(key)) return FUSION_SET_FAMILY.get(key);
    const names = [];
    gearMap.each((k, v) => { if (Number(v.setId) === key) names.push(stripFusionPart(v.name)); });
    let family = names[0] || '';
    for (const name of names.slice(1)) {
      while (family && name.indexOf(family) !== 0) family = family.slice(0, -1);
    }
    FUSION_SET_FAMILY.set(key, family);
    return family;
  }
  // 三件同套装的融合目标：下一品质、首件材料部位、同一套装家族。
  // · 三件材料必须同属一个套装家族（狂战头盔/拳甲/铠甲 = 狂战；黑装 46/67 也算同一套）；
  function familyUpgradeTarget(gs, part, targetQuality) {
    if (!Array.isArray(gs) || gs.length !== 3) return null;
    const families = gs.map((g) => {
      const def = gearMap.getValue(g && g.id);
      return def ? fusionSetFamily(def.setId) : '';
    });
    if (!families[0] || families.some((f) => f !== families[0])) return null;
    const pool = gearIdsOf(part, targetQuality).filter((id) => {
      const def = gearMap.getValue(id);
      return def && fusionSetFamily(def.setId) === families[0];
    });
    if (!pool.length) return null;
    return { id: Math.min.apply(null, pool), mutant: false, family: families[0] };
  }
  // 融合页提示用：三件材料同套且下一品质存在该家族时返回目标信息，否则 null。
  function fusionFamilyInfo(gears) {
    if (ONLINE_RULES) return null;
    if (!Array.isArray(gears) || gears.length !== 3) return null;
    const first = gears[0];
    if (!first || !Number.isFinite(Number(first.id))) return null;
    const quality = gearQuality(first);
    if (!(quality >= 0 && quality < 5)) return null;
    if (gears.some((g) => gearQuality(g) !== quality)) return null;
    const part = gearPart(first.id);
    if (part < 0) return null;
    const target = familyUpgradeTarget(gears, part, quality + 1);
    if (!target) return null;
    return { id: target.id, family: target.family, part: part, quality: quality + 1 };
  }


  function pickBlackMergeTarget(gs, part) {
    const pool = gearIdsOf(part, 5);
    if (!pool.length) return null;
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const family = gearSetFamily(gs[0].id);
    const same = pool.filter((id) => gearSetFamily(id) === family);
    const others = pool.filter((id) => gearSetFamily(id) !== family);
    const rare = others.filter((id) => FUSION_BLACK_MUTANT_SETS.includes(gearSetOf(id)));
    const mutants = rare.length ? rare : others;
    const roll = Math.random();
    if (mutants.length && roll < 0.03) return { id: pick(mutants), mutant: true };
    if (same.length && roll < 0.73) return { id: pick(same), mutant: false };
    return { id: pick(pool), mutant: false };
  }

  function mergeGears(keys, opts) {
    if (!Array.isArray(keys) || keys.length !== 3 || new Set(keys).size !== 3) return { ok: false, msg: '请选择三件不同的装备' };
    const gs = keys.map((k) => S.gears.find((x) => x.key === k)).filter(Boolean);
    if (gs.length !== 3) return { ok: false, msg: '装备不存在' };
    if (!blackGearEnabled() && gs.some((g) => isBlackGearId(g.id))) return { ok: false, msg: '现代界面没有黑装内容' };
    if (gs.some((g) => g.used)) return { ok: false, msg: '不能融合已穿戴的装备' };

    if (gs.some((g) => isGearStarred(g))) {
      return { ok: false, msg: '有装备已加星标（防误合），先取消星标再融合' };
    }
    const q = gearQuality(gs[0]);
    const sourceGear = gs[ONLINE_RULES ? Math.floor(Math.random() * gs.length) : 0];
    const part = gearPart(sourceGear.id);
    if (part < 0) return { ok: false, msg: '装备数据异常' };
    if (gs.some((g) => gearQuality(g) !== q)) return { ok: false, msg: '需要三件同品质的装备' };
    const partName = ['头巾', '手套', '衣服', '鞋子'][part] || '装备';
    const cost = fusionCostOf(q);
    if (S.goldPoint < cost) return { ok: false, msg: '融合费用不足（需要 ' + cost + ' 金松果）' };
    if (ONLINE_RULES) {
      const targetQuality = Math.min(5, q + 1);
      const pool = gearIdsOf(part, targetQuality);
      if (!pool.length) return { ok: false, msg: '该部位没有可融合的目标装备' };
      const family = fusionSetFamily(gearSetOf(sourceGear.id));
      const inherited = pool.filter(id => fusionSetFamily(gearSetOf(id)) === family);
      const mutationSets = fusionMutantSets(targetQuality);
      const alternatives = pool.filter(id => fusionSetFamily(gearSetOf(id)) !== family);
      const special = alternatives.filter(id => mutationSets.includes(gearSetOf(id)));
      const mutants = special.length ? special : alternatives;
      const mutated = mutants.length > 0 && Math.random() < 0.02;
      const available = mutated ? mutants : (inherited.length ? inherited : pool.filter(id => !mutants.includes(id)));
      const candidates = available.length ? available : pool;
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      S.goldPoint -= cost;
      S.gears = S.gears.filter(g => !keys.includes(g.key));
      const made = addGear(id, mergeExt(gs, targetQuality));
      const card = q >= 5 && Math.random() < 0.2 ? 1 : 0;
      if (card) S.props[80] = (S.props[80] || 0) + card;
      bumpDaily('merge', 1, true);
      save();
      return { ok: true, gear: Object.assign(made || {}, { quality: targetQuality, mutant: mutated }), card };
    }
    if (q >= 5) {
      // 3 件黑装 → 同部位黑装（洗 3 条附加），20% 额外返 1 张黑色卡片。
      // 3 橙 → 黑在下面的 q===4 分支；这里只处理 3 黑洗练。
      const target = pickBlackMergeTarget(gs, part);
      if (target == null) return { ok: false, msg: '这个部位还没有可融合的黑装' + partName + '。' };
      S.goldPoint -= cost;
      S.gears = S.gears.filter((g) => !keys.includes(g.key));
      const made = addGear(target.id, mergeExt(gs, 5));
      const card = Math.random() < 0.2 ? 1 : 0;
      if (card) S.props[80] = (S.props[80] || 0) + card;
      bumpDaily('merge', 1, true);
      save();
      return { ok: true, gear: Object.assign(made || {}, { quality: 5, mutant: target.mutant }), card };
    }

    if (q === 4) {
      if (!blackGearEnabled()) return { ok: false, msg: '现代界面没有黑装内容' };

      const target = familyUpgradeTarget(gs, part, 5) || pickMergeTarget(gs, part, 5);
      if (target == null) return { ok: false, msg: '这个部位还没有可合成的黑色' + partName + '。' };
      S.goldPoint -= cost;
      S.gears = S.gears.filter((g) => !keys.includes(g.key));
      const made = addGear(target.id, mergeExt(gs, 5));
      bumpDaily('merge', 1, true);
      save();
      return { ok: true, gear: Object.assign(made || {}, { quality: 5, mutant: target.mutant }), card: 0 };
    }
    if (q === 3) {

      const target = familyUpgradeTarget(gs, part, 4) || pickMergeTarget(gs, part, 4);
      if (target == null) return { ok: false, msg: '这个部位还没有可合成的传说' + partName + '。' };
      S.goldPoint -= cost;
      S.gears = S.gears.filter((g) => !keys.includes(g.key));
      const made = addGear(target.id, mergeExt(gs, 4));
      bumpDaily('merge', 1, true);
      save();
      return { ok: true, gear: Object.assign(made || {}, { quality: 4, mutant: target.mutant }) };
    }

    const target = familyUpgradeTarget(gs, part, q + 1) || pickMergeTarget(gs, part, q + 1);
    if (target == null) return { ok: false, msg: '这个部位还没有更高品质的' + partName + '。' };
    S.goldPoint -= cost;
    S.gears = S.gears.filter((g) => !keys.includes(g.key));
    const g = addGear(target.id, mergeExt(gs, q + 1));
    bumpDaily('merge', 1, true);
    save();
    return { ok: true, gear: Object.assign(g || {}, { mutant: target.mutant }) };
  }
  function autoEnergyPotion(need) {
    const s = state();
    const deficit = Math.max(0, (Number(need) || 0) - s.energy);
    if (!deficit) return { ok: true, used: 0 };
    const order = deficit <= 10 ? [1, 2] : [2, 1];
    for (const id of order) {
      if (!(s.props[id] > 0)) continue;
      const res = useProp(id);
      if (res && res.ok) return { ok: true, used: id, msg: res.msg };
    }
    return { ok: false, msg: '体力不足，也没有体力药剂。' };
  }
  function randomExt(n, maxLevel, exclude) {
    maxLevel = Math.max(1, Math.min(3, Number(maxLevel) || 3));
    const ext = [];
    const used = new Set((exclude ? [...exclude] : []).map(Number));
    const ids = attachmentMap.keys.map(Number).filter((id) => Number.isFinite(id) && !used.has(id));
    for (let i = 0; i < n && ids.length; i++) {
      const aid = ids.splice(Math.floor(Math.random() * ids.length), 1)[0];
      ext.push({ id: aid, level: 1 + Math.floor(Math.random() * maxLevel) });
    }
    return ext;
  }

  function extText(ext, units) {
    const list = normalizeExt(ext);
    return list.map((e, i) => {
      const id = LEGACY_EXT_ID[Number(e.id)] || e.id;
      const a = attachmentMap.getValue(id);
      if (!a) return '';
      const unit = Array.isArray(units) ? (units[i] || 0) : units;
      const v = attachmentValue(id, e.level, unit);
      return a.name.replace('N', String(v.total));
    }).filter(Boolean);
  }

  function extTextForGear(gear, detail) {
    const list = normalizeExt(gear && gear.ext);
    const units = gemUnitsForGear(gear);
    return list.map((e, i) => {
      const id = LEGACY_EXT_ID[Number(e.id)] || e.id;
      const a = attachmentMap.getValue(id);
      if (!a) return '';
      const v = attachmentValue(id, e.level, units[i] || 0);
      return a.name.replace('N', String(v.total)) + (detail && v.extra > 0 ? '（基础' + v.base + '+增幅' + v.extra + '）' : '');
    }).filter(Boolean);
  }

  // 与 extText 一一对应：没有增幅也返回空串占位，状态页两列才不会错行。
  function extExtraText(ext, units) {
    const list = normalizeExt(ext);
    const listUnits = Array.isArray(units) ? units : [];
    return list.map((e, i) => {
      const id = LEGACY_EXT_ID[Number(e.id)] || e.id;
      const a = attachmentMap.getValue(id);
      if (!a) return '';
      const v = attachmentValue(id, e.level, listUnits[i] || 0);
      if (!v.extra) return '';
      const name = String(a.name || '');
      const sign = name.indexOf('-N%') >= 0 ? '-' : '+';
      const unit = name.indexOf('N点') >= 0 ? '点' : name.indexOf('N倍') >= 0 ? '倍' : '%';
      return sign + v.extra + unit;
    });
  }
  function extExtraTextForGear(gear) {
    return extExtraText(gear && gear.ext, gemUnitsForGear(gear));
  }
  function addGear(id, ext, attr) {
    if (!blackGearEnabled() && isBlackGearId(id)) return null;
    const rolled = attr == null ? rollGearAttr(id) : (integer(attr, 0, 0) || rollGearAttr(id));
    const info = gearInst(id, ext, rolled);
    if (!info) return null;
    let key;
    do { key = 'g' + Date.now() + '_' + (gearKeySeq++); } while (S.gears.some((g) => g.key === key));
    S.gears.push({ id: info.id, used: false, key, ext: info.ext, attr: rolled });
    save();
    return Object.assign(info, { key, used: false });
  }
  // 5 级更换装备教程的随机白装：只从 5 级可穿的白色装备里抽一件。
  // 必须落存档（`starterGearGiven`）：不然每次重开游戏第一次进换装页都会再送一件。
  function grantStarterGear() {
    if (!S || S.starterGearGiven === true || (ONLINE_RULES && Number(S.level) < 5)) return null;
    if (S.gears.length >= gearCapacity()) return null;
    const ids = [];
    gearMap.each((k, v) => {
      const id = parseInt(k, 10);
      const gi = gearInst(id);
      if (gi && Number(gi.quality) === 0 && Number(gi.useLevel) <= 5) ids.push(id);
    });
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const gear = addGear(id, randomExtForQuality(0));
    if (!gear) return null;
    S.starterGearGiven = true;
    save();
    return gear;
  }

  function setTutorialStep(step) {
    const value = Number(step);
    if (!S || !Number.isInteger(value) || !((value >= 1 && value <= 26) || value === 99)) return false;
    S.tutorial = Object.assign({}, object(S.tutorial) ? S.tutorial : {}, { step: value });
    save();
    return true;
  }

  function equipmentEffects() {
    const effects = {};
    for (const gear of S.gears) {
      if (!gear.used) continue;
      if (!blackGearEnabled() && isBlackGearId(gear.id)) continue;
      const info = gearInst(gear.id, gear.ext, gear.attr);
      if (!info || S.level < info.useLevel) continue;
      const ext = normalizeExt(gear.ext);
      const units = gemUnitsForGear(gear);
      for (let i = 0; i < ext.length; i++) {
        const v = attachmentValue(ext[i].id, ext[i].level, units[i] || 0);
        effects[ext[i].id] = Math.max(effects[ext[i].id] || 0, v.total);
      }
    }
    return effects;
  }



  function permanentStatTotal(source) {
    const s = object(source) ? source : S;
    if (!s) return 0;
    const num = (v) => Math.max(0, Number(v) || 0);
    return num(s.power) + num(s.agility) + num(s.speed) + num(s.maxHp) / 5;
  }
  // 还差多少才到 651 硬上限（离线版；联机版不再设硬上限，返回 Infinity）。
  function statCapRoom(source) {
    if (ONLINE) return Infinity;
    return Math.max(0, STAT_HARD_CAP - permanentStatTotal(source));
  }
  // 把离线版永久属性点收口到 651；联机版只做非负/整数清洗，不设总上限。所有写盘与读档路径都必须经过这里：
  // 只要保存或重载就会被拉回上限。返回本次被收掉的点数。
  function clampPermanentStats(source) {
    const s = object(source) ? source : S;
    if (!s) return 0;
    let power = Math.max(1, integer(s.power, 1, 1));
    let agility = Math.max(1, integer(s.agility, 1, 1));
    let speed = Math.max(1, integer(s.speed, 1, 1));
    let hp = Math.max(5, integer(s.maxHp, 5, 5));
    // 生命按 5 点一格收口；旧档/调试写入的零头不参与上限计算。
    let hpPoints = Math.floor(hp / 5);

    if (ONLINE) {
      s.power = power; s.agility = agility; s.speed = speed; s.maxHp = hpPoints * 5;
      if (Number(s.hp) > s.maxHp) s.hp = s.maxHp;
      return 0;
    }
    const used = () => power + agility + speed + hpPoints;
    let excess = used() - STAT_HARD_CAP;
    let removed = 0;
    let guard = 0;
    while (excess > 0 && guard++ < 4096) {
      const pools = [
        { key: 'power', get: () => power, set: (v) => { power = v; } },
        { key: 'agility', get: () => agility, set: (v) => { agility = v; } },
        { key: 'speed', get: () => speed, set: (v) => { speed = v; } },
        { key: 'hp', get: () => hpPoints, set: (v) => { hpPoints = v; } },
      ].sort((a, b) => b.get() - a.get());
      let progressed = false;
      for (const pool of pools) {
        const take = Math.min(excess, Math.max(0, pool.get() - 1));
        if (take <= 0) continue;
        pool.set(pool.get() - take);
        excess -= take;
        removed += take;
        progressed = true;
        if (excess <= 0) break;
      }
      if (!progressed) break;
    }
    s.power = power; s.agility = agility; s.speed = speed; s.maxHp = hpPoints * 5;
    if (Number(s.hp) > s.maxHp) s.hp = s.maxHp;
    return removed;
  }
  function totalStats(opts) {
    opts = opts || {};

    clampPermanentStats();
    let power = S.power, agility = S.agility, speed = S.speed, hp = S.maxHp;
    for (const g of S.gears) {
      if (!g.used) continue;
      if (!blackGearEnabled() && isBlackGearId(g.id)) continue;
      const gi = gearInst(g.id, g.ext, g.attr);
      if (!gi || S.level < gi.useLevel) continue;
      let val = gi.abilityVal;
      if (g.gem) val = Math.round(val * (1 + gemPercent(gemLevel(g.gem.id)) / 100));
      if (gi.type === 0) agility += val;
      else if (gi.type === 1) power += val;
      else if (gi.type === 2) hp += val;
      else speed += val;
    }

    const sk = mySkills();
    const has = (id) => sk.find((x) => x.id === id);
    const effects = equipmentEffects();
    let t;
    if ((t = has(1))) power += GData.passiveBonus(1, t.level) * (1 + (effects[27] || 0) / 100);
    if ((t = has(2))) agility += GData.passiveBonus(2, t.level) * (1 + (effects[28] || 0) / 100);
    if ((t = has(3))) speed += GData.passiveBonus(3, t.level) * (1 + (effects[29] || 0) / 100);
    if ((t = has(4))) hp += GData.passiveBonus(4, t.level) * (1 + (effects[30] || 0) / 100);
    if (opts.useProps !== false) {
      const st = S.propsStates || {};
      if (st[3] > 0) power += Math.max(Math.floor(power * 0.2), 5);
      if (st[4] > 0) agility += Math.max(Math.floor(agility * 0.2), 5);
      if (st[5] > 0) speed += Math.max(Math.floor(speed * 0.2), 5);
      if (st[41] > 0) power += Math.max(Math.floor(power * 0.4), 10);
      if (st[42] > 0) agility += Math.max(Math.floor(agility * 0.4), 10);
      if (st[43] > 0) speed += Math.max(Math.floor(speed * 0.4), 10);
    }
    return { power: Math.round(power), agility: Math.round(agility), speed: Math.round(speed), hp: Math.round(hp) };
  }



  const SHOP_DAILY_PILLS = [3, 4, 5, 7];
  const SHOP_PILL_LIMIT = 3;

  const SHOP_DAILY_ENERGY = [1, 2];
  const SHOP_ENERGY_LIMIT = 3;
  // 注意道具行里最后一个字段是 useType，不是购买数量 —— 限购只认这里。
  const SHOP_DAILY_LIMITS = { 39: 5, 87: 1 };
  function shopLimit(id) {
    const key = Number(id), prop = propMap.getValue(key);
    if (!prop) return 0;
    if (SHOP_DAILY_LIMITS[key] != null) return SHOP_DAILY_LIMITS[key];
    if (SHOP_DAILY_PILLS.includes(key)) return SHOP_PILL_LIMIT;
    if (SHOP_DAILY_ENERGY.includes(key)) return SHOP_ENERGY_LIMIT;
    return [13, 16, 17, 18, 19, 37, 38, 47, 48].includes(key) || /宝箱|魔法袋|礼包|永久/.test(prop.name) ? 1 : 5;
  }
  function syncShopPurchases() {
    const date = localDate();
    if (S.shopPurchaseDate === date && object(S.shopPurchases)) return;
    if ((S.shopPurchaseDate && S.shopPurchaseDate !== date) || !object(S.shopPurchases)) S.shopPurchases = {};
    S.shopPurchaseDate = date;
    save();
  }
  function purchaseStatus(id) {
    id = Number(id);
    syncShopPurchases();
    const prop = propMap.getValue(id), limit = shopLimit(id), bought = integer(S.shopPurchases[id], 0);

    const offShelf = false;

    const notOnSale = ONLINE_RULES && id === GData.CAMPAIGN_TICKET_ID && GData.campaignTicketOnSale && !GData.campaignTicketOnSale();
    const buyable = !!prop && prop.buy === 'true' && !offShelf && !notOnSale;
    return { date: S.shopPurchaseDate, limit, bought, remaining: buyable ? Math.max(0, limit - bought) : 0, buyable, offShelf: !!offShelf, notOnSale: !!notOnSale };
  }
  function buyProp(id, count) {
    id = Number(id);
    const p = propMap.getValue(id);
    if (!p || p.buy !== 'true') return { ok: false, msg: '该物品不出售' };

    const shelf = purchaseStatus(id);
    if (ONLINE_RULES && !shelf.buyable) {
      if (shelf.notOnSale) return { ok: false, msg: '征战令只在每周二、四、六出售。' };
      if (shelf.offShelf) return { ok: false, msg: '这件商品没有上架。' };
    }
    if (id === 47 && Number(S.level) < 30) return { ok: false, levelLocked: true, msg: '需要达到30级后才可购买此道具！' };
    count = count == null ? 1 : Number(count);
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, msg: '购买数量必须是正整数' };
    const status = purchaseStatus(id);
    if (count > status.remaining) return { ok: false, limited: true, msg: status.remaining ? `今日还可购买${status.remaining}个${p.name}` : `${p.name}今日已达限购${status.limit}个`, ...status };
    const cost = parseInt(p.price) * count;
    if (!Number.isSafeInteger(cost) || cost < 0) return { ok: false, msg: '商品价格无效' };
    if (!debugOn('freeShop')) {
      if (S.goldPoint < cost) return { ok: false, msg: '金松果不足！' };
      S.goldPoint -= cost;
    }
    S.props[id] = (S.props[id] || 0) + count;
    S.shopPurchases[id] = status.bought + count;
    bumpDaily('buy', count, true);
    save();
    return { ok: true, msg: `购买了${p.name}x${count}`, ...purchaseStatus(id) };
  }
  // 原版 `rankgoodsMap` 的 23 件商品；价格（积分/金杯/金松果）与 `timesLimit` 都在这里判，
  // 限购分四类：每周 / 每月（魔法袋与狂战）/ 账号累计（仅离线）/ 开服以来累计额度（永久属性货）。
  // 这里做成 `State.rankBuy` 是为了让服务端动作和单机界面共用同一套判定；
  const RANK_ACCOUNT_LIMIT_GOODS = Object.freeze(ONLINE ? [] : [7, 8, 9, 10, 19]);

  const BERSERK_MONTHLY_GOODS = Object.freeze([11, 12, 13, 14, 20, 21, 22, 23]);
  const RANK_MONTHLY_LIMIT_GOODS = Object.freeze(ONLINE ? [19].concat(BERSERK_MONTHLY_GOODS) : []);
  const RANK_CONVERT_PILL_GOODS = Object.freeze([15, 16, 17, 18]);
  // 联机版永久属性货（力/敏/速/血）共用一份额度：从开服月起每月 2 次，
  // 未兑换的次数累计、不设上限；新号也从开服月补足，所有人的累计上限一致。
  const RANK_STAT_GOODS = Object.freeze([7, 8, 9, 10]);
  const RANK_STAT_OPEN_MONTH = '2026-11';
  const RANK_STAT_PER_MONTH = 2;
  // 2026-11-30（下周一）起，力/敏/速/血转化丸从 30 杯 + 30 松果涨到 50 + 50。
  const RANK_CONVERT_PILL_PRICE_FROM = '2026-11-30';
  function rankConvertPillPrice(weekKey) {
    return String(weekKey || '') >= RANK_CONVERT_PILL_PRICE_FROM
      ? { cup: 50, gold: 50 }
      : { cup: 30, gold: 30 };
  }
  // 同日（2026-11-30）起，四种转化丸的每周限兑从 1 次提高到 2 次；之前的周仍按 1 次结算。
  const RANK_CONVERT_PILL_WEEKLY_FROM = '2026-11-30';
  function rankConvertPillWeeklyLimit(weekKey) {
    return String(weekKey || '') >= RANK_CONVERT_PILL_WEEKLY_FROM ? 2 : 1;
  }
  function applyRankGoodsPrice(item) {
    if (!item || !item.source || !RANK_CONVERT_PILL_GOODS.includes(Number(item.id))) return item;
    const price = rankConvertPillPrice(rankWeekKey());
    item.source[4] = String(price.cup);
    item.source[5] = String(price.gold);
    item.cup = String(price.cup);
    item.gold = String(price.gold);
    return item;
  }
  function rankWeekKey() {
    if (liveServerClock()) return serverWeekKey(nowMs());
    const d = new Date(Date.now());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return dateKey(d);
  }
  // 月度 key 必须用真实日历月，不能用 localDate()：后者有 12 点换日，
  function rankMonthKey() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
      }).formatToParts(new Date(nowMs()));
      const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
      return get('year') + '-' + get('month');
    } catch (_) {
      const d = new Date(nowMs() + 8 * 3600000);
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    }
  }
  // 永久属性货的总额度只由「开服月 → 当前月」决定，与注册时间无关：
  // 晚注册的号拿到的累计次数与开服玩家相同，差额只体现在各自已兑换的次数上。
  function rankStatQuota() {
    const now = rankMonthKey().split('-').map(Number);
    const open = RANK_STAT_OPEN_MONTH.split('-').map(Number);
    const months = now[0] && now[1] ? (now[0] * 12 + now[1]) - (open[0] * 12 + open[1]) + 1 : 1;
    return Math.max(1, months) * RANK_STAT_PER_MONTH;
  }
  function refreshRankShopDay() {
    if (!S) return;
    let dirty = false;
    const week = rankWeekKey();
    const month = rankMonthKey();
    if (!object(S.rankPurchaseTotals) || Array.isArray(S.rankPurchaseTotals)) { S.rankPurchaseTotals = {}; dirty = true; }
    if (!object(S.rankPurchases) || Array.isArray(S.rankPurchases)) { S.rankPurchases = {}; dirty = true; }
    if (!object(S.rankMonthPurchases) || Array.isArray(S.rankMonthPurchases)) { S.rankMonthPurchases = {}; dirty = true; }
    // 永久属性货改为累计额度后的一次性迁移：月度账里只剩「最后一次重置后」的次数，
    // 只有记录月份 >= 开服月才计入累计；之后月度账继续给魔法袋 / 狂战用。
    if (ONLINE && S.rankStatMigrated !== true) {
      const savedMonth = String(S.rankPurchaseMonth || '');
      let used = 0;
      if (savedMonth >= RANK_STAT_OPEN_MONTH) {
        for (const id of RANK_STAT_GOODS) used += Math.max(0, Math.floor(Number(S.rankMonthPurchases[id]) || 0));
      }
      S.rankStatUsed = Math.max(0, used);
      S.rankStatMigrated = true;
      dirty = true;
    }
    if (ONLINE) {

      if (!S.rankPurchaseMonth) {
        for (const id of RANK_MONTHLY_LIMIT_GOODS) {
          const weekly = Math.max(0, Math.floor(Number(S.rankPurchases[id]) || 0));
          const lifetime = Math.max(0, Math.floor(Number(S.rankPurchaseTotals[id]) || 0));
          const old = Math.max(weekly, lifetime ? 1 : 0);
          if (old > 0) S.rankMonthPurchases[id] = Math.min(1, old);
          delete S.rankPurchaseTotals[id];
        }
        S.rankPurchaseMonth = month;
        dirty = true;
      } else if (S.rankPurchaseMonth !== month) {
        S.rankMonthPurchases = {};
        S.rankPurchaseMonth = month;
        dirty = true;
      }
    } else {

      for (const id of RANK_ACCOUNT_LIMIT_GOODS) {
        const old = Math.max(0, Math.floor(Number(S.rankPurchases[id]) || 0));
        if (old > 0) S.rankPurchaseTotals[id] = Math.max(old, Math.floor(Number(S.rankPurchaseTotals[id]) || 0));
      }
    }
    // 两套狂战改为每月限兑后的一次性迁移：老玩家的 `rankPurchaseMonth` 已经有值
    // （永久属性丸月度账先上线），不会走上面的首次迁移；这里把本周已经买过的狂战件数
    if (ONLINE && !S.rankBerserkMigrated) {
      // 只有「本周周一已经在本月」时才把周账搬进本月账；跨月的那一周可能含上个月的购买，
      // 不能算到本月（宁可不拦，也不要误拦）。
      const weekStart = String(S.rankPurchaseWeek || '');
      if (!weekStart || weekStart >= (month + '-01')) {
        for (const id of BERSERK_MONTHLY_GOODS) {
          const weekly = Math.max(0, Math.floor(Number(S.rankPurchases[id]) || 0));
          if (weekly > 0) S.rankMonthPurchases[id] = Math.max(Math.floor(Number(S.rankMonthPurchases[id]) || 0), weekly);
        }
      }
      S.rankBerserkMigrated = true;
      dirty = true;
    }

    const oldBag = Math.max(0, Math.floor(Number(S.rankPurchases[19]) || 0));
    if (ONLINE) {
      // 19 号魔法袋从「账号累计 1 次」改为「每月 1 次」：本周已买过的记进本月账，
      // 避免改版当周白送一次；以前的账号累计记录没有月份，直接作废。
      if (S.rankPurchaseWeek === week && String(S.rankPurchaseWeek) >= (month + '-01') && oldBag > 0) {
        S.rankMonthPurchases[19] = Math.max(Math.floor(Number(S.rankMonthPurchases[19]) || 0), 1);
        dirty = true;
      }
      if (S.rankPurchaseTotals[19] !== undefined) { delete S.rankPurchaseTotals[19]; dirty = true; }
    } else if (oldBag > 0) {
      S.rankPurchaseTotals[19] = Math.max(oldBag, Math.floor(Number(S.rankPurchaseTotals[19]) || 0));
      dirty = true;
    }
    if (S.rankPurchaseWeek !== week || !object(S.rankPurchases) || Array.isArray(S.rankPurchases)) {
      S.rankPurchases = {};
      S.rankPurchaseWeek = week;
      if (S.rankPurchaseDay !== undefined) delete S.rankPurchaseDay;
      dirty = true;
    }
    if (dirty) save();
  }
  function rankGoodsOf(goodsId) {
    const map = typeof rankgoodsMap !== 'undefined' ? rankgoodsMap : null;
    const item = map && map.getValue ? (map.getValue(String(goodsId)) || map.getValue(Number(goodsId))) : null;
    return applyRankGoodsPrice(item);
  }
  function rankLimitInfo(item) {
    const id = String(item && item.id);
    const stat = ONLINE && RANK_STAT_GOODS.includes(Number(item && item.id));
    const account = RANK_ACCOUNT_LIMIT_GOODS.includes(Number(item && item.id));
    const monthly = RANK_MONTHLY_LIMIT_GOODS.includes(Number(item && item.id));
    const convertPill = RANK_CONVERT_PILL_GOODS.includes(Number(item && item.id));
    const baseLimit = Math.max(0, Math.floor(Number(item && item.timesLimit) || 0));
    const limit = stat ? rankStatQuota() : convertPill ? rankConvertPillWeeklyLimit(rankWeekKey()) : baseLimit;
    const bag = stat ? null : monthly ? (S.rankMonthPurchases || {}) : account ? (S.rankPurchaseTotals || {}) : (S.rankPurchases || {});
    const bought = stat
      ? Math.max(0, Math.floor(Number(S.rankStatUsed) || 0))
      : Math.max(0, Math.floor(Number(bag[id]) || 0));
    return { stat, account, monthly, limit, bought, remaining: limit > 0 ? Math.max(0, limit - bought) : Infinity,
      month: monthly ? String(S.rankPurchaseMonth || '') : '' };
  }
  function rankBuy(goodsId) {
    if (!S) return { ok: false, msg: '还没有存档' };
    if (Number(S.level) < 30) return { ok: false, msg: '天梯商店需要达到30级。' };
    refreshRankShopDay();
    const item = rankGoodsOf(goodsId);
    if (!item) return { ok: false, msg: '没有这件商品' };
    const needCup = Math.max(0, Number(item.cup) || 0);
    const needGold = Math.max(0, Number(item.gold) || 0);
    const needIntegral = Math.max(0, Number(item.integral) || 0);
    const lim = rankLimitInfo(item);
    if (Number(S.integral) < needIntegral) return { ok: false, msg: '天梯积分尚未达到兑换要求。' };
    if (Number(S.goldCup) < needCup || Number(S.goldPoint) < needGold) return { ok: false, msg: '金杯或金松果不足。' };
    if (lim.limit > 0 && lim.bought >= lim.limit) {
      return { ok: false, msg: lim.stat
        ? '力/敏/速/血永久兑换的累计次数已用完（共 ' + lim.limit + ' 次），下个月 1 号 0 点再增加 ' + RANK_STAT_PER_MONTH + ' 次。'
        : lim.monthly
          ? '该奖励本月只能兑换 ' + lim.limit + ' 次，下个月 1 号 0 点重置。'
          : lim.account
            ? '该奖励每个账号累计只能兑换 ' + lim.limit + ' 次，已经兑换完了。'
            : '该奖励本周的兑换次数已用完，下周一重置后可再兑换。' };
    }
    const count = Math.max(1, Math.floor(Number(item.count) || 1));
    const gearId = Number(item.goodsId);
    if (String(item.type) !== '2' && !propMap.getValue(gearId)) {
      return { ok: false, msg: '道具数据异常，兑换失败。' };
    }
    if (String(item.type) === '2' && S.gears.length >= gearCapacity()) {
      return { ok: false, msg: '装备已满（' + S.gears.length + '/' + gearCapacity() + '），先卖掉或融合几件' };
    }
    // 先生成装备再扣账：`addGear` 失败时不能让金杯/金松果先掉。
    if (String(item.type) === '2') {
      if (!addGear(gearId, randomExt(2))) return { ok: false, msg: '装备数据异常，兑换失败。' };
    }
    S.goldCup = Math.max(0, Number(S.goldCup) || 0) - needCup;
    S.goldPoint = Math.max(0, Number(S.goldPoint) || 0) - needGold;
    if (String(item.type) !== '2') {
      S.props[gearId] = (Number(S.props[gearId]) || 0) + count;
    }
    if (lim.stat) S.rankStatUsed = lim.bought + 1;
    else {
      const bag = lim.monthly ? S.rankMonthPurchases : lim.account ? S.rankPurchaseTotals : S.rankPurchases;
      bag[String(item.id)] = Math.max(0, Math.floor(Number(bag[String(item.id)]) || 0)) + 1;
    }
    save();
    return {
      ok: true, msg: '兑换成功：' + item.name,
      item: { id: String(item.id), name: String(item.name), type: String(item.type), goodsId: gearId },
      goldCup: S.goldCup, goldPoint: S.goldPoint, integral: S.integral,
      bought: lim.bought + 1, limit: lim.limit, stat: lim.stat, account: lim.account, monthly: lim.monthly, month: lim.month,
    };
  }

  // 原版客户端只负责「展示奖品 + 播放动画」，真正的奖品由服务端 `chest.do` 下发。
  function rollBlackChestGear() {
    const roll = Math.random();
    let setId;
    if (roll < 0.10) setId = Math.random() < 0.5 ? 71 : 72;
    else if (roll < 0.40) setId = 46;
    else setId = 47;
    const ids = [];
    gearMap.each((k, v) => { if (Number(v.setId) === setId) ids.push(Number(v.id)); });
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const def = gearMap.getValue(id);
    return { kind: 'gear', id, count: 1, name: def ? def.name : '黑装' };
  }

  function rollChestReward(kind) {
    const r = Math.random();
    const prop = (id, count) => {
      const p = propMap.getValue(id);
      return { kind: 'prop', id, count, name: p ? p.name : '道具' };
    };

    if (kind === 'gold') {

      if (!blackGearEnabled()) {
        if (r < 0.04) return prop(106, 1);
        if (r < 0.14) return prop(105, 2);
        if (r < 0.26) return prop(105, 1);
        if (r < 0.51) return { kind: 'gold', count: 500 + Math.floor(Math.random() * 3) * 250, name: '金松果' };
        if (r < 0.54) return { kind: 'points', count: 12, name: '基础属性点' };
        if (r < 0.62) return { kind: 'points', count: 10, name: '基础属性点' };
        if (r < 0.76) return { kind: 'points', count: 8, name: '基础属性点' };
        return { kind: 'points', count: 6, name: '基础属性点' };
      }

      if (r < 0.04) return prop(106, 1);
      if (r < 0.14) return prop(105, 2);
      if (r < 0.26) return prop(105, 1);
      if (r < 0.41) return { kind: 'gold', count: 500 + Math.floor(Math.random() * 3) * 250, name: '金松果' };
      if (r < 0.49) return prop(80, 1);
      if (r < 0.51) return rollBlackChestGear() || prop(80, 1);
      if (r < 0.54) return { kind: 'points', count: 12, name: '基础属性点' };
      if (r < 0.62) return { kind: 'points', count: 10, name: '基础属性点' };
      if (r < 0.76) return { kind: 'points', count: 8, name: '基础属性点' };
      return { kind: 'points', count: 6, name: '基础属性点' };
    }
    if (r < 0.03) return prop(106, 1);
    if (r < 0.18) return prop(105, 1);
    if (r < 0.33) return prop(26, 5 + Math.floor(Math.random() * 6));
    if (r < 0.50) return prop(82, 1 + Math.floor(Math.random() * 2));
    if (r < 0.75) return { kind: 'gold', count: 300 + Math.floor(Math.random() * 5) * 50, name: '金松果' };
    return { kind: 'hatch', count: 100, name: '孵化点' };
  }

  // 联机金宝箱的“其它奖励”池：只收非属性奖励；属性点由 beginChest 固定发。
  const CHEST_OTHER_ROWS = Object.freeze({
    gem6: Object.freeze({ weight: 4, label: '6 级宝石 ×1' }),
    gem5x2: Object.freeze({ weight: 10, label: '5 级宝石 ×2' }),
    gem5x1: Object.freeze({ weight: 12, label: '5 级宝石 ×1' }),
    gold: Object.freeze({ weight: 15, label: '金松果 500/750/1000' }),
    card: Object.freeze({ weight: 8, label: '黑色卡片 ×1' }),
    blackGear: Object.freeze({ weight: 2, label: '完整黑装 ×1' }),
  });
  function chestOtherRows() {
    const black = blackGearEnabled();
    const keys = ['gem6', 'gem5x2', 'gem5x1', 'gold'].concat(black ? ['card', 'blackGear'] : []);
    return keys.map((key) => {
      const row = CHEST_OTHER_ROWS[key];
      return {
        key,
        weight: key === 'gold' && !black ? 25 : row.weight,
        label: row.label,
      };
    });
  }
  function rollChestOtherReward() {
    const rows = chestOtherRows();
    if (!rows.length) return null;
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    let r = Math.random() * total;
    let picked = rows[rows.length - 1];
    for (const row of rows) {
      r -= row.weight;
      if (r < 0) { picked = row; break; }
    }
    const prop = (id, count) => {
      const p = propMap.getValue(id);
      return { kind: 'prop', id, count, name: p ? p.name : '道具' };
    };
    if (picked.key === 'gem6') return prop(106, 1);
    if (picked.key === 'gem5x2') return prop(105, 2);
    if (picked.key === 'gem5x1') return prop(105, 1);
    if (picked.key === 'gold') {
      return { kind: 'gold', count: 500 + Math.floor(Math.random() * 3) * 250, name: '金松果' };
    }
    if (picked.key === 'card') return prop(80, 1);
    if (picked.key === 'blackGear') return rollBlackChestGear() || prop(80, 1);
    return null;
  }
  function chestOtherOdds() {
    if (!ONLINE) return [];
    const rows = chestOtherRows();
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    if (!total) return [];
    return rows.map((row) => ({ key: row.key, label: row.label, chance: row.weight / total }));
  }

  // 金宝箱固定属性点：先掷出完整分配并落 pending，界面第一页展示的就是最终值；
  // 领取时按同一份分配入账。
  function rollPointGain(count) {
    const out = { power: 0, agility: 0, speed: 0, hp: 0 };
    const n = Math.max(0, Math.floor(Number(count) || 0));
    for (let i = 0; i < n; i++) {
      const target = STAT_KEYS[Math.floor(Math.random() * STAT_KEYS.length)];
      out[target] += STAT_GAIN[target];
    }
    return out;
  }
  function applyPointGain(save, gain) {
    if (!object(save) || !object(gain)) return;
    for (const key of ['power', 'agility', 'speed']) save[STAT_FIELDS[key]] += Math.max(0, integer(gain[key], 0));
    save.maxHp += Math.max(0, integer(gain.hp, 0));
  }
  function normalizePointGain(raw) {
    if (!object(raw)) return null;
    const out = {
      power: Math.max(0, integer(raw.power, 0)),
      agility: Math.max(0, integer(raw.agility, 0)),
      speed: Math.max(0, integer(raw.speed, 0)),
      hp: Math.max(0, integer(raw.hp, 0)),
    };
    if (out.hp % 5 !== 0) return null;
    if (out.power + out.agility + out.speed + out.hp / 5 !== CHEST_FIXED_POINTS) return null;
    return out;
  }

  // 金宝箱等来源的属性点直接落到四维，避免再产生待分配点。
  function allocateRandomPointsTo(save, count) {
    const out = { power: 0, agility: 0, speed: 0, hp: 0 };
    if (!save || !(Number(count) > 0)) return out;
    let n = Math.max(0, Math.floor(Number(count) || 0));
    if (!ONLINE) {
      const used = save.power + save.agility + save.speed + Math.floor(save.maxHp / 5);
      n = Math.min(n, Math.max(0, STAT_HARD_CAP - used));
    }
    for (let i = 0; i < n; i++) {
      const target = STAT_KEYS[Math.floor(Math.random() * STAT_KEYS.length)];
      save[STAT_FIELDS[target]] += STAT_GAIN[target];
      out[target] += STAT_GAIN[target];
    }
    return out;
  }

  function canGrantChestReward(reward) {
    if (!reward || !(Number(reward.count) > 0)) return false;
    if (reward.kind === 'prop') return !!propMap.getValue(Number(reward.id));
    if (reward.kind === 'gear') return S.gears.length < gearCapacity();
    return ['points', 'gold', 'hatch'].includes(String(reward.kind));
  }
  function grantChestReward(reward) {
    if (!reward || !(Number(reward.count) > 0)) return false;
    if (reward.kind === 'prop') {
      const id = Number(reward.id);
      if (!propMap.getValue(id)) return false;
      S.props[id] = (S.props[id] || 0) + Number(reward.count);
    } else if (reward.kind === 'points') {
      allocateRandomPointsTo(S, reward.count);
    } else if (reward.kind === 'gold') {
      addGold(Number(reward.count));
    } else if (reward.kind === 'hatch') {
      S.hatchPoint = (S.hatchPoint || 0) + Number(reward.count);
    } else if (reward.kind === 'gear') {
      if (!blackGearEnabled() && isBlackGearId(reward.id)) return false;
      if (S.gears.length >= gearCapacity()) return false;
      if (!addGear(Number(reward.id), randomExtForQuality(5))) return false;
    } else return false;
    return true;
  }

  function chestState() { return S && S.chestPending ? clone(S.chestPending) : null; }

  function beginChest(id) {
    id = Number(id) || 90;
    if (id !== 90) return { ok: false, msg: '只有金宝箱可以打开' };
    if (S.chestPending) return { ok: false, msg: '还有未领取的开箱结果，请先领取' };
    if ((S.props[90] || 0) <= 0) return { ok: false, msg: '没有金宝箱' };
    S.props[90]--;
    if (S.props[90] <= 0) delete S.props[90];
    if (ONLINE) {
      const other = rollChestOtherReward() || chestOtherDefaultReward();
      const pointsGain = rollPointGain(CHEST_FIXED_POINTS);
      S.chestPending = { propId: 90, points: CHEST_FIXED_POINTS, pointsGain, reward: other };
      save();
      return { ok: true, pending: chestState(),
        msg: '打开金宝箱：基础属性点 ×' + CHEST_FIXED_POINTS + '（自动随机分配） + ' + other.name + ' ×' + other.count };
    }
    const reward = rollChestReward('gold');
    S.chestPending = { propId: 90, reward };
    save();
    return { ok: true, pending: chestState(), msg: '打开金宝箱：' + reward.name + ' ×' + reward.count };
  }

  function confirmChest() {
    const p = S.chestPending;
    if (!p) return { ok: false, msg: '没有待领取的开箱结果' };
    const reward = p.reward;
    const points = Math.max(0, Math.floor(Number(p.points) || 0));
    const pointsGain = points > 0 ? (normalizePointGain(p.pointsGain) || rollPointGain(points)) : null;
    if (!canGrantChestReward(reward)) return { ok: false, msg: '开箱奖励暂时无法领取（装备栏已满或数据异常）' };
    const roomBefore = reward.kind === 'points' ? Math.max(0, Math.floor(statCapRoom())) : null;
    if (!grantChestReward(reward)) return { ok: false, msg: '开箱奖励无效' };
    if (pointsGain) applyPointGain(S, pointsGain);
    delete S.chestPending;
    save();
    const capped = roomBefore != null && roomBefore < Number(reward.count);
    const parts = [];
    if (pointsGain) parts.push('基础属性点 ×' + points + '（已自动随机分配）');
    parts.push(reward.name + ' ×' + reward.count + (reward.kind === 'points' ? '（已自动随机分配）' : ''));
    return { ok: true, points, pointsGain, reward,
      msg: '领取' + parts.join(' + ') +
        (capped ? '（属性点已达硬上限 ' + STAT_HARD_CAP + '，超出部分未入账）' : '') };
  }

  function settlePendingChest(opts) {
    if (!S || !S.chestPending) return false;
    const p = S.chestPending;
    const points = Math.max(0, Math.floor(Number(p.points) || 0));
    const pointsGain = points > 0 ? (normalizePointGain(p.pointsGain) || rollPointGain(points)) : null;
    if (!canGrantChestReward(p.reward)) return false;
    if (!grantChestReward(p.reward)) return false;
    if (pointsGain) applyPointGain(S, pointsGain);
    delete S.chestPending;
    if (!(opts && opts.save === false)) save();
    return true;
  }

  function openChestProp(id) {
    id = Number(id);
    if (id === 79) {
      if ((S.props[79] || 0) <= 0) return { ok: false, msg: '没有该道具' };
      S.props[79]--;
      if (S.props[79] <= 0) delete S.props[79];
      const reward = rollChestReward('magic');
      grantChestReward(reward);

      const card = blackGearEnabled() ? 1 : 0;
      if (card) S.props[80] = (S.props[80] || 0) + card;
      save();
      return {
        ok: true, id, reward, card,
        msg: '打开魔法袋：' + reward.name + ' ×' + reward.count + (card ? '；额外获得黑色卡片 ×1' : ''),
      };
    }
    if (id !== 90) return { ok: false, msg: '不是可开启的宝箱' };
    if (S.chestPending) return { ok: false, msg: '还有未领取的开箱结果，请先领取' };
    const begin = beginChest(90);
    if (!begin.ok) return begin;
    return confirmChest();
  }


  function blackCardOptions() {
    if (!blackGearEnabled()) return [];
    return [
      { setId: 71, name: '凤凰', shardId: 77 },
      { setId: 72, name: '圣熊', shardId: 78 },
    ];
  }

  function applyBlackCard(setId) {
    if (!blackGearEnabled()) return { ok: false, msg: '现代界面没有黑装内容' };
    const set = Number(setId);
    if (![71, 72].includes(set)) return { ok: false, msg: '请选择凤凰或圣熊' };
    const shardId = set === 71 ? 77 : 78;
    const shards = Math.random() < 0.7 ? 1 : 2;
    const roll = Math.random();

    const gold = roll < 0.5 ? 100 : roll < 0.85 ? 200 : 400;
    S.props[shardId] = (S.props[shardId] || 0) + shards;
    addGold(gold);
    const def = propMap.getValue(shardId);
    return {
      ok: true, setId: set, shardId, shards, gold,
      msg: '打开黑色卡片：' + (def ? def.name : '黑装碎片') + ' ×' + shards + '，金松果 +' + gold,
    };
  }

  function blackGearBoxOptions() {
    if (!blackGearEnabled()) return [];
    const out = [];
    for (const setId of [71, 72]) {
      gearMap.each((k, v) => {
        if (Number(v.setId) !== setId) return;
        out.push({ id: Number(v.id), name: v.name, type: Number(v.type), setId });
      });
    }
    return out.sort((a, b) => (a.setId - b.setId) || (a.type - b.type));
  }

  function applyBlackGearBox(gearId) {
    if (!blackGearEnabled()) return { ok: false, msg: '现代界面没有黑装内容' };
    if (S.gears.length >= gearCapacity()) return { ok: false, msg: '装备已满（' + S.gears.length + '/' + gearCapacity() + '），先卖掉或融合几件' };
    const id = Number(gearId);
    const hit = blackGearBoxOptions().find((o) => o.id === id);
    if (!hit) return { ok: false, msg: '请选择一件凤凰或圣熊装备' };
    const g = addGear(id, randomExtForQuality(5));
    if (!g) return { ok: false, msg: '黑装数据缺失' };
    return { ok: true, gear: g, msg: '获得' + g.name };
  }


  const ENDLESS_BLACK_CARD_CAP = 10;

  function blackCardWeekKey() {
    if (liveServerClock()) return serverWeekKey(nowMs());
    const d = new Date(Date.now());
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return dateKey(d);
  }
  function syncBlackCardsWeek() {
    const week = blackCardWeekKey();
    if (!object(S.blackCardsWeek)) S.blackCardsWeek = { week, count: 0 };
    if (S.blackCardsWeek.week !== week) S.blackCardsWeek = { week, count: 0 };
    S.blackCardsWeek.count = Math.max(0, Math.min(ENDLESS_BLACK_CARD_CAP, integer(S.blackCardsWeek.count, 0)));
    return S.blackCardsWeek;
  }
  function endlessBlackCardLeft() {
    syncBlackCardsWeek();
    return Math.max(0, ENDLESS_BLACK_CARD_CAP - S.blackCardsWeek.count);
  }

  function grantEndlessBlackCard(n) {
    if (!blackGearEnabled()) return { gain: 0, left: 0, cap: ENDLESS_BLACK_CARD_CAP, week: blackCardWeekKey() };
    syncBlackCardsWeek();
    const left = endlessBlackCardLeft();
    const gain = Math.min(left, Math.max(0, Math.floor(Number(n) || 0)));
    if (gain > 0) {
      S.blackCardsWeek.count += gain;
      S.props[80] = (S.props[80] || 0) + gain;
      save();
    }
    return { gain, left: left - gain, cap: ENDLESS_BLACK_CARD_CAP, week: S.blackCardsWeek.week };
  }

  function useProp(id, param) {
    id = parseInt(id);
    if (!blackGearEnabled() && isBlackPropId(id)) return { ok: false, msg: '现代界面没有黑装内容' };
    const p = propMap.getValue(id);
    if (!p) return { ok: false, msg: '没有该道具' };
    // 宝箱先走自己的入口：金宝箱可能「箱子已消耗、结果待领取」（S.chestPending），
    // 这时背包里数量是 0，不能按普通道具直接判成「没有该道具」。
    if (id === 79 || id === 90) return openChestProp(id);
    if ((S.props[id] || 0) <= 0) return { ok: false, msg: '没有该道具' };
    // 永久属性类道具：离线版先看 651 硬上限；联机版无总上限，只做非负清洗。
    if (id >= 16 && id <= 19 && Math.floor(statCapRoom()) < 1) {
      return { ok: false, msg: '永久属性点已达硬上限 ' + STAT_HARD_CAP + ' 点' };
    }
    if (id === 37 && Math.floor(statCapRoom()) < 8) {
      return { ok: false, msg: '属性书需要 8 点空间，当前只剩 ' + Math.floor(statCapRoom()) + ' 点（硬上限 ' + STAT_HARD_CAP + '）' };
    }
    let msg = '使用成功';
    let conversion = null;
    let levelUps = null;
    switch (id) {
      case 1: case 2: {
        tickEnergy();
        if (S.energy >= ENERGY_HARD_CAP) return { ok: false, msg: '体力已达上限 ' + ENERGY_HARD_CAP + ' 点' };
        const per = id === 1 ? 10 : 30;
        const restored = Math.min(per, ENERGY_HARD_CAP - S.energy);
        S.energy += restored;
        if (S.energy >= S.maxEnergy) S.lastEnergyTs = nowMs();
        msg = '恢复体力' + restored + '点（' + S.energy + '/' + S.maxEnergy + '）';
        break;
      }
      case 3: case 4: case 5: case 7: case 41: case 42: case 43: case 44:
        S.propsStates[id] = 20; msg = p.name + '生效，持续20次战斗'; break;
      case 10: case 11: case 12: {
        const from = id === 10 ? 'power' : id === 11 ? 'agility' : 'speed';
        const total = S.power + S.agility + S.speed;
        if (S[from] < total * 0.25) return { ok: false, msg: '该属性占比过低，不能使用' };
        const to = param === 'power' || param === 'agility' || param === 'speed' ? param : (['power', 'agility', 'speed'].filter((x) => x !== from))[Math.floor(Math.random() * 2)];
        if (to === from) return { ok: false, msg: '请选择另一种属性' };
        S[from]--;
        S[to]++;
        conversion = { from, to, fromName: STAT_NAMES[from], toName: STAT_NAMES[to] };
        msg = '属性转换成功：' + conversion.fromName + ' → ' + conversion.toName;
        break;
      }
      case 13: {
        // 转生果现在只切换「等级是否继续提升」：冻结期间经验照常累积，
        // 再次使用时先让玩家确认预计等级，再逐级补发升级奖励。
        if (!S.levelFrozen) {
          S.levelFrozen = 1;
          msg = '等级提升已暂停：经验继续累积，再次使用转生果可恢复并领取升级奖励';
          break;
        }
        if (param !== 'confirm' && param !== true) {
          const preview = levelUpPreview();
          return { ok: false, needsUnfreezeConfirm: true, preview, msg: '确认恢复等级提升' };
        }
        S.levelFrozen = 0;
        levelUps = applyLevelUps();
        msg = levelUps.length
          ? '等级提升已恢复：升到 ' + S.level + ' 级'
          : '等级提升已恢复';
        break;
      }
      case 14: { // 生命转化丸：扣 5 点基础生命，随机 +1 力/敏/速（原版由服务端结算并回 index）
        if (S.maxHp < S.level * 9) return { ok: false, msg: '基础生命低于等级×9，不能使用' };
        const target = ['power', 'agility', 'speed'][Math.floor(Math.random() * 3)];
        S.maxHp -= 5; S[target] += 1;
        msg = '减少5点生命，增加1点' + ({ power: '力量', agility: '敏捷', speed: '速度' })[target];
        break;
      }
      case 16: S.power++; msg = '力量永久+1'; break;
      case 17: S.agility++; msg = '敏捷永久+1'; break;
      case 18: S.speed++; msg = '速度永久+1'; break;
      case 19: S.maxHp += 5; msg = '生命永久+5'; break;
      case 37: {
        const attrs = ['power', 'agility', 'speed'];
        if (!object(param) || attrs.some(attr => !Number.isSafeInteger(param[attr]) || param[attr] < 0) || attrs.reduce((sum, attr) => sum + param[attr], 0) !== 8) {
          return { ok: false, needsAllocation: true, msg: '请将8点属性分配到力量、敏捷和速度' };
        }
        for (const attr of attrs) S[attr] += param[attr];
        msg = `力量+${param.power} 敏捷+${param.agility} 速度+${param.speed}`;
        break;
      }
      case 38: { const g = 20 + Math.floor(Math.random() * 80); addGold(g); msg = `打开红包，获得${g}金松果！`; break; }
      case 47:
      case 48: {
        // 已经抽出的结果必须原样复用：弹窗有取消键，但大退 / 重开背包不能重抽。
        const pending = S.fruitChoices && S.fruitChoices[id];
        if (pending && Array.isArray(pending.options) && pending.options.length) {
          return { ok: false, needsFruitChoice: true, fruit: id, mode: pending.mode, options: pending.options, msg: '请确认这次随机结果' };
        }
        const fruit = fruitOptions(id);
        if (!fruit) {
          return { ok: false, msg: id === 47 ? '获得失败：可能已达上限或没有可学的武技' : '没有可以遗忘的武器或技能' };
        }
        if (!object(S.fruitChoices)) S.fruitChoices = {};
        S.fruitChoices[id] = { mode: fruit.mode, options: fruit.options, at: Date.now() };
        save();
        return { ok: false, needsFruitChoice: true, fruit: id, mode: fruit.mode, options: fruit.options, msg: '请确认这次随机结果' };
      }
      case 28: case 29: case 30: case 31: case 32: case 49: {
        const gift = giftMap.getValue(id);
        if (!gift) return { ok: false, msg: '礼包数据缺失' };
        if (S.level < parseInt(gift.level)) return { ok: false, msg: `需要${gift.level}级才能打开` };
        const boosted = GData.giftPackPrize ? GData.giftPackPrize(id) : null;
        const prizes = boosted || gift.prize.split('|').map((item) => {
          const [pid, num] = item.split(':').map(Number);
          return { id: pid, count: num };
        });
        const got = [];
        for (const { id: pid, count: num } of prizes) {
          if (pid === 8) { addGold(num); got.push(`金松果x${num}`); }
          else { S.props[pid] = (S.props[pid] || 0) + num; const pp = propMap.getValue(pid); got.push((pp ? pp.name : pid) + 'x' + num); }
        }
        msg = '获得：' + got.join('、');
        break;
      }
      case 80: {
        const raw = String(param == null ? '' : param);
        let set = 0;
        if (raw === 'random') set = Math.random() < 0.5 ? 71 : 72;
        else if (raw === '71' || raw === '72') set = Number(raw);
        if (!set) return { ok: false, needsBlackChoice: true, options: blackCardOptions(), msg: '请选择凤凰或圣熊' };
        const card = applyBlackCard(set);
        if (!card.ok) return card;
        msg = card.msg;
        break;
      }
      case 89: {
        const raw = String(param == null ? '' : param);
        if (!/^\d+$/.test(raw)) {
          return { ok: false, needsBlackGearChoice: true, options: blackGearBoxOptions(), msg: '请选择一件黑装' };
        }
        const box = applyBlackGearBox(Number(raw));
        if (!box.ok) return box;
        msg = box.msg;
        break;
      }
      default:
        return { ok: false, msg: '该道具不能直接使用' };
    }
    S.props[id]--;
    if (S.props[id] <= 0) delete S.props[id];
    bumpDaily('use', 1, true);
    save();
    const out = { ok: true, msg };
    if (conversion) out.conversion = conversion;
    if (levelUps) out.ups = levelUps;
    return out;
  }
  function gainRandomWS() {
    const pick = wsPool();
    if (!pick.length) return null;
    return grantWS(pick[Math.floor(Math.random() * pick.length)]);
  }
  // 还能学、且没拥有的武器/技能池（'w3'/'s7' 这种编码）。
  function wsPool() {
    if (!S) return [];
    const ownedW = S.weapons.map((w) => parseInt(w.split(':')[0]));
    const ownedS = S.skills.map((s) => parseInt(s.split(':')[0]));
    if (ownedWSCount() >= wsLimit()) return [];
    const pool = [];
    weaponsMap.each((k, v) => { if (!ownedW.includes(parseInt(v.id)) && GData.canLearn('weapon', v.id, S.level)) pool.push('w' + v.id); });
    skillsMap.each((k, v) => { if (!ownedS.includes(parseInt(v.id)) && GData.canLearn('skill', v.id, S.level)) pool.push('s' + v.id); });
    return pool;
  }
  function wsInfo(code) {
    const kind = String(code)[0] === 'w' ? 'weapon' : 'skill';
    const id = Number(String(code).slice(1));
    const def = (kind === 'weapon' ? weaponsMap : skillsMap).getValue(id);
    return def ? { kind, id, name: def.name, remark: def.remark || '', type: def.type || '' } : null;
  }
  function grantWS(code) {
    const info = wsInfo(code);
    if (!info) return null;
    S[info.kind === 'weapon' ? 'weapons' : 'skills'].push(info.id + ':1');
    return info;
  }

  function wsChoices(n) {
    const pool = wsPool();
    const want = Math.min(Math.max(1, integer(n, 3, 1)), pool.length);
    const picked = [];
    while (picked.length < want && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picked.map(wsInfo).filter(Boolean);
  }


  function fruitCode(kind, id) { return (kind === 'weapon' ? 'w' : 's') + Number(id); }
  // 这个果实「出现过 / 被取消过」的武技编码（'w3' / 's7'）。
  function fruitSeen(id) {
    if (!object(S.fruitSeen)) S.fruitSeen = {};
    if (!Array.isArray(S.fruitSeen[id])) S.fruitSeen[id] = [];
    return S.fruitSeen[id];
  }
  // 果实的可抽池子（编码）：天使=还能学的，恶魔=已拥有的武器/技能。
  // 「师父驾到」是拜师剧情技能，两个果实都永远不投放；否则恶魔果实能把它遗忘。
  function fruitPool(id) {
    const withoutMasterSkill = (code) => code !== 's' + MASTER_SKILL_ID;
    if (id === 47) return wsPool().filter(withoutMasterSkill);
    return [
      ...S.weapons.map((w) => 'w' + parseInt(w, 10)),
      ...S.skills.map((s) => 's' + parseInt(s, 10)),
    ].filter(withoutMasterSkill);
  }

  function fruitRoll(id, pool) {
    let seen = fruitSeen(id).filter((code) => pool.indexOf(code) >= 0);
    let rest = pool.filter((code) => seen.indexOf(code) < 0);
    if (!rest.length) { seen = []; rest = pool.slice(); }
    S.fruitSeen[id] = seen;
    const code = rest[Math.floor(Math.random() * rest.length)];
    return code ? wsInfo(code) : null;
  }

  function fruitOptions(id) {
    id = Number(id);
    if (id === 47) {
      const pool = fruitPool(47);
      if (!pool.length) return null;
      const info = fruitRoll(47, pool);
      return info ? { mode: 'gain', options: [info] } : null;
    }
    if (id === 48) {
      if (S.weapons.length + S.skills.length <= 1) return null;
      const info = fruitRoll(48, fruitPool(48));
      return info ? { mode: 'lose', options: [info] } : null;
    }
    return null;
  }

  function applyFruitChoice(id, kind, targetId) {
    id = Number(id); targetId = Number(targetId);
    kind = kind === 'weapon' ? 'weapon' : 'skill';
    if (kind === 'skill' && targetId === MASTER_SKILL_ID) {
      return { ok: false, msg: '「师父驾到」不能通过果实获得或遗忘' };
    }
    if (!(S.props[id] > 0)) return { ok: false, msg: '没有这个果实' };
    const pending = (S.fruitChoices && S.fruitChoices[id]) || (S.__onlineFruitChoices && S.__onlineFruitChoices[id]);
    if (pending && Array.isArray(pending.options)
      && !pending.options.some((c) => c && c.kind === kind && Number(c.id) === targetId)) {
      return { ok: false, msg: '请选择这次抽出的候选' };
    }
    const label = kind === 'weapon' ? '武器' : '技能';
    if (id === 47) {
      const info = grantWS((kind === 'weapon' ? 'w' : 's') + targetId);
      if (!info) return { ok: false, msg: '这个' + label + '暂时学不了' };
      S.props[id]--; if (S.props[id] <= 0) delete S.props[id];
      if (S.fruitChoices) delete S.fruitChoices[id];
      bumpDaily('use', 1, true);
      save();
      return { ok: true, msg: '获得了 ' + info.name + '！' };
    }
    if (id === 48) {
      const arr = kind === 'weapon' ? S.weapons : S.skills;
      const idx = arr.findIndex((x) => parseInt(x.split(':')[0]) === targetId);
      if (idx < 0) return { ok: false, msg: '没有这个' + label };
// 忘掉之后至少要留一件，否则玩家会变成赤手空拳
      if (S.weapons.length + S.skills.length <= 1) return { ok: false, msg: '至少要留下一个武器或技能' };
      const info = wsInfo((kind === 'weapon' ? 'w' : 's') + targetId);
      arr.splice(idx, 1);
      if (typeof debugForgetWS === 'function') debugForgetWS(kind, targetId);
      S.props[id]--; if (S.props[id] <= 0) delete S.props[id];
      if (S.fruitChoices) delete S.fruitChoices[id];
      bumpDaily('use', 1, true);
      save();
      return { ok: true, msg: '遗忘了 ' + ((info && info.name) || label) };
    }
    return { ok: false, msg: '这个道具不能这样用' };
  }

  function cancelFruitChoice(id) {
    id = Number(id);
    if (!(S.props[id] > 0)) return { ok: false, msg: '没有这个果实' };
    const pending = (S.fruitChoices && S.fruitChoices[id]) || (S.__onlineFruitChoices && S.__onlineFruitChoices[id]);
    const c = object(pending) && Array.isArray(pending.options) ? pending.options[0] : null;
    if (!object(c) || (c.kind !== 'weapon' && c.kind !== 'skill')) {
      return { ok: false, msg: '这次随机结果已经结算过了' };
    }
    const seen = fruitSeen(id);
    const code = fruitCode(c.kind, c.id);
    if (seen.indexOf(code) < 0) seen.push(code);
    S.props[id]--; if (S.props[id] <= 0) delete S.props[id];
    if (object(S.fruitChoices) && S.fruitChoices[id]) delete S.fruitChoices[id];
    if (object(S.__onlineFruitChoices) && S.__onlineFruitChoices[id]) {
      // 换一份对象再删：runOnSave 用旧档嵌套对象算 diff，原地删会让服务端漏发这次改动。
      S.__onlineFruitChoices = Object.assign({}, S.__onlineFruitChoices);
      delete S.__onlineFruitChoices[id];
    }
    bumpDaily('use', 1, true);
    save();
    return { ok: true, msg: '已取消：这次不' + (c.kind === 'weapon' ? '获得 ' : '遗忘 ') + (c.name || '这个武技') + '（果实已消耗）' };
  }
  // 还没选的「三选一」：升级发下来就必须选掉。
  function pendingWS() { return S && Array.isArray(S.wsPicks) ? S.wsPicks.length : 0; }

  function pendingFruitChoices() {
    if (!S) return [];
    const map = {};
    if (object(S.fruitChoices)) Object.assign(map, S.fruitChoices);
    if (object(S.__onlineFruitChoices)) Object.assign(map, S.__onlineFruitChoices);
    const out = [];
    for (const id of [47, 48]) {
      const p = map[id];
      if (!object(p) || !Array.isArray(p.options) || !p.options.length) continue;
      out.push({ fruit: id, mode: p.mode === 'lose' ? 'lose' : 'gain', options: p.options });
    }
    return out;
  }

  function supportPromptPending() { return !!(S && S.supportPrompt) && !(S && S.supportPromptShown); }
  // 取一次提示权（原子）：真待提示时立刻记「已提示」并返回 true，否则 false。
  function supportPromptTake() {
    if (!supportPromptPending()) return false;
    S.supportPromptShown = true;
    save();
    return true;
  }

  function supportPromptReset() {
    if (!S) return false;
    S.supportPrompt = true;
    S.supportPromptShown = false;
    save();
    return true;
  }
  const SUPPORT_LEVEL = SUPPORT_PROMPT_LEVEL;

  function currentWSChoices() { return pendingWS() ? (S.wsPicks[0] || []) : []; }

  function chooseWS(kind, id) {
    if (!S || !pendingWS()) return { ok: false, msg: '没有待选的武器/技能' };
    const list = S.wsPicks[0] || [];
    const hit = list.find((c) => c && c.kind === kind && Number(c.id) === Number(id));
    if (!hit) return { ok: false, msg: '这一组里没有这个选项' };
    const info = grantWS((kind === 'weapon' ? 'w' : 's') + Number(id));
    if (!info) return { ok: false, msg: '这个武器/技能暂时学不了' };
    S.wsPicks.shift();
    save();
    return { ok: true, kind: info.kind, id: info.id, name: info.name, remaining: pendingWS() };
  }

  function chooseWSRandom() {
    const got = [];
    if (!S || !pendingWS()) return { ok: true, got, remaining: 0 };
    let guard = 0;
    while (pendingWS() && guard++ < 200) {
      const list = S.wsPicks[0] || [];
      const pool = list.filter((c) => c && c.kind && !ownsWS(c.kind, c.id));
      if (!pool.length) { S.wsPicks.shift(); continue; }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const r = chooseWS(pick.kind, pick.id);
      if (!r.ok) { S.wsPicks.shift(); continue; }
      got.push(r.name);
    }
    save();
    return { ok: true, got, remaining: pendingWS() };
  }
  function ownsWS(kind, id) {
    if (!S) return false;
    const key = Number(id) + ':';
    const list = kind === 'weapon' ? S.weapons : S.skills;
    return list.some((x) => String(x).indexOf(key) === 0);
  }



  function statPoints(source, key) {
    const s = object(source) ? source : S;
    const raw = Math.max(0, Number(s && s[STAT_FIELDS[key]]) || 0);
    return key === 'hp' ? raw / HP_PER_STAT : raw;
  }

  function statShares(source) {
    const s = object(source) ? source : S;
    let total = 0;
    const raw = {};
    for (const key of SHARE_KEYS) {
      raw[key] = Math.max(0, Number(s && s[STAT_FIELDS[key]]) || 0);
      total += raw[key];
    }
    const out = {};
    for (const key of SHARE_KEYS) out[key] = total > 0 ? raw[key] / total : 1 / SHARE_KEYS.length;
    return out;
  }

  function forcedStat(source) {
    const shares = statShares(source);
    const low = SHARE_KEYS.filter((key) => shares[key] < STAT_SHARE_MIN - 1e-9);
    if (!low.length) return null;
    return low.reduce((a, b) => (shares[b] < shares[a] ? b : a));
  }

  function lowestStat(source) {
    const vals = {};
    for (const key of STAT_KEYS) vals[key] = statPoints(source, key);
    return STAT_KEYS.reduce((a, b) => (vals[b] < vals[a] ? b : a));
  }

  function grantPoint(target) {
    if (!S || !STAT_KEYS.includes(target)) return false;
    if (Math.floor(statCapRoom()) < 1) return false; // 离线版 651 硬上限；联机版 Infinity
    S[STAT_FIELDS[target]] += STAT_GAIN[target];
    return true;
  }

  // 记下「今天」自己赚到多少经验与金松果，徒弟日供按昨天这条流水结算。
  // 经验只有 gainExp 一个入口、金松果统一走 addGold()，所以两个钩子就能覆盖全部真实收益；
  const EARN_DAYS = 7;
  function trackEarn(kind, n) {
    n = Math.round(Number(n) || 0);
    if (!S || n <= 0) return;
    if (!Array.isArray(S.earnHistory)) S.earnHistory = [];
    const date = localDate();
    let row = S.earnHistory.find((d) => object(d) && d.date === date);
    if (!row) {
      row = { date, exp: 0, gold: 0 };
      S.earnHistory.push(row);
      S.earnHistory = S.earnHistory.slice(-EARN_DAYS);
    }
    row[kind] = Math.max(0, integer(row[kind], 0) + n);
  }

  function earnOn(date) {
    const row = (Array.isArray(S.earnHistory) ? S.earnHistory : []).find((d) => object(d) && d.date === date);
    return { exp: row ? Math.max(0, integer(row.exp, 0)) : 0, gold: row ? Math.max(0, integer(row.gold, 0)) : 0 };
  }

  function ensureYesterdayEarnings() {
    if (!S) return { seeded: false };
    const y = yesterdayDate(), t = localDate();
    const mine = earnOn(t);
    if (!(mine.exp > 0 || mine.gold > 0)) return { seeded: false };
    const prev = (Array.isArray(S.earnHistory) ? S.earnHistory : []).find((d) => object(d) && d.date === y);
    const cur = prev ? { exp: Math.max(0, integer(prev.exp, 0)), gold: Math.max(0, integer(prev.gold, 0)) } : null;
    if (cur && (cur.exp > 0 || cur.gold > 0)) return { seeded: false };
    if (!Array.isArray(S.earnHistory)) S.earnHistory = [];
    if (prev) { prev.exp = mine.exp; prev.gold = mine.gold; }
    else S.earnHistory.push({ date: y, exp: mine.exp, gold: mine.gold });
    S.earnHistory = S.earnHistory.slice(-EARN_DAYS);
    return { seeded: true, date: y, exp: mine.exp, gold: mine.gold };
  }

  function addGold(n, opts) {
    n = Math.round(Number(n) || 0);
    if (!S || !n) return 0;
    S.goldPoint += n;
    if (n > 0 && !(opts && opts.count === false)) trackEarn('gold', n);
    return n;
  }

  // 金杯的当日累计（竞技场席位「今日金杯」）：只记进账，花掉不减。
  // 跨天在读取/进账时按本地日期归零；字段随存档走，服务端与离线共用。
  function goldCupToday() {
    if (!S) return 0;
    return S.goldCupDate === localDate() ? Math.max(0, integer(S.goldCupToday, 0, 0)) : 0;
  }
  function addGoldCup(n) {
    const amount = Math.floor(Number(n) || 0);
    if (!S || !(amount > 0)) return 0;
    S.goldCup = Math.max(0, Number(S.goldCup) || 0) + amount;
    const date = localDate();
    if (S.goldCupDate !== date) { S.goldCupDate = date; S.goldCupToday = 0; }
    S.goldCupToday = Math.max(0, integer(S.goldCupToday, 0) + amount);
    return amount;
  }


  // 等级提升循环：gainExp 与「转生果解冻」共用，逐级发奖并返回每级增量。
  // 等级冻结（levelFrozen）时经验照常入账，但不消耗经验升级。
  function applyLevelUps() {
    const ups = [];
    if (!S || S.levelFrozen) return ups;
    while (S.level < MAX_PLAYER_LEVEL && S.exp >= GData.nextExp(S.level)) {
      S.exp -= GData.nextExp(S.level);
      S.level++;

      if (S.level >= SUPPORT_PROMPT_LEVEL) S.supportPrompt = true;
      // 1~90 级统一成长：每级 2 点随机 + 1 点系统分配（合计 3 属性）+ 5 生命。
      // 代价是金宝箱单箱上限从 16 点压到 12 点 —— 20×12 = 240，正好等于
      const growth = { power: 0, agility: 0, speed: 0, hp: 5 };
      for (let point = 0; point < FREE_POINT_RANDOM; point++) {
        const attr = ['power', 'agility', 'speed', 'hp'][Math.floor(Math.random() * 4)];
        growth[attr] += attr === 'hp' ? 5 : 1;
      }
      const { power: pw, agility: ag, speed: sp, hp } = growth;
      S.power += pw; S.agility += ag; S.speed += sp; S.maxHp += hp;

      let autoPoint = null;
      const forced = forcedStat();
      const pointRoom = Math.floor(statCapRoom());
      if (pointRoom >= 1) {
        const target = forced || STAT_KEYS[Math.floor(Math.random() * STAT_KEYS.length)];
        if (grantPoint(target)) autoPoint = target;
      }
      // pointRoom < 1：已经顶到 651 硬上限（正常升级不会出现，只有调试/旧档超额时才会），
      // 这一点不再发放，避免属性越过上限。
      // 71~90 级：每级 1 个金宝箱；`levelChests` 是账号累计上限 20，旧转生档也不会重复发。
      const chestCap = MAX_PLAYER_LEVEL - 70;
      const chest = S.level > 70 && integer(S.levelChests, 0) < chestCap ? 1 : 0;
      if (chest) {
        S.props[90] = (S.props[90] || 0) + chest;
        S.levelChests = integer(S.levelChests, 0) + chest;
      }
// 体力上限按等级重算（2~3 级每级 +3、4~20 每级 +2、21~90 每级 +1，满级 200）
      S.maxEnergy = Math.max(S.maxEnergy, energyCapForLevel(S.level));
      const choices = GData.WS_LEVELS.includes(S.level) ? wsChoices(3) : [];
      if (choices.length) S.wsPicks.push(choices);
      // 联机版旧版固定等级静默发属性书：直接进背包，不写 gifts / attributeBook，
      // 升级弹窗不展示；离线版 ATTRIBUTE_BOOK_LEVELS 为空，不会走到这里。
      const book = GData.ATTRIBUTE_BOOK_LEVELS.includes(S.level);
      if (book) S.props[37] = Math.min(PROP_HARD_CAP, (S.props[37] || 0) + 1);
      // （见 docs/奖励与经济.md 的 D 段）。联机版按「只能少不能多」整条去掉：
      if (!ONLINE_RULES && S.level === 5 && !S.reborn) addGold(50);
      // 静默进背包，不写进 gifts —— 升级弹窗只展示属性/三选一，不展示这瓶药。
      if (ONLINE_RULES) {
        const potion = levelStaminaPotion(S.level);
        if (potion) S.props[2] = Math.min(PROP_HARD_CAP, (S.props[2] || 0) + potion);
      }
      const gifts = ONLINE_RULES ? [] : (GData.levelGift ? GData.levelGift(S.level) : []).map((g) => {
        const item = propMap.getValue(g.id);
        S.props[g.id] = (S.props[g.id] || 0) + g.count;
        return { id: g.id, count: g.count, name: item ? item.name : '道具' };
      });
      ups.push({
        level: S.level, power: pw, agility: ag, speed: sp, hp,
        reward: null,
        rewardId: null,
        rewardKind: null,
        wsChoice: choices.length,
        attributeBook: false,
        silentBook: book,
        chest,
        autoPoint,
        autoPointName: autoPoint ? STAT_NAMES[autoPoint] : null,
        gifts,
      });
    }
    return ups;
  }

  // 解冻前给玩家看的「预计升到几级」：只读，不改存档。
  function levelUpPreview() {
    if (!S) return { level: 1, levels: 0, exp: 0, need: GData.nextExp(1), frozen: false };
    const current = Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(S.level, 1, 1)));
    const totalExp = Math.max(0, integer(S.exp, 0));
    let level = current, exp = totalExp;
    while (level < MAX_PLAYER_LEVEL && exp >= GData.nextExp(level)) {
      exp -= GData.nextExp(level);
      level++;
    }
    return {
      level, levels: level - current, exp: totalExp, need: GData.nextExp(current),
      frozen: S.levelFrozen === 1,
    };
  }

  function levelFrozen() { return !!(S && S.levelFrozen); }

  function gainExp(amount, opts) {
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const gained = Math.round(amount);
    S.exp += gained;
    if (!(opts && opts.noTrack)) trackEarn('exp', gained);
    const ups = applyLevelUps();
    save();
    return ups;
  }

  function consumeEnergy(n) {
    n = Number(n);
    if (!Number.isSafeInteger(n) || n < 0) return false;
    tickEnergy();
    if (debugOn('infiniteEnergy')) return true;
    if (S.energy < n) return false;
    S.energy -= n;
    bumpDaily('energy', n, true);
    save();
    return true;
  }
  // 药丸分两类：属性丸（力/敏/速，含超级版）与经验丸。
  // `tickPropStates` 仍是普通挑战（一场两类全扣）与经验结算（只扣 exp）的公共入口。
  const STAT_PILL_IDS = [3, 4, 5, 41, 42, 43];
  const EXP_PILL = { 7: 0.4, 44: 0.6 };

  function tickPropStates(opts) {
    const kind = opts && opts.kind;
    const keys = kind === 'stat' ? STAT_PILL_IDS
      : kind === 'exp' ? Object.keys(EXP_PILL)
        : Object.keys(S.propsStates);
    for (const k of keys) {
      if (Number(S.propsStates[k]) > 0) S.propsStates[k]--;
    }
  }

  function expBoostPct() {
    let pct = 0;
    for (const id of Object.keys(EXP_PILL)) if (S.propsStates[id] > 0) pct += EXP_PILL[id] * 100;
    return pct;
  }

  function gainExpWithBoost(amount) {
    const boosted = Math.round(Number(amount || 0) * (1 + expBoostPct() / 100));
    return { exp: boosted, ups: gainExp(boosted) };
  }


  function composeSeed(seedId) {
    seedId = Number(seedId);
    const fruit = (seedId === 45) ? 47 : (seedId === 46) ? 48 : 0;
    if (!fruit) return { ok: false, msg: '这个种子不能合成' };
    if ((S.props[seedId] || 0) < 10) return { ok: false, msg: '需要 10 个' + (propMap.getValue(seedId) || {}).name };
    if (S.goldPoint < 50) return { ok: false, msg: '合成需要 50 金松果' };
    S.props[seedId] -= 10;
    S.goldPoint -= 50;
    S.props[fruit] = Math.min(PROP_HARD_CAP, (S.props[fruit] || 0) + 1);
    save();
    const item = propMap.getValue(fruit);
    return { ok: true, msg: '合成成功：' + (item ? item.name : '果实'), propId: fruit, name: item ? item.name : '果实' };
  }


  function composeConvertPill() {
    // 属性碎片只换 10/11/12 的力量/敏捷/速度转化丸；永久属性只能从金杯商店
    // goods 7-10 按开服累计额度兑换，不能靠天梯碎片绕过限购。
    const need = GData.CONVERT_SHARD_COST;
    const shard = GData.CONVERT_SHARD_ID;
    if ((S.props[shard] || 0) < need) return { ok: false, msg: '需要 ' + need + ' 个' + GData.CONVERT_SHARD_NAME };
    if (S.goldPoint < 50) return { ok: false, msg: '合成需要 50 金松果' };
    S.props[shard] -= need;
    // 单机存档保留 0 计数；联机镜像按「没有该道具」处理，避免背包出现 0 个的条目。
    if (ONLINE_RULES && S.props[shard] <= 0) delete S.props[shard];
    S.goldPoint -= 50;
    const pills = GData.CONVERT_PILLS;
    const got = pills[Math.floor(Math.random() * pills.length)];
    S.props[got] = Math.min(PROP_HARD_CAP, (S.props[got] || 0) + 1);
    save();
    const item = propMap.getValue(got);
    return { ok: true, msg: '合成成功：' + (item ? item.name : '转化丸'), prop: got, name: item ? item.name : '转化丸' };
  }


  const VIP_LEVELS = [   // [等级, 被动经验上限/天, 体力恢复倍率]
    [1, 150, 1.1], [2, 150, 1.2], [3, 200, 1.2], [4, 200, 1.3], [5, 250, 1.3],
    [6, 300, 1.4], [7, 300, 1.4], [8, 350, 1.5], [9, 350, 1.5], [10, 400, 1.5],
  ];
  const VIP_LEVEL_EXP = [3, 5, 15, 30, 60, 60, 60, 60, 100];
  const VIP_MAX_LEVEL = 10;
  const VIP_ENERGY_BONUS = 60;   // 特权 8：在当前等级应有的体力上限之上再 +60
  const VIP_GEAR_BONUS = 6;
  const VIP_PLANS = [Object.freeze({ days: 7, gold: 150 }), Object.freeze({ days: 30, gold: 500 })];
  const GEAR_CAPACITY = 100;

  function vipState() {
    if (!S.vip || typeof S.vip !== 'object') S.vip = { level: 1, exp: 0, until: 0, capAdded: 0, capApplied: false, lastDaily: '' };
    return S.vip;
  }
  function vipUntil() { return Math.max(0, Number(vipState().until) || 0); }
  function vipActive() { return vipUntil() > nowMs(); }
  function vipLevel() { return vipActive() ? Math.max(1, Math.min(VIP_MAX_LEVEL, Math.floor(Number(vipState().level) || 1))) : 0; }
  function vipRow(level) { return VIP_LEVELS[Math.max(1, Math.min(VIP_MAX_LEVEL, level)) - 1]; }
  function vipRegenMul() { const lv = vipLevel(); return lv ? vipRow(lv)[2] : 1; }
  function vipPassiveExpCap() { const lv = vipLevel(); return lv ? vipRow(lv)[1] : 0; }
  function vipExpNeed() { const lv = vipLevel() || 1; return VIP_LEVEL_EXP[Math.min(lv, VIP_MAX_LEVEL) - 1]; }
  function vipDaysLeft() { return Math.max(0, Math.ceil((vipUntil() - nowMs()) / 86400000)); }

  function gearCapacity() { return GEAR_CAPACITY + (vipState().capApplied ? VIP_GEAR_BONUS : 0); }
  // VIP 生效时的体力上限 =「当前等级应有的上限」+ 60（特权 8）。
  function vipEnergyCap() { return energyCapForLevel(S.level) + VIP_ENERGY_BONUS; }
  // 特权 8：VIP 期间体力上限在等级上限之上 +60，到期原样退回。
  // 只搬动「上限本身」的 ±60 变化量，所以期间升级、或者被其它来源抬上去的
  // 上限都不会被误算；退回后也不会低于当前等级应有的基础上限。
  function syncVipEnergyCap() {
    const v = vipState(), on = vipActive(), base = energyCapForLevel(S.level);
    if (on !== v.capApplied) {
      const before = base + (v.capApplied ? VIP_ENERGY_BONUS : 0);
      const after = base + (on ? VIP_ENERGY_BONUS : 0);
      v.capApplied = on;
      v.capAdded = on ? VIP_ENERGY_BONUS : 0;
      S.maxEnergy = Math.max(base, S.maxEnergy + (after - before));
    } else if (on) {
// 期间升级：保险起见把上限抬到「新等级 + 60」
      const target = vipEnergyCap();
      if (S.maxEnergy < target) S.maxEnergy = target;
      v.capAdded = VIP_ENERGY_BONUS;
    }
// 只按硬上限收口：药剂顶上去的超出部分要保住，不能因为上限变化被清掉
    if (S.energy > ENERGY_HARD_CAP) S.energy = ENERGY_HARD_CAP;
    return S.maxEnergy;
  }

  function tickVipDaily() {
    const v = vipState();
    if (!vipActive()) return { gained: false };
    const today = localDate();
    if (v.lastDaily === today) return { gained: false };
    v.lastDaily = today;
    v.exp = (Number(v.exp) || 0) + 1;
    let leveled = 0;
    while (v.level < VIP_MAX_LEVEL && v.exp >= VIP_EXP_NEED(v.level)) { v.exp -= VIP_EXP_NEED(v.level); v.level++; leveled++; }
    if (v.level >= VIP_MAX_LEVEL) v.exp = 0;
    save();
    return { gained: true, level: v.level, leveled: leveled };
  }
  function VIP_EXP_NEED(level) { return VIP_LEVEL_EXP[Math.max(1, Math.min(VIP_MAX_LEVEL, Math.floor(Number(level) || 1))) - 1]; }
  // 购买/续期超级松鼠。days 必须命中 VIP_PLANS。
  function buyVip(days) {
    const plan = VIP_PLANS.find((p) => p.days === Number(days));
    if (!plan) return { ok: false, msg: '没有这个档位' };
    if (S.goldPoint < plan.gold) return { ok: false, msg: '金松果不足，需要 ' + plan.gold + ' 个' };
    S.goldPoint -= plan.gold;
    const v = vipState();
    const base = Math.max(Date.now(), vipUntil());
    v.until = base + plan.days * 86400000;
    if (!v.level) v.level = 1;
    syncVipEnergyCap();
    save();
    return { ok: true, msg: '已成为超级松鼠 ' + plan.days + ' 天', until: v.until, level: v.level };
  }

  function grantVip(days, level) {
    const v = vipState();
    v.until = Math.max(Date.now(), vipUntil()) + Math.max(1, Number(days) || 1) * 86400000;
    if (level) v.level = Math.max(1, Math.min(VIP_MAX_LEVEL, Number(level)));
    if (!v.level) v.level = 1;
    syncVipEnergyCap(); save();
    return { until: v.until, level: v.level };
  }


  // 好友只是本地保存的一份对手快照（名字 + 等级 + 三维），可以切磋，不连接真实玩家。
  // 原版 ssfight 没有好友数量上限：`MainMovie.as` 的 `getFriends`（:2609-2705）把
  // 服务端 `<friends>` 整份读进 `friendsArray`，`showMyFriends`（:13204）按 4 行/页翻页，
  // 抓包 `friends.do?order=2` 里能拿到 142 位好友（`unpacked/05-服务器协议/抓包原文/new/023…`）。
  const FRIEND_LIMIT = 50;
  const friendLimit = () => FRIEND_LIMIT;
  function friendList() { if (!Array.isArray(S.friends)) S.friends = []; return S.friends; }
  function friendOf(name) { return S.friends.find((f) => f.name === name) || null; }

  function addFriend(foe) {
    const name = foe && foe.name ? String(foe.name).trim().slice(0, 20) : '';
    if (!name) return { ok: false, msg: '好友信息无效' };
    if (friendOf(name)) return { ok: false, msg: '【' + name + '】已经是好友了' };

    // 师徒与好友是两套关系：成为师徒时服务端会把双方加进好友（`force` 是给这条自动关系
    // 用的，可越过 50 人上限），手动删好友也不会反过来拆师徒。
    if (!foe.force && S.friends.length >= FRIEND_LIMIT) return { ok: false, msg: '好友已满（' + FRIEND_LIMIT + ' 位），先删掉几位吧' };
    const accountId = Math.max(0, integer(foe.accountId != null ? foe.accountId : foe.remoteId, 0));
    S.friends.push({
      name,
      accountId, remoteId: accountId,
      snapshotId: String(foe.snapshotId || ''),
      level: Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(foe.level, 1, 1))),
      power: integer(foe.power, 1, 1), agility: integer(foe.agility, 1, 1), speed: integer(foe.speed, 1, 1),
      hp: integer(foe.hp != null ? foe.hp : foe.maxHp, 1, 1),
      note: typeof foe.note === 'string' ? foe.note.slice(0, 12) : '',
      // 好友的穿戴、武器与技能也一起存下来：经典模式的挑战页要把好友自己的装备贴到右侧立绘上、
      // 并显示它的战斗力（原版这两项都来自服务端下发的 `wearsList` / `totalharm`）。
      // ⚠ `genAI` 抽出来的装备只有 `{id, ext, used}`、没有 `type` —— 这里顺手把部位补上
      gears: normalizeFoeGears(foe.gears),
      weapons: (foe.weapons || []).slice(0, 8),
      skills: (foe.skills || []).slice(0, 16),
      since: localDate(),
    });
    save();
    return { ok: true, msg: '已把【' + name + '】加为好友', friend: friendOf(name), count: S.friends.length };
  }
  // 老档里的好友没有 `gears` / `weapons` / `skills`（这三个字段是后来才陆续落存档的）：
  // 第一次读到时就按它的等级补一份（走 `genAI` 同一条随机路，与"推荐好友"一致），并写回存档。
  function ensureFriendLoadout(f) {
    if (!f) return f;
    const needGears = !Array.isArray(f.gears);
    const needWeapons = !Array.isArray(f.weapons);
    const needSkills = !Array.isArray(f.skills);
    if (!needGears && !needWeapons && !needSkills) return f;
    try {
      const roll = genAI(Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(f.level, 1, 1))), '', { gearSelfLevel: true });
      if (needGears) f.gears = normalizeFoeGears(roll.gears);
      if (needWeapons) f.weapons = (roll.weapons || []).slice(0, 8);
      if (needSkills) f.skills = (roll.skills || []).slice(0, 16);
      // ⚠ 只补装备 / 武器 / 技能，绝不要碰三维：`f` 可能是师父 / 徒弟那一行
    } catch (e) {
      if (needGears) f.gears = [];
      if (needWeapons) f.weapons = [];
      if (needSkills) f.skills = [];
    }
    try { save(); } catch (e) {}
    return f;
  }
  function removeFriend(name) {
    const at = S.friends.findIndex((f) => f.name === name);
    if (at < 0) return { ok: false, msg: '没有这位好友' };
    const [gone] = S.friends.splice(at, 1);
    if (object(S.friendMessages)) delete S.friendMessages[gone.name];
    save();
    return { ok: true, msg: '已把【' + gone.name + '】移出好友', count: S.friends.length };
  }
  // 好友留言（本地离线版）
  // 离线版没有服务端，这里落进存档：`friendMessages[好友名] = [{text, at}]`。
  const FRIEND_MESSAGE_MAX = 50;
  function friendMessages(name) {
    const who = String(name || '').trim();
    const all = object(S.friendMessages) ? S.friendMessages : {};
    const list = Array.isArray(all[who]) ? all[who] : [];
    return list.slice(-20).map((m) => ({ text: String(m.text || ''), at: Number(m.at) || 0 }));
  }
  function leaveFriendMessage(name, text) {
    const who = String(name || '').trim().slice(0, 20);
    const body = String(text == null ? '' : text).trim().slice(0, 80);
    if (!who) return { ok: false, msg: '好友信息无效' };
    if (!friendOf(who)) return { ok: false, msg: '只有好友才能留言' };
    if (!body) return { ok: false, msg: '留言不能为空' };
    if (!object(S.friendMessages)) S.friendMessages = {};
    const list = Array.isArray(S.friendMessages[who]) ? S.friendMessages[who] : [];
    list.push({ text: body, at: Date.now() });
    S.friendMessages[who] = list.slice(-FRIEND_MESSAGE_MAX);
    save();
    return { ok: true, msg: '留言已保存', list: friendMessages(who) };
  }
  // 把好友快照还原成可以战斗的对手对象（切磋用）。
  // ⚠ 武器 / 技能必须一起带进战斗：`Sim` 的出手模型是「武器 / 技能 / 普攻」三方权重竞争，
  // 老档缺字段时先走 `ensureFriendLoadout()` 就地补全（与挑战页右侧展示共用同一份快照）。
  function friendFoe(friend) {
    if (!friend) return null;
    const full = ensureFriendLoadout(friend) || friend;
    return {
      name: full.name, level: full.level, power: full.power, agility: full.agility, speed: full.speed,
      hp: full.hp, maxHp: full.hp, baseStats: { power: full.power, agility: full.agility, speed: full.speed, hp: full.hp },
      weapons: (full.weapons || []).slice(), skills: (full.skills || []).slice(),
      gears: (full.gears || []).slice(),
      isAI: true, effects: {}, friend: true,
    };
  }

  function rollFriendCandidates(count) {
    const n = Math.max(1, Math.min(8, Math.round(Number(count) || 3)));
    const out = [];
    for (let i = 0; i < n; i++) {
      const level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, S.level + Math.floor(Math.random() * 7) - 2));
      out.push(genAI(level, '', { levelJitter: 1, gearSelfLevel: true }));
    }
    return out;
  }


  // 随机挑战经验（2026-10 下调）：同级收益整体降低，等级差带来的增幅也大幅收窄。
  // 竞技场（冠军 150／30 体力）保持不变 —— 它是 4 人两轮、要赢才拿满，
  const CHALLENGE_EXP_BASE = 16;
  const CHALLENGE_EXP_PER_LEVEL = 0.55;
  const CHALLENGE_EXP_CAP_LEVEL = 20;
  const EXP_DIFF_STEP = 0.09;
  const EXP_DIFF_TIGHTEN = 0.78;
  const EXP_DIFF_FLOOR = 0.3;
  const EXP_DIFF_CAP = 2.2;
  const ARENA_CHAMPION_EXP = 150;
  const ARENA_ENERGY_COST = 30;
  const ARENA_EXP_PER_ENERGY = ARENA_CHAMPION_EXP / ARENA_ENERGY_COST;
  // 一次主动挑战胜利的经验期望（不含随机浮动与经验丸）。
  // 所以同级别挑战的经验期望不变。
  function challengeExp(foeLevel, myLevel) {
    const mine = Math.max(1, Math.round(Number(myLevel) || (S && S.level) || 1));
    const diff = Math.max(-15, Math.min(15, Math.round(Number(foeLevel) || mine) - mine));
    const base = CHALLENGE_EXP_BASE + Math.min(mine, CHALLENGE_EXP_CAP_LEVEL) * CHALLENGE_EXP_PER_LEVEL;
    const linear = Math.max(EXP_DIFF_FLOOR, Math.min(EXP_DIFF_CAP, 1 + diff * EXP_DIFF_STEP));
    const mult = Math.pow(linear, EXP_DIFF_TIGHTEN);
    return Math.round(base * mult);
  }

  const CHALLENGE_DIFF_RANGE = [-1, 3];

  function challengeFightsPerLevel(level) {
    const gain = challengeExp(level, level);
    return gain > 0 ? GData.nextExp(level) / gain : Infinity;
  }
  function fightReward(win, opts) {
    opts = opts || {};
    const foeLevel = Math.max(1, Math.floor(Number(opts.foeLevel) || (S && S.level) || 1));
    const expBase = win
      ? Math.round(challengeExp(foeLevel, S.level) * (0.9 + Math.random() * 0.2))
      : Math.max(4, Math.round(challengeExp(foeLevel, S.level) * 0.08));
    const useProps = opts.useProps !== false;
    const expMul = 1 + (useProps ? expBoostPct() : 0) / 100;
    const gold = win ? 3 + Math.floor(Math.random() * 5) : (Math.random() < 0.3 ? 1 : 0);
    addGold(gold);
    const ups = gainExp(expBase * expMul);
    if (useProps) tickPropStates();
    save();
    return { exp: Math.round(expBase * expMul), gold, ups };
  }

  // 输掉的挑战记在 S.battles 里，玩家可以拿录像里记下的对手数据再打一次。
  // 但远低于正常赢一场，所以不会变成刷经验的入口。每条记录只能复仇成功一次。
  const REVENGE_EXP_RATIO = 0.35;
  function revengeReward(foeLevel) {
    const level = Math.max(1, Math.floor(Number(foeLevel) || (S && S.level) || 1));
    const full = challengeExp(level, (S && S.level) || 1);
    const exp = Math.max(4, Math.round(full * REVENGE_EXP_RATIO));
    const gold = 1 + Math.floor(Math.random() * 3);
    addGold(gold);
    const ups = gainExp(exp);
    save();
    return { exp, gold, ups };
  }

  function markRevenged(id) {
    const battle = (S.battles || []).find((b) => b && b.id === id);
    if (!battle || battle.revenged) return false;
    battle.revenged = Date.now();
    save();
    return true;
  }
  // 复仇信息：第 n 次复仇要 `(n+1)*20` 金松果。
  // `cups` 是上限，实际值由界面在确认时掷一次（0 或 1），确认文案与结算共用同一次结果。
  function revengeInfo(id) {
    const battle = (S.battles || []).find((b) => b && b.id === id);
    const n = Math.max(0, Math.floor(Number(battle && battle.revengeCount) || 0));
    const ladder = !!(battle && battle.kind === 'rank');

    const cups = ONLINE_RULES ? (n + 1) * 5 + 3 : (ladder ? 1 : 0);
    return { count: n, cost: (n + 1) * 20, ladder, cups, cupsMin: 0, revenged: !!(battle && battle.revenged) };
  }
  function noteRevenge(id) {
    const battle = (S.battles || []).find((b) => b && b.id === id);
    if (!battle) return 0;
    battle.revengeCount = Math.max(0, Math.floor(Number(battle.revengeCount) || 0)) + 1;
    save();
    return battle.revengeCount;
  }



  const AI_PREFIX = ['松果', '橡果', '坚果', '瓜子', '松针', '尾巴', '树梢', '森林', '飞天', '闪电', '暴躁', '萌萌',
    '快乐', '无敌', '狂战', '吃瓜', '鼠胆', '大尾', '老', '小', '铁齿', '铜牙', '旋风', '疾风'];
  const AI_CORE = ['小弟', '小鼠', '大侠', '无双', '王者', '姐姐', '妹妹', '群众', '英雄', '达人', '杀手', '猎手',
    '终结者', '收藏家', '舞者', '王子', '公主', '一霸', '战神', '掌门', '小旋风', '大魔王', '掌门人', '小队长'];
  const AI_NICK = ['吱吱喳喳', '鼠你最棒', '鼠不尽的快乐', '鼠来运转', '松鼠妹妹', '啃果群众', '尾巴翘翘', '闪电鼠',
    '吃瓜小鼠', '鼠胆英雄', '森林一霸', '松果收藏家', '暴躁小鼠', '快乐松鼠', '鼠大王', '松涛依旧', '坚果猎人',
    '瓜子杀手', '老松鼠', '鼠门弄斧', '松间明月', '大尾巴狼', '树梢舞者', '松针小王子', '橡果终结者'];

  const AI_TITLE = ['', '', '', '', '的师傅', '的师兄', '的宿敌', '二世'];
  // 后面的字会被字段框裁掉 —— 所以不再生成 8~9 个字的「前缀+核心+称号」。
  const AI_NAME_MAX = 7;

  // 按汉字个数截断（只有兜底用；正常组合在生成时就保证放得下）。
  function clipAIName(name) {
    const chars = [...String(name == null ? '' : name)];
    return chars.length > AI_NAME_MAX ? chars.slice(0, AI_NAME_MAX).join('') : chars.join('');
  }

  function fitAIName(name, suffix) {
    const base = String(name == null ? '' : name);
    const extra = String(suffix == null ? '' : suffix);
    if (!extra) return base;
    return [...base + extra].length <= AI_NAME_MAX ? base + extra : base;
  }

  // 随机生成一个对手名字：固定昵称池或「前缀+核心词」，少数带称号。
  function randomAIName(rng) {
    const r = typeof rng === 'function' ? rng : Math.random;
    if (r() < 0.3) return clipAIName(AI_NICK[Math.floor(r() * AI_NICK.length)]);
    const name = AI_PREFIX[Math.floor(r() * AI_PREFIX.length)] + AI_CORE[Math.floor(r() * AI_CORE.length)];
    const title = AI_TITLE[Math.floor(r() * AI_TITLE.length)];
    return fitAIName(name, title);
  }

  // · 上限：同一等级一个可达到的高配玩家总属性：满成长 + 永久来源（金宝箱/神迹/天梯丸）
  // 因此它是一个保守的“理论上限”，敌人不会超过真正的最深养成。
  // 两个上下限都随等级单调增长；随机对手在生成完成后按总属性夹到 [下限, 上限]。
  const FOE_TOTAL_HP_DIV = 5;
  const FOE_TOTAL_CACHE = new Map();


  function foeTotalStats(foe) {
    if (!foe) return 0;
    return (Number(foe.power) || 0) + (Number(foe.agility) || 0)
      + (Number(foe.speed) || 0) + (Number(foe.hp) || 0) / FOE_TOTAL_HP_DIV;
  }
  // 现代随机战斗的「查看对手」：把 foe 上的武技/装备原始字段翻成可读详情。
  function foeLoadout(foe) {
    if (!foe) return null;
    const parseWS = (entry) => {
      let id = 0, level = 1;
      if (typeof entry === 'string') {
        const p = entry.split(/[:,]/);
        id = Number(p[0]) || 0;
        level = Math.max(1, Number(p[1]) || 1);
      } else if (entry && typeof entry === 'object') {
        id = Number(entry.id) || 0;
        level = Math.max(1, Number(entry.level) || 1);
      }
      return { id, level };
    };
    const weapons = ((foe.weapons) || []).map((entry) => {
      const w = parseWS(entry);
      const def = weaponsMap.getValue(w.id);
      return { id: w.id, level: w.level, name: def ? def.name : ('武器#' + w.id), type: def ? def.type : '' };
    });
    const skills = ((foe.skills) || []).map((entry) => {
      const s = parseWS(entry);
      const def = skillsMap.getValue(s.id);
      return { id: s.id, level: s.level, name: def ? def.name : ('技能#' + s.id), type: def ? def.type : '' };
    });
    const gears = ((foe.gears) || []).map((g) => {
      const info = gearInst(g.id, g.ext, g.attr);
      if (!info) return null;
      const set = gearSetMap.getValue(info.setId);
      const gemLv = g.gem && gemLevel(g.gem.id);
      const rawQuality = Number(g.quality != null ? g.quality : info.quality);
      return {
        id: info.id, name: info.name, type: info.type,
        part: ['头巾', '手套', '衣服', '鞋子'][info.type] || '装备',
        quality: g.orange === true ? 4 : (Number.isFinite(rawQuality) ? rawQuality : 0),
        orange: g.orange === true,
        setName: set ? set.name : '',
        attrName: info.attrName, abilityVal: info.abilityVal,
        ext: extTextForGear(g),
        gem: gemLv ? { level: gemLv, percent: gemPercent(gemLv), total: gemAffixTotal(gemLv), units: gemUnitsForGear(g) } : null,
      };
    }).filter(Boolean);
    return {
      name: foe.name || '', level: Number(foe.level) || 1,
      stats: {
        power: Number(foe.power) || 0, agility: Number(foe.agility) || 0,
        speed: Number(foe.speed) || 0, hp: Number(foe.hp) || 0, maxHp: Number(foe.maxHp) || Number(foe.hp) || 0,
      },
      weapons, skills, gears,
      pets: Array.isArray(foe.pets) ? foe.pets.map((p) => ({ name: p.name, grade: p.grade, level: p.level, skillId: p.skillId })) : [],
    };
  }

  function aiToolMaxLevel(level) {
    const lv = Math.max(1, Math.floor(Number(level) || 0));
    let hi = 1;
    while (hi < 15 && Number(upgradeMap.getValue(hi).levelLimit) <= lv) hi++;
    return hi;
  }

  function playerNormalTotal(level) {
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(level) || 1)));
    const growth = 22 + (lv - 1) * 4;
    const curve = 3 * GData.stagePlayerStat(lv) + GData.stagePlayerHp(lv) / FOE_TOTAL_HP_DIV;
    return Math.ceil(Math.max(growth, curve));
  }
  // 该等级可达到的高配玩家总属性（保守上限；不含无限属性道具/幻兽）。
  function playerMaxTotal(level) {
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(level) || 1)));
    const growth = 22 + (lv - 1) * 4;

    const permanent = Math.max(0, Math.min(20, lv - 70)) * 12
      + (lv >= 25 ? 29 : 0) + (lv >= 30 ? 4 : 0);

    const toolMax = aiToolMaxLevel(lv);
    let passive = 0;
    for (const id of [1, 2, 3, 4]) passive += Math.max(0, Number(GData.passiveBonus(id, toolMax)) || 0);

    const gemMax = lv >= 45 ? Math.min(7, 1 + Math.floor((lv - 45) / 6)) : 0;
    const gemMul = gemMax ? 1 + gemPercent(gemMax) / 100 : 1;
    const best = [0, 0, 0, 0];
    for (const row of (GData.GEAR_BASE || [])) {
      const baseAttr = Number(row && row[5]) || 0;
      if (!(baseAttr > 0)) continue;
      const info = gearInst(row[0], [], Math.ceil(baseAttr * (1 + GEAR_ATTR_JITTER)));   // 主属性 +5% 上限
      if (!info || Number(info.useLevel) > lv) continue;
      const type = Number(info.type);
      if (!(type >= 0 && type < 4)) continue;
      const val = Math.round((Number(info.abilityVal) || 0) * gemMul);
      if (val > best[type]) best[type] = val;
    }
    const gear = best.reduce((sum, val) => sum + val, 0);
    return Math.ceil(growth + permanent + passive + gear);
  }

  function playerTotalBounds(level) {
    const lv = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(level) || 1)));
    let hit = FOE_TOTAL_CACHE.get(lv);
    if (hit) return hit;
    const normal = playerNormalTotal(lv);
    const max = Math.max(normal, playerMaxTotal(lv));
    hit = { level: lv, normal: normal, max: max };
    FOE_TOTAL_CACHE.set(lv, hit);
    return hit;
  }

  function addFoeTotalPoints(foe, points) {
    let n = Math.max(0, Math.ceil(Number(points) || 0));
    const order = ['power', 'agility', 'speed', 'hp'];
    let i = 0;
    while (n-- > 0) {
      const key = order[i++ % order.length];
      if (key === 'hp') foe.hp += 5;
      else foe[key] += 1;
    }
    foe.maxHp = foe.hp;
  }

  function removeFoeTotalPoints(foe, points) {
    let n = Math.max(0, Math.ceil(Number(points) || 0));
    const order = ['power', 'agility', 'speed', 'hp'];
    let guard = 0;
    while (n > 0 && guard++ < 10000) {
      order.sort((a, b) => (Number(foe[b]) || 0) - (Number(foe[a]) || 0));
      let done = false;
      for (const key of order) {
        if (key === 'hp') {
          if ((Number(foe.hp) || 0) > 5) { foe.hp -= 5; done = true; break; }
        } else if ((Number(foe[key]) || 0) > 1) {
          foe[key] -= 1;
          done = true;
          break;
        }
      }
      if (!done) break;
      n--;
    }
    foe.maxHp = foe.hp;
  }

  function scaleFoeToTotal(foe, target, limit) {
    const want = Math.max(4, Math.round(Number(target) || 0));
    const before = foeTotalStats(foe);
    if (!(before > 0)) return;
    const factor = want / before;
    for (const key of ['power', 'agility', 'speed']) {
      foe[key] = Math.max(1, Math.round((Number(foe[key]) || 1) * factor));
    }
    foe.hp = Math.max(5, Math.round((Number(foe.hp) || 5) * factor));
    foe.maxHp = foe.hp;
    const total = foeTotalStats(foe);
    if (limit === 'max') {
      if (total > want + 1e-9) removeFoeTotalPoints(foe, total - want);
    } else if (total < want - 1e-9) {
      addFoeTotalPoints(foe, want - total);
    }
  }
  // 生成出口统一夹总属性：低于正常玩家总属性就抬上来，高于高配玩家上限就压下去。
  function applyFoeTotalBounds(foe) {    if (!foe) return foe;
    const level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, Math.floor(Number(foe.level) || 1)));
    const bounds = playerTotalBounds(level);
    const total = foeTotalStats(foe);
    if (total < bounds.normal - 1e-9) scaleFoeToTotal(foe, bounds.normal, 'min');
    else if (total > bounds.max + 1e-9) scaleFoeToTotal(foe, bounds.max, 'max');
    foe.maxHp = Math.max(1, Math.round(Number(foe.hp) || 1));
    return foe;
  }

  // 生成一个对手。
  function genAI(level, nameSuffix, opts) {
    opts = opts || {};
    level = integer(level, 1, 1);
    const jitter = Number.isFinite(opts.levelJitter) ? Math.max(0, Math.floor(opts.levelJitter)) : 2;
    const rolled = jitter ? integer(level + Math.floor(Math.random() * (2 * jitter + 1)) - jitter, 1, 1) : level;
// 所以在出口处统一夹一次（所有对手生成都走这里）。
    const finalLevel = Math.min(MAX_PLAYER_LEVEL, Math.max(integer(opts.minLevel, 1, 1), rolled));

    const name = opts.name ? String(opts.name) : fitAIName(randomAIName(), nameSuffix);
    const base = GData.initialStats();
    for (let lv = 2; lv <= finalLevel; lv++) {
      base.maxHp += 5;
      for (let point = 0; point < FREE_POINT_RANDOM; point++) {
        const key = ['power', 'agility', 'speed', 'maxHp'][Math.floor(Math.random() * 4)];
        base[key] += key === 'maxHp' ? 5 : 1;
      }
      const forced = forcedStat(base);
      let freeKey = opts.freePointBias;
      if (freeKey === 'lowest' || !STAT_KEYS.includes(freeKey)) {
        freeKey = freeKey === 'lowest' ? lowestStat(base) : STAT_KEYS[Math.floor(Math.random() * STAT_KEYS.length)];
      }
      const target = forced || freeKey;
      if (target === 'hp') base.maxHp += STAT_GAIN.hp; else base[target] += STAT_GAIN[target];
    }
    const wsPool = [];
    weaponsMap.each((k, v) => { if (GData.canLearn('weapon', v.id, finalLevel)) wsPool.push(parseInt(v.id)); });
    const skPool = [];
    skillsMap.each((k, v) => { if (GData.canLearn('skill', v.id, finalLevel)) skPool.push(parseInt(v.id)); });
    const nWS = GData.wsLimit(finalLevel);
    const weapons = [], skills = [];
    // 武器/技能总数 = GData.wsLimit(finalLevel)（跟着敌人等级走，不是随机个数）；
    // · 上限 = 强化表里 levelLimit ≤ 等级的最大档 —— 武器与技能同一条线都到 15 级。
    // 夹到最后 `Math.min(lo, hi)`，所以 6/13 这类不能升级的技能仍是 1 级。
    for (let i = 0; i < nWS; i++) {
      const wantWeapon = Math.random() < 0.55;
      let pool = wantWeapon ? wsPool : skPool;
      if (!pool.length) pool = wantWeapon ? skPool : wsPool;
      const chooseWeapon = pool === wsPool;
      if (!pool.length) break;
      const id = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      let hi = aiToolMaxLevel(finalLevel);
      if (!chooseWeapon && [6, 13].includes(id)) hi = 1;
      const lo = Math.min(aiToolMinLevel(finalLevel), hi);
      (chooseWeapon ? weapons : skills).push(id + ':' + (lo + Math.floor(Math.random() * (hi - lo + 1))));
    }
    const foe = {
      name, level: finalLevel, power: base.power, agility: base.agility, speed: base.speed,
      hp: base.maxHp, baseStats: { power: base.power, agility: base.agility, speed: base.speed, hp: base.maxHp },
      weapons, skills, isAI: true, effects: {},
    };
    const playerLevel = S && Number.isFinite(S.level) ? S.level : 1;
    const gearLevel = opts.gearSelfLevel ? finalLevel : Math.max(playerLevel, 1);
    if (opts.gear !== false) foe.gears = randomAIGears(finalLevel, gearLevel);
    for (const gear of foe.gears || []) {
      const info = gearInst(gear.id, gear.ext, gear.attr);
      if (!info) continue;

      const gemLv = gear.gem ? gemLevel(gear.gem.id) : 0;
      const mainMul = gemLv ? 1 + gemPercent(gemLv) / 100 : 1;
      foe[['agility', 'power', 'hp', 'speed'][info.type]] += Math.round(info.abilityVal * mainMul);
      const ext = normalizeExt(gear.ext);
      const gemUnits = gemUnitsForGear(gear);
      for (let i = 0; i < ext.length; i++) {
        const val = attachmentValue(ext[i].id, ext[i].level, gemUnits[i] || 0).total;
        if (Number.isFinite(val)) foe.effects[ext[i].id] = Math.max(foe.effects[ext[i].id] || 0, val);
      }
    }

    for (const value of skills) {
      const skill = skillInst(value);
      const stat = { 1: 'power', 2: 'agility', 3: 'speed', 4: 'hp' }[skill.id];
      if (stat) foe[stat] += Math.round(GData.passiveBonus(skill.id, skill.level) * (1 + (foe.effects[26 + skill.id] || 0) / 100));
    }

    const statScale = Number(opts.statScale);
    if (Number.isFinite(statScale) && statScale > 0 && statScale !== 1) {
      for (const key of ['power', 'agility', 'speed']) {
        foe[key] = Math.max(1, Math.round(foe[key] * statScale));
      }
      foe.hp = Math.max(1, Math.round(foe.hp * statScale));
      foe.statScale = statScale;
    }

    if (foe.maxHp == null) foe.maxHp = Math.max(1, Math.round(foe.hp));
    // 幻兽必须在生成对手时就抽定并落到面板上。
    if (opts.pets !== false && foe.isAI && !Array.isArray(foe.pets)) {
      try {
        foe.pets = randomPetLoadout(finalLevel);
        applyPetBonuses(foe, foe.pets);
      } catch (e) { if (window.__errs) window.__errs.push('genAI pets: ' + (e && e.message)); }
    }

    if (opts.bounds !== false) applyFoeTotalBounds(foe);
    return foe;
  }


  const BERSERK_SET_ID = 51;
  const BERSERK_LEVEL = 50;
  const BERSERK_CHANCE_AT_50 = 0.10;
  const BERSERK_CHANCE_AT_70 = 0.50;
  const BERSERK_CHANCE_MAX = 0.80;

  function berserkChance(level) {
    const lv = Math.floor(Number(level) || 0);
    if (lv < BERSERK_LEVEL) return 0;

    const span = Math.max(1, MAX_PLAYER_LEVEL - BERSERK_LEVEL);
    const t = Math.min(1, Math.max(0, (lv - BERSERK_LEVEL) / span));
    const pct = Math.round(BERSERK_CHANCE_AT_50 * 100 + (BERSERK_CHANCE_AT_70 * 100 - BERSERK_CHANCE_AT_50 * 100) * t);
    return Math.min(BERSERK_CHANCE_MAX, pct / 100);
  }

  // 随机对手等级越高，火力的武器 / 技能档位就越不许压得太低：
  // 真正的夹取在 genAI 里做（`Math.min(lo, hi)`），所以 6/13 不能升级的技能仍是 1 级。
  const AI_TOOL_MIN_TRUE_LEVEL = 11;
  function aiToolMinLevel(level) {
    const lv = Math.max(1, Math.floor(Number(level) || 0));
    return Math.max(1, Math.min(AI_TOOL_MIN_TRUE_LEVEL, Math.floor((lv - 2) / 8)));
  }


  const AI_FULL_GEAR_LEVEL = 40;
  function aiGearMinLevel(level) {
    const lv = Math.max(1, Math.floor(Number(level) || 0));
    if (lv >= 60) return 25;
    if (lv >= 40) return 20;
    return 0;
  }

  // 橙装不是靠「高 id」：和玩家融合出来的橙装一样，是实例级 `orange: true`
  // 只对紫装档（info.quality >= 3）掷橙装 —— 白/绿/蓝装不能直接变成橙装。
  const AI_ORANGE_FROM_LEVEL = 30;
  const AI_GEM_FROM_LEVEL = 45;
  function aiOrangeChance(level) {
    const lv = Math.max(0, Number(level) || 0);
    if (lv < AI_ORANGE_FROM_LEVEL) return 0;
    const t = Math.max(0, Math.min(1, (lv - AI_ORANGE_FROM_LEVEL) / (MAX_PLAYER_LEVEL - AI_ORANGE_FROM_LEVEL)));
    return Math.min(0.35, 0.01 + 0.24 * t);
  }
  function aiGemChance(level) {
    const lv = Math.max(0, Number(level) || 0);
    if (lv < AI_GEM_FROM_LEVEL) return 0;
    const t = Math.max(0, Math.min(1, (lv - AI_GEM_FROM_LEVEL) / (MAX_PLAYER_LEVEL - AI_GEM_FROM_LEVEL)));
    return Math.min(0.85, 0.20 + 0.50 * t);
  }
  function aiGemLevel(level) {
    const lv = Math.max(0, Number(level) || 0);
    if (lv < AI_GEM_FROM_LEVEL) return 0;
    const base = 1 + Math.floor((lv - AI_GEM_FROM_LEVEL) / 6);
    const jitter = Math.floor(Math.random() * 3) - 1;
    return Math.max(1, Math.min(7, base + jitter));
  }


  function randomAIGears(foeLevel, refLevel) {
    const level = Math.max(1, Math.min(foeLevel, Math.floor(refLevel || foeLevel || 1)));
    const minSetLevel = aiGearMinLevel(level);
    const sets = [];
    gearSetMap.each((id, set) => {
      const lv = Number(set && set.level);

      // 48/49（深海·机器猫 q3）只从融合变异产出，不进随机对手池；
      // 否则同等级 NPC 会多抽到这两套，征战 / 关卡的胜率标定跟着漂。
      if (set && Number.isFinite(lv) && lv <= level && lv >= minSetLevel &&
          Number(set.quality) < 4 && ![48, 49].includes(Number(id))) {
        sets.push({ id: Number(id), level: lv, quality: parseInt(set.quality) || 0 });
      }
    });
    if (!sets.length) return [];
// 正常玩家闯关到10级后基本穿满当前套装，对手的穿戴率不能差太多；
    const alwaysFull = Math.max(1, Math.floor(Number(foeLevel) || 0)) >= AI_FULL_GEAR_LEVEL;
    const wearChance = alwaysFull ? 1 : Math.min(0.95, 0.5 + level / 40);

    const classicUniform = slotMode() === 'classic' && level >= BERSERK_LEVEL;
    let tiers = null, berserkPool = null, normalPool = null, pieceChance = 0;
    if (!classicUniform) {
// 套装按等级从高到低分档；低等级套装的主属性和品质档位远低于高档，不能等概率随机
      tiers = [];
      for (const set of sets.slice().sort((a, b) => b.level - a.level)) {
        const top = tiers[tiers.length - 1];
        if (top && top.level === set.level) top.sets.push(set);
        else tiers.push({ level: set.level, sets: [set] });
      }
      // 狂战套按部位掷（需求166：70 级每件 50%、50 级下限 10%）：
      // （狂战是最高档唯一的成员，不剔掉的话没命中的部位仍有 75% 落进它，等于白压）。
      berserkPool = tiers.filter((tier) => tier.sets.some((set) => set.id === BERSERK_SET_ID));
      normalPool = tiers.map((tier) => ({ level: tier.level, sets: tier.sets.filter((set) => set.id !== BERSERK_SET_ID) }))
        .filter((tier) => tier.sets.length);
      if (!berserkPool.length && !normalPool.length) return [];
      pieceChance = berserkChance(level);
    }
    const out = [];
    const usedType = new Set();
    for (let slot = 0; slot < 4; slot++) {
      if (Math.random() > wearChance) continue;
      let tier = null;
      if (classicUniform) {

        const picked = sets[Math.floor(Math.random() * sets.length)];
        tier = { level: picked.level, sets: [picked] };
      } else {
        const useBerserk = berserkPool.length > 0 && Math.random() < pieceChance;
        const pool = useBerserk ? berserkPool : normalPool;
        if (!pool.length) break;
        const roll = Math.random();
        tier = roll < 0.75 ? pool[0]
          : roll < 0.95 ? pool[Math.min(1, pool.length - 1)]
          : pool[Math.floor(Math.random() * pool.length)];
      }
      const set = tier.sets[Math.floor(Math.random() * tier.sets.length)];
      const gearsOfSet = [];
      gearMap.each((k, v) => { if (parseInt(v.setId) === set.id) gearsOfSet.push(parseInt(v.id)); });
      if (!gearsOfSet.length) break;

      const candidates = gearsOfSet.filter((id) => {
        const it = gearInst(id);
        return it && !usedType.has(it.type);
      });
      if (!candidates.length) break;
      const gid = candidates[Math.floor(Math.random() * candidates.length)];
      const info = gearInst(gid);
      if (!info) continue;
      usedType.add(info.type);
      const extSlots = fusionSlots(info.quality);
      const ext = extSlots ? randomExt(extSlots, info.quality >= 3 ? 3 : 2) : [];
      const piece = { id: gid, used: true, ext, attr: rollGearAttr(gid) };

      const ref = Math.max(1, Math.floor(Number(refLevel) || level));
      if (info.quality === 3 && Math.random() < aiOrangeChance(ref)) {
        piece.orange = true;
        if (Math.random() < aiGemChance(ref)) {
          const lv = aiGemLevel(ref);
          if (lv) piece.gem = { id: 100 + lv, units: rollGemAffixUnits(lv, normalizeExt(piece.ext).length) };
        }
      }
      out.push(piece);
    }
    return out;
  }


  function stageProgress(stageId) {
    return clone(S.stages[stageId] || { npcIndex: 1, passed: false });
  }
  function setStageProgress(stageId, prog) {
    stageId = Number(stageId);
    if (!npcOf(stageId, 1) || !object(prog)) return false;
    const previous = stageProgress(stageId);
    const total = GData.stageEnemyCount ? GData.stageEnemyCount(stageId) : 3;
    const passed = previous.passed || prog.passed === true;
    S.stages[stageId] = { npcIndex: passed ? total : Math.min(total, Math.max(previous.npcIndex, integer(prog.npcIndex, 1, 1))), passed };
    save();
    return true;
  }
  function npcOf(stageId, npcIndex) {
    stageId = Number(stageId); npcIndex = Number(npcIndex);
    // 超级大关（19-36）：字典里没有这三扇门的 NPC，按同星级「大侠」模板生成，
    if (stageId >= 19 && stageId <= 36) {
      if (npcIndex !== 1) return null;
      const star = ((stageId - 19) % 6) + 1;
      const gate = Math.floor((stageId - 19) / 6);
      const templateStage = [1, 7, 13][gate] + (star - 1);
      const base = npcOf(templateStage, 3);
      if (!base) return null;
      const hp = GData.stageNpcHp(stageId, 1);
      const name = String(base.name || '').replace(/^\d+星/, '');
      return Object.assign({}, base, {
        id: 's' + stageId, name: '超级' + name, stageId: String(stageId), npcIndex: '1',
        isBoss: 'true', hp: String(hp),
      });
    }
    let found = null;
    npcsMap.each((k, v) => {
      const actualStage = Number(v.id) === 127 ? 10 : Number(v.stageId);
      if (actualStage === stageId && Number(v.npcIndex) === npcIndex) found = actualStage === Number(v.stageId) ? v : Object.assign({}, v, { stageId: String(actualStage) });
    });
    const hp = found && GData.stageNpcHp(stageId, npcIndex);
    if (found && hp) found = Object.assign({}, found, { hp: String(hp) });
    return found;
  }

  function highestStageId() {
    let highest = 1;
    for (const id of Object.keys(S.stages)) if (S.stages[id].passed) highest = Math.max(highest, Number(id) + 1);
    return highest;
  }
  function stageRun(stageId) { return S.stageRuns && S.stageRuns[stageId] ? clone(S.stageRuns[stageId]) : null; }
  function stageAccess(stageId) {
    stageId = Number(stageId);
    if (!Number.isInteger(stageId) || !npcOf(stageId, 1)) return { ok: false, msg: '没有这个关卡。' };
    if (S.level < 5) return { ok: false, msg: '5级才有资格挑战我们盖世五侠哦！加油吧!' };
    if (stageId > highestStageId() && !stageRun(stageId)) return { ok: false, msg: '请先通过前面关卡。' };
    return { ok: true };
  }
  function stageReward(stageId) {
    const count = GData.stageEnemyCount ? GData.stageEnemyCount(stageId) : 3;
    let exp = 0;
    for (let i = 1; i <= count; i++) exp += GData.stageNpcExp(stageId, i);
    const gold = (GData.isSuperStage && GData.isSuperStage(stageId) ? 35 : 25) * (GData.STAGE_GOLD_MULT || 1);
    return { exp, gold };
  }
  // 关卡连战里「先上阵」的徒弟：原版 `fightType == 6` 时服务端把左方设成徒弟，
  function stagePrentice() {
    const list = (Array.isArray(S.prentices) ? S.prentices : []).filter((p) => p && p.name);
    if (!list.length) return null;
    let best = list[0], bestLevel = Number(best.level) || 0;
    for (let i = 1; i < list.length; i++) {
      const lv = Number(list[i].level) || 0;
      if (lv > bestLevel) { best = list[i]; bestLevel = lv; }
    }
    return best;
  }
  // 把徒弟快照变成可交给 `Main.startBattle({ fighter })` 的玩家侧面板。
  // 三维/武器/技能沿用收徒时保存的快照；装备补 `wears` 供经典战斗立绘使用。
  function stagePrenticeFighter() {
    const row = stagePrentice();
    if (!row) return null;
    const full = (typeof ensureFriendLoadout === 'function' ? ensureFriendLoadout(row) : row) || row;
    const level = Math.max(1, Math.min(MAX_PLAYER_LEVEL, integer(full.level, 1, 1)));
    let power = Number(full.power) || 0, agility = Number(full.agility) || 0;
    let speed = Number(full.speed) || 0, hp = Number(full.hp) || 0;
    if (!power || !agility || !speed || !hp) {
      const roll = genAI(level, '', { levelJitter: 0, gearSelfLevel: true });
      power = power || roll.power; agility = agility || roll.agility;
      speed = speed || roll.speed; hp = hp || roll.hp;
    }
    const weapons = (full.weapons || []).map((w) => typeof w === 'string' ? weaponInst(w) : w).filter(Boolean);
    const skills = (full.skills || []).map((v) => typeof v === 'string' ? skillInst(v) : v).filter(Boolean);
    // ⚠ 必须把 `gears` 一起交出去（哪怕是空数组）。
    const gears = normalizeFoeGears(full.gears || []);
    return {
      name: full.name, level, power, agility, speed, hp: Math.max(1, Math.round(hp)), maxHp: Math.max(1, Math.round(hp)),
      baseStats: { power, agility, speed, hp },
      weapons, skills, gears,
      effects: {}, masterLevel: S.level,
      isPrentice: true,
    };
  }
  let stageAttemptSeq = 0;
  function beginStageBattle(stageId) {
    stageId = Number(stageId);
    const access = stageAccess(stageId);
    if (!access.ok) return access;
    S.stageRuns = S.stageRuns || {};
    let run = S.stageRuns[stageId];
    if (run && run.attempt) return { ok: false, msg: '这场战斗尚未结束。' };
    if (run && run.needsRevive && run.revives >= 2) return { ok: false, msg: '本轮已用完2次复活机会，请结束本轮后重新挑战。' };
    const costsBook = !run || run.needsRevive;
    if (costsBook && !debugOn('noStageCost')) {
      if (!(S.props[23] > 0)) return { ok: false, needsBook: true, msg: '挑战书不足，快去商店中购买吧！' };
      S.props[23]--;
    }
    let reviving = false;
    if (!run) run = S.stageRuns[stageId] = { npcIndex: 1, revives: 0, needsRevive: false, masterOnly: false };
    else if (run.needsRevive) { reviving = true; run.revives++; run.needsRevive = false; }

    const prentice = !run.masterOnly && !reviving ? stagePrentice() : null;
    run.attempt = 'stage_' + Date.now() + '_' + (++stageAttemptSeq);
    save();
    return { ok: true, npcIndex: run.npcIndex, token: run.attempt,
      role: prentice ? 'prentice' : 'master', prentice: prentice ? prentice.name : null };
  }
  function interruptStageBattle(stageId, token) {
    const run = S.stageRuns && S.stageRuns[stageId];
    if (!run || run.attempt !== token) return false;
    delete run.attempt;
    save();
    return true;
  }

  // 徒弟战败：不扣复活、不结束本轮，只收掉 attempt 并标记师父接手。
  // foeRatio = 徒弟打完后对手的剩余血量比例；师父接手同一名对手，玩家侧仍是满血。
  function stagePrenticeLost(stageId, token, foeRatio) {
    const run = S.stageRuns && S.stageRuns[stageId];
    if (!run || run.attempt !== token) return false;
    delete run.attempt;
    run.masterOnly = true;
    delete run.carryHp;
    if (foeRatio != null && Number.isFinite(Number(foeRatio))) run.foeCarryHp = Math.max(0, Math.min(1, Number(foeRatio)));
    else delete run.foeCarryHp;
    save();
    return true;
  }
  function finishStageBattle(stageId, token, win, carryRatio) {
    stageId = Number(stageId);
    const run = S.stageRuns && S.stageRuns[stageId];
    if (!run || run.attempt !== token) return { ok: false };
    delete run.attempt;
    // 每场结算后对手血量都不再保留：打赢进入下一名对手，打输复活也是满血重打。
    delete run.foeCarryHp;
    if (!win) {
      run.needsRevive = true;
      delete run.carryHp;
      save();
      return { ok: true, win: false, complete: false, exp: 0, gold: 0, ups: [], run: stageRun(stageId) };
    }
    const fightExp = GData.stageNpcExp(stageId, run.npcIndex);
    const total = GData.stageEnemyCount ? GData.stageEnemyCount(stageId) : 3;
    const complete = run.npcIndex === total;
    const old = stageProgress(stageId);
    const nextNpc = Math.min(total, run.npcIndex + 1);
    S.stages[stageId] = { npcIndex: Math.max(old.npcIndex, nextNpc), passed: old.passed || complete };
    if (complete) {
      delete S.stageRuns[stageId];

      noteChallengeClear(stageId);
    }
    else {
      run.npcIndex = nextNpc;
      if (Number.isFinite(carryRatio)) run.carryHp = Math.max(0, Math.min(1, carryRatio));
    }
// 螳螂(1-6) 白为主 / 仙鹤(7-12) 绿为主 / 熊猫(13-18) 蓝为主（蓝为上限）。
    const star = GData.stageStar(stageId);
    const frag = GData.STAGE_FRAGMENT;
    let drop = null;
    if (Math.random() < GData.stageChallengeFragmentChance(star)) {
      const superStage = !!(GData.isSuperStage && GData.isSuperStage(stageId));

      const base = superStage ? 26 : 24 + Math.floor((stageId - 1) / 6);
      const up = superStage ? 0 : star >= 5 ? 2 : star >= 3 ? 1 : 0;
      const step = Math.min(base + up, 26);
      let id = up > 0 && Math.random() >= frag.tierUp ? step : base;
      // 只动「蓝」这一档，螳螂的白/绿基础掉落完全不变。
      if (id === 26 && Math.random() >= Number(GData.BLUE_SHARD_DROP_MUL)) id = base === 26 ? 0 : base;
      if (id) {
        const count = GData.stageFragmentCount();
        S.props[id] = (S.props[id] || 0) + count;
        drop = { id, count, name: propMap.getValue(id).name };
      }
    }
    const gold = complete ? stageReward(stageId).gold : 0;

    let goldBuff = false;
    if (gold > 0 && activeBuildingBuff('stageGold')) {
      const rate = buildingDoubleRate('altar', 'stageGold');
      if (rate > 0 && Math.random() * 100 < rate) goldBuff = true;
    }
    addGold(gold * (goldBuff ? 2 : 1));
    const gem = complete ? rollGemDrop(10) : null;
    // 金宝箱不再从超级关循环掉落：原版只在 71~90 级每级发 1 个，
    // 这里同样只保留升级产出，否则「总属性点」会重新变成无上限。
    // 返回值里的 `chest` 字段保留给界面/回归读（现在恒为 null）。
    const chest = null;
    const ups = gainExp(fightExp);
    save();
    return { ok: true, win: true, complete, drop, gem, chest, ups, run: stageRun(stageId), exp: fightExp,
      gold: gold * (goldBuff ? 2 : 1), goldBase: gold, goldBuff: goldBuff };
  }
  function abandonStageRun(stageId) {
    if (!S.stageRuns || !S.stageRuns[stageId] || S.stageRuns[stageId].attempt) return false;
    delete S.stageRuns[stageId];
    save();
    return true;
  }
  // 弃赛只清赛事局面：报名费已在 arenaJoin 扣掉，这里不退也不结算。
  function abandonArenaRun() {
    if (!S.classicArenaRun) return false;
    delete S.classicArenaRun;
    save();
    return true;
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 联机客户端的「今天 / 本周」必须按服务端时区算：设备时区不同时，服务端已按
  // Asia/Shanghai 记账，客户端再用本机日期判断就会把已领的祭坛 / 每日礼包重新点亮。
  let serverDayFormatter = null;
  function serverDayKey(ms) {
    try {
      if (!serverDayFormatter) serverDayFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = serverDayFormatter.formatToParts(new Date(ms));
      const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
      const y = get('year'), m = get('month'), d = get('day');
      if (y && m && d) return y + '-' + m + '-' + d;
    } catch (e) {}
    const d = new Date(ms + 8 * 3600000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function serverWeekKey(ms) {
    const day = serverDayKey(ms).split('-').map(Number);
    const weekday = new Date(Date.UTC(day[0], day[1] - 1, day[2])).getUTCDay();
    const monday = new Date(Date.UTC(day[0], day[1] - 1, day[2] - (weekday + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  function liveServerClock() {
    return ONLINE && !SERVER && typeof window !== 'undefined' && typeof window.__ssdzServerNow === 'function';
  }

  function shortDay() { return !!(window.Debug && window.Debug.enabled && window.Debug.enabled('shortDay')); }
  // 打开「12 小时一天」时，12:00 起换成「第二天」的日期键，于是每日礼包、免费抽奖、
  // 格式仍是 YYYY-MM-DD（存档校验 validLocalDate、earnOn 按日期查表都依赖它）。
  function localDate() {
    if (liveServerClock()) return serverDayKey(nowMs());
    const now = new Date(Date.now());
    if (shortDay() && now.getHours() >= 12) {
      const next = new Date(now.getTime());
      next.setDate(next.getDate() + 1);
      return dateKey(next);
    }
    return dateKey(now);
  }
  function syncDailyStats() {
    const date = localDate();
    if (S.dailyStatsDate === date) return;
    if (S.dailyStatsDate) {
      S.dailyWins = 0;
      S.dailyFails = 0;
      S.joinRankCount = 0;
    }
    S.dailyStatsDate = date;
    if (object(S.challengeDaily) && S.challengeDaily.date !== date) S.challengeDaily = null;
    if (S.quests && S.quests.date !== date) S.quests = null;
    if (S.dailyCounters && S.dailyCounters.date !== date) S.dailyCounters = null;
    save();
  }
  // 叠加无上限 —— 只压当天被反复刷的那一关，别的关卡不受牵连。
  function challengeDaily() {
    const date = localDate();
    const cur = object(S.challengeDaily) ? S.challengeDaily : null;
    if (!cur || cur.date !== date) return { date, counts: {} };
    return { date, counts: normalizeChallengeCounts(cur.counts) };
  }
  function challengeDailyCount(stageId) {
    const id = Math.floor(Number(stageId));
    if (!(id >= 1 && id <= GData.STAGE_TYPES.length * 6)) return 0;
    return challengeDaily().counts[id] || 0;
  }

  function noteChallengeClear(stageId) {
    const id = Math.floor(Number(stageId));
    if (!(id >= 1 && id <= GData.STAGE_TYPES.length * 6)) return 0;
    const cur = challengeDaily();
    cur.counts[id] = (cur.counts[id] || 0) + 1;
    S.challengeDaily = { date: cur.date, counts: cur.counts };
    save();
    return S.challengeDaily.counts[id];
  }

  const DAILY_GIFT_EXTRAS = Object.freeze([
    { id: 23, name: '挑战书' }, { id: 36, name: '英雄帖' }, { id: 39, name: '勇气徽章' },
    { id: 82, name: '召唤证' }, { id: 41, name: '超级大力丸' }, { id: 42, name: '超级敏捷丸' }, { id: 43, name: '超级速度丸' },
  ]);

  function dailyGiftExtra(date) {
    const src = validLocalDate(date) ? String(date) : localDate();
    const [y, m, d] = src.split('-').map(Number);
    const day = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    const n = DAILY_GIFT_EXTRAS.length;
    const idx = ((day % n) + n) % n;
    return Object.assign({ count: 1, index: idx, date: src }, DAILY_GIFT_EXTRAS[idx]);
  }
  // 征战令发放口径按领取日切：2026-11-23 起周五/周六/周日各 +1，之前仍是连续第 3/6/9 天。
  const TICKET_WEEKEND_FROM = '2026-11-23';
  function weekdayOf(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }
  function dailyTicket(date, streak) {
    if (date < TICKET_WEEKEND_FROM) return streak % 3 === 0 ? 1 : 0;
    const day = weekdayOf(date);
    return day === 5 || day === 0 || day === 6 ? 1 : 0;
  }
  function dailyStatus() {
    const date = localDate();
    const claimed = S.dailyClaimDate === date;
    const days = Math.max(0, integer(S.loginStreak, 0, 0));
    // 连续天数：今天已领 → 记的天数；昨天领过 → 今天续上；否则从 1 重新算。
    const streak = claimed ? Math.max(1, days)
      : (S.dailyClaimDate === yesterdayDate() ? Math.max(1, days) + 1 : 1);
    const extra = dailyGiftExtra(date);
    // 走独立的 ticket 字段，不占每日礼包的 7 种附加道具轮换。
    const ticket = dailyTicket(date, streak);
    return { date, claimed, streak, gold: Math.min(200, 100 + (streak - 1) * 10), extra, ticket,
      newbie: newbieGift(date),
      // 兼容旧界面/旧调用：只有轮到挑战书时才是 1。
      challengeBooks: extra.id === 23 ? extra.count : 0 };
  }

  function newbieGift(date) {
    if (ONLINE) return null;
    const src = validLocalDate(date) ? String(date) : localDate();
    const start = validLocalDate(S.newbieStartDate) ? String(S.newbieStartDate) : '';
    if (!start) return null;
    const toDay = (s) => {
      const [y, m, d] = String(s).split('-').map(Number);
      return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    };
    const day = toDay(src) - toDay(start) + 1;
    if (day < 1 || day > 3) return null;
    return { day, gold: 150, propId: 2, count: 3, name: '新手福利' };
  }


  const QUEST_TYPES = [
    { key: 'win',       name: '赢下 {n} 场对战',          steps: [2, 3, 5] },
    { key: 'fight',     name: '进行 {n} 场战斗',          steps: [4, 6, 8] },
    { key: 'challenge', name: '发起 {n} 次随机挑战',      steps: [2, 3, 5] },
    { key: 'stage',     name: '通关 {n} 次关卡挑战',      steps: [2, 3, 5], minLevel: 10 },
    { key: 'arena',     name: '参加 {n} 次竞技场比赛',    steps: [1, 2, 3], minLevel: 11 },
    { key: 'rank',      name: '参加 {n} 场天梯赛',        steps: [2, 3, 5], minLevel: 30 },
    { key: 'spar',      name: '和好友切磋 {n} 次',        steps: [1, 2, 3] },
    { key: 'lottery',   name: '抽取 {n} 次每日幸运抽奖',  steps: [1, 2] },
    { key: 'merge',     name: '合成或融合 {n} 次装备',    steps: [1, 2, 3], minLevel: 10 },
    { key: 'gem',       name: '合成 {n} 次宝石',          steps: [1, 2, 3], minLevel: 45 },
    { key: 'upgrade',   name: '升级武器或技能 {n} 次',    steps: [1], minLevel: 2 },
    { key: 'use',       name: '使用 {n} 个道具',          steps: [2, 4, 6] },
    { key: 'buy',       name: '在商店购买 {n} 件道具',    steps: [1, 2, 3] },
    { key: 'pickup',    name: '拾取 {n} 次战斗掉落',      steps: [1, 2, 3] },
    { key: 'energy',    name: '消耗 {n} 点体力',          steps: [10, 20, 30] },
  ];

  const QUEST_COUNT = ONLINE ? 3 : 4;
  const QUEST_KEYS = QUEST_TYPES.map((q) => q.key);
  // 这条任务在 level 级能不能做（没写 minLevel 的就是 1 级就能做）。
  function questAvailableAt(key, level) {
    const type = QUEST_TYPES.find((q) => q.key === key);
    if (!type) return false;
    return (type.minLevel || 1) <= Math.max(1, Number(level) || 1);
  }
  // 现在还有没有「升得动」的武器/技能：既没到自身等级上限，玩家等级也满足该级的等级门槛。
  function hasUpgradableWS(level) {
    if (!S) return false;
    const lv = Math.max(1, Number(level) || S.level);
    for (const kind of ['weapon', 'skill']) {
      const list = kind === 'weapon' ? myWeapons() : mySkills();
      for (const it of list) {
        const info = upgradeInfo(kind, it.id);
        if (info && !info.max && lv >= info.levelLimit) return true;
      }
    }
    return false;
  }
  // 当前等级可完成的每日任务池（按 QUEST_TYPES 的固定顺序，保证同一天同一等级抽题稳定）。
  // 「升级武器或技能」额外要求手上真有升得动的武技：全都顶到等级上限时整条不触发。
  function questPoolFor(level) {
    const lv = Math.max(1, Number(level) || 1);
    const pool = QUEST_TYPES.filter((q) => (q.minLevel || 1) <= lv);
    return hasUpgradableWS(lv) ? pool : pool.filter((q) => q.key !== 'upgrade');
  }

  function emptyCounters(date) {
    const counters = { date };
    for (const key of QUEST_KEYS) counters[key] = 0;
    return counters;
  }
  const QUEST_GOLD = { kind: 'gold', weight: 1.4, range: [10, 30] };
  const QUEST_EXP = { kind: 'exp', weight: 1.4, range: [50, 80] };
  const QUEST_EXTRA_POOL = [
    { id: 21, range: [3, 5], weight: 1.2 },
    { id: 22, range: [3, 5], weight: 1.2 },
    { id: 23, range: [1, 2], weight: 1.0 },
    { id: 1, range: [1, 2], weight: 1.0 },
    { id: 7, range: [1, 1], weight: 0.7, pill: true },
    { id: 45, range: [1, 1], weight: 0.1 },
    { id: 2, range: [1, 1], weight: 0.3 },
    { id: 44, range: [1, 1], weight: 0.06, pill: true },
  ];

  function questSeed(date) {
    let h = 2166136261;
    for (const ch of String(date)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function questRng(seed) {
    let state = seed || 1;
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  }
  const questRoll = (rnd, range) => range[0] + Math.floor(rnd() * (range[1] - range[0] + 1));

  function rollQuests() {
    const date = localDate();
    const rnd = questRng(questSeed(date));
    const pool = questPoolFor(S ? S.level : 1).map((q) => q.key);
// Fisher–Yates：同一天的抽取顺序固定，刷新页面不会换题
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, Math.min(QUEST_COUNT, pool.length)).map((key) => {
      const type = QUEST_TYPES.find((q) => q.key === key);
      const tier = Math.floor(rnd() * type.steps.length);
      const bag = [QUEST_GOLD, QUEST_EXP].concat(QUEST_EXTRA_POOL.map((item) => ({
        kind: 'prop', id: item.id, weight: item.weight, range: item.range, pill: item.pill,
      })));
      const rewardCount = rnd() < 0.45 ? 1 : 2;
      const rewards = [];
      for (let i = 0; i < rewardCount && bag.length; i++) {
        const total = bag.reduce((sum, item) => sum + item.weight, 0);
        let roll = rnd() * total, pick = 0;
        for (let j = 0; j < bag.length; j++) { roll -= bag[j].weight; if (roll <= 0) { pick = j; break; } }
        const item = bag.splice(pick, 1)[0];
        rewards.push({
          kind: item.kind, id: item.id,
          count: item.pill ? 1 : questRoll(rnd, item.range),
        });
      }
      return { key, need: type.steps[tier], rewards, claimed: false };
    });
  }
  function questState() {
    const date = localDate();
    const level = S ? S.level : 1;
    const hasList = S.quests && typeof S.quests === 'object' && Array.isArray(S.quests.list) && S.quests.list.length > 0;
    const sameDay = !!(S.quests && S.quests.date === date);
    const staleLevel = hasList && S.quests.list.some((q) => !q || !questAvailableAt(q.key, level)
      || (q.key === 'upgrade' && !hasUpgradableWS()));
    // 4→3 收口后，当天已经落库的旧题面条数不对也要重抽；否则要拖到第二天才变 3 条。
    const wrongCount = hasList && S.quests.list.length !== QUEST_COUNT;
    if (!hasList || !sameDay || staleLevel || wrongCount) {
      const claimedCount = sameDay && hasList ? S.quests.list.filter((q) => q && q.claimed === true).length : 0;
      S.quests = { date, list: rollQuests() };
      S.quests.list.forEach((q, i) => { q.claimed = i < claimedCount; });
      if (!sameDay) S.dailyCounters = emptyCounters(date);
      save();
    }
    if (!S.dailyCounters || S.dailyCounters.date !== date) {
      S.dailyCounters = emptyCounters(date);
      save();
    }
    return S.quests;
  }

  function bumpDaily(key, n, silent) {
    if (!QUEST_KEYS.includes(key)) return 0;
    questState();
    S.dailyCounters[key] = Math.max(0, (Number(S.dailyCounters[key]) || 0) + (Number(n) || 1));
    if (!silent) save();
    return S.dailyCounters[key];
  }

  function bumpBattleDaily(win, kind) {
    bumpDaily('fight', 1, true);
    if (win) bumpDaily('win', 1, true);
    if (kind === 'stage' && win) bumpDaily('stage', 1, true);
    if (kind === 'arena') bumpDaily('arena', 1, true);
    if (kind === 'rank') bumpDaily('rank', 1, true);
    if (kind === 'friend') bumpDaily('spar', 1, true);
    if (kind === 'challenge') bumpDaily('challenge', 1, true);
    // 状态页的「今日胜率 / 战斗场次」仍读这四个旧字段；服务端战斗由 recordBattle
    // 统一记账（客户端在线时 skipRecord，离线仍由页面 settle 自己加）。
    if (SERVER) {
      syncDailyStats();
      if (win) {
        S.dailyWins = Math.max(0, integer(S.dailyWins, 0)) + 1;
        S.allWins = Math.max(0, integer(S.allWins, 0)) + 1;
      } else {
        S.dailyFails = Math.max(0, integer(S.dailyFails, 0)) + 1;
        S.allFails = Math.max(0, integer(S.allFails, 0)) + 1;
      }
    }
  }
  // 兼容旧档：老任务只有 gold/exp/extras，新任务直接存 rewards。
  function questRewards(q) {
    const nameOf = (id) => { const item = propMap.getValue(id); return item ? item.name : '道具'; };
    const out = [];
    if (Array.isArray(q.rewards) && q.rewards.length) {
      for (const r of q.rewards) {
        if (!r) continue;
        if (r.kind === 'gold') out.push({ kind: 'gold', id: 8, name: '金松果', count: Math.max(1, Number(r.count) || 1) });
        else if (r.kind === 'exp') out.push({ kind: 'exp', id: 15, name: '经验', count: Math.max(1, Number(r.count) || 1) });
        else if (r.id) out.push({ kind: 'prop', id: Number(r.id), name: nameOf(r.id), count: Math.max(1, Number(r.count) || 1) });
      }
      return out;
    }
    if (q.gold) out.push({ kind: 'gold', id: 8, name: '金松果', count: q.gold });
    if (q.exp) out.push({ kind: 'exp', id: 15, name: '经验', count: q.exp });
    for (const extra of Array.isArray(q.extras) ? q.extras : []) {
      if (extra && extra.id) out.push({ kind: 'prop', id: Number(extra.id), name: nameOf(extra.id), count: Math.max(1, Number(extra.count) || 1) });
    }
    return out;
  }
  // 把服务端/单机生成的 `quests.list` 映射成页面行。计数缺失按 0 处理。
  function mapQuestRows(quests, counters) {
    counters = counters || {};
    return quests.list.map((q, index) => {
      const type = QUEST_TYPES.find((t) => t.key === q.key) || { name: q.key };
      const progress = Math.min(q.need, Number(counters[q.key]) || 0);
      const rewards = questRewards(q);
      const pick = (kind) => { const r = rewards.find((x) => x.kind === kind); return r ? r.count : 0; };
      return {
        index, key: q.key, need: q.need,
        gold: pick('gold'), exp: pick('exp'),
        extras: rewards.filter((r) => r.kind === 'prop').map((r) => ({ id: r.id, count: r.count })),
        rewards,
        name: String(type.name).replace('{n}', q.need),
        progress, done: progress >= q.need, claimed: q.claimed === true,
        claimable: progress >= q.need && q.claimed !== true,
      };
    });
  }
  // 联机版每日任务由服务端生成并随存档下发；客户端只读，不能自己重摇。
  // 服务端（`__SSDZ_SERVER__`）才走 `questState()`：缺题/换天时生成并落库。
  function questStatus() {
    if (!S) return [];
    if (ONLINE && !SERVER) {
      const q = S.quests;
      if (!q || !Array.isArray(q.list) || !q.list.length) return [];
      return mapQuestRows(q, S.dailyCounters);
    }
    return mapQuestRows(questState(), S.dailyCounters);
  }
  // 页面标题用的日期：联机版用服务端下发的 `quests.date`，别用本机时区猜。
  function questDate() {
    return (S && S.quests && typeof S.quests.date === 'string') ? S.quests.date : localDate();
  }

  function questClaimable() { return questStatus().filter((q) => q.claimable).length; }
  function claimQuest(index) {
    const list = questStatus();
    const row = list[Number(index)];
    if (!row) return { ok: false, msg: '没有这个任务' };
    if (row.claimed) return { ok: false, msg: '这条任务已经领过了' };
    if (!row.done) return { ok: false, msg: '任务还没完成' };
    questState().list[row.index].claimed = true;
    const parts = [];
    const ups = [];
    for (const r of row.rewards) {
      if (r.kind === 'gold') { addGold(r.count); parts.push('金松果 +' + r.count); }
      else if (r.kind === 'exp') { ups.push(...gainExp(r.count)); parts.push('经验 +' + r.count); }
      else { S.props[r.id] = (S.props[r.id] || 0) + r.count; parts.push(r.name + ' +' + r.count); }
    }
    save();
    return { ok: true, msg: '领取成功：' + parts.join('、'), gold: row.gold, exp: row.exp, extras: row.extras, rewards: row.rewards, ups };
  }
  // 原版由服务端 `lottery.do` 开奖，客户端只播动画。联机版把奖池搬到
  // `GData.LOTTERY_PRIZES`，扣费与开奖都在 `State`（服务端执行）：
  function syncLotteryDay() {
    if (!S) return;
    const today = localDate();
    if (S.lotteryDate === today) return;
    S.lotteryDate = today;
    S.lotteryFree = 1;
  }
  function lotteryDraw(count) {
    if (!S) return { ok: false, msg: '还没有存档' };
    syncLotteryDay();
    const table = (GData.LOTTERY_PRIZES || []);
    if (!table.length) return { ok: false, msg: '抽奖奖池未配置' };
    const rawN = Math.max(1, Math.min(10, Math.floor(Number(count) || 1)));
    // 价格由服务端 server/config.js 决定，启动时覆盖 GData.LOTTERY_PRICE；
    // 按免费 → 抽奖卷 → 金松果顺序逐次扣费，资源不足时只开已扣得起的次数。
    const n = rawN;
    const TICKET = 50;
    const price = Math.max(1, Math.floor(Number(GData.LOTTERY_PRICE) || 25));
    const draws = [];
    const ups = [];
    for (let i = 0; i < n; i++) {
      let pay = '';
      if (Number(S.lotteryFree) > 0) { S.lotteryFree = Math.max(0, Number(S.lotteryFree) - 1); pay = 'free'; }
      else if (Number(S.props[TICKET]) > 0) {
        S.props[TICKET] = Number(S.props[TICKET]) - 1;
        if (S.props[TICKET] <= 0) delete S.props[TICKET];
        pay = 'ticket';
      } else if (Number(S.goldPoint) >= price) { S.goldPoint -= price; pay = 'gold'; }
      else break;

      const selected = Math.floor(Math.random() * table.length);
      const prize = table[selected] || table[0];
      let label = String(prize.label || '奖池物品');
      let icon = Number(prize.id) || 0;
      let superPill = false;
      let gainedUps = [];
      if (prize.pills) {
        superPill = Math.random() < Number(prize.superChance || 0);
        const pool = superPill ? (GData.SUPER_PILLS || []) : (GData.NORMAL_PILLS || []);
        const pid = pool[Math.floor(Math.random() * pool.length)] || 7;
        S.props[pid] = (Number(S.props[pid]) || 0) + prize.pills;
        const item = propMap.getValue(pid);
        label = (item ? item.name : String(pid)) + ' ×' + prize.pills + (superPill ? '（高级！）' : '');
        icon = pid;
      } else if (prize.exp) {
        const before = ups.length;
        const out = gainExp(prize.exp);
        for (const u of out) ups.push(u);
        gainedUps = ups.slice(before);
        label = '经验 +' + prize.exp;
        icon = 15;
      } else if (prize.gold) {
        addGold(prize.gold);
        label = '金松果 +' + prize.gold;
        icon = 8;
      } else if (prize.count) {
        const id = Number(prize.id);
        S.props[id] = (Number(S.props[id]) || 0) + Number(prize.count);
        const item = propMap.getValue(id);
        label = (item ? item.name : String(id)) + ' ×' + prize.count;
        icon = id;
      }
      bumpDaily('lottery', 1, true);
      draws.push({ selected, label, icon, pay, superPill, ups: gainedUps });
    }
    if (!draws.length) {
      return { ok: false, msg: '金松果不足' + price + '且没有抽奖卷，今天的免费机会也用完了。', free: Number(S.lotteryFree) || 0, price };
    }
    save();
    return {
      ok: true, draws, count: draws.length, free: Number(S.lotteryFree) || 0, price,
      tickets: Number(S.props[TICKET]) || 0, gold: Number(S.goldPoint) || 0,
      ups, msg: draws.length === 1 ? draws[0].label : '连抽 ' + draws.length + ' 次',
    };
  }
  function claimDaily() {
    const daily = dailyStatus();
    if (daily.claimed) return { ok: false, msg: '今天的奖励已经领取，明天再来吧！', date: daily.date };
    const extra = daily.extra || dailyGiftExtra(daily.date);
    addGold(daily.gold);
    S.props[extra.id] = (S.props[extra.id] || 0) + extra.count;
    const ticket = Math.max(0, Number(daily.ticket) || 0);
    if (ticket) {
      const ticketId = (GData && GData.CAMPAIGN_TICKET_ID) || 87;
      S.props[ticketId] = (S.props[ticketId] || 0) + ticket;
    }
    const newbie = daily.newbie || null;
    if (newbie) {
      addGold(newbie.gold);
      S.props[newbie.propId] = (S.props[newbie.propId] || 0) + newbie.count;
    }
    S.loginStreak = daily.streak;
    S.dailyClaimDate = daily.date;
    save();
    const ticketMsg = ticket ? '，征战令 +' + ticket : '';
    const newbieMsg = newbie
      ? '，新手福利：大体力药剂 +' + newbie.count + '、金松果 +' + newbie.gold
      : '';
    return { ok: true, msg: '连续登录 ' + daily.streak + ' 天：金松果 +' + daily.gold + '，' + extra.name + ' +' + extra.count + ticketMsg + newbieMsg,
      gold: daily.gold + (newbie ? newbie.gold : 0), extra, ticket, newbie,
      challengeBooks: extra.id === 23 ? extra.count : 0, streak: daily.streak, date: daily.date };
  }

  // 联机战报在服务端 `combats` 里已有完整录像；存档只需保留消息列表用的摘要。
  // `online.combatId` 是「服务端可重放」的凭证，缺它的离线战报仍保留整段 result。
  function compactOnlineBattle(entry) {
    const ref = ONLINE && object(entry) && object(entry.online)
      && typeof entry.online.combatId === 'string' && entry.online.combatId;
    if (!ref) return entry;

    if (object(entry.result) && !Array.isArray(entry.result.rounds)
      && object(entry.me) && Object.keys(entry.me).length <= 2
      && object(entry.foe) && Object.keys(entry.foe).length <= 2
      && (entry.winner === 0 || entry.winner === 1)) return entry;
    const source = object(entry.result) ? entry.result : {};
    const winner = (source.winner === 0 || source.winner === 1) ? source.winner
      : (entry.winner === 0 ? 0 : 1);
    entry.me = object(entry.me) ? { name: String(entry.me.name || ''), level: Math.max(1, integer(entry.me.level, 1, 1)) } : null;
    entry.foe = object(entry.foe) ? { name: String(entry.foe.name || ''), level: Math.max(1, integer(entry.foe.level, 1, 1)) } : null;
    entry.result = {
      winner,
      maxHp: Array.isArray(source.maxHp) && source.maxHp.length === 2 ? source.maxHp.slice(0, 2) : null,
    };
    entry.online = Object.assign({}, entry.online);
    entry.winner = winner;
    return entry;
  }
  function validBattle(entry) {
    if (!object(entry) || !object(entry.me) || !object(entry.foe)) return false;

    if (ONLINE && object(entry.online) && typeof entry.online.combatId === 'string' && entry.online.combatId) return true;
    return object(entry.result)
      && Array.isArray(entry.result.rounds) && entry.result.rounds.length > 0 && entry.result.rounds.length <= 240
      && Array.isArray(entry.result.maxHp) && entry.result.maxHp.length === 2 && entry.result.maxHp.every((hp) => Number.isFinite(hp) && hp > 0)
      && entry.result.rounds.every((round) => object(round) && (round.attacker === 0 || round.attacker === 1)
        && Array.isArray(round.hpAfter) && round.hpAfter.length === 2 && round.hpAfter.every((hp) => Number.isFinite(hp) && hp >= 0))
      && (entry.result.winner === 0 || entry.result.winner === 1);
  }
  function normalizeBattleHistory(list) {
    return (Array.isArray(list) ? list : []).filter(validBattle).slice(0, BATTLE_HISTORY_LIMIT);
  }
  function trimBattleHistory(slot) {
    if (!Array.isArray(slot.battles)) slot.battles = [];
    else if (slot.battles.length > BATTLE_HISTORY_LIMIT) slot.battles.splice(BATTLE_HISTORY_LIMIT);
    return slot.battles;
  }
  function battlePayloadNeedsTrim(raw) {
    if (!object(raw)) return false;
    const slots = [raw, raw.__dualOther];
    if (object(raw.__dualSaves)) for (const mode of SAVE_SLOTS) slots.push(raw.__dualSaves[mode]);
    return slots.some((slot) => object(slot) && Array.isArray(slot.battles) && slot.battles.length > BATTLE_HISTORY_LIMIT);
  }
  function normalizeWoodBest(raw) {
    if (!object(raw)) return null; // 旧档没有分项，不能从总伤害猜出三类。
    return {
      handDamage: integer(raw.handDamage, 0),
      weaponDamage: integer(raw.weaponDamage, 0),
      skillDamage: integer(raw.skillDamage, 0),
    };
  }

  function recordWoodBattle(result) {
    if (!S || !result || !Array.isArray(result.rounds) || !result.rounds.length) return null;
    const current = { handDamage: 0, weaponDamage: 0, skillDamage: 0, total: 0 };
    const types = { common: 'handDamage', weapon: 'weaponDamage', skill: 'skillDamage' };
    for (const round of result.rounds) {
      if (!round || round.attacker !== 0 || round.selfDot) continue;
      const damage = integer(round.dmg, 0);
      current.total += damage;
      if (types[round.action]) current[types[round.action]] += damage;
    }
    const best = normalizeWoodBest(S.woodBest) || { handDamage: 0, weaponDamage: 0, skillDamage: 0 };
    for (const key of Object.keys(best)) best[key] = Math.max(best[key], current[key]);
    S.woodBest = best;
    S.woodCount = integer(S.woodCount, 0) + 1;
    S.woodDamage = Math.max(integer(S.woodDamage, 0), current.total);
    save();
    return { current, best: clone(best), totalBest: S.woodDamage, count: S.woodCount };
  }
  let battleKeySeq = 1;
  function recordBattle(entry) {
    if (!validBattle(entry)) return null;
    let snapshot;
    try {

      const compact = ONLINE && object(entry) && object(entry.online)
        && typeof entry.online.combatId === 'string' && entry.online.combatId;
      snapshot = compact ? compactOnlineBattle(Object.assign({}, entry)) : clone(entry);
    } catch (e) { return null; }
    const history = trimBattleHistory(S);
    do { snapshot.id = 'b' + Date.now() + '_' + battleKeySeq++; } while (history.some((battle) => battle && battle.id === snapshot.id));
    snapshot.createdAt = Date.now();
    snapshot.kind = typeof snapshot.kind === 'string' ? snapshot.kind : '挑战';
    snapshot.region = integer(snapshot.region, 0);
    snapshot.winner = (object(snapshot.result) && (snapshot.result.winner === 0 || snapshot.result.winner === 1))
      ? snapshot.result.winner
      : (snapshot.winner === 0 ? 0 : 1);
    // 联机战报只留摘要：完整录像已经在服务端 `combats`（`/api/replay/:id`）。
    compactOnlineBattle(snapshot);
    S.battles = [snapshot].concat(history).slice(0, BATTLE_HISTORY_LIMIT);
    bumpBattleDaily(snapshot.winner === 0, snapshot.kind);
    save();

    return snapshot;
  }
  function battleHistory() { return clone(S ? trimBattleHistory(S) : []); }

  function msgSeenAt() { return Math.max(0, integer(S && S.msgSeenAt, 0, 0)); }
  function markMessagesSeen() {
    const newest = (S && Array.isArray(S.battles) && S.battles.length) ? (Number(S.battles[0].createdAt) || 0) : 0;
    // 没有消息时不动记账：否则开一次消息页会把时间戳推到现在，
    if (!newest) return 0;
    if (newest > msgSeenAt()) { S.msgSeenAt = newest; save(); }
    return S.msgSeenAt;
  }

  // · 装备按实例 key记：只删调试时新生成的那几件，玩家原有的 key 不动。
  const DEBUG_LEDGER_MAX_HISTORY = 200;
  function debugLedgerEnsure() {
    if (!S) return null;
    if (!object(S.debugLedger)) {
      S.debugLedger = { v: 1, createdAt: Date.now(), props: {}, gold: null, goldCup: null, exp: null, weapons: {}, skills: {}, gears: [], history: [] };
    }
    const L = S.debugLedger;
    if (!object(L.props)) L.props = {};
    if (!object(L.weapons)) L.weapons = {};
    if (!object(L.skills)) L.skills = {};
    if (!Array.isArray(L.gears)) L.gears = [];
    if (!Array.isArray(L.history)) L.history = [];
    if (!Number.isFinite(Number(L.createdAt))) L.createdAt = Date.now();
    return L;
  }
  // 当前武器/技能列表 → {id: level}，给快照与回收判断共用。
  function debugLevelMap(list) {
    const out = {};
    for (const entry of Array.isArray(list) ? list : []) {
      const [id, lv] = String(entry).split(':').map(Number);
      if (Number.isFinite(id) && id > 0) out[id] = Math.max(0, Number(lv) || 0);
    }
    return out;
  }
  function debugLevelOf(list, id) {
    for (const entry of Array.isArray(list) ? list : []) {
      const [wid, lv] = String(entry).split(':').map(Number);
      if (wid === Number(id)) return Math.max(0, Number(lv) || 0);
    }
    return 0;
  }
  // 调试操作前的快照：只取会被发放/改动的字段，不深拷录像等大对象。
  function debugSnapshot() {
    if (!S) return null;
    return {
      props: Object.assign({}, S.props),
      goldPoint: Number(S.goldPoint) || 0,
      goldCup: Number(S.goldCup) || 0,
      exp: Number(S.exp) || 0,
      level: Number(S.level) || 1,
      power: Number(S.power) || 0, agility: Number(S.agility) || 0,
      speed: Number(S.speed) || 0, maxHp: Number(S.maxHp) || 0,
      weapons: debugLevelMap(S.weapons), skills: debugLevelMap(S.skills),
      gearKeys: (Array.isArray(S.gears) ? S.gears : []).map((g) => String(g.key)),
      wsPicks: Array.isArray(S.wsPicks) ? S.wsPicks.length : 0,
    };
  }
  function debugPushHistory(L, label, changes) {
    if (!L || !object(changes)) return;
    const entry = { at: Date.now(), label: String(label || '调试') };
    for (const key of ['props', 'weapons', 'skills', 'gears', 'gold', 'goldCup', 'exp', 'level', 'stats', 'picks', 'cleared']) {
      const v = changes[key];
      if (v == null) continue;
      if (Array.isArray(v) && !v.length) continue;
      if (object(v) && !Array.isArray(v) && !Object.keys(v).length) continue;
      if (typeof v === 'number' && !v) continue;
      entry[key] = v;
    }
    if (Object.keys(entry).length <= 2) return;
    L.history.push(entry);
    if (L.history.length > DEBUG_LEDGER_MAX_HISTORY) L.history.splice(0, L.history.length - DEBUG_LEDGER_MAX_HISTORY);
  }
  // 记录「操作前快照 → 操作后」的净增量。debug.js 在所有发放按钮外面包一层。
  function debugRecordDiff(before, label) {
    if (!before || !S) return null;
    const L = debugLedgerEnsure();
    if (!L) return null;
    const changes = {};
    const propChanges = {};
    for (const id of Object.keys(S.props || {})) {
      const now = Number(S.props[id]) || 0, was = Number(before.props[id]) || 0;
      if (now <= was) continue;
      const delta = now - was;
      let e = L.props[id];
      if (!object(e)) e = L.props[id] = { before: was, granted: 0 };
      if (!Number.isFinite(Number(e.before))) e.before = was;
      e.granted = Math.max(0, Number(e.granted) || 0) + delta;
      propChanges[id] = delta;
    }
    if (Object.keys(propChanges).length) changes.props = propChanges;

    const cur = (key, name) => {
      const now = Number(S[key]) || 0, was = Number(before[key]) || 0;
      if (now <= was) return;
      const delta = now - was;
      let e = L[name];
      if (!object(e)) e = L[name] = { before: was, granted: 0 };
      if (!Number.isFinite(Number(e.before))) e.before = was;
      e.granted = Math.max(0, Number(e.granted) || 0) + delta;
      changes[name] = delta;
    };
    cur('goldPoint', 'gold');
    cur('goldCup', 'goldCup');

    const levelGain = Math.max(0, (Number(S.level) || 1) - (Number(before.level) || 1));
    const expGain = levelGain ? 0 : Math.max(0, (Number(S.exp) || 0) - (Number(before.exp) || 0));
    const stats = {
      power: Math.max(0, (Number(S.power) || 0) - (Number(before.power) || 0)),
      agility: Math.max(0, (Number(S.agility) || 0) - (Number(before.agility) || 0)),
      speed: Math.max(0, (Number(S.speed) || 0) - (Number(before.speed) || 0)),
      maxHp: Math.max(0, (Number(S.maxHp) || 0) - (Number(before.maxHp) || 0)),
    };
    const hasStats = Object.values(stats).some((n) => n > 0);
    if (levelGain || expGain || hasStats) {
      let e = L.exp;
      if (!object(e)) e = L.exp = { beforeLevel: Number(before.level) || 1, beforeExp: Number(before.exp) || 0, grantedExp: 0, levels: 0, stats: { power: 0, agility: 0, speed: 0, maxHp: 0 } };
      if (!object(e.stats)) e.stats = { power: 0, agility: 0, speed: 0, maxHp: 0 };
      e.levels = Math.max(0, Number(e.levels) || 0) + levelGain;
      e.grantedExp = Math.max(0, Number(e.grantedExp) || 0) + expGain;
      for (const k of Object.keys(stats)) e.stats[k] = Math.max(0, Number(e.stats[k]) || 0) + stats[k];
      if (levelGain) changes.level = levelGain;
      if (expGain) changes.exp = expGain;
      if (hasStats) changes.stats = stats;
    }

    const diffList = (list, beforeMap, target, keyName) => {
      const out = {};
      for (const id of Object.keys(debugLevelMap(list))) {
        const now = debugLevelOf(list, id), was = Number(beforeMap[id]) || 0;
        if (now <= was) continue;
        let e = target[id];
        if (!object(e)) e = target[id] = { before: was, granted: 0 };
        if (!Number.isFinite(Number(e.before))) e.before = was;
        e.granted = Math.max(Number(e.granted) || 0, now);
        out[id] = now;
      }
      if (Object.keys(out).length) changes[keyName] = out;
      return out;
    };
    diffList(S.weapons, before.weapons, L.weapons, 'weapons');
    diffList(S.skills, before.skills, L.skills, 'skills');

    const gearChanges = [];
    const beforeGears = new Set(Array.isArray(before.gearKeys) ? before.gearKeys : []);
    for (const g of (Array.isArray(S.gears) ? S.gears : [])) {
      const key = String(g.key);
      if (!key || beforeGears.has(key)) continue;
      if (!L.gears.includes(key)) L.gears.push(key);
      gearChanges.push(key);
    }
    if (gearChanges.length) changes.gears = gearChanges;

    const pickGain = Math.max(0, (Array.isArray(S.wsPicks) ? S.wsPicks.length : 0) - (Number(before.wsPicks) || 0));
    if (pickGain) changes.picks = pickGain;

    if (!Object.keys(changes).length) return null;
    debugPushHistory(L, label, changes);
    save();
    return changes;
  }

  function debugForgetWS(kind, id) {
    if (!S || !object(S.debugLedger)) return;
    const map = kind === 'skill' ? S.debugLedger.skills : S.debugLedger.weapons;
    if (object(map)) delete map[Number(id)];
    save();
  }

  function debugLedgerSummary() {
    const L = S && object(S.debugLedger) ? S.debugLedger : null;
    if (!L) return { hasData: false, entries: [], history: [], removable: 0 };
    const entries = [];
    const addProp = (id, e, kind, name) => {
      const now = kind === 'gold' ? Number(S.goldPoint) || 0 : kind === 'goldCup' ? Number(S.goldCup) || 0 : Number(S.props[id]) || 0;
      const before = Math.max(0, Number(e && e.before) || 0);
      const granted = Math.max(0, Number(e && e.granted) || 0);
      const remove = Math.min(granted, Math.max(0, now - before));
      if (remove > 0) entries.push({ kind, id, name, remove, before, granted, current: now });
    };
    for (const id of Object.keys(L.props || {})) {
      const def = propMap.getValue(Number(id));
      addProp(id, L.props[id], 'prop', def ? def.name : ('道具#' + id));
    }
    if (object(L.gold)) addProp(8, L.gold, 'gold', '金松果');
    if (object(L.goldCup)) addProp(40, L.goldCup, 'goldCup', '金杯');
    const addWS = (map, kind) => {
      for (const id of Object.keys(map || {})) {
        const e = map[id];
        const list = kind === 'weapon' ? S.weapons : S.skills;
        const now = debugLevelOf(list, id);
        if (!now) continue;
        const before = Math.max(0, Number(e && e.before) || 0);
        const granted = Math.max(0, Number(e && e.granted) || 0);
        if (now > before && now <= granted) {
          const def = (kind === 'weapon' ? weaponsMap : skillsMap).getValue(Number(id));
          entries.push({ kind, id: Number(id), name: def ? def.name : (kind + '#' + id),
            mode: before > 0 ? 'restore' : 'remove', before, granted, current: now });
        }
      }
    };
    addWS(L.weapons, 'weapon');
    addWS(L.skills, 'skill');
    const gearKeys = new Set((Array.isArray(S.gears) ? S.gears : []).map((g) => String(g.key)));
    for (const key of (Array.isArray(L.gears) ? L.gears : [])) {
      if (!gearKeys.has(String(key))) continue;
      const g = (Array.isArray(S.gears) ? S.gears : []).find((x) => String(x.key) === String(key));
      const def = g && gearMap.getValue(g.id);
      entries.push({ kind: 'gear', key: String(key), name: def ? def.name : '装备', remove: 1 });
    }
    const exp = object(L.exp) ? {
      levels: Math.max(0, Number(L.exp.levels) || 0),
      grantedExp: Math.max(0, Number(L.exp.grantedExp) || 0),
      stats: object(L.exp.stats) ? L.exp.stats : null,
    } : null;
    const history = (Array.isArray(L.history) ? L.history : []).slice(-20);
    return { hasData: entries.length > 0 || history.length > 0, entries, history, removable: entries.length, exp, createdAt: Number(L.createdAt) || 0 };
  }

  function clearDebugGains() {
    if (!S) return { ok: false, msg: '还没有存档' };
    const sum = debugLedgerSummary();
    if (!sum.entries.length) return { ok: false, msg: '没有可回收的调试所得', summary: sum };
    const removed = [];
    for (const e of sum.entries) {
      if (e.kind === 'prop') {
        const left = Math.max(0, (Number(S.props[e.id]) || 0) - e.remove);
        if (left > 0) S.props[e.id] = left; else delete S.props[e.id];
        removed.push(e.name + '×' + e.remove);
      } else if (e.kind === 'gold') {
        S.goldPoint = Math.max(0, (Number(S.goldPoint) || 0) - e.remove);
        removed.push('金松果×' + e.remove);
      } else if (e.kind === 'goldCup') {
        S.goldCup = Math.max(0, (Number(S.goldCup) || 0) - e.remove);
        removed.push('金杯×' + e.remove);
      } else if (e.kind === 'weapon' || e.kind === 'skill') {
        const list = e.kind === 'weapon' ? S.weapons : S.skills;
        const at = list.findIndex((x) => Number(String(x).split(':')[0]) === Number(e.id));
        if (at >= 0) {
          if (e.mode === 'remove') list.splice(at, 1);
          else list[at] = Number(e.id) + ':' + e.before;
          removed.push(e.name + (e.mode === 'remove' ? '（移除）' : '（还原到 Lv' + e.before + '）'));
        }
      } else if (e.kind === 'gear') {
        const beforeLen = (Array.isArray(S.gears) ? S.gears : []).length;
        S.gears = (Array.isArray(S.gears) ? S.gears : []).filter((g) => String(g.key) !== String(e.key));
        if (S.gears.length !== beforeLen) removed.push(e.name + '（装备）');
      }
    }
    const L = debugLedgerEnsure();
    L.props = {}; L.gold = null; L.goldCup = null; L.exp = null;
    L.weapons = {}; L.skills = {}; L.gears = []; L.clearedAt = Date.now();
    L.history.push({ at: Date.now(), label: '清理调试所得', cleared: removed.length });
    if (L.history.length > DEBUG_LEDGER_MAX_HISTORY) L.history.splice(0, L.history.length - DEBUG_LEDGER_MAX_HISTORY);
    save();
    return { ok: true, removed, summary: debugLedgerSummary(), msg: '已清理 ' + removed.length + ' 项调试所得' };
  }


  window.State = {
    saveKey: SAVE_KEY, uiModeKey: UI_MODE_KEY, testMode: !!testMode, rememberUiMode,
    save, load, newGame, state, switchMode, activeUiMode, hasModeSave, tickEnergy, energyCountdown,
    fileProbe, fileLoad, fileWrite, fileWriteNow, fileInfo, storageMode, flushFileWrite, setSaveTransport, hasFileTransport, readFileRaw, importFileRaw, exportPayload, restorePayload, prepareImport, verifyImport, importFingerprint, syncFormatTime: fmtTime, markLocalFresh: () => { fileState.freshLocal = true; },
    hasLocalSave, localSaveMeta, fileLoadedThisBoot,
    // 调试所得账本：快照/记录/摘要/回收（系统页「调试所得」与 debug.js 用）。
    debugSnapshot, debugRecordDiff, debugForgetWS, debugLedgerSummary, clearDebugGains,
    vipActive, vipLevel, vipUntil, vipDaysLeft, vipRegenMul, vipPassiveExpCap, vipExpNeed,
    vipRow, buyVip, grantVip, tickVipDaily, gearCapacity, syncVipEnergyCap,
    VIP_LEVELS, VIP_LEVEL_EXP, VIP_MAX_LEVEL, VIP_PLANS, VIP_ENERGY_BONUS, vipEnergyCap, VIP_GEAR_BONUS, GEAR_CAPACITY,
    weaponInst, skillInst, myWeapons, mySkills, wsLimit, ownedWSCount,
    upgradeInfo, doUpgrade, upgradeFails, UPGRADE_COIN, UPGRADE_FAIL_BONUS,
    isTrueLevel, TRUE_SKILL_MAX_LEVEL,
    fruitOptions, applyFruitChoice, cancelFruitChoice, pendingFruitChoices,
    trackEarn, earnOn, ensureYesterdayEarnings, addGold,
    apprenticeTributeTable,
    TRIBUTE_LEVEL_SUM_FULL,
    hasUpgradableWS,
    gearInst, myGears, wear, unwear, sellGear, gearSellPrice, gearSellRange, gearQuality, composeGear, mergeGears, addGear, grantStarterGear, setTutorialStep, extText, extTextForGear, extExtraText, extExtraTextForGear, randomExt, randomExtForQuality,
    blackGearEnabled, isBlackGearId, BLACK_PROP_IDS,
    gearBaseAttr, rollGearAttr, gearCostOf, fusionCostOf, gearAttrText, GEAR_ATTR_JITTER,
    FUSION_SAME_NAME_RATE, FUSION_MUTANT_RATE, FUSION_MUTANT_SET, FUSION_ORANGE_MUTANT_SET,
    FUSION_MUTANT_SETS, FUSION_ORANGE_MUTANT_SETS, FUSION_BLACK_MUTANT_SETS, FUSION_EXT_UPGRADE_RATE,
    FUSION_EXT_INHERIT_RATE, FUSION_EXT_SLOTS,
    toggleGearStar, isGearStarred, gearsInDisplayOrder,
    gemLevel, gemPercent, gemMergeRate, rollGemDrop, mergeGems, socketGem, unsocketGem, canSocketGem, gemAffixTotal, gemUnitsForGear, rollGemAffixUnits, normalizeGemUnits, attachmentValue, GEM_AFFIX_TOTALS, GEM_AFFIX_CAP,
    totalStats, equipmentEffects, shopLimit, purchaseStatus, buyProp, useProp, openChestProp, gainRandomWS, wsChoices, wsInfo,
    rankBuy, rankGoodsOf, rankConvertPillPrice, rankConvertPillWeeklyLimit, rankLimitInfo, refreshRankShopDay, rankWeekKey, rankMonthKey, RANK_ACCOUNT_LIMIT_GOODS, RANK_MONTHLY_LIMIT_GOODS,
    chestState, beginChest, confirmChest,
    CHEST_FIXED_POINTS, chestOtherOdds, settlePendingChest,
    blackCardOptions, applyBlackCard, blackGearBoxOptions, applyBlackGearBox,
    ENDLESS_BLACK_CARD_CAP, blackCardWeekKey, syncBlackCardsWeek, endlessBlackCardLeft, grantEndlessBlackCard,
    pendingWS, currentWSChoices, chooseWS, chooseWSRandom,
    // 30 级「自愿支持作者」的一次性提示（落存档，不换任何游戏内好处）。
    supportPromptPending, supportPromptTake, supportPromptReset, SUPPORT_LEVEL,
    SPEED_UNLOCK_LEVEL, SKIP_UNLOCK_LEVEL, VIP_SKIP_UNLOCK_LEVEL, unlockedSpeed, unlockedSkip, skipButtonEnabled,
    BERSERK_SET_ID, BERSERK_LEVEL, BERSERK_CHANCE_AT_50, BERSERK_CHANCE_AT_70, berserkChance,
    AI_FULL_GEAR_LEVEL, aiToolMinLevel, aiToolMaxLevel, aiGearMinLevel,
    playerNormalTotal, playerMaxTotal, playerTotalBounds, foeTotalStats, applyFoeTotalBounds, foeLoadout,
    GEM_SOCKET_COST, GEM_UNSOCKET_COST,
    gainExp, levelUpPreview, levelFrozen, consumeEnergy, tickPropStates, fightReward, revengeReward, markRevenged, revengeInfo, noteRevenge, REVENGE_EXP_RATIO, expBoostPct, gainExpWithBoost,
    apprenticeTributeExpRatio, apprenticeTributeGoldRatio, TRIBUTE_EXP_MIN, TRIBUTE_EXP_MAX, TRIBUTE_GOLD_MIN, TRIBUTE_GOLD_MAX,
    TRIBUTE_DAILY_EXP_CAP, TRIBUTE_DAILY_GOLD_CAP,
    apprenticeCap, learnSkill, setMaster, clearMaster, addPrentice, removePrentice,

    BUILDING_UP_INFO, BUILDING_MAX_LEVEL, BUILDING_KEYS, BUILDING_IDS, BUILDING_LABEL,
    BUILDING_UNLOCK_LEVEL, WAR_UNLOCK_LEVEL, buildingUnlockLevel,
    building, buildingUnlocked, buildingTier, buildingUpInfo, upgradeBuilding,
    settleBuildings, buildingBuffClaimed, claimBuildingBuff, activeBuildingBuff,
    buildingDoubleRate, miracleRecord, normalizeFoeGears,
    petLeadership, PET_UNLOCK_LEVEL, pets, petByKey, petTeam, hatchPet, grantPet, setPetTeam, feedPet, evolvePet, petBattleBonus, applyPetBonuses, randomPetLoadout, PETS, PET_SKILLS,
    gearPart, gearPartQuality, gearIdsOf, autoEnergyPotion,
    gearSetFamily, fusionFamilyInfo,
    apprenticeDailyExp, apprenticeDailyGold, apprenticeDailyTotal, apprenticeDailyStatus,
    apprenticeLevelSum, apprenticeTributeRatio, claimApprenticeExp, canKickToday, kickPrentice,
    beginRecruitChallenge, finishRecruitChallenge, cancelRecruitChallenge,
    MASTER_SKILL_ID, MASTER_SKILL_NAME,
    genAI, randomAIName, fitAIName, clipAIName, AI_NAME_MAX,
    RANDOM_FOE_SCALE, stageProgress, setStageProgress, npcOf, highestStageId, stageRun, stageAccess, stageReward,
    beginStageBattle, finishStageBattle, interruptStageBattle, abandonStageRun, abandonArenaRun, stagePrentice, stagePrenticeFighter, stagePrenticeLost,
    localDate, goldCupToday, addGoldCup,
    dailyStatus, dailyGiftExtra, challengeDailyCount, noteChallengeClear, refreshDaily: syncDailyStats, claimDaily, syncLotteryDay, lotteryDraw, recordBattle, battleHistory, recordWoodBattle,
    // 「消息」红点的记账（落存档，见 normalizeSave 里 msgSeenAt 那段注释）。
    msgSeenAt, markMessagesSeen,
    questStatus, questClaimable, questDate, claimQuest, bumpDaily, QUEST_TYPES, QUEST_EXTRA_POOL, QUEST_GOLD, QUEST_EXP,
    questState, questAvailableAt, questPoolFor, QUEST_COUNT,
    settings, setSettings, normalizeSettings, RESOLUTIONS, resolutionHeight,
    UIMODES, UIMODE_KEYS,
    sellProp, propSellPrice, sellableProps, PROP_SELL_OVERRIDES, MIN_SELL_PRICE,
    BAG_CURRENCY_PROP, isBagCurrencyProp, bagCountOf,
    friendLimit, friendList, friendOf, addFriend, removeFriend, friendFoe, rollFriendCandidates, FRIEND_LIMIT, ensureFriendLoadout,
    friendMessages, leaveFriendMessage, FRIEND_MESSAGE_MAX,
    weaponList, skillList, setWeapon, setSkill, forgetWeapon, forgetSkill, setWS, forgetWS,
    composeConvertPill, composeSeed, challengeExp, challengeFightsPerLevel, usePropMany, energyHardCap, ENERGY_HARD_CAP, PROP_HARD_CAP,
    MAX_PLAYER_LEVEL, energyCapForLevel, levelStaminaPotion,
    statShares, forcedStat, lowestStat,
    STAT_SHARE_MIN, SHARE_KEYS, STAT_KEYS, STAT_NAMES, STAT_GAIN, HP_PER_STAT, FREE_POINT_RANDOM,
    STAT_HARD_CAP, permanentStatTotal, statCapRoom, clampPermanentStats,
    CHALLENGE_EXP_BASE, CHALLENGE_EXP_PER_LEVEL, CHALLENGE_EXP_CAP_LEVEL, EXP_DIFF_STEP, EXP_DIFF_TIGHTEN,
    CHALLENGE_DIFF_RANGE, ARENA_CHAMPION_EXP, ARENA_ENERGY_COST, ARENA_EXP_PER_ENERGY,
  };
})();
