// tower.js — 无尽挑战塔 · 主塔 + 无尽模式状态机
(function () {
  'use strict';

  // 联机版状态存 TowerLocal，战斗走本机 Sim；奖励由服务端 claimEndlessTower 发。
  const ONLINE = typeof window !== 'undefined' && !!window.__SSDZ_ONLINE__;
  const S = () => (ONLINE && window.TowerLocal ? window.TowerLocal.state() : State.state());
  const D = () => window.TowerData;
  const save = () => {
    if (ONLINE && window.TowerLocal) { window.TowerLocal.save(); return; }
    State.save();
  };
  const isHeroRun = (run) => !!(run && run.ruleset === 'hero' && run.hero && window.TowerHero);
  const heroBaseHp = (run) => isHeroRun(run) ? TowerHero.fighter(run.hero).maxHp : State.totalStats({ useProps: false }).hp;
  function runWeapons(run) { return isHeroRun(run) ? run.hero.weapons.map(State.weaponInst).filter(Boolean) : (State.myWeapons ? State.myWeapons() : []); }
  function runSkills(run) { return isHeroRun(run) ? run.hero.skills.map(State.skillInst).filter(Boolean) : (State.mySkills ? State.mySkills() : []); }
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  let attemptSeq = 0;

  const HERO_NAME = { tl: '螳螂大侠', xh: '仙鹤大侠', xm: '熊猫大侠' };
  const HERO_SKILL = { tl: 19, xh: 20, xm: 22 };
  const HERO_REGION = { tl: 3, xh: 4, xm: 1 };
  const UNLOCK_STAGES = 18;

  const ENDLESS_UNLOCK_LEVEL = 20;
  const TICKET_PROP = 50, BOOK_PROP = 23;
  // 即时削弱「敌人生命上限 −N%」的唯一上限（E07 挫锐 / E08 卸甲）。
  const ENEMY_MAXHP_DOWN_CAP = 0.6;

  const HERO_EARLY_FOE_MUL = 0.90;
  const HERO_EARLY_FOE_LAST_LAYER = 5;

  const ENDLESS_EARLY_FOE_MUL = 0.95;
  const ENDLESS_EARLY_FOE_LAST_LAYER = 5;

  function debug(flag) { return typeof debugOn === 'function' && debugOn(flag); }

  function freeCoinSpend() { return debug('noCoinCost'); }



  function tower() {
    const s = S();
    if (!s.tower || typeof s.tower !== 'object') s.tower = { maxLayer: 0, run: null };
    s.tower.maxLayer = Math.max(0, Math.floor(Number(s.tower.maxLayer) || 0));
    if (s.tower.run) s.tower.run = normalizeRunCached(s.tower.run, 'tower');
    return s.tower;
  }
  function endless() {
    const s = S();
    if (!s.endless || typeof s.endless !== 'object') s.endless = {
      best: 0, weekBest: 0, weekKey: '', bestLayer: 0,
      heroBest: 0, heroWeekBest: 0, heroBestLayer: 0, shieldDate: '', run: null,
    };
    const e = s.endless;
    e.best = Math.max(0, Math.floor(Number(e.best) || 0));
    e.weekBest = Math.max(0, Math.floor(Number(e.weekBest) || 0));
    e.bestLayer = Math.max(0, Math.floor(Number(e.bestLayer) || 0));
    if (typeof e.weekKey !== 'string') e.weekKey = '';
    if (typeof e.shieldDate !== 'string') e.shieldDate = '';
    // 剧情：{ 剧情 id: true } = 这段只播一次的剧情已经播过了。
    // 界面靠它决定「进店前那段商人剧情」还要不要走。
    if (!e.storySeen || typeof e.storySeen !== 'object' || Array.isArray(e.storySeen)) e.storySeen = {};
    const mon = mondayKey();
    if (e.weekKey !== mon) { e.weekKey = mon; e.weekBest = 0; e.heroWeekBest = 0; }
    for (const key of ['heroBest', 'heroWeekBest', 'heroBestLayer']) e[key] = Math.max(0, Math.floor(Number(e[key]) || 0));
    if (e.run) e.run = normalizeRunCached(e.run, 'endless');
    return e;
  }
  // · 给某一局挂一段「待播放的剧情 id」（`run.story`，随存档走，重载也还在）；

  function setRunStory(mode, id) {
    const box = mode === 'tower' ? tower() : endless();
    if (!box.run || !id) return null;
    box.run.story = String(id);

    const runId = String(id);
    if (runId === 'layer100') box.run.x00PreNo = Math.max(1, Math.floor(Number(box.run.x00PreNo) || 0));
    else if (runId === 'x00a') box.run.x00PreNo = Math.max(2, Math.floor(Number(box.run.x00PreNo) || 0));
    save();
    return box.run.story;
  }

  function clearRunStory(mode) {
    const box = mode === 'tower' ? tower() : endless();
    if (!box.run) return false;
    // 连「延迟一步」那一份一起清（`pendingStoryId` / 停留标记）——
    // 否则播完提示窗之后还会被反复交接，或者卡在「待播但界面不认」的状态里。
    const had = !!(box.run.story || box.run.pendingStory);
    delete box.run.story;
    delete box.run.pendingStory;
    delete box.run.pendingStoryHold;
    if (had) save();
    return had;
  }

  function clearRunStoryHold() {
    const run = endless().run;
    if (!run || !run.pendingStoryHold) return false;
    delete run.pendingStoryHold;
    save();
    return true;
  }
  // 「延迟一步」那一段播完了：把待播槽（`pendingStory` / `pendingStoryHold`）清掉，
  // ⚠ 这是「第一次失烙印」那条链的收尾：漏掉它，待播槽在界面判定里会一直排在 `run.story`
  function clearRunStoryPending(mode) {
    const box = mode === 'tower' ? tower() : endless();
    const run = box.run;
    if (!run) return false;
    const had = !!(run.pendingStory || run.pendingStoryHold);
    delete run.pendingStory;
    delete run.pendingStoryHold;
    if (had) save();
    return had;
  }


  function storySeenKey(id) {
    const key = String(id || '');
    if (!key) return '';
    return isHeroRun(endless().run) ? 'hero:' + key : key;
  }
  function storySeen(id) { return !!(endless().storySeen || {})[storySeenKey(id)]; }

  function markStorySeen(id) {
    if (!id) return false;
    const e = endless();
    e.storySeen = Object.assign({}, e.storySeen, { [storySeenKey(id)]: true });
    save();
    return true;
  }
  // 剧情模式开着吗（无尽首页左下角那颗按钮；挑战模式 = 关）。
  // 存档里存的是 `endless().storyOn`，默认 true（剧情模式）。
  function storyEnabled() { return endless().storyOn !== false; }

  function setStoryEnabled(on) {
    const e = endless();
    e.storyOn = !!on;
    save();
    return storyEnabled();
  }

  function markShopStoryShown(mode) {
    const box = mode === 'tower' ? tower() : endless();
    if (!box.run || !box.run.shop) return false;
    box.run.shop.storyShown = true;
    save();
    return true;
  }

  function setShopStoryPick(id) {
    const box = endless();
    if (!box.run || !box.run.shop || !id) return false;
    box.run.shop.storyPick = String(id);
    save();
    return true;
  }
  function mondayKey() {
    try {
      if (window.State && typeof State.rankWeekKey === 'function') return State.rankWeekKey();
    } catch (e) {}
    const d = new Date(Date.now());
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 联机版无尽塔周奖励的只读账本（周一 00:00 换周；服务端 `claimEndlessTower` 是权威写入口）。
  // 本机时钟只用于预览：换周后最多把上一周的已用额度先当成 0，服务端回包会再校正。
  function onlineWeekState() {
    const tr = (typeof window !== 'undefined' && window.TowerRewards) || null;
    const cap = Math.max(1, Math.floor(Number(tr && tr.WEEK_CAP) || 10));
    const s = S();
    const box = (s && s.towerWeek && typeof s.towerWeek === 'object') ? s.towerWeek : {};
    const week = mondayKey();
    const same = String(box.week || '') === week;
    const used = same ? Math.max(0, Math.min(cap, Math.floor(Number(box.tickets) || 0))) : 0;
    const trueEndBonusUsed = same && box.trueEndBonus === true;
    return { week, used, cap, left: Math.max(0, cap - used), trueEndBonusUsed };
  }
  // 同名增益可以并排占多个背包栏位，于是「同名」≠「同一条」：
  // · 成长进度记在行上（`row.grow`），run 上的旧字段只是「各栏求和」的镜像；
  // 所有「针对某一条」的操作（附魔 / 卖出 / 交换 / 移除 / 替换 / 取消）都必须传 uid。
  const GROW_FIELDS = ['killPower', 'winMaxHp', 'winHpFlat', 'winStatPower', 'winStatAgility', 'winStatSpeed', 'winTakenMul', 'sellBonus'];
  const GROW_SPEND_FIELDS = ['power', 'agility', 'speed', 'hp'];
  // 逐栏成长对象：只保留已知字段与正数（坏档兜底）。
  function cleanGrowObj(g) {
    if (!g || typeof g !== 'object') return null;
    const out = {};
    for (const k of GROW_FIELDS) { const v = Math.max(0, Number(g[k]) || 0); if (v > 0) out[k] = v; }
    if (g.spend && typeof g.spend === 'object') {
      const sp = {};
      for (const k of GROW_SPEND_FIELDS) { const v = Math.max(0, Number(g.spend[k]) || 0); if (v > 0) sp[k] = v; }
      if (GROW_SPEND_FIELDS.some((k) => sp[k] > 0)) out.spend = sp;
    }
    return Object.keys(out).length ? out : null;
  }
  function growAdd(row, key, val) {
    const v = Number(val) || 0;
    if (!row || !(v > 0) || GROW_FIELDS.indexOf(key) < 0) return;
    row.grow = row.grow || {};
    row.grow[key] = Math.max(0, Number(row.grow[key]) || 0) + v;
  }

  function growOf(row, key) { return Math.max(0, Number(row && row.grow && row.grow[key]) || 0); }
  // 这样：① 旧调用方直接读写 run 字段仍然有效；② 卖出 / 交换某一栏时能精确扣掉它那一份。
  function addGrow(run, row, key, val) {
    const v = Number(val) || 0;
    if (!(v > 0) || GROW_FIELDS.indexOf(key) < 0) return;
    growAdd(row, key, v);
    if (run) run[key] = Math.max(0, Number(run[key]) || 0) + v;
  }

  function subGrow(run, row, key) {
    const v = growOf(row, key);
    if (!(v > 0) || !run) return v;
    run[key] = Math.max(0, (Number(run[key]) || 0) - v);
    return v;
  }
  // C25「战利品账本」这一栏自己的累计加价。
  // 那个数是其它栏位的合计。否则同店卖掉一本、再买一本时，新账本会继承
  // 只有真正还没迁移到逐栏账本的旧档（`run.growByRow` 未置位）才退回 run 级合计。
  function sellBonusOf(run, row) {
    if (row) {
      const own = growOf(row, 'sellBonus');
      if (own > 0) return own;
      if (run && run.growByRow) return 0;
    }
    return Math.max(0, Number(run && run.sellBonus) || 0);
  }
  // 深校验一份读档出来的 run：坏档直接作废（不收费、不掉层）。
  function normalizeRun(run, mode) {
    if (!run || typeof run !== 'object') return null;
    // 旧档里存着 E01 的 run.postBattleShop 缓存：这套缓存已经废弃
    if ('postBattleShop' in run) delete run.postBattleShop;
    if (mode === 'endless' && run.ruleset === 'hero') {
      run.hero = window.TowerHero && TowerHero.normalize(run.hero);
      if (!run.hero) return null;
      const seenMentor = !!(run.hero.events && run.hero.events.mentor);
      run.heroMentorMintDone = run.heroMentorMintDone === true || seenMentor;
      run.heroMentorPending = run.heroMentorPending === true && !seenMentor;
      run.eventRegen = (Array.isArray(run.eventRegen) ? run.eventRegen : [])
        .map((e) => ({
          id: String((e && e.id) || 'event'),
          pct: clamp01(e && e.pct),
          left: Math.max(0, Math.floor(Number(e && e.left) || 0)),
        }))
        .filter((e) => e.pct > 0 && e.left > 0);
    } else run.ruleset = 'default';
    const layer = Math.floor(Number(run.layer));
    if (!Number.isFinite(layer) || layer < 1 || !Array.isArray(run.plan) || !run.plan.length) return null;
    // 旧档 id 迁移：G/T 两组重排过序号（见 tower-data.js 的 LEGACY_BUFF_IDS）。
    // 只按 buffVer 判断一次：旧档没有这个字段才搬，搬完打上新版本号。
    // 新档（buffVer 已是最新）绝不走这张表 —— 否则新代码里合法的 T04（见血封喉）
    const legacyIds = run.buffVer !== D().BUFF_VER;
    const remapId = (id) => ((legacyIds && D().LEGACY_BUFF_IDS[id]) || id);
    run.buffVer = D().BUFF_VER;
    const buffDef = (b) => ((b && typeof b === 'object') ? D().BUFF_BY_ID[remapId(b.id)] : null);
    const buffOk = (b) => !!buffDef(b);
    // 暴击精通（C21）改成「每次拾取占一个新栏位」：stackCap 现在是 1，
    // 但旧存档里同一栏可能已经叠到 3 层 —— 归一化时保留旧层数（最多 3），
    const clampStacks = (def, v) => {
      const cap = def && def.id === 'C21' ? Math.max(3, D().stackCap(def)) : D().stackCap(def);
      return Math.max(1, Math.min(cap, Math.floor(Number(v) || 1)));
    };
    // 归一化只保留「有效字段」：注意 `at`（获得顺序号）必须留着 ——
    // 商店的出售 / 交换列表按它正序排，抹掉再补号会把顺序按「永久表在前、限次表在后」重排，
    const cleanBuffs = (list) => (Array.isArray(list) ? list.filter(buffOk)
      .map((b) => {
        const def = buffDef(b);
        const out = { id: def.id, stacks: clampStacks(def, b.stacks) };
        const at = Math.max(0, Math.floor(Number(b && b.at) || 0));
        if (at > 0) out.at = at;

        if (b && b.spend != null) out.spend = Math.max(0, Number(b.spend) || 0);
        if (b && b.procs != null) out.procs = Math.max(0, Math.floor(Number(b.procs) || 0));
        if (b && b.limitedSpend != null) out.limitedSpend = Math.max(0, Number(b.limitedSpend) || 0);
        // 每栏自己的成长进度与破碎随机数种子必须留在白名单里。
        const grow = cleanGrowObj(b && b.grow);
        if (grow) out.grow = grow;
        const fseed = Math.max(0, Math.floor(Number(b && b.fragileSeed) || 0));
        if (fseed > 0) out.fragileSeed = fseed;
        // 栏位身份与「附魔免占位」都是逐条的，必须留在白名单里。
        const uid = Math.max(0, Math.floor(Number(b && b.uid) || 0));
        if (uid > 0) out.uid = uid;
        if (b && b.slotFree === true) out.slotFree = true;

        const ench = (b && Array.isArray(b.enchants)) ? b.enchants.filter((v, i, a) => v && a.indexOf(v) === i) : [];
        if (ench.length) out.enchants = ench.map(String);
        const emul = Number(b && b.enchMul);
        if (Number.isFinite(emul) && emul > 0 && emul !== 1) out.enchMul = emul;
        return out;
      }) : []);
    run.layer = layer;
    run.idx = Math.max(0, Math.min(run.plan.length - 1, Math.floor(Number(run.idx) || 0)));
    run.carry = Math.max(0.01, clamp01(run.carry == null ? 1 : run.carry));
    if (!Array.isArray(run.permanent) || !Array.isArray(run.limited)) {
      const oldBattle = cleanBuffs(run.battleBuffs), oldLayer = cleanBuffs(run.layerBuffs), oldRun = cleanBuffs(run.buffs);
      run.permanent = oldRun.filter((b) => D().BUFF_BY_ID[b.id] && D().BUFF_BY_ID[b.id].kind === 'permanent')
        .concat(oldLayer.filter((b) => D().BUFF_BY_ID[b.id] && D().BUFF_BY_ID[b.id].kind === 'permanent'));
      run.limited = oldBattle.concat(oldLayer).filter((b) => D().BUFF_BY_ID[b.id] && D().BUFF_BY_ID[b.id].kind === 'limited')
        .map((b) => ({ id: b.id, stacks: b.stacks, uses: Number(b.uses) || D().BUFF_BY_ID[b.id].uses || 1, on: b.on !== false }));
    }    /* 段位机制已并入环境词缀：run.mechs 只作历史兼容，永远为空。 */
    run.mechs = [];
    // 旧档的「勇者之剑」HB01 是 permanent 的；新数据里 HB01 是限次件的初始阶段。
    // 这里把它搬到 limited、补 uses / 献祭层数 / 闲置计数等字段，并且只保留一把。
    (function normalizeBlade() {
      const ids = D().BLADE.ids;
      const isBlade = (row) => !!(row && ids.indexOf(String(row.id)) >= 0);
      const oldPerm = (run.permanent || []).filter(isBlade);
      run.permanent = (run.permanent || []).filter((row) => !isBlade(row));
      const existing = (run.limited || []).find(isBlade) || null;
      const blade = existing || oldPerm[0] || null;
      run.limited = (run.limited || []).filter((row) => row && !isBlade(row));
      if (!blade) return;
      const def = D().BUFF_BY_ID[blade.id] || D().BUFF_BY_ID[D().BLADE.initialId];
      blade.id = def && isBlade(def) ? def.id : D().BLADE.initialId;
      const max = Math.max(1, Number(D().BLADE.maxStacks) || 5);
      blade.stacks = Math.max(1, Math.min(max, Math.floor(Number(blade.stacks) || 1)));
      const deftUses = Number(def && def.uses);
      const rowUses = Math.floor(Number(blade.uses));
      blade.uses = (deftUses < 0) ? -1
        : (Number.isFinite(rowUses) && rowUses > 0 ? rowUses : Math.max(1, deftUses || 1));
      blade.on = blade.on !== false;
      blade.idleBattles = Math.max(0, Math.floor(Number(blade.idleBattles) || 0));
      blade.forced = blade.forced === true;
      blade.suppressStreak = Math.max(0, Math.min(2, Math.floor(Number(blade.suppressStreak) || 0)));
      run.limited.push(blade);
    })();
    // 渴血之剑的两类「还没处理」标记：都必须跟存档走，下一场才不会被绕过。
    run.bladeEventDone = Math.max(0, Math.floor(Number(run.bladeEventDone) || 0));
    if (!bladeRowOf(run)) { delete run.bladeSacrificePending; delete run.bladeEventPending; }
    if (run.bladeSacrificePending === true) run.bladeSacrificePending = true;
    else delete run.bladeSacrificePending;
    const bladeEvt = run.bladeEventPending;
    if (bladeEvt && typeof bladeEvt === 'object'
        && Number(bladeEvt.layer) === run.layer && bladeRowOf(run)) {
      run.bladeEventPending = { layer: run.layer, id: 'bladeEvent' };
    } else delete run.bladeEventPending;

    run.storyQueue = (Array.isArray(run.storyQueue) ? run.storyQueue : [])
      .map((id) => String(id || '')).filter(Boolean).slice(-4);
    if (run.pillSlots) delete run.pillSlots;
    // 即时削弱的累计值（E07/E08 生命上限、E11 攻击力）：夹在 0~上限，坏值不许把敌人打成 0。
    run.enemyMaxHpDown = Math.max(0, Math.min(ENEMY_MAXHP_DOWN_CAP, Number(run.enemyMaxHpDown) || 0));

    run.legendPity = Math.max(0, Math.floor(Number(run.legendPity) || 0));
    // `patrolStoryAt` = 本层已经讲过巡视剧情（换层即失效），`patrolMeetNo` = 讲到第几段。
    // 两个都必须是干净的整数 —— 它们是「一次偶遇只讲一段」的唯一依据，
    run.patrolMeetNo = Math.max(0, Math.floor(Number(run.patrolMeetNo) || 0));
    const patrolStoryAt = Math.floor(Number(run.patrolStoryAt) || 0);
    if (patrolStoryAt > 0) run.patrolStoryAt = patrolStoryAt;
    else delete run.patrolStoryAt;
    // 巡视魔王每 10 层区块只刷新一次：旧档缺字段按 0 补齐，坏值夹回整数。
    run.patrolDoneBlock = Math.max(0, Math.floor(Number(run.patrolDoneBlock) || 0));
    run.patrolDoneWins = Math.max(0, Math.floor(Number(run.patrolDoneWins) || 0));

    const mirrorTaken = Math.floor(Number(run.mirrorTaken) || 0);
    if (mirrorTaken > 0) run.mirrorTaken = mirrorTaken;
    else delete run.mirrorTaken;
    const cleanMirror = cleanMirrorSnapshot(run.mirrorSnapshot);
    if (cleanMirror) run.mirrorSnapshot = cleanMirror;
    else delete run.mirrorSnapshot;

    run.x00PreNo = Math.max(0, Math.min(2, Math.floor(Number(run.x00PreNo) || 0)));
    run.x00stage = Math.max(0, Math.min(4, Math.floor(Number(run.x00stage) || 0)));

    run.skippedBattles = Math.max(0, Math.min(Math.max(0, (Array.isArray(run.plan) ? run.plan.length : 0)),
      Math.floor(Number(run.skippedBattles) || 0)));
    // 战斗掉落 / 场间选择的待选增益（`run.choices`）与排队中的下一批（`run.choiceQueue`）：
    // 玩家退出重进就白丢一次掉落，靠重打同一场还能换一组。这里只做轻校验：
    const cleanChoiceList = (list) => (Array.isArray(list) ? list.map((c) => {
      const id = remapId(typeof c === 'string' ? c : (c && c.id));
      return id && D().BUFF_BY_ID[id] ? { type: 'buff', id: id } : null;
    }).filter(Boolean).slice(0, 8) : []);
    run.choices = cleanChoiceList(run.choices);
    run.choiceQueue = (Array.isArray(run.choiceQueue) ? run.choiceQueue : [])
      .map((q) => ({ choices: cleanChoiceList(q && q.choices),
        kind: (q && q.kind === 'patrolLegendary') ? 'patrolLegendary' : 'normal' }))
      .filter((q) => q.choices.length);
    if (!run.choices.length) { run.choices = null; run.choicesKind = null; }
    else run.choicesKind = run.choicesKind === 'patrolLegendary' ? 'patrolLegendary' : 'normal';

    if (!run.choices) advanceChoiceQueue(run);
    // 上一场失利后的「重新挑战 / 放弃本局」还没选：这个状态必须跟着存档走，
    // 否则退出重进就能绕过铸币直接白打一场。层号 / 场次对不上就当作废（旧档兜底）。
    const pendingRetry = run.pendingRetry;
    if (pendingRetry && typeof pendingRetry === 'object'
        && Number(pendingRetry.layer) === run.layer && Number(pendingRetry.idx) === run.idx) {
      run.pendingRetry = { layer: run.layer, idx: run.idx, battleNo: run.idx + 1,
        battleCount: run.plan.length, score: Math.max(0, Number(run.score) || 0) };
    } else delete run.pendingRetry;
    // 战斗掉落种子：同一场战斗（含退出重进 / 铸币回滚）必须落在同一组选项上。
    // 下一次开战会生成新的种子；它随 `retrySnap` 一起回滚。
    run.battleSerial = Math.max(0, Math.floor(Number(run.battleSerial) || 0));
    const battleSeed = Math.floor(Number(run.battleChoiceSeed));
    if (Number.isFinite(battleSeed) && battleSeed > 0) run.battleChoiceSeed = battleSeed >>> 0;
    else delete run.battleChoiceSeed;
    // 之后镜像字段由 syncSpendMirrors 维护（读旧字段的界面 / 探针不受影响）。
    run.shopSpendProcs = Math.max(0, Math.floor(Number(run.shopSpendProcs) || 0));

    if (run.pickGot && typeof run.pickGot === 'object') {
      const cleanGot = {};
      for (const k of Object.keys(run.pickGot)) {
        const v = Math.max(0, Math.floor(Number(run.pickGot[k]) || 0));
        if (v > 0) cleanGot[k] = v;
      }
      run.pickGot = cleanGot;
    }
    (function migrateSpendProgress() {
      const legacy = Math.max(0, Number(run.shopSpend) || 0);
      const legacyProcs = Math.max(0, Math.floor(Number(run.shopSpendProcs) || 0));
      const legacy58 = Math.max(0, Number(run.shopSpendLimited) || 0);
      const row36 = (run.permanent || []).find((b) => b && b.id === 'C36');
      const row58 = (run.permanent || []).find((b) => b && b.id === 'C58');
      if (row36) {
        if (row36.spend == null && row36.procs == null && (legacy > 0 || legacyProcs > 0)) {
          row36.spend = legacy; row36.procs = legacyProcs;
        }
        row36.spend = Math.max(0, Number(row36.spend) || 0);
        row36.procs = Math.max(0, Math.floor(Number(row36.procs) || 0));
      }
      if (row58) {
        if (row58.limitedSpend == null && legacy58 > 0) row58.limitedSpend = legacy58;
        row58.limitedSpend = Math.max(0, Number(row58.limitedSpend) || 0);
      }
      // 顺带把镜像字段同步成「各栏求和」（卖 / 替换掉一栏之后镜像不会残留旧值）。
      syncSpendMirrors(run);
    })();
    run.enemyPowerDown = Math.max(0, Math.min(0.8, Number(run.enemyPowerDown) || 0));
    // 槽位相关字段的防御性规范化（当前存档已经会带上它们，这里是第二道闸）：
    // permSlotIds 是权威记录、permSlots 由它派生、两者取最大值兼容旧档 ——
    // 只要有一份字段缺失（旧档 / 同步来的残缺档），下面那行
    const cleanIds = (v) => (Array.isArray(v) ? v.filter((id) => typeof id === 'string' && id) : []);
    run.permSlotIds = cleanIds(run.permSlotIds);
    const slotFromIds = run.permSlotIds.reduce((sum, id) => {
      const def = D().BUFF_BY_ID[id];
      return sum + Math.max(0, Number(def && def.mods && def.mods.permSlot) || 0);
    }, 0);
    run.permSlots = Math.max(slotFromIds, Math.max(0, Number(run.permSlots) || 0));

    run.slotFreeIds = cleanIds(run.slotFreeIds);
    (function migrateSlotFree() {
      const legacy = run.slotFreeIds.slice();
      for (const id of legacy) {
        const rows = (run.permanent || []).filter((b) => b && b.id === id);
        if (!rows.length || rows.some((b) => rowFreeOf(b))) continue;
        rows[0].slotFree = true;
      }
      syncSlotFree(run);
    })();
    // 栏位身份：老档没有 uid → 按顺序补一个，并保证唯一。
    (function ensureUids() {
      run.rowUidSeq = Math.max(0, Math.floor(Number(run.rowUidSeq) || 0));
      const seen = Object.create(null);
      for (const row of (run.permanent || []).concat(run.limited || [])) {
        let uid = Math.max(0, Math.floor(Number(row && row.uid) || 0));
        if (!uid || seen[uid]) uid = run.rowUidSeq + 1;
        seen[uid] = true;
        row.uid = uid;
        if (uid > run.rowUidSeq) run.rowUidSeq = uid;
      }
    })();

    (function ensureInscriptions() {
      for (const row of (run.permanent || []).concat(run.limited || [])) {
        if (!row) continue;
        row.enchants = rowEnchantsOf(row).filter((v, i, a) => v && a.indexOf(v) === i);
        const m = Number(row.enchMul);
        row.enchMul = (Number.isFinite(m) && m > 0) ? m : 1;
      }
    })();
    run.pickBuffIds = cleanIds(run.pickBuffIds);
    // 绝不在这里丢弃永久增益。
    // 上限 8、占用 7/8（其中 1 个免占位 → 数组长度 8），
    // 上限的维护收口在 addBuff（按「加入后占用是否超上限」判定、超了就要求替换），
    run.permanent = cleanBuffs(run.permanent);
    run.permanent = repairPermanentSlots(run, run.permanent);
    run.limited = (Array.isArray(run.limited) ? run.limited : [])
      .filter((b) => { const d = buffDef(b); return !!d && d.kind === 'limited'; })
      .map((b) => {
        const def = buffDef(b);
        // 渴血之剑的字段是逐行状态机（闲置计数 / 强制苏醒 / 抑制连击 / 永续 uses=-1）：
        // 不能走下面普通限次件的白名单重建，否则每次归一化都会把它们抹掉。
        if (D().isBladeId(def.id)) {
          b.id = def.id;
          b.stacks = clampStacks(def, b.stacks);
          const defUses = Number(def.uses);
          b.uses = defUses < 0 ? -1 : Math.max(0, Math.floor(Number(b.uses) || 0));
          b.on = b.on !== false;
          b.idleBattles = Math.max(0, Math.floor(Number(b.idleBattles) || 0));
          b.forced = b.forced === true;
          b.suppressStreak = Math.max(0, Math.min(2, Math.floor(Number(b.suppressStreak) || 0)));
          return b;
        }
        const out = { id: def.id, stacks: clampStacks(def, b.stacks),
          uses: Math.max(0, Math.floor(Number(b.uses) || 0)), on: b.on !== false };
        if (b && b.spend != null) out.spend = Math.max(0, Number(b.spend) || 0);
        if (b && b.procs != null) out.procs = Math.max(0, Math.floor(Number(b.procs) || 0));
        if (b && b.limitedSpend != null) out.limitedSpend = Math.max(0, Number(b.limitedSpend) || 0);

        const grow2 = cleanGrowObj(b && b.grow);
        if (grow2) out.grow = grow2;
        const fseed2 = Math.max(0, Math.floor(Number(b && b.fragileSeed) || 0));
        if (fseed2 > 0) out.fragileSeed = fseed2;
        const uid = Math.max(0, Math.floor(Number(b && b.uid) || 0));
        if (uid > 0) out.uid = uid;
        if (b && b.slotFree === true) out.slotFree = true;
        const at = Math.max(0, Math.floor(Number(b && b.at) || 0));    // 同上：获得顺序号要留着
        if (at > 0) out.at = at;
        return out;
      })
      .filter((b) => D().isBladeId(b.id) || b.uses > 0);
    if (run.mode === 'tower') run.limited = run.limited.map((b) => Object.assign(b, { uses: 1, on: true }));
    if (!Array.isArray(run.buffs)) run.buffs = [];

    if (!run.growByRow) {
      const allRows = (run.permanent || []).concat(run.limited || []);
      const firstRowOf = (id) => allRows.find((b) => b && b.id === id) || null;
      const hand = (id, key, val) => {
        const v = Math.max(0, Number(val) || 0);
        const row = firstRowOf(id);
        if (row && v > 0) growAdd(row, key, v);
      };
      hand('C06', 'killPower', run.killPower);
      hand('C07', 'winMaxHp', run.winMaxHp);
      hand('C11', 'winHpFlat', run.winHpFlat);
      if (run.winStatPower > 0 || run.winStatAgility > 0 || run.winStatSpeed > 0) {
        const row = firstRowOf('C12');
        if (row) {
          growAdd(row, 'winStatPower', run.winStatPower);
          growAdd(row, 'winStatAgility', run.winStatAgility);
          growAdd(row, 'winStatSpeed', run.winStatSpeed);
        }
      }
      hand('C25', 'sellBonus', run.sellBonus);
      hand('C48', 'winTakenMul', run.winTakenMul);
      run.growByRow = 1;
    }
// 注意：attempt/choices 的作废只在读档时做（state.js normalizeSave），
// 这里是每次访问都会跑的深校验，不能动进行中的战斗令牌。
    if (mode === 'tower') run.pot = Math.max(0, Math.floor(Number(run.pot) || 0));
    else {
      run.coins = Math.max(0, Math.floor(Number(run.coins) || 0));

    run.grantedSkills = (Array.isArray(run.grantedSkills) ? run.grantedSkills : [])
      .map((id) => Number(String(id).split(':')[0]))
      .filter((id, i, arr) => id > 0 && arr.indexOf(id) === i && skillsMap.getValue(id));
      run.score = Math.max(0, Math.floor(Number(run.score) || 0));
      run.bestLayer = Math.max(0, Math.floor(Number(run.bestLayer) || 0));
      run.killPower = Math.max(0, Number(run.killPower) || 0);
      run.winMaxHp = Math.max(0, Number(run.winMaxHp) || 0);
      run.fragileBase = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBase || {});
      run.fragileBurned = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBurned || {});

      if (!run.fragileAliveFull) {
        for (const k of ['power', 'agility', 'speed']) {
          run.fragileBase[k] = Math.max(0, Number(run.fragileBase[k]) || 0) / 2;
        }
        run.fragileAliveFull = 1;
      }
      run.fragileGot = Object.assign({}, run.fragileGot || {});

      run.fragileCoinBase = Math.max(0, Math.floor(Number(run.fragileCoinBase) || 0));
      run.fragileCoinBurned = Array.isArray(run.fragileCoinBurned)
        ? run.fragileCoinBurned.map((v) => Math.max(0, Number(v) || 0)).filter((v) => v > 0) : [];
      run.fragileHealBurned = Array.isArray(run.fragileHealBurned)
        ? run.fragileHealBurned.map((v) => Math.max(0, Number(v) || 0)).filter((v) => v > 0) : [];

      if (run.fragileHealBase === undefined) {
        const c52 = (run.limited || []).reduce((n, b) => n + (b && b.id === 'C52' ? Math.max(0, Math.floor(Number(b.stacks) || 1)) : 0), 0);
        run.fragileHealBase = c52;
        if (c52 > 0) run.fragileMulBase = Math.max(0, Math.floor(Number(run.fragileMulBase) || 0) - c52);
      }
      run.fragileHealBase = Math.max(0, Math.floor(Number(run.fragileHealBase) || 0));
      run.brokenMarks = Array.isArray(run.brokenMarks)
        ? run.brokenMarks.filter((m) => m && typeof m.kind === 'string')
          .map((m) => ({
            kind: m.kind,
            legacy: m.legacy === true,
            stat: typeof m.stat === 'string' ? m.stat : undefined,
            pct: Math.max(0, Number(m.pct) || 0),
            alive: Math.max(0, Number(m.alive) || 0),
            burned: Math.max(0, Number(m.burned) || 0),
          })) : [];

      run.fragileMulBase = Math.max(0, Math.floor(Number(run.fragileMulBase) || 0));
      run.fragileMulBurned = Math.max(0, Math.floor(Number(run.fragileMulBurned) || 0));
      if (run.fragileMulBurned > 0 &&
          !run.brokenMarks.some((m) => m.kind === 'final')) {
        run.brokenMarks.push({ kind: 'final', alive: 0.25, burned: 0.5, legacy: true });
      }
      for (const k of ['power', 'agility', 'speed']) {
        run.fragileBase[k] = Math.max(0, Number(run.fragileBase[k]) || 0);
        run.fragileBurned[k] = Math.max(0, Number(run.fragileBurned[k]) || 0);

        if (run.fragileBurned[k] > 0 &&
            !run.brokenMarks.some((m) => m.kind === 'stat' && m.stat === k)) {
          run.brokenMarks.push({ kind: 'stat', stat: k, pct: run.fragileBurned[k], legacy: true });
        }
      }
      if (run.stickyStat) {
        for (const k of ['power', 'agility', 'speed']) {
          const oldv = Math.max(0, Number(run.stickyStat[k]) || 0);
          if (oldv > run.fragileBurned[k]) run.fragileBurned[k] = oldv;
        }
        delete run.stickyStat;
      }
      run.fragileSeeds = Object.assign({}, run.fragileSeeds || {});

      run.achievements = Array.isArray(run.achievements) ? run.achievements.slice(0, 40) : [];
      run.scoreLog = Array.isArray(run.scoreLog) ? run.scoreLog.slice(-60) : [];
      run.statPeaks = Object.assign({}, run.statPeaks || {});
      // 成就提示与过程飘字是两个队列：成就项是对象（name/points），过程飘字是字符串。
      // 否则界面会把它当字符串贴出去，显示成「[object Object]」。
      const pending = Array.isArray(run.pendingToasts) ? run.pendingToasts.slice(0, 12) : [];
      run.pendingToasts = pending.filter((item) => !(item && typeof item === 'object'));
      run.pendingAchievements = (Array.isArray(run.pendingAchievements) ? run.pendingAchievements.slice(0, 12) : [])
        .concat(pending.filter((item) => item && typeof item === 'object'));
      if (run.pendingAchievements.length > 12) run.pendingAchievements.splice(0, run.pendingAchievements.length - 12);
      run.deathSaves = Math.max(0, Math.floor(Number(run.deathSaves) || 0));
      run.reviveCount = Math.max(0, Math.floor(Number(run.reviveCount) || 0));
      run.reviveTierPaid = Math.max(0, Number(run.reviveTierPaid) || 0);
      run.bonusPower = Math.max(0, Number(run.bonusPower) || 0);
      run.winStatPower = Math.max(0, Number(run.winStatPower) || 0);
      run.winStatAgility = Math.max(0, Number(run.winStatAgility) || 0);
      run.winStatSpeed = Math.max(0, Number(run.winStatSpeed) || 0);
      run.winTakenMul = Math.max(0, Number(run.winTakenMul) || 0);
      run.rarityBoost = Math.max(0, Math.floor(Number(run.rarityBoost) || 0));
      run.lostMarks = Array.isArray(run.lostMarks) ? run.lostMarks.slice(-20) : [];
      run.noEnvRoll = run.noEnvRoll === true;
      run.noEnvGain = run.noEnvGain === true;
      run.lastSacrifice = run.lastSacrifice && typeof run.lastSacrifice === 'object' ? run.lastSacrifice : null;
      run.instantIds = Array.isArray(run.instantIds)
        ? run.instantIds.filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, count: Math.max(1, Math.floor(Number(x.count) || 1)) }))
        : [];

      run.hpAbs = Math.max(0, Math.round(Number(run.hpAbs) || 0));
      run.repeatAt = Number(run.repeatAt) >= 0 ? Number(run.repeatAt) : -1;
      run.refMaxHp = Math.max(0, Math.round(Number(run.refMaxHp) || 0));
      // 铸币商店：最近一次刷出的「连续三层组号」（-1 = 本局还没刷过）。
      // 老存档没有这个字段 → 视为没刷过，本组还能刷一次。
      run.mintGroup = Number.isFinite(Number(run.mintGroup)) && Number(run.mintGroup) >= 0
        ? Math.floor(Number(run.mintGroup)) : -1;

      run.shopHalfPending = Math.max(0, Math.floor(Number(run.shopHalfPending) || 0));
      if (run.shop && typeof run.shop === 'object' && !Array.isArray(run.shop.slots)) run.shop = null;

      if (run.shop) run.shop.halfPerPage = Math.max(0, Math.floor(Number(run.shop.halfPerPage) || 0));
      // 铸币商店的账本字段防御性归一化（老档 / 手改档都不该让界面崩）。
      if (run.shop && run.shop.mint) {
        run.shop.mint = true;
        run.shop.rerollCount = Math.max(0, Math.floor(Number(run.shop.rerollCount) || 0));
        run.shop.rerollFree = (Number(run.shop.rerollCount) || 0) === 0;
        run.shop.swapped = run.shop.swapped === true;
        run.shop.swapOpen = run.shop.swapOpen === true;
        run.shop.layer = Math.max(1, Math.floor(Number(run.shop.layer) || Number(run.layer) || 1));
      }

      // 版本变更），就地转成「留着等目标」（deferredPicks）—— 否则界面会一直弹一个 0 候选的空弹窗，
    parkStalePendingPick(run);

    if (['shop', 'checkpoint', 'sacrifice', 'patrolToll', 'patrolDiscard', 'mirror'].indexOf(run.phase) < 0) run.phase = null;
      if (!Array.isArray(run.debuffs)) run.debuffs = [];
      // 获得顺序号（`at`）：商店的出售 / 交换列表按它倒序排（最新的在最上）。
      {
        let seq = Math.max(0, Math.floor(Number(run.acqSeq) || 0));
        for (const list of [run.permanent, run.limited]) {
          for (const e of list || []) {
            if (!e || typeof e !== 'object') continue;
            const at = Math.max(0, Math.floor(Number(e.at) || 0));
            if (at > 0) { seq = Math.max(seq, at); continue; }
            e.at = ++seq;
          }
        }
        run.acqSeq = seq;
      }
      // 削弱条目只要求是对象（老档 / 手改存档兜底）。
      // 不要再按来源去重：2026-10 起三侠削弱是「每次大招命中各落一条、各有本层上限」，
      if (run.debuffs.some((d) => !d || typeof d !== 'object')) {
        run.debuffs = run.debuffs.filter((d) => d && typeof d === 'object');
      }
    }
    if (mode === 'endless') ensureRunStats(run);
    return run;
  }
  // 归一化缓存：`tower()/endless()` 每次调用都会走一遍整段 normalizeRun（重建 permanent/limited、
  // 校验每组 buff），开一次塔页要跑 4~6 遍。给 run 打一个版本戳，同一份 run 只归一化一次；
  // 改档/迁移（读档、写档、切模式）时版本戳不在或不同，仍会完整跑一遍。
  const NORM_VER = 5;
  function normalizeRunCached(run, mode) {
    if (!run || typeof run !== 'object') return null;
    // 自检 / QA 档不做缓存：用例会直接改 run 再要求重新归一化（和旧行为一致）。
    if (typeof window !== 'undefined' && window.State && window.State.testMode) return normalizeRun(run, mode);
    if (run.__normVer === NORM_VER) return run;
    const out = normalizeRun(run, mode);
    if (out) out.__normVer = NORM_VER;
    return out;
  }



  function unlocked() {
    for (let id = 1; id <= UNLOCK_STAGES; id++) {
      if (!State.stageProgress(id).passed) return { ok: false, msg: '通关前 ' + UNLOCK_STAGES + ' 关后解锁挑战塔。' };
    }
    return { ok: true };
  }

  // 联机版村庄无尽塔的等级门槛：20 级。只读，不写存档。
  function endlessUnlocked() {
    const level = Math.max(1, Math.floor(Number(State.state() && State.state().level) || 1));
    if (level < ENDLESS_UNLOCK_LEVEL) {
      return {
        ok: false, level, need: ENDLESS_UNLOCK_LEVEL,
        msg: '无尽塔 ' + ENDLESS_UNLOCK_LEVEL + ' 级解锁（当前 ' + level + ' 级）。',
      };
    }
    return { ok: true, level, need: ENDLESS_UNLOCK_LEVEL };
  }



  function bossEntry(layer, salt, squirrelsOnly) { return D().bossFor(layer, salt, squirrelsOnly); }
  // 某个「松鼠系」对手在某一层实际穿的套装（`wearsOf` 的键）—— 预告与实战共用这一份。
  // 狂战套用的是 4 号档，`gearKeyForLayer` 会从「≤ 该层档位上限」的普通套装里按层哈希挑一套，
  function gearKeyOf(layer, sq) {
    const L = Math.max(1, Number(layer) || 1);
    const key = (sq && sq.gear) ? sq.gear : 'ninja1';
    if (L % 10 === 0) return key;
    return D().gearKeyForLayer ? D().gearKeyForLayer(L, key) : key;
  }

  function isEliteEntry(entry, layer, isLast) {
    if (entry && entry.kind === 'warlord') return true;

    if (entry && entry.kind === 'campaign') return true;

    if (entry && entry.kind === 'patrol') return true;
    const L = Number(layer) || 0;
    return !!isLast && L > 0 && L % 5 === 0 && L % 10 !== 0;
  }

  const LAYER_ENTRY_STORY = {
    20: 'gate20',
    30: 'layer30',
    40: 'layer40',
    90: 'layer90',
    95: 'layer95',
    100: 'layer100',
  };

  function layerEntryStory(layer) {
    return LAYER_ENTRY_STORY[Math.floor(Number(layer) || 0)] || null;
  }

  const OFFER_STORY_IDS = ['offer1', 'offer2', 'offer3', 'offer4', 'offer5'];

  function noteEntryStory(plan, layer) {
    if (!Array.isArray(plan) || !plan.length) return plan;

    if (Math.floor(Number(layer) || 0) % 100 === 0 && Number(layer) > 0) {
      plan[0].entryStory = 'x00stage';
      return plan;
    }

    const first = layerEntryStory(layer);
    for (const entry of plan) {
      if (entry && entry.kind === 'patrol' && entry.audience !== 'king') entry.patrolStory = true;
    }
    if (first && plan[0]) plan[0].entryStory = first;
    return plan;
  }

  // 进层那一刻的剧情判定已经搬去 js/tower-plot.js（TowerPlot.due）。
  // ⚠ 别在这里再写一份「按层号该播什么」的判定 —— 会和 due() 各判各的。
  function isX00Plan(plan) {
    return !!(Array.isArray(plan) && plan.length && plan[0] && plan[0].entryStory === 'x00stage');
  }
  // 整百层：第 1 场开打之前要播的那一段（王庭 → 第一近卫）。
  // ⚠ 这两段每次到达整百层都讲一遍，判据是这一局这一层的进度
  // 不看存档里的 `storySeen`：
  function x00BeforeFirst(run) {
    if (!run) return null;
    const pre = Math.max(0, Math.floor(Number(run.x00PreNo) || 0));
    if (pre <= 0) return 'layer100';
    if (pre === 1) return 'x00a';
    return null;
  }

  function nextEntryStory(run) {
    if (!run) return null;
    // 渴血之剑的剧情队列（获取 / 强制苏醒 / 彻底失活）：当前这段播完后按顺序接上。
    if (Array.isArray(run.storyQueue) && run.storyQueue.length) return run.storyQueue.shift();
    if (!isX00Plan(run.plan)) return null;
    const stage = Math.max(0, Math.floor(Number(run.x00stage) || 0));

    return stage <= 1 ? x00BeforeFirst(run) : null;
  }
  // 主动触发：进层（或挪层）之后，把「这一层刚进去就该播的剧情」挂到 `run.story` 上。
  // ⚠ 判空要严：`run.story` 已经有待播的、正在战斗（attempt）、有待选增益（choices）时都别插队，
  function autoPlayStory(run) {
    if (!run) return null;
    if (typeof window === 'undefined' || !window.TowerPlot || !TowerPlot.due) return null;
    if (run.story || run.attempt || run.choices) return null;
    let id = null;
    try { id = TowerPlot.due(run); } catch (e) { id = null; }
    if (!id) return null;
    setRunStory('endless', id);
    // · `patrolStoryAt` = 本层已经讲过巡视剧情（换一层就是新的偶遇）；
    // `patrolMeet*` 是 `once:false` 的那一类，播完不会写进存档的 seen 表，
    // 所以段号必须记在 run 上，不能靠 storySeen。
    const patrolMeet = /^patrolMeet(\d*)$/.exec(id);
    if (id === 'patrolGate' || patrolMeet) {
      run.patrolStoryAt = Math.max(1, Math.floor(Number(run.layer) || 1));
      if (patrolMeet) run.patrolMeetNo = Math.max(1, Math.floor(Number(patrolMeet[1]) || 1));
      save();
    }
    if (run.plan && run.plan[0] && run.plan[0].entryStory === 'x00stage') {
      run.x00stage = Math.max(1, Math.floor(Number(run.x00stage) || 0));

      save();
    }
    return id;
  }
  // 界面「开战前的最后一道闸」用：现在不该开打、该先播剧情吗。
  // ⚠ 必须是无副作用的纯查询（不建战斗令牌、不改 `run`）——
  function storyPendingForBattle(mode) {
    if (mode !== 'endless') return false;
    const run = endless().run;
    if (!run || run.attempt || run.choices || run.phase) return false;
    if (typeof window === 'undefined' || !window.TowerPlot) return false;
    if (!TowerPlot.script) return false;
    try {
      if (TowerPlot.pending(run) && TowerPlot.script(TowerPlot.pending(run))) return true;
    } catch (e) {  }
    // pending 里对「延迟一步」那类会先吃掉 hold 标记并返回 null —— 那种情况属于「下一步才播」，
    // 这里也不能开打，所以下面统一用 due 再问一次。
    // ⚠ 但已经播过（或认不出来）的那一份不能再拦：旧档里残留的待播槽会把
    if (run.pendingStoryId && TowerPlot.script(run.pendingStoryId) && !storySeen(run.pendingStoryId)) return true;
    if (run.pendingStoryHold) return true;
    try { return !!TowerPlot.due(run); } catch (e) { return false; }
  }

  // 这次清层要不要先播「献祭前」那一段（由 reportBattle 在挂 sacrifice 阶段时调）。
  // ⚠【第八十六批修过的坑，别改回去】随机那一段的判据不能只看 `storySeen('gate20b')`：
  function noteSacrificeStory(run) {
    if (!run) return null;
    const firstTime = !storySeen('gate20b') && D().cycleLayer(run.layer) <= 20;
    if (firstTime) return setRunStory('endless', 'gate20b');
    const pool = OFFER_STORY_IDS.filter((id) => !!id);
    const pick = pool[Math.floor(Math.random() * pool.length)] || pool[0];
    return setRunStory('endless', pick);
  }

  function noteSacrificeDoneStory(run) {
    if (!run || storySeen('gate20c')) return null;
    return setRunStory('endless', 'gate20c');
  }
  // ⚠ 埋点是「烙印真的碎了」这个事件，不是第 31 层这个层号 —— 所以它不在上面的层号表里。
  // 顺序也是刻意的：先让「碎掉的烙印失效」那个提示停留，再播剧情。所以这里写的是
  function noteFirstMarkLostStory(run) {
    if (!run) return null;
    if (storySeen('layer31')) return null;
    run.pendingStory = 'layer31';
    run.pendingStoryHold = true;
    save();
    return run.pendingStory;
  }

  function notePatrolResultStory(run, won) {
    if (!run) return null;
    // 失败时记一笔「前半段已经挂过」——`patrolFailB` 用它决定要不要接后半段。
    // ⚠ 不能改用 `storySeen('patrolFailA')`：那两段是「每次都播」的（`once:false`），
    // 播完不会写进存档的 seen 表，用 seen 判的话后半段永远播不出来（实测：巡逻失败只播了
    if (!won) run.patrolFailStoryAt = Math.max(1, Math.floor(Number(run.layer) || 1));
    return setRunStory('endless', won ? 'patrolWin' : 'patrolFailA');
  }
  // 巡视失败：交出藏品之后那一段（`patrolFailB`）。
  // ⚠ 前半段还没挂过时（比如玩家中途关掉页面又回来、直接把增益交了），这里就不硬塞后半段。
  // ⚠ 判据是这一局记的 `patrolFailStoryAt`，不是 `storySeen('patrolFailA')`：
  function notePatrolTollDoneStory(run) {
    if (!run || !run.patrolFailStoryAt) return null;
    return setRunStory('endless', 'patrolFailB');
  }
  // 整百层三连战的段间剧情：打完第 1 场 → `x00b`，第 2 场 → `x00c`，第 3 场 → `x00win`。
  // 所以段间这几段必须先把 stage 推到 ≥ 2，否则界面开下一场时会先播王庭那两段。
  // ⚠ 判据用 `run.x00stage` 自己（每一层进入整百层时归零），不再看 `storySeen`：
  function noteX00BetweenStory(run) {
    if (!run || !Array.isArray(run.plan)) return null;
    const last = run.plan.length - 1;
    const stage = Math.max(0, Math.floor(Number(run.x00stage) || 0));
    const justFought = Math.max(0, (Number(run.idx) || 0) - 1);
    if (justFought === 0 && stage < 2) {
      run.x00stage = 2;
      return setRunStory('endless', 'x00b');
    }
    if (justFought === 1 && stage < 3) {
      run.x00stage = 3;
      return setRunStory('endless', 'x00c');
    }
    if (justFought === last && stage < 4) {
      run.x00stage = 4;
      return setRunStory('endless', 'x00win');
    }
    return null;
  }

  function patrolBlockKey(layer) {
    const n = Math.max(1, Math.floor(Number(layer) || 1));
    const cycle = Math.max(1, Math.min(100, Math.floor(Number(D().cycleLayer(n)) || 1)));
    const len = Math.max(1, Number(D().LAYER_CYCLE) || 100);
    const round = Math.max(0, Math.floor((n - 1) / len));
    return (round + 1) * 100 + Math.floor(cycle / 10);
  }

  function patrolDoneInBlock(run, layer) {
    return !!run && Number(run.patrolDoneWins) > 0 &&
      Number(run.patrolDoneBlock) === patrolBlockKey(layer);
  }

  function markPatrolDone(run, layer) {
    if (!run) return;
    const key = patrolBlockKey(layer);
    if (Number(run.patrolDoneBlock) !== key) {
      run.patrolDoneBlock = key;
      run.patrolDoneWins = 1;
    } else {
      run.patrolDoneWins = Math.max(1, Math.floor(Number(run.patrolDoneWins) || 0) + 1);
    }
  }
  // 造一层的战斗计划。
  // 'tower' / 省略时保持原样（挑战塔的层结构是另一套，不能动）。
  function buildPlan(layer, salt, squirrelsOnly, mode, options) {
    const endlessMode = mode !== 'tower';
    const opts = options || {};
    // ⚠ 普通的 x0 层（10/20/30…）不触发这套结构 —— 那些层照旧是「三侠 ×3 + 首领 + 守关」。
    if (endlessMode && Math.floor(Number(layer) || 0) % 100 === 0 && Number(layer) > 0 && D().PATROL) {
      const g1 = D().warlordFor(layer, salt);
      // 两名近卫必须是不同的变体（同一位站两道门太敷衍）—— 撞了就换盐重取。
      let salt2 = (Number(salt) || 0) + 4177, g2 = D().warlordFor(layer, salt2);
      for (let i = 0; i < 6 && g1 && g2 && g1.name === g2.name; i++) {
        salt2 += 977;
        g2 = D().warlordFor(layer, salt2);
      }
      return noteEntryStory([
        { kind: 'warlord', id: 'warlord', _layer: layer, _salt: salt, audience: 'guard', guardNo: 1, noReward: true,
          guardName: (g1 && g1.name) || '魔王近卫' },
        { kind: 'warlord', id: 'warlord', _layer: layer, _salt: salt2, audience: 'guard', guardNo: 2, noReward: true,
          guardName: (g2 && g2.name) || '魔王近卫' },
        { kind: 'patrol', id: 'patrol', _layer: layer, _salt: salt, x00: true, audience: 'king', replacedIndex: 2,
          replacedKind: 'boss' },
      ], layer);
    }
    // 三侠顺序按层数随机（`heroOrder`，与日期无关）：同层固定 → 预告 = 实战、重试不变。
    // 削弱跟着「哪一位大侠」走（HERO_DEBUFF[anim]），所以顺序一变，本层要吃的削弱顺序也变，
    const plan = D().heroOrder(layer, salt).map((anim) => ({ kind: 'hero', anim }));

    const campaign = endlessMode ? D().campaignBossFor(layer) : null;
    if (campaign) {
      plan.push({ kind: 'warlord', id: 'warlord', _layer: layer, _salt: salt });
      plan.push({ kind: 'campaign', id: campaign.id, _layer: layer, _salt: salt });
    } else {
      const boss = bossEntry(layer, salt, squirrelsOnly);

      if (boss && boss.kind === 'warlord') { boss._layer = layer; boss._salt = salt; }
      plan.push(boss);
      if (layer % 10 === 0) plan.push({ kind: 'warlord', id: 'warlord', _layer: layer, _salt: salt });
    }
    // 「巡逻」替换（2026-10 第六十二批）：40 层之后、每个 10 层区块挑一层（x0/x5 除外），
    // ⚠ 「巡逻 / 巡视」是无尽塔专属（2026-10 用户口径：挑战塔不要巡视事件）：
    if (endlessMode && !opts.skipPatrol && D().isPatrolLayer(layer, salt)) {
      // · 被换掉的那一场不再出现（战斗场数不变 —— 这就是「替换」而不是「新加」）。
      const seed = (Math.max(1, Math.floor(Number(layer) || 1)) * 6151 + Math.abs(Math.floor(Number(salt) || 0)) * 3571) % 100003;
      const at = Math.abs(seed) % plan.length;
      const victim = plan[at];
      plan[at] = { kind: 'patrol', id: 'patrol', _layer: layer, _salt: salt,
        replacedIndex: at, replacedKind: victim && victim.kind, replacedAnim: victim && victim.anim,
        replacedId: victim && victim.id };
    }

    if (!endlessMode) return plan;
    return noteEntryStory(plan, layer);
  }
  function entryInfo(entry, layer, isLast) {
    const elite = isEliteEntry(entry, layer != null ? layer : entry._layer, isLast);
    if (entry.kind === 'hero') return { name: HERO_NAME[entry.anim], anim: entry.anim, type: '三侠位', mechDesc: '', elite: false };
    if (entry.kind === 'campaign') {
      const b = D().CAMPAIGN_BOSS_BY_ID[entry.id] || {};
      return { id: entry.id, name: b.name || '征战首领', anim: 'campaign', campaign: true, mcFrame: b.mcFrame || 1,
        type: b.type || '征战首领', mechDesc: b.mechDesc || '', patternDesc: b.patternDesc || '',
        elite: true, mechs: (b.mech || []).slice() };
    }
    if (entry.kind === 'warlord') {
      // 预告必须显示这一层实际会遇到的那只变体与实际穿的套装（同层固定 → 预告 = 实战）：
      // 非 10 的整数层抽到的狂战松鼠穿的是普通套装，预告里也不能画成狂战套。
      const w = D().warlordFor(entry._layer, entry._salt);

      if (entry.audience === 'guard') {
        return { name: w.name, squirrel: true, gear: gearKeyOf(entry._layer, w), elite: true,
          type: '魔王近卫 · 第 ' + (Number(entry.guardNo) || 1) + ' 关', guard: entry.guardNo,
          mechDesc: '觐见魔王的第一道门 —— 近卫' + (Number(entry.guardNo) || 1) + '：' + (w.mechDesc || '') +
            '；这一场**没有**战斗前后的增益奖励',
          patternDesc: w.patternDesc, mechs: w.mech.slice() };
      }
      return { name: w.name, squirrel: true, gear: gearKeyOf(entry._layer, w), elite: true, type: w.type,
        mechDesc: w.mechDesc, patternDesc: w.patternDesc, mechs: w.mech.slice() };
    }

    if (entry.kind === 'patrol') {

      const isKing = entry.audience === 'king' || entry.x00;

      const liveRun = (typeof endless === 'function') ? endless().run : null;
      const held = (liveRun && Array.isArray(liveRun.patrolTolls)) ? liveRun.patrolTolls.length : 0;
      return { name: D().patrolName ? D().patrolName(entry._layer) : D().PATROL.name,
        squirrel: true, patrol: entry,

        gear: (D().PATROL.classicGear || []).slice(),
        elite: true, boss: true, type: isKing ? '魔王 · 觐见' : '精英 首领',
        audience: isKing ? 'king' : null,
        mechDesc: (isKing
          ? '觐见魔王 —— 走过两名近卫，你终于站到了它面前。'
          : '开战时定格你进场那一刻的面板；持有全部武器与技能（真5）；' +
            '战斗失败时，上交一个本局当前还在生效的最高稀有度增益'),
        patternDesc: '全部武器 + 全部技能（真5）', mechs: [] };
    }
    if (entry.kind === 'npc') {
      const npc = D().NPC_BY_ID[entry.id];
      return { name: npc.name, anim: npc.anim, elite: elite, type: npc.type, mechDesc: npc.mechDesc, mechs: [npc.mech] };
    }
    const sq = entry.kind === 'trial' ? D().TRIAL_BY_ID[entry.id] : D().SQUIRREL_BY_ID[entry.id];
    return { name: sq.name, squirrel: true, gear: sq.gear, elite: elite, type: sq.type,
      mechDesc: sq.mechDesc || '', patternDesc: sq.patternDesc || '', mechs: (sq.mech || []).slice() };
  }
  // 进塔页的 BOSS 图鉴：无尽塔真正会出现的候选（挑战塔的 NPC 不进来）——
  // 同一稀有度里保留「当天稳定洗牌」的相对顺序（换一天看起来不重样），
  function bossPool() {
    const TD = D();
    const list = [];
    for (const pick of (TD.ENDLESS_BOSS_POOL || [])) {
      if (pick.kind === 'warlord') continue;
      const entry = { kind: pick.kind, id: pick.id };
      const tier = TD.bossGearTier ? TD.bossGearTier(pick) : 2;
      list.push(Object.assign({ kind: pick.kind, tier, rarity: (TD.BOSS_GEAR_RARITY || [])[tier] || '' }, entryInfo(entry)));
    }
    for (const w of (TD.WARLORD_POOL || [])) {
      list.push({
        kind: 'warlord', id: 'warlord', name: w.name, type: w.type, elite: true, squirrel: true,
        tier: 4, rarity: (TD.BOSS_GEAR_RARITY || [])[4] || '传说',
        mechDesc: w.mechDesc, patternDesc: w.patternDesc, mechs: (w.mech || []).slice(),
      });
    }
    const kingName = ((TD.PATROL && TD.PATROL.kingPrefix) || '') + ((TD.PATROL && TD.PATROL.name) || '魔王');
    list.push({
      // 魔王卡在 UI 上要显示成「？？？」，但 `hidden` 是增益标签名、已列为禁止的冗余字段
      kind: 'patrol', id: 'patrol', name: kingName, type: '？？？', tier: null, rarity: '',
      secret: true, king: true, mechDesc: '？？？', patternDesc: '？？？', mechs: [],
    });
    let seed = 0x9e3779b9;
    const seedText = (typeof State !== 'undefined' && State.localDate) ? State.localDate() : 'endless';
    for (let i = 0; i < seedText.length; i++) seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619) >>> 0;
    for (let i = list.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    // 洗牌之后再按稀有度稳定排序（Array#sort 是稳定排序）：
    // 档位之间严格递增，档位内部保持上面洗出来的当天顺序；魔王（tier 为 null）永远最后。
    const tierOf = (b) => (b.tier == null ? Number.MAX_SAFE_INTEGER : Number(b.tier));
    list.sort((a, b) => tierOf(a) - tierOf(b));
    return list;
  }
  // 入口页预告：当前层的全部对手（与 buildPlan 同源，所以预告 = 实战）。
  function preview(layer, salt, squirrelsOnly, mode) {
    const plan = buildPlan(layer, salt, squirrelsOnly, mode);
    return plan.map((entry, i) => Object.assign({ kind: entry.kind }, entryInfo(entry, layer, i === plan.length - 1)));
  }

  function planInfo(mode) {
    const run = (mode === 'tower' ? tower() : endless()).run;
    if (!run || !Array.isArray(run.plan) || !run.plan.length) return [];
    return run.plan.map((entry, i) => Object.assign({ kind: entry.kind }, entryInfo(entry, run.layer, i === run.plan.length - 1)));
  }

  // 结算顺序锁定（见文档 6.5）：基础 → 叠层累积 → C15 全局乘区。


  function findRowRef(run, ref) {
    if (!run) return null;
    const lists = [run.permanent || [], run.limited || []];
    const n = Math.floor(Number(ref) || 0);
    if (n > 0) {
      for (const L of lists) {
        const row = (L || []).find((b) => b && Number(b.uid) === n);
        if (row) return { row: row, list: L };
      }
    }
    for (const L of lists) {
      for (let i = (L || []).length - 1; i >= 0; i--) {
        if (L[i] && L[i].id === ref) return { row: L[i], list: L };
      }
    }
    return null;
  }
  function ownedEntry(run, id) {
    const hit = findRowRef(run, id);
    return hit ? hit.row : null;
  }

  function stacksOf(run, id) {
    if (!run) return 0;
    let n = 0;
    for (const list of [run.permanent || [], run.limited || []]) {
      for (const b of list) {
        if (b && b.id === id) n += Math.max(1, Math.floor(Number(b.stacks) || 1));
      }
    }
    return n;
  }

  function reviveInfoOf(run) {
    if (!run) return null;
    const perLayer = Math.max(0, Math.floor(Number(stacksOf(run, 'C14')) || 0));
    if (!perLayer) return null;
    const used = (Number(run.reviveLayer) || 0) === Number(run.layer)
      ? Math.max(0, Math.floor(Number(run.reviveUsed) || 0)) : 0;
    return { perLayer: perLayer, used: used, left: Math.max(0, perLayer - used) };
  }
  // 永久增益是否「可无限同名拾取」——叠满后另开一个背包栏位继续叠加。
  // 必须保持「一局只拿一次」，否则会绕过刚做的削弱；
  function permanentRestackable(buff) {
    if (!buff || buff.kind !== 'permanent') return false;
    if (D().hasTag(buff, 'oncePerRun')) return false;
    // noRestack（任务4）：涅槃 / 后发制人 / 挥金如土这一组拿满上限后移出可获得池，
    if (D().hasTag(buff, 'noRestack')) return false;

    if (D().hasTag(buff, 'unique')) return false;
    return occupiesPermSlot(buff);
  }

  function globalMul(run) {
    const st = stacksOf(run, 'C15');
    if (!st) return 1;
    const per = Number(D().BUFF_BY_ID.C15.mods.globalMul) || 1;
    const add = Math.round((per - 1) * 10000) / 10000;
    return Math.round((1 + add * st) * 10000) / 10000;
  }
  // 某一条 buff 的最终效果倍率：增幅水晶（全局）+ 水晶铭文（本条）加算。
  // 注意：`g` 已含 C15 的同名加算；铭文倍率只作用于这一栏。
  function buffEffectMulOf(row, g) {
    const base = Number(g) > 0 ? Number(g) : 1;
    const ench = rowEnchMulOf(row);
    if (!(ench > 1)) return base;
    return Math.round((base + ench - 1) * 10000) / 10000;
  }
  // 生效中的 buff：永久全部生效；限次只在「开关打开且还有次数」时生效。
  // 例外：渴血之剑的最终 / 失活形态用 `uses = -1` 表示永续，必须和普通限次区分开
  function eachBuff(run, fn) {
    for (const b of run.permanent || []) fn(D().BUFF_BY_ID[b.id], b.stacks, b);
    for (const b of run.limited || []) {
      if (b.on === false) continue;
      const unlimitedBlade = Number(b.uses) === -1 && D().isBladeId(b.id);
      if (!(b.uses > 0) && !unlimitedBlade) continue;
      fn(D().BUFF_BY_ID[b.id], b.stacks, b);
    }
  }
  // 一次生效类增益「到底给了什么」——调试台要把效果写清楚，不能只显示个名字。
  function instantDetail(buff) {
    const m = (buff && buff.mods) || {};
    const parts = [];
    if (m.instantCoins) parts.push('试炼币 +' + m.instantCoins);
    if (m.enemyMaxHpDown) parts.push('本局敌人生命上限 −' + Math.round(m.enemyMaxHpDown * 100) + '%');
    if (m.shopDiscount) parts.push('下一家商店 ' + shopDiscountLabel(m.shopDiscount));
    if (m.postBattleShop) parts.push('下一场战斗后开一次商店');
    if (m.postBattleMintShop) parts.push('下一场战斗后开一次铸币商店（顶掉普通商店）');
    if (m.instantRetry) parts.push('铸币 +' + m.instantRetry);
    if (m.shopHalf) parts.push('下次进店 ' + m.shopHalf + ' 件随机商品对折');
    if (m.rerollTiltMul) parts.push('商店刷新稀有线提速 ×' + m.rerollTiltMul);
    return parts.join('、') || (buff && buff.desc) || '立即生效';
  }


  const BUFF_LOG_MAX = 100;
  function logBuff(run, id, event, extra) {
    if (!run || !id) return;

    if (run.mode === 'endless' && ['get', 'stack', 'instant'].includes(event) && D().BUFF_BY_ID[id]) {
      const stats = ensureRunStats(run);
      stats.buffs[id] = Math.max(0, Number(stats.buffs[id]) || 0) + 1;
    }
    const list = Array.isArray(run.buffLog) ? run.buffLog : (run.buffLog = []);
    list.push(Object.assign({ id: String(id), event: String(event), layer: Math.max(1, Number(run.layer) || 1) }, extra || {}));
    if (list.length > BUFF_LOG_MAX) list.splice(0, list.length - BUFF_LOG_MAX);
  }
  // 本局结算账本随 run 保存，也随已有战前快照一起回滚；不从余额倒算收入。
  function createRunStats(run, complete) {
    const stats = { version: 1, id: String(run.salt || ('legacy:' + Date.now())), complete: complete === true,
      enemiesDefeated: 0, layersCleared: 0, trialCoinsEarned: 0, mintEarned: 0,
      buffs: {}, achievements: [], victoryLayer: 0 };
    if (complete) return stats;

    const owned = {}, logged = {};
    const atLeast = (id, n) => {
      if (D().BUFF_BY_ID[id]) stats.buffs[id] = Math.max(Number(stats.buffs[id]) || 0, Math.max(0, Number(n) || 0));
    };
    for (const row of (run.permanent || []).concat(run.limited || [], run.buffs || [])) {
      if (row && D().BUFF_BY_ID[row.id]) owned[row.id] = (owned[row.id] || 0) + Math.max(1, Math.floor(Number(row.stacks) || 1));
    }
    for (const row of run.buffLog || []) {
      if (row && ['get', 'stack', 'instant'].includes(row.event)) logged[row.id] = (logged[row.id] || 0) + 1;
    }
    for (const id of Object.keys(owned)) atLeast(id, owned[id]);
    for (const id of Object.keys(logged)) atLeast(id, logged[id]);
    for (const row of run.instantIds || []) if (row) atLeast(row.id, row.count);
    for (const key of ['fragileGot', 'pickGot']) {
      for (const id of Object.keys(run[key] || {})) atLeast(id, run[key][id]);
    }
    for (const id of (run.permSlotIds || []).concat(run.pickBuffIds || [])) atLeast(id, 1);
    stats.achievements = cloneRun(run.achievements || []);
    return stats;
  }
  function ensureRunStats(run) {
    if (!run.runStats || run.runStats.version !== 1 || !run.runStats.buffs ||
        !Array.isArray(run.runStats.achievements)) run.runStats = createRunStats(run, false);
    return run.runStats;
  }
  function noteRunIncome(run, currency, amount) {
    if (!run || run.mode !== 'endless') return;
    const n = Math.max(0, Number(amount) || 0);
    if (!n) return;
    const stats = ensureRunStats(run);
    stats[currency] = Math.max(0, Number(stats[currency]) || 0) + n;
  }

  function canSettleEndlessVictory(run) {
    run = run || endless().run;
    if (!run || run.attempt || run.phase !== 'mirror' || Number(run.layer) % 100 !== 0 ||
        !isX00Plan(run.plan) || Number(run.idx) < run.plan.length - 1) return false;
    const last = run.plan[run.plan.length - 1];
    return !!(last && last.x00 && last.audience === 'king' && run.finished &&
      Number(run.finished.layer) === Number(run.layer) && Number(run.finished.count) === run.plan.length && run.runStats &&
      Number(run.runStats.victoryLayer) === Number(run.layer));
  }
  // 百层奖励只看本局已通过层数（bestLayer），从 >=100 层起结算，不再要求整百层胜利结局。
  function endlessBonusMinLayer() {
    const n = Number(window.TowerRewards && window.TowerRewards.BONUS_MIN_LAYER);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  }

  function buildEndlessSummary(run, outcome, reason) {
    if (!run) return null;
    const stats = run.runStats || createRunStats(run, false), pv = previewSettleTickets(run);
    const complete = stats.complete === true;
    const buffs = Object.keys(stats.buffs).map((id) => {
      const def = D().BUFF_BY_ID[id];
      return def ? { id, name: def.name, rarity: def.rarity, kind: def.kind,
        count: Math.max(0, Math.floor(Number(stats.buffs[id]) || 0)) } : null;
    }).filter((b) => b && b.count > 0);
    const metric = (key) => complete ? Math.max(0, Math.floor(Number(stats[key]) || 0)) : null;
    return { version: 1, id: stats.id, outcome: outcome === 'win' && canSettleEndlessVictory(run) ? 'win' : 'lose',
      reason: reason || 'abandon', settled: false, complete, ruleset: isHeroRun(run) ? 'hero' : 'default',
      incompleteFields: complete ? [] : ['enemiesDefeated', 'layersCleared', 'trialCoinsEarned', 'mintEarned', 'buffs', 'achievements'],
      score: Math.max(0, Math.floor(Number(run.score) || 0)), layer: pv.layer,
      bestLayer: Math.max(0, Math.floor(Number(run.bestLayer) || 0)),
      enemiesDefeated: metric('enemiesDefeated'), layersCleared: metric('layersCleared'),
      trialCoinsEarned: metric('trialCoinsEarned'), mintEarned: metric('mintEarned'),
      trialCoinsLeft: pv.coins, mintLeft: pv.mint, tickets: pv.total, layerTickets: pv.layerTickets,
      bonusTickets: pv.bonusTickets,
      mintConverted: pv.mintConverted, mintForfeited: pv.mintForfeited, mintTicketCap: pv.mintCap,
      rawTickets: pv.rawTickets, weekTickets: pv.weekTickets, weekCap: pv.weekCap,
      weekLeft: pv.weekLeft, ticketsCapped: pv.capped === true,
      trueEnd: Math.max(0, Math.floor(Number(pv.bestLayer) || 0)) >= endlessBonusMinLayer(),
      victoryBonus: Math.max(0, Math.floor(Number(pv.victoryBonus) || 0)),
      victoryBonusUsed: pv.victoryBonusUsed === true,
      freeDraws: 0,
      uiMode: S().settings && S().settings.uiMode === 'modern' ? 'modern' : 'classic',
      buffs, buffCount: buffs.reduce((sum, b) => sum + b.count, 0),
      achievements: cloneRun(stats.achievements) };
  }

  function previewEndlessSummary(outcome) {
    const run = endless().run;
    return buildEndlessSummary(run, outcome, outcome === 'win' && canSettleEndlessVictory(run) ? 'victory' : 'abandon');
  }
  function finishEndlessSummary(out) {
    out.summary.settled = true;
    out.summary.endedAt = Date.now();
    out.summary.freeDraws = out.shield ? 1 : 0;
    // 返回给界面的对象与持久快照隔离，界面绘制不能改坏存档。
    endless().lastSummary = cloneRun(out.summary);
  }
  // 联机版：服务端结算 / 补发成功后，把「已领到」的结果补进本机保存的上局战报。
  // 只认同一局（id 必须一致），避免把别的战报或预览改掉。
  function updateLastSummary(id, patch) {
    const summary = endless().lastSummary;
    if (!summary || String(summary.id) !== String(id)) return false;
    if (!patch || typeof patch !== 'object') return false;
    Object.assign(summary, patch);
    save();
    return true;
  }
  // E01「立即进货」当前实际生效的折扣比例（0 = 没有生效的）。
  // run.shopDiscount 缓存，玩家把 E01 关掉之后缓存还在 —— 于是关掉了照样每场结束进商店。
  function activeShopCredit(run) {
    let pct = 0;
    for (const e of run.limited || []) {
      if (e.on === false || !(e.uses > 0)) continue;
      const def = D().BUFF_BY_ID[e.id];
      const m = def && def.mods;
      if (m && m.postBattleShop) pct = Math.max(pct, Number(m.postBattleShopDiscount) || D().SHOP_DISCOUNT_E01);
    }
    return pct;
  }

  function activePostBattleMintShop(run) {
    for (const e of run.limited || []) {
      if (e.on === false || !(e.uses > 0)) continue;
      const m = (D().BUFF_BY_ID[e.id] || {}).mods;
      if (m && m.postBattleMintShop) return true;
    }
    return false;
  }
  function consumeLimited(run, out) {
    for (const b of run.limited || []) {

      if (D().isBladeId(b.id)) continue;
      if (b.on === false || !(b.uses > 0)) continue;
      b.uses--;
      if (b.uses <= 0) logBuff(run, b.id, 'expire', { stacks: b.stacks || 1 });
    }
    run.limited = (run.limited || []).filter((b) => D().isBladeId(b.id) || b.uses > 0);
    bladeAfterBattle(run, out);
  }

  function isPostBattleShopRow(row) {
    const m = (D().BUFF_BY_ID[row && row.id] || {}).mods;
    return !!(m && (m.postBattleShop || m.postBattleMintShop));
  }

  function snapshotShopCredits(run) {
    return (run.limited || [])
      .filter((b) => b && b.on !== false && Number(b.uses) > 0 && isPostBattleShopRow(b))
      .map((b) => cloneRun(b));
  }
  function restoreShopCredits(run, rows) {
    if (!rows || !rows.length) return 0;
    run.limited = Array.isArray(run.limited) ? run.limited : [];
    for (const snap of rows) {
      let at = -1;
      if (snap.uid != null) at = run.limited.findIndex((b) => b && b.uid != null && Number(b.uid) === Number(snap.uid));
      if (at < 0) at = run.limited.findIndex((b) => b && b.id === snap.id);
      if (at >= 0) run.limited[at] = snap;
      else run.limited.push(snap);

      const log = Array.isArray(run.buffLog) ? run.buffLog : null;
      if (log) for (let i = log.length - 1; i >= 0; i--) {
        if (log[i] && log[i].id === snap.id && log[i].event === 'expire') { log.splice(i, 1); break; }
      }
    }
    return rows.length;
  }

  // 某个 mod 在本局的合计值（不参与 adjustMe 的「场外」结算用，例如每胜利上限
  // 注意：「开战回血」类（补给 N08 / 战斗续航 C16·C17）不在这里，它们走 aggregate
  // 的 startHealPct，必须在 adjustMe 里按本场真实上限结算。
  function runModTotal(run, key) {
    const g = globalMul(run);
    let sum = 0;
    eachBuff(run, (buff, stacks, row) => { const m = buff.mods; if (m && m[key]) sum += m[key] * stacks * buffEffectMulOf(row, g); });
    return sum;
  }

  function combineTakenMul(base, extra) {
    const a = Number(base) || 0, b = Number(extra) || 0;
    if (!a) return b;
    if (!b) return a;
    return Math.max(-0.99, (1 + a) * (1 + b) - 1);
  }

  function permanentBuffCountFor(run, selfRow, freeWeight) {
    const selfId = selfRow && selfRow.id ? String(selfRow.id) : '';
    const w = Math.max(0, Number(freeWeight) || 0);
    let count = 0;
    for (const row of (run.permanent || [])) {
      if (selfId && row && row !== selfRow && String(row.id) === selfId) continue;
      count += rowFreeOf(row) ? w : 1;
    }
    return Math.round(count * 10) / 10;
  }
  // 闪避率的最终上限（与 Sim 的 `RULES.dodgeCap` 同源；面板与聚合都用这一份）。
  function dodgeCapPct() {
    const v = Number(window.Sim && window.Sim.rules && window.Sim.rules.dodgeCap);
    return Number.isFinite(v) && v > 0 ? Math.min(100, v) : 55;
  }

  function eventRegenPct(run) {
    let sum = 0;
    for (const e of (run && Array.isArray(run.eventRegen) ? run.eventRegen : [])) {
      if (e && Number(e.left) > 0) sum += Math.max(0, Number(e.pct) || 0);
    }
    return sum;
  }
  function grantEventRegen(run, id, pct, battles) {
    if (!run) return 0;
    const value = Math.max(0, Number(pct) || 0);
    if (!(value > 0)) return 0;
    run.eventRegen = (Array.isArray(run.eventRegen) ? run.eventRegen : [])
      .filter((e) => e && Number(e.left) > 0)
      .concat([{ id: String(id || 'event'), pct: value, left: Math.max(1, Math.floor(Number(battles) || 10)) }]);
    return value;
  }
  function consumeEventRegen(run) {
    if (!run || !Array.isArray(run.eventRegen) || !run.eventRegen.length) return;
    for (const e of run.eventRegen) e.left = Math.max(0, Math.floor(Number(e.left) || 0) - 1);
    run.eventRegen = run.eventRegen.filter((e) => e && e.left > 0);
  }
  function aggregate(run, foeCtx) {
    const g = globalMul(run);
    const agg = { powerMul: 0, agilityMul: 0, maxHpMul: 0, critBonus: 0, critDmgBonus: 0, dodgeBonus: 0, takenMul: 0,
      regenPct: 0, lifestealPct: 0, shellPct: 0, openStrikePct: 0, enemyPowerDown: 0, startHealPct: 0,
      mustHitFirst: 0, firstSkillFree: 0, deathSaves: [], dmgMul: 1, revivePct: 0, reviveStatMul: 0, reviveMax: 0,
      speedMul: 0, thornsPct: 0, lowHpPowerMul: 0, lowHpAt: 0,
      lowHpAgilityMul: 0, lowHpSpeedMul: 0,
      emptyMaxHpMul: 0, lowHpTakenMul: 0, lowHpLifestealPct: 0, lowHpRegenPct: 0, lowHpRegenAt: 0,
      reflectImmune: 0, winTakenMulPct: 0, winTakenMulCap: 0,
      winStatAfter10: 0,
      weaponFreeUses: 0, weaponBoostUses: 0, weaponBoostPowerMul: 0, weaponBoostMustHit: 0,
      weaponBoostReflectImmune: 0, weaponBoostFatigueMul: 0, lowHpFinalMul: 0,
      openerPowerMul: 0, openerRounds: 0, fatiguePowerMul: 0, dodgeMul: 0,
      roundStatPct: 0, catchUpPct: 0, roundMaxHpMul: 0, firstDodge: 0, firstDodgeFreeTurn: 0,
      firstHitZero: 0, firstHitZeroFreeTurn: 0, firstHitZeroName: '',
      // 2026-10 新增（N16 战意沸腾 / N17 血蚀印记 / E17 假如我直接赢）：
      // startMaxHpFlat   战斗开始时生命上限 +N（固定值）
      startStatFlat: 0, startMaxHpFlat: 0, enemyHpDrainPct: 0, openKill: 0 };

    const dmgMulById = new Map();
    eachBuff(run, (buff, stacks, row) => {

      const m = buff.mods, k = stacks * buffEffectMulOf(row, g);
      if (m.powerMul) agg.powerMul += m.powerMul * k;
      if (m.powerPerEmptySlot) agg.powerMul += m.powerPerEmptySlot * Math.max(0, permSlots(run) - permUsed(run)) * k;
      if (m.powerPerPermBuff) {

        const w = m.powerPerPermBuffEnchantedWeight != null
          ? Math.max(0, Number(m.powerPerPermBuffEnchantedWeight))
          : 1;
        const count = permanentBuffCountFor(run, row, w);
        agg.powerMul += m.powerPerPermBuff * count * k;
      }
      if (m.winStatAfter10) agg.winStatAfter10 += 1;
      if (m.maxHpMul) { if (buff.kind === 'limited') agg.maxHpMul += m.maxHpMul * k; }
      if (m.critBonus) agg.critBonus += m.critBonus * k;
      if (m.critDmgBonus) agg.critDmgBonus += m.critDmgBonus * k;
      if (m.dodgeBonus) agg.dodgeBonus += m.dodgeBonus * k;
      if (m.takenMul) agg.takenMul = combineTakenMul(agg.takenMul, m.takenMul * k);
      if (m.regenPct) agg.regenPct += m.regenPct * k;
      if (m.lifestealPct) agg.lifestealPct += m.lifestealPct * k;
      if (m.shellPct) agg.shellPct += m.shellPct * k;
      if (m.startHealPct) agg.startHealPct += m.startHealPct * k;
      if (m.enemyPowerDown) agg.enemyPowerDown += m.enemyPowerDown * k;
      if (m.openStrikePct) agg.openStrikePct = Math.max(agg.openStrikePct, m.openStrikePct * k);
      if (m.speedMul) agg.speedMul += m.speedMul * k;
      if (m.agilityMul) agg.agilityMul += m.agilityMul * k;

      if (m.openerPowerMul) agg.openerPowerMul += m.openerPowerMul * k;
      if (m.fatiguePowerMul) agg.fatiguePowerMul += m.fatiguePowerMul * k;
      if (m.openerRounds) agg.openerRounds = Math.max(agg.openerRounds, Number(m.openerRounds) || 5);
      if (m.dodgeMul) agg.dodgeMul += m.dodgeMul * k;

      if (m.thornsPct) agg.thornsPct += m.thornsPct * k;
      if (m.mustHitAll) agg.mustHitAll = 1;
      if (m.firstHitZero) agg.firstHitZero = 1;
      if (m.firstHitZeroName) agg.firstHitZeroName = String(m.firstHitZeroName);
      if (m.firstHitZeroFreeTurn) agg.firstHitZeroFreeTurn = 1;

      if (m.roundStatPct) agg.roundStatPct += m.roundStatPct * k;
      if (m.catchUpPct) agg.catchUpPct = Math.max(agg.catchUpPct, m.catchUpPct * k);
      if (m.roundMaxHpMul) agg.roundMaxHpMul = agg.roundMaxHpMul > 0
        ? Math.min(agg.roundMaxHpMul, Number(m.roundMaxHpMul)) : Number(m.roundMaxHpMul);
      if (m.firstDodge) agg.firstDodge = 1;

      if (m.firstDodgeFreeTurn) agg.firstDodgeFreeTurn = 1;
      // 2026-10 新增限次类：战意沸腾（固定力/敏/速与血上限）与血蚀印记（按敌人当前血抽血）。
      if (m.startStatFlat) agg.startStatFlat += m.startStatFlat * k;
      if (m.startMaxHpFlat) agg.startMaxHpFlat += m.startMaxHpFlat * k;
      if (m.enemyHpDrainPct) agg.enemyHpDrainPct += m.enemyHpDrainPct * k;

      if (m.openKill) agg.openKill = 1;


      if (m.reflectImmune) agg.reflectImmune = Math.max(agg.reflectImmune, Number(m.reflectImmune) || 0);

      if (m.winTakenMulPct) {
        agg.winTakenMulPct += m.winTakenMulPct * k;
        agg.winTakenMulCap = Math.max(agg.winTakenMulCap, (Number(m.winTakenMulCap) || 0) * stacks);
      }
      // 空血上限：只抬高上限、不回血（与 maxHpMul 那条「回复等量」的语义相反）。
      if (m.emptyMaxHpMul) agg.emptyMaxHpMul += m.emptyMaxHpMul * k;

      if (m.lowHpTakenMul) agg.lowHpTakenMul = combineTakenMul(agg.lowHpTakenMul, m.lowHpTakenMul * k);
      if (m.lowHpLifestealPct) agg.lowHpLifestealPct += m.lowHpLifestealPct * k;
      if (m.lowHpRegenPct) {
        agg.lowHpRegenPct += m.lowHpRegenPct * k;
        agg.lowHpRegenAt = Math.max(agg.lowHpRegenAt, Number(m.lowHpRegenAt) || Number(m.lowHpAt) || 0.5);
      }
      if (m.lowHpPowerMul || m.lowHpAgilityMul || m.lowHpSpeedMul) {
        if (m.lowHpPowerMul) agg.lowHpPowerMul += m.lowHpPowerMul * k;
        if (m.lowHpAgilityMul) agg.lowHpAgilityMul += m.lowHpAgilityMul * k;
        if (m.lowHpSpeedMul) agg.lowHpSpeedMul += m.lowHpSpeedMul * k;
        agg.lowHpAt = Math.max(agg.lowHpAt, Number(m.lowHpAt) || 0.35);
      }
      if (m.mustHitFirst) agg.mustHitFirst = 1;
      if (m.firstSkillFree) agg.firstSkillFree = 1;

      if (m.deathSave) agg.deathSaves.push({ name: buff.name });
      if (m.reviveFirstPct) {
        agg.deathSaves.push({ healPct: Math.min(0.9, m.reviveFirstPct * g), name: buff.name });
      }

      if (m.layerFirstHealPct && run.idx === 0) agg.startHealPct += m.layerFirstHealPct * k;

      if (m.weaponFreeUses) agg.weaponFreeUses = Math.max(agg.weaponFreeUses, Math.floor(m.weaponFreeUses));
      if (m.weaponBoostUses) {
        agg.weaponBoostUses = Math.max(agg.weaponBoostUses, Math.floor(m.weaponBoostUses));
        if (m.weaponBoostPowerMul) agg.weaponBoostPowerMul += m.weaponBoostPowerMul * k;
        if (m.weaponBoostMustHit) agg.weaponBoostMustHit = 1;
        if (m.weaponBoostReflectImmune) agg.weaponBoostReflectImmune = 1;
        agg.weaponBoostFatigueMul += Number(m.weaponBoostFatigueMul || 0) * k;
      }
      if (m.lowHpFinalMul) { agg.lowHpFinalMul += m.lowHpFinalMul * k; agg.lowHpAt = Math.max(agg.lowHpAt, Number(m.lowHpAt) || 0.5); }
      if (m.revivePct) {

        const em = rowEnchMulOf(row);
        agg.revivePct = Math.max(agg.revivePct || 0, Math.min(0.9, m.revivePct * buffEffectMulOf(row, g)));
        agg.reviveStatMul = Math.max(agg.reviveStatMul || 0, (Number(m.reviveStatMul) || 0) * em);
        agg.reviveMax = Math.max(agg.reviveMax || 0, Math.max(1, Math.floor(stacks)));
      }
      if (foeCtx.hero && m.dmgMulType) dmgMulById.set(buff.id, (dmgMulById.get(buff.id) || 0) + m.dmgMulType * k);
      if (foeCtx.poolNpc && m.dmgMulMech) dmgMulById.set(buff.id, (dmgMulById.get(buff.id) || 0) + m.dmgMulMech * k);
      if (foeCtx.elite && m.dmgMulElite) dmgMulById.set(buff.id, (dmgMulById.get(buff.id) || 0) + m.dmgMulElite * k);
    });

    for (const v of dmgMulById.values()) agg.dmgMul *= 1 + v;
    for (const [k, field] of [['power', 'powerMul'], ['agility', 'agilityMul'], ['speed', 'speedMul']]) {
      const v = fragileBonus(run, k).value * g;
      if (v) agg[field] += v;
    }
    if (run.killPower) agg.powerMul += run.killPower;
    // killMaxHp 是「击杀成长·生命上限」的历史字段，现已没有任何地方写它
    if (run.bonusPower) agg.powerMul += run.bonusPower;
    const c09 = (run.permanent || []).find((row) => row && row.id === 'C09');
    if (c09 && run.layer % 5 === 0) {
      // 不能只在悬停里写 ×1.5）；与增幅水晶的全局倍率加算。
      const boost = (D().BUFF_BY_ID.C09.mods.x10Boost || 0.30) * buffEffectMulOf(c09, g);
      agg.powerMul += boost; agg.maxHpMul += boost;
    }
    // 闪避类藏品（C22 闪避精通 / G03 凌波微步 / T02 烟幕）可以靠多栏叠出很高的
    // 同一个上限，避免面板出现 +100% 以上的假数字，也避免未来有人把终限改掉后
    agg.dodgeBonus = Math.max(0, Math.min(dodgeCapPct(), Number(agg.dodgeBonus) || 0));
    // 勇者事件「接下来 N 场每回合回复」：与常驻 regenPct 同一条结算路径。
    agg.regenPct += eventRegenPct(run);
    return agg;
  }


  function buffEffectLines(run, foeCtx) {
    if (!run) return [];
    const a = aggregate(run, foeCtx || {});
    const pct = (v) => (v >= 0 ? '+' : '') + (Math.round(v * 1000) / 10) + '%';
    const num = (v) => (v >= 0 ? '+' : '') + (Math.round(v * 10) / 10);
    const lines = [];
    if (a.powerMul) lines.push(['攻击', pct(a.powerMul)]);
    if (a.agilityMul) lines.push(['敏捷', pct(a.agilityMul)]);
    if (a.speedMul) lines.push(['速度', pct(a.speedMul)]);
    // 永久类的生命上限加成不进聚合乘区（拿到时就折算进 run.hpBonus，卖掉也不回落），
    // 所以这里要把两条并起来算，否则「磐石之躯 +20%」在报告里会整条消失。
    const hpTotal = (a.maxHpMul || 0) + (run.hpBonus || 0) + winMaxHpOf(run);
    if (hpTotal) {
      lines.push(['生命上限', pct(hpTotal) +
        (run.hpBonus ? '（含已冻结 ' + pct(run.hpBonus) + '）' : '') +
        (winMaxHpOf(run) ? '（含成长 ' + pct(winMaxHpOf(run)) + '）' : '')]);
    }

    if (a.critBonus) lines.push(['暴击率', num(a.critBonus) + '%']);
    if (a.critDmgBonus) lines.push(['暴击伤害', pct(a.critDmgBonus)]);
    if (a.dodgeBonus) lines.push(['闪避', num(a.dodgeBonus) + '%']);
    if (a.takenMul) lines.push(['受到伤害', pct(a.takenMul)]);
    if (a.regenPct) lines.push(['每回合回血', pct(a.regenPct) + ' 最大生命']);
    if (a.lifestealPct) lines.push(['攻击吸血', pct(a.lifestealPct)]);
    if (a.thornsPct) lines.push(['荆棘反伤', pct(a.thornsPct)]);
    if (a.shellPct) lines.push(['护盾', pct(a.shellPct)]);
    // 「开战回血」= 补给 N08 与战斗续航 C16·C17 共用的那一条：每场战斗第一回合
    // 按本场真实上限（含空血上限）回复，所以这里只报比例，不报「按上一场上限」的绝对值。
    if (a.startHealPct) lines.push(['开战回血', pct(a.startHealPct) + ' 最大生命']);
    if (a.reflectImmune) lines.push(['反噬豁免', '免疫一切反伤']);
    { const wt = winTakenMulOf(run); if (wt > 0) lines.push(['减伤成长（每胜利 −1%）', pct(wt)]); }
    if (a.openStrikePct) lines.push(['开局打击', pct(a.openStrikePct) + ' 敌最大生命']);
    // 2026-10 新增：N16 战意沸腾（固定力/敏/速与血上限）、N17 血蚀印记（每回合按敌人当前血抽血）。
    if (a.startStatFlat) lines.push(['战意沸腾', '力/敏/速 +' + Math.round(a.startStatFlat)]);
    if (a.startMaxHpFlat) lines.push(['战意沸腾', '生命上限 +' + Math.round(a.startMaxHpFlat)]);
    if (a.enemyHpDrainPct) lines.push(['血蚀印记', '每回合抽 ' + pct(Math.min(1, a.enemyHpDrainPct)) + ' 当前生命']);
    if (a.openKill) lines.push(['假如我直接赢', '开战即让敌方生命归零（本场直接判胜）']);
    if (a.enemyPowerDown) lines.push(['敌人攻击', pct(-a.enemyPowerDown)]);
    // 空血上限是乘法叠加的，清单里显示合并后的真实比例：
    // 空的部分 / 最终上限，这样玩家看到的数字与战斗里的实际占比一致。
    if (a.emptyMaxHpMul) lines.push(['空生命上限（不回血）', pct(a.emptyMaxHpMul / (1 + a.emptyMaxHpMul))]);

    const lowGate = '低血（≤' + Math.round(Math.max(a.lowHpAt, a.lowHpRegenAt) * 100) + '%）';

    if (a.lowHpFinalMul) lines.push([lowGate + '最终伤害', '×' + (1 + a.lowHpFinalMul).toFixed(2)]);
    if (a.lowHpPowerMul) lines.push([lowGate + '攻击', pct(a.lowHpPowerMul)]);
    if (a.lowHpAgilityMul) lines.push([lowGate + '最终敏捷', '×' + (1 + a.lowHpAgilityMul).toFixed(2) + '（终乘）']);
    if (a.lowHpSpeedMul) lines.push([lowGate + '最终速度', '×' + (1 + a.lowHpSpeedMul).toFixed(2) + '（终乘）']);
    if (a.lowHpTakenMul) lines.push([lowGate + '减伤', pct(-a.lowHpTakenMul)]);
    if (a.lowHpLifestealPct) lines.push([lowGate + '吸血', pct(a.lowHpLifestealPct)]);
    if (a.lowHpRegenPct) lines.push(['低血（≤' + Math.round(a.lowHpRegenAt * 100) + '%）每回合回血',
      pct(a.lowHpRegenPct) + '，最多回到 ' + Math.round(a.lowHpRegenAt * 100) + '%']);
    if (a.dmgMul && a.dmgMul !== 1) lines.push(['对本场敌人伤害', pct(a.dmgMul - 1)]);
    if (a.revivePct) {
      const rev = reviveInfoOf(run);
      const perLayer = rev ? rev.perLayer : Math.max(1, Math.floor(a.reviveMax || 1));
      const usedNow = rev ? rev.used : 0;
      const leftNow = rev ? rev.left : perLayer;
      lines.push(['复活（每层 ' + perLayer + ' 次）', pct(a.revivePct) + ' 生命' +
        (a.reviveStatMul ? '，复活后本场力/敏/速 +' + pct(a.reviveStatMul) : '') +
        (usedNow > 0 ? '（本层已用 ' + usedNow + '/' + perLayer + '，剩 ' + leftNow + ' 次）' : '')]);
    }

    { const cn = fragileCoinBonus(run); if (cn > 0) lines.push(['试炼币获取（每场胜利）', pct(cn)]); }
    if (a.deathSaves && a.deathSaves.length) {
      const named = a.deathSaves.filter((s) => s.name).map((s) => s.name);
      const label = named.length ? named.join('/') : '免死';
      lines.push([label, a.deathSaves.length + ' 次' +
        (a.deathSaves.some((s) => s.healPct) ? '（按比例复活）' : '（保留 1 血）')]);
    }
    if (a.weaponFreeUses) lines.push(['前 ' + a.weaponFreeUses + ' 次使用武器', '不消耗回合']);
    if (a.weaponBoostUses) {
      lines.push(['前 ' + a.weaponBoostUses + ' 次使用武器',
        pct(a.weaponBoostPowerMul) + (a.weaponBoostMustHit ? '、必中' : '') +
        (a.weaponBoostReflectImmune ? '、免疫反伤' : '') +
        (a.weaponBoostFatigueMul ? '；之后攻击 ' + pct(-a.weaponBoostFatigueMul) : '')]);
    }
    if (a.mustHitFirst) lines.push(['必中', '首次攻击']);
    if (a.mustHitAll) lines.push(['必中', '全部攻击']);
    if (a.firstDodge) lines.push(['首次受击', '必定闪避' + (a.firstDodgeFreeTurn ? ' · 我方立刻行动一次' : '')]);
    if (a.firstHitZero) lines.push(['首次受击', '伤害归零' + (a.firstHitZeroFreeTurn ? ' · 我方立刻行动一次' : '')]);
    if (a.firstSkillFree) lines.push(['首技能', '不消耗回合']);
    if (run.winStatPower || run.winStatAgility || run.winStatSpeed) {
      lines.push(['登顶成长（第 10 层起每胜）', '力 +' + Math.round(Number(run.winStatPower) || 0) +
        '、敏 +' + Math.round(Number(run.winStatAgility) || 0) + '、速 +' + Math.round(Number(run.winStatSpeed) || 0)]);
    }

    if (run.killPower) lines.push(['击杀成长（攻击）', pct(run.killPower)]);
    if (run.bonusPower) lines.push(['加成累积（攻击）', pct(run.bonusPower)]);
    for (const [k, name] of [['power', '攻击'], ['agility', '敏捷'], ['speed', '速度']]) {
      const fb = fragileBonus(run, k);
      if (fb.value) lines.push(['烙印·' + name + (fb.burned ? '（已损毁·永久保留）' : '（存在）'), pct(fb.value)]);
    }
    if (run.spendGain && (run.spendGain.power || run.spendGain.agility || run.spendGain.speed || run.spendGain.hp)) {
      const g = run.spendGain;
      lines.push(['挥金如土', '攻击 +' + g.power + ' / 敏捷 +' + g.agility + ' / 速度 +' + g.speed + ' / 生命 +' + g.hp]);
    }
    if (run.enemyMaxHpDown) lines.push(['敌人生命上限（本局）', pct(-run.enemyMaxHpDown)]);
    if (run.shopDiscount) lines.push(['下一家商店', shopDiscountLabel(run.shopDiscountPct || 0.5)]);

    if (stacksOf(run, 'C09') && run.layer % 5 === 0) lines.push(['逢五强化（本层）', '已生效']);
    return lines;
  }



  function shopDiscountLabel(pct) {
    const v = Math.max(0, Number(pct) || 0);
    const zhe = Math.round((1 - v) * 100) / 10;
    return (Number.isInteger(zhe) ? zhe : zhe.toFixed(1)) + ' 折';
  }

  function permSlots(run) { return (D().PERMANENT_SLOTS || 5) + Math.max(0, Number(run && run.permSlots) || 0); }
  // 下一场把它放进「非战斗期间算出的上限」，所以进场血量不会高于局外上限。
  // 参考上限：战斗中用本场实际 maxHp；换层等「还没有下一场」的时机用上一场记下的
  // run.lastMaxHp（就是玩家看到的那条血上限）。
  function hpAbsOf(run, fallbackMaxHp) {
    if (!run) return Math.max(1, Math.round(Number(fallbackMaxHp) || 1));
    const v = Number(run.hpAbs);
    if (Number.isFinite(v) && v > 0) return Math.max(1, Math.round(v));
    const ref = Math.max(1, Math.round(Number(run.refMaxHp) || Number(run.lastMaxHp) || Number(fallbackMaxHp) || 0));
    return Math.max(1, Math.round(ref * clamp01(run.carry == null ? 1 : run.carry)));
  }
  // 「涌泉烙印」（C52）的治疗加成倍率：技能 / 持续治疗（sim 的 healOf）乘上它。
  // 注意不作用于「规则回血」（层间结算回血、自动回血、药丸），
  function healBonusMul(run) {
    const saved = run && run.mode === 'endless' && run.mirrorSnapshot && run.mirrorSnapshot.combat;
    const inherited = saved && Number.isFinite(Number(saved.healMul)) ? Number(saved.healMul) - 1 : 0;
    return Math.round(Math.max(0, 1 + fragileHealBonus(run) + inherited) * 10000) / 10000;
  }
  // 非战斗期间按「最大生命的百分比」回血：换算成绝对值后累加（自动受上限约束）。
  function healAbs(run, pct, refMaxHp) {
    const p = Math.max(0, Number(pct) || 0);
    if (!p) return 0;
    const ref = Math.max(1, Math.round(Number(refMaxHp) || Number(run && run.refMaxHp) || Number(run && run.lastMaxHp) || 0));
    const gain = Math.max(1, Math.round(ref * p));
    run.hpAbs = hpAbsOf(run) + gain;
    return gain;
  }
  function occupiesPermSlot(buff) {
    if (!buff || buff.kind !== 'permanent') return false;
    const m = buff.mods || {};
    if (m.pickWeaponPct || m.pickSkillPct || m.pickPermanentFree || m.pickPermanentMul || m.pickBrandBreak || m.pickLimitedUses || m.permSlot) return false;
    return true;
  }

  function winTakenMulOf(run) {
    if (!run) return 0;
    const c48 = stacksOf(run, 'C48');
    if (!c48) return 0;
    const cap = (Number(D().BUFF_BY_ID.C48.mods.winTakenMulCap) || 0.25) * c48;
    return Math.min(cap, Math.max(0, Number(run.winTakenMul) || 0));
  }
  // 上限按每一栏算：层数 ×（增幅水晶 + 本条水晶铭文，加算）。
  function winMaxHpOf(run) {
    if (!run) return 0;
    const g = globalMul(run);
    let cap = 0;
    for (const row of (run.permanent || [])) {
      if (!row || row.id !== 'C07') continue;
      const st = Math.max(1, Math.floor(Number(row.stacks) || 1));
      cap += (D().BUFF_BY_ID.C07.mods.winMaxHpCap || 0.30) * st * buffEffectMulOf(row, g);
    }
    return Math.min(cap, Math.max(0, Number(run.winMaxHp) || 0));
  }

  function bumpInstant(run, id) {
    if (!run || !id) return;
    run.instantIds = Array.isArray(run.instantIds) ? run.instantIds : [];
    const row = run.instantIds.find((x) => x && x.id === id);
    if (row) row.count = Math.max(1, Math.floor(Number(row.count) || 1)) + 1;
    else run.instantIds.push({ id: id, count: 1 });
  }

  function buffCountOf(run, id) {
    if (!run) return 0;
    let n = 0;
    for (const row of run.permanent || []) if (row && row.id === id) n += Math.max(1, Math.floor(Number(row.stacks) || 1));
    for (const row of run.limited || []) if (row && row.id === id) n += Math.max(1, Math.floor(Number(row.stacks) || 1));
    return n;
  }
  // 碎掉的烙印也要计入累计（否则层数上限与重复降权会因碎掉而回退，

  function pickGotOf(run, id) {
    const t = run && run.pickGot;
    return Math.max(0, Math.floor(Number(t && t[id]) || 0));
  }
  function notePickGot(run, id) {
    if (!run || !id) return 0;
    const n = pickGotOf(run, id) + 1;
    run.pickGot = Object.assign({}, run.pickGot || {}, { [id]: n });
    return n;
  }

  function fragileGotOf(run, id) {
    const t = run && run.fragileGot;
    return Math.max(0, Math.floor(Number(t && t[id]) || 0));
  }

  function obtainedCountOf(run, id) {
    return Math.max(buffCountOf(run, id), fragileGotOf(run, id), pickGotOf(run, id));
  }

  function instantOwnedCount(run, id) {
    if (!run) return 0;
    let n = 0;
    for (const row of run.instantIds || []) if (row && row.id === id) n += Math.max(1, Math.floor(Number(row.count) || 1));
    return n;
  }
  function permUsed(run) {
    const list = (run && run.permanent) || [];

    let used = 0;
    for (const row of list) {
      const def = D().BUFF_BY_ID[row && row.id];
      if (def && D().hasTag(def, 'story')) continue;
      if (!rowFreeOf(row)) used++;
    }
    return Math.max(0, used);
  }
  function repairPermanentSlots(run, list) {
    const cap = permSlots(run);
    const used = permUsed(run);
    if (used > cap && typeof console !== 'undefined' && console.warn) {
      console.warn('[tower] 永久增益占用槽位超过上限：' + used + '/' + cap +
        '（列表 ' + list.length + ' 项，含免占位 ' + (list.length - used) + ' 项）—— 保留不丢弃，请检查 addBuff 的满格判定');
    }
    return list;
  }
  function currentMaxHp(run) {
    const base = Number(run && run.baseMaxHp) || 0;
    if (!(base > 0)) return 0;
    const stickyHp = Math.max(0, Number(run.hpBonus) || 0);
    const winMaxHp = winMaxHpOf(run);
    const flat = Math.max(0, Number(run.winHpFlat) || 0) +
      (run.spendGain ? Math.max(0, Number(run.spendGain.hp) || 0) : 0);
    const mirrored = mirrorStatValue(run, 'maxHp', base);
    return Math.max(1, Math.round(mirrored * (1 + stickyHp + winMaxHp)) + flat);
  }

  function currentHp(run) {
    // run.hpAbs 是全局实际血量计数器（已在 reportBattle 里按局外上限裁过），
    // 所以这里通常只做防御性裁剪（上限因卖增益/吃 debuff 变小时才会真的裁到）。
    // · 战斗进行中时 run.lastMaxHp 就是本场真实上限（含空血上限等临时加成），
    const longCap = currentMaxHp(run);
    const battleCap = Math.max(0, Math.round(Number(run && run.lastMaxHp) || 0));
    const live = !!(run && run.attempt);
    const cap = live && battleCap > 0 ? battleCap : (longCap > 0 ? longCap : battleCap);
    const hp = hpAbsOf(run, cap);
    // 同步全局计数器：局外上限如果比计数器低（卖掉/失去永久上限增益、
    // 否则局外显示虽然按上限裁过，计数器里却还留着「多出来的血」，
    // 下次上限一变高它又会冒出来。
    if (cap > 0 && Number(run.hpAbs) > cap) run.hpAbs = cap;
    return { hp: cap > 0 ? Math.min(hp, cap) : hp, maxHp: cap };
  }


  function buildFoe(mode, layer, entry, salt, isLast) {
    const TD = D();
    const scale = mode === 'endless' && TD.endlessScaleParts ? TD.endlessScaleParts(layer) : null;
    const LT = mode === 'tower' ? TD.towerLevel(layer) : scale ? scale.level : TD.endlessLevel(layer);
    const M = mode === 'tower' ? TD.towerMult(layer) : scale ? scale.mult : TD.endlessMult(layer);

    const KM = mode === 'tower' ? 1
      : scale ? scale.depth : (TD.endlessDepthMul ? TD.endlessDepthMul(layer) : 1);
    const statBase = scale ? scale.statBase : GData.stagePlayerStat(LT);
    const hpBase = scale ? scale.hpBase : GData.stagePlayerHp(LT);
// 无尽段机制叠加：所有怪物按固定顺序追加机制
    const extra = [];
    const elite = isEliteEntry(entry, layer, isLast);
    let name, bias, npcType, skills = [], weapons = [], pattern = null, mech;
    let mechParams = null, wears = null, castable = undefined, campaign = null;
    if (entry.kind === 'hero') {
      const scale = (GData.STAGE_TYPE_SCALE && GData.STAGE_TYPE_SCALE[entry.anim]) || 1;
      bias = { power: scale, agility: scale, speed: scale, hp: 1 };
      name = HERO_NAME[entry.anim]; npcType = entry.anim;
      skills = [{ id: HERO_SKILL[entry.anim], level: Math.max(1, Math.min(15, Math.round(LT / 5))) }];
      mech = extra.slice();
    } else if (entry.kind === 'campaign') {

      const cb = TD.CAMPAIGN_BOSS_BY_ID[entry.id] || TD.CAMPAIGN_BOSSES[0];
      const up = Math.max(0, Math.floor((LT - 28) / 12));
      bias = cb.bias; name = cb.name; npcType = null;
      weapons = cb.weapons.map((w) => ({ id: w.id, level: Math.max(1, Math.min(15, w.level + up)) }));
      skills = cb.skills.map((k) => ({ id: k.id, level: Math.max(1, Math.min(15, k.level + up)) }));
      pattern = cb.pattern.slice();
      castable = Array.isArray(cb.castable) ? cb.castable.slice() : undefined;
      wears = null;

      mech = (cb.mech || []).slice();
      for (const m of extra) if (!mech.includes(m)) mech.push(m);
      campaign = { id: cb.id, bossId: cb.bossId, mcFrame: cb.mcFrame,
        bigName: cb.bigName, level: cb.level };
    } else if (entry.kind === 'squirrel' || entry.kind === 'trial' || entry.kind === 'warlord' || entry.kind === 'patrol') {

      const sq = entry.kind === 'patrol'
        ? { name: TD.patrolName ? TD.patrolName(layer) : TD.PATROL.name,
          bias: { power: 1, agility: 1, speed: 1, hp: 1 }, weapons: [], skills: [],
          pattern: [], mech: [], mechParams: null, castable: undefined }
        : entry.kind === 'warlord' ? TD.warlordFor(layer, salt)
          : entry.kind === 'trial' ? TD.TRIAL_BY_ID[entry.id] : TD.SQUIRREL_BY_ID[entry.id];
      bias = sq.bias; name = sq.name; npcType = null;
      const up = Math.max(0, Math.floor((LT - 28) / 12));
      weapons = sq.weapons.map((w) => ({ id: w.id, level: Math.max(1, Math.min(15, w.level + up)) }));
      skills = sq.skills.map((k) => ({ id: k.id, level: Math.max(1, Math.min(15, k.level + up)) }));
      pattern = sq.pattern.slice();

      wears = TD.wearsOf(gearKeyOf(layer, sq));
      mech = extra.slice();
      for (const m of sq.mech || []) if (!mech.includes(m)) mech.push(m);
      mechParams = sq.mechParams || null;

      castable = Array.isArray(sq.castable) ? sq.castable.slice() : undefined;
    } else {
      const npc = TD.NPC_BY_ID[entry.id];
      bias = npc.bias; name = npc.name; npcType = 'tw_' + npc.id;
      mech = [npc.mech];
      for (const m of extra) if (!mech.includes(m)) mech.push(m);
    }
    const eliteMul = elite ? 1.2 : 1;
    const stat = (b, mul) => Math.max(1, Math.round(statBase * (mul || TD.FOE_STAT_MUL) * M * KM * b * eliteMul));
    const hero = entry.kind === 'hero';
    const warlord = entry.kind === 'warlord';
    const powMul = hero ? TD.FOE_HERO_POWER_MUL
      : warlord ? TD.FOE_WARLORD_POWER_MUL
        : campaign ? TD.FOE_CAMPAIGN_POWER_MUL : TD.FOE_TRIAL_POWER_MUL;

    const earlyHp = TD.towerEarlyHpMul(layer, mode);
    const heroHp = hpBase * TD.FOE_HP_MUL * TD.FOE_HERO_HP_MUL * M * KM * bias.hp * earlyHp;
    const hpRatio = hero ? 1 : campaign ? TD.CAMPAIGN_HP_RATIO : warlord ? TD.WARLORD_HP_RATIO
      : mode === 'endless' && TD.endlessBossHpRatio ? TD.endlessBossHpRatio(bias.hp, layer) : TD.bossHpRatio(bias.hp, layer);
    const foe = {
      name, level: LT, npcType,
      power: stat(bias.power, TD.FOE_POWER_MUL * powMul),
      agility: stat(bias.agility), speed: stat(bias.speed),
      hp: Math.max(1, Math.round(heroHp * hpRatio)),
      weapons, skills, mech, pattern, mechParams, wears,
      castable,
    };
    const poolNpc = entry.kind === 'npc' || entry.kind === 'warlord' || entry.kind === 'campaign' || (entry.kind === 'trial');
    if (campaign) { foe.campaign = campaign; foe.bossKind = 'campaign'; }

    if (entry.kind === 'patrol') {
      const tools = [];
      const each = (map) => { if (map && map.each) map.each((id) => tools.push(Number(id))); };
      each(typeof weaponsMap !== 'undefined' ? weaponsMap : (typeof window !== 'undefined' ? window.weaponsMap : null));
      const wAll = tools.slice();
      const sAll = [];
      const smap = (typeof skillsMap !== 'undefined' ? skillsMap : (typeof window !== 'undefined' ? window.skillsMap : null));
      if (smap && smap.each) smap.each((id) => sAll.push(Number(id)));
      const lv = Math.max(1, Math.floor(Number(TD.PATROL.toolLevel) || 15));
      foe.weapons = (wAll.length ? wAll : [1]).map((id) => ({ id, level: lv }));
      foe.skills = sAll.map((id) => ({ id, level: lv }));
      foe.gears = (TD.PATROL.classicGear || []).map((g) => ({ id: g.id, type: g.type }));
      foe.patrol = true;

      foe.name = TD.patrolName ? TD.patrolName(layer) : TD.PATROL.name;
    }
    // 无尽塔仙鹤的后期技能收敛：只给这一种 foe 写字段，Sim 读取后只影响
    if (mode === 'endless' && entry.kind === 'hero' && entry.anim === 'xh'
        && typeof TD.endlessXhTune === 'function') {
      const tune = TD.endlessXhTune(layer);
      foe.xhSkillMul = tune.skill;
      foe.xhEarlyMul = tune.early;
    }
    return { foe, elite, poolNpc };
  }
  function regionOf(entry) {
    if (entry.kind === 'campaign') {
      const b = D().CAMPAIGN_BOSS_BY_ID[entry.id];
      return b && b.region != null ? b.region : 0;
    }
    if (entry.kind === 'squirrel' || entry.kind === 'trial' || entry.kind === 'warlord') {
      const sq = entry.kind === 'warlord' ? D().warlordFor(entry._layer, entry._salt)
        : entry.kind === 'trial' ? D().TRIAL_BY_ID[entry.id] : D().SQUIRREL_BY_ID[entry.id];
      return sq && sq.region != null ? sq.region : 0;
    }

    if (entry.kind === 'patrol') return HERO_REGION[D().heroOrder(entry._layer || 1, entry._salt || 0)[0]] != null
      ? HERO_REGION[D().heroOrder(entry._layer || 1, entry._salt || 0)[0]] : 0;
    const anim = entry.kind === 'hero' ? entry.anim : D().NPC_BY_ID[entry.id].anim;
    return HERO_REGION[anim] != null ? HERO_REGION[anim] : 0;
  }



  function startTowerRun() {
    // 只开放无尽塔；挑战塔入口不出现，这里也直接拒绝。
    if (ONLINE) return { ok: false, msg: '联机版只开放无尽塔。' };
    const lock = unlocked();
    if (!lock.ok) return lock;
    const t = tower();
    if (t.run) return { ok: false, msg: '本层挑战尚未结束。' };
    settleBlackTowerRewards();
    const s = S();

    if (!debug('noStageCost')) {
      if (!(s.props[BOOK_PROP] > 0)) return { ok: false, needsBook: true, msg: '挑战书不足，快去商店中购买吧！' };
      s.props[BOOK_PROP]--;
      if (s.props[BOOK_PROP] <= 0) delete s.props[BOOK_PROP];
    }
    const layer = t.maxLayer + 1;
    // buffVer 必须建局时就写上：否则第一次 normalizeRun 会把新加的 T04 当成旧档 T04 搬走。
    t.run = { mode: 'tower', layer, plan: buildPlan(layer, undefined, false, 'tower'), idx: 0, carry: 1, buffVer: D().BUFF_VER,
      permanent: [], limited: [], buffs: [], debuffs: [], pot: 0, choices: null };
    save();
    return { ok: true, layer };
  }
  function startEndlessRun(options) {

    if (ONLINE) {
      const levelLock = endlessUnlocked();
      if (!levelLock.ok) return levelLock;
    }
    const lock = ONLINE ? { ok: true } : unlocked();
    if (!lock.ok) return lock;
    const e = endless();
    if (e.run) return { ok: false, msg: '本局无尽挑战尚未结束。' };
    const opts = options || {};
    const created = opts.ruleset === 'hero' ? (window.TowerHero ? TowerHero.create(opts.hero) : { ok: false, msg: '勇者模块尚未加载。' }) : null;
    if (created && !created.ok) return created;
    const salt = (Date.now() % 1000000) + ':' + Math.floor(Math.random() * 1e6);
    const run = { ruleset: created ? 'hero' : 'default', hero: created ? created.hero : null, layer: 1, plan: buildPlan(1, salt, true), idx: 0, carry: 1, salt, buffVer: D().BUFF_VER,
      mode: 'endless', permanent: [], limited: [], coins: 0, score: 0, bestLayer: 0,
      // 即时削弱累计（E07/E08 生命上限、E11 攻击力）：拿到就记在这里，之后每场都生效。
      enemyMaxHpDown: 0, enemyPowerDown: 0,
      killPower: 0, bonusPower: 0, shop: null, phase: null, choices: null, choiceQueue: [], choicesKind: null, debuffs: [],

      patrolDoneBlock: 0, patrolDoneWins: 0,

      heroMentorMintDone: false, heroMentorPending: false,

      eventRegen: [],
      retryToken: 0, retrySnap: null,
      achievements: [], scoreLog: [], statPeaks: {}, pendingToasts: [], pendingAchievements: [],
      deathSaves: 0, reviveCount: 0, reviveTierPaid: 0,

      fragileAliveFull: 1 };
    run.runStats = createRunStats(run, true);

    // 第一场之前也要能正常显示血量。
    // run.baseMaxHp 原本只在第一场的 adjustMe 里才写（那是唯一知道玩家面板的地方），
    // ⚠️ 只写基准、不写 `run.hpAbs`：绝对血量计数器在「没写过」时按当前上限算满血
    run.baseMaxHp = Math.max(1, Math.round(Number(heroBaseHp(run)) || 0));
    e.run = run;
    save();
    return { ok: true, layer: 1 };
  }

  function heroOwned(run) {
    if (!isHeroRun(run)) return [];
    const out = [];
    for (const kind of ['weapon', 'skill']) for (const raw of run.hero[kind === 'weapon' ? 'weapons' : 'skills']) {
      const [id, level] = raw.split(':').map(Number);
      out.push({ kind, id, level, ref: (kind === 'weapon' ? 'w:' : 's:') + id });
    }
    return out;
  }
  function heroTraining(run, attempts, guaranteed) {
    const pool = heroOwned(run).filter(it => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)));
    if (!pool.length) return { ok: false, msg: '所有可升级武技均已满级。' };
    const it = pool[Math.floor(Math.random() * pool.length)];
    return TowerHero.upgrade(run.hero, it.ref, { attempts, guaranteed });
  }

  function heroTrainingSpread(run, times) {
    const count = Math.max(1, Math.floor(Number(times) || 1));
    const results = [];
    for (let i = 0; i < count; i++) {
      const pool = heroOwned(run).filter(it => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)));
      if (!pool.length) break;
      const it = pool[Math.floor(Math.random() * pool.length)];
      const res = TowerHero.upgrade(run.hero, it.ref, { attempts: 1, guaranteed: true });
      if (!res || !res.ok) break;
      results.push(res);
    }
    if (!results.length) return { ok: false, msg: '所有可升级武技均已满级。' };
    return { ok: true, results, msg: results.map(it => it.label).join(' '),
      label: results.map(it => it.label).join(' ') };
  }
  function noteHero(run, text) {
    run.hero.log = (run.hero.log || []).concat([String(text)]).slice(-20);
    run.baseMaxHp = heroBaseHp(run);
  }

  function coinTrainHero(ref) {
    const e = endless(), run = e.run;
    if (!isHeroRun(run)) return { ok: false, msg: '当前不是勇者模式。' };
    if (run.attempt) return { ok: false, msg: '战斗中不能修炼。' };
    const tokens = Math.max(0, Math.floor(Number(run.retryToken) || 0));
    if (!freeCoinSpend() && tokens < 1) return { ok: false, msg: '铸币不足（需要 1 枚）。' };
    const item = heroOwned(run).find(it => it.ref === String(ref));
    if (!item) return { ok: false, msg: '勇者尚未掌握这个武技。' };
    if (item.level >= 15) return { ok: false, msg: '该武技已达到真5上限。' };
    if (item.kind === 'skill' && [6, 13].includes(item.id)) return { ok: false, msg: '该技能不能升级。' };
    const gain = 3 + Math.floor(Math.random() * 3);
    if (!freeCoinSpend()) run.retryToken = tokens - 1;
    const out = TowerHero.addLevels(run.hero, item.ref, gain);
    if (!out.ok) {
      if (!freeCoinSpend()) run.retryToken = tokens;
      save();
      return out;
    }
    noteHero(run, '铸币修炼：' + out.msg);
    save();
    return Object.assign({}, out, { cost: freeCoinSpend() ? 0 : 1, left: run.retryToken });
  }

  function bladeRowOf(runArg) {
    const run = runArg || endless().run;
    if (!run) return null;
    return (run.limited || []).find((row) => row && D().isBladeId(row.id)) || null;
  }
  // 界面 / 状态机共用的剑信息快照。
  function bladeInfoOf(runArg) {
    const run = runArg || endless().run;
    const row = bladeRowOf(run);
    if (!row) return null;
    const def = D().BUFF_BY_ID[row.id] || {};
    const cfg = D().BLADE;
    const stacks = Math.max(1, Math.min(cfg.maxStacks, Math.floor(Number(row.stacks) || 1)));
    const uses = Math.floor(Number(row.uses));
    const finalForm = row.id === cfg.finalId;
    const dead = row.id === cfg.deadId;
    const round4 = (v) => Math.round(v * 10000) / 10000;
    const on = row.on !== false;

    const cutT = cfg.maxStacks > 1 ? (stacks - 1) / (cfg.maxStacks - 1) : 0;
    const lerpCut = (min, max) => round4(min + (max - min) * cutT);
    const powerCut = finalForm && on
      ? Math.min(cfg.mirrorPowerCutMax, lerpCut(cfg.mirrorPowerCut, cfg.mirrorPowerCutMax)) : 0;
    const hpCut = finalForm && on
      ? Math.min(cfg.mirrorHpCutMax, lerpCut(cfg.mirrorHpCut, cfg.mirrorHpCutMax)) : 0;
    return {
      id: row.id, uid: row.uid, name: def.name || '渴血之剑', desc: def.desc || '',
      stage: D().bladeStageOf(row.id), final: finalForm, dead: dead,
      stacks: stacks, uses: Number.isFinite(uses) ? uses : -1, unlimited: !(uses > 0),
      on: on, forced: row.forced === true,
      idleBattles: Math.max(0, Math.floor(Number(row.idleBattles) || 0)),
      idleLimit: cfg.idleLimit,
      suppressStreak: Math.max(0, Math.floor(Number(row.suppressStreak) || 0)),
      sacrificePending: run && run.bladeSacrificePending === true,
      nextId: D().bladeNextId(row.id),
      powerCut: powerCut, hpCut: hpCut,
    };
  }
  // 兼容旧界面 / 旧回归的出口：返回剑的层数与对镜之魔王的削减幅度。
  function heroBladeOf(run) {
    return bladeInfoOf(run);
  }

  function queueRunStory(run, id) {
    if (!run || !id) return null;
    const key = String(id);
    if (!storyEnabled()) {
      run.pendingToasts = (run.pendingToasts || []).concat(['渴血之剑：' + key]).slice(-12);
      save();
      return null;
    }
    if (run.story === key || run.pendingStory === key) return key;
    if (!run.story && !run.pendingStory) { setRunStory('endless', key); return key; }
    run.storyQueue = (Array.isArray(run.storyQueue) ? run.storyQueue : [])
      .filter((x) => x !== key).concat([key]).slice(-4);
    save();
    return key;
  }

  function grantBlade(run) {
    if (!run || bladeRowOf(run)) return null;
    const cfg = D().BLADE;
    const def = D().BUFF_BY_ID[cfg.initialId];
    if (!def) return null;
    const row = { id: cfg.initialId, stacks: 1, uses: Math.max(1, Number(def.uses) || 8), on: true,
      at: nextAcqSeq(run), uid: nextUid(run), idleBattles: 0, forced: false, suppressStreak: 0 };
    run.limited = Array.isArray(run.limited) ? run.limited : [];
    run.limited.push(row);
    logBuff(run, cfg.initialId, 'get', { detail: '第一次巡视胜利 · 渴血之剑' });
    queueRunStory(run, 'bladeGet');
    save();
    return row;
  }

  function starveBlade(run, out) {
    const row = bladeRowOf(run);
    if (!row) return null;
    const cfg = D().BLADE;
    const consumed = Math.max(1, Math.floor(Number(cfg.starveUses) || 1));
    if (!(row.uses > 0)) return null;
    const oldId = row.id;
    row.uses = Math.max(0, Math.floor(Number(row.uses) || 0) - consumed);
    let evolved = null;
    if (!(row.uses > 0)) {
      const next = D().bladeNextId(row.id);
      if (next && next !== row.id) {
        const nextDef = D().BUFF_BY_ID[next] || {};
        row.id = next;
        row.uses = Number(nextDef.uses) < 0 ? -1 : Math.max(1, Number(nextDef.uses) || 1);
        evolved = { id: next, name: nextDef.name || next };
        if (out) out.bladeEvolved = evolved;
        run.pendingToasts = (run.pendingToasts || []).concat(['渴血之剑进化为「' + (nextDef.name || next) + '」']).slice(-12);
      }
    }
    const name = (D().BUFF_BY_ID[row.id] || {}).name || '渴血之剑';
    const left = row.uses > 0 ? ('剩余 ' + row.uses + ' 场') : ('已进化为' + name);
    run.pendingToasts = (run.pendingToasts || []).concat([
      '没有可献祭的增益：' + name + ' 自动吞噬 ' + consumed + ' 次使用次数（' + left + '）',
    ]).slice(-12);
    logBuff(run, oldId, 'lose', { detail: '没有祭品：自动吞噬 ' + consumed + ' 次使用次数' });
    return { starved: true, consumed: consumed, uses: row.uses, evolved: evolved };
  }

  function bladeAfterBattle(run, out) {
    const row = bladeRowOf(run);
    if (!row || (out && out.bladeGranted)) return null;
    const cfg = D().BLADE;
    const finalForm = row.id === cfg.finalId || row.id === cfg.deadId;
    if (finalForm) { row.idleBattles = 0; row.forced = false; return null; }

    if (row.on === false) {
      row.idleBattles = Math.max(0, Math.floor(Number(row.idleBattles) || 0)) + 1;
      if (row.idleBattles >= cfg.idleLimit) {
        row.idleBattles = 0;
        row.on = true;
        row.forced = true;
        if (out) out.bladeForced = true;
        run.pendingToasts = (run.pendingToasts || []).concat(['渴血之剑强制苏醒：它已经等了 20 场。']).slice(-12);
        queueRunStory(run, 'bladeForce');
      }
      return null;
    }
    row.idleBattles = 0;
    row.forced = false;
    if (row.uses > 0) row.uses -= 1;
    if (!(row.uses > 0)) {
      const next = D().bladeNextId(row.id);
      if (next && next !== row.id) {
        const nextDef = D().BUFF_BY_ID[next] || {};
        row.id = next;
        row.uses = Number(nextDef.uses) < 0 ? -1 : Math.max(1, Number(nextDef.uses) || 1);
        if (out) out.bladeEvolved = { id: next, name: nextDef.name || '渴血之剑' };
        run.pendingToasts = (run.pendingToasts || []).concat(['渴血之剑进化为「' + (nextDef.name || next) + '」']).slice(-12);
      }
    }
    if (row.id !== cfg.finalId && row.id !== cfg.deadId) {

      if (bladeSacrificeCandidates(run).list.length) {
        run.bladeSacrificePending = true;
        if (out) out.bladeSacrifice = true;
      } else {
        const s = starveBlade(run, out);
        if (s && out) out.bladeStarved = s;
        delete run.bladeSacrificePending;
      }
    }
    return bladeInfoOf(run);
  }

  function bladeSacrificeCandidates(runArg) {
    const run = runArg || endless().run;
    if (!run || !bladeRowOf(run)) return { ok: false, list: [], msg: '当前没有渴血之剑。' };
    const cfg = D().BLADE;
    const list = [];
    for (const row of (run.limited || [])) {
      if (!row || D().isBladeId(row.id)) continue;
      const def = D().BUFF_BY_ID[row.id];
      if (!def || def.kind !== 'limited') continue;
      if (Number(def.rarity) < cfg.sacrificeRarity) continue;
      if (D().hasTag(def, 'story') || D().hasTag(def, 'hidden')) continue;
      // 易碎烙印（C49/C53…）的「层数」与损毁明细是另一套账，不能当作普通限次件拆一层。
      if (def.mods && def.mods.fragileBreakPct) continue;
      if (!(Number(row.uses) > 0)) continue;
      list.push({
        ref: 'l:' + row.uid, uid: row.uid, id: def.id, name: def.name, rarity: def.rarity,
        kind: 'limited', stacks: Math.max(1, Math.floor(Number(row.stacks) || 1)),
        uses: Math.max(0, Math.floor(Number(row.uses) || 0)), inscription: null,
        meta: '限次 · 剩余 ' + Math.max(0, Math.floor(Number(row.uses) || 0)) + ' 场' +
          (Math.max(1, Math.floor(Number(row.stacks) || 1)) > 1 ? ' · ×' + Math.max(1, Math.floor(Number(row.stacks) || 1)) + ' 层' : ''),
      });
    }
    for (const row of (run.permanent || [])) {
      if (!row) continue;
      const def = D().BUFF_BY_ID[row.id];
      if (!def || D().hasTag(def, 'hidden') || D().hasTag(def, 'story')) continue;
      const crystal = rowEnchMulOf(row) > 1;
      const free = rowFreeOf(row);

      const inscription = crystal ? 'C60' : (free ? 'C37' : null);
      const stacks = Math.max(1, Math.floor(Number(row.stacks) || 1));
      list.push({
        ref: 'p:' + row.uid, uid: row.uid, id: def.id, name: def.name, rarity: def.rarity,
        kind: 'permanent', stacks: stacks, uses: null, inscription: inscription,
        meta: inscription
          ? (inscription === 'C60' ? '消耗水晶铭文 · 增益保留' : '消耗虚空铭文 · 增益保留')
          : ('永久' + (stacks > 1 ? ' · ×' + stacks + ' 层（消耗 1 层）' : '')),
      });
    }

    list.sort((a, b) => (a.kind === b.kind ? (b.rarity - a.rarity) : (a.kind === 'limited' ? -1 : 1)));
    return { ok: true, list: list, blade: bladeInfoOf(run) };
  }

  function consumeBladeOffering(run, cand) {
    if (!cand) return null;
    if (cand.kind === 'permanent' && cand.inscription) {
      const row = (run.permanent || []).find((b) => b && Number(b.uid) === Number(cand.uid));
      if (!row) return null;
      if (cand.inscription === 'C60') {
        const ench = rowEnchantsOf(row);
        const at = ench.indexOf('C60');
        if (at >= 0) ench.splice(at, 1);
        row.enchants = ench;
        let mul = 1;
        for (const eid of ench) {
          const ed = D().BUFF_BY_ID[eid] || {};
          mul *= Math.max(1, Number(ed.mods && ed.mods.pickPermanentMul) || 1);
        }
        row.enchMul = mul;
      } else {
        row.slotFree = false;
        syncSlotFree(run);
      }
      return { kind: 'inscription', id: cand.inscription, rowId: row.id };
    }

    if (cand.kind === 'limited' && cand.stacks <= 1) {
      const row = (run.limited || []).find((b) => b && Number(b.uid) === Number(cand.uid));
      if (!row) return null;
      const def = D().BUFF_BY_ID[row.id] || {};
      const per = Math.max(1, Math.floor(Number(def.uses) || 1));
      const left = Math.max(0, Math.floor(Number(row.uses) || 0));
      if (left > per) {
        row.uses = left - per;
        row.on = true;
        return { kind: 'limited', id: row.id, uses: row.uses, consumed: per, partial: true };
      }
    }

    if (cand.stacks > 1) {
      const row = cand.kind === 'permanent'
        ? (run.permanent || []).find((b) => b && Number(b.uid) === Number(cand.uid))
        : (run.limited || []).find((b) => b && Number(b.uid) === Number(cand.uid));
      if (!row) return null;
      row.stacks = Math.max(1, Math.floor(Number(row.stacks) || 1) - 1);
      return { kind: cand.kind, id: row.id, stacks: row.stacks };
    }
    const row = (run.permanent || []).find((b) => b && Number(b.uid) === Number(cand.uid))
      || (run.limited || []).find((b) => b && Number(b.uid) === Number(cand.uid));
    if (!row) return null;
    const detail = '献祭给渴血之剑';
    if (!takeOwnedBuff(run, Number(row.uid) > 0 ? Number(row.uid) : row.id, detail)) return null;
    return { kind: cand.kind, id: row.id, removed: true };
  }

  function sacrificeBlade(ref) {
    const run = endless().run;
    if (!run || !run.bladeSacrificePending) return { ok: false, msg: '现在不需要献祭。' };
    const row = bladeRowOf(run);
    if (!row) { delete run.bladeSacrificePending; save(); return { ok: false, msg: '当前没有渴血之剑。' }; }
    const got = bladeSacrificeCandidates(run);
    if (!ref) {
      if (got.list.length) return { ok: false, msg: '必须选择一件祭品。' };

      const s = starveBlade(run, null);
      delete run.bladeSacrificePending;
      save();
      return { ok: true, starved: true, name: (D().BUFF_BY_ID[row.id] || {}).name || '渴血之剑',
        uses: row.uses, consumed: s ? s.consumed : 0, evolved: s ? s.evolved : null };
    }
    const cand = got.list.find((c) => c.ref === String(ref));
    if (!cand) return { ok: false, msg: '这件祭品已经不在手里了。' };
    const used = consumeBladeOffering(run, cand);
    if (!used) return { ok: false, msg: '献祭失败，请重试。' };
    row.stacks = Math.min(D().BLADE.maxStacks, Math.max(1, Math.floor(Number(row.stacks) || 1) + 1));
    delete run.bladeSacrificePending;
    logBuff(run, row.id, 'stack', { stacks: row.stacks,
      detail: '献祭《' + cand.name + '》' + (used.kind === 'inscription' ? '（铭文）' : '') + ' · 成长 ×' + row.stacks });
    save();
    return { ok: true, name: cand.name, used: used, stacks: row.stacks,
      blade: (D().BUFF_BY_ID[row.id] || {}).name || '渴血之剑' };
  }

  function bladeEventDue(run) {
    const row = bladeRowOf(run);
    if (!row || row.id === D().BLADE.finalId || row.id === D().BLADE.deadId) return false;
    if (!D().bladeEventLayer(run.layer)) return false;
    return Math.floor(Number(run.bladeEventDone) || 0) !== run.layer;
  }
  function maybeQueueBladeEvent(run) {
    if (!run || !bladeEventDue(run)) return false;
    run.bladeEventPending = { layer: run.layer, id: 'bladeEvent' };
    save();
    return true;
  }

  function resolveBladeEvent(choice) {
    const run = endless().run;
    if (!run || !run.bladeEventPending) return { ok: false, msg: '现在没有需要处理的剑之活性。' };
    const row = bladeRowOf(run);
    if (!row) { delete run.bladeEventPending; save(); return { ok: false, msg: '当前没有渴血之剑。' }; }
    const cfg = D().BLADE;
    const out = { ok: true, choice: choice };
    if (choice === 'suppress') {
      row.suppressStreak = Math.min(3, Math.max(0, Math.floor(Number(row.suppressStreak) || 0)) + 1);
      out.streak = row.suppressStreak;
      if (row.suppressStreak >= 3) {
        row.id = cfg.deadId;
        row.uses = -1;
        row.on = true;
        row.forced = false;
        row.suppressStreak = 0;
        out.dead = true;
        queueRunStory(run, 'bladeDead');
        run.pendingToasts = (run.pendingToasts || []).concat(['渴血之剑彻底失活，化为「涸血之剑」']).slice(-12);
        logBuff(run, cfg.deadId, 'get', { detail: '连续抑制 3 次 · 彻底失活' });
      } else {
        run.pendingToasts = (run.pendingToasts || []).concat(['你压制了剑的活性（' + row.suppressStreak + '/3）']).slice(-12);
      }
    } else if (choice === 'enhance') {
      row.suppressStreak = 0;
      if (row.uses > 0) row.uses = Math.max(0, row.uses - cfg.enhanceUses);
      if (!(row.uses > 0) && row.id !== cfg.finalId) {
        const next = D().bladeNextId(row.id);
        if (next) {
          const nextDef = D().BUFF_BY_ID[next] || {};
          row.id = next;
          row.uses = Number(nextDef.uses) < 0 ? -1 : Math.max(1, Number(nextDef.uses) || 1);
          out.evolved = { id: next, name: nextDef.name || next };
          run.pendingToasts = (run.pendingToasts || []).concat(['剑的活性大增，进化为「' + (nextDef.name || next) + '」']).slice(-12);
        }
      } else {
        run.pendingToasts = (run.pendingToasts || []).concat(['你增强了剑的活性（使用次数 −' + cfg.enhanceUses + '）']).slice(-12);
      }
      out.uses = row.uses;
    } else return { ok: false, msg: '只能选择抑制或增强。' };
    run.bladeEventDone = run.layer;
    delete run.bladeEventPending;
    logBuff(run, row.id, 'stack', { stacks: row.stacks || 1, detail: '活性事件：' + (choice === 'suppress' ? '抑制' : '增强') });
    save();
    return out;
  }

  function bladePendingOf(runArg) {
    const run = runArg || endless().run;
    if (!run) return null;
    if (run.bladeSacrificePending) return 'sacrifice';
    if (run.bladeEventPending) return 'event';
    return null;
  }

  function setHeroAppearance(appearance) {
    const e = endless();
    if (!isHeroRun(e.run)) return { ok: false, msg: '当前不是勇者模式。' };
    const clean = TowerHero.normalize(Object.assign({}, e.run.hero, { appearance: appearance }));
    if (!clean) return { ok: false, msg: '外观数据无效。' };
    e.run.hero.appearance = clean.appearance;
    save();
    return { ok: true, appearance: clean.appearance.map((g) => Object.assign({}, g)) };
  }
  // 勇者专属即时货品的落地。`opts.heroChoice` 是界面在购买前收集的自选目标：
  // 旧调用（调试 / 无界面）不传 choice 时仍退回随机目标，保证 API 不空转。
  function applyHeroGoods(run, buff, opts) {
    if (!isHeroRun(run)) return { ok: false, msg: '仅勇者模式可使用。' };
    const m = buff.mods || {}, choice = (opts && opts.heroChoice) || {};
    let out;
    if (m.heroTraining) out = heroTraining(run, m.heroTraining || 1, false);
    else if (m.heroLevelUp) {
      const levels = Math.max(1, Math.min(15, Math.floor(Number(m.heroLevelUp) || 5)));
      const pool = heroOwned(run).filter(it => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)));
      const chosen = choice.ref && pool.find(it => it.ref === String(choice.ref));
      if (chosen) out = TowerHero.addLevels(run.hero, chosen.ref, levels);
      else if (pool.length) out = TowerHero.addLevels(run.hero, pool[Math.floor(Math.random() * pool.length)].ref, levels);
      else out = { ok: false, msg: '没有可升级的武技。' };
    } else if (m.heroGuaranteed) out = heroTraining(run, 1, true);
    else if (m.heroSecret) out = TowerHero.learn(run.hero, { special: true, level: 5, uncapped: true });
    else if (m.heroReplace) {
      const pool = heroOwned(run);
      const forget = choice.forgetRef && pool.find(it => it.ref === String(choice.forgetRef));
      if (forget) {
        out = choice.learnRef ? TowerHero.replace(run.hero, forget.ref, { learnRef: choice.learnRef })
          : TowerHero.replace(run.hero, forget.ref);
      } else if (pool.length) {
        out = TowerHero.replace(run.hero, pool[Math.floor(Math.random() * pool.length)].ref);
      } else out = { ok: false, msg: '没有可替换的武技。' };
    } else return { ok: false, msg: '这份勇者物品不能直接使用。' };
    if (out.ok) noteHero(run, buff.name + '：' + out.msg);
    return out;
  }
  // 勇者授业：第一次自然触发铸币商店时，用 mentor 事件替换这次铸币商店。
  // 返回 true 表示已消费这次自然刷出，调用方不要再 openMintShop。
  function heroMentorReplacesMint(run, layer) {
    if (!isHeroRun(run) || !run.hero) return false;
    const seen = run.hero.events || {};
    if (run.heroMentorMintDone === true || seen.mentor) return false;
    run.heroMentorMintDone = true;
    run.heroMentorPending = true;

    run.mintGroup = D().mintGroupOf(layer);
    return true;
  }
  function heroEventFor(run) {
    if (!isHeroRun(run) || run.attempt) return null;
    const h = run.hero, seen = h.events || {}, wins = Number(h.wins) || 0;
    const scene = (id, title, lines, choices) => seen[id] ? null : { id, title,
      lines: lines.slice(), text: lines.join(''),
      choices: choices.map(c => ({ id: id + ':' + c[0], label: c[1], desc: c[2], effect: c[0] })) };

    if (run.heroMentorPending === true) {
      const event = scene('mentor', '阶前的盲眼师',
        ['石阶尽头坐着一位蒙眼老人，膝上横着三枚磨钝的棋子。',
         '他不看你的脸，只把棋子排成三条路。',
         '「勇者，旧路走深，还是把新路带上塔？」'],
        [['training', '复盘旧招', '随机升级4次武技；每次从可升级武技中随机。'],
          ['learn', '记下陌生一招', '随机学会一个5级武技；遵守普通24项上限。']]);
      if (event) return event;
    }
    if (wins >= 25) {
      const event = scene('campfire', '倒燃的营火',
        ['石阶中央有一堆倒着燃烧的营火：火苗向下，灰烬向上。',
         '火边的砖上刻着一行被烟熏黑的小字：',
         '「勇者不是不会倒下，是倒下后还记得自己为什么站起来。」',
         '你把手伸进火里，影子却没有跟着动。'],
        [['regen5', '借火重整气息', '接下来10次战斗，每回合开始回复5%生命上限。'],
          ['mint', '带走火中的铸币', '获得1枚铸币。']]);
      if (event) return event;
    }
    if (run.layer >= 41) {
      const event = scene('reflection', '巡镜者',
        ['一具与你等高的镜甲挡在阶前。',
         '它没有脸，胸口却映着你的每一次胜利。',
         '镜甲抬起手，先你一步摆出了你惯用的起手式。',
         '「我记住的不是你的招式，是你以为自己不会输的那一瞬。」'],
        [['coins', '记住破绽，暂避其锋', '获得180试炼币；用运营迎接下一次照影。']]);
      if (event) return event;
    }
    if (run.layer >= 80) {
      const event = scene('last-lesson', '钟声之前',
        ['第80层的钟声第一次传到脚边。',
         '老武师留下的最后一页没有招式，只有一行被水浸开的墨：',
         '「你无需掌握世间一切，也能决定自己如何挥剑。」',
         '钟声第二次响起时，你听见自己的呼吸与它重叠。'],
        [['maximize', '把这一式练到极处', '自选一个武技，直接升到真5满级。'],
          ['coins', '为最后的补给留余地', '获得300试炼币。']]);
      if (event) return event;
    }
    if (run.layer > 100) return scene('cycle-' + Math.floor((run.layer - 1) / 100), '镜外的新雪',
      ['你发现自己已经能听见镜外落雪的声音。',
       '旧日补给不再相随，可剑上的裂痕记得每一次巡逻。',
       '重新收集，重新选择——登塔的不是旧日的你，而是仍愿出发的勇者。'],
      [['regen10', '以新一轮旅途为名', '接下来10次战斗，每回合开始回复10%生命上限。']]);
    return null;
  }
  function resolveHeroEvent(choiceId, opts) {
    const run = endless().run, event = heroEventFor(run), choiceOpts = opts || {};
    const choice = event && event.choices.find(c => c.id === choiceId);
    if (!choice) return { ok: false, msg: '这个勇者事件已结束或选项已失效。' };
    let out = { ok: true, msg: '你记住了这一段旅途。' };
    if (choice.effect === 'sword') {
      const row = grantBlade(run);
      out.msg = row ? '获得「渴血之剑」：已放入限次增益，第一次巡视胜利的固定奖励。' : '你已持有渴血之剑。';
    } else if (choice.effect === 'coins') {
      const amount = event.id === 'last-lesson' ? 300 : 180;
      run.coins += amount; noteRunIncome(run, 'trialCoinsEarned', amount); out.msg = '获得' + amount + '试炼币。';
    } else if (choice.effect === 'mint') {
      run.retryToken += 1; noteRunIncome(run, 'mintEarned', 1); out.msg = '获得1枚铸币。';
    } else if (choice.effect === 'regen5' || choice.effect === 'regen10') {
      const pct = choice.effect === 'regen10' ? 0.10 : 0.05;
      grantEventRegen(run, event.id, pct, 10);
      out.msg = '接下来10次战斗，每回合开始回复' + Math.round(pct * 100) + '%生命上限。';
    } else if (choice.effect === 'maximize') {
      const pool = heroOwned(run).filter(it => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)));
      const want = choiceOpts.heroChoice && choiceOpts.heroChoice.ref;
      const chosen = want && pool.find(it => it.ref === String(want));
      const target = chosen || pool[Math.floor(Math.random() * pool.length)];
      out = target ? TowerHero.maxOut(run.hero, target.ref) : { ok: false, msg: '没有可升级的武技。' };
    } else if (choice.effect === 'heal') { healAbs(run, 0.5, currentMaxHp(run)); out.msg = '已回复50%生命上限。'; }
    else if (choice.effect === 'training') {
      out = event.id === 'mentor' ? heroTrainingSpread(run, 4) : heroTraining(run, 1, true);
    }
    else if (choice.effect === 'learn') out = TowerHero.learn(run.hero);
    if (event.id === 'mentor') { run.heroMentorPending = false; run.heroMentorMintDone = true; }
    run.hero.events = Object.assign({}, run.hero.events, { [event.id]: true });
    noteHero(run, event.title + '：' + out.msg); save();
    return Object.assign({}, out, { ok: true, eventId: event.id });
  }

  function layerStartHeal(run, mode) {
    const ref = Math.max(1, Number(run.lastMaxHp) || 0);
    if (mode === 'endless') healAbs(run, D().ENDLESS_LAYER_HEAL_PCT, ref);
  }



  // 深拷贝一份对局状态（优先用 structuredClone，退回 JSON —— 用 Object.assign 会被 __proto__ 坑到）。
  function cloneRun(run) {
    if (typeof structuredClone === 'function') { try { return structuredClone(run); } catch (e) {  } }
    return JSON.parse(JSON.stringify(run));
  }
  function snapshotBattle(run) {
    if (!run || run.mode !== 'endless') return null;
    const snap = cloneRun(run);
    delete snap.retrySnap;
    delete snap.attempt;          // 令牌不能带回来，否则回滚后就「这场还没结束」了
    run.retrySnap = snap;
    return snap;
  }

  function nextBattle(mode, previewRun) {
    // 镜面只读构建：调用方提供独立克隆，不替换存档对局，也不建立战斗/成就/回滚记录。
    const run = previewRun || (mode === 'tower' ? tower().run : endless().run);
    if (!run) return { ok: false, msg: '没有进行中的挑战。' };
    if (!previewRun && heroEventFor(run)) return { ok: false, msg: '请先完成勇者事件。' };
    if (run.attempt) return { ok: false, msg: '这场战斗尚未结束。' };

    if (run.pendingRetry) return { ok: false, msg: '请先处理上一场失利：重新挑战或放弃本局。' };
    // 渴血之剑的必选处理（献祭 / 活性事件）同样必须先做掉，不能靠退出重进绕过。
    if (run.bladeSacrificePending) return { ok: false, msg: '请先完成渴血之剑的献祭。' };
    if (run.bladeEventPending) return { ok: false, msg: '请先处理渴血之剑的活性事件。' };
    if (run.choices) return { ok: false, msg: '请先完成场间选择。' };
    if (run.phase) return { ok: false, msg: '请先完成商店与结算。' };
    const entry = run.plan[run.idx];
    const isLastBattle = run.idx === run.plan.length - 1;

    if (mode === 'endless' && !previewRun) autoPlayStory(run);
    const built = buildFoe(mode, run.layer, entry, run.salt, isLastBattle);
    // 1~5 层早段修正（2026-10-29 勇者 10%；2026-11-09 两种无尽剧本通用再降 5%）：
    // 放在 buildFoe 之后、所有敌方削弱（E07/E11 / 威慑）之前，乘区顺序不影响结果。
    const earlyLayer = Math.max(1, Math.floor(Number(run.layer) || 1));
    if (isHeroRun(run) && earlyLayer <= HERO_EARLY_FOE_LAST_LAYER) {
      const foe = built.foe;
      for (const key of ['power', 'agility', 'speed', 'hp']) {
        foe[key] = Math.max(1, Math.round((Number(foe[key]) || 1) * HERO_EARLY_FOE_MUL));
      }
    }
    if (mode === 'endless' && earlyLayer <= ENDLESS_EARLY_FOE_LAST_LAYER) {
      const foe = built.foe;
      for (const key of ['power', 'agility', 'speed', 'hp']) {
        foe[key] = Math.max(1, Math.round((Number(foe[key]) || 1) * ENDLESS_EARLY_FOE_MUL));
      }
    }
    const foeCtx = { hero: entry.kind === 'hero', poolNpc: built.poolNpc, elite: built.elite };
    const agg = aggregate(run, foeCtx);

    if (!previewRun) checkStatAchievements(run, agg);
    // M01 威慑（本场 buff 的聚合值）+ 即时削弱 E11「挫锋」（记录在 run.enemyPowerDown 上）：
    // 两者相加后一起压敌人力量，上限 80%（别把敌人打成 0 攻击）。
    const foePowerDown = Math.max(0, Math.min(0.8,
      Math.max(0, Number(run.enemyPowerDown) || 0) + Math.max(0, Number(agg.enemyPowerDown) || 0)));
    if (foePowerDown > 0) built.foe.power = Math.max(1, Math.round(built.foe.power * (1 - foePowerDown)));
    const foeHpDown = Math.max(0, Math.min(ENEMY_MAXHP_DOWN_CAP, Number(run.enemyMaxHpDown) || 0));
    if (foeHpDown > 0) built.foe.hp = Math.max(1, Math.round(built.foe.hp * (1 - foeHpDown)));
    const maxHpMul = agg.maxHpMul, powerMul = agg.powerMul;

    const mirrorFrame = {};
    const adjustMe = (me) => {
      const external = { power: me.power, agility: me.agility, speed: me.speed, maxHp: me.maxHp };
      // 联机版：塔内事件临时授予、账号没学的技能，只在本局战斗体里补一份；
      // 不写 State.skills（那是服务端权威存档）。
      if (ONLINE && !isHeroRun(run) && Array.isArray(run.grantedSkills) && run.grantedSkills.length) {
        me.skills = Array.isArray(me.skills) ? me.skills.slice() : [];
        for (const raw of run.grantedSkills) {
          const sid = Number(String(raw).split(':')[0]);
          if (!(sid > 0)) continue;
          const has = me.skills.some((s2) => Number(s2 && typeof s2 === 'object' ? s2.id : String(s2).split(':')[0]) === sid);
          if (!has) me.skills.push({ id: sid, level: 1 });
        }
      }
      run.baseMaxHp = Math.max(1, Number(me.maxHp) || 0);
      applyMirrorStats(run, me);
      const inherited = mirrorStatsOf(run);
      const frame = mirrorFrame.stats = {};
      for (const key of MIRROR_STAT_KEYS) frame[key] = Object.assign({}, inherited[key]);
      mirrorFrame.external = external;
// 本层削弱（三侠大招留下的）：生命上限 / 属性 / 锁武技
      const debuffs = Array.isArray(run.debuffs) ? run.debuffs : [];
      const dMaxHp = debuffs.filter((d) => d.kind === 'maxHp').reduce((a, d) => a * (1 - (Number(d.pct) || 0)), 1);
      const dPower = debuffs.filter((d) => d.kind === 'stat' && d.stat === 'power').reduce((a, d) => a * (1 - (Number(d.pct) || 0)), 1);
      const dAgi = debuffs.filter((d) => d.kind === 'stat' && d.stat === 'agility').reduce((a, d) => a * (1 - (Number(d.pct) || 0)), 1);
      const dSpd = debuffs.filter((d) => d.kind === 'stat' && d.stat === 'speed').reduce((a, d) => a * (1 - (Number(d.pct) || 0)), 1);
      const stickyHp = Math.max(0, Number(run.hpBonus) || 0);
      const winMaxHp = Math.max(0, Number(run.winMaxHp) || 0);
      const spendHp = run.spendGain ? Math.max(0, Number(run.spendGain.hp) || 0) : 0;
      // 「空血上限」（emptyMaxHpMul）
      // 而「当前最大生命」是这一场算出来的上限（会随层数、成长、其它增益变化），
      // 所以每条「空血上限 +E」定义成「把空出来的那份放大 (1+E) 倍」——
      const emptyPct = Math.max(0, Number(agg.emptyMaxHpMul) || 0);
      const flatHp = Math.max(0, Number(run.winHpFlat) || 0) + spendHp + Math.max(0, Number(agg.startMaxHpFlat) || 0);
      const baseMaxHp = Math.max(1, Math.round(me.maxHp * (1 + maxHpMul + stickyHp + winMaxHp) * dMaxHp) + flatHp);
      const emptyPart = Math.max(0, Math.round(baseMaxHp * emptyPct));
      const maxHp = baseMaxHp + emptyPart;

      const wBoost = run.weaponBoost || {};
      let weaponMul = 1;
      for (const key of Object.keys(wBoost)) {
        const inst = runWeapons(run).find((w) => Number(w.id) === Number(key));
        if (inst) weaponMul = Math.max(weaponMul, 1 + Number(wBoost[key] || 0));
      }
      const sBoost = run.skillBoost || {};

      const cosmosFirst = Number(sBoost[PICKABLE_COSMOS] || 0) > 0 ? 1 : 0;
      // 秘技通神（C33）的技能加成走独立通道 `me.skillBoost`（技能id → 比例）。
      // 绝对防御/龟甲术由 sim 的 passiveSkillBoost 读同一字段。
      const sb = {};
      for (const key of Object.keys(sBoost)) {
        if (Number(key) === PICKABLE_COSMOS) continue;
        const v = Number(sBoost[key]) || 0;
        if (v > 0) sb[Number(key)] = v;
      }
      if (Object.keys(sb).length) me.skillBoost = Object.assign({}, me.skillBoost, sb);

      applyEnvToFoe(run, built.foe);
      me.power = Math.max(1, Math.round(me.power * (1 + powerMul) * dPower * weaponMul));
      me.agility = Math.max(1, Math.round(me.agility * dAgi * (1 + agg.agilityMul)));
      me.speed = Math.max(1, Math.round(me.speed * dSpd * (1 + agg.speedMul)));
      if (run.spendGain) {
        for (const k of ['power', 'agility', 'speed']) me[k] += Math.max(0, Number(run.spendGain[k]) || 0);
      }

      me.power += Math.max(0, Number(run.winStatPower) || 0);
      me.agility += Math.max(0, Number(run.winStatAgility) || 0);
      me.speed += Math.max(0, Number(run.winStatSpeed) || 0);

      const startFlatStat = Math.max(0, Number(agg.startStatFlat) || 0);
      if (startFlatStat) { me.power += startFlatStat; me.agility += startFlatStat; me.speed += startFlatStat; }
      for (const d of debuffs) {
        if (d.kind !== 'lock') continue;
        if (d.what === 'weapon') me.weapons = (me.weapons || []).filter((w) => Number(w.id) !== Number(d.id));
        // me.skills 是 {id, level} 对象数组（main.js 的 mySkills().map(...)），
        // 于是「锁技能」永远删不掉（只有武器锁生效）。这里把对象与旧的 "id:lv" 字符串都兼容。
        else me.skills = (me.skills || []).filter((s2) => {
          const sid = Number(s2 && typeof s2 === 'object' ? s2.id : String(s2).split(':')[0]);
          return sid !== Number(d.id);
        });
      }
      const beforeEnvSpeed = me.speed;
      applyEnvToMe(run, me);
      const envSpeedMul = me.speed / Math.max(1, beforeEnvSpeed);
      const envModsMine = Object.assign({}, me.mods || {});
      // 终乘烙印（C49「终焉烙印」）：所有加算 / 成长都算完之后再乘一遍。
      // 力/敏/速/生命上限 ×(1 + 0.25×存在层 + 0.5×损毁层)
      // 注意 maxHp 与当前血量一起放大，保持「当前血量占上限的比例」不变。

      const healBonus = fragileHealBonus(run);
      const finalMul = fragileFinalMul(run);
      const scaledMaxHp = finalMul === 1 ? maxHp : Math.max(1, Math.round(maxHp * finalMul));
      if (finalMul !== 1) {
        me.power = Math.max(1, Math.round(me.power * finalMul));
        me.agility = Math.max(1, Math.round(me.agility * finalMul));
        me.speed = Math.max(1, Math.round(me.speed * finalMul));
        me.hp = Math.max(1, Math.min(scaledMaxHp, Math.round(me.hp * finalMul)));
      } else {
        me.hp = Math.max(1, Math.min(scaledMaxHp, me.hp));
      }

// maxHpMul 的「回复等量生命」= 按比例继承到新上限（正增益不亏比例、负增益同步缩血）
      me.maxHp = scaledMaxHp;
      const initHp = Math.max(1, Math.min(baseMaxHp, hpAbsOf(run, baseMaxHp)));
      me.hp = Math.max(1, Math.min(maxHp, initHp));
      if (!(Number(run.hpAbs) > 0)) run.hpAbs = me.hp;
      // 「开战回血」类（补给 N08 / 战斗续航 C16·C17）：本场第一回合回复 X% 最大生命。
      // 「最大生命」用本场算出的 me.maxHp 作基准（含局内上限加成、固定值成长与空血上限）。
      // 位置很关键：必须放在「按 baseMaxHp 裁进场血」之后，否则回血会被再裁一次、
      // 枯泉·涸井（trialDry）「封死对手的一切治疗」：开战回血也要封。
      // 这段发生在战斗准备阶段，早于 sim 把 def.healMul 归零，所以必须在这里拦一道 ——
      // 否则 C04/C16/C17 的开战回血会绕过封疗（用户报「枯泉没生效」的主因之一）。
      const foeSealsHeal = !!(D().mechSealsHeal && D().mechSealsHeal(built && built.foe && built.foe.mech));
      if (agg.startHealPct > 0 && me.maxHp > 0 && !foeSealsHeal) {
        const beforeHeal = me.hp;

        const gain = Math.max(1, Math.round(me.maxHp * agg.startHealPct));
        me.hp = Math.min(me.maxHp, me.hp + gain);
        run.hpAbs = me.hp;
        agg.startHealGain = me.hp - beforeHeal;      // 实际回血量（可能被本场上限截断）
        agg.startHealRef = me.maxHp;
      }

      run.lastMaxHp = scaledMaxHp;
      run.lastHp = Math.min(me.hp, scaledMaxHp);
      // 记下本场真正的上限，供「非战斗期间」的绝对回血与裁血使用
      // （尤其是第一场：那时还没有任何历史血量，必须以本场上限为基准）。
      run.refMaxHp = maxHp;
      const mods = {};
      if (agg.critBonus) mods.critBonus = agg.critBonus;
      if (agg.critDmgBonus) mods.critDmgBonus = agg.critDmgBonus;
      if (agg.dodgeBonus) mods.dodgeBonus = agg.dodgeBonus;
      if (agg.takenMul) mods.takenMul = agg.takenMul;
      // 挑战塔专属字段必须显式带过去（mods 是逐字段挑的，漏一个 buff 就静默失效）。
      if (agg.openerPowerMul) mods.openerPowerMul = agg.openerPowerMul;
      if (agg.fatiguePowerMul) mods.fatiguePowerMul = agg.fatiguePowerMul;
      if (agg.openerRounds) mods.openerRounds = agg.openerRounds;
      if (agg.dodgeMul) mods.dodgeMul = agg.dodgeMul;
      if (agg.regenPct) mods.regenPct = agg.regenPct;
      if (agg.lifestealPct) mods.lifestealPct = agg.lifestealPct;
      if (agg.shellPct) mods.shellPct = agg.shellPct;
      if (agg.openStrikePct) mods.openStrikePct = agg.openStrikePct;
      if (agg.mustHitFirst) mods.mustHitFirst = 1;
      if (agg.firstSkillFree) mods.firstSkillFree = 1;

      if (cosmosFirst) mods.cosmosFirst = 1;
      if (agg.dmgMul !== 1) mods.dmgMul = agg.dmgMul;
      if (agg.thornsPct) mods.thornsPct = Math.min(0.6, agg.thornsPct);
      if (agg.mustHitAll) mods.mustHitAll = 1;
      if (agg.firstHitZero) mods.firstHitZero = 1;
      if (agg.firstHitZeroName) mods.firstHitZeroName = agg.firstHitZeroName;
      if (agg.firstHitZeroFreeTurn) mods.firstHitZeroFreeTurn = 1;

      const grownTaken = winTakenMulOf(run);
      if (grownTaken > 0) mods.takenMul = combineTakenMul(mods.takenMul, -Math.min(agg.winTakenMulCap || grownTaken, grownTaken));
      if (agg.reflectImmune) mods.reflectImmune = agg.reflectImmune;
      // 治疗烙印：sim 的 healOf() 读的是 fighter 顶层的 healMul（不是 me.mods 里的字段），
      // 所以这里要把面板字段一起写上。
      if (healBonus > 0) me.healMul = 1 + healBonus;
      if (agg.emptyMaxHpMul) mods.emptyMaxHpMul = agg.emptyMaxHpMul;
      // 回合开始类（越战越勇 / 后发制人 / 玉石俱焚 / 风影身法）—— sim 侧按这些字段结算。
      if (agg.roundStatPct) mods.roundStatPct = agg.roundStatPct;
      if (agg.catchUpPct) mods.catchUpPct = agg.catchUpPct;
      if (agg.roundMaxHpMul > 0 && agg.roundMaxHpMul < 1) mods.roundMaxHpMul = agg.roundMaxHpMul;
      if (agg.firstDodge) mods.firstDodge = agg.firstDodge;
      if (agg.firstDodgeFreeTurn) mods.firstDodgeFreeTurn = 1;

      if (agg.enemyHpDrainPct) {
        mods.enemyHpDrainPct = Math.min(1, Math.max(0, Number(agg.enemyHpDrainPct) || 0));
        mods.enemyHpDrainNote = '血蚀印记';
      }

      if (agg.openKill) mods.openKill = 1;

      if (agg.weaponFreeUses) mods.weaponFreeUses = agg.weaponFreeUses;
      if (agg.weaponBoostUses) {
        mods.weaponBoostUses = agg.weaponBoostUses;
        mods.weaponBoostPowerMul = agg.weaponBoostPowerMul || 0;
        mods.weaponBoostMustHit = agg.weaponBoostMustHit || 0;
        mods.weaponBoostReflectImmune = agg.weaponBoostReflectImmune || 0;
        mods.weaponBoostFatigueMul = agg.weaponBoostFatigueMul || 0;
      }
      if (agg.lowHpPowerMul || agg.lowHpAgilityMul || agg.lowHpSpeedMul || agg.lowHpFinalMul ||
          agg.lowHpTakenMul || agg.lowHpLifestealPct || agg.lowHpRegenPct) {
        if (agg.lowHpPowerMul) mods.lowHpPowerMul = agg.lowHpPowerMul;
        if (agg.lowHpFinalMul) mods.lowHpFinalMul = agg.lowHpFinalMul;
        if (agg.lowHpAgilityMul) mods.lowHpAgilityMul = agg.lowHpAgilityMul;
        if (agg.lowHpSpeedMul) mods.lowHpSpeedMul = agg.lowHpSpeedMul;
        if (agg.lowHpTakenMul) mods.lowHpTakenMul = Math.max(-0.9, agg.lowHpTakenMul);
        if (agg.lowHpLifestealPct) mods.lowHpLifestealPct = agg.lowHpLifestealPct;
        if (agg.lowHpRegenPct) { mods.lowHpRegenPct = agg.lowHpRegenPct; mods.lowHpRegenAt = agg.lowHpRegenAt || 0.5; }

        mods.lowHpAt = agg.lowHpAt || agg.lowHpRegenAt || 0.5;
      }

      if (agg.revivePct) {
        const rev = reviveInfoOf(run);
        const left = rev ? rev.left : Math.max(1, Math.floor(agg.reviveMax || 1));
        for (let i = 0; i < left; i++) {
          mods.deathSaves = (mods.deathSaves || []).concat([{ healPct: agg.revivePct, statMul: agg.reviveStatMul || 0, revive: 1 }]);
        }
      }
      if (agg.deathSaves.length) mods.deathSaves = (mods.deathSaves || []).concat(agg.deathSaves);
      for (const [k, v] of Object.entries(envModsMine || {})) {
        if (!v) continue;
        if (k === 'takenMul' || k === 'lowHpTakenMul') mods[k] = combineTakenMul(mods[k], v);
        else mods[k] = (Number(mods[k]) || 0) + v;
      }
      me.mods = mods;
      applyMirrorCombat(run, me);

      const factors = { power: (1 + powerMul) * dPower * weaponMul * finalMul,
        agility: dAgi * (1 + agg.agilityMul) * finalMul,
        speed: dSpd * (1 + agg.speedMul) * envSpeedMul * finalMul,
        maxHp: (1 + maxHpMul + stickyHp + winMaxHp) * dMaxHp * (1 + emptyPct) * finalMul };
      for (const key of MIRROR_STAT_KEYS) {
        frame[key].mul *= factors[key];
        frame[key].flat = Number(me[key]) - Number(external[key]) * frame[key].mul;
      }
      // x0 层那一场（entry.x00，即「觐见魔王」）额外吃「玩家此前上交过的增益」的快照加成
      if (built.foe && built.foe.patrol) {
        const foe = built.foe;
        foe.power = Math.max(1, Math.round(Number(me.power) || 1));
        foe.agility = Math.max(1, Math.round(Number(me.agility) || 1));
        foe.speed = Math.max(1, Math.round(Number(me.speed) || 1));
        foe.hp = Math.max(1, Math.round(Number(me.hp) || 1));
        foe.maxHp = Math.max(1, Math.round(Number(me.maxHp) || foe.hp));
        if (me.baseStats) foe.baseStats = Object.assign({}, me.baseStats);
        if (me.effects) foe.effects = Object.assign({}, me.effects);
        foe.masterLevel = Math.max(0, Number(me.masterLevel) || 0);

        delete foe.mods;
        delete foe.healMul;
        delete foe.skillBoost;

        foe.copiedFromPlayer = { power: foe.power, agility: foe.agility,
          speed: foe.speed, hp: foe.hp, maxHp: foe.maxHp };
        if (entry.x00) {
          applyPatrolTollToFoe(run, foe);

          applyDemonLordLives(foe);
        } else {
          // 寻常「巡视」层的魔王也加强为两条命：第二条命只回 75% 生命上限；
          // 不吃 x00 的 +20% 上限 / 减伤，也不吃破碎终焉烙印。
          const P = D().PATROL || {};
          applyDemonLordLives(foe, { lives: Number(P.patrolLives) || 1,
            healPct: P.patrolLifeHealPct == null ? 0.75 : P.patrolLifeHealPct,
            maxHpMul: 0, takenMul: 0, brands: 0, perBrand: 0 });
        }

        const blade = heroBladeOf(run);
        if (blade && blade.final && blade.on && (blade.powerCut > 0 || blade.hpCut > 0)) {
          foe.power = Math.max(1, Math.round(foe.power * (1 - blade.powerCut)));
          foe.maxHp = Math.max(1, Math.round(foe.maxHp * (1 - blade.hpCut)));
          foe.hp = Math.min(foe.maxHp, Math.max(1, Math.round(foe.hp * (1 - blade.hpCut))));
          foe.heroCounter = '王者之剑·断镜 ×' + blade.stacks;
        }
      }
    };
    if (previewRun) return { ok: true, foe: built.foe, adjustMe, mirrorFrame };
    const fighter = isHeroRun(run) ? TowerHero.fighter(run.hero) : null;
    // 这一场战斗的掉落种子：有就沿用（退出重进 / 铸币回滚同一场），没有才新开一份。
    // 它写在 `snapshotBattle` 之前，所以随快照一起回滚；reportBattle 抽完即清。
    if (mode === 'endless' && run.battleChoiceSeed == null) {
      run.battleSerial = Math.max(0, Math.floor(Number(run.battleSerial) || 0)) + 1;

      run.battleChoiceSeed = (hashSeedText(['battle', run.salt, run.layer, run.idx,
        run.battleSerial].join('|')) % 0xFFFFFFFE) + 1;
    }
    run.attempt = mode + '_' + Date.now() + '_' + (++attemptSeq);
    snapshotBattle(run);
    if (fighter) adjustMe(fighter);
    save();
    const toasts = takeAchievementToasts(run);
    return { ok: true, token: run.attempt, entry, info: entryInfo(entry, run.layer, isLastBattle), foe: built.foe,
      elite: built.elite, region: regionOf(entry), hpRatio: fighter ? 1 : run.carry, fighter, adjustMe,
      effMaxHp: () => Math.max(1, Number(run.lastMaxHp) || Math.max(1, Number(built.foe && built.foe.hp) || 1)),
      debuffs: (run.debuffs || []).slice(), achievements: toasts,
      battleNo: run.idx + 1, battleCount: run.plan.length, layer: run.layer };
  }

  function skipPlaybackAllowed(mode, layer) {
    if (mode !== 'endless') return false;
    const from = Math.max(1, Math.floor(Number(D().ENDLESS_SKIP_LAYER) || 10));
    return Math.max(1, Math.floor(Number(layer) || 1)) >= from;
  }

  // 手上有没有铸币（以及有没有可用的快照）。
  function canRetry(run) {
    return !!(run && run.mode === 'endless' && Number(run.retryToken) > 0 && run.retrySnap);
  }
  function retryBattle() {
    const e = endless(), run = e.run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    if (!(Number(run.retryToken) > 0)) return { ok: false, msg: '没有铸币（可在试炼商店购买）。' };
    if (!run.retrySnap) return { ok: false, msg: '没有可回滚的战斗记录。' };
    const snap = cloneRun(run.retrySnap);
    snap.retryToken = Number(run.retryToken) - 1;
    snap.retrySnap = null;                           // 回滚后旧快照作废，下一场会重新拍
    delete snap.attempt;
    delete snap.pendingRetry;
    e.run = snap;
    save();
    return { ok: true, layer: snap.layer, left: snap.retryToken };
  }

  function interruptBattle(mode, token) {
    const run = mode === 'tower' ? tower().run : endless().run;
    if (!run || run.attempt !== token) return false;
    delete run.attempt;
    save();
    return true;
  }





  const HERO_SOURCE = Object.freeze({
    tl: { hero: '螳螂大侠', short: '螳螂', color: '#2f7a52' },
    xh: { hero: '仙鹤大侠', short: '仙鹤', color: '#2f5f9e' },
    xm: { hero: '熊猫大侠', short: '熊猫', color: '#8a5a20' },
  });

  function ultHitsOf(result, def) {
    if (!result || !Array.isArray(result.rounds) || !def) return 0;
    let n = 0;
    for (const r of result.rounds) {
      if (!r || r.ultName !== def.ult) continue;
      if (r.dodge || r.jueDui || r.reboundHurt || r.fakeDie) continue;
      if (!(Number(r.dmg) > 0)) continue;
      n++;
    }
    return n;
  }
  // 三侠大招留下的「本层削弱」：按实际命中次数逐次累加，数值随机浮动并各有本层上限。
  // · 螳螂「重伤」：每次 −pctRange 的生命上限，本层累计最多 −capPct（多层相乘后不超过这个总量）；
  function applyHeroDebuff(run, entry, result) {
    if (!entry || entry.kind !== 'hero') return null;
    const def = D().HERO_DEBUFF[entry.anim];
    if (!def) return null;
    const hits = ultHitsOf(result, def);
    if (hits <= 0) return null;
    if (!Array.isArray(run.debuffs)) run.debuffs = [];
    const src = HERO_SOURCE[entry.anim] || { hero: '大侠', short: '大侠', color: '#7a4a18' };
    const layer = Math.max(1, Math.floor(Number(run.layer) || 1));
    const mine = run.debuffs.filter((d) => d && d.from === entry.anim);
    const range = Array.isArray(def.pctRange) && def.pctRange.length === 2
      ? [Math.max(0, Number(def.pctRange[0]) || 0), Math.max(0, Number(def.pctRange[1]) || 0)]
      : [Math.max(0, Number(def.pct) || 0), Math.max(0, Number(def.pct) || 0)];
    const rollPct = () => range[0] + Math.random() * Math.max(0, range[1] - range[0]);
    const maxTimes = Math.max(1, Math.floor(Number(def.maxTimes) || 1));
    const added = [];
    for (let i = 0; i < hits; i++) {
      const soFar = mine.length + added.length;
      let d = null;
      if (def.kind === 'stat') {
        if (soFar >= maxTimes) break;
        const stat = ['power', 'agility', 'speed'][Math.floor(Math.random() * 3)];
        const label = { power: '力量', agility: '敏捷', speed: '速度' }[stat];
        const pct = rollPct();
        d = { from: entry.anim, hero: src.hero, short: src.short, color: src.color,
          kind: 'stat', stat, pct, name: def.name, times: soFar + 1,
          text: label + ' −' + Math.round(pct * 100) + '%' };
      } else if (def.kind === 'lock') {
        if (soFar >= maxTimes) break;

        const locked = mine.concat(added).map((x) => x && x.what + ':' + x.id);
        const st = isHeroRun(run) ? run.hero : S(), pool = [];
        const nameOf = (map, id) => { const dd = map && map.getValue(id); return dd ? dd.name : ('#' + id); };
        for (const raw of st.weapons || []) {
          const id = Number(String(raw).split(':')[0]);
          if (locked.indexOf('weapon:' + id) >= 0) continue;
          pool.push({ what: 'weapon', id, name: nameOf(weaponsMap, id) });
        }
        for (const raw of st.skills || []) {
          const id = Number(String(raw).split(':')[0]);
          if (id === 13) continue;
          if (locked.indexOf('skill:' + id) >= 0) continue;
          pool.push({ what: 'skill', id, name: nameOf(skillsMap, id) });
        }
        if (!pool.length) break;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        d = { from: entry.anim, hero: src.hero, short: src.short, color: src.color,
          kind: 'lock', what: pick.what, id: pick.id, name: def.name, times: soFar + 1,
          text: '锁住' + (pick.what === 'weapon' ? '武器' : '技能') + '「' + pick.name + '」' };
      } else {
        // 生命上限：按累计削减总量封顶（多层是相乘的，所以要按 1−Π(1−p) 算）。
        // 余量不足 1 个百分点就不再落新条目了 —— 否则会堆出一串 0.3% / 0.04% 的废条目。
        const cap = Math.max(0, Number(def.capPct) || 0);
        const used = 1 - mine.concat(added).reduce((a, x) => a * (1 - (Number(x.pct) || 0)), 1);
        const left = cap - used;
        if (left < 0.01) break;                             // 本层已经削到上限（或只差不到 1%）
        const pct = Math.min(left, rollPct());
        d = { from: entry.anim, hero: src.hero, short: src.short, color: src.color,
          kind: 'maxHp', pct, name: def.name, times: soFar + 1,
          text: '生命上限 −' + Math.round(pct * 100) + '%' };
      }
      if (!d) break;
      // 记下是哪一层吃的削弱（正常流程里进新层就会被 advanceLayer 清掉；
      // 这个字段主要用于存档校对与调试台观察）。
      d.layer = layer;
      run.debuffs.push(d);
      added.push(d);
    }
    // 返回这一场新落下的最后一条（界面拿它飘字 / 存档）；一条都没落下就返回 null。
    return added.length ? added[added.length - 1] : null;
  }

  function reportBattle(mode, token, win, hpAbs, effMaxHp, result) {
    const box = mode === 'tower' ? tower() : endless();
    const run = box.run;
    if (!run || run.attempt !== token) return { ok: false };
    delete run.attempt;

    if (stacksOf(run, 'C14') && result && Array.isArray(result.rounds)) {
      const revives = result.rounds.filter((r) => r && r.deathSave && r.revive).length;
      if (revives > 0) {
        if ((run.reviveLayer || 0) !== run.layer) { run.reviveLayer = run.layer; run.reviveUsed = 0; }
        run.reviveUsed = Math.max(0, Math.floor(Number(run.reviveUsed) || 0)) + revives;
      }
    }

    if (result && result.skipped) run.skippedBattles = Math.max(0, Math.floor(Number(run.skippedBattles) || 0)) + 1;

    run.lastCoinsGained = 0;

    run.lastMintGained = 0;
    const entry = run.plan[run.idx];
    const wasLastBattle = run.idx === run.plan.length - 1;
    const isElite = isEliteEntry(entry, run.layer, wasLastBattle);
    if (!win) {
      // 本场也不计叠层与试炼币收益；改为进入「收缴」阶段：玩家必须交出一个
      // ⚠ x00 层的「觐见魔王」是例外（用户口径 2026-10 第六十六批）：那一场输了照常结算失败 ——
      if (entry && entry.kind === 'patrol' && !entry.x00) {
        run.phase = 'patrolToll';
        run.patrolTollAt = { layer: run.layer, idx: run.idx };

        notePatrolResultStory(run, false);
        logBuff(run, 'patrol', 'lose', { detail: '巡逻失败：需要上交一个最高稀有度的增益' });
        save();
        return { ok: true, win: false, patrol: true, phase: 'patrolToll', entryKind: entry.kind,
          msg: '巡逻失败：交出一个最高稀有度的增益即可继续（血量与增益层数都保留）' };
      }
      const fail = mode === 'tower' ? towerFail(run) : endlessFail(run);
      if (fail && fail.retryable) { fail.battleNo = run.idx + 1; fail.battleCount = run.plan.length; }
      return fail;
    }
    const rawHp = Math.max(1, Math.round(Number(hpAbs) || 0));
    const endCap = Math.max(1, Math.round(Number(effMaxHp) || 0));
    // 全局实际血量计数器：被上限压下来的部分要真正写进去。
    // 战斗中的上限可能因为「空血上限」（浴血重生 / 濒死觉悟 / 血之契约）等临时加成
    // 远高于局外上限。如果直接把战斗内的剩余血量原样记进计数器，那份「多出来的血」
    const outCap = currentMaxHp(run);
    const endHp = (outCap > 0) ? Math.min(rawHp, outCap) : rawHp;
    run.hpAbs = endHp;
    run.carry = clamp01(endHp / endCap);
    // 本场参考上限：本场结束时记下的真实 maxHp（「回 X% 最大生命」都按它换算）。
    const refMax = Math.max(1, Number(run.refMaxHp) || Number(run.lastMaxHp) || endCap);
    const battleLayer = Math.max(1, Math.floor(Number(run.layer) || 1));

    const battleIdx = Math.max(0, Math.floor(Number(run.idx) || 0));
    const out = { ok: true, win: true, elite: isElite, entryKind: entry.kind };
    // 本场掉落的固定种子：先取下来再清字段（下一场重新生成）。
    // 同一场反复重打时 `run.battleChoiceSeed` 会由快照恢复，抽到的选项因此不变。
    const battleSeed = battleChoiceSeedOf(run);
    delete run.battleChoiceSeed;

    if (mode === 'endless' && entry && entry.kind === 'patrol' && !entry.x00) {
      markPatrolDone(run, battleLayer);
      out.patrolDone = { block: run.patrolDoneBlock, wins: run.patrolDoneWins };
    }
    if (isHeroRun(run)) {
      out.heroGrowth = TowerHero.grow(run.hero, { layer: battleLayer, elite: isElite, patrol: entry.kind === 'patrol',
        lastBattle: wasLastBattle });
      run.baseMaxHp = heroBaseHp(run);
      // 勇者每打完一场，按休息期血量上限的 5% 回血。
      // 结算顺序：先做本场成长（可能抬上限）→ 再用新的上限算休息回血 →
      const restMax = currentMaxHp(run);
      out.heroRestHeal = healAbs(run, 0.05, restMax);
      run.carry = clamp01(run.hpAbs / Math.max(1, restMax));
    }

    if (mode === 'endless' && result && Array.isArray(result.rounds)) {
      const saves = result.rounds.filter((r) => r.deathSave).length;
      if (saves > 0) {
        run.deathSaves = Math.max(0, Math.floor(Number(run.deathSaves) || 0)) + saves;
        const tier = D().reviveScoreAt(run.deathSaves);

        if (tier > (Number(run.reviveTierPaid) || 0)) {
          const gained = tier - (Number(run.reviveTierPaid) || 0);
          run.reviveTierPaid = tier;
          run.reviveCount = (Number(run.reviveCount) || 0) + 1;
          addScore(run, gained, '隐藏成就·死而复生（累计 ' + run.deathSaves + ' 次）');
          // 原成就提示保留档位面值；结算账本另记本次实际补发的分数，不能把档位面值相加。
          const item = markAchievement(run, 'revive:' + run.reviveCount,
            '死而复生 · 累计 ' + run.deathSaves + ' 次', tier, gained);
          out.achievement = item || null;
          out.reviveScore = gained;
        }
      }
    }
    const debuff = applyHeroDebuff(run, entry, result);
    if (debuff) { out.debuff = debuff; save(); }
    if (mode === 'tower') {
      healAbs(run, D().AUTO_HEAL_PCT, refMax);
      const shares = D().towerGoldShares(run.layer, run.plan.length);
      run.pot += shares[run.idx];
      out.potGold = run.pot;
    } else {
      const g = globalMul(run);
      const stats = ensureRunStats(run);
      stats.enemiesDefeated = Math.max(0, Number(stats.enemiesDefeated) || 0) + 1;
      addScore(run, D().SCORE.battle, '战斗胜利');

      const coinBoostPct = Math.max(0, runModTotal(run, 'coinBoostPct') || 0);
      const coinFragilePct = fragileCoinBonus(run);
      let coinGreedPct = 0;

      {
        const fx = envEffective(run);
        if (fx.mine.includes('greed')) coinGreedPct = Math.max(0, envModTotal(run, 'coinBonus', { mineOnly: true }));
      }
      const coinMul = 1 + coinBoostPct + coinFragilePct + coinGreedPct;

      const eachRow = (fn) => {
        for (const row of (run.permanent || [])) {
          const def = row && D().BUFF_BY_ID[row.id];
          if (def) fn(row, def, Math.max(1, Math.floor(Number(row.stacks) || 1)));
        }
      };
      eachRow((row, def, st) => {
        const m = def.mods || {};

        const em = rowEnchMulOf(row);
        const emul = buffEffectMulOf(row, g);
        if (m.sellGrowthPerWin) addGrow(run, row, 'sellBonus', m.sellGrowthPerWin * st * emul);
        if (m.winMaxHpFlat) addGrow(run, row, 'winHpFlat', m.winMaxHpFlat * st * emul);

        if (m.winTakenMulPct) {
          const cap = (Number(m.winTakenMulCap) || 0.25) * st * em;
          const cur = growOf(row, 'winTakenMul');
          const next = Math.min(cap, cur + (Number(m.winTakenMulPct) || 0.01) * st * em);
          addGrow(run, row, 'winTakenMul', next - cur);
        }

        if (m.winStatAfter10 && battleLayer >= 10) {
          const per = Math.max(0, Number(m.winStatAfter10) || 1) * st * em;
          addGrow(run, row, 'winStatPower', per);
          addGrow(run, row, 'winStatAgility', per);
          addGrow(run, row, 'winStatSpeed', per);
        }
        // 猎杀时刻（C06）：每杀一个敌人攻击 +2%，上限 +30% × 层数。
        if (m.killPowerPct) {
          const cap = (m.killPowerCap || 0.40) * st * emul;
          const cur = growOf(row, 'killPower');
          const next = Math.min(cap, cur + (m.killPowerPct || 0.02) * st * emul);
          addGrow(run, row, 'killPower', next - cur);
        }
        // 吞噬成长（C07）：每胜一场生命上限 +2%，上限 +30% × 层数。
        if (m.winMaxHpPct) {
          const cap = (m.winMaxHpCap || 0.30) * st * emul;
          const cur = growOf(row, 'winMaxHp');
          const next = Math.min(cap, cur + (m.winMaxHpPct || 0.02) * st * emul);
          addGrow(run, row, 'winMaxHp', next - cur);
        }
      });

      const coinsBeforeBattle = Math.max(0, Number(run.coins) || 0);
      const coinBase = D().coinBattleBase(battleLayer);
      const eliteMul = isElite ? Math.max(1, Number(D().COINS.eliteMul) || 3) : 1;

      const patrolMul = (entry.kind === 'patrol') ? Math.max(1, Number(D().PATROL.winCoinMul) || 1) : 1;
      let coinGain = Math.round(coinBase * coinMul * eliteMul * patrolMul);

      if (result && result.skipped && mode === 'endless') coinGain = Math.round(coinGain * 2 / 3);
      run.coins += coinGain;
      noteRunIncome(run, 'trialCoinsEarned', coinGain);

      run.lastCoinBreak = {
        base: coinBase, layer: battleLayer, band: D().coinBattleTierLabel(battleLayer),
        elite: !!isElite, eliteMul,
        boosts: [
          { name: '战利品', pct: coinBoostPct },
          { name: '淘金烙印', pct: coinFragilePct },
          { name: '贪婪裂隙', pct: coinGreedPct },
        ].filter((b) => b.pct > 0),
      };
      const c11 = stacksOf(run, 'C11');
      if (c11) healAbs(run, 0.03 * c11 * g * healBonusMul(run), refMax);
      if (isElite) {
        addScore(run, D().SCORE.elite, '击败精英');
        const c13 = stacksOf(run, 'C13');
        if (c13) {
          healAbs(run, D().BUFF_BY_ID.C13.mods.eliteHealAfter * g * healBonusMul(run), refMax);

          const addHp = Number(D().BUFF_BY_ID.C13.mods.eliteMaxHpAfter) || 0;
          if (addHp > 0) run.hpBonus = Math.max(0, Number(run.hpBonus) || 0) + addHp * c13 * g;
        }
      }

    run.lastCoinsGained = Math.max(0, Math.round((Number(run.coins) || 0) - coinsBeforeBattle));
    out.coinsGained = run.lastCoinsGained;
    out.score = run.score; out.coins = run.coins;
    }
    // 幻影回响（三侠战）：胜利后按概率立刻再战同一场。
    // · 层号不变，所以不会触发跨层回血，也不会提前进下一层
    const echoP = (entry.kind === 'hero') ? echoRepeatChance(run) : 0;
    run.idx++;

    const layerCleared = run.idx >= run.plan.length;

    const shopCreditPct = activeShopCredit(run);
    const mintCredit = activePostBattleMintShop(run);
    const layerRestart = hasActiveLayerRestart(run);

    const shopCreditRows = snapshotShopCredits(run);
    consumeLimited(run, out);
    consumeEventRegen(run);
    const brokenFragile = rollFragileBuffs(run);
    if (brokenFragile.length) out.fragileBroken = brokenFragile;
    // 环境词缀的「剩余场数」与「战后补抽」必须每场都推进 ——
    rollEnvAfterBattle(run);

    if (layerRestart) {
      const restart = restartLayer(run);
      out.layerRestart = { layer: restart.layer, battleNo: battleIdx + 1, battleCount: run.plan.length,
        patrolSkipped: !!restart.patrolSkipped };

      if (!D().layerNoShop(run.layer)) {
        if (mintCredit) {
          openMintShop(run, battleLayer, { noGroup: true, byBuff: true });
          out.phase = 'shop';
          out.mintShop = true;
        } else if (shopCreditPct > 0) {
          run.shop = makeShop(run, shopCreditPct);
          if (run.shop) {
            run.shop.postBattle = true;
            run.shop.byBuff = true;
            run.phase = 'shop';
            out.phase = 'shop';
            out.postBattleShop = true;
          }
        }
      }
      save();
      return out;
    }
    // 打完第 2 场 → 三重王命（x00c）；打完第 3 场 → 终章（x00win，见 noteX00BetweenStory）。
    // ⚠ 位置：`run.idx++` 之后、回响/商店那些分支之前 ——
    // 所以绝不能挂在「run.idx >= plan.length」那个「本层已清空」分支里（那样永远进不去）；
    if (mode === 'endless' && isX00Plan(run.plan)) noteX00BetweenStory(run);


    const echoBattleKey = battleLayer * 1000 + battleIdx;
    if (echoP > 0 && run.idx < run.plan.length &&
        Number(run.repeatAt) !== echoBattleKey &&
        Math.random() < echoP) {
      run.idx--;
      run.repeatAt = echoBattleKey;

      const keptCredit = restoreShopCredits(run, shopCreditRows);
      out.repeat = { chance: echoP, name: (echoDef() || {}).name || '幻影回响', layer: run.layer, battleNo: run.idx + 1 };
      if (keptCredit > 0) out.repeat.shopCreditKept = keptCredit;
      run.repeatCount = Math.max(0, Number(run.repeatCount) || 0) + 1;
      save();
      return out;
    }

    const mintRoll = (mode === 'endless' && shopCreditPct <= 0 && !mintCredit && !noMintShop) && rollMintShop(run, battleLayer);
    if (layerCleared) {

      // 必须在 `layerClear` 之前：`layerClear` 里的 `advanceLayer` 会顺手挂新层的入场剧情
      const patrolLast = !!(mode === 'endless' && entry && entry.kind === 'patrol' && !entry.x00);
      if (patrolLast) notePatrolResultStory(run, true);
      const cleared = layerClear(mode, run, out, shopCreditPct, mintCredit);
      if (mintCredit && !run.shop) {
        openMintShop(run, battleLayer, { noGroup: true, byBuff: true });
        out.phase = 'shop';
        out.mintShop = true;
        save();
      } else if (mintRoll && !run.shop) {

        if (heroMentorReplacesMint(run, battleLayer)) {
          out.heroMentor = true;
          save();
        } else {
          openMintShop(run, battleLayer);
          out.phase = 'shop';
          out.mintShop = true;
          save();
        }
      }
      // E01「立即进货」在整层最后一场也必须开出来。
      if (mode === 'endless' && shopCreditPct > 0 && !mintCredit && !run.shop) {
        run.shop = makeShop(run, shopCreditPct);
        if (run.shop) {
          run.shop.postBattle = true;
          run.shop.byBuff = true;
          run.phase = 'shop';
          out.phase = 'shop';
          out.postBattleShop = true;
        }
        save();
      }
      // `layerClear` 里的 `advanceLayer` 会把 `run.choices` 清空，所以必须等它跑完
      // （剧情那一段见上面 `patrolLast`：那个要在 layerClear 之前挂，否则会被
      if (patrolLast) {
        if (!bladeRowOf(run)) {
          grantBlade(run);
          out.bladeGranted = true;
          out.patrolReward = { legendaries: 0, blade: true, coinMul: Math.max(1, Number(D().PATROL.winCoinMul) || 1) };
        } else {
          const n = grantPatrolLegendary(run);
          out.patrolReward = { legendaries: n, coinMul: Math.max(1, Number(D().PATROL.winCoinMul) || 1) };
        }
        maybeQueueBladeEvent(run);
        save();
      }
      return cleared;
    }
    // 战后临时小店（层还没打完）：E16「铸币商队」优先 —— 它顶掉 E01 的试炼商店；
    // 既不挂 phase（否则界面会停在「进入商店」而店里什么都没有），也不折腾限次。
    if (mode === 'endless' && !D().layerNoShop(run.layer)) {
      if (mintCredit) {
        openMintShop(run, battleLayer, { noGroup: true, byBuff: true });
        out.phase = 'shop';
        out.mintShop = true;
      } else if (shopCreditPct > 0) {
        run.shop = makeShop(run, shopCreditPct);

        if (run.shop) {
          run.shop.postBattle = true;
          run.shop.byBuff = true;
          run.phase = 'shop';
          out.phase = 'shop';
          out.postBattleShop = true;
        }
      } else if (mintRoll) {

        if (heroMentorReplacesMint(run, battleLayer)) out.heroMentor = true;
        else {
          openMintShop(run, battleLayer);
          out.phase = 'shop';
          out.mintShop = true;
        }
      }
    }
    const won = run.idx, len = run.plan.length;
    const choiceAfter = 3;
    const extraChoice = len === 5;
    // 界面回主界面时先播剧情，播完才轮到传奇三选一的奖励弹窗（顺序见 tower-ui 的 afterBattle）。
    // ⚠ 第二道门：巡逻是无尽塔专属（见 buildPlan 的 endlessMode 门）。这里的传奇奖励取自
    if (mode === 'endless' && entry.kind === 'patrol') {
      if (!entry.x00) notePatrolResultStory(run, true);

      if (!bladeRowOf(run)) {
        grantBlade(run);
        out.bladeGranted = true;
        out.patrolReward = { legendaries: 0, blade: true, coinMul: Math.max(1, Number(D().PATROL.winCoinMul) || 1) };
        maybeQueueBladeEvent(run);
      } else {
        const n = grantPatrolLegendary(run, battleSeed ^ 0x27d4eb2d);
        out.patrolReward = { legendaries: n, coinMul: Math.max(1, Number(D().PATROL.winCoinMul) || 1) };
      }
    }
    // 普通战斗掉落与巡逻传奇并存：巡逻先写进 run.choices，这一批由 setRunChoices
    // 抽卡用本场固定种子 —— 退出重进 / 铸币回滚重打同一场不会换一组。
    if (won === choiceAfter || (extraChoice && won === 4)) {
      setRunChoices(run, withSeededRandom(battleSeed ^ 0x5bd1e995, () => rollChoices(mode, run)), 'normal');
    }
    out.achievements = takeAchievementToasts(run);
    out.choices = run.choices;
    out.choicesKind = run.choicesKind;
    out.choiceQueue = (run.choiceQueue || []).map((q) => ({ choices: (q.choices || []).slice(), kind: q.kind }));
    out.permanent = (run.permanent || []).length;
    out.limited = (run.limited || []).map((b) => ({ id: b.id, uses: b.uses, on: b.on }));
    save();
    return out;
  }
  function towerFail(run) {
    const layer = run.layer, pot = run.pot;
    run.failedAt = run.idx;
    if (run.idx === 3 || (run.idx === 4 && run.plan.length === 5)) {
      run.limited = [];
      run.choices = rollChoices('tower', run);
    }
    tower().retry = { layer, date: State.localDate() };
    save();
    return { ok: true, win: false, layer, potGold: pot, retry: true,
      battleNo: run.idx + 1, battleCount: run.plan.length, choices: run.choices };
  }

  function giveUp(mode) {
    if (mode !== 'tower') return abandon(mode);
    const run = tower().run;
    if (!run || run.attempt) return { ok: false };
    const consolation = Math.floor(run.pot * D().TOWER_FAIL_CONSOLATION);

    if (!ONLINE && consolation > 0) State.addGold(consolation);
    const out = { ok: true, layer: run.layer, potGold: run.pot, consolation: ONLINE ? 0 : consolation };
    tower().run = null;
    tower().retry = null;
    save();
    return out;
  }

  function endlessFail(run) {
    if (canRetry(run)) {
      // 把「还没选重新挑战 / 放弃本局」落进存档：界面在退出重进后会按这个标记
      run.pendingRetry = { layer: run.layer, idx: run.idx, battleNo: run.idx + 1,
        battleCount: run.plan.length, score: Math.max(0, Number(run.score) || 0) };
      save();
      return { ok: true, win: false, retryable: true, layer: run.layer, battleNo: run.idx + 1,
        battleCount: run.plan.length, retryLeft: Number(run.retryToken) || 0, settled: false,
        pendingRetry: Object.assign({}, run.pendingRetry) };
    }
    const out = { ok: true, win: false, layer: run.layer, score: run.score, bestLayer: run.bestLayer };
    return doFail(run, out);
  }

  function doFail(run, out) {
    const e = endless();
    out = out || { ok: true, win: false, layer: run.layer, score: run.score, bestLayer: run.bestLayer };
    out.win = false;
    out.summary = buildEndlessSummary(run, 'lose', 'defeat');
    settleRunTickets(run, out);
    out.shield = false;
    out.settled = true;
    settleScore(run, out);

    const today = State.localDate();
    if (!ONLINE && run.bestLayer >= D().ENDLESS_CONSOLATION_LAYER && e.shieldDate !== today) {
      e.shieldDate = today;
      S().lotteryFree = (S().lotteryFree || 0) + 1;
      out.shield = true;
    }
    finishEndlessSummary(out);
    e.run = null;
    save();
    return out;
  }

  function previewSettleTickets(run) {
    const layer = Math.max(1, Math.floor(Number(run && run.layer) || 1));
    const coins = Math.max(0, Math.floor(Number(run && run.coins) || 0));

    if (ONLINE) {
      const bestLayer = Math.max(0, Math.floor(Number(run && run.bestLayer) || 0));
      const mint = Math.max(0, Math.floor(Number(run && run.retryToken) || 0));
      const tr = (typeof window !== 'undefined' && window.TowerRewards) || null;
      const calc = (tr && typeof tr.compute === 'function')
        ? tr.compute(bestLayer, mint)
        : { bestLayer, mintCount: mint, layerTickets: Math.floor(bestLayer / 10),
            mintBonus: mint > 10 ? 1 : 0, raw: Math.floor(bestLayer / 10) + (mint > 10 ? 1 : 0) };
      const week = onlineWeekState();
      const trueEnd = calc.bestLayer >= endlessBonusMinLayer();
      const victoryBonus = trueEnd && !week.trueEndBonusUsed
        ? Math.max(0, Math.floor(Number(tr && tr.TRUE_END_BONUS_TICKETS) || 2)) : 0;
      const total = Math.min(calc.raw, week.left) + victoryBonus;
      return {
        layer, bestLayer: calc.bestLayer,
        layerTickets: calc.layerTickets,
        mint, mintCap: 0, mintConverted: 0, mintForfeited: 0,
        coins,
        bonusTickets: calc.mintBonus,
        trueEnd,
        victoryBonus,
        victoryBonusUsed: week.trueEndBonusUsed,
        rawTickets: calc.raw,
        total,
        capped: Math.min(calc.raw, week.left) < calc.raw,
        week: week.week, weekTickets: week.used, weekCap: week.cap, weekLeft: week.left,
        online: true,
      };
    }
    const layerTickets = Math.max(0, Math.floor(Number(D().endlessTickets(run && run.layer)) || 0));
    const mint = Math.max(0, Math.floor(Number(run && run.retryToken) || 0));
    // 铸币 → 抽奖卷有上限（默认 10）：超出部分不再转化，随本局作废。
    const cap = Math.max(0, Math.floor(Number(D().TICKET_FROM_MINT_CAP) || 0));
    const mintConverted = Math.min(cap, mint);
    const passedLayer = Math.max(0, Math.floor(Number(run && run.bestLayer) || 0));

    const bonusTickets = passedLayer >= endlessBonusMinLayer()
      ? Math.max(0, Math.floor(Number(D().ENDLESS_X00_BONUS_TICKETS) || 0)) : 0;
    return {
      layer: Math.max(1, Math.floor(Number(run && run.layer) || 1)),
      bestLayer: passedLayer,
      layerTickets: layerTickets,
      mint: mint,
      mintCap: cap,
      mintConverted: mintConverted,
      mintForfeited: Math.max(0, mint - mintConverted),
      coins: Math.max(0, Math.floor(Number(run && run.coins) || 0)),
      bonusTickets: bonusTickets,
      total: layerTickets + mintConverted + bonusTickets,
    };
  }
  function settleRunTickets(run, out) {
    out = out || {};

    const pv = previewSettleTickets(run);
    const layerTickets = pv.layerTickets, coins = pv.coins, mintCap = pv.mintCap;
    const retryTokens = pv.mint, retryConverted = pv.mintConverted, retryForfeited = pv.mintForfeited;
    const gain = ONLINE ? 0 : pv.total;
    if (!ONLINE && gain > 0) S().props[TICKET_PROP] = (S().props[TICKET_PROP] || 0) + gain;
    run.coins = 0;
    run.retryToken = 0;
    run.retrySnap = null;
    // 联机版也把「本局应得」报给界面（仅预览；真正入包由服务端 claimEndlessTower 完成）。
    out.layerTickets = layerTickets;
    out.bonusTickets = pv.bonusTickets;
    out.trueEnd = pv.trueEnd === true;
    out.victoryBonus = pv.victoryBonus || 0;
    out.victoryBonusUsed = pv.victoryBonusUsed === true;
    out.retryLeft = retryTokens;
    out.forfeitCoins = coins;
    out.tickets = ONLINE ? pv.total : gain;
    out.ticketsTotal = S().props[TICKET_PROP] || 0;
    out.retryConverted = retryConverted;
    out.retryForfeited = retryForfeited;
    out.mintTicketCap = mintCap;
    out.rawTickets = pv.rawTickets;
    out.weekTickets = pv.weekTickets;
    out.weekCap = pv.weekCap;
    out.weekLeft = pv.weekLeft;
    out.ticketsCapped = pv.capped === true;
    out.online = ONLINE;
    if (!ONLINE && retryConverted > 0) {
      out.retryMsg = retryConverted + ' 枚铸币已 1:1 兑换为 ' + retryConverted + ' 张抽奖卷'
        + (retryForfeited > 0 ? ('（兑换上限 ' + mintCap + ' 枚，超出 ' + retryForfeited + ' 枚不再转化）') : '');
    }
    return out;
  }

  function declineRetry() {
    const e = endless(), run = e.run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    const out = { ok: true, win: false, layer: run.layer, score: run.score, bestLayer: run.bestLayer };
    return doFail(run, out);
  }
  function settleScore(run, out) {
    const e = endless();
    if (isHeroRun(run)) {
      e.heroBest = Math.max(e.heroBest, run.score); e.heroWeekBest = Math.max(e.heroWeekBest, run.score);
      e.heroBestLayer = Math.max(e.heroBestLayer, run.bestLayer);
      out.best = e.heroBest; out.weekBest = e.heroWeekBest;
    } else {
      e.best = Math.max(e.best, run.score); e.weekBest = Math.max(e.weekBest, run.score);
      e.bestLayer = Math.max(e.bestLayer, run.bestLayer); out.best = e.best; out.weekBest = e.weekBest;
    }
  }


  function addScore(run, points, tag) {
    const pts = Math.max(0, Math.round(Number(points) || 0));
    if (!run || !pts) return 0;
    run.score = Math.max(0, Math.floor(Number(run.score) || 0)) + pts;
    if (tag) {
      run.scoreLog = Array.isArray(run.scoreLog) ? run.scoreLog : (run.scoreLog = []);
      run.scoreLog.push({ tag: tag, points: pts, layer: Math.max(1, Number(run.layer) || 1) });
      if (run.scoreLog.length > 60) run.scoreLog.splice(0, run.scoreLog.length - 60);
    }
    return pts;
  }
  // 记录一条隐藏成就。同一 key 只记一次，所以「可重复」是靠调用方给递增的 key
  // 顺带推进「待界面显示」的队列（成就提示在 explore 的所有路径上统一取出）。
  function markAchievement(run, key, name, points, earnedPoints) {
    if (!run) return null;
    run.achievements = Array.isArray(run.achievements) ? run.achievements : (run.achievements = []);
    if (run.achievements.some((a) => a.key === key)) return null;
    const item = { key: key, name: name, points: Math.max(0, Math.round(Number(points) || 0)),
      layer: Math.max(1, Number(run.layer) || 1) };
    const history = run.mode === 'endless' ? ensureRunStats(run).achievements : null;
    run.achievements.push(item);
    if (history && !history.some((a) => a.key === key)) history.push(Object.assign({}, item, {
      earnedPoints: earnedPoints == null ? item.points : Math.max(0, Math.round(Number(earnedPoints) || 0)) }));
    if (run.achievements.length > 40) run.achievements.splice(0, run.achievements.length - 40);
    run.pendingAchievements = Array.isArray(run.pendingAchievements) ? run.pendingAchievements : (run.pendingAchievements = []);
    run.pendingAchievements.push(item);
    if (run.pendingAchievements.length > 12) run.pendingAchievements.splice(0, run.pendingAchievements.length - 12);
    return item;
  }
  // 取出待显示的成就（对象）并清空队列。与 `takeRunToasts` 的字符串队列分开：
  // 老档兼容：`pendingToasts` 里残留的成就对象也一并收走，字符串留在原队列。
  function takeAchievementToasts(run) {
    run = run || endless().run;
    if (!run) return [];
    const out = (Array.isArray(run.pendingAchievements) ? run.pendingAchievements.slice() : [])
      .filter((item) => item && typeof item === 'object');
    run.pendingAchievements = [];
    if (Array.isArray(run.pendingToasts) && run.pendingToasts.some((item) => item && typeof item === 'object')) {
      const keep = [];
      for (const item of run.pendingToasts) {
        if (item && typeof item === 'object') out.push(item);
        else keep.push(item);
      }
      run.pendingToasts = keep;
    }
    return out;
  }

  function scoreBuffAcquire(run, buff) {
    if (!run || run.mode !== 'endless' || !buff) return 0;
    return addScore(run, D().buffScore(buff.rarity), '获得增益·' + buff.name);
  }
  function checkStatAchievements(run, agg) {
    if (!run || run.mode !== 'endless' || !agg) return [];
    const got = [];
    const peaks = run.statPeaks = Object.assign({}, run.statPeaks || {});
    const NAMES = { powerMul: '攻击', agilityMul: '敏捷', speedMul: '速度', maxHpMul: '生命上限' };
    for (const [field, label] of Object.entries(NAMES)) {
      const before = Math.max(0, Number(peaks[field]) || 0);
      const pct = Math.max(0, Number(agg[field]) || 0);
      if (pct > before) peaks[field] = pct;
      const after = Number(peaks[field]) || 0;
      for (const m of D().SCORE.statMilestones) {
        if (!(before < m.at && after >= m.at)) continue;
        const key = 'stat:' + field + ':' + Math.round(m.at * 100);
        const item = markAchievement(run, key, '超凡入圣 · ' + label + ' +' + Math.round(m.at * 100) + '%', m.points);
        if (item) { addScore(run, m.points, '隐藏成就·' + item.name); got.push(item); }
      }
    }
    return got;
  }


  function envList(run) { return Array.isArray(run.env) ? run.env : (run.env = []); }

  function echoRepeatChance(run) {
    const TD = D(), fx = envEffective(run);

    let miss = 1;
    for (const e of envList(run)) {
      if (fx.mine.indexOf(e.id) < 0) continue;
      const def = TD.ENDLESS_ENV_BY_ID[e.id];
      if (!def || !def.repeatOnly) continue;
      const p = Math.max(0, Math.min(1, Number(envValues(run, e).repeatChance) || 0));
      if (p > 0) miss *= (1 - p);
    }
    return 1 - miss;
  }

  function echoDef() { return D().ENDLESS_ENV_BY_ID.echo; }
  function rollEnvAfterBattle(run) {
    const TD = D(), list = envList(run);

    if (run.noEnvRoll === true) { list.length = 0; return; }
    // 情况与第 1 层一样 —— 不再抽新的，手上的也一并清掉。
    // 清理必须放在「扣剩余场数」之前，否则旧档里挂着的一条会继续掉场数、继续生效。
    if (!TD.envAllowed(run.layer)) { list.length = 0; return; }
    if (run.noEnvGain === true) { if (list.length) return; }
    for (let i = list.length - 1; i >= 0; i--) { list[i].left -= 1; if (list[i].left <= 0) list.splice(i, 1); }
    // 第 101~104 层与第 1~4 层一样不给环境、105 层照旧抽。
    // ⚠ 别再写成 `run.layer < TD.ENV_START_LAYER`（绝对层号）：那样 101 层会被当成「早过了第 5 层」，
    if (!TD.canHaveEnv(run.layer)) return;
    const cap = Math.max(1, Number(TD.ENV_MAX) || 2);
    // 兜底：旧档 / 调试注入可能已经超过上限，先裁到上限（保留剩余场数多的那几条）。
    if (list.length > cap) {
      list.sort((a, b) => (Number(b.left) || 0) - (Number(a.left) || 0));
      list.splice(cap);
    }
    const room = cap - list.length;
    if (room <= 0) return;

    const forced = TD.cycleLayer(run.layer) >= TD.ENV_TWO_LAYER ? 2 : 0;
    const want = Math.max(0, Math.min(room, forced || (Math.random() < TD.envChance(run.layer) ? 1 : 0)));

    const envMode = run.mode === 'tower' ? 'tower' : 'endless';
    for (let k = 0; k < want; k++) {
      const pool = TD.envPoolFor(envMode).filter((e) => !list.some((x) => x.id === e.id));
      if (!pool.length) break;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const dur = TD.ENV_DUR[0] + Math.floor(Math.random() * (TD.ENV_DUR[1] - TD.ENV_DUR[0] + 1));

      list.push({ id: pick.id, left: dur, values: TD.rollEnvMods(pick, envMode) });
    }
  }

  function envValues(run, entry) {
    const TD = D();
    const def = TD.ENDLESS_ENV_BY_ID[entry && entry.id];
    if (!def) return {};
    const envMode = run && run.mode === 'tower' ? 'tower' : 'endless';
    if (!entry.values || typeof entry.values !== 'object') entry.values = TD.rollEnvMods(def, envMode);
    const mul = 1 + Math.max(0, runModTotal(run, 'envPowerMul'));
    const out = {};
    for (const [k, v] of Object.entries(entry.values)) {

      if (envMode === 'tower' && TD.ENDLESS_REWARD_MOD_KEYS.includes(k)) continue;
      out[k] = Number(v) * mul;
    }
    return out;
  }


  function envModTotal(run, key, opts) {
    const mineOnly = !!(opts && opts.mineOnly);
    const fx = mineOnly ? envEffective(run) : null;
    let sum = 0;
    for (const e of envList(run)) {
      if (mineOnly && fx.mine.indexOf(e.id) < 0) continue;
      const def = D().ENDLESS_ENV_BY_ID[e.id];
      if (!def || !def.mods || def.mods[key] === undefined) continue;
      sum += Number(envValues(run, e)[key]) || 0;
    }
    return sum;
  }


  const ENV_MOD_MAP = {

    thornsPct: ['thornsPct', 'foe'],
    regenPct: ['regenPct', 'foe'],
    lifestealPct: ['lifestealPct', 'foe'],
    shellPct: ['shellPct', 'foe'],
    devourPct: ['devourPct', 'foe'],

    enemyCritBonus: ['critBonus', 'foe'],
    enemyMaxHpMul: ['maxHpMul', 'foe'],
    selfSpeedMul: ['speedMul', 'me'],
    enemySpeedMul: ['speedMul', 'foe'],
    bothLifestealPct: ['lifestealPct', 'both'],
    selfCritBonus: ['critBonus', 'me'],
  };

  function applyEnvTo(run, fighter, side) {
    const TD = D(), fx = envEffective(run);
    const isFoe = side != null ? side === 1 : fighter.side === 1;
    const key = isFoe ? 'foe' : 'me';
    const eff = { mods: {} };
    const add = (k, key2, v) => { if (v) eff.mods[k] = (Number(eff.mods[k]) || 0) + v; };

    const consume = (entry) => {
      const def = TD.ENDLESS_ENV_BY_ID[entry.id];
      if (!def || !def.mods) return;
      const values = envValues(run, entry);
      const goodEnv = !def.bad;
      if (isFoe && goodEnv && fx.sh.denyGood) return;
      for (const [mk, spec] of Object.entries(ENV_MOD_MAP)) {
        if (def.mods[mk] === undefined) continue;
        if (spec[1] !== 'both' && spec[1] !== key) continue;
        add(spec[0], mk, Number(values[mk]) || 0);
      }
    };
    const done = new Set();
    const once = (e) => { if (e && !done.has(e.id)) { done.add(e.id); consume(e); } };

    for (const e of envList(run)) if (fx.mine.includes(e.id)) once(e);

    if (isFoe) for (const e of envList(run)) if (fx.enemy.includes(e.id)) once(e);

    const mods = fighter.mods || (fighter.mods = {});
    for (const [k, v] of Object.entries(eff.mods)) if (v) mods[k] = (Number(mods[k]) || 0) + v;

    if (eff.mods.critBonus) fighter.crit = Math.max(Number(fighter.crit) || 0, 0) + eff.mods.critBonus;
    if (eff.mods.maxHpMul) fighter.hp = Math.max(1, Math.round(fighter.hp * (1 + eff.mods.maxHpMul)));
    if (eff.mods.speedMul) fighter.speed = Math.max(1, Math.round(fighter.speed * (1 + eff.mods.speedMul)));
    // 血色黄昏是「双方向」的吸血：sim 只看 mods.lifestealPct，所以这里要把
    // 面板字段也补上（否则玩家侧只是 mods 里有个值、面板不显示、老代码读面板时看不到）。
    if (eff.mods.lifestealPct) fighter.lifestealPct = Math.max(Number(fighter.lifestealPct) || 0, eff.mods.lifestealPct);

    const coin = fx.mine.includes('greed') ? envModTotal(run, 'coinBonus', { mineOnly: true }) : 0;
    run.envCoinMul = 1 + Math.max(0, coin);
    return fighter;
  }
  function applyEnvToFoe(run, foe) { return applyEnvTo(run, foe, 1); }
  function applyEnvToMe(run, me) { return applyEnvTo(run, me, 0); }

  function envShield(run) {
    return { ignore: runModTotal(run, 'envIgnore') > 0, reflect: runModTotal(run, 'envReflect') > 0,
      denyGood: runModTotal(run, 'envDenyGood') > 0 };
  }

  function envEffective(run) {
    const TD = D(), sh = envShield(run), mine = [], enemy = [];
    const used = {};
    const allow = (def) => {
      const cap = Math.max(1, Math.floor(Number(def.maxStacks) || 1));
      const n = used[def.id] || 0;
      if (n >= cap) return false;
      used[def.id] = n + 1;
      return true;
    };
    for (const e of envList(run)) {
      const def = TD.ENDLESS_ENV_BY_ID[e.id];
      if (!def) continue;
      if (def.bad) {
        if (sh.ignore) { if (def.noReflect || !sh.reflect) continue; }
        if (sh.reflect && !def.noReflect) { if (allow(def)) enemy.push(e.id); }
        else if (allow(def)) mine.push(e.id);
      }

      else if (allow(def)) mine.push(e.id);
    }
    return { mine, enemy, sh };
  }




  function towerBlackCards(layer) {
    layer = Math.max(1, Math.floor(Number(layer) || 1));
    if (layer % 100 === 0) return 0;
    let n = 0;
    if (layer % 20 === 0) n += 1;
    if (layer % 50 === 0) n += 1;
    return n;
  }

  function endlessBlackCardLayer(layer) {
    layer = Math.max(1, Math.floor(Number(layer) || 1));
    return layer % 50 === 0;
  }

  function settleBlackTowerRewards() {

    if (ONLINE) return { cards: 0, box: 0 };
    const t = tower();
    const s = S();

    if (!State.blackGearEnabled()) return { cards: 0, box: 0 };
    const paid = Math.max(0, Math.min(t.maxLayer, Math.floor(Number(s.blackTowerLayer) || 0)));
    let cards = 0;
    for (let layer = paid + 1; layer <= t.maxLayer; layer++) cards += towerBlackCards(layer);
    let box = 0;
    if (t.maxLayer >= 100 && !s.blackBox100) { box = 1; s.blackBox100 = true; }
    if (cards) s.props[80] = (s.props[80] || 0) + cards;
    if (box) s.props[89] = (s.props[89] || 0) + box;
    s.blackTowerLayer = t.maxLayer;
    if (cards || box) save();
    return { cards, box };
  }

  // 勇者每通过 5 层：生命上限 +50、回复 50、力/敏/速 各 +5。
  function grantHeroLayerBonus(run, out) {
    if (!isHeroRun(run) || !run.hero || !run.hero.base) return;
    const layer = Math.max(1, Math.floor(Number(run.layer) || 1));
    if (layer % 5 !== 0) return;
    const beforeHp = currentHp(run).hp;
    // 开局四维分配有「合计 195」的校验，直接加 base 会在下一次 normalize 被回滚；
    const bonus = run.hero.towerBonus || (run.hero.towerBonus = { power: 0, agility: 0, speed: 0, maxHp: 0 });
    bonus.power = Math.max(0, Number(bonus.power) || 0) + 5;
    bonus.agility = Math.max(0, Number(bonus.agility) || 0) + 5;
    bonus.speed = Math.max(0, Number(bonus.speed) || 0) + 5;
    bonus.maxHp = Math.max(0, Number(bonus.maxHp) || 0) + 50;
    run.baseMaxHp = Math.max(1, Math.round(Number(heroBaseHp(run)) || 0));
    if (Number(run.lastMaxHp) > 0) run.lastMaxHp += 50;
    if (Number(run.refMaxHp) > 0) run.refMaxHp += 50;
    const cap = Math.max(1, currentMaxHp(run));
    run.hpAbs = Math.min(cap, Math.max(0, beforeHp + 50));
    run.carry = clamp01(run.hpAbs / cap);
    run.hero.log = (Array.isArray(run.hero.log) ? run.hero.log : []).concat([
      '第' + layer + '层通过：生命上限 +50、回复 50、力/敏/速 +5',
    ]).slice(-20);
    out.heroLayerBonus = { layer, maxHp: 50, heal: 50, power: 5, agility: 5, speed: 5 };
  }

  function layerClear(mode, run, out, shopPct, mintShop) {
    out.layerComplete = true;
    out.layer = run.layer;
// 本层已全清：留一份快照，主界面在商店/结算点阶段仍能看到「最后一个敌人 已战胜」
    if (mode === 'endless') run.finished = { layer: run.layer, count: run.plan.length, at: Date.now() };

    if (mode === 'endless' && out.win === true && run.layer % 10 === 0) {
      run.retryToken = Math.max(0, Number(run.retryToken) || 0) + 1;
      noteRunIncome(run, 'mintEarned', 1);
      run.lastMintGained = Math.max(0, Number(run.lastMintGained) || 0) + 1;
      out.mintGained = 1;
    }
    if (mode === 'tower') {
      const gold = run.pot;

      if (!ONLINE) {
        State.addGold(gold);
        tower().maxLayer = run.layer;
        tower().retry = null;

        if (Math.random() < GData.stageFragmentChance(6) * Number(GData.BLUE_SHARD_DROP_MUL)) {
          const count = GData.stageFragmentCount();
          const id = 26;
          S().props[id] = (S().props[id] || 0) + count;
          out.drop = { id, count, name: propMap.getValue(id).name };
        }
        out.prizes = settlePrizes(run);
        out.gold = gold;

        if (State.blackGearEnabled()) {
          const blackCards = towerBlackCards(run.layer);
          if (blackCards) {
            S().props[80] = (S().props[80] || 0) + blackCards;
            out.black = { cards: blackCards };
          }
          S().blackTowerLayer = Math.max(Number(S().blackTowerLayer) || 0, run.layer);
          if (run.layer === 100) {
            S().props[89] = (S().props[89] || 0) + 1;
            S().blackBox100 = true;
            out.blackBox = 1;
          }
        }
      } else {
        tower().maxLayer = run.layer;
        tower().retry = null;
        out.prizes = [];
        out.gold = 0;
        out.noRewards = true;
      }
      tower().run = null;
      save();
      return out;
    }
    const g = globalMul(run);
    const stats = ensureRunStats(run);
    stats.layersCleared = Math.max(0, Number(stats.layersCleared) || 0) + 1;

    stats.victoryLayer = out.win === true && isX00Plan(run.plan) && run.layer % 100 === 0 ? run.layer : 0;
    addScore(run, D().SCORE.layer, '通过第 ' + run.layer + ' 层');
    run.coins += D().COINS.layer;
    noteRunIncome(run, 'trialCoinsEarned', D().COINS.layer);
    run.bestLayer = Math.max(run.bestLayer, run.layer);
    // 勇者每通过 5 层：+50 生命上限 / 回复 50 / 力敏速 +5（真实胜利才发）。
    if (out.win === true) grantHeroLayerBonus(run, out);


    if (!ONLINE && run.layer % D().MILESTONE_EVERY === 0) {
      const rollLucky = () => {
        const cands = [D().rollMilestone(), D().rollMilestone(), D().rollMilestone()].filter(Boolean);
        const rank = (r) => (r.kind === 'pill' ? 2 : r.kind === 'skill' ? 1 : 0);
        return cands.sort((a, b) => rank(b) - rank(a))[0] || null;
      };
      const FALLBACK = { kind: 'skill', propId: 21, count: 10, name: '技能卷轴' };
      const reward = (run.layer % 10 === 0 ? rollLucky() : D().rollMilestone()) || FALLBACK;
      S().props[reward.propId] = (S().props[reward.propId] || 0) + reward.count;
      const def = propMap.getValue(reward.propId);
      reward.name = def ? def.name : (reward.name || '奖励');
      out.milestone = reward;
    }
    out.score = run.score; out.coins = run.coins;

    if (!ONLINE && State.blackGearEnabled() && endlessBlackCardLayer(run.layer)) {
      out.black = State.grantEndlessBlackCard(1);
    }
    if (run.layer % 5 === 0) {
      // 于是这一层只有「觐见魔王」三连战，中途不插店。走 advanceLayer 而不是干等 ——
      // 否则整局会卡在「本层已清空、却没有下一步」。
      if (D().layerNoShop(run.layer)) {

        if (D().isMirrorLayer(run.layer)) {
          run.phase = 'mirror';
          delete run.mirrorTaken;
          out.phase = 'mirror';
          out.mirror = { layer: run.layer, stacks: mirrorStacks(run) + 1 };
          save();
          return out;
        }
        advanceLayer(run, 'endless');
        save();
        return out;
      }
      // E16「铸币商队」：顶掉这次的结算商店 —— 位置与去向都不变（`boundary` 一样要打），
      if (mintShop) {
        openMintShop(run, run.layer, { noGroup: true, byBuff: true, boundary: true });
        out.mintShop = true;
      } else {
        run.shop = makeShop(run, shopPct);
        if (run.shop) run.shop.boundary = true;
      }
      run.phase = 'shop';
      out.phase = 'shop';
    } else {
      advanceLayer(run, 'endless');
    }
    save();
    return out;
  }

  function settlePrizes(run) {
    const Drops = window.BattleDrops;
    if (!Drops || typeof Drops.plan !== 'function') return { items: [], ups: [] };
    const battles = Math.max(0, Number(D().SETTLE_DROP_BATTLES) || 3);
    const skipped = Math.max(0, Math.floor(Number(run && run.skippedBattles) || 0));
    const list = [], lost = [];
    for (let i = 0; i < battles; i++) {
      const pack = Drops.plan();
      if (i >= skipped || typeof Drops.trimOne !== 'function') { list.push(...pack); continue; }
      const cut = Drops.trimOne(pack);
      list.push(...cut.list);
      if (cut.lost) lost.push({ id: cut.lost.id, name: cut.lost.name, count: cut.lost.count });
    }
    const out = Drops.grant(list);
    if (lost.length) out.lost = lost;
    return out;
  }
  function advanceLayer(run, mode) {
    run.layer++;
    run.plan = buildPlan(run.layer, run.salt, true, mode);
    run.idx = 0;
    clearRunChoices(run);
    run.restShopUsed = false;

    run.skippedBattles = 0;

    if (mode === 'endless' && D().isMirrorLayer(run.layer)) {
      run.x00PreNo = 0;
      run.x00stage = 0;
    }
    // 三侠大招留下的削弱是「贯穿本层」的（见 TowerData.HERO_DEBUFF、界面上的
    // 「本层已被削弱（贯穿本层）」）：进新的一层必须清掉。
    // 注意清理放在 layerStartHeal 之前：新层的回血不该按被压低的上限算。
    run.debuffs = [];
    layerStartHeal(run, mode);
    const lost = applyBrokenMarkLoss(run);
    if (lost) run.pendingToasts = (run.pendingToasts || []).concat(['碎掉的烙印失效：' + lost.label]).slice(-12);
    // 手上的残留就地清掉 —— 与「进新的一层」时清三侠削弱同一个道理（给新一轮一个干净的起点）。
    // 注意判据是「轮次切换」而不是「不吃环境」：环境本身从 ENV_START_LAYER（第 5 层）起
    if (mode === 'endless' && run.layer > D().LAYER_CYCLE && D().layerCycle(run.layer) === 1) {
      if (Array.isArray(run.env) && run.env.length) run.env = [];
      if (run.phase === 'sacrifice') run.phase = null;
      run.pendingToasts = (run.pendingToasts || []).concat([
        '第 ' + run.layer + ' 层：新一轮开始 —— 商店件数 / 战斗选项 / 环境词缀 / 每 10 层放弃增益' +
        '都回到与第 1 层相同的节奏；旧构筑已封存，敌人以本轮基准重新成长。']).slice(-12);
    }
    if (mode === 'endless' && D().layerNoShop(run.layer) && run.shop) {
      run.shop = null;
      if (run.phase === 'shop') run.phase = null;
    }

    if (mode === 'endless' && run.layer > 0 && run.layer % D().LAYER_CYCLE === 0) {
      const held = Array.isArray(run.patrolTolls) ? run.patrolTolls.length : 0;
      const line = '第 ' + run.layer + ' 层 · 觐见魔王：两名近卫把门，门后是照着你的样子站起来的那一位' +
        (held ? '（它身上挂着你交出去的 ' + held + ' 件东西）' : '') +
        '。这一层不开商店。';
      run.pendingToasts = (run.pendingToasts || []).concat([line]).slice(-12);
    }
    // 不需要玩家先点一次「继续战斗」）。放在最后：层号、plan、环境、toast 都就位了再判。
    // ⚠ 它不会为空手而归的状态乱挂：`run.story / attempt / choices` 有任何一个非空都不插队，
    if (mode === 'endless') {
      maybeQueueBladeEvent(run);
      autoPlayStory(run);
    }
  }
  // 手上有没有「开着的」时间回廊（E15，限次 1）—— 必须在 consumeLimited 之前取。
  function hasActiveLayerRestart(run) {
    for (const b of run.limited || []) {
      if (b.on === false || !(b.uses > 0)) continue;
      const m = (D().BUFF_BY_ID[b.id] || {}).mods || {};
      if (m.layerRestart) return true;
    }
    return false;
  }
  // （后者按「层号×1000 + 层内序号」记账，重开同一层会撞上旧 key，必须清）。
  function restartLayer(run) {
    const layer = Math.max(1, Math.floor(Number(run.layer) || 1));
    // 本 10 层区块的巡视魔王已经击败过 → 重建 plan 时跳过巡逻替换，让它不再刷新。
    // 其余三侠 / 首领位照旧（被巡逻替换掉的那一场会回到原位，层内场数不变）。
    const patrolSkipped = patrolDoneInBlock(run, layer);
    run.plan = buildPlan(layer, run.salt, true, 'endless', { skipPatrol: patrolSkipped });
    run.idx = 0;
    clearRunChoices(run);
    run.finished = null;
    run.restShopUsed = false;
    run.repeatAt = -1;
    return { layer, patrolSkipped };
  }



  function poolFilter(run, buff) {

    if (D().hasTag(buff, 'story')) return false;
    if (D().hasTag(buff, 'hero') && !isHeroRun(run)) return false;
    if (D().hasTag(buff, 'hero') && buff.kind === 'instant') {
      const owned = heroOwned(run);
      if (buff.mods.heroSecret && owned.length >= TowerHero.catalog().length) return false;
      if (buff.mods.heroReplace && owned.length >= TowerHero.catalog().length) return false;
      if ((buff.mods.heroTraining || buff.mods.heroGuaranteed || buff.mods.heroLevelUp) && !owned.some(it => it.level < 15 && !(it.kind === 'skill' && [6, 13].includes(it.id)))) return false;
    }
    const cap = D().stackCap(buff);

    if (buff && buff.mods && buff.mods.brandGate != null &&
      unbrokenBrandCount(run) <= Math.max(0, Math.floor(Number(buff.mods.brandGate) || 0))) return false;

    if (permanentRestackable(buff)) return true;
    // noRestack（涅槃 / 后发制人 / 挥金如土这一组）：拿满上限后出池。
    // 有 maxStacks 的按上限判；没有的（后发制人）按「同名唯一」判。
    if (D().hasTag(buff, 'noRestack')) {
      if (buff.maxStacks) return obtainedCountOf(run, buff.id) < Math.max(1, Math.floor(buff.maxStacks));
      return !(run.permanent || []).some((b) => b.id === buff.id);
    }

    if (D().hasTag(buff, 'stackable') && obtainedCountOf(run, buff.id) >= cap) return false;
    // maxUses：限次类的「本局最多获得 N 次」上限（例：终焉烙印最多 3 次）。
    // 所以不能只靠上面那条 stackable 判断。
    if (!D().hasTag(buff, 'stackable') && buff.maxStacks) {

      const got = obtainedCountOf(run, buff.id) + instantOwnedCount(run, buff.id);
      if (got >= Math.max(1, Math.floor(buff.maxStacks))) return false;
    }
    if (D().hasTag(buff, 'repeatable')) return true;
    if (!D().hasTag(buff, 'unique')) return true;
    if ((run.pickBuffIds || []).includes(buff.id)) return false;
    if ((run.permSlotIds || []).includes(buff.id)) return false;
    if (run.pendingPick && run.pendingPick.buffId === buff.id) return false;

    if (instantOwnedCount(run, buff.id) > 0) return false;
    return !(run.permanent || []).some((b) => b.id === buff.id);
  }
  const CHOICE_TILT_PAID = 10;
  // 调试/测试开关：把「会改变层内流程」的增益从场间选择里排除
  // 模块级、不进存档；正式玩法永远为 false。
  let noFlowBuffs = false;
  // 调试/测试开关 2：关掉「铸币商店」的自动刷出（模块级、不进存档）。
  // 注意只掐自动那一次掷骰（reportBattle 里的调用），`mintRollOf`（测试/探针读概率）
  let noMintShop = false;
  const FLOW_BUFF_MODS = ['postBattleShop', 'postBattleMintShop', 'layerRestart'];
  function isFlowBuff(b) {
    const m = (b && b.mods) || {};
    return FLOW_BUFF_MODS.some((k) => m[k]);
  }
  // 「同名再获得 = 直接叠加场次」的限次件。
  // `ownable`（能不能继续刷出来）与 `addBuff`（再获得怎么算）共用这一个判据，别各写一份。
  function usesStackable(b) {
    if (!b || b.kind !== 'limited') return false;
    if (b.unlimitedStacks || b.maxStacks) return false;
    if (D().hasTag(b, 'unique')) return false;
    if (isFlowBuff(b)) return false;
    return true;
  }
  // 战斗获得的选项目数：基础 3，由「抉择扩充」(C50) 每层 +1，上限 6。
  // ⚠ 那个按层扣减是无尽塔专属（100 层循环那一套）：挑战塔的层结构是另一套，
  function choiceSlotsOf(run, mode) {
    const base = 3, cap = 6;
    const extra = Math.max(0, Math.floor(runModTotal(run, 'choiceCount') || 0));
    const m = mode || (run && run.mode) || 'endless';
    const cut = m === 'tower' ? 0 : D().choiceCut(run && run.layer);
    return Math.max(1, Math.min(cap, base + extra - cut));
  }

  function setRunChoices(run, choices, kind) {
    if (!run || !Array.isArray(choices) || !choices.length) return false;
    const stamp = kind === 'patrolLegendary' ? 'patrolLegendary' : 'normal';
    if (Array.isArray(run.choices) && run.choices.length) {
      run.choiceQueue = Array.isArray(run.choiceQueue) ? run.choiceQueue : [];
      run.choiceQueue.push({ choices: choices, kind: stamp });
      return false;
    }
    run.choices = choices;
    run.choicesKind = stamp;
    return true;
  }
  function advanceChoiceQueue(run) {
    if (!run || (Array.isArray(run.choices) && run.choices.length)) return false;
    const queue = Array.isArray(run.choiceQueue) ? run.choiceQueue : [];
    while (queue.length) {
      const next = queue.shift();
      const list = next && Array.isArray(next.choices) ? next.choices : [];
      if (!list.length) continue;
      run.choices = list;
      run.choicesKind = next.kind === 'patrolLegendary' ? 'patrolLegendary' : 'normal';
      run.choiceQueue = queue;
      return true;
    }
    run.choiceQueue = queue;
    run.choices = null;
    run.choicesKind = null;
    return false;
  }
  function clearRunChoices(run) {
    if (!run) return;
    run.choices = null;
    run.choicesKind = null;
    if (Array.isArray(run.choiceQueue)) run.choiceQueue.length = 0;
  }
  // 同一场战斗反复重打（退出重进 / 铸币回滚）时，抽卡必须落在同一组：
  // 种子在 nextBattle 里算好并存进 run（随快照回滚），reportBattle 抽完即清。
  function hashSeedText(text) {
    let h = 2166136261 >>> 0;
    const src = String(text == null ? '' : text);
    for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
    return h >>> 0;
  }

  function withSeededRandom(seed, fn) {
    const original = Math.random;
    let s = (Number(seed) >>> 0) || 0x9e3779b9;
    Math.random = function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    try { return fn(); } finally { Math.random = original; }
  }
  // 这一场战斗的掉落种子：优先用 nextBattle 存在 run 上的那份（随快照回滚）。
  function battleChoiceSeedOf(run) {
    const v = Math.floor(Number(run && run.battleChoiceSeed));
    if (Number.isFinite(v) && v > 0) return v >>> 0;
    return (hashSeedText(['battle', run && run.salt, run && run.layer, run && run.idx,
      run && run.battleSerial].join('|')) % 0xFFFFFFFE) + 1;
  }
  function rollChoices(mode, run) {
    const TD = D();

    const rawPool = mode === 'tower' ? TD.towerPool : TD.endlessPool;
    const pool = noFlowBuffs ? rawPool.filter((b) => !isFlowBuff(b)) : rawPool;
    const picked = [];
    const taken = new Set();
    const limitedLeft = () => pool.filter((b) => b.kind === 'limited' && b.id !== 'N08' &&
      !taken.has(b.id) && ownable(run, b) && poolFilter(run, b));

    const baseTier = TD.battleTierWeights(TD.rerollTilt(CHOICE_TILT_PAID), run);

    const slots = choiceSlotsOf(run, mode);
    let pitySlot = -1;
    for (let slot = 0; slot < slots; slot++) {
      const candidates = pool.filter((b) => !taken.has(b.id) && ownable(run, b) && poolFilter(run, b));
      if (!candidates.length) break;
      const got = rollOneCandidate(run, candidates, baseTier);
      const buff = got.buff;
      if (!buff) break;
      if (got.pity) pitySlot = picked.length;
      taken.add(buff.id);
      picked.push({ type: 'buff', id: buff.id });
    }
    const hasLimited = picked.some((c) => { const b = TD.BUFF_BY_ID[c.id]; return b && b.kind === 'limited' && b.id !== 'N08'; });
    if (picked.length && !hasLimited) {
      const list = limitedLeft();
      const at = (pitySlot >= 0 && picked.length - 1 === pitySlot) ? pitySlot - 1 : picked.length - 1;
      if (list.length && at >= 0) {
        const buff = pickByShopWeight(list, run);
        taken.delete(picked[at].id);
        picked[at] = { type: 'buff', id: buff.id };
        taken.add(buff.id);
      }
    }
    return picked;
  }

  function rollLegendaryChoices(run) {
    const TD = D();

    const slots = choiceSlotsOf(run, 'endless');
    // 「会改变层内流程」的牌）必须一起排除，否则巡逻奖励会把它们放回来。
    const pool = TD.endlessPool.filter((b) => b.rarity === 3 && ownable(run, b) && poolFilter(run, b) &&
      !(noFlowBuffs && isFlowBuff(b)));
    const picked = [], taken = new Set();
    for (let i = 0; i < slots; i++) {
      const cands = pool.filter((b) => !taken.has(b.id));
      if (!cands.length) break;

      const weights = cands.map((b) => Math.max(0.0001, buffWeightOf(run, b)));
      const sum = weights.reduce((a, v) => a + v, 0);
      let roll = Math.random() * sum, hit = cands[0];
      for (let k = 0; k < cands.length; k++) { roll -= weights[k]; if (roll <= 0) { hit = cands[k]; break; } }
      taken.add(hit.id);
      picked.push({ type: 'buff', id: hit.id });
    }
    return picked;
  }

  function grantPatrolLegendary(run, seed) {
    if (!run) return 0;
    const picked = seed != null && Number.isFinite(Number(seed))
      ? withSeededRandom(seed, () => rollLegendaryChoices(run))
      : rollLegendaryChoices(run);
    if (!picked.length) return 0;
    setRunChoices(run, picked, 'patrolLegendary');
    return picked.length;
  }

  function hasPickTargets(run, kind, inscriptionIdArg) {
    if (!run) return false;
    // （技能那一路还会补上「绝对防御 / 龟甲术 / 小宇宙爆发」这三个可选取项）——
    // 一把武器都没有时必须判「没有目标」，否则弹窗无限重开（软锁）。
    if (kind === 'weapon') return runWeapons(run).length > 0;
    if (kind === 'skill') {
      const list = runSkills(run).filter((sk) => sk && pickableSkillId(sk.id));
      return list.length > 0 || PICKABLE_DEFENSE.concat([PICKABLE_COSMOS]).length > 0;
    }
    if (kind === 'brandBuff' || kind === 'limitedBuff') {
      const wantBrand = kind === 'brandBuff';
      return (run.limited || []).some((row) => {
        const def = D().BUFF_BY_ID[row && row.id];
        if (!row || !def || Math.max(0, Math.floor(Number(row.stacks) || 0)) <= 0) return false;
        if (isBrandBuff(def) !== wantBrand) return false;
        // ⚠ 与 `pickCandidates` 的候选口径必须一致：`noExtend`（E01 立即进货 / E15 时间回廊 / E16 铸币商队）
        if (!wantBrand && def.noExtend) return false;
        return true;
      });
    }
    if (kind === 'permBuff') {
      // 铭文身份：调用方显式传进来的优先 —— 发牌那一刻 run.pendingPick 还没挂上，
      // 只靠待选推断会误判成虚空铭文（C37），于是「同一张铭文不能重复附」这类规则会被绕过。
      const inscriptionId = inscriptionIdArg || activeInscriptionId('permBuff', run) || 'C37';
      return (run.permanent || []).some((row) => {
        const def = D().BUFF_BY_ID[row && row.id];
        if (!row || !def || D().hasTag(def, 'hidden')) return false;
        return inscriptionEligible(row, run, inscriptionId);
      });
    }
    return false;
  }

  function deferPick(run, buff, kind) {
    const label = kind === 'brandBuff' ? '烙印' : kind === 'limitedBuff' ? '限次增益'
      : kind === 'weapon' ? '武器' : kind === 'skill' ? '可强化的技能' : '永久增益';
    const entry = { kind: kind, buffId: buff.id };
    if (buff.mods && buff.mods.pickLimitedUses) entry.addUses = Math.max(1, Math.floor(Number(buff.mods.pickLimitedUses) || 1));
    if (buff.mods && buff.mods.pickPermanentMul) entry.mul = Number(buff.mods.pickPermanentMul) || 0;
    if (buff.mods && buff.mods.pickWeaponPct) entry.pct = Number(buff.mods.pickWeaponPct) || 0;
    if (buff.mods && buff.mods.pickSkillPct) entry.pct = Number(buff.mods.pickSkillPct) || 0;
    run.deferredPicks = (Array.isArray(run.deferredPicks) ? run.deferredPicks : [])
      .filter((x) => !(x && x.buffId === buff.id)).concat([entry]);
    save();
    return { ok: true, deferred: true, icon: 'warn',
      msg: buff.name + '：现在还没有可以挑的目标，先替你留着 —— 之后拿到' + label + '时会自动弹出。' };
  }

  function resolveDeferredPicks(runArg) {
    const run = runArg || endless().run;
    if (!run || run.pendingPick) return null;
    const list = Array.isArray(run.deferredPicks) ? run.deferredPicks : [];
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it || !it.kind) continue;

      if (it.kind === 'permBuff') run.pendingPick = { kind: 'permBuff', buffId: it.buffId, mul: it.mul };
      if (!hasPickTargets(run, it.kind)) {
        if (it.kind === 'permBuff') run.pendingPick = null;
        continue;
      }
      if (it.kind === 'permBuff') {
        run.pendingPick = { kind: 'permBuff', buffId: it.buffId };
        if (it.mul) run.pendingPick.mul = it.mul;
      } else if (it.kind === 'brandBuff') {
        run.pendingPick = { kind: 'brandBuff', buffId: it.buffId };
      } else if (it.kind === 'weapon' || it.kind === 'skill') {

        const def = D().BUFF_BY_ID[it.buffId] || {};
        const pct = it.kind === 'weapon' ? ((def.mods || {}).pickWeaponPct || it.pct) : ((def.mods || {}).pickSkillPct || it.pct);
        run.pendingPick = { kind: it.kind, buffId: it.buffId, pct: pct };
      } else {
        run.pendingPick = { kind: 'limitedBuff', buffId: it.buffId, addUses: Math.max(1, Math.floor(Number(it.addUses) || 1)) };
      }
      run.deferredPicks = list.filter((x, k) => k !== i);
      save();
      return run.pendingPick;
    }
    return null;
  }
  // 把「已经没有可选目标」的 pendingPick 收进 deferredPicks（软锁第二道防线）：
  // 返回是否真的收走了（界面据此决定要不要提示「先留着」）。
  function parkStalePendingPick(runArg) {
    const run = runArg || endless().run;
    if (!run || !run.pendingPick || !run.pendingPick.kind) return false;
    const kind = run.pendingPick.kind;
    // 武器 / 技能强化也在内：没有可强化的目标时同样要收进 deferredPicks（否则弹窗关不掉）。
    if (['permBuff', 'brandBuff', 'limitedBuff', 'weapon', 'skill'].indexOf(kind) < 0) return false;
    if (hasPickTargets(run, kind)) return false;
    const def = D().BUFF_BY_ID[run.pendingPick.buffId];
    if (def) {
      const entry = { kind: kind, buffId: run.pendingPick.buffId };
      if (run.pendingPick.mul) entry.mul = run.pendingPick.mul;
      if (run.pendingPick.addUses) entry.addUses = run.pendingPick.addUses;
      if (run.pendingPick.pct) entry.pct = run.pendingPick.pct;
      run.deferredPicks = (Array.isArray(run.deferredPicks) ? run.deferredPicks : [])
        .filter((x) => !(x && x.buffId === entry.buffId)).concat([entry]);
    }
    run.pendingPick = null;
    save();
    return true;
  }
  function ownable(run, buff) {
    // 即时类不进 permanent / limited，ownedEntry 永远查不到 —— 必须先单独判上限，
    // 否则会在第一行被 `if (!owned) return true` 直接放行
    if (buff.kind === 'instant' && buff.maxStacks) {
      const got = instantOwnedCount(run, buff.id);
      return got < Math.max(1, Math.floor(buff.maxStacks));
    }
    // 所以这里不能加「叠满即出池」的闸 —— 只有 `unique` / `noRestack` 那两类才出去
    if (permanentRestackable(buff)) return true;
    if (buff.maxStacks && obtainedCountOf(run, buff.id) >= Math.max(1, Math.floor(buff.maxStacks))) return false;
    // 带 repeatable 标签的不适用「同名唯一」：它们的数量由 maxStacks（上面的早返回）
    if (D().hasTag(buff, 'repeatable')) return true;
    const owned = ownedEntry(run, buff.id);
    if (!owned) return true;
    // 再获得 = 直接叠加场次（见 addBuff 的同名分支），所以这里不能因为「已经有一条」就
    // 把它踢出池子 —— 否则商店 / 场间三选一 里再也刷不到它，「持有时还能刷新」就成了空话。
    if (usesStackable(buff)) return true;
    // 可叠层类的上限：优先用该增益自己的 maxStacks（例如 C50 只到 2 层），
    if (!D().hasTag(buff, 'stackable')) {
      // 既没有 stackable 也没有 maxStacks 的才是「同名唯一」；
      // 带 maxStacks 的烙印类（C49 等）可以叠到上限 —— 上限在前置判断里已把过关。
      if (!buff.maxStacks) return false;
      return obtainedCountOf(run, buff.id) < Math.max(1, Math.floor(buff.maxStacks));
    }
    const cap = D().stackCap(buff);
    return obtainedCountOf(run, buff.id) < cap;
  }

  function rollRarity(weights) {
    const w = (weights && weights.length) ? weights : D().RARITY_WEIGHTS;
    const total = w.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < w.length; i++) { if (r < w[i]) return i; r -= w[i]; }
    return 0;
  }
  function pickChoice(mode, index, replaceId) {
    const run = mode === 'tower' ? tower().run : endless().run;
    if (!run || !run.choices) return { ok: false };
    const choice = run.choices[index];
    if (!choice) return { ok: false };
    const res = addBuff(run, choice.id, replaceId);
    if (!res.ok) return res;
    const gained = res.buff || D().BUFF_BY_ID[choice.id];
    const pts = scoreBuffAcquire(run, gained);
    run.choices = null;
    run.choicesKind = null;

    advanceChoiceQueue(run);
    save();
    return Object.assign({}, res, pts ? { score: pts } : null,
      { achievements: takeAchievementToasts(run), nextChoices: run.choices, choicesKind: run.choicesKind });
  }


  function fragileBonus(run, key) {
    const base = Math.max(0, Number((run.fragileBase || {})[key]) || 0);
    const burned = Math.max(0, Number((run.fragileBurned || {})[key]) || 0);
    return { base: base, burned: burned, value: base + burned };
  }

  function fragileFinalMul(run) {
    const b = Math.max(0, Math.floor(Number(run && run.fragileMulBase) || 0));
    const k = Math.max(0, Math.floor(Number(run && run.fragileMulBurned) || 0));
    if (!b && !k) return 1;
    const mA = D().BUFF_BY_ID.C49.mods;
    const alive = Number(mA.fragileAddAlive) || 0.25;
    const burned = Number(mA.fragileAddBurned) || 0.5;
    return 1 + alive * b + burned * k;
  }

  function fragileHealBonus(run) {

    const b = Math.max(0, Math.floor(Number(run && run.fragileHealBase) || 0));
    const list = Array.isArray(run && run.fragileHealBurned) ? run.fragileHealBurned : [];
    if (!b && !list.length) return 0;
    const m = D().BUFF_BY_ID.C52.mods;
    let sum = (Number(m.fragileHealAddAlive) || 0.10) * b;
    for (const v of list) sum += Math.max(0, Number(v) || 0);
    // 每层 0.1 / 0.2 反复相加会得到 4.800000000000001；照影快照与面板都显示这个尾巴。
    return Math.round(sum * 10000) / 10000;
  }
  // 淘金烙印（C53「淘金烙印」）的战斗代币加成：按层加算（存在 +15%/层、损毁 +30%/层）。
  // 注意它不复用 run.fragileMulBase —— 那个字段是「终乘烙印」的倍率层数
  function fragileCoinBonus(run) {
    const base = Math.max(0, Math.floor(Number(run && run.fragileCoinBase) || 0));
    const list = Array.isArray(run && run.fragileCoinBurned) ? run.fragileCoinBurned : [];
    if (!base && !list.length) return 0;
    const m = D().BUFF_BY_ID.C53.mods;
    let sum = (Number(m.fragileCoinAddAlive) || 0.15) * base;
    for (const v of list) sum += Math.max(0, Number(v) || 0);
    return sum;
  }
  // 把明细重新汇总成「合计值」（移除明细后必须重算）。
  function rebuildFragileTotals(run) {
    if (!run) return;
    run.fragileBurned = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBurned || {});
    run.fragileBurned.power = 0; run.fragileBurned.agility = 0; run.fragileBurned.speed = 0;
    run.fragileHealBurned = [];
    run.fragileCoinBurned = [];
    for (const m of run.brokenMarks || []) {
      if (m.kind === 'stat' && m.stat) {
        if (run.fragileBurned[m.stat] === undefined) run.fragileBurned[m.stat] = 0;
        run.fragileBurned[m.stat] += Math.max(0, Number(m.pct) || 0);
      } else if (m.kind === 'heal') {
        run.fragileHealBurned.push(Math.max(0, Number(m.burned) || 0));
      } else if (m.kind === 'coin') {
        run.fragileCoinBurned.push(Math.max(0, Number(m.burned) || 0));
      }
    }
  }
  function loseRandomBrokenMark(run) {
    const pool = (run.brokenMarks || []).filter((m) => !m.legacy);
    if (!pool.length) return null;
    const idx = Math.floor(Math.random() * pool.length);
    const m = pool[idx];
    run.brokenMarks.splice((run.brokenMarks || []).indexOf(m), 1);
    let label = '碎裂烙印';
    if (m.kind === 'stat') {
      const statName = { power: '力量', agility: '敏捷', speed: '速度' }[m.stat] || m.stat;
      label = statName + '烙印（已损毁 +' + Math.round((Number(m.pct) || 0) * 100) + '%）';
    } else if (m.kind === 'heal') {
      label = '涌泉烙印（已损毁 +' + Math.round((Number(m.burned) || 0) * 100) + '% 治疗）';
    } else if (m.kind === 'coin') {

      label = '淘金烙印（已损毁 +' + Math.round((Number(m.burned) || 0) * 100) + '% 试炼币）';
    } else if (m.kind === 'final') {
      label = '终焉烙印（已损毁 +' + Math.round((Number(m.burned) || 0) * 100) + '%）';
      run.fragileMulBurned = Math.max(0, Math.floor(Number(run.fragileMulBurned) || 0) - 1);
    }
    rebuildFragileTotals(run);
    return { label: label, kind: m.kind, stat: m.stat };
  }
  // 逐栏（逐条）的破碎随机数：种子存在行上（`row.fragileSeed`），
  // 向后兼容：老档 / 测试仍可用 `run.fragileSeeds[id]` 注入「下一步必碎」的初始状态 ——
  function fragileRoll(run, row, pct) {
    if (!row) return false;
    run.fragileSeeds = Object.assign({}, run.fragileSeeds || {});
    const id = row.id;
    let st = Math.max(0, Math.floor(Number(row.fragileSeed) || 0));
    if (!st) {
      const legacy = run.fragileSeeds[id];
      if (Number.isFinite(legacy)) {
        st = (Math.floor(legacy) >>> 0);
        delete run.fragileSeeds[id];
      }
    }
    if (!st) {

      const key = String(run.salt == null ? 'run' : run.salt) + '#' + (Number(run.layer) || 0)
        + '#' + id + '#' + Math.max(0, Math.floor(Number(row.uid) || 0));
      let h = 0x811c9dc5;
      for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      h ^= (Date.now() & 0xffff) << 13;
      st = h >>> 0 || 1;
    }
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    row.fragileSeed = st;
    return (st / 4294967296) * 100 < pct;
  }
  // 烙印碎裂时飘一条过程提示：「XX烙印已融入身躯」。
  // 三条碎裂路径（易碎判定 / 碎裂铭文 C61 / 烙印升华 E20）都走 breakOneFragileCopy，这里只排一次。
  function queueBrandBreakToast(run, def) {
    if (!run || !def) return;
    const name = String(def.name || '烙印');

    const label = /烙印/.test(name) ? name : name + '烙印';
    run.pendingToasts = (run.pendingToasts || []).concat([label + '已融入身躯']).slice(-12);
  }

  function breakOneFragileCopy(run, def, row) {
    queueBrandBreakToast(run, def);
    if (def.mods.fragileStat) {

      const alive = Math.max(0, Number(def.mods.fragilePct) || 0);
      const burnedPct = Math.max(0, Number(def.mods.fragileBurnedPct != null
        ? def.mods.fragileBurnedPct : alive) || 0);
      run.fragileBase = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBase || {});
      run.fragileBurned = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBurned || {});
      run.fragileBase[def.mods.fragileStat] = Math.max(0, (Number(run.fragileBase[def.mods.fragileStat]) || 0) - alive);
      run.fragileBurned[def.mods.fragileStat] = Math.max(0, Number(run.fragileBurned[def.mods.fragileStat]) || 0) + burnedPct;
    }

    if (def.mods.fragileFinalMul) {
      run.fragileMulBase = Math.max(0, Math.floor(Number(run.fragileMulBase) || 0) - 1);
      run.fragileMulBurned = Math.max(0, Math.floor(Number(run.fragileMulBurned) || 0)) + 1;
    }

    if (def.mods.fragileCoinAddAlive !== undefined) {
      run.fragileCoinBase = Math.max(0, Math.floor(Number(run.fragileCoinBase) || 0) - 1);
      run.fragileCoinBurned = (Array.isArray(run.fragileCoinBurned) ? run.fragileCoinBurned : [])
        .concat([Math.max(0, Number(def.mods.fragileCoinAddBurned) || 0)]);
    }
    if (def.mods.fragileHealAddAlive !== undefined) {
      run.fragileHealBase = Math.max(0, Math.floor(Number(run.fragileHealBase) || 0) - 1);
      run.fragileHealBurned = (Array.isArray(run.fragileHealBurned) ? run.fragileHealBurned : [])
        .concat([Math.max(0, Number(def.mods.fragileHealAddBurned) || 0)]);
    }

    run.brokenMarks = Array.isArray(run.brokenMarks) ? run.brokenMarks : [];
    if (def.mods.fragileStat) {

      run.brokenMarks.push({ kind: 'stat', stat: def.mods.fragileStat,
        pct: Math.max(0, Number(def.mods.fragileBurnedPct != null
          ? def.mods.fragileBurnedPct : def.mods.fragilePct) || 0) });
    } else if (def.mods.fragileHealAddAlive !== undefined) {
      run.brokenMarks.push({ kind: 'heal',
        alive: Math.max(0, Number(def.mods.fragileHealAddAlive) || 0),
        burned: Math.max(0, Number(def.mods.fragileHealAddBurned) || 0) });
    } else if (def.mods.fragileCoinAddAlive !== undefined) {
      run.brokenMarks.push({ kind: 'coin',
        alive: Math.max(0, Number(def.mods.fragileCoinAddAlive) || 0),
        burned: Math.max(0, Number(def.mods.fragileCoinAddBurned) || 0) });
    } else if (def.mods.fragileFinalMul) {
      run.brokenMarks.push({ kind: 'final',
        alive: Math.max(0, Number(def.mods.fragileAddAlive) || 0),
        burned: Math.max(0, Number(def.mods.fragileAddBurned) || 0) });
    }
  }

  function isBrandBuff(def) { return !!(def && def.mods && def.mods.fragileBreakPct); }
  function unbrokenBrandCount(run) {
    let n = 0;
    for (const row of (run && run.limited) || []) {
      const def = D().BUFF_BY_ID[row && row.id];
      if (row && isBrandBuff(def)) n += Math.max(0, Math.floor(Number(row.stacks) || 0));
    }
    return n;
  }

  function breakBrandRow(run, row) {
    const def = D().BUFF_BY_ID[row && row.id];
    if (!run || !row || !isBrandBuff(def)) return 0;
    const copies = Math.max(0, Math.floor(Number(row.stacks) || 0));
    for (let i = 0; i < copies; i++) {
      breakOneFragileCopy(run, def, row);
      logBuff(run, row.id, 'break', { uid: row.uid, detail: '碎裂铭文：立刻破碎（升级为全额并永久保留）' });
    }
    row.stacks = 0;
    return copies;
  }
  // 巡逻失败不结算失败，而是让玩家交出一个本局最高稀有度的增益：
  // 交接记录留在 `run.patrolTolls`（x0 层的魔王会按快照吃这些加成）。



  function markSpecOf(def) {
    const m = (def && def.mods) || {};
    if (m.fragileStat) return { kind: 'stat', stat: m.fragileStat,
      per: Math.max(0, Number(m.fragileBurnedPct != null ? m.fragileBurnedPct : m.fragilePct) || 0) };
    if (m.fragileFinalMul) return { kind: 'final', stat: null, per: Math.max(0, Number(m.fragileAddBurned) || 0.5) };
    if (m.fragileHealAddAlive !== undefined) return { kind: 'heal', stat: null, per: Math.max(0, Number(m.fragileHealAddBurned) || 0) };
    if (m.fragileCoinAddAlive !== undefined) return { kind: 'coin', stat: null, per: Math.max(0, Number(m.fragileCoinAddBurned) || 0) };
    return null;
  }

  function brandDefOfMark(mark) {
    if (!mark || !mark.kind) return null;
    for (const b of (D().BUFFS || [])) {
      const spec = markSpecOf(b);
      if (!spec || spec.kind !== mark.kind) continue;
      if (mark.kind === 'stat' && spec.stat !== mark.stat) continue;
      return b;
    }
    return null;
  }

  function brokenCopiesOf(run, def) {
    const spec = markSpecOf(def);
    if (!spec || !run) return 0;
    let n = 0;
    for (const m of (run.brokenMarks || [])) {
      if (!m || m.kind !== spec.kind) continue;
      if (spec.kind === 'stat' && m.stat !== spec.stat) continue;
      if (!m.legacy) { n += 1; continue; }
      const v = Number(spec.kind === 'stat' ? m.pct : m.burned) || 0;
      n += spec.per > 0 ? Math.round(v / spec.per) : (v > 0 ? 1 : 0);
    }
    return n;
  }
  // 收回一层已损毁（巡逻收缴：把这个烙印交出去）—— 与 loseRandomBrokenMark 同一套记账：
  // ⚠ 合计是从明细重算出来的：只改 run.fragileBurned 而不动明细，下一次重建就会把收回的那层加回来。
  function loseOneBrokenCopy(run, def) {
    const spec = markSpecOf(def);
    if (!spec || !run) return false;
    const marks = Array.isArray(run.brokenMarks) ? run.brokenMarks : (run.brokenMarks = []);
    const hit = (m) => m && m.kind === spec.kind && (spec.kind !== 'stat' || m.stat === spec.stat);
    let idx = marks.findIndex((m) => hit(m) && !m.legacy);
    if (idx >= 0) {
      marks.splice(idx, 1);
    } else {

      idx = marks.findIndex(hit);
      if (idx < 0) return false;
      const m = marks[idx];
      const cur = Number(spec.kind === 'stat' ? m.pct : m.burned) || 0;
      const left = Math.max(0, cur - spec.per);
      if (left <= 1e-9) marks.splice(idx, 1);
      else if (spec.kind === 'stat') m.pct = left;
      else m.burned = left;
    }
    if (spec.kind === 'final') run.fragileMulBurned = Math.max(0, Math.floor(Number(run.fragileMulBurned) || 0) - 1);
    rebuildFragileTotals(run);
    return true;
  }

  function returnBuffToPool(run, id) {
    if (!run || !id) return false;
    let changed = false;
    const refund = (key) => {
      const t = run[key];
      const cur = Math.max(0, Math.floor(Number(t && t[id]) || 0));
      if (cur <= 0) return;
      run[key] = Object.assign({}, t);
      if (cur - 1 > 0) run[key][id] = cur - 1; else delete run[key][id];
      changed = true;
    };
    refund('fragileGot');
    refund('pickGot');
    return changed;
  }

  function patrolTollRows(run) {
    if (!run) return [];
    const agg = Object.create(null);
    const touch = (id, def) => (agg[id] || (agg[id] = { id: id, def: def, row: null, alive: 0, broken: 0 }));

    for (const row of (run.permanent || []).concat(run.limited || [])) {
      const def = D().BUFF_BY_ID[row && row.id];
      if (!row || !def) continue;
      if (D().hasTag(def, 'hidden') || D().hasTag(def, 'story') || D().isBladeId(def.id) || def.kind === 'instant') continue;
      const stacks = Math.max(0, Math.floor(Number(row.stacks) || 0));
      if (stacks <= 0) continue;
      const a = touch(row.id, def);
      if (!a.row) a.row = row;
      a.alive += stacks;
    }

    for (const m of (run.brokenMarks || [])) {
      const def = brandDefOfMark(m);
      if (!def || D().hasTag(def, 'hidden')) continue;
      touch(def.id, def).broken = brokenCopiesOf(run, def);
    }
    const out = [];
    for (const id of Object.keys(agg)) {
      const a = agg[id];
      const stacks = a.alive + a.broken;
      if (stacks <= 0) continue;
      out.push({ ref: (a.row && a.row.uid != null) ? a.row.uid : ('brand:' + id), id: id,
        name: a.def.name, rarity: Number(a.def.rarity) || 0, cat: a.alive > 0 ? 'row' : 'brand',
        def: a.def, row: a.row, alive: a.alive, broken: a.broken, stacks: stacks,
        slotFree: a.row ? rowFreeOf(a.row) : false, enchMul: a.row ? rowEnchMulOf(a.row) : 1 });
    }

    const insc = Object.create(null);
    for (const row of (run.permanent || [])) {
      if (!row) continue;
      if (rowFreeOf(row)) insc.C37 = (insc.C37 || 0) + 1;
      for (const eid of rowEnchantsOf(row)) insc[eid] = (insc[eid] || 0) + 1;
    }
    for (const id of Object.keys(insc)) {
      const def = D().BUFF_BY_ID[id];
      // ⚠ 铭文一律可交：它们本来就带 `hidden` 标签（那只是「不进本局构筑面板、不可出售」的意思），
      // 不能照抄上面那条 hasTag(hidden) 过滤 —— 否则用户要的「交出虚空铭文」根本进不了候选。
      if (!def || def.kind !== 'inscription') continue;
      out.push({ ref: 'insc:' + id, id: id, name: def.name, rarity: Number(def.rarity) || 0, cat: 'insc',
        def: def, row: null, alive: insc[id], broken: 0, stacks: insc[id], slotFree: false, enchMul: 1 });
    }
    return out;
  }

  function patrolTollCandidates(runArg) {
    const run = runArg || endless().run;
    if (!run) return { top: -1, list: [] };
    const rows = patrolTollRows(run);
    if (!rows.length) return { top: -1, list: [] };
    const top = rows.reduce((a, x) => Math.max(a, x.rarity), 0);
    const list = rows.filter((x) => x.rarity === top).map((x) => ({
      ref: x.ref, id: x.id, name: x.name, rarity: x.rarity, kind: x.def.kind, cat: x.cat,
      stacks: Math.max(1, x.stacks), alive: x.alive, broken: x.broken,

      slotFree: x.slotFree === true, enchMul: x.enchMul,
    }));
    return { top: top, list: list };
  }

  function payPatrolToll(a, b) {
    const byRun = !!(a && typeof a === 'object');
    const run = byRun ? a : endless().run;
    const ref = byRun ? b : a;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    const all = patrolTollRows(run);
    const cand = all.find((x) => String(x.ref) === String(ref)) || all.find((x) => x.id === ref);
    if (!cand) return { ok: false, msg: '找不到这个增益。' };
    const def = cand.def || {};
    const stacks = Math.max(1, Math.floor(Number(cand.stacks) || 1));
    const note = () => {
      run.patrolTolls = (Array.isArray(run.patrolTolls) ? run.patrolTolls : [])
        .concat([{ id: cand.id, name: def.name || cand.id, stacks: stacks, rarity: Number(def.rarity) || 0, layer: run.layer }]);
    };

    if (cand.cat === 'insc') {
      note();
      const free = !!(def.mods && def.mods.pickPermanentFree);
      let undone = null;
      if (free) {
        const enchanted = (run.permanent || []).filter((b) => b && rowFreeOf(b));
        if (enchanted.length) {
          undone = enchanted[Math.floor(Math.random() * enchanted.length)];
          undone.slotFree = false;
          syncSlotFree(run);
        }
      } else {

        const marked = (run.permanent || []).filter((b) => b && rowEnchantsOf(b).indexOf(cand.id) >= 0);
        if (marked.length) {
          undone = marked[Math.floor(Math.random() * marked.length)];
          undone.enchants = rowEnchantsOf(undone).filter((x) => x !== cand.id);
          let mul = 1;
          for (const eid of undone.enchants) {
            const ed = D().BUFF_BY_ID[eid] || {};
            mul *= Math.max(1, Number(ed.mods && ed.mods.pickPermanentMul) || 1);
          }
          undone.enchMul = mul;
        }
      }
      logBuff(run, cand.id, 'lose', { detail: '巡逻收缴：随机取消一份附魔（' +
        (undone ? (D().BUFF_BY_ID[undone.id] || {}).name : '无') + '）' });
      save();

      const over = free && permUsed(run) > permSlots(run);
      if (over) run.phase = 'patrolDiscard';
      return { ok: true, id: cand.id, name: def.name, undone: undone ? undone.id : null, needDiscard: over };
    }

    if (cand.broken > 0) {
      note();
      const done = loseOneBrokenCopy(run, def);
      if (!done) return { ok: false, msg: '这一份已损毁的烙印已经找不到了。' };

      const back = !poolFilter(run, def) ? returnBuffToPool(run, cand.id) : false;
      logBuff(run, cand.id, 'lose', { detail: '巡逻收缴：已损毁层 -1' + (back ? '（已退回 buff 池）' : '') });
      save();
      return { ok: true, id: cand.id, name: def.name, broken: true, backToPool: back,
        left: Math.max(0, stacks - 1) };
    }

    const row = cand.row;
    const hit = findRowRef(run, row && row.uid != null ? row.uid : cand.id);
    if (!row || !hit || !hit.row) return { ok: false, msg: '找不到这个增益。' };
    note();
    row.stacks = stacks - 1;
    let removed = false;
    if (row.stacks <= 0) {
      hit.list.splice(hit.list.indexOf(row), 1);
      removed = true;
      syncSlotFree(run);
      resetGrowth(run, row.id, stacks, row);

      if (!poolFilter(run, def)) returnBuffToPool(run, cand.id);
    }
    logBuff(run, row.id, 'lose', { detail: '巡逻收缴 -1 层' + (removed ? '（已交出整栏）' : '') });

    notePatrolTollDoneStory(run);
    save();
    return { ok: true, id: row.id, name: def.name, left: Math.max(0, row.stacks || 0), removed: removed };
  }
  // 收缴结束（界面点「继续」）：清掉阶段，并推进到下一场。
  // 现在与胜利路径同一套推进：`run.idx + 1`；本层打完就 `layerClear()` —— 它自己会按
  // 刻意不做胜利路径的另外几件事：不扣限次（输了不给收益，也就不存在「白扣一次」）、
  function finishPatrolToll() {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };

    const wasToll = run.phase === 'patrolToll' || run.phase === 'patrolDiscard';
    run.phase = null;
    run.patrolTollAt = null;
    if (!wasToll) { save(); return { ok: true }; }
    run.idx = Math.max(0, Math.floor(Number(run.idx) || 0)) + 1;
    const out = { ok: true, patrol: true, advanced: true, battleNo: run.idx + 1 };
    if (run.idx >= run.plan.length) return layerClear('endless', run, out, 0, false);
    save();
    return out;
  }

  // x0 层的魔王：额外持有玩家此前上交过的所有增益（按上交时的快照生效）。
  function applyPatrolTollToFoe(run, foe) {
    const list = Array.isArray(run && run.patrolTolls) ? run.patrolTolls : [];
    if (!foe || !list.length) return 0;
    let n = 0;
    const names = [];
    for (const it of list) {
      const def = D().BUFF_BY_ID[it.id];
      const m = (def && def.mods) || null;
      if (!def || !m) continue;
      const k = Math.max(1, Math.floor(Number(it.stacks) || 1));
      if (isPureOpsBuff(def)) { names.push(def.name + '（运营类·不生效）'); continue; }

      if (m.shopSpendStep) {
        run.patrolShopGift = { step: Number(m.shopSpendStep) || 5, stat: Number(m.shopSpendStat) || 1,
          hp: Number(m.shopSpendHp) || 5 };
        names.push(def.name + '（生效：你在商店每消费 ' + (Number(m.shopSpendStep) || 5) + ' 试炼币，魔王就长一点）');
        n++;
        continue;
      }
      if (m.powerMul) foe.power = Math.max(1, Math.round(foe.power * (1 + m.powerMul * k)));
      if (m.agilityMul) foe.agility = Math.max(1, Math.round(foe.agility * (1 + m.agilityMul * k)));
      if (m.speedMul) foe.speed = Math.max(1, Math.round(foe.speed * (1 + m.speedMul * k)));
      if (m.maxHpMul) { foe.hp = Math.max(1, Math.round(foe.hp * (1 + m.maxHpMul * k))); foe.maxHp = foe.hp; }
      // ⚠ 暴击 / 减伤这类只能从 mods 读（见 sim 的 critChance 与 applyDamage），
      // 写成 foe.critBonus / foe.takenMul 这种裸字段根本没人读 —— 2026-10 第八十二批顺手修掉：
      foe.mods = foe.mods || {};
      if (m.critBonus) foe.mods.critBonus = Math.max(0, Number(foe.mods.critBonus) || 0) + m.critBonus * k;
      if (m.takenMul) foe.mods.takenMul = combineTakenMul(foe.mods.takenMul, m.takenMul * k);
      names.push(def.name);
      n++;
    }

    const gain = run.patrolFoeGain;
    if (gain) {
      foe.power = Math.max(1, Math.round(foe.power + (Number(gain.power) || 0)));
      foe.agility = Math.max(1, Math.round(foe.agility + (Number(gain.agility) || 0)));
      foe.speed = Math.max(1, Math.round(foe.speed + (Number(gain.speed) || 0)));
      if (Number(gain.hp) > 0) { foe.hp = Math.max(1, Math.round(foe.hp + Number(gain.hp))); foe.maxHp = foe.hp; }
      names.push('商店消费成长 +' + [gain.power, gain.agility, gain.speed, gain.hp].map((v) => Number(v) || 0).join('/'));
    }
    foe.tollBuffs = names;
    return n;
  }
  // 魔王额外命数 + x00 固定持有。
  // 死亡时回满血（100% 生命上限），并当场生命上限 +20%、受到伤害 −15%；
  // 第二件触发时这两项叠加（上限 +40%、减伤 30%）。于是它一共 3 条命。
  function applyDemonLordLives(foe, opts) {
    if (!foe) return null;
    const P = D().PATROL || {};
    const O = opts || {};
    const num = (v, fallback) => (v == null || !Number.isFinite(Number(v))) ? fallback : Number(v);
    const lives = Math.max(0, Math.floor(num(O.lives, P.bossLives) || 0));
    const brands = Math.max(0, Math.floor(num(O.brands, P.bossBrokenBrands) || 0));
    const perBrand = Math.max(0, num(O.perBrand, P.bossBrokenFinal) || 0);
    const healPct = Math.max(0, num(O.healPct, P.bossLifeHealPct) || 1);
    const lifeMaxHpMul = Math.max(0, num(O.maxHpMul, P.bossLifeMaxHpMul) || 0);
    const lifeTakenMul = num(O.takenMul, P.bossLifeTakenMul) || 0;
    foe.mods = Object.assign({}, foe.mods || {});
    // 命数直接摆回设计值（不是无脑追加）：
    // · 也是自愈 —— 万一上一次模拟/别的路径把命吃掉了几条，下一次 adjustMe 会把两条命摆回来；
    if (lives > 0) {
      const one = () => ({
        healPct: healPct,
        maxHpMul: lifeMaxHpMul,
        takenMul: lifeTakenMul,
        revive: true, bossLife: true, name: '涅槃+',
      });
      const list = [];
      for (let i = 0; i < lives; i++) list.push(one());
      const keep = (Array.isArray(foe.mods.deathSaves) ? foe.mods.deathSaves : []).filter((sv) => !(sv && sv.bossLife));
      foe.mods.deathSaves = list.concat(keep);
    }
    const mul = 1 + perBrand * brands;
    if (mul > 1) {
      const beforeMax = Math.max(1, Number(foe.maxHp) || 1);
      const ratio = Math.max(0, Math.min(1, (Number(foe.hp) || 1) / beforeMax));
      for (const k of ['power', 'agility', 'speed']) foe[k] = Math.max(1, Math.round((Number(foe[k]) || 1) * mul));
      foe.maxHp = Math.max(1, Math.round(beforeMax * mul));
      foe.hp = Math.max(1, Math.round(foe.maxHp * ratio));
      foe.brokenBrandFinalMul = mul;
    }
    foe.demonLives = lives + 1;
    return foe;
  }

  const PATROL_PURE_OPS_MODS = ['instantCoins', 'coinBoostPct', 'shopDiscount', 'sellValue',
    'sellGrowthPerWin', 'shopEnterCoins', 'instantRetry', 'rerollTiltMul', 'shopHalf',
    'postBattleShop', 'postBattleMintShop', 'postBattleShopDiscount', 'shopSpendLimited',
    'limitedDefaultRerollPaid', 'layerRestart', 'coinFragilePct'];
  function isPureOpsBuff(def) {
    const keys = Object.keys((def && def.mods) || {});
    if (!keys.length) return false;
    return keys.every((k) => PATROL_PURE_OPS_MODS.indexOf(k) >= 0);
  }
    function breakAllBrands(run) {
    const names = [];
    let total = 0;
    for (const row of (run && run.limited) || []) {
      if (!isBrandBuff(D().BUFF_BY_ID[row && row.id]) || row.on === false) continue;
      const n = breakBrandRow(run, row);
      if (n > 0) { names.push(D().BUFF_BY_ID[row.id].name + '×' + n); total += n; }
    }
    if (run && run.limited) run.limited = run.limited.filter((b) => Math.max(0, Math.floor(Number(b.stacks) || 0)) > 0);
    return { copies: total, names: names };
  }
  function rollFragileBuffs(run) {    const broken = [];
    run.limited = (run.limited || []).filter((b) => {
      const def = D().BUFF_BY_ID[b.id];
      const pct = def && def.mods && def.mods.fragileBreakPct;
      if (!pct || b.on === false) return true;

      const copies = Math.max(1, Math.floor(Number(b.stacks) || 1));
      for (let i = 0; i < copies; i++) {
        if (!fragileRoll(run, b, Number(pct))) continue;
        broken.push(def.name);
        breakOneFragileCopy(run, def, b);
        b.stacks = Math.max(0, Math.floor(Number(b.stacks) || 1) - 1);
        logBuff(run, b.id, 'break', { uid: b.uid, detail: '易碎损毁（这一份升级为全额并永久保留）' });
      }
      return (Math.floor(Number(b.stacks) || 0)) > 0;
    });
    return broken;
  }
  // 选取型强化（C32 神兵淬炼 / C33 秘技通神）被移除时，把它们的加成一起清掉。
  // 所有「失去这条增益」的路径都必须经过这里 —— 否则会出现
  function dropPickBoost(run, id) {
    if (!run) return false;
    if (id === 'C32') { run.weaponBoost = {}; return true; }
    if (id === 'C33') { run.skillBoost = {}; return true; }
    return false;
  }

  function resetGrowth(run, id, stacks, row) {
    if (!run) return false;
    const n = Math.max(1, Math.floor(Number(stacks) || 1));
    // · 有 → 只扣它那一份（同名其它栏不受影响）；
    // （`run.growByRow`），也必须按逐栏处理 —— 它自己的成长是 0，卖掉时只扣 0，
    // 不能把 run 级合计清零（否则另一本账本的累计会被一起抹掉）。
    const hasLedger = !!(row && row.grow && Object.keys(row.grow).length);
    const perRow = !!row && (hasLedger || (!!run.growByRow && id === 'C25'));
    const rowGrow = (key) => (perRow ? growOf(row, key) : 0);
    if (id === 'C06') {
      if (perRow) subGrow(run, row, 'killPower'); else run.killPower = 0;
    }
    else if (id === 'C07') {
      const v = perRow ? rowGrow('winMaxHp') : Math.max(0, Number(run.winMaxHp) || 0);
      run.hpBonus = Math.max(0, Number(run.hpBonus) || 0) + v;
      if (perRow) subGrow(run, row, 'winMaxHp'); else run.winMaxHp = 0;
    }
    else if (id === 'C11') {
      const flat = perRow ? rowGrow('winHpFlat') : Math.max(0, Number(run.winHpFlat) || 0);
      const base = Math.max(1, Number(run.baseMaxHp) || 0);
      run.hpBonus = Math.max(0, Number(run.hpBonus) || 0) + (base > 0 ? flat / base : 0);
      if (perRow) subGrow(run, row, 'winHpFlat'); else run.winHpFlat = 0;
    }
    else if (id === 'C12') {
      if (perRow) { subGrow(run, row, 'winStatPower'); subGrow(run, row, 'winStatAgility'); subGrow(run, row, 'winStatSpeed'); }
      else { run.winStatPower = 0; run.winStatAgility = 0; run.winStatSpeed = 0; }
    }
    // 选取型强化（C32 神兵淬炼 / C33 秘技通神）：加成是绑在这条增益身上的，
    // 卖出/被替换时必须一起清掉，否则「加成还在、增益已经没了」——
    else if (id === 'C32' || id === 'C33') dropPickBoost(run, id);

    else if (id === 'C25') { if (perRow) subGrow(run, row, 'sellBonus'); else run.sellBonus = 0; }
    // 天命所归（C51）：永久件被卖出/替换，稀有度加成也要一起收回（否则「加成还在、增益没了」）。
    else if (id === 'C51') run.rarityBoost = Math.max(0, Math.floor(Number(run.rarityBoost) || 0) - n);
    else if (id === 'C36') {
      if (!perRow) {
        run.spendGain = { power: 0, agility: 0, speed: 0, hp: 0 };
        run.shopSpend = 0; run.shopSpendProcs = 0;
        clearSpendProgress(run, 'C36');
      }
    }
    else {
      const def = D().BUFF_BY_ID[id];
      if (def && def.mods && def.mods.fragileStat) {

        const key = def.mods.fragileStat;
        const pct = Math.max(0, Number(def.mods.fragilePct) || 0);
        run.fragileBase = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBase || {});
        run.fragileBase[key] = Math.max(0, run.fragileBase[key] - pct * n);
        return true;
      }
      // 终乘（C49）/ 治疗（C52）/ 淘金（C53）烙印：主动失去时把未破碎的那一份按层数收回 ——
      // 与「现在还持有几份」无关（否则卖掉再买回来就能绕开层数上限）。
      if (def && def.mods && def.mods.fragileFinalMul) {
        run.fragileMulBase = Math.max(0, Math.floor(Number(run.fragileMulBase) || 0) - n);
        return true;
      }
      if (def && def.mods && def.mods.fragileHealAddAlive !== undefined) {

        run.fragileHealBase = Math.max(0, Math.floor(Number(run.fragileHealBase) || 0) - n);
        return true;
      }
      if (def && def.mods && def.mods.fragileCoinAddAlive !== undefined) {
        run.fragileCoinBase = Math.max(0, Math.floor(Number(run.fragileCoinBase) || 0) - n);
        return true;
      }
      return false;
    }
    return true;
  }

  // 「获得这个增益时」立刻要结算的东西（新增与叠加两条路径都要走）。
  // · 生命上限增益：按字面「回复等量生命」—— 新上限比旧上限多出来的部分补进当前血量
  function applyBuffOnAcquire(run, buff) {
    // 天命所归（C51）：2026-10 起由即时改为永久，而 permanent 不经过 applyInstant ——
    // 所以稀有度加成必须在「获得时」写进 run.rarityBoost（数量就是本局的加成层数）。
    if (buff.mods && buff.mods.rarityBoost) {
      run.rarityBoost = Math.max(0, Math.floor(Number(run.rarityBoost) || 0)) + 1;
    }
    // 永久增益的生命上限加成是粘性的（拿到就折算进 run.hpBonus，卖掉不回落），
    // 否则第 2/3 层会白拿（只有开新栏位那条路才会加）。
    if (buff.kind === 'permanent' && buff.mods && buff.mods.maxHpMul) {
      run.hpBonus = Math.max(0, Number(run.hpBonus) || 0) + Number(buff.mods.maxHpMul);
    }
    // 终乘烙印：每获得一份就 +1 层（没有次数上限，重复获得按层加算）。
    if (buff.mods && buff.mods.fragileFinalMul) {
      run.fragileMulBase = Math.max(0, Math.floor(Number(run.fragileMulBase) || 0)) + 1;
    }
    if (buff.mods && buff.mods.fragileHealAddAlive !== undefined) {
      run.fragileHealBase = Math.max(0, Math.floor(Number(run.fragileHealBase) || 0)) + 1;
    }
    if (buff.mods && buff.mods.fragileStat) {
      const key = buff.mods.fragileStat;
      run.fragileBase = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBase || {});
      run.fragileBurned = Object.assign({ power: 0, agility: 0, speed: 0 }, run.fragileBurned || {});
      run.fragileBase[key] += Math.max(0, Number(buff.mods.fragilePct) || 0);
    }
    if (buff.mods && buff.mods.fragileBreakPct) {
      run.fragileGot = Object.assign({}, run.fragileGot || {});
      run.fragileGot[buff.id] = Math.max(0, Math.floor(Number(run.fragileGot[buff.id]) || 0)) + 1;

      if (buff.mods.fragileCoinAddAlive !== undefined) {
        run.fragileCoinBase = Math.max(0, Math.floor(Number(run.fragileCoinBase) || 0)) + 1;
      }
      run.fragileSeeds = Object.assign({}, run.fragileSeeds || {});

      run.achievements = Array.isArray(run.achievements) ? run.achievements.slice(0, 40) : [];
      run.scoreLog = Array.isArray(run.scoreLog) ? run.scoreLog.slice(-60) : [];
      run.statPeaks = Object.assign({}, run.statPeaks || {});
      run.pendingToasts = Array.isArray(run.pendingToasts) ? run.pendingToasts.slice(0, 12) : [];
      run.deathSaves = Math.max(0, Math.floor(Number(run.deathSaves) || 0));
      run.reviveCount = Math.max(0, Math.floor(Number(run.reviveCount) || 0));
      run.reviveTierPaid = Math.max(0, Number(run.reviveTierPaid) || 0);
    }
    if (buff.mods && buff.mods.shopDiscount) {
      run.shopDiscount = Math.max(0, Math.floor(Number(run.shopDiscount) || 0)) + 1;
      run.shopDiscountPct = Math.max(Number(run.shopDiscountPct) || 0, Number(buff.mods.shopDiscount) || 0);
    }
    // E01「立即进货」不再往 run 上写缓存：它的效果（战后开店 + 5 折）由

    if (buff.mods && buff.mods.healOnGainPct) {
      healAbs(run, Number(buff.mods.healOnGainPct) * globalMul(run) * healBonusMul(run), currentMaxHp(run));
    }
  }
  // 获得顺序号：商店的「出售增益 / 免费交换」列表要按获得先后倒序排，
  function nextAcqSeq(run) {
    run.acqSeq = Math.max(0, Math.floor(Number(run.acqSeq) || 0)) + 1;
    return run.acqSeq;
  }
  // 同名增益可以并排占多个背包栏位（任务3 起），于是「同名」不再等于「同一条」：
  // · 不同叠层类的同名件各有各的层数，不能互相借用；
  // · 虚空铭文附魔只作用于被点的那一条，不能把同名的另一条也标成「已附魔（不占位）」。
  function nextUid(run) {
    run.rowUidSeq = Math.max(0, Math.floor(Number(run.rowUidSeq) || 0)) + 1;
    return run.rowUidSeq;
  }
  function rowFreeOf(row) { return !!(row && row.slotFree === true); }
  // 一条永久增益可以吃多个不同铭文，但同一张铭文不能重复附在同一条上：
  // · 虚空铭文 C37（`pickPermanentFree`）→ 该条不占永久槽位（沿用旧的 slotFree 字段）；
  function rowEnchantsOf(row) { return (row && Array.isArray(row.enchants)) ? row.enchants : []; }
  function rowEnchMulOf(row) { const m = Number(row && row.enchMul); return Number.isFinite(m) && m > 0 ? m : 1; }
  // 某张铭文能不能附在这一条上（同一条上同一张铭文只能附一次）。
  function rowInscriptionFree(row, inscriptionId) {
    if (!row) return false;
    if (!inscriptionId) return true;
    return rowEnchantsOf(row).indexOf(inscriptionId) < 0;
  }

  function markRowInscription(run, row, inscriptionId, mul) {
    if (!run || !row) return null;
    const id = String(inscriptionId || '');
    if (!rowInscriptionFree(row, id)) return null;
    row.enchants = rowEnchantsOf(row).concat([id]);
    const m = Number(mul);
    if (Number.isFinite(m) && m > 0) row.enchMul = rowEnchMulOf(row) * m;
    return row;
  }
  // 把镜像字段同步成「被附魔行的 id 去重」。
  function syncSlotFree(run) {
    if (!run) return;
    const ids = [];
    for (const row of (run.permanent || [])) {
      if (rowFreeOf(row) && ids.indexOf(row.id) < 0) ids.push(row.id);
    }
    run.slotFreeIds = ids;
  }

  function findRow(run, ref) {
    const list = (run && run.permanent) || [];
    const n = Math.floor(Number(ref) || 0);
    if (n > 0) { const byUid = list.find((b) => b && Number(b.uid) === n); if (byUid) return byUid; }
    return list.find((b) => b && b.id === ref) || null;
  }

  function enchantEligible(row, run) {
    if (!row) return false;
    if (rowFreeOf(row)) return true;
    return !(run.permanent || []).some((b) => b && b.id === row.id && rowFreeOf(b));
  }
  // 一次附魔选取（pendingPick.kind === 'permBuff'）的合法候选判据 —— 按铭文种类分派：
  // · 增幅铭文（效果倍率）：同一张铭文不能重复附在同一条上（否则倍率会叠乘），
  function inscriptionEligible(row, run, inscriptionId) {
    const buff = D().BUFF_BY_ID[inscriptionId];
    const free = !!(buff && buff.mods && buff.mods.pickPermanentFree);
    if (free) return enchantEligible(row, run);
    return rowInscriptionFree(row, inscriptionId);
  }

  function markRowFree(run, row) {
    if (!run || !row) return null;
    row.slotFree = true;
    syncSlotFree(run);
    return row;
  }
  // 铭文附魔的落地：C37 免占位、C60 效果 ×倍率。返回给界面用的摘要。
  // · 增幅铭文：记 `enchants` + 乘倍率，同一张铭文不能重复附在同一条上。
  function applyInscription(run, row, inscriptionId, mul) {
    const buff = D().BUFF_BY_ID[inscriptionId];
    if (buff && buff.mods && buff.mods.pickPermanentFree) {
      markRowFree(run, row);
      return { slotFree: true, enchMul: rowEnchMulOf(row) };
    }
    const m = mul != null ? mul : (buff && buff.mods && buff.mods.pickPermanentMul) || 0;
    if (!markRowInscription(run, row, inscriptionId, m)) return null;
    return { slotFree: rowFreeOf(row), enchMul: rowEnchMulOf(row), enchants: rowEnchantsOf(row).slice() };
  }
  // 加一个 buff。永久类要过 5 格上限（满则返回 needsReplace，由界面选一个替换）。
  function addBuff(run, id, replaceId, opts) {
    const buff = D().BUFF_BY_ID[id];
    if (!buff) return { ok: false, msg: '没有这个增益' };
    if (D().hasTag(buff, 'hero') && !isHeroRun(run)) return { ok: false, msg: '仅勇者模式可获得。' };
    if (buff.kind === 'instant') {

      if (buff.maxStacks && instantOwnedCount(run, id) >= Math.max(1, Math.floor(buff.maxStacks))) {
        return { ok: false, msg: '【' + buff.name + '】一局只能获得一次。' };
      }
      bumpInstant(run, id);
      const r = applyInstant(run, buff, opts);
      logBuff(run, id, 'instant', { detail: instantDetail(buff) });
      return r;
    }

    if (buff.mods && (buff.mods.pickWeaponPct || buff.mods.pickSkillPct)) {
      if (!D().hasTag(buff, 'repeatable') && (run.pickBuffIds || []).includes(buff.id)) {
        return { ok: false, msg: '这类选取增益一局只能获得一次。' };
      }
      run.pickBuffIds = (run.pickBuffIds || []).concat([buff.id]);
      notePickGot(run, buff.id);
      const pickKindW = buff.mods.pickWeaponPct ? 'weapon' : 'skill';
      logBuff(run, id, 'get', { detail: '选取型（待选目标）' });
      save();

      if (!hasPickTargets(run, pickKindW)) return deferPick(run, buff, pickKindW);
      run.pendingPick = pickKindW === 'weapon'
        ? { kind: 'weapon', buffId: buff.id, pct: buff.mods.pickWeaponPct }
        : { kind: 'skill', buffId: buff.id, pct: buff.mods.pickSkillPct };
      save();
      return { ok: true, pendingPick: run.pendingPick };
    }
    // 铭文类（kind: 'inscription'）：不占栏位，只登记「待选一条永久增益」。
    // 两种铭文共用这一条路径，差别在落地时（见 applyInscription）：
    if (buff.mods && (buff.mods.pickPermanentFree || buff.mods.pickPermanentMul)) {
      if (!D().hasTag(buff, 'repeatable') && (run.pickBuffIds || []).includes(buff.id)) {
        return { ok: false, msg: '这类选取增益一局只能获得一次。' };
      }
      run.pickBuffIds = (run.pickBuffIds || []).concat([buff.id]).filter((v, i, a) => a.indexOf(v) === i);
      notePickGot(run, buff.id);
      logBuff(run, id, 'get', { detail: buff.name + '（待选永久增益）' });
      save();
      // 没有可选目标（一条永久增益都没有）→ 不要挂 pendingPick：挂了界面每次都弹同一个
      if (!hasPickTargets(run, 'permBuff', buff.id)) return deferPick(run, buff, 'permBuff');
      run.pendingPick = { kind: 'permBuff', buffId: buff.id };
      if (buff.mods.pickPermanentMul) run.pendingPick.mul = Number(buff.mods.pickPermanentMul) || 0;
      return { ok: true, pendingPick: run.pendingPick };
    }

    if (buff.mods && (buff.mods.pickBrandBreak || buff.mods.pickLimitedUses)) {
      if (!D().hasTag(buff, 'repeatable') && (run.pickBuffIds || []).includes(buff.id)) {
        return { ok: false, msg: '这类选取增益一局只能获得一次。' };
      }
      run.pickBuffIds = (run.pickBuffIds || []).concat([buff.id]).filter((v, i, a) => a.indexOf(v) === i);
      notePickGot(run, buff.id);
      const pickKind = buff.mods.pickBrandBreak ? 'brandBuff' : 'limitedBuff';
      logBuff(run, id, 'get', { detail: buff.name + '（待选目标）' });
      save();
      // 同上：没有可选的烙印 / 限次增益时不挂 pendingPick（否则弹窗永远关不掉）。
      if (!hasPickTargets(run, pickKind, buff.id)) return deferPick(run, buff, pickKind);
      run.pendingPick = pickKind === 'brandBuff'
        ? { kind: 'brandBuff', buffId: buff.id }
        : { kind: 'limitedBuff', buffId: buff.id, addUses: Math.max(1, Math.floor(Number(buff.mods.pickLimitedUses) || 1)) };
      save();
      return { ok: true, pendingPick: run.pendingPick };
    }

    if (buff.mods && buff.mods.permSlot) {
      if ((run.permSlotIds || []).includes(buff.id)) return { ok: false, msg: '这类扩容增益一局只能获得一次。' };
      run.permSlots = Math.max(0, Number(run.permSlots) || 0) + Number(buff.mods.permSlot);
      run.permSlotIds = (run.permSlotIds || []).concat([buff.id]);
      logBuff(run, id, 'get', { detail: '永久槽位 +' + Number(buff.mods.permSlot) });
      return { ok: true, granted: buff.mods.permSlot };
    }
    const listKey = buff.kind === 'permanent' ? 'permanent' : 'limited';
    const list = run[listKey] || (run[listKey] = []);

    let owned = null;
    for (const b of list) { if (b && b.id === id) owned = b; }

    let restackSlot = false;
    if (owned) {
      // 叠层上限：该增益自己的 maxStacks（可叠层的），否则全局 STACK_MAX。
      const cap = D().stackCap(buff);
      restackSlot = owned.stacks >= cap;
      // 限次类：同名再获得 = 直接把份数加到场次上。
      // 但一买就被这里拒掉「已经叠满了（上限 1 层）」—— 于是「持有时还能刷新」等于白刷。
      const usesOnly = usesStackable(buff);
      if (usesOnly && restackSlot) {
        const addUses = Math.max(1, Math.floor(Number(buff.uses) || 1));
        owned.uses = Math.max(0, Math.floor(Number(owned.uses) || 0)) + addUses;
        owned.on = true;
        applyBuffOnAcquire(run, buff);
        logBuff(run, id, 'stack', { stacks: owned.stacks, detail: '场次 +' + addUses + '（共 ' + owned.uses + '）' });
        save();
        return { ok: true, buff: buff, stacks: owned.stacks, uses: owned.uses, addedUses: addUses };
      }

      if (restackSlot && !permanentRestackable(buff)) {
        return { ok: false, msg: '【' + buff.name + '】已经叠满了（上限 ' + cap + ' 层）。' };
      }
      if (!restackSlot) {
      owned.stacks = Math.min(cap, owned.stacks + 1);

      if (buff.kind === 'limited') { if (run.mode !== 'tower') owned.uses += buff.uses || 1; owned.on = true; }
      applyBuffOnAcquire(run, buff);
      logBuff(run, id, 'stack', { stacks: owned.stacks, detail: '叠到 ×' + owned.stacks });
      return { ok: true, buff, stacks: owned.stacks };
      }

    }
    // 满格判定按加入后的占用：占位类增益会 +1，所以只要 permUsed + 1 > 上限就得替换。

    if (occupiesPermSlot(buff) && permUsed(run) + 1 > permSlots(run)) {
      if (!replaceId) return { ok: false, needsReplace: true, buff, msg: '永久增益已满，先选一个替换掉' };
      // `replaceId` 优先当 uid（精确替换被点的那一条）；否则按 id 取最后一条。
      const rn = Math.floor(Number(replaceId) || 0);
      let at = -1;
      if (rn > 0) at = list.findIndex((b) => b && Number(b.uid) === rn);
      if (at < 0) at = list.findIndex((b) => b && b.id === replaceId);
      if (at < 0) return { ok: false, needsReplace: true, buff, msg: '要替换的增益不存在' };
      const replacedRow = list[at];
      const replacedId = replacedRow.id;
      const replacedStacks = Math.max(1, Math.floor(Number(replacedRow && replacedRow.stacks) || 1));

      if (rowFreeOf(replacedRow)) {
        return { ok: false, needsReplace: true, buff, msg: '【' + replacedId + '】已被虚空铭文附魔、不占槽位，换它腾不出位置' };
      }
      list.splice(at, 1);
      resetGrowth(run, replacedId, replacedStacks, replacedRow);
      // 只移除被替换的那一条：不要去清同名的其它栏位的附魔标记。
      syncSlotFree(run);
      logBuff(run, replacedId, 'lose', { detail: '被【' + buff.name + '】替换掉' });
    }
    applyBuffOnAcquire(run, buff);

    const towerLimitedUses = run.mode === 'tower' ? 1 : (buff.uses || 1);
    list.push(buff.kind === 'limited'
      ? { id, stacks: 1, uses: towerLimitedUses, on: true, at: nextAcqSeq(run), uid: nextUid(run) }
      : { id, stacks: 1, at: nextAcqSeq(run), uid: nextUid(run) });
    // 自检：加入后占用不应超过上限（前面已按「加入后占用」判定过，正常不会触发）。
    if (buff.kind === 'permanent' && permUsed(run) > permSlots(run)
        && typeof console !== 'undefined' && console.warn) {
      console.warn('[tower] 永久增益占用槽位超上限：' + permUsed(run) + '/' + permSlots(run) + '（id=' + id + '）');
    }
    logBuff(run, id, 'get', { detail: restackSlot
      ? '新栏位（原栏位已叠满，继续叠加）'
      : (buff.kind === 'permanent' ? '永久' : (run.mode === 'tower' ? '下一场战斗' : ('限次 ' + towerLimitedUses + ' 场'))) });

    const resumed = resolveDeferredPicks(run);
    if (resumed) save();
    return { ok: true, buff, resumedPick: resumed || undefined };
  }

  function applyInstant(run, buff, opts) {
    if (D().hasTag(buff, 'hero')) return applyHeroGoods(run, buff, opts);

    if (buff.mods && buff.mods.rarityBoost) {
      run.rarityBoost = Math.max(0, Math.floor(Number(run.rarityBoost) || 0)) + 1;
      return { ok: true, msg: '本局稀有度提升已生效（' + run.rarityBoost + ' 层）', rarityBoost: run.rarityBoost };
    }
    const m = buff.mods || {};
    const out = { ok: true, buff, instant: true };
    if (m.instantCoins) {
      run.coins = Math.max(0, (run.coins || 0) + m.instantCoins);
      noteRunIncome(run, 'trialCoinsEarned', m.instantCoins);
      out.coins = m.instantCoins;
    }
    // 即时削弱 —— 累加到本局全局，下一场 buildFoe 起对所有敌人生效。
    // E07/E08 削生命上限（enemyMaxHpDown）、E11「挫锋」削攻击力（enemyPowerDown）。
    if (m.enemyMaxHpDown) {
      run.enemyMaxHpDown = Math.min(ENEMY_MAXHP_DOWN_CAP, Math.max(0, Number(run.enemyMaxHpDown) || 0) + Number(m.enemyMaxHpDown));
      out.enemyMaxHpDown = run.enemyMaxHpDown;
    }
    if (m.enemyPowerDown) {
      run.enemyPowerDown = Math.min(0.8, Math.max(0, Number(run.enemyPowerDown) || 0) + Number(m.enemyPowerDown));
      out.enemyPowerDown = run.enemyPowerDown;
    }
    if (m.instantRetry) {
      run.retryToken = Math.max(0, Number(run.retryToken) || 0) + Number(m.instantRetry);
      noteRunIncome(run, 'mintEarned', m.instantRetry);
      out.retryToken = run.retryToken;
    }

    if (m.shopHalf) {
      const add = Math.max(1, Math.floor(Number(m.shopHalf) || 1));
      run.shopHalfPending = Math.max(0, Math.floor(Number(run.shopHalfPending) || 0)) + add;
      out.shopHalfPending = run.shopHalfPending;
    }

    if (m.breakAllBrands) {
      const r = breakAllBrands(run);
      out.brokenBrands = r.copies;
      out.brokenNames = r.names;
      out.msg = r.copies > 0
        ? '所有烙印立刻破碎：' + r.names.join('、') + '（共 ' + r.copies + ' 份，已升级为全额并永久保留）'
        : '当前没有可破碎的烙印。';
    }
    if (m.shopDiscount) {
      // 即时类（E04 steam大促）走这条分支，不经过 applyBuffOnAcquire ——
      // 所以折扣比例必须在这里也记一份，否则 makeShop 只能退回默认的 5 折。
      run.shopDiscount = Math.max(0, Math.floor(Number(run.shopDiscount) || 0)) + 1;
      run.shopDiscountPct = Math.max(Number(run.shopDiscountPct) || 0, Number(m.shopDiscount) || 0);
      out.discount = m.shopDiscount;
    }
    if (m.openShop) {
// 【100 层循环】整百层不开店：makeShop 会返回 null，这里必须判空再挂标记。
      run.shop = makeShop(run);
      if (run.shop) {
        run.shop.postBattle = true;
        run.phase = 'shop';
        out.shop = true;
      }
    }
    save();
    return out;
  }
  // 限次增益的开关。`ref` 优先当 uid（精确切那一条），否则按 id 取第一条。
  function toggleLimited(ref, on) {
    const run = endless().run;
    if (!run) return { ok: false };
    const n = Math.floor(Number(ref) || 0);
    const list = run.limited || [];
    const b = (n > 0 ? list.find((x) => x && Number(x.uid) === n) : null)
      || list.find((x) => x.id === ref);
    if (!b) return { ok: false };
    if (D().isBladeId(b.id)) {
      if (run.bladeSacrificePending) return { ok: false, msg: '先完成这次献祭，再决定剑的开关。' };
      const want = on === undefined ? b.on === false : !!on;
      if (!want && b.forced === true) return { ok: false, msg: '渴血之剑正在强制苏醒，无法关闭。' };
    }
    b.on = on === undefined ? b.on === false : !!on;
    save();
    return { ok: true, id: b.id, uid: b.uid, on: b.on };
  }


  const PICKABLE_DEFENSE = [16, 7];
  const isPickableDefense = (id) => PICKABLE_DEFENSE.indexOf(Number(id)) >= 0;
  const PICKABLE_COSMOS = 14;
  const isPickableCosmos = (id) => Number(id) === PICKABLE_COSMOS;

  const COSMOS_PICK_BOOST = 1;
  const DEFENSE_PICK_BOOST = 2.0;
  const JUE_DUI_PICK_BOOST = 1.5;
  const defensePickBoostOf = (id) => (Number(id) === 16 ? JUE_DUI_PICK_BOOST : DEFENSE_PICK_BOOST);

  const PICK_NOTE = { 14: '开战第一招必放', 16: '触发概率提升', 7: '触发概率提升' };


  function grantRunSkill(run, id) {
    const n = Number(id);
    if (!run || isHeroRun(run) || !(n > 0)) return false;
    run.grantedSkills = Array.isArray(run.grantedSkills) ? run.grantedSkills : [];
    if (run.grantedSkills.some((x) => Number(x) === n)) return false;
    run.grantedSkills.push(n);
    return true;
  }
  const ownsSkill = (run, id) => {
    const sid = Number(String(id).split(':')[0]);
    if (((isHeroRun(run) ? run.hero : S()).skills || [])
      .some((sk) => Number(String(sk).split(':')[0]) === sid)) return true;
    return !!(run && Array.isArray(run.grantedSkills) && run.grantedSkills.some((x) => Number(x) === sid));
  };

  // 这一次「附魔三选一」到底是哪张铭文触发的 —— 候选、可行性与界面标记共用这一个出口。
  // ⚠ 不要在这里调 `endless()`：`endless()` 会走 normalizeRun → parkStalePendingPick →
  function activeInscriptionId(kind, run, pending) {
    const pend = pending || (run && run.pendingPick) || null;
    if (pend && pend.kind === kind && pend.buffId) return pend.buffId;
    const def = (run && Array.isArray(run.deferredPicks) ? run.deferredPicks : [])
      .find((x) => x && x.kind === kind);
    if (def && def.buffId) return def.buffId;
    return kind === 'permBuff' ? 'C37' : null;
  }

  function pickableSkillId(id) {
    const map = (typeof skillsMap !== 'undefined' && skillsMap) ? skillsMap : (window.skillsMap || null);
    const it = map && map.getValue ? map.getValue(Number(id)) : null;
    const t = it && it.type ? String(it.type) : '';
    if (t === '主动') return true;
    return isPickableDefense(Number(id)) || isPickableCosmos(Number(id));
  }
  function pickCandidates(kind) {
    const run = endless().run;
    if (!run) return [];
    if (kind === 'permBuff') {

      const inscriptionId = activeInscriptionId('permBuff', run) || 'C37';
      const pool = (run.permanent || [])
        .map((b) => ({ id: b.id, uid: b.uid, buff: D().BUFF_BY_ID[b.id], stacks: b.stacks || 1, free: rowFreeOf(b),
          enchMul: rowEnchMulOf(b), enchants: rowEnchantsOf(b).slice() }))
        .filter((x) => x.buff && !D().hasTag(x.buff, 'hidden'))

        .filter((x) => inscriptionEligible((run.permanent || []).find((r) => r && Number(r.uid) === Number(x.uid)), run, inscriptionId));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }

      return pool.slice(0, 3).map((x) => ({ id: x.id, uid: x.uid, name: x.buff.name, rarity: x.buff.rarity,
        stacks: x.stacks, slotFree: x.free, enchMul: x.enchMul, enchants: x.enchants }));
    }

    // 延续 / 碎裂铭文的候选：只看「还在手里」（有未用尽的份数），
    // 延续铭文也必须能选到它 —— 关掉只是「这场先不用」，不代表这条增益不存在）。
    if (kind === 'brandBuff' || kind === 'limitedBuff') {
      const wantBrand = kind === 'brandBuff';
      const list = (run.limited || [])
        .filter((row) => row && Math.max(0, Math.floor(Number(row.stacks) || 0)) > 0)

        .filter((row) => !(D().BUFF_BY_ID[row.id] || {}).noExtend)
        // 渴血之剑的场次是阶段生命线：不能被延续铭文 +5（否则进化节奏被打乱）。
        .filter((row) => !D().isBladeId(row.id))
        .filter((row) => {
          const def = D().BUFF_BY_ID[row.id];
          if (!def) return false;
          return wantBrand ? isBrandBuff(def) : !isBrandBuff(def);
        })
        .map((row) => ({ uid: row.uid, id: row.id, name: (D().BUFF_BY_ID[row.id] || {}).name || row.id,
          rarity: (D().BUFF_BY_ID[row.id] || {}).rarity || 0, stacks: Math.max(1, Math.floor(Number(row.stacks) || 1)),
          uses: Math.max(0, Math.floor(Number(row.uses) || 0)), off: row.on === false }));
      const pool = list.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      return pool.slice(0, 3);
    }
    // 秘技通神（C33）：只抽主动技能，外加两条特殊技能 —— 防御被动（绝对防御/龟甲术）
    // ⚠ 判据抽到模块级（`pickableSkillId`）：`hasPickTargets('skill')` 必须与这里的候选同口径，
    // 否则又会出现「判定说有目标、界面候选 0 个」的弹窗死循环。
    let list;
    if (kind === 'skill') {
      list = runSkills(run).filter((sk) => sk && pickableSkillId(sk.id));

      const have = new Set(list.map((sk) => Number(sk.id)));
      const map = (typeof skillsMap !== 'undefined' && skillsMap) ? skillsMap : (window.skillsMap || null);
      for (const id of PICKABLE_DEFENSE.concat([PICKABLE_COSMOS])) {
        if (have.has(id)) continue;
        const it = map && map.getValue ? map.getValue(id) : null;
        if (it) list = list.concat([{ id: id, level: 1, name: it.name, type: it.type }]);
      }

      list = list.map((sk) => {
        const note = PICK_NOTE[Number(sk.id)];
        return note ? Object.assign({}, sk, { note: note }) : sk;
      });
    } else {
      list = runWeapons(run);
    }
    const pool = list.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, 3);
  }

  function applyPickBuff(kind, id) {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    // `pendingPick` 为空时，允许退回「留着等目标」的那一条（deferredPicks）——
    // 那种情况下候选与拒绝理由仍然要按那张铭文的规则算（否则「同一张铭文不能重复附」
    let pend = run.pendingPick;
    if ((!pend || pend.kind !== kind) && ['permBuff', 'brandBuff', 'limitedBuff'].indexOf(kind) >= 0) {
      const def = (Array.isArray(run.deferredPicks) ? run.deferredPicks : []).find((x) => x && x.kind === kind);
      if (def) pend = def;
    }
    if (!pend || pend.kind !== kind) return { ok: false, msg: '现在没有待选取的强化。' };
    if (kind === 'permBuff') {

      const row = findRow(run, id);
      if (!row) return { ok: false, msg: '你还没有这个永久增益。' };
      const inscriptionId = pend.buffId || 'C37';
      if (!inscriptionEligible(row, run, inscriptionId)) {
        const isFree = !!(D().BUFF_BY_ID[inscriptionId] || {}).mods && !!(D().BUFF_BY_ID[inscriptionId] || {}).mods.pickPermanentFree;
        return { ok: false, msg: isFree
          ? '【' + (D().BUFF_BY_ID[row.id] || {}).name + '】已经有一条被虚空铭文附魔了 —— 同名件里只能附魔一条，这一条不行。'
          : '【' + (D().BUFF_BY_ID[row.id] || {}).name + '】这一条已经吃过这张铭文了 —— 同一张铭文不能重复附在同一条上。' };
      }
      const r = applyInscription(run, row, inscriptionId, pend.mul);
      run.pickBuffIds = (run.pickBuffIds || []).concat([inscriptionId]).filter((v, i, a) => a.indexOf(v) === i);
      run.pendingPick = null;
      save();
      return { ok: true, kind, id: row.id, uid: row.uid, slotFree: rowFreeOf(row), enchMul: rowEnchMulOf(row),
        inscription: inscriptionId, enchants: (r && r.enchants) || rowEnchantsOf(row) };
    }

    if (kind === 'brandBuff' || kind === 'limitedBuff') {
      const row = (run.limited || []).find((b) => b && Number(b.uid) === Number(id)) ||
        (run.limited || []).find((b) => b && b.id === id);
      if (!row) return { ok: false, msg: '你还没有这个增益。' };
      const def = D().BUFF_BY_ID[row.id] || {};
      if (kind === 'brandBuff') {
        if (!isBrandBuff(def)) return { ok: false, msg: '只能对烙印使用。' };
        const n = breakBrandRow(run, row);
        run.limited = (run.limited || []).filter((b) => Math.max(0, Math.floor(Number(b.stacks) || 0)) > 0);
        run.pickBuffIds = (run.pickBuffIds || []).concat([pend.buffId || 'C61']).filter((v, i, a) => a.indexOf(v) === i);
        run.pendingPick = null;
        save();
        return { ok: true, kind, id: row.id, uid: row.uid, broken: n, name: def.name };
      }
      if (isBrandBuff(def)) return { ok: false, msg: '烙印类限次增益不能用延续铭文。' };
      // （`noExtend`）—— 候选那边已经过滤掉了，这里再挡一道（老存档 / 直接调 API）。
      if (def.noExtend) return { ok: false, msg: '【' + (def.name || row.id) + '】是流程类增益，延续铭文不能延长它。' };
      const add = Math.max(1, Math.floor(Number(pend.addUses) || 1));
      row.uses = Math.max(0, Math.floor(Number(row.uses) || 0)) + add;
      run.pickBuffIds = (run.pickBuffIds || []).concat([pend.buffId || 'C62']).filter((v, i, a) => a.indexOf(v) === i);
      run.pendingPick = null;
      save();
      return { ok: true, kind, id: row.id, uid: row.uid, addUses: add, uses: row.uses, name: def.name };
    }
    const key = kind === 'skill' ? 'skillBoost' : 'weaponBoost';
    run[key] = run[key] || {};
    let pct = pend.pct;
    if (kind === 'skill' && isPickableCosmos(id)) {

      if (!ownsSkill(run, id)) {
        if (isHeroRun(run)) run.hero.skills.push(Number(id) + ':1');
        else if (ONLINE) grantRunSkill(run, id);
        else State.setWS('skill', Number(id), 1);
      }
      run[key][Number(id)] = COSMOS_PICK_BOOST;
      pct = COSMOS_PICK_BOOST;
    } else if (kind === 'skill' && isPickableDefense(id)) {

      if (!ownsSkill(run, id)) {
        if (isHeroRun(run)) run.hero.skills.push(Number(id) + ':1');
        else if (ONLINE) grantRunSkill(run, id);
        else State.setWS('skill', Number(id), 1);
      }
      const before = Number(run[key][Number(id)]) || 0;
      run[key][Number(id)] = before + defensePickBoostOf(id);
      pct = run[key][Number(id)];
    } else {
      run[key][Number(id)] = Math.max(Number(run[key][Number(id)]) || 0, pct);
    }
    if (pend.buffId) run.pickBuffIds = (run.pickBuffIds || []).concat([pend.buffId]).filter((v, i, a) => a.indexOf(v) === i);
    run.pendingPick = null;
    save();
    return { ok: true, kind, id: Number(id), pct: pct };
  }



  function grantShopEnterCoins(run) {
    const enterStacks = stacksOf(run, 'C59');
    if (!(enterStacks > 0)) return 0;
    const enterCoins = Math.max(0, Math.round(Number(D().BUFF_BY_ID.C59.mods.shopEnterCoins) || 100) * enterStacks);
    if (enterCoins > 0) {
      run.coins = Math.max(0, Number(run.coins) || 0) + enterCoins;
      noteRunIncome(run, 'trialCoinsEarned', enterCoins);
    }
    return enterCoins;
  }
  // 开一次商店。
  // 休整商店（openRestShop）/ 立即开店都是独立入口，它们会先把 E04 的份数吃掉。
  // 另外 openRestShop 也必须把 activeShopCredit 传进来 —— 它和「打完这场再开的店」
  function makeShop(run, e01Pct) {
    // 那三层是「觐见魔王」三连战，中途插一家店很别扭；x5 层照旧开。
    // 覆盖所有入口：每 5 层的结算商店、休整商店、E01 立即进货、调试台手开 ——
    if (D().layerNoShop(run && run.layer)) return null;
    // 兜底：上一家「合并折扣店」如果没走 closeShop 就被顶掉（极少数路径，例如同场又开了
    if (run.shop && run.shop.combinedCoupon === true && run.shop.mint !== true) {
      run.shopDiscount = Math.max(0, Math.floor(Number(run.shopDiscount) || 0) - 1);
      if (run.shopDiscount <= 0) run.shopDiscountPct = 0;
    }
    const enterCoins = grantShopEnterCoins(run);
    const stacks = Math.max(0, Math.floor(Number(run.shopDiscount) || 0));
    const instantPct = Math.max(0, Number(run.shopDiscountPct) || 0);
    const own = Math.max(0, Number(e01Pct) || 0);
    // 这一份即时折扣券的比例：优先用它自身记着的 `shopDiscountPct`，
    // 旧档 / 手改档没有这个字段时才退回「当前生效的那张券」或数据表的 −30%。
    const pendingInstantPct = stacks > 0
      ? Math.max(instantPct, own || instantPct || D().SHOP_DISCOUNT_E04)
      : 0;

    const merged = own > 0 && stacks > 0;
    let discountPct = 0;
    if (merged) discountPct = Math.max(D().SHOP_DISCOUNT_BOTH, instantPct, own);
    else if (own > 0) discountPct = own;
    else if (stacks > 0) discountPct = pendingInstantPct;
    const discount = discountPct > 0;
    if (merged) {
      // 合并成立 → 不在这里吃掉 E04：把它的份数与比例都留着，
      // （否则这段高于 −30% 的折扣会漏给下一家店）。
    } else if (own > 0) {

    } else if (stacks > 0) {
      run.shopDiscount = stacks - 1;
      if (run.shopDiscount <= 0) run.shopDiscountPct = 0;
    }

    const slots = rollShopSlots(run);
    const shop = { layer: run.layer, slots: slots, retrySold: false, rerollFree: true,
      discount, discountPct, rerollCount: 0, rerollPaid: 0,

      combinedCoupon: merged || undefined,
      enterCoins: enterCoins || undefined };
    applyShopHalf(run, slots, shop);
    return shop;
  }


  function buffStaticWeightOf(b) {
    return Math.max(0, Number(b && b.shopWeight) || 1);
  }

  function buffDynamicPenaltyOf(run, b) {
    if (!run || !b || !b.mods) return 1;
    let m = 1;
    const rw = Number(b.mods.repeatWeight);
    if (rw > 0 && rw < 1) {
      const owned = b.kind === 'instant'
        ? instantOwnedCount(run, b.id)
        : Math.max(0, obtainedCountOf(run, b.id) - 1);
      if (owned > 0) m *= Math.pow(rw, owned);
    }
    const divBy = b.mods.weightDivBy;
    if (divBy === 'enchanted' || divBy === 'enchantedBy' || divBy === 'owned') {
      const rows = run.permanent || [];
      const n = divBy === 'enchanted'
        ? rows.filter((row) => rowFreeOf(row)).length
        : divBy === 'enchantedBy'
          ? rows.filter((row) => rowEnchantsOf(row).indexOf(b.id) >= 0).length
          : obtainedCountOf(run, b.id);

      const decay = Number(b.mods.weightDecay);
      if (decay > 0 && decay < 1) m *= Math.pow(decay, n);
      else {

        const div = n + Math.max(0, Number(b.mods.weightDivOffset) || 0);
        if (div > 1) m /= div;
      }
    }
    return m;
  }
  function buffWeightOf(run, b) {
    return buffStaticWeightOf(b) * buffDynamicPenaltyOf(run, b);
  }


  function dynamicTierWeightsBy(baseTier, run, list, weightOfFn) {
    const base = Array.isArray(baseTier) && baseTier.length ? baseTier : D().RARITY_WEIGHTS;
    if (D().TIER_DYNAMIC_WEIGHTS === false) return base.slice();
    const includeStatic = D().TIER_AVG_INCLUDES_STATIC === true;
    const fn = typeof weightOfFn === 'function' ? weightOfFn
      : (includeStatic ? buffWeightOf : buffDynamicPenaltyOf);
    const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (const b of list || []) {
      const r = Math.max(0, Math.min(3, Math.floor(Number(b && b.rarity) || 0)));
      const m = fn(run, b);
      sum[r] += Math.max(0, Number(m) || 0); n[r] += 1;
    }
    return base.map((v, r) => (n[r] > 0 ? Math.max(0, Number(v) || 0) * (sum[r] / n[r]) : 0));
  }
  function dynamicTierWeights(baseTier, run, list) {
    return dynamicTierWeightsBy(baseTier, run, list, null);
  }

  function rollableTierWeights(weights, fallback) {
    const total = (weights || []).reduce((a, b) => a + b, 0);
    return total > 0 ? weights : (fallback || weights);
  }

  function legendPityNeed() {
    const n = Math.floor(Number((D().LEGEND_PITY || {}).slots));
    return Number.isFinite(n) && n >= 1 ? n : 120;
  }
  function legendPityOf(run) { return Math.max(0, Math.floor(Number(run && run.legendPity) || 0)); }

  function legendPityReady(run, candidates) {
    if (!(candidates || []).some((b) => b.rarity === 3)) return false;
    return legendPityOf(run) >= legendPityNeed();
  }

  function pickByPityWeight(list, run) {
    const pool = (list || []).filter((b) => pityWeightOf(b, run) > 0);
    if (!pool.length) return pickByShopWeight(list, run);
    let total = 0;
    for (const b of pool) total += pityWeightOf(b, run);
    let roll = Math.random() * total;
    for (const b of pool) { roll -= pityWeightOf(b, run); if (roll < 0) return b; }
    return pool[pool.length - 1];
  }

  function pityWeightOf(b, run) {
    const v = Number(b && b.mods && b.mods.pityWeight);
    const base = Number.isFinite(v) && v > 0 ? v : (b && b.mods && b.mods.pityWeight === 0 ? 0 : 1);
    if (base <= 0) return 0;
    return run ? base * buffDynamicPenaltyOf(run, b) : base;
  }
  // 记一笔：掷到传奇清零，否则 +1；传奇池为空时不累加。
  function notePityRoll(run, buff, hasLegendCandidate) {
    if (!run) return;
    if (buff && buff.rarity === 3) { run.legendPity = 0; return; }
    if (!hasLegendCandidate) return;
    run.legendPity = legendPityOf(run) + 1;
  }

  function rollOneCandidate(run, candidates, baseTier) {
    const pity = legendPityReady(run, candidates);
    let want;
    if (pity) want = 3;
    else {
      const tierW = rollableTierWeights(dynamicTierWeights(baseTier, run, candidates), baseTier);
      want = rollRarity(tierW);
    }
    let list = candidates.filter((b) => b.rarity === want);
    if (!list.length) list = candidates;
    const buff = pity ? pickByPityWeight(list, run) : pickByShopWeight(list, run);
    notePityRoll(run, buff, candidates.some((b) => b.rarity === 3));
    return { buff, pity };
  }

  function pickByShopWeight(list, run, extraOf) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    const weightOf = (b) => {
      const extra = extraOf ? Math.max(0, Number(extraOf(b)) || 0) : 1;
      return buffWeightOf(run, b) * extra;
    };
    let total = 0;
    for (const b of list) total += weightOf(b);
    if (!(total > 0)) return list[Math.floor(Math.random() * list.length)];
    let roll = Math.random() * total;
    for (const b of list) { roll -= weightOf(b); if (roll < 0) return b; }
    return list[list.length - 1];
  }
  function rollShopSlots(run, paid) {
    const pool = D().shopPool || D().endlessPool, slots = [], taken = new Set();

    const baseTier = D().rawTierWeights(D().rerollTilt(paid || 0, run), run);

    const shelf = Math.max(1, Math.floor(Number(D().endlessShopSlots(run && run.layer)) || D().SHOP.slots || 5));
    let pitySlot = -1;
    for (let i = 0; i < shelf; i++) {
      const candidates = pool.filter((b) => !taken.has(b.id) && ownable(run, b) && poolFilter(run, b));
      if (!candidates.length) break;

      const got = rollOneCandidate(run, candidates, baseTier);
      const buff = got.buff;
      if (!buff) break;
      if (got.pity) pitySlot = slots.length;
      taken.add(buff.id);
      slots.push({ id: buff.id, sold: false, price: D().rollShopPrice(D().shopBuyPrice(buff)) });
    }
    const isLimited = (bid) => { const b = D().BUFF_BY_ID[bid]; return !!b && b.kind === 'limited' && b.id !== 'N08'; };
    if (slots.length && !slots.some((sl) => isLimited(sl.id))) {
      const cand = pool.filter((b) => b.kind === 'limited' && b.id !== 'N08' && !taken.has(b.id) && ownable(run, b) && poolFilter(run, b));
      const at = (pitySlot >= 0 && slots.length - 1 === pitySlot) ? pitySlot - 1 : slots.length - 1;
      if (cand.length && at >= 0) {
        const buff = pickByShopWeight(cand, run);
        taken.delete(slots[at].id);
        slots[at] = { id: buff.id, sold: false, price: D().rollShopPrice(D().shopBuyPrice(buff)) };
        taken.add(buff.id);
      }
    }

    if (pool.some((b) => b.rarity === 3 && ownable(run, b) && poolFilter(run, b))) {
      let pity = 0;
      for (const s of slots) {
        const b = D().BUFF_BY_ID[s.id];
        if (b && b.rarity === 3) pity = 0; else pity++;
      }
      run.legendPity = pity;
    }
    return slots;
  }

  function claimShopEnterCoins() {
    const run = endless().run;
    if (!run || !run.shop) return 0;
    const gain = Math.max(0, Math.round(Number(run.shop.enterCoins) || 0));
    if (gain > 0) { run.shop.enterCoins = 0; save(); }
    return gain;
  }
  function shopState() {
    const run = endless().run;
    if (!run || !run.shop) return null;

    if (D().layerNoShop(run.layer)) return null;
    // 铸币商店（run.shop.mint）与试炼商店共用这一份快照，界面按 `mint` 分流：
    const mint = !!run.shop.mint;
    return { coins: run.coins, layer: run.shop.layer, mint: mint,

      rest: !!run.shop.rest, postBattle: !!run.shop.postBattle, boundary: !!run.shop.boundary,

      byBuff: !!run.shop.byBuff,
      enterCoins: Math.max(0, Math.round(Number(run.shop.enterCoins) || 0)),
      rerollFree: !!run.shop.rerollFree,
      rerollCount: Number(run.shop.rerollCount) || 0,
      rerollNextPrice: D().rerollPriceAt(Number(run.shop.rerollCount) || 0),
      rerollCapped: D().rerollPriceCapped(Number(run.shop.rerollCount) || 0),
      rerollLastPaid: Number(run.shop.rerollPaid) || 0,
      retrySold: !!run.shop.retrySold, retryPrice: D().SHOP.retryPrice,
      retryToken: Math.max(0, Number(run.retryToken) || 0),
      rerollPrice: D().SHOP.rerollPrice,

      swapAllowed: mint ? swapAllowedOf(run) : false,
      swapUsed: mint ? (run.shop.swapped === true) : false,

      swapOpen: mint ? (run.shop.swapOpen === true) : false,
      swapCandidates: mint ? sellListOf('endless').length : 0,
      mintPrices: D().MINT_SHOP.price.slice(),

      halfCount: run.shop.slots.filter((s) => s && s.half).length,
      halfPerPage: Math.max(0, Math.floor(Number(run.shop.halfPerPage) || 0)),
      slots: run.shop.slots.map((s) => {
        if (s.swap) {
          return { id: 'MINT_SWAP', swap: true, sold: !!s.sold, name: '等价交换',
            desc: '选择自己的一件永久 / 限次增益，换回一件新的；不消耗铸币。',
            rarity: 0, kind: 'service', price: 0, listPrice: 0, half: false,
            ops: false, ownedStacks: 0, canStack: false };
        }
        const b = D().BUFF_BY_ID[s.id];

        const listPrice = mint ? D().mintPrice(b) : Math.max(0, Math.round(Number(s.price) || 0));
        return { id: s.id, sold: s.sold, name: b.name, desc: D().shopDescOf(b, 'endless'), rarity: b.rarity, kind: b.kind,
          price: mint ? (s.half ? Math.floor(listPrice / 2) : listPrice) : shopPriceOf(b, s),

          half: !!s.half, listPrice: listPrice,
          ops: D().hasTag(b, 'ops'),
          ownedStacks: stacksOf(run, s.id), canStack: D().hasTag(b, 'stackable') }; }) };
  }

  function limitedRerollPaid() {
    const m = (D().BUFF_BY_ID.C58 && D().BUFF_BY_ID.C58.mods) || {};
    const raw = m.limitedDefaultRerollPaid != null ? m.limitedDefaultRerollPaid : 10;
    return Math.max(0, Number(raw) || 0);
  }

  function limitedGrantWeights(run) {
    const pool = D().endlessPool.filter((b) => b.kind === 'limited' && ownable(run, b) && poolFilter(run, b));
    if (!pool.length) return [];
    const rar = (b) => Math.max(0, Math.min(3, Math.floor(Number(b && b.rarity) || 0)));
    const baseTier = D().rawTierWeights(D().rerollTilt(limitedRerollPaid()), run);
    const tier = dynamicTierWeights(baseTier, run, pool);
    const sum = [0, 0, 0, 0];
    for (const b of pool) sum[rar(b)] += Math.max(0, buffWeightOf(run, b));
    return pool.map((b) => {
      const r = rar(b);
      const mw = Math.max(0, buffWeightOf(run, b));
      return { buff: b, weight: sum[r] > 0 ? Math.max(0, Number(tier[r]) || 0) * (mw / sum[r]) : 0 };
    });
  }

  function limitedGrantWeightOf(run, b) {
    if (!b) return 0;
    const hit = limitedGrantWeights(run).find((x) => x.buff.id === b.id);
    return hit ? hit.weight : 0;
  }

  function grantRandomLimited(run) {
    const list = limitedGrantWeights(run);
    if (!list.length) return null;
    const total = list.reduce((a, x) => a + Math.max(0, x.weight), 0);
    let pick = list[list.length - 1].buff;
    if (total > 0) {
      let roll = Math.random() * total;
      for (const x of list) { roll -= Math.max(0, x.weight); if (roll < 0) { pick = x.buff; break; } }
    } else {
      pick = list[Math.floor(Math.random() * list.length)].buff;
    }
    const got = addBuff(run, pick.id);
    return got && got.ok ? pick.id : null;
  }

  // 挥金如土（C36）第 procs 次属性提升需要花多少试炼币（分段涨价）。
  // 没配 tiers 时退回单一 shopSpendStep（旧档 / 别的增益复用本函数时也安全）。
  function shopSpendStepFor(buff, procs, row) {
    const m = (buff && buff.mods) || {};
    const tiers = Array.isArray(m.shopSpendTiers) ? m.shopSpendTiers.filter((v) => Number(v) > 0) : null;
    const base = (!tiers || !tiers.length)
      ? Math.max(1, Number(m.shopSpendStep) || 20)
      : Math.max(1, Number(tiers[Math.min(tiers.length - 1, Math.floor(Math.max(0, procs) / Math.max(1, Math.floor(Number(m.shopSpendTierSize) || 20))))]) || 1);
    return row ? enchCost(base, rowEnchMulOf(row)) : base;
  }
  // ⚠ 只用于 `shopSpendStep` / `shopSpendLimited` 这类花多少钱的门槛，
  function enchCost(value, enchMul) {
    const base = Math.max(1, Math.round(Number(value) || 0));
    const mul = Number(enchMul) > 0 ? Number(enchMul) : 1;
    if (!(mul > 1)) return base;
    const stacks = Math.max(1, Math.round(Math.log(mul) / Math.log(1.5)));
    return Math.max(1, Math.round(base * Math.pow(0.75, stacks)));
  }
  // 界面 / 存档 / 探针继续读它们即可。

  function clearSpendProgress(run, id) {
    const key = id === 'C58' ? 'limitedSpend' : 'spend';
    for (const row of (run.permanent || [])) {
      if (row && row.id === id) { row[key] = 0; if (id === 'C36') row.procs = 0; }
    }
  }
  // 把各栏进度汇总回镜像字段（界面只读这几个）。
  function syncSpendMirrors(run) {
    const sum = (id, key) => (run.permanent || []).reduce((n, b) =>
      n + (b && b.id === id ? Math.max(0, Number(b[key]) || 0) : 0), 0);
    run.shopSpend = sum('C36', 'spend');
    run.shopSpendProcs = sum('C36', 'procs');
    run.shopSpendLimited = sum('C58', 'limitedSpend');
  }
  function addShopSpend(run, amount, flags) {
    const spend = Math.max(0, Number(amount) || 0);
    if (!(spend > 0)) return null;

    const countC58 = !(flags && flags.excludeC58);

    if (run && run.patrolShopGift && Number(run.patrolShopGift.step) > 0) {
      const gift = run.patrolShopGift;
      run.patrolShopSpend = Math.max(0, Number(run.patrolShopSpend) || 0) + spend;
      run.patrolFoeGain = Object.assign({ power: 0, agility: 0, speed: 0, hp: 0 }, run.patrolFoeGain || {});
      const opts = ['power', 'agility', 'speed', 'hp'];
      let guard = 0;
      while (run.patrolShopSpend >= Math.max(1, Number(gift.step) || 5) && guard++ < 100000) {
        run.patrolShopSpend -= Math.max(1, Number(gift.step) || 5);
        const key = opts[Math.floor(Math.random() * opts.length)];
        run.patrolFoeGain[key] += key === 'hp'
          ? Math.max(0, Number(gift.hp) || 5)
          : Math.max(0, Number(gift.stat) || 1);
      }
    }

    const c36Rows = (run.permanent || []).filter((b) => b && b.id === 'C36');
    const c58Rows = (run.permanent || []).filter((b) => b && b.id === 'C58');
    if (!c36Rows.length && !(countC58 && c58Rows.length) && !(flags && flags.assumeOwned)) return null;
    const gained = [];
    const mm36 = D().BUFF_BY_ID.C36.mods;
    const opts = ['power', 'agility', 'speed', 'hp'];
    const grantOnce = () => {
      const key = opts[Math.floor(Math.random() * opts.length)];
      run.spendGain = Object.assign({ power: 0, agility: 0, speed: 0, hp: 0 }, run.spendGain || {});
      run.spendGain[key] += key === 'hp'
        ? Math.max(0, Number(mm36.shopSpendHp) || 5)
        : Math.max(0, Number(mm36.shopSpendStat) || 1);
      gained.push(key);
    };
    // 兜底：调用方说「算给 C36」但栏位还没建出来（理论上不会）→ 记在镜像字段上。
    if (!c36Rows.length && !c58Rows.length) {
      run.shopSpend = Math.max(0, Number(run.shopSpend) || 0) + spend;
      run.shopSpendProcs = Math.max(0, Math.floor(Number(run.shopSpendProcs) || 0));
      let guard = 0;
      while (run.shopSpend >= shopSpendStepFor(D().BUFF_BY_ID.C36, run.shopSpendProcs) && guard++ < 100000) {
        run.shopSpend -= shopSpendStepFor(D().BUFF_BY_ID.C36, run.shopSpendProcs);
        run.shopSpendProcs += 1;
        grantOnce();
      }
      if (!gained.length) return null;
      return { gained: gained, limited: [], spendGain: Object.assign({}, run.spendGain || {}) };
    }

    for (const row of c36Rows) {
      row.spend = Math.max(0, Number(row.spend) || 0) + spend;
      row.procs = Math.max(0, Math.floor(Number(row.procs) || 0));
      let guard = 0;
      while (row.spend >= shopSpendStepFor(D().BUFF_BY_ID.C36, row.procs, row) && guard++ < 100000) {
        row.spend -= shopSpendStepFor(D().BUFF_BY_ID.C36, row.procs, row);
        row.procs += 1;
        grantOnce();
      }
    }

    const base58 = Math.max(1, Number(D().BUFF_BY_ID.C58.mods.shopSpendLimited) || 100);
    const limited = [];
    if (countC58) for (const row of c58Rows) {
      const step58 = enchCost(base58, rowEnchMulOf(row));
      row.limitedSpend = Math.max(0, Number(row.limitedSpend) || 0) + spend;
      let guard = 0;
      while (row.limitedSpend >= step58 && guard++ < 1000) {
        const id = grantRandomLimited(run);
        if (!id) break;
        row.limitedSpend -= step58;
        limited.push(id);
      }
    }
    syncSpendMirrors(run);
    if (!gained.length && !limited.length) return null;
    return { gained: gained, limited: limited, spendGain: Object.assign({}, run.spendGain || {}) };
  }
  // 试炼商店专用操作（买 / 刷新 / 卖 / 买铸币）的守门：
  // 两套 API 不能互相调用 —— 否则会出现「用试炼币买走铸币货架上的东西」这种串味。
  function trialShopGuard(run) {
    if (run && run.shop && run.shop.mint) {
      return { ok: false, msg: '这里是铸币商店：请用铸币购买、或者用免费交换。' };
    }
    return null;
  }
  function buyShopSlot(index, replaceId, opts) {
    const run = endless().run;
    if (!run || !run.shop) return { ok: false };
    const guard = trialShopGuard(run);
    if (guard) return guard;
    const slot = run.shop.slots[index];
    if (!slot || slot.sold) return { ok: false };
    const buff = D().BUFF_BY_ID[slot.id];
    const permanentFull = occupiesPermSlot(buff) && permUsed(run) >= permSlots(run) &&
      !(run.permanent || []).some((b) => b.id === buff.id);
    if (permanentFull && !replaceId) {
      return { ok: false, needsReplace: true, buff, msg: '永久增益已满 5 个，请选择要替换掉的增益。' };
    }
    const price = shopPriceOf(buff, slot);
    if (!freeCoinSpend() && run.coins < price) return { ok: false, msg: '试炼币不足。' };
    if (!freeCoinSpend()) run.coins -= price;
    slot.sold = true;
    const res = addBuff(run, slot.id, replaceId, opts);
    if (!res || !res.ok) {
      if (!freeCoinSpend()) run.coins += price;      // 免费模式下本来就没扣，不能退
      slot.sold = false;
      save();
      return { ok: false, msg: (res && res.msg) || '这件增益现在买不了。' };
    }


    const c36After = stacksOf(run, 'C36');
    const spend = addShopSpend(run, price, { assumeOwned: c36After > 0 });
    const pts = scoreBuffAcquire(run, buff);
    // 买走这一页的传奇后立刻清空保底计数：这一页已经兑现了保底，
    // 不能让页面末尾「传奇之后的空格」继续带到下一页。
    if (buff && buff.rarity === 3) run.legendPity = 0;
    save();
    return { ok: true, buff, price, instant: !!res.instant, score: pts,
      msg: res.msg, heroResult: res, shopSpend: spend || undefined };
  }

  function buyShopHeal() { return buyRetryToken(); }
  function buyRetryToken() {
    const run = endless().run;
    if (!run || !run.shop) return { ok: false, msg: '商店还没开张。' };
    const guard = trialShopGuard(run);
    if (guard) return guard;
    if (run.shop.retrySold) return { ok: false, msg: '这家店已经买过了。' };
    const price = D().SHOP.retryPrice;
    if (!freeCoinSpend() && run.coins < price) return { ok: false, msg: '试炼币不足。' };
    if (!freeCoinSpend()) run.coins -= price;

    const spend = addShopSpend(run, price);
    run.shop.retrySold = true;
    run.retryToken = Math.max(0, Number(run.retryToken) || 0) + 1;
    noteRunIncome(run, 'mintEarned', 1);
    save();
    return { ok: true, left: run.retryToken, price: price, shopSpend: spend };
  }
  function rerollShop() {
    const run = endless().run;
    if (!run || !run.shop) return { ok: false, msg: '商店还没开张。' };
    const guard = trialShopGuard(run);
    if (guard) return guard;
    const shop = run.shop;
    const free = !!shop.rerollFree;
    const raw = D().rerollPriceAt(Number(shop.rerollCount) || 0);
    const price = free ? 0 : shopDiscountApply(run, raw);
    let spend = null;
    if (!free) {
      if (!freeCoinSpend() && run.coins < price) return { ok: false, msg: '试炼币不足（本次刷新需要 ' + price + ' 币）。' };
      if (!freeCoinSpend()) run.coins -= price;
      spend = addShopSpend(run, price, { excludeC58: true });
    }
    shop.rerollFree = false;
    shop.rerollCount = (Number(shop.rerollCount) || 0) + 1;
    shop.rerollPaid = price;
    shop.slots = rollShopSlots(run, price);

    applyShopHalfCount(shop.slots, shop.halfPerPage);
    save();
    // 期望值按这一页真实件数算（第 41 层起货架只有 3 件，不能再按 5 报）。
    return { ok: true, paid: price, expect: D().rerollExpectation(price, run, shop.slots.length),
      nextPrice: D().rerollPriceAt(shop.rerollCount), shopSpend: spend };
  }

  function shopPriceOf(buff, slot) {
    const run = endless().run;
    const base = slot && Number.isFinite(Number(slot.price)) ? Number(slot.price) : D().shopBuyPrice(buff);
    const priced = slot && slot.half ? Math.floor(Math.max(0, base) / 2) : base;
    return shopDiscountApply(run, priced);
  }

  function shopDiscountApply(run, base) {
    const shop = run && run.shop;
    if (!shop || !shop.discount) return base;
    const pct = Math.max(0, Number(shop.discountPct) || 0.5);
    return Math.max(1, Math.round(base * (1 - pct)));
  }
  function debugGrantBuff(id) {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    const buff = D().BUFF_BY_ID[id];
    if (!buff) return { ok: false, msg: '没有这个增益。' };
    const res = addBuff(run, id);
    save();
    return { ok: !!(res && res.ok), buff, res };
  }
  // 调试台：失去一条增益。`ref` 优先当 uid（精确移除那一条），否则按 id 取最后一条。
  function debugLoseBuff(ref) {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    if (run.pendingPick && run.pendingPick.buffId === ref) {
      run.pendingPick = null;
      run.pickBuffIds = (run.pickBuffIds || []).filter((x) => x !== ref);
      dropPickBoost(run, ref);
      logBuff(run, ref, 'lose', { detail: '调试台取消待选取' });
      save();
      return { ok: true, id: ref, cancelledPick: true };
    }

    const hit = findRowRef(run, ref);
    if (hit) {
      const row = hit.row, list = hit.list, id = row.id;
      const removedStacks = Math.max(1, Math.floor(Number(row.stacks) || 1));
      list.splice(list.indexOf(row), 1);
      resetGrowth(run, id, removedStacks, row);
      syncSlotFree(run);
      run.pickBuffIds = (run.pickBuffIds || []).filter((x) => x !== id);
      run.permSlotIds = (run.permSlotIds || []).filter((x) => x !== id);
      dropPickBoost(run, id);
      if (run.pendingPick && run.pendingPick.buffId === id) run.pendingPick = null;
      logBuff(run, id, 'lose', { detail: '调试台失去' });
      save();
      return { ok: true, id, uid: row.uid };
    }

    for (const list of [run.permSlotIds || [], run.pickBuffIds || []]) {
      const i = (list || []).findIndex((b) => (typeof b === 'string' ? b === ref : b.id === ref));
      if (i >= 0) {
        const removed = list[i];
        const id = typeof removed === 'string' ? removed : removed.id;
        list.splice(i, 1);
        resetGrowth(run, id, 1);
        syncSlotFree(run);
        run.pickBuffIds = (run.pickBuffIds || []).filter((x) => x !== id);
        run.permSlotIds = (run.permSlotIds || []).filter((x) => x !== id);
        dropPickBoost(run, id);
        if (run.pendingPick && run.pendingPick.buffId === id) run.pendingPick = null;
        logBuff(run, id, 'lose', { detail: '调试台失去' });
        save();
        return { ok: true, id };
      }
    }
    return { ok: false, msg: '本局没有这个增益。' };
  }

  function sellPriceOf(run, buff, stacks, row) {
    const sellBack = buff.kind === 'limited'
      ? (D().SHOP.sellBackLimited != null ? D().SHOP.sellBackLimited : D().SHOP.sellBack)
      : D().SHOP.sellBack;
    const base = buff.mods && buff.mods.sellValue
      ? Number(buff.mods.sellValue)
      : Math.max(1, Math.round(D().shopPrice(buff) * sellBack));
    const n = Math.max(1, Math.floor(Number(stacks != null ? stacks : stacksOf(run, buff.id)) || 1));

    const bonus = sellBonusOf(run, row);
    const unit = (buff.id === 'C25' && (row ? true : stacksOf(run, 'C25') > 0))
      ? base + Math.max(0, Math.floor(bonus))
      : base;
    return unit * n;
  }
  // 卖出：`ref` 优先当 uid（精确卖那一条），否则按 id 卖最后拿到的那一栏（LIFO）。
  function sellBuff(ref) {
    const run = endless().run;
    if (!run || !run.shop) return { ok: false };
    const guard = trialShopGuard(run);
    if (guard) return guard;
    const hit = findRowRef(run, ref);
    if (!hit) return { ok: false };
    const row = hit.row, list = hit.list, id = row.id;
    const buff = D().BUFF_BY_ID[id];
    if (!buff || buff.kind === 'instant' || D().hasTag(buff, 'hidden')
        || D().hasTag(buff, 'story') || D().isBladeId(buff.id)) return { ok: false };
    const stacks = Math.max(1, Math.floor(Number(row.stacks) || 1));
    const gain = sellPriceOf(run, buff, stacks, row);
    list.splice(list.indexOf(row), 1);
    resetGrowth(run, id, stacks, row);
    syncSlotFree(run);
    run.coins += gain;
    noteRunIncome(run, 'trialCoinsEarned', gain);
    logBuff(run, id, 'lose', { detail: '商店卖出 ' + (stacks > 1 ? ('×' + stacks + ' 层 ') : '') + '+' + gain + ' 试炼币' });
    save();
    return { ok: true, gain, id, uid: row.uid };
  }

  function openRestShop() {
    const run = endless().run;
    if (!run || !run.choices) return { ok: false, msg: '只有休整点（每层第 3 场后）能开休整商店。' };
    if (run.restShopUsed) return { ok: false, msg: '本层的休整商店已经用过了。' };

    if (D().layerNoShop(run.layer)) return { ok: false, msg: '整百层（觐见魔王）不开商店。' };
    run.restShopUsed = true;

    run.shop = makeShop(run, activeShopCredit(run));
    run.shop.rest = true;
    run.phase = 'shop';
    save();
    return { ok: true };
  }
  function closeShop() {

    { const r = endless().run; if (r && r.shop) r.shop.discount = false; }

    { const r = endless().run;
      if (r && r.shop && r.shop.combinedCoupon === true) {
        r.shopDiscount = Math.max(0, Math.floor(Number(r.shopDiscount) || 0) - 1);
        if (r.shopDiscount <= 0) r.shopDiscountPct = 0;
      } }
    const run = endless().run;
    if (!run || run.phase !== 'shop') return { ok: false };

    const shop = run.shop || {};

    if (shop.mint) return leaveMintShop();
    run.phase = (!shop.rest && !shop.postBattle) ? 'checkpoint' : null;
    // 店本身也要收掉：只归位 phase 的话，`shopState()` 仍然拿得到一家店，
    // 界面「离开」按钮就是踩在这个坑上（没关店 → 首页按钮还是「进入试炼商店」→ 出不去）。
    run.shop = null;
    save();
    return { ok: true };
  }




  function applyShopHalfCount(slots, count) {
    let left = Math.max(0, Math.floor(Number(count) || 0));
    if (!left || !Array.isArray(slots) || !slots.length) return 0;
    let marks = 0;
    while (left > 0) {
      const cand = slots.filter((s) => s && !s.half && !s.swap);
      if (!cand.length) break;
      cand[Math.floor(Math.random() * cand.length)].half = true;
      left--; marks++;
    }
    return marks;
  }

  function applyShopHalf(run, slots, shop) {
    const want = Math.max(0, Math.floor(Number(run && run.shopHalfPending) || 0));
    const applied = applyShopHalfCount(slots, want);
    if (shop) shop.halfPerPage = applied;
    if (run) run.shopHalfPending = Math.max(0, want - applied);
    return applied;
  }



  // 这一场打完之后要不要刷出铸币商店（只判定，不动任何状态）。
  function rollMintShop(run, layer) {
    const L = Math.max(1, Math.floor(Number(layer) || 1));
    if (!D().mintLayerOk(L)) return false;
    if (Number(run.mintGroup) === D().mintGroupOf(L)) return false;
    return Math.random() < clamp01(D().mintChance(L));
  }

  function mintCandidates(run, rarity, opsOnly, taken) {
    return D().mintPool.filter((b) => b.rarity === rarity
      && (!opsOnly || D().hasTag(b, 'ops'))
      && !(taken && taken.has(b.id))
      && ownable(run, b) && poolFilter(run, b));
  }

  const MINT_SWAP_SLOT = Object.freeze({ id: 'MINT_SWAP', swap: true, sold: false, price: 0, listPrice: 0 });
  function mintSwapSlot() { return Object.assign({}, MINT_SWAP_SLOT); }

  function rollMintSlots(run, opts) {
    const S = D().MINT_SHOP;
    const o = opts || {};
    const slots = [], taken = new Set();
    const opsChance = clamp01(S.opsChance);
    const shelf = Math.max(1, Math.floor(Number(S.shelf) || 5));
    const baseTier = D().mintWeights(run);
    if (o.fixedSwap) slots.push(mintSwapSlot());
    for (let i = slots.length; i < shelf; i++) {

      const allCands = [];
      for (let r = 0; r < 4; r++) allCands.push(...mintCandidates(run, r, false, taken));
      if (!allCands.length) break;
      const tierW = rollableTierWeights(dynamicTierWeights(baseTier, run, allCands), baseTier);
      const want = rollRarity(tierW);
      let rarity = -1, pool = null;
      for (const r of [want, want + 1, want + 2, want + 3, want - 1, want - 2, want - 3]) {
        if (r < 0 || r > 3) continue;
        const list = mintCandidates(run, r, false, taken);
        if (list.length) { rarity = r; pool = list; break; }
      }
      if (rarity < 0) break;

      let target = pool;
      if (rarity !== 3) {
        const wantOps = Math.random() < opsChance;
        const sub = pool.filter((b) => D().hasTag(b, 'ops') === wantOps);
        if (sub.length) target = sub;
      }
      const buff = pickByShopWeight(target, run);
      if (!buff) break;
      taken.add(buff.id);

      slots.push({ id: buff.id, sold: false, price: D().mintPrice(buff) });
    }
    // 刷新后的「等价交换」不再固定首位，而是按概率洗进一个随机格。
    // 只替换已有的普通格，保证货架件数不变；也不会出现两个交换服务。
    if (o.allowSwap && slots.length && !slots.some((s) => s.swap)
        && Math.random() < clamp01(Number(S.swapChance) || 0)) {
      const at = Math.floor(Math.random() * slots.length);
      slots[at] = mintSwapSlot();
    }
    return slots;
  }
  function makeMintShop(run, layer) {

    const slots = rollMintSlots(run, { fixedSwap: true });

    const enterCoins = grantShopEnterCoins(run);
    const shop = {
      mint: true,
      layer: Math.max(1, Math.floor(Number(layer) || Number(run.layer) || 1)),
      slots: slots,
      rerollFree: true,
      rerollCount: 0,
      swapped: false,
      swapOpen: false,
      enterCoins: enterCoins || undefined,
    };

    applyShopHalf(run, slots, shop);
    return shop;
  }

  function openMintShop(run, layer, opts) {
    const o = opts || {};

    if (D().layerNoShop(run && run.layer)) return null;
    if (!o.debug && !o.noGroup) run.mintGroup = D().mintGroupOf(layer);
    run.shop = makeMintShop(run, layer);
    if (o.byBuff) run.shop.byBuff = true;
    if (o.boundary) run.shop.boundary = true;
    run.phase = 'shop';
    return run.shop;
  }
  // 铸币商店里「等价交换」可不可以进行：
  // · 初始进店：第一格固定有等价交换，可以直接交换（兼容旧调用 / 测试）；
  function swapAllowedOf(run) {
    const shop = run && run.shop;
    if (!shop || !shop.mint || shop.swapped === true) return false;
    return shop.swapOpen === true || !(Number(shop.rerollCount) > 0);
  }
  // 收摊：买 / 换完成、或玩家直接走人 —— 这家店立刻消失（不会再来）。
  // 20/30… 层先放弃一个永久增益，否则直接推进到下一层 —— 否则整局会卡在
  function closeMintShop(run) {
    run = run || endless().run;
    if (!run || !run.shop) return false;
    const boundary = run.shop.mint === true && run.shop.boundary === true;
    run.shop = null;
    if (boundary) { advancePastBoundaryShop(run); return true; }
    run.phase = null;
    return true;
  }

  function buyMintSlot(index, replaceId, opts) {
    const run = endless().run;
    if (!run || !run.shop || !run.shop.mint) return { ok: false, msg: '现在不在铸币商店里。' };
    const slot = run.shop.slots[index];
    if (!slot || slot.sold) return { ok: false, msg: '这件已经卖掉了。' };

    if (slot.swap) {
      if (!sellListOf('endless').length) {
        return { ok: false, msg: '现在没有可以拿去交换的永久 / 限次增益。' };
      }
      slot.sold = true;
      run.shop.swapOpen = true;
      save();
      return { ok: true, swap: true, price: 0, left: Math.max(0, Number(run.retryToken) || 0) };
    }
    const buff = D().BUFF_BY_ID[slot.id];
    if (!buff) return { ok: false, msg: '没有这件增益。' };
    const base = D().mintPrice(buff);

    const price = slot.half ? Math.floor(base / 2) : base;
    const tokens = Math.max(0, Math.floor(Number(run.retryToken) || 0));
    if (!freeCoinSpend() && tokens < price) return { ok: false, msg: '铸币不足（需要 ' + price + ' 枚，现有 ' + tokens + ' 枚）。' };
    const permanentFull = occupiesPermSlot(buff) && permUsed(run) >= permSlots(run) &&
      !(run.permanent || []).some((b) => b.id === buff.id);
    if (permanentFull && !replaceId) {
      return { ok: false, needsReplace: true, buff, msg: '永久增益已满，请选择要替换掉的增益。' };
    }
    if (!freeCoinSpend()) run.retryToken = tokens - price;
    slot.sold = true;
    const res = addBuff(run, slot.id, replaceId, opts);
    if (!res || !res.ok) {
      run.retryToken = tokens;
      slot.sold = false;
      save();
      return { ok: false, msg: (res && res.msg) || '这件增益现在买不了。' };
    }
    const pts = scoreBuffAcquire(run, buff);

    closeMintShop(run);
    save();
    return { ok: true, buff, price, left: run.retryToken, instant: !!res.instant,
      msg: res.msg, heroResult: res, score: pts, pendingPick: res.pendingPick || null };
  }

  function takeOwnedBuff(run, ref, detail) {
    // `ref` 优先当 uid（精确到那一条），否则按 id 取最后一条。
    const hit = findRowRef(run, ref);
    if (!hit) return null;
    const row = hit.row, list = hit.list;
    const id = row.id;
    const stacks = Math.max(1, Math.floor(Number(row.stacks) || 1));
    const snapshot = Object.assign({}, row);
    list.splice(list.indexOf(row), 1);
    const m = (D().BUFF_BY_ID[id] || {}).mods || {};
    // 扩容类：把名额还回去（addBuff 的「替换」路径不管这一条，会留下幽灵槽位）。
    if (m.permSlot) {
      run.permSlots = Math.max(0, (Number(run.permSlots) || 0) - (Number(m.permSlot) || 0));
      run.permSlotIds = (run.permSlotIds || []).filter((x) => x !== id);
    }

    if (m.pickWeaponPct || m.pickSkillPct || m.pickPermanentFree || m.pickPermanentMul || m.pickBrandBreak || m.pickLimitedUses) {
      run.pickBuffIds = (run.pickBuffIds || []).filter((x) => x !== id);
      dropPickBoost(run, id);
      if (run.pendingPick && run.pendingPick.buffId === id) run.pendingPick = null;
    }
    syncSlotFree(run);
    resetGrowth(run, id, stacks, snapshot);
    logBuff(run, id, 'lose', { detail: detail || '铸币商店交换' });
    return { row: snapshot, stacks: stacks };
  }

  function rollSwapTarget(run, srcBuff) {
    const S = D().MINT_SHOP;
    const isOps = (b) => D().hasTag(b, 'ops');
    const rarity = Math.max(0, Math.min(3, Math.floor(Number(srcBuff && srcBuff.rarity) || 0)));

    const srcId = srcBuff && srcBuff.id;
    const at = (r, ops) => D().mintPool.filter((b) => b.rarity === r && b.id !== srcId
      && (ops === null || isOps(b) === ops) && ownable(run, b) && poolFilter(run, b));
    const wantOps = Math.random() < clamp01(S.swapOpsChance);
    let r = rarity;
    if (wantOps && rarity === 0 && Math.random() < clamp01(S.swapCommonUp)) {
      r = Math.max(0, Math.min(3, Math.floor(Number(S.swapCommonUpRarity) || 1)));
    }
    const tries = wantOps
      ? [[r, true], [rarity, true], [rarity, false], [rarity, null]]
      : [[rarity, false], [rarity, true], [rarity, null]];
    for (const pair of tries) {
      const list = at(pair[0], pair[1]);
      if (list.length) return pickByShopWeight(list, run) || list[0];
    }
    const anyList = D().mintPool.filter((b) => b.id !== srcId && ownable(run, b) && poolFilter(run, b));
    return anyList.length ? (pickByShopWeight(anyList, run) || anyList[0]) : null;
  }
  // 免费交换：拿自己的一件永久 / 限次增益，换一件新的（不花铸币）；做成就收摊。
  // `ref` 优先当 uid（交换指定的那一条），否则按 id 取最后一条。
  function swapMintBuff(ref) {
    const run = endless().run;
    if (!run || !run.shop || !run.shop.mint) return { ok: false, msg: '现在不在铸币商店里。' };
    if (!swapAllowedOf(run)) return { ok: false, msg: '刷新过货架之后就不能再免费交换了。' };
    const hit = findRowRef(run, ref);
    if (!hit) return { ok: false, msg: '这件增益不在本局身上。' };
    const row = hit.row;
    const id = row.id;
    const buff = D().BUFF_BY_ID[id];
    if (!buff) return { ok: false, msg: '没有这件增益。' };
    if (buff.kind === 'instant' || D().hasTag(buff, 'hidden')
        || D().hasTag(buff, 'story') || D().isBladeId(buff.id)) return { ok: false, msg: '只有永久 / 限次增益能拿去交换。' };

    const target = rollSwapTarget(run, buff);
    if (!target) return { ok: false, msg: '现在没有能换给你的增益（池子里的都被你拿满了）。' };
    if (rowFreeOf(row) && occupiesPermSlot(target)
        && permUsed(run) >= permSlots(run)) {
      return { ok: false, msg: '【' + buff.name + '】已被虚空铭文附魔、不占槽位；永久增益栏已满，换它腾不出位置。' };
    }
    const taken = takeOwnedBuff(run, Number(row.uid) > 0 ? Number(row.uid) : id);
    const res = addBuff(run, target.id);
    if (!res || !res.ok) {

      const L = buff.kind === 'permanent' ? (run.permanent || (run.permanent = [])) : (run.limited || (run.limited = []));
      if (taken) L.push(taken.row);
      applyBuffOnAcquire(run, buff);
      if (taken && taken.row && taken.row.slotFree) markRowFree(run, taken.row);
      save();
      return { ok: false, msg: (res && res.msg) || '交换失败。' };
    }
    run.shop.swapped = true;
    const pts = scoreBuffAcquire(run, target);
    closeMintShop(run);
    save();
    return { ok: true, from: id, fromUid: row.uid, fromName: buff.name, fromRarity: buff.rarity,
      buff: target, score: pts, pendingPick: res.pendingPick || null };
  }
  // 免费刷新货架（一次）。刷新之后就不能再用「免费交换」了。
  function rerollMintShop() {
    const run = endless().run;
    if (!run || !run.shop || !run.shop.mint) return { ok: false, msg: '现在不在铸币商店里。' };
    if (!run.shop.rerollFree) return { ok: false, msg: '铸币商店只免费刷新一次。' };
    run.shop.rerollFree = false;
    run.shop.rerollCount = (Number(run.shop.rerollCount) || 0) + 1;

    run.shop.slots = rollMintSlots(run, { allowSwap: true });
    run.shop.swapOpen = false;
    run.shop.swapped = false;

    applyShopHalfCount(run.shop.slots, run.shop.halfPerPage);
    save();
    return { ok: true, slots: run.shop.slots.length };
  }

  function leaveMintShop() {
    const run = endless().run;
    if (!run || !run.shop || !run.shop.mint) return { ok: false, msg: '现在不是铸币商店。' };
    if (run.shop.boundary === true) {
      run.shop = null;
      return advancePastBoundaryShop(run);
    }
    closeMintShop(run);
    save();
    return { ok: true, layer: run.layer };
  }



  function checkpointInfo() {
    const run = endless().run;
    if (!run) return null;
    const s = D().endlessSegment(run.layer);
    const coins = Math.max(0, Math.floor(Number(run.coins) || 0));
    const tokens = Math.max(0, Math.floor(Number(run.retryToken) || 0));
    if (ONLINE) {

      const pv = previewSettleTickets(run);
      const step = Math.max(1, Number(window.TowerRewards && window.TowerRewards.LAYERS_PER_TICKET) || 10);
      return { layer: run.layer, score: run.score, coins, retryToken: tokens,
        ticketsNow: pv.total, ticketsNowTotal: pv.total,
        ticketsNext: Math.min(pv.rawTickets + 1, pv.weekLeft),
        nextCheckpoint: (Math.floor(pv.bestLayer / step) + 1) * step,
        online: true, bestLayer: pv.bestLayer, layerTickets: pv.layerTickets,
        mintBonus: pv.bonusTickets, rawTickets: pv.rawTickets, total: pv.total,
        capped: pv.capped, weekTickets: pv.weekTickets, weekCap: pv.weekCap, weekLeft: pv.weekLeft };
    }
    const now = D().endlessTickets(run.layer);
    return { layer: run.layer, score: run.score, coins, retryToken: tokens,
      ticketsNow: now,

      ticketsNowTotal: now + tokens,
      ticketsNext: D().endlessTickets((s + 1) * 5),
      nextCheckpoint: (s + 1) * 5 };
  }

  function settleEndless() {
    const e = endless(), run = e.run;
    if (!run || run.phase !== 'checkpoint') return { ok: false };
    const out = { ok: true, score: run.score, layer: run.layer };
    out.summary = buildEndlessSummary(run, 'lose', 'checkpoint');
    settleRunTickets(run, out);
    settleScore(run, out);
    finishEndlessSummary(out);
    e.run = null;
    save();
    return out;
  }
  // 整百层最终战胜利后主动离场；沿用同一发奖 API，只在真正结束本局时入包。
  function settleEndlessVictory() {
    const e = endless(), run = e.run;

    if (!canSettleEndlessVictory(run) || (storyEnabled() && (run.story || run.pendingStory)) ||
        mirrorPickupPending(run)) return { ok: false };
    const out = { ok: true, win: true, score: run.score, layer: run.layer };
    out.summary = buildEndlessSummary(run, 'win', 'victory');
    settleRunTickets(run, out);
    settleScore(run, out);
    finishEndlessSummary(out);
    e.run = null;
    save();
    return out;
  }
  // 结算商店（每 5 层）关掉之后的去向：20/30… 层先放弃一个永久增益，否则推进到下一层。
  // 判据必须用「可放弃的候选」而不是 permanent.length：C32/C33/C63 带 hidden，
  // 不会进候选，只按长度判断会写进一个永远选不完的 sacrifice 阶段。
  function advancePastBoundaryShop(run) {
    if (needPermSacrifice(run.layer) && sacrificeCandidates(run).length) {
      run.phase = 'sacrifice';

      noteSacrificeStory(run);
      save();
      return { ok: true, phase: 'sacrifice', layer: run.layer };
    }
    run.phase = null;
    advanceLayer(run, 'endless');
    save();
    return { ok: true, layer: run.layer };
  }
  function continueFromShop() {
    const run = endless().run;
    if (!run || run.phase !== 'shop') return { ok: false };
    run.shop = null;
    return advancePastBoundaryShop(run);
  }



  const MIRROR_STAT_KEYS = ['power', 'agility', 'speed', 'maxHp'];
  const MIRROR_COMBAT_KEYS = ['critBonus', 'critDmgBonus', 'dodgeBonus', 'dodgeMul', 'takenMul',
    'regenPct', 'lifestealPct', 'shellPct', 'thornsPct', 'reflectImmune', 'mustHitAll'];
  // 存档数值收口：浮点求和会留下 4.800000000000001 这种尾巴，照影面板会原样显示。
  // 统一保留 4 位小数（治疗/闪避/减伤这些都够用），同时保证快照往返不再漂移。
  function roundMirrorNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : n;
  }
  function cleanMirrorCombat(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const key of MIRROR_COMBAT_KEYS) {
      if (value[key] == null) continue;
      const v = Number(value && value[key]);
      if (Number.isFinite(v) && v) out[key] = roundMirrorNumber(v);
    }
    for (const key of ['dmgMul', 'healMul']) {
      if (value[key] == null) continue;
      const v = Number(value && value[key]);
      if (Number.isFinite(v) && (key === 'healMul' ? v >= 0 : v > 0) && v !== 1) out[key] = roundMirrorNumber(v);
    }
    return out;
  }
  function applyMirrorCombat(run, me) {
    if (!run || run.mode !== 'endless') return;
    const saved = run.mirrorSnapshot && run.mirrorSnapshot.combat;
    if (!saved) return;
    const combat = cleanMirrorCombat(saved), mods = me.mods || (me.mods = {});
    for (const key of MIRROR_COMBAT_KEYS) {
      if (!combat[key]) continue;
      if (key === 'reflectImmune' || key === 'mustHitAll') mods[key] = Math.max(Number(mods[key]) || 0, combat[key]);

      else if (key === 'takenMul') mods[key] = combineTakenMul(mods[key], combat[key]);
      else mods[key] = (Number(mods[key]) || 0) + combat[key];
    }
    if (combat.dmgMul != null) mods.dmgMul = (mods.dmgMul == null ? 1 : Number(mods.dmgMul)) * combat.dmgMul;
    if (mods.thornsPct) mods.thornsPct = Math.min(0.6, mods.thornsPct);
    if (combat.healMul != null) me.healMul = roundMirrorNumber(Math.max(0, (me.healMul == null ? 1 : Number(me.healMul)) + combat.healMul - 1));
  }

  function mirrorCombatAtFirstRound(actor) {
    const combat = cleanMirrorCombat(actor.mods || {});
    if (actor.healMul != null) combat.healMul = Number(actor.healMul);
    return cleanMirrorCombat(combat);
  }
  // 带这些 mod 的增益不进入快照。
  const MIRROR_INRUN_MODS = Object.freeze([
    'catchUpPct', 'roundStatPct', 'roundMaxHpMul',
    'startHealPct', 'layerFirstHealPct', 'startStatFlat', 'startMaxHpFlat', 'emptyMaxHpMul',
    'enemyHpDrainPct', 'firstDodge', 'firstDodgeFreeTurn', 'firstDodgeName', 'firstHitZero', 'firstHitZeroFreeTurn', 'firstHitZeroName', 'firstSkillFree', 'mustHitFirst',
    'openStrikePct', 'openKill',
    'winMaxHpPct', 'winMaxHpCap', 'winMaxHpFlat', 'winStatAfter10', 'winTakenMulPct', 'winTakenMulCap',
    'killPowerPct', 'killPowerCap', 'eliteHealAfter', 'eliteMaxHpAfter',
    'lowHpAt', 'lowHpPowerMul', 'lowHpAgilityMul', 'lowHpSpeedMul', 'lowHpFinalMul', 'lowHpTakenMul',
    'lowHpLifestealPct', 'lowHpRegenPct', 'lowHpRegenAt',
    'dmgMulType', 'dmgMulMech', 'dmgMulElite',
    'revivePct', 'reviveStatMul', 'reviveFirstPct',
    'x10Boost',
    'rarityBoost', 'commonMul', 'epicMul', 'legendMul',
    'globalMul',
    'coinBoostPct', 'fragileCoinAddAlive', 'fragileCoinAddBurned',
    'shopDiscount', 'shopHalf', 'postBattleShop', 'postBattleShopDiscount', 'postBattleMintShop',
    'shopEnterCoins', 'shopSpendHp', 'shopSpendLimited', 'shopSpendStat', 'shopSpendStep',
    'shopSpendTierSize', 'shopSpendTiers',
    'sellValue', 'sellGrowthPerWin', 'instantCoins', 'instantRetry', 'layerRestart',
    'rerollTiltMul', 'limitedDefaultRerollPaid',
    'pickWeaponPct', 'pickSkillPct',
    'powerPerEmptySlot', 'powerPerPermBuff', 'powerPerPermBuffEnchantedWeight',
    'openerPowerMul', 'fatiguePowerMul', 'openerRounds', 'weaponFreeUses', 'weaponBoostUses',
    'weaponBoostPowerMul', 'weaponBoostMustHit', 'weaponBoostReflectImmune', 'weaponBoostFatigueMul',
    'dodgeMul',
  ]);

  function mirrorAbsorbableBuff(id) {
    const def = D().BUFF_BY_ID[id];
    if (!def) return false;
    const m = def.mods || {};
    return !MIRROR_INRUN_MODS.some((key) => m[key] != null);
  }
  // 照影取样用克隆：剔除纯局内增益、清零成长/运营字段，避免它们通过 adjustMe 混进快照。
  function mirrorProbeRun(run) {
    const probe = cloneRun(run);
    probe.phase = null; probe.choices = null; delete probe.attempt;
    probe.idx = Math.max(0, (probe.plan || []).length - 1);
    const keep = (row) => !!(row && mirrorAbsorbableBuff(row.id));
    probe.permanent = (probe.permanent || []).filter(keep);
    probe.limited = (probe.limited || []).filter(keep);
    probe.buffs = (probe.buffs || []).filter(keep);

    probe.weaponBoost = {}; probe.skillBoost = {};
    for (const key of ['killPower', 'bonusPower', 'winMaxHp', 'winHpFlat', 'winStatPower', 'winStatAgility',
      'winStatSpeed', 'winTakenMul', 'rarityBoost', 'fragileCoinBase', 'enemyMaxHpDown', 'enemyPowerDown',
      'shopSpend', 'shopSpendProcs', 'shopSpendLimited', 'shopDiscount', 'shopDiscountPct', 'shopHalfPending']) {
      probe[key] = 0;
    }
    delete probe.spendGain;
    probe.fragileCoinBurned = [];
    probe.env = []; probe.debuffs = [];
    return probe;
  }
  function cleanMirrorSnapshot(value) {
    if (!value || value.version !== 1 || !value.stats) return null;
    const through = Math.max(0, Math.floor(Number(value.absorbedThrough) || 0));
    if (!through || through % 100) return null;
    const stats = {};
    for (const key of MIRROR_STAT_KEYS) {
      const part = value.stats[key], mul = Number(part && part.mul), flat = Number(part && part.flat);
      if (!Number.isFinite(mul) || mul <= 0 || !Number.isFinite(flat)) return null;
      stats[key] = { mul, flat };
    }
    const source = { layer: through, firstRound: true };
    for (const key of MIRROR_STAT_KEYS) source[key] = Math.max(1, Number(value.source && value.source[key]) || 1);
    return { version: 1, absorbedThrough: through, stats, source, combat: cleanMirrorCombat(value.combat) };
  }
  function mirrorStatsOf(run) {
    const snap = run && run.mode === 'endless' && cleanMirrorSnapshot(run.mirrorSnapshot);
    const stats = {};
    for (const key of MIRROR_STAT_KEYS) stats[key] = snap ? snap.stats[key] : { mul: 1, flat: 0 };
    return stats;
  }
  function mirrorStatValue(run, key, value) {
    const part = mirrorStatsOf(run)[key];
    return Math.max(1, Math.round(Number(value) * part.mul + part.flat));
  }
  function applyMirrorStats(run, me) {
    if (!run || run.mode !== 'endless' || !run.mirrorSnapshot) return;
    const ratio = clamp01(Number(me.hp) / Math.max(1, Number(me.maxHp) || 1));
    for (const key of MIRROR_STAT_KEYS) me[key] = mirrorStatValue(run, key, me[key]);
    me.hp = Math.max(1, Math.round(me.maxHp * ratio));
  }

  function freezeMirrorSnapshot(run) {
    const layer = Math.max(1, Math.floor(Number(run.layer) || 1));
    const prior = cleanMirrorSnapshot(run.mirrorSnapshot);
    if (prior && prior.absorbedThrough >= layer) return prior;
    const probe = mirrorProbeRun(run);
    const prepared = nextBattle('endless', probe);
    if (!prepared.ok) return null;
    const hero = isHeroRun(run) ? TowerHero.fighter(run.hero) : null;
    const st = hero ? Object.assign({ hp: hero.maxHp }, hero, { hp: hero.maxHp }) : State.totalStats({ useProps: false }), account = hero ? hero.baseStats : S();
    const cap = Math.max(1, Math.round(Number(st.hp) || 1));
    const liveHp = currentHp(run), ratio = liveHp.maxHp > 0 ? clamp01(liveHp.hp / liveHp.maxHp) : clamp01(run.carry);
    const me = { power: st.power, agility: st.agility, speed: st.speed, maxHp: cap, hp: Math.max(1, Math.round(cap * ratio)),
      baseStats: { power: account.power, agility: account.agility, speed: account.speed },
      weapons: [], skills: [], effects: hero ? {} : (State.equipmentEffects ? State.equipmentEffects() : {}) };
    // 只跑 adjustMe：不再跑 Sim 的首轮光环/幻兽，也不做低血条件取样。
    // 于是后发制人、战斗续航、开场固定值这些纯局内效果不会改变快照。
    prepared.adjustMe(me);
    if (!prepared.mirrorFrame || !prepared.mirrorFrame.stats) return null;
    const stats = {};
    for (const key of MIRROR_STAT_KEYS) stats[key] = Object.assign({}, prepared.mirrorFrame.stats[key]);
    const source = { layer: layer, firstRound: true, power: me.power, agility: me.agility, speed: me.speed, maxHp: me.maxHp };
    return cleanMirrorSnapshot({ version: 1, absorbedThrough: layer, stats,
      source: source, combat: mirrorCombatAtFirstRound(me) });
  }
  function clearMirrorBuild(run, mirror) {

    const blade = bladeRowOf(run);
    for (const row of (run.permanent || []).concat(run.limited || [])) {
      if (row.id !== D().MIRROR.id && !D().isBladeId(row.id)) {
        logBuff(run, row.id, 'lose', { stacks: row.stacks || 1, detail: '封存进照影之境' });
      }
    }
    run.permanent = [mirror]; run.limited = blade ? [blade] : []; run.buffs = [];
    for (const key of ['killPower', 'bonusPower', 'hpBonus', 'winMaxHp', 'winHpFlat', 'winStatPower', 'winStatAgility',
      'winStatSpeed', 'winTakenMul', 'sellBonus', 'shopSpend', 'shopSpendProcs', 'shopSpendLimited', 'permSlots',
      'fragileMulBase', 'fragileMulBurned', 'fragileHealBase', 'fragileCoinBase', 'rarityBoost', 'enemyMaxHpDown',
      'enemyPowerDown', 'shopDiscount', 'shopDiscountPct', 'shopHalfPending', 'legendPity']) run[key] = 0;
    for (const key of ['fragileGot', 'pickGot', 'fragileSeeds', 'weaponBoost', 'skillBoost']) run[key] = {};
    for (const key of ['fragileBase', 'fragileBurned']) run[key] = { power: 0, agility: 0, speed: 0 };
    for (const key of ['instantIds', 'pickBuffIds', 'permSlotIds', 'slotFreeIds', 'deferredPicks', 'fragileHealBurned',
      'fragileCoinBurned', 'brokenMarks', 'patrolTolls', 'env', 'debuffs']) run[key] = [];
    for (const key of ['spendGain', 'pendingPick', 'patrolShopGift', 'patrolShopSpend', 'patrolFoeGain', 'retrySnap',
      'shop', 'choices', 'choicesKind', 'choiceQueue', 'pendingRetry', 'battleChoiceSeed',
      'lastSacrifice', 'pendingAfterShop']) delete run[key];
    // 试炼币与铸币(retryToken)是已赚到的余额；只清旧战前快照，不抹钱包。
    run.mintGroup = -1; run.envCoinMul = 1; run.reviveUsed = 0; run.reviveLayer = 0;
  }

  function mirrorStacks(run) {
    const row = ((run && run.permanent) || []).find((b) => b && b.id === D().MIRROR.id);
    return row ? Math.max(1, Math.floor(Number(row.stacks) || 1)) : 0;
  }

  function mirrorPickupPending(run) {
    if (!run || run.phase !== 'mirror') return false;
    return Math.floor(Number(run.mirrorTaken) || 0) !== Math.floor(Number(run.layer) || 0);
  }
  // 拾取「照影之境」：第一次新增一行（放在永久表最前面），之后每次 +1 层。
  // ⚠ 不走 `addBuff`：那一条会走「永久位不够 → 让玩家换掉一个」的流程，
  function takeMirrorReward() {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    if (run.phase !== 'mirror') return { ok: false, msg: '现在没有可以拾取的东西。' };
    if (!mirrorPickupPending(run)) return { ok: false, msg: '这一份已经拾取过了。' };
    const id = D().MIRROR.id;
    const def = D().BUFF_BY_ID[id];
    let first = false, row = (run.permanent || []).find((b) => b && b.id === id);
    if (row) {
      row.stacks = Math.max(1, Math.floor(Number(row.stacks) || 1)) + 1;
    } else {
      first = true;
      row = { id: id, stacks: 1, at: nextAcqSeq(run), uid: nextUid(run) };

      run.permanent = [row].concat(run.permanent || []);
    }
    run.mirrorTaken = Math.max(1, Math.floor(Number(run.layer) || 1));
    logBuff(run, id, 'get', { detail: (def ? def.name : id) + ' 第 ' + row.stacks + ' 层' });
    save();
    return { ok: true, id: id, name: def ? def.name : id, stacks: row.stacks, first: first };
  }

  function enterMirrorWorld() {
    const run = endless().run;
    if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
    if (run.phase !== 'mirror') return { ok: false, msg: '现在不在镜中世界的入口。' };
    if (mirrorPickupPending(run)) return { ok: false, msg: '先把这一件拾取了。' };
    const through = Math.max(1, Math.floor(Number(run.layer) || 1));
    const old = cleanMirrorSnapshot(run.mirrorSnapshot);
    if (!old || old.absorbedThrough < through) {
      const hp = currentHp(run), ratio = hp.maxHp > 0 ? clamp01(hp.hp / hp.maxHp) : clamp01(run.carry);
      const snapshot = freezeMirrorSnapshot(run);
      if (!snapshot) return { ok: false, msg: '未能封存本轮首回合属性，请重试。' };
      const mirror = (run.permanent || []).find((row) => row.id === D().MIRROR.id);
      if (!mirror) return { ok: false, msg: '先把这一件拾取了。' };
      run.mirrorSnapshot = snapshot;
      clearMirrorBuild(run, mirror);
      run.baseMaxHp = Math.max(1, Math.round(Number(heroBaseHp(run)) || 1));
      const cap = currentMaxHp(run);
      run.hpAbs = Math.max(1, Math.round(cap * ratio)); run.carry = ratio;
      run.lastMaxHp = cap; run.refMaxHp = cap; run.lastHp = run.hpAbs;
    }
    run.phase = null;
    delete run.mirrorTaken;
    advanceLayer(run, 'endless');
    save();
    return { ok: true, layer: run.layer, stacks: mirrorStacks(run) };
  }
  // 是否需要在「刚清完这一层」时放弃一个永久增益（轮内第 20 层起、每 10 层一次）。
  // ⚠ `n >= 20` 若不换成轮内层号，第 110 / 210 层（轮内第 10 层）会被误判成「要交增益」——
  // ⚠ 另一个坑：块注释里别写「两个星号 + 加粗 + 紧跟一个斜杠」那种写法 ——
  function needPermSacrifice(layer) {
    const n = Math.max(0, Math.floor(Number(layer) || 0));
    return D().cycleLayer(n) >= 20 && n % 10 === 0 && D().sacrificeAllowed(n);
  }

  function sacrificeCandidates(run) {
    return (run.permanent || [])
      .map((b) => ({ id: b.id, uid: b.uid, slotFree: rowFreeOf(b), stacks: Math.max(1, Math.floor(Number(b.stacks) || 1)),
        buff: D().BUFF_BY_ID[b.id] }))
      .filter((x) => x.buff && !D().hasTag(x.buff, 'hidden'));
  }

  function sacrificePerm(ref) {
    const run = endless().run;
    if (!run || run.phase !== 'sacrifice') return { ok: false, msg: '现在不是放弃永久增益的时机。' };
    const hit = findRowRef(run, ref);
    const row = hit && hit.list === run.permanent ? hit.row : null;
    if (!row) return { ok: false, msg: '只能放弃你已有的永久增益。' };
    const id = row.id;
    const pick = { id: id, buff: D().BUFF_BY_ID[id] };
    if (!pick.buff) return { ok: false, msg: '只能放弃你已有的永久增益。' };

    row.stacks = Math.max(0, Math.floor(Number(row.stacks) || 1) - 1);
    if (row.stacks <= 0) {

      run.permanent = run.permanent.filter((b) => b !== row);
    }

    syncSlotFree(run);

    const mods = pick.buff.mods || {};
    if (mods.permSlot) run.permSlots = Math.max(0, (Number(run.permSlots) || 0) - mods.permSlot);

    if (id === 'C32' || id === 'C33') { dropPickBoost(run, id); run.pickBuffIds = (run.pickBuffIds || []).filter((x) => x !== id); }
    const log = { id: id, name: pick.buff.name, stacks: row.stacks };
    run.lastSacrifice = { id: id, name: pick.buff.name, layer: run.layer };
    run.phase = null;
    advanceLayer(run, 'endless');

    noteSacrificeDoneStory(run);
    const lost = applyBrokenMarkLoss(run);
    save();
    return { ok: true, sacrificed: log, lostMark: lost, layer: run.layer };
  }
  // 旧档 / 只有隐藏永久增益时 phase 可能已经是 sacrifice 但没有候选：
  // 直接推进到下一层，避免界面每次重画都再弹一次空弹窗。
  function skipEmptySacrifice() {
    const run = endless().run;
    if (!run || run.phase !== 'sacrifice') return { ok: false };
    if (sacrificeCandidates(run).length) return { ok: false, msg: '还有可放弃的永久增益。' };
    run.phase = null;
    advanceLayer(run, 'endless');
    save();
    return { ok: true, layer: run.layer };
  }
  function applyBrokenMarkLoss(run) {

    if (run && run.mode === 'tower') return null;
    // ⚠ 别再写成绝对层号 `layer > 30 && layer % 2 === 0`：那样 102 / 104… 层就会开始丢，
    if (!D().canBrandLoss(run && run.layer)) return null;
    const layer = Math.max(0, Math.floor(Number(run && run.layer) || 0));
    const lost = loseRandomBrokenMark(run);
    if (!lost) return null;
    run.lostMarks = (run.lostMarks || []).concat([{ layer: layer, label: lost.label }]).slice(-20);
    // 第一次被塔夺走烙印：挂上 `layer31` 那一段（并让提示窗停留久一点）。
    // 顺序是「先提示、后剧情」—— pendingStory 不会顶掉提示窗，界面在提示点掉之后再播。
    noteFirstMarkLostStory(run);
    return lost;
  }

  function settleFromShop() {
    const run = endless().run;
    if (!run || run.phase !== 'shop') return { ok: false };

    if (run.shop && run.shop.mint && run.shop.boundary !== true) {
      return { ok: false, msg: '铸币商店不能结算离场。' };
    }
    run.phase = 'checkpoint';
    return settleEndless();
  }

  function continueEndless() {
    const run = endless().run;
    if (!run || run.phase !== 'checkpoint') return { ok: false };
    run.phase = null;
    advanceLayer(run, 'endless');
    save();
    return { ok: true, layer: run.layer };
  }



  function abandon(mode) {
    if (mode === 'tower') {
      const run = tower().run;
      if (!run || run.attempt) return { ok: false };
      const layer = run.layer;
      tower().run = null;
      tower().retry = null;
      save();
      return { ok: true, layer };
    }
    const run = endless().run;
    if (!run || run.attempt) return { ok: false };
    const out = { ok: true, score: run.score, layer: run.layer };
    out.summary = buildEndlessSummary(run, 'lose', 'abandon');
    settleScore(run, out);
    settleRunTickets(run, out);
    finishEndlessSummary(out);
    endless().run = null;
    save();
    return out;
  }



  function towerInfo() {
    settleBlackTowerRewards();
    const t = tower(), s = S();
    const layer = t.maxLayer + 1;
    return { maxLayer: t.maxLayer, nextLayer: layer, books: s.props[BOOK_PROP] || 0,
      gold: D().towerGold(layer), battles: layer % 10 === 0 ? 5 : 4,
      level: D().towerLevel(layer), mult: D().towerMult(layer),
      retry: t.retry || null,
      run: t.run ? { layer: t.run.layer, battleNo: t.run.idx + 1, battleCount: t.run.plan.length, carry: t.run.carry,
        curMaxHp: currentMaxHp(t.run), curHp: currentHp(t.run).hp, hpAbs: hpAbsOf(t.run), pot: t.run.pot, failedAt: t.run.failedAt == null ? null : t.run.failedAt,
        choices: t.run.choices ? t.run.choices.slice() : null,
        debuffs: (t.run.debuffs || []).slice(),
        // 环境词缀：挑战塔与无尽塔共用同一套环境（第 5 层起层内可能出现），
        // 主界面要把它画出来（与无尽塔同一个 envPanelHtml），所以这里必须一起给出，
        env: (t.run.env || []).map((x) => {
          const raw = D().ENDLESS_ENV_BY_ID[x.id] || { id: x.id, name: x.id, desc: '' };
          const def = D().envDefFor(raw, 'tower');
          const values = envValues(t.run, x);
          const text = D().envText(raw, values, 'tower');
          return Object.assign({}, def, {
            left: x.left, values: values, text: text.text,
            rangeText: D().envRangeText(raw, 'tower'), mech: !!def.mech,
          });
        }),
        lastMaxHp: Math.max(0, Number(t.run.lastMaxHp) || 0),
        lastHp: Math.max(0, Number(t.run.lastHp) || 0),
        curMaxHp: currentMaxHp(t.run),
        next: t.run.plan[t.run.idx] ? Object.assign({ kind: t.run.plan[t.run.idx].kind }, entryInfo(t.run.plan[t.run.idx], t.run.layer, t.run.idx === t.run.plan.length - 1)) : null } : null,
      preview: preview(layer) };
  }
  function endlessInfo() {
    const e = endless();

    const victoryBonus = !ONLINE && e.run && Math.max(0, Math.floor(Number(e.run.bestLayer) || 0)) >= endlessBonusMinLayer()
      ? Math.max(0, Math.floor(Number(D().ENDLESS_X00_BONUS_TICKETS) || 0)) : 0;
    const onlineWeek = ONLINE ? onlineWeekState() : null;
    const runTickets = (ONLINE && e.run) ? previewSettleTickets(e.run) : null;

    const allBest = Math.max(e.best, e.heroBest);
    const allWeekBest = Math.max(e.weekBest, e.heroWeekBest);
    const allBestLayer = Math.max(e.bestLayer, e.heroBestLayer);
    return { best: e.best, weekBest: e.weekBest, bestLayer: e.bestLayer, heroBest: e.heroBest, heroWeekBest: e.heroWeekBest, heroBestLayer: e.heroBestLayer,
      allBest, allWeekBest, allBestLayer,
      weekTickets: onlineWeek ? onlineWeek.used : 0,
      weekCap: onlineWeek ? onlineWeek.cap : 0,
      weekLeft: onlineWeek ? onlineWeek.left : 0,
      lastSummary: e.lastSummary ? cloneRun(e.lastSummary) : null,
      tickets: S().props[TICKET_PROP] || 0,
      run: e.run ? { ruleset: isHeroRun(e.run) ? 'hero' : 'default', hero: isHeroRun(e.run) ? cloneRun(e.run.hero) : null, layer: e.run.layer, score: e.run.score, coins: e.run.coins, carry: e.run.carry,
        // 待播剧情 id（没有就是 null）—— 界面据此决定要不要进剧情展示模式。
        story: e.run.story || null,
        pendingStoryId: e.run.pendingStory || null,
        pendingStoryHold: e.run.pendingStoryHold === true,

        lastCoinsGained: Math.max(0, Math.floor(Number(e.run.lastCoinsGained) || 0)),

        lastMintGained: Math.max(0, Math.floor(Number(e.run.lastMintGained) || 0)),
        lastCoinBreak: e.run.lastCoinBreak ? Object.assign({}, e.run.lastCoinBreak,
          { boosts: (e.run.lastCoinBreak.boosts || []).map((b) => Object.assign({}, b)) }) : null,

        coinBase: D().coinBattleBase(e.run.layer),
        coinBand: D().coinBattleTierLabel(e.run.layer),
        battleNo: e.run.idx + 1, battleCount: e.run.plan.length, phase: e.run.phase,

        mirrorPending: mirrorPickupPending(e.run),
        mirrorTaken: Math.floor(Number(e.run.mirrorTaken) || 0) === Math.floor(Number(e.run.layer) || 0),
        mirrorStacks: mirrorStacks(e.run),
        mirrorSnapshot: cleanMirrorSnapshot(e.run.mirrorSnapshot),
      debuffs: (e.run.debuffs || []).slice(),
        choices: e.run.choices ? e.run.choices.slice() : null,

        choicesKind: e.run.choicesKind || null,
        choiceQueue: (e.run.choiceQueue || []).map((q) => ({ choices: (q.choices || []).slice(), kind: q.kind })),

        pendingRetry: e.run.pendingRetry ? Object.assign({}, e.run.pendingRetry) : null,

        blade: bladeInfoOf(e.run),
        bladeSacrificePending: e.run.bladeSacrificePending === true,
        bladeEventPending: e.run.bladeEventPending ? Object.assign({}, e.run.bladeEventPending) : null,
        bladePending: bladePendingOf(e.run),
        next: e.run.plan[e.run.idx] ? Object.assign({ kind: e.run.plan[e.run.idx].kind }, entryInfo(e.run.plan[e.run.idx], e.run.layer, e.run.idx === e.run.plan.length - 1)) : null,
        bestLayer: e.run.bestLayer, segment: D().endlessSegment(e.run.layer),
        plan: (e.run.plan || []).map((entry, i) => Object.assign({ kind: entry.kind }, entryInfo(entry, e.run.layer, i === e.run.plan.length - 1))),

        achievements: (e.run.achievements || []).slice(),
        scoreLog: (e.run.scoreLog || []).slice(-12),
        deathSaves: Math.max(0, Number(e.run.deathSaves) || 0),

        mechs: [],
        restShopUsed: !!e.run.restShopUsed,

        mintShop: !!(e.run.shop && e.run.shop.mint),

        shopByBuff: !!(e.run.shop && e.run.shop.byBuff),
        shopStoryShown: !!(e.run.shop && e.run.shop.storyShown),
        // 这家店摇到的随机商人文案（同一次相遇里必须一直用这一段，见 setShopStoryPick）。
        shopStoryPick: (e.run.shop && e.run.shop.storyPick) || null,

        hasShop: !!e.run.shop,

        shopHalfPending: Math.max(0, Math.floor(Number(e.run.shopHalfPending) || 0)),
        pendingPick: e.run.pendingPick || null,

        env: (e.run.env || []).map((x) => {
          const def = D().ENDLESS_ENV_BY_ID[x.id] || { id: x.id, name: x.id, desc: '' };
          const values = envValues(e.run, x);
          const t = D().envText(def, values);
          return Object.assign({}, def, {
            left: x.left, values: values, text: t.text,
            rangeText: D().envRangeText(def), mech: !!def.mech,
          });
        }),
        permSlots: Math.max(0, Number(e.run.permSlots) || 0),
        slotFreeIds: (e.run.slotFreeIds || []).slice(),
        permUsed: permUsed(e.run),
        lastMaxHp: Math.max(0, Number(e.run.lastMaxHp) || 0),
        lastHp: Math.max(0, Number(e.run.lastHp) || 0),
        curMaxHp: currentMaxHp(e.run),
        curHp: currentHp(e.run).hp,
        hpAbs: hpAbsOf(e.run),
        fragileBase: Object.assign({ power: 0, agility: 0, speed: 0 }, e.run.fragileBase || {}),
        fragileBurned: Object.assign({ power: 0, agility: 0, speed: 0 }, e.run.fragileBurned || {}),
        enemyMaxHpDown: Math.max(0, Math.min(ENEMY_MAXHP_DOWN_CAP, Number(e.run.enemyMaxHpDown) || 0)),
        enemyPowerDown: Math.max(0, Number(e.run.enemyPowerDown) || 0),
        shopSpend: Math.max(0, Number(e.run.shopSpend) || 0),
        spendGain: Object.assign({ power: 0, agility: 0, speed: 0, hp: 0 }, e.run.spendGain || {}),
        permCap: permSlots(e.run),
        finished: e.run.finished || null,
        victoryReady: canSettleEndlessVictory(e.run),
        victoryBonusTickets: victoryBonus,
        trueEndBonusTickets: ONLINE ? Math.max(0, Math.floor(Number(runTickets && runTickets.victoryBonus) || 0)) : victoryBonus,
        trueEndBonusUsed: ONLINE ? !!(runTickets && runTickets.victoryBonusUsed) : false,
        // · 联机版：每累计通过 10 层 1 张 + 结算铸币 >10 再 +1，受本周 10 张上限限制；
        // · retryToken 是手上的铸币（字段名沿用旧名，避免旧档迁移）。
        retryToken: Math.max(0, Math.floor(Number(e.run.retryToken) || 0)),
        ticketsIfSettle: ONLINE ? runTickets.total : (D().endlessTickets(e.run.layer) + victoryBonus),
        ticketsOnExit: ONLINE ? runTickets.total : (D().endlessTickets(e.run.layer) + victoryBonus
          + Math.max(0, Math.floor(Number(e.run.retryToken) || 0))),
        ticketsRaw: ONLINE ? runTickets.rawTickets : 0,
        ticketsCapped: ONLINE ? runTickets.capped === true : false,
        layerTickets: ONLINE ? runTickets.layerTickets : D().endlessTickets(e.run.layer),
        mintBonusTickets: ONLINE ? runTickets.bonusTickets : 0,

        scale: D().endlessScaleParts(e.run.layer),
        // 注：曾有一个 `modsOn`（「这一层还吃不吃环境 / 丢烙印 / 放弃增益」）字段。
        // 第八十六批起这三条按 100 层一轮走、恒为成立，该字段再无判别力，

        shopSlots: D().endlessShopSlots(e.run.layer),
        choiceCut: D().choiceCut(e.run.layer),
        choicesPerBattle: choiceSlotsOf(e.run),
        noShop: !!D().layerNoShop(e.run.layer) } : null };
  }
  function progressOf(run, id, row) {
    const g = globalMul(run);
    // （否则悬停里上半截写附魔后的值、下半截「当前进度」还是基础值）。
    const em = row ? rowEnchMulOf(row) : 1;

    const gm = row ? buffEffectMulOf(row, g) : g;
    const pct = (v) => Math.round((Number(v) || 0) * 100);
    // 这一栏还没有账本（老档 / 外部直接写了 run 级字段）时退回 run 级合计。
    const rowStacks = (fallbackId) => (row ? Math.max(1, Math.floor(Number(row.stacks) || 1)) : Math.max(1, stacksOf(run, fallbackId)));
    const rowVal = (key, fallback) => {
      const v = row ? growOf(row, key) : 0;
      return v > 0 ? v : Math.max(0, Number(fallback) || 0);
    };
    if (id === 'C06') {
      const cap = D().BUFF_BY_ID.C06.mods.killPowerCap * rowStacks('C06') * gm;
      return '已累计 攻击 +' + pct(rowVal('killPower', run.killPower)) + '%（上限 +' + pct(cap) + '%）';
    }
    // C07 吞噬成长：累计值在 run.winMaxHp、上限字段是 mods.winMaxHpCap。
    // · C07 从不写那个 kill 前缀字段（它是给「击杀成长」用的历史字段），累计恒为 0
    // · 上限字段名不存在 → 上限也恒为 0
    if (id === 'C07') {
      const cap = D().BUFF_BY_ID.C07.mods.winMaxHpCap * rowStacks('C07') * gm;
      return '已累计 生命上限 +' + pct(rowVal('winMaxHp', run.winMaxHp)) + '%（上限 +' + pct(cap) + '%）';
    }
    if (id === 'C11') return '已累计 生命上限 +' + Math.round(rowVal('winHpFlat', run.winHpFlat));
    if (id === 'C34' || id === 'C35') {
      const def34 = D().BUFF_BY_ID[id];

      const stacks34 = id === 'C35'
        ? (row ? Math.max(1, Math.floor(Number(row.stacks) || 1)) : (stacksOf(run, id) || 1))
        : (stacksOf(run, id) || 1);
      const per = (def34.mods.powerPerEmptySlot != null ? def34.mods.powerPerEmptySlot : def34.mods.powerPerPermBuff) * gm;
      let n = id === 'C34'
        ? Math.max(0, permSlots(run) - permUsed(run))
        : (function () {
            // 否则面板会出现「3.4000000000000004 个永久增益」。
            const w = def34.mods.powerPerPermBuffEnchantedWeight != null
              ? Math.max(0, Number(def34.mods.powerPerPermBuffEnchantedWeight)) : 1;
            return permanentBuffCountFor(run, row, w);
          })();

      const total = Math.round(per * n * stacks34 * 1000) / 1000;
      const unit = id === 'C34' ? '空槽' : '永久增益';

      const countText = id === 'C34' ? String(n) : n.toFixed(1);
      const pctText = (v) => { const s = (v * 100).toFixed(1); return s.replace(/\.0$/, ''); };
      return '当前 ' + countText + ' 个' + unit + ' × ' + Math.round(per * 100) + '%' +
        (stacks34 > 1 ? ' × ' + stacks34 + ' 层' : '') + ' = 攻击 +' + pctText(total) + '%' +
        '（永久位 ' + permUsed(run) + '/' + permSlots(run) + '）';
    }
    if (id === 'C12') {
      return '第 10 层起已累计 力 +' + Math.round(rowVal('winStatPower', run.winStatPower)) +
        ' / 敏 +' + Math.round(rowVal('winStatAgility', run.winStatAgility)) +
        ' / 速 +' + Math.round(rowVal('winStatSpeed', run.winStatSpeed));
    }
    if (id === 'C20') {
      // 三项都是「终乘」：写在最终值上，而不是并进攻击/敏捷/速度面板（否则会被别的乘区稀释）。
      // 注意不能用 lowHpPowerMul 当攻击那一份 —— C20 用的是 lowHpFinalMul，
      const m20 = D().BUFF_BY_ID.C20.mods;
      return '生命 ≤' + Math.round((m20.lowHpAt || 0.5) * 100) + '% 时：最终伤害 ×' +
        (1 + (m20.lowHpFinalMul || 0) * em).toFixed(2) + '、最终敏捷 ×' + (1 + (m20.lowHpAgilityMul || 0) * em).toFixed(2) +
        '、最终速度 ×' + (1 + (m20.lowHpSpeedMul || 0) * em).toFixed(2) + '（终乘）';
    }
    if (id === 'N13' || id === 'C46' || id === 'C47') {
      const def = D().BUFF_BY_ID[id], mm = def.mods;
      const bits = ['空生命上限 +' + pct(mm.emptyMaxHpMul * em)];
      if (mm.lowHpRegenPct) bits.push('低血每回合回 ' + pct(mm.lowHpRegenPct * em) + '（最多到 ' + pct(mm.lowHpRegenAt) + '）');
      if (mm.lowHpTakenMul) bits.push('低血减伤 ' + pct(-mm.lowHpTakenMul * em));
      if (mm.lowHpLifestealPct) bits.push('低血吸血 ' + pct(mm.lowHpLifestealPct * em));
      return '每场开始：' + bits.join('、');
    }
    if (id === 'N14') return '生命 ≤' + pct(D().BUFF_BY_ID.N14.mods.lowHpAt) + '% 时减伤 ' + pct(-D().BUFF_BY_ID.N14.mods.lowHpTakenMul);
    if (id === 'C48') {

      const cap = (D().BUFF_BY_ID.C48.mods.winTakenMulCap || 0.25) * rowStacks('C48') * em;
      const v = row ? growOf(row, 'winTakenMul') : winTakenMulOf(run);
      return '已累计 受到伤害 −' + pct(v) + '（上限 −' + pct(cap) + '）';
    }
    if (id === 'N15') return '接下来免疫一切反伤（荆棘 / 镜鳞 / 绝对防御）';
    if (id === 'C25') return '这一本已累计 卖价 +' + Math.round(sellBonusOf(run, row)) + ' 试炼币（只加自己）';
    const def = D().BUFF_BY_ID[id];
    if (def && def.mods && def.mods.fragileStat) {
      const key = def.mods.fragileStat;
      const names = { power: '力量', agility: '敏捷', speed: '速度' };
      const fb = fragileBonus(run, key);
      const now = Math.round(fb.value * 100);
      if (fb.burned) return (names[key] || key) + ' +' + now + '%（已损毁：全额并本局永久保留）';

      const alive = Math.max(0, Number(def.mods.fragilePct) || 0);
      const burnedNext = Math.max(0, Number(def.mods.fragileBurnedPct != null
        ? def.mods.fragileBurnedPct : alive) || 0);
      const after = Math.round((fb.base - alive + fb.burned + burnedNext) * 100);
      return (names[key] || key) + ' +' + now + '%（烙印存在；损毁后升为 ' +
        after + '% 并本局永久保留）';
    }
    if (id === 'C36') {
      const sg = Object.assign({ power: 0, agility: 0, speed: 0, hp: 0 }, run.spendGain || {});

      const rows36 = (run.permanent || []).filter((b) => b && b.id === 'C36');
      const procs = rows36.length
        ? rows36.reduce((n, b) => n + Math.max(0, Math.floor(Number(b.procs) || 0)), 0)
        : Math.max(0, Math.floor(Number(run.shopSpendProcs) || 0));
      const copies = Math.max(1, rows36.length || stacksOf(run, 'C36'));
      let best = null;
      for (const row of rows36) {
        const p = Math.max(0, Math.floor(Number(row.procs) || 0));
        // 进度条要显示附魔后的真实门槛，否则玩家会看到 5/5 却还没触发。
        const st = shopSpendStepFor(D().BUFF_BY_ID.C36, p, row);
        const have = Math.max(0, Number(row.spend) || 0);
        const left = Math.max(0, st - have);
        if (!best || left < best.left) best = { left: left, step: st, have: have };
      }
      const step = best ? best.step : shopSpendStepFor(D().BUFF_BY_ID.C36, procs);
      const have = best ? best.have : Math.floor(Number(run.shopSpend) || 0);
      return '已累计 力 +' + sg.power + ' / 敏 +' + sg.agility + ' / 速 +' + sg.speed + ' / 生命 +' + sg.hp +
        '（已提升 ' + procs + ' 次' + (copies > 1 ? ' · ×' + copies + ' 份' : '') +
        ' · 距下次 ' + have + '/' + step + ' 试炼币）';
    }
    return null;
  }


  function isTowerBattleBuff(id) {
    const def = D().BUFF_BY_ID[id];
    return !!(def && D().hasTag(def, 'nextBattle'));
  }
  function ownedBuffs(mode) {
    // 直接遍历本局的两张表（permanent / limited），不要用 eachBuff ——
    const run = mode === 'tower' ? tower().run : endless().run;
    if (!run) return [];
    const scopeName = { limited: '限次', permanent: '永久', instant: '即时' };
    const out = [];
    const add = (entry) => {
      const buff = entry && D().BUFF_BY_ID[entry.id];
      // 查不到定义的条目进不来：normalizeRun 的 cleanBuffs 已经先过滤过一遍
      // （不可出售、不可献祭、不进随机池），但必须进增益面板 ——
      if (!buff || (D().hasTag(buff, 'hidden') && !D().hasTag(buff, 'story'))) return;
      out.push({ id: buff.id, name: buff.name, desc: D().descOf(buff, mode), rarity: buff.rarity, kind: buff.kind,        scopeName: scopeName[buff.kind], stacks: entry.stacks || 1,
        progress: progressOf(run, buff.id, entry),
        uses: buff.kind === 'limited' ? entry.uses : undefined,
        nextBattle: D().hasTag(buff, 'nextBattle'),
        on: buff.kind === 'limited' ? entry.on !== false : true,
        // 获得顺序（越早拿到的越小）与「是否被虚空铭文附魔过（不占位）」——
        // 商店的出售 / 交换列表按这两个字段排（见 sortForSell）。
        at: Math.max(0, Math.floor(Number(entry.at) || 0)),

        slotFree: rowFreeOf(entry), uid: entry.uid,

        enchMul: rowEnchMulOf(entry), enchants: rowEnchantsOf(entry).slice(),
        forced: entry.forced === true,
        unlimited: D().isBladeId(buff.id) && !(Number(entry.uses) > 0),
        sellable: !!run.shop && buff.kind !== 'instant' && !D().hasTag(buff, 'hidden')
          && !D().hasTag(buff, 'story') && !D().isBladeId(buff.id),
        sellPrice: sellPriceOf(run, buff, entry.stacks || 1, entry) });
    };
    (run.permanent || []).forEach(add);
    (run.limited || []).forEach(add);
    return out;
  }

  // `at` 相同（老档没补上号）时保持原顺序 —— 排序稳定。
  function sortForSell(list) {
    return (list || []).map((b, i) => ({ b: b, i: i })).sort((x, y) => {
      const fx = x.b && x.b.slotFree ? 1 : 0;
      const fy = y.b && y.b.slotFree ? 1 : 0;
      if (fx !== fy) return fx - fy;
      const ax = Math.max(0, Math.floor(Number(x.b && x.b.at) || 0));
      const ay = Math.max(0, Math.floor(Number(y.b && y.b.at) || 0));
      if (ax !== ay) return ay - ax;
      return x.i - y.i;
    }).map((x) => x.b);
  }
  // 「卖出」按钮更糟 —— 所以源头就不要列出来）。
  function sellListOf(mode) {
    return sortForSell(ownedBuffs(mode === 'tower' ? 'tower' : 'endless').filter((b) => {
      if (b.kind === 'instant') return false;
      const def = D().BUFF_BY_ID[b.id];
      return !(def && D().hasTag(def, 'story'));
    }));
  }



  function debugSetEndlessLayer(n) {
    const layer = Math.max(1, Math.floor(Number(n) || 1));
    const e = endless();
    if (!e.run) { const r = startEndlessRun(); if (!r.ok) return r; }
    e.run.layer = layer;
    // 必须和 advanceLayer 用同一组参数（salt + squirrelsOnly=true）重建，
    // 否则第 4 场的 boss 会和界面预告的不是同一只。
    e.run.plan = buildPlan(layer, e.run.salt, true);
    e.run.idx = 0;
    e.run.choices = null;
    e.run.phase = null;
    e.run.finished = null;

    e.run.debuffs = [];
    // 上一层的待播剧情若不清掉，会跟着你跳到任何一层去重播，
    // ⚠ 只清「待播」这一类本局内的状态（run 上的 story / pendingStory / x00stage），
    clearRunStory('endless');
    e.run.x00stage = 0;

    e.run.x00PreNo = 0;

    delete e.run.patrolStoryAt;
    // 调试挪层：旧的剑事件 / 献祭窗不能跟着跳到新层；到了 51/61… 则按正常规则重新排。
    delete e.run.bladeEventPending;
    delete e.run.bladeSacrificePending;
    maybeQueueBladeEvent(e.run);

    autoPlayStory(e.run);
    save();
    return { ok: true, layer };
  }

  function debugResetStory() {
    const e = endless();
    const n = Object.keys(e.storySeen || {}).length;
    e.storySeen = {};
    if (e.run) {
      clearRunStory('endless');
      e.run.x00stage = 0;

      e.run.x00PreNo = 0;
      // 巡视的段号也要回到第一段 —— 否则「清空之后从头看一遍」时，
      e.run.patrolMeetNo = 0;
      delete e.run.patrolStoryAt;
    }
    save();
    return { ok: true, cleared: n };
  }


  window.Tower = {
    unlocked, endlessUnlocked, ENDLESS_UNLOCK_LEVEL, towerInfo, endlessInfo, preview, planInfo, ownedBuffs, bossPool, debugGrantBuff, debugLoseBuff, pickCandidates, applyPickBuff,

    setRunStory, clearRunStory, clearRunStoryHold, clearRunStoryPending, storySeen, markStorySeen, storyEnabled, setStoryEnabled,
    markShopStoryShown, setShopStoryPick,

    nextEntryStoryOf: () => nextEntryStory(endless().run),
    // 整百层「第 1 场之前」那两段讲到哪一段了（`x00BeforeFirst` 的唯一出口，tower-plot 也用它）。
    x00BeforeFirstOf: () => x00BeforeFirst(endless().run),

    autoPlayStory: (mode) => (mode === 'tower' ? null : autoPlayStory(endless().run)),

    storyPendingForBattle: (mode) => storyPendingForBattle(mode),

    takeMirrorReward, enterMirrorWorld, mirrorStacks: () => mirrorStacks(endless().run),
    mirrorPending: () => mirrorPickupPending(endless().run),

    canHaveEnvOf: (layer) => D().canHaveEnv(layer),
    canBrandLossOf: (layer) => D().canBrandLoss(layer),
    layerModsOnOf: (layer) => D().layerModsOn(layer),

    isBrandBuff, unbrokenBrandCount, breakAllBrands,

    activeInscriptionId,

    patrolTollCandidates, payPatrolToll, finishPatrolToll, patrolTollRows,

    buildFoeOf: (mode, layer, entry, salt, isLast) => buildFoe(mode, layer, entry, salt, isLast),
    isEliteEntryOf: (entry, layer, isLast) => isEliteEntry(entry, layer, isLast),

    isPureOpsBuffOf: (def) => isPureOpsBuff(def),

    deferPendingPick: () => parkStalePendingPick(),
    hasPickTargetsOf: (run, kind) => hasPickTargets(run || endless().run, kind),
    resolveDeferredPicksOf: (run) => resolveDeferredPicks(run),
    applyPatrolTollToFoeOf: (run, foe) => applyPatrolTollToFoe(run, foe),
    addShopSpendOf: (run, amount) => addShopSpend(run, amount),
    // 只读（界面/回归）：水晶铭文附魔后的消费门槛（100 → 75/张，见 enchCost）。
    // 界面必须用它显示，才能和 addShopSpend 的实际结算一致。
    enchCostOf: (value, enchMul) => enchCost(value, enchMul),

    sortForSell, sellListOf,
    heroEventInfo: () => { const ev = heroEventFor(endless().run); return ev ? cloneRun(ev) : null; }, resolveHeroEvent, setHeroAppearance,

    heroRunActive: () => isHeroRun(endless().run),
    // 闪避上限（与 Sim.rules.dodgeCap 同源）：面板显示与回归用。
    dodgeCapPct,
    coinTrainHero, heroBladeOf: (run) => heroBladeOf(run || endless().run),
    // 渴血之剑：界面 / 回归共用的只读快照与三个动作。
    bladeInfoOf: (run) => bladeInfoOf(run || endless().run),
    bladeSacrificeCandidates: (run) => bladeSacrificeCandidates(run || endless().run),
    sacrificeBlade, resolveBladeEvent,
    bladePendingOf: (run) => bladePendingOf(run || endless().run),
    startTowerRun, startEndlessRun, nextBattle, reportBattle, interruptBattle, abandon,
    towerBlackCards, settleBlackTowerRewards, endlessBlackCardLayer,
    // 结算预览（只算不改）：放弃本局 / 结算离场的弹窗用它把这一局的账摊开给玩家看。
    // ⚠ 界面是不带参数调的，所以这里必须补上「默认取当前无尽塔对局」——
    previewSettleTickets: (run) => previewSettleTickets(run || endless().run),
    // 联机版：服务端领奖 / 补发成功后回写本机保存的上局战报（只认同一局 id）。
    updateLastSummary,
    pickChoice, toggleLimited, addBuff, applyInstant, openRestShop,
    shopState, buyShopSlot, buyRetryToken, buyShopHeal, rerollShop, sellBuff, closeShop, giveUp, claimShopEnterCoins,

    buyMintSlot, swapMintBuff, rerollMintShop, leaveMintShop,
    mintRollOf: (run, layer) => rollMintShop(run || endless().run, layer == null ? (run || endless().run || {}).layer : layer),
    mintSlotsOf: (run) => rollMintSlots(run || endless().run),
    mintSwapAllowedOf: (run) => swapAllowedOf(run || endless().run),
    mintSwapTargetOf: (run, id) => {
      const r = run || endless().run;
      const b = D().BUFF_BY_ID[id];
      return (r && b) ? rollSwapTarget(r, b) : null;
    },
    canRetry, retryBattle, declineRetry, isTowerBattleBuff, takeAchievementToasts,

    rollShopSlotsOf: (run, paid) => rollShopSlots(run || endless().run, paid),
    // 只读/回归：跑一次「战后环境推进」（不改其它状态），用来核「每 100 层一轮」那条规则 ——
    // 按层号跑，不依赖当前对局（101 层 = 新一轮第 1 层不该抽、105 层起照旧抽）。
    // ⚠ 早期版本写成 `rollEnvAfterBattle(run || endless().run)`：那些调用点传的是普通对象，
    rollEnvOf: (arg) => {
      const run = (arg && typeof arg === 'object') ? arg : { layer: Number(arg) || 1 };
      if (!Array.isArray(run.env)) run.env = [];
      rollEnvAfterBattle(run);
      return run.env;
    },

    poolFilterOf: (run, buff) => poolFilter(run || endless().run, buff),

    ownableOf: (run, buff) => ownable(run || endless().run, buff),
    // 只读（测试/文档）：这件永久增益「叠满后能不能另开一个背包栏位继续叠」。
    permanentRestackableOf: (buff) => permanentRestackable(buff),

    permUsedOf: (run) => permUsed(run || endless().run),
    permSlotsOf: (run) => permSlots(run || endless().run),
    stacksOf: (run, id) => stacksOf(run || endless().run, id),

    reviveInfoOf: (run) => reviveInfoOf(run || endless().run),

    buffWeightOf: (run, idOrBuff) => {
      const r = run || endless().run;
      const b = (idOrBuff && typeof idOrBuff === 'object') ? idOrBuff : D().BUFF_BY_ID[idOrBuff];
      return buffWeightOf(r, b);
    },

    buffDynamicPenaltyOf: (run, idOrBuff) => {
      const r = run || endless().run;
      const b = (idOrBuff && typeof idOrBuff === 'object') ? idOrBuff : D().BUFF_BY_ID[idOrBuff];
      return buffDynamicPenaltyOf(r, b);
    },

    limitedRerollPaidOf: () => limitedRerollPaid(),
    limitedGrantWeightsOf: (run) => limitedGrantWeights(run || endless().run)
      .map((x) => ({ id: x.buff.id, weight: x.weight })),
    limitedGrantWeightOf: (run, id) => limitedGrantWeightOf(run || endless().run, D().BUFF_BY_ID[id]),

    dynamicTierWeightsOf: (run, pool, baseTier) => {
      const r = run || (endless().run || tower().run || {});
      return dynamicTierWeights(baseTier || D().rawTierWeights(1, r), r, pool || D().endlessPool);
    },

    shopHalfPendingOf: (run) => Math.max(0, Math.floor(Number((run || endless().run || {}).shopHalfPending) || 0)),

    layerRestartPendingOf: (run) => hasActiveLayerRestart(run || endless().run),

    _debugNotePityRoll: (run, buff, hasLegendCandidate) => {
      const r = run || endless().run;
      notePityRoll(r, buff, hasLegendCandidate !== false);
      return legendPityOf(r);
    },
    // 调试/测试：直接摇一页试炼商店货架 / 一组战斗奖励选项（走真实抽取路径，含传奇保底）。
    _debugRollShopSlots: (run, paid) => rollShopSlots(run || endless().run, paid || 0),
    _debugRollChoices: (mode, run) => rollChoices(mode || 'endless', run || endless().run),
    // 调试/测试：走真实的「豪掷千金随机限次增益」抽取路径，返回抽到的 id（池空则 null）。
    _debugGrantRandomLimited: (run) => grantRandomLimited(run || endless().run),

    _debugFragileRollOf: (run, ref, pct) => {
      const r = run || endless().run;
      const hit = findRowRef(r, ref);
      if (!hit) return null;
      const broke = fragileRoll(r, hit.row, Math.max(0, Number(pct) || 0));
      return { id: hit.row.id, uid: hit.row.uid, seed: hit.row.fragileSeed, broke: broke };
    },

    rowGrowOf: (run, ref) => {
      const hit = findRowRef(run || endless().run, ref);
      return hit ? cleanGrowObj(hit.row.grow) : null;
    },

    rowRefOf: (run, ref) => {
      const hit = findRowRef(run || endless().run, ref);
      return hit ? { id: hit.row.id, uid: hit.row.uid, key: Number(hit.row.uid) > 0 ? String(hit.row.uid) : String(hit.row.id) } : null;
    },

    fragileFinalMulOf: (run) => fragileFinalMul(run || endless().run),

    legendPityOf: (run) => legendPityOf(run || endless().run),
    legendPityNeed,
    // 只读（测试/UI）：这一场战斗能不能显示「跳过」键（无尽塔 30 层起）。
    skipPlaybackAllowed: (mode, layer) => skipPlaybackAllowed(
      mode, layer == null ? ((mode === 'endless' ? endless().run : tower().run) || {}).layer : layer),

    obtainedCountOf: (run, id) => obtainedCountOf(run || endless().run, id),
    // 只读：当前战斗奖励的选项目数（基础 3 + 抉择扩充层数，上限 6）。
    choiceSlotsOf: (run, mode) => choiceSlotsOf(run || endless().run, mode),

    pickCandidatesOf: (kind) => pickCandidates(kind),


    _debugSetNoEnv: (on) => {
      const e = endless();
      if (!e.run) return { ok: false };
      e.run.noEnvRoll = on !== false;
      if (e.run.noEnvRoll) e.run.env = [];
      return { ok: true, noEnvRoll: e.run.noEnvRoll };
    },
    // 调试/测试：把 E01（战后开店）/ E15（重开本层）从场间选择里排除（模块级开关，不进存档）。
    _debugSetNoFlowBuffs: (on) => { noFlowBuffs = on !== false; return { ok: true, noFlowBuffs: noFlowBuffs }; },
    _debugNoFlowBuffs: () => noFlowBuffs,

    _debugSetNoMintShop: (on) => { noMintShop = on !== false; return { ok: true, noMintShop: noMintShop }; },
    _debugNoMintShop: () => noMintShop,
    needPermSacrifice: (layer) => needPermSacrifice(layer),
    sacrificeCandidatesOf: (run) => sacrificeCandidates(run || endless().run),

    sacrificePerm: (id) => sacrificePerm(id),
    skipEmptySacrifice: () => skipEmptySacrifice(),

    takeRunToasts: () => {
      const run = endless().run;
      if (!run || !Array.isArray(run.pendingToasts) || !run.pendingToasts.length) return [];
      // 只把字符串交给过程飘字；旧档/漏网混进来的成就对象转到成就队列，
      // 否则 `runToast()` 会把它 String() 成「[object Object]」。
      const out = [], legacy = [];
      for (const item of run.pendingToasts) {
        if (item && typeof item === 'object') legacy.push(item);
        else out.push(item);
      }
      run.pendingToasts = [];
      if (legacy.length) {
        run.pendingAchievements = (Array.isArray(run.pendingAchievements) ? run.pendingAchievements : (run.pendingAchievements = []))
          .concat(legacy).slice(-12);
      }
      return out;
    },
    brokenMarksOf: (run) => (run || endless().run || {}).brokenMarks || [],

    rarityBoostOf: (run) => D().rarityBoostOf(run || endless().run),

    instantOwnedCountOf: (run, id) => instantOwnedCount(run || endless().run, id),

    globalMulOf: (run) => globalMul(run || endless().run),
    checkpointInfo, settleEndless, settleEndlessVictory, canSettleEndlessVictory, previewEndlessSummary,
    continueEndless, continueFromShop, settleFromShop,

    debugBuffReport(mode) {
      const m = mode === 'endless' ? 'endless' : 'tower';
      const run = (m === 'endless' ? endless() : tower()).run;
      if (!run) return { ok: false, msg: '当前没有' + (m === 'endless' ? '无尽塔' : '挑战塔') + '对局。' };
      const seen = new Set();
      const collected = [];
      const add = (id, tag, detail) => {
        if (!id) return;
        const def = D().BUFF_BY_ID[id];
        if (!def) return;
        const key = id + '|' + tag;
        if (seen.has(key)) return;
        seen.add(key);
        collected.push({ id, name: def.name, rarity: def.rarity, kind: def.kind, tag, detail: detail || '' });
      };
      for (const b of run.permanent || []) add(b.id, b.stacks > 1 ? '永久 ×' + b.stacks : '永久');
      for (const b of run.limited || []) {
        const def = D().BUFF_BY_ID[b.id] || {};
        const fragile = def.mods && def.mods.fragileBreakPct;
        add(b.id, b.on === false ? '限次（已关闭）' : (fragile ? '限次 · 易碎' : '限次 剩' + b.uses + ' 场'),
          b.stacks > 1 ? '叠 ×' + b.stacks : '');
      }
      for (const id of run.permSlotIds || []) add(id, '槽位扩容（已生效）');
      for (const id of run.pickBuffIds || []) add(id, '选取型（已生效）');

      for (const e of run.buffLog || []) {
        add(e.id, { get: '已获得', stack: '已叠加', instant: '已立即生效', expire: '已用尽消失', break: '已损毁', lose: '已失去' }[e.event] || e.event, e.detail || '');
      }
      return {
        ok: true, mode: m, layer: run.layer,
        collected,
        history: (run.buffLog || []).slice(),
        effects: buffEffectLines(run, {}),
        fragile: { base: run.fragileBase || null, burned: run.fragileBurned || null },
        slots: { used: permUsed(run), cap: permSlots(run) },
      };
    },
    _debugSetLayer(n) { tower().maxLayer = Math.max(0, Math.floor(Number(n) || 0)); save(); },
    // 调试/探针用：endlessInfo/towerInfo 返回的是子集，看不到 killPower、sellBonus、
    // limited 的 uses 这些运行态字段。诊断叠层/限次问题时需要拿到原始 run。
    _debugRun(mode) { return (mode === 'endless' ? endless() : tower()).run; },
    _debugSetStatPeak(field, value) {
      const run = endless().run;
      if (!run) return { ok: false, msg: '当前没有无尽塔对局。' };
      run.statPeaks = Object.assign({}, run.statPeaks || {});
      run.statPeaks[field] = Math.max(0, Number(value) || 0);
      save();
      return { ok: true, peaks: run.statPeaks };
    },


    _debugAdvanceLayer: () => {
      const e = endless();
      if (!e.run) return { ok: false };
      advanceLayer(e.run, 'endless');
      save();
      return { ok: true, layer: e.run.layer, toasts: (e.run.pendingToasts || []).slice() };
    },
    // 调试台专属：立刻开一家铸币商店（跳过概率与层区间判定）。
    // 走的是正式开店路径（掷货架 / 兑现讨价还价对折 / 发 C59 进门币 / 剥掉一家旧店），
    // 唯一区别是 `debug:true` → 不记「本组已刷过」，这一组自然刷出的机会照旧留着。
    _debugSpawnMintShop: () => {
      const e = endless();
      if (!e.run) return { ok: false, msg: '当前没有无尽塔对局（先开始一局）。' };
      const layer = Math.max(1, Math.floor(Number(e.run.layer) || 1));
      openMintShop(e.run, layer, { debug: true });
      save();
      return { ok: true, layer, slots: (e.run.shop && e.run.shop.slots.length) || 0 };
    },
    // 调试台专属：立刻开一家普通（试炼）商店（跳过每 5 层 / 概率判定）。
    // 走正式开店路径（掷货架 / E04 折扣 / E14 对折 / C59 进门币），标记成「战后临时小店」——
    _debugSpawnShop: () => {
      const e = endless();
      if (!e.run) return { ok: false, msg: '当前没有无尽塔对局（先开始一局）。' };
      const layer = Math.max(1, Math.floor(Number(e.run.layer) || 1));
      e.run.shop = makeShop(e.run, 0);
      // 整百层不开店：makeShop 返回 null，这里要判空（否则直接抛异常）。
      if (!e.run.shop) return { ok: false, msg: '第 ' + layer + ' 层是整百层（觐见魔王），这一层不开商店。', layer, slots: 0 };
      e.run.shop.postBattle = true;
      e.run.phase = 'shop';
      save();
      return { ok: true, layer, slots: (e.run.shop && e.run.shop.slots.length) || 0 };
    },
    _debugSetEndlessLayer(n) { return debugSetEndlessLayer(n); },

    _debugResetStory: () => debugResetStory(),

    _debugShiftEndlessLayer(delta) {
      const e = endless();
      const d = Math.round(Number(delta) || 0);
      if (!e.run) return debugSetEndlessLayer(1);
      return debugSetEndlessLayer(Math.max(1, (Math.floor(Number(e.run.layer) || 1)) + d));
    },

    _debugGrantCoins: (n) => {
      const e = endless();
      if (!e.run) return { ok: false, msg: '当前没有无尽塔对局（先开始一局）。' };
      const amount = Math.max(1, Math.min(1000000, Math.round(Number(n) || 0)));
      e.run.coins = Math.max(0, Number(e.run.coins) || 0) + amount;
      noteRunIncome(e.run, 'trialCoinsEarned', amount);
      save();
      return { ok: true, amount, total: e.run.coins, layer: e.run.layer };
    },
    // 调试台专属：直接发铸币（内部字段就是 `run.retryToken`；试炼商店 50 币换 1 枚那种）。
    _debugGrantMint: (n) => {
      const e = endless();
      if (!e.run) return { ok: false, msg: '当前没有无尽塔对局（先开始一局）。' };
      const amount = Math.max(1, Math.min(100000, Math.round(Number(n) || 0)));
      e.run.retryToken = Math.max(0, Number(e.run.retryToken) || 0) + amount;
      noteRunIncome(e.run, 'mintEarned', amount);
      save();
      return { ok: true, amount, total: e.run.retryToken, layer: e.run.layer };
    },
  };
})();
