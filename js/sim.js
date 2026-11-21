// sim.js — 战斗模拟器

(function () {
  'use strict';
  const ONLINE_COMBAT = !!(window.__SSDZ_ONLINE__ || window.__SSDZ_ONLINE_COMBAT__);
  const DOUBLE_THROW_IDS = new Set([5, 6, 8, 9, 13, 14]);


  function R(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
  function chance(pct) { return Math.random() * 100 < pct; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  const RULES = Object.freeze({
    masterHpRatio: 0.50, masterChance: 35,

    repeatWeapon: 8,
    repeatSkill: 5,
    repeatSpecialFirst: 5, repeatSpecialAgain: 5,

    commonAttackWeight: 100,
    minCommonShare: 0.05,

    npcSkillChance: 30,

    jueDuiFirstBase: 20, jueDuiFirstStep: 0.5, jueDuiRepeat: 0.5,
    jueDuiTrueFirst: 24.5, jueDuiTrueSecond: 5, jueDuiTrueSecondStep: 5, jueDuiTrueSecondMax: 24, jueDuiTrueRepeat: 0.5,
    shellFirstBase: 20, shellFirstStep: 0.5, shellRepeat: 1,
    shellTrueFirst: 24.5,
    xhSpeedShare: 0.35,
    skillCooldown: 2,
    // 题面·熔核·炽壳：每过一回合叠一层减伤（+10%/层），第 8 回合起封顶 70%。
    // 层数上限 = 0.70 / 0.10 = 7（coreReduceOf 与 mechDesc 共用同一份数字）。
    coreReducePerRound: 0.10, coreReduceCap: 0.70,
    // 题面·蚀骨：玩家每次出手叠 1 层「攻击 −3%」，这个上限同时被代码与 NPC 文案使用 ——
    erodeMax: 15,
    // 同一方最多连续行动 5 次；第 6 次必须轮到另一方，不能无限先手。
    maxConsecutiveActions: 5,
    // 闪避率的最终上限（百分点）。藏品里的 C22 闪避精通 / G03 凌波微步 / T02 烟幕
    // 可以叠出远高于 100% 的展示值，但真正掷骰时只到这里；面板也按这个上限显示。
    dodgeCap: 55,
    // 暴击率最终上限（百分点，隐藏规则）：溢出的暴击率按 1:1 加进暴击伤害。
    critCap: 70,
  });

  const ACTIVE_SKILLS = [8, 12, 14, 15, 17, 18, 23];
  // 幻兽（原版 `petsInfo` / `petsSkills`，见 MainMovie.as:19146-19148）
  // 原版客服端只负责播服务端下发的 `attackType 4` 回合（`Squirrel.attack` 的
  // `attacks.gotoAndStop(29 + weaponSkillId)`），真正的触发与数值在服务端。
  const PET_INFO_BY_ID = (() => {
    const map = new Map();
    const list = (window.GData && Array.isArray(GData.PETS)) ? GData.PETS : [];
    for (const p of list) map.set(Number(p.id), p);
    return map;
  })();
  const petRule = (skillId) => {
    const rules = window.GData && GData.PET_SKILL_RULES;
    return (rules && rules[Number(skillId)]) || null;
  };
  const petValue = (skillId, level) => {
    if (window.GData && GData.petSkillValue) return GData.petSkillValue(skillId, level);
    const r = petRule(skillId);
    return r ? r.base + r.step * (Math.max(1, Number(level) || 1) - 1) : 0;
  };
  const petTrigger = (skillId, level) => {
    if (window.GData && GData.petSkillTrigger) return GData.petSkillTrigger(skillId, level);
    const r = petRule(skillId);
    return r ? (r.trigger == null ? petValue(skillId, level) : r.trigger) : 0;
  };
  // 把调用方给的幻兽列表（State.petTeam / randomPetLoadout）收成 sim 只认的字段。
  function normalizePetTeam(list) {
    const out = [];
    for (let i = 0; i < (Array.isArray(list) ? list.length : 0) && out.length < 3; i++) {
      const p = list[i];
      if (!p || typeof p !== 'object') continue;
      const info = PET_INFO_BY_ID.get(Number(p.id)) || {};
      const skillId = Number(p.skillId) || Number(info.skillId) || 0;
      if (!skillId) continue;
      out.push({
        slot: out.length, id: Number(p.id) || Number(info.id) || 0,
        name: String(p.name || info.name || '幻兽'),
        grade: Math.max(1, Number(p.grade) || Number(info.grade) || 1),
        level: Math.max(1, Number(p.level) || 1),
        skillId,
      });
    }
    return out;
  }


  function godSave(def) {
    try { return !!(def && def.side === 0 && window.Debug && window.Debug.enabled('godMode')); } catch (e) { return false; }
  }
  // 「无敌模式」必须名副其实：玩家血量计数器不受任何掉血影响。
  // 旁路照旧能把血打下去；血量掉到 1 之后，60 手超时会按血量比例判负 ——
  // 玩家实测「开了无敌，在无尽塔里还是被打死」就是这条（塔里连战继承血量，残血进场更容易超时判负）。
  const godHpGuarded = new WeakSet();
  function guardGodHp(def) {
    if (!def || def.side !== 0 || godHpGuarded.has(def)) return def;
    godHpGuarded.add(def);
    let hp = Math.max(1, Math.round(Number(def.hp) || 1));
    Object.defineProperty(def, 'hp', {
      configurable: true, enumerable: true,
      get() { return hp; },
      set(value) {
        const next = Math.max(0, Math.round(Number(value) || 0));
        if (next < hp && godSave(def)) return;
        hp = next;
      },
    });
    return def;
  }




  function cloneModsForBattle(mods) {
    const out = Object.assign({}, mods);
    if (Array.isArray(mods.deathSaves)) {
      out.deathSaves = mods.deathSaves.map((sv) => (sv && typeof sv === 'object') ? Object.assign({}, sv) : sv);
    }
    return out;
  }
  function makeCombatant(f, side) {
    const stat = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(1, Number(value)) : fallback;
    const skills = {};
    for (let s of f.skills || []) {
      if (typeof s === 'string') { const p = s.split(/[:,]/); s = { id: +p[0], level: +(p[1] || 1) }; }
      if (s && Number.isFinite(Number(s.id))) skills[Number(s.id)] = clamp(stat(s.level, 1), 1, 15);
    }
    const weapons = (f.weapons || []).map((w) => {
      if (typeof w === 'string') { const p = w.split(/[:,]/); w = { id: +p[0], level: +(p[1] || 1) }; }
      const base = weaponsMap.getValue(w.id);
      if (!base) return null;
      w = Object.assign({}, w, { id: Number(w.id), level: clamp(stat(w.level, 1), 1, 15) });
      let lo = w.harmLo, hi = w.harmHi;
      if (lo == null) {
        const [bLo, bHi] = base.harm.split('-').map(Number);
        let add = 0;
        if (w.level <= 10) add = parseInt(base.harmAdd) * (w.level - 1);
        else { add = parseInt(base.harmAdd) * 9; const ex = base.harmAdd1.split('|').map(Number); for (let i = 0; i < w.level - 10 && i < ex.length; i++) add += ex[i]; }
        lo = bLo + add; hi = bHi + add;
      }
      return { id: w.id, level: w.level, name: base.name, type: base.type, lo, hi };
    }).filter(Boolean);
// 关卡连战会带一个「入场血量比例」进来：hp 是当前血量，maxHp 才是上限。
    const fullHp = stat(f.maxHp != null ? f.maxHp : f.hp, 1);
    const mech = Array.isArray(f.mech) ? f.mech.slice() : (f.mech ? [f.mech] : []);
    // ⚠ `mods` 里的 `deathSaves` 必须拷一份：sim 会 `shift()` 掉免死条目，
    const mods = f.mods && typeof f.mods === 'object' ? cloneModsForBattle(f.mods) : null;

    const pets = normalizePetTeam(f.pets);
    let petRagePct = 0, petDodgeHeal = 0;
    for (const p of pets) {
      const rule = petRule(p.skillId);
      if (!rule) continue;
      if (rule.kind === 'rage') petRagePct = Math.max(petRagePct, petValue(p.skillId, p.level));
      else if (rule.kind === 'dodgeHeal') petDodgeHeal += petValue(p.skillId, p.level);
    }
    return {
      side, name: f.name, level: stat(f.level, 1), npcType: f.npcType || null,

      xhSkillMul: Number.isFinite(Number(f.xhSkillMul)) ? Math.max(0.1, Math.min(1.5, Number(f.xhSkillMul))) : 1,
      xhEarlyMul: Number.isFinite(Number(f.xhEarlyMul)) ? Math.max(1, Math.min(1.3, Number(f.xhEarlyMul))) : null,
      power: stat(f.power, 1), agility: stat(f.agility, 1), speed: stat(f.speed, 1),
      maxHp: fullHp, hp: Math.max(1, Math.min(stat(f.hp, 1), fullHp)),
      weapons, skills, usedWeapons: {}, weaponUseCount: {}, usedSkills: {},
      skillUseCount: {}, lastWeaponId: null, lastSkillId: null,
      // 完整技能表的稳定顺序（skills 是「id → 等级」的对象，不是数组！）。

      skillOrder: (function () {
        const own = Array.isArray(f.castable) ? f.castable.map(Number) : Object.keys(skills).map(Number);
        const usable = own.filter((id) => ACTIVE_SKILLS.includes(id) && skills[id]);
        return (usable.length ? usable : ACTIVE_SKILLS.filter((id) => skills[id] || usable.length === 0)).sort((a, b) => a - b);
      })(),
      patternSkillIdx: 0,

      turnId: 0, lastTurnId: -1, turnSkills: {},

      skillCd: {},
      effects: f.effects || {}, masterLevel: Math.max(0, Number(f.masterLevel) || 0),
      heroTrueBase: !!f.heroTrueBase,
      baseStats: Object.fromEntries(['power', 'agility', 'speed'].map((key) => [key, stat(f.baseStats?.[key], stat(f[key], 1))])),
      ap: 0, restNext: false, pendingWeapon: null, stun: 0, silence: 0, disarm: 0, shellCharges: 0,
      mustHitNext: !!(mods && mods.mustHitFirst), stripTurns: 0, usedFakeDie: false, usedMaster: false, shellCount: 0, usedCosmos: false, jueDuiCount: 0,

      healMul: Number.isFinite(Number(f.healMul)) && Number(f.healMul) >= 0 ? Number(f.healMul) : 1,

      pets, petRagePct, petDodgeHeal, petUsed: {},

      petSkillUsed: {},
      petWeakPct: 0, petDotPlus: false, petHealCut: false, petNextCrit: false,
      petSealWeapons: {}, petSealSkills: {},

      petAfterFakeDie: false,
      healMulBase: Number.isFinite(Number(f.healMul)) && Number(f.healMul) >= 0 ? Number(f.healMul) : 1,

      skillBoost: f.skillBoost && typeof f.skillBoost === 'object' ? Object.assign({}, f.skillBoost) : {},
      usedUlt: false, acted: false, usedFreeSkill: false,
      swordDodge: 0, meteorDodge: 0, debuffs: { power: 0, agility: 0, speed: 0 },
      dot: null,
      buffFlat: { power: 0, agility: 0, speed: 0 },
      mech, mods,

      practice: !!f.practice,
      practiceRounds: Math.max(0, Math.floor(Number(f.practiceRounds) || 0)),

      practiceHealPending: 0,

      mechParams: f.mechParams && typeof f.mechParams === 'object' ? f.mechParams : null,
      pattern: Array.isArray(f.pattern) && f.pattern.length ? f.pattern.slice() : null,
      patternStep: 0,
      mechState: { basePower: stat(f.power, 1), berserk: false, core: false, coreStack: 0, bfStep: 0, erode: 0 },
      shell: Math.round(fullHp * ((mech.includes('shell') ? 0.30 : 0) + (mods && mods.shellPct || 0))),
      pendingNote: null,
    };
  }





  function reflectImmune(c) {
    if (!c) return false;
    if (c.weaponBoostImmune) return true;
    return !!(c.mods && Number(c.mods.reflectImmune) > 0);
  }
  // 触发一条免死条目（涅槃 / 涅槃plus / 金蝉脱壳）—— 两个致死判定点共用这一份：
  // 顺序：先抬生命上限（涅槃plus 的 +20%），再按 healPct 回血（回的是抬过之后的上限），
  function consumeDeathSave(def, sv, r) {
    const plusMax = Math.max(0, Number(sv.maxHpMul) || 0);
    if (plusMax > 0) def.maxHp = Math.max(1, Math.round((Number(def.maxHp) || 1) * (1 + plusMax)));
    const plusTaken = Number(sv.takenMul) || 0;
    if (plusTaken) {
      // 减伤按伤害倍率相乘，不把两条减伤直接相加（否则 60% + 60% 会变成 100% 免疫）。
      const oldTaken = Number(def.mods.takenMul) || 0;
      def.mods.takenMul = Math.max(-0.95, (1 + oldTaken) * (1 + plusTaken) - 1);
      if (r) r.reviveTakenMul = def.mods.takenMul;
    }
    def.hp = sv.healPct ? Math.max(1, Math.round(def.maxHp * sv.healPct)) : 1;

    const mul = Math.max(0, Number(sv.statMul) || 0);
    if (mul > 0) {
      for (const key of ['power', 'agility', 'speed']) {
        def.buffFlat[key] = (def.buffFlat[key] || 0) + Math.max(1, Math.round((Number(def[key]) || 0) * mul));
      }
    }
    if (!r) return;
    r.deathSave = true;
    r.reviveStatMul = mul > 0 ? mul : undefined;

    r.revive = sv.revive ? 1 : undefined;
    r.noteText = (r.noteText ? r.noteText + '·' : '') + (sv.name || (sv.healPct ? '涅槃' : '金蝉脱壳'));
    r.noteSide = def.side;
  }
  function tryDeathSave(def, r) {
    if (!def || def.hp > 0) return false;
    if (def.mods && Array.isArray(def.mods.deathSaves) && def.mods.deathSaves.length) {
      consumeDeathSave(def, def.mods.deathSaves.shift(), r);
      return true;
    }
    if (godSave(def)) { def.hp = 1; if (r) r.godSave = true; return true; }
    return false;
  }


  function inheritFakeDie(r, rr) {
    r.fakeDie = true;
    if (rr.fakeDieSide != null) r.fakeDieSide = rr.fakeDieSide;
    if (rr.fakeDieReflect) r.fakeDieReflect = true;
  }

  function stripped(c) { return Number(c.stripTurns) > 0; }
  function statOf(c, key) { return stripped(c) ? c.baseStats[key] : c[key]; }

  function healOf(c, amount) { return Math.max(0, Math.round(Number(amount) * (c.healMul == null ? 1 : c.healMul))); }
  function effPower(c) {
    let p = statOf(c, 'power') * (1 - c.debuffs.power / 100) + c.buffFlat.power;
    const rage = c.mods && Number(c.mods.lowHpPowerMul) || 0;
    if (rage > 0 && lowHpActive(c)) p *= 1 + rage;
    // 塔 buff「开局狂热」：按本次战斗的出手次数分档 ——
    // 玩家与敌人共用这段逻辑，但只有拿到该 buff 的一方 mods 里才有这两个字段。
    if (c.mods) {
      const boost = Number(c.mods.openerPowerMul) || 0;
      const fatigue = Number(c.mods.fatiguePowerMul) || 0;
      if (boost || fatigue) {
        const rounds = Math.max(1, Number(c.mods.openerRounds) || 5);
        p *= (Number(c.acts) || 1) <= rounds ? 1 + boost : 1 - fatigue;
      }

      const wFatigue = Number(c.mods.weaponBoostFatigueMul) || 0;
      const wCap = Number(c.mods.weaponBoostUses) || 0;
      if (wFatigue > 0 && wCap > 0 && (Number(c.weaponUses) || 0) > wCap) p *= 1 - wFatigue;
    }

    return Math.max(1, Math.round(p));
  }

  function lowHpActive(c) {
    const th = c.mods && Number(c.mods.lowHpAt);
    return !!(th > 0 && c.maxHp > 0 && c.hp <= c.maxHp * th);
  }
  // 回合开始类增益（塔 buff，每场战斗重置）
  // roundMaxHpMul  玉石俱焚：双方生命上限各乘一次（向下取整），当前血量跟着裁
  function applyRoundAuras(actor, foe, push) {
    const m = actor.mods || {};
    const statPct = Number(m.roundStatPct) || 0;
    if (statPct > 0) {
      for (const key of ['power', 'agility', 'speed']) {
        const base = Number(statOf(actor, key)) || 0;
        actor.buffFlat[key] = (actor.buffFlat[key] || 0) + Math.max(1, Math.round(base * statPct));
      }
      if (push) push({ attacker: actor.side, action: 'buff', noteText: '越战越勇', noteSide: actor.side });
    }
    const catchPct = Number(m.catchUpPct) || 0;
    if (catchPct > 0 && foe && foe.hp > 0) {
      const eff = { power: effPower, agility: effAgility, speed: effSpeed };
      let best = null;
      for (const key of ['power', 'agility', 'speed']) {
        const gap = eff[key](foe) - eff[key](actor);
        if (gap > 0 && (!best || gap > best.gap)) best = { key: key, gap: gap };
      }
      if (best) {
        const gain = Math.max(1, Math.round(best.gap * catchPct));
        actor.buffFlat[best.key] = (actor.buffFlat[best.key] || 0) + gain;

        if (foe && foe.buffFlat) foe.buffFlat[best.key] = (foe.buffFlat[best.key] || 0) - gain;
        if (push) push({ attacker: actor.side, action: 'buff', noteText: '后发制人', noteSide: actor.side,
          aura: { key: best.key, gain: gain, drain: gain, drainSide: foe ? foe.side : null } });
      }
    }
    const hpMul = Number(m.roundMaxHpMul) || 0;
    if (hpMul > 0 && hpMul < 1) {
      for (const c of [actor, foe]) {
        if (!c || c.hp <= 0) continue;
        c.maxHp = Math.max(1, Math.floor(c.maxHp * hpMul));
        if (c.hp > c.maxHp) c.hp = c.maxHp;
      }
      // 把两边的新上限/当前血量一起写进这一回合：战斗回放要据此更新血条，
      // 否则玩家在战斗里只看得到飘字、看不到「血量上限变化」。
      const bySide = (pick) => (actor.side === 0 ? [pick(actor), pick(foe)] : [pick(foe), pick(actor)]);
      if (push) push({ attacker: actor.side, action: 'buff', noteText: '玉石俱焚', noteSide: actor.side,
        maxHp: bySide((c) => c.maxHp), hp: bySide((c) => c.hp) });
    }
  }

  function lowHpTakenDamage(def, dmg, mul, at) {
    const d = Math.max(0, Number(dmg) || 0);
    const cut = Math.max(0, 1 + (Number(mul) || 0));

    const th = Number(at != null ? at : (def.mods && def.mods.lowHpAt)) || 0;
    const maxHp = Math.max(0, Number(def.maxHp) || 0);
    const hp = Math.max(0, Number(def.hp) || 0);
    if (!(th > 0) || !(maxHp > 0)) return Math.round(d * cut);
    // 注意：这里不做 cut<=0 的提前返回 —— 减伤 100% 时也应该先把阈值以上那一段打完
    const line = maxHp * th;
    const above = Math.max(0, hp - line);
    if (d <= above) return d;
    const below = d - above;
    return Math.round(above + below * cut);
  }
  function effAgility(c) {
    let a = statOf(c, 'agility') * (1 - c.debuffs.agility / 100) + c.buffFlat.agility;
    const m = c.mods && Number(c.mods.lowHpAgilityMul) || 0;
    if (m > 0 && lowHpActive(c)) a *= 1 + m;
    return Math.max(1, Math.round(a));
  }
  function effSpeed(c) {
    let v = statOf(c, 'speed') * (1 - c.debuffs.speed / 100) + c.buffFlat.speed;
    const m = c.mods && Number(c.mods.lowHpSpeedMul) || 0;
    if (m > 0 && lowHpActive(c)) v *= 1 + m;
    return Math.max(1, Math.round(v));
  }
  function effect(c, id) { return stripped(c) ? 0 : Math.max(0, Number(c.effects[id]) || 0); }
  const trueVal = (id, level) => (window.GData && GData.trueSkillValue ? GData.trueSkillValue(id, level) : 0);
  const trueW = (w, key) => (window.GData && GData.trueWeaponBonus ? GData.trueWeaponBonus(w, key) : 0);

  const trueBaseMul = (level) => {
    const lv = Math.max(1, Math.min(15, Math.floor(Number(level) || 1)));
    return lv >= 15 ? 2 : lv >= 11 ? 1.5 : 1;
  };
  const heroBaseMul = (att, level) => att && att.heroTrueBase ? trueBaseMul(level) : 1;
  // 勇者真化白值：武技 真1~真4 ×1.5、真5 ×2；野球拳（12）不吃这档倍率，真1~真5 都按原白值。
  const HERO_TRUE_BASE_SKIP_SKILLS = new Set([12]);
  function skill(c, id) { return c.silence > 0 && id > 4 ? 0 : c.skills[id] || 0; }

  function weaponEffect(w, base, perLevel) {
    return base + perLevel * (Math.min(w.level, 10) - 1);
  }


  function rawCritChance(att) {
    let c = 5;
    if (skill(att, 9)) c += 2 * Math.min(10, skill(att, 9));
    if (att.mods && att.mods.critBonus) c += Number(att.mods.critBonus);
    return c;
  }

  function critOverflow(att) {
    return Math.max(0, rawCritChance(att) - RULES.critCap);
  }
  function critChanceAgainst(att, def) {
    const antiCrit = def && def.skills ? trueVal(10, def.skills[10]) : 0;
    return clamp(Math.max(0, critChance(att) - antiCrit), 0, RULES.critCap);
  }
  function critDmgBonus(att) {
    const base = (att.mods && Number(att.mods.critDmgBonus) || 0) / 100;

    return base + critOverflow(att) / 100;
  }

  function pickOne(list) { return list[Math.floor(Math.random() * list.length)]; }


  const UNUSED_WEIGHT = 100;

  function pickWeighted(list, weightOf) {
    let total = 0;
    for (const x of list) total += weightOf(x);
    if (!(total > 0)) return pickOne(list);
    let roll = Math.random() * total;
    for (const x of list) { roll -= weightOf(x); if (roll <= 0) return x; }
    return list[list.length - 1];
  }



  function repeatRateOf(id, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (Number(id) === 17) return 1;
    if (id !== 12) return RULES.repeatSkill;
    return n <= 1 ? RULES.repeatSpecialFirst : RULES.repeatSpecialAgain;
  }

  function skillUseCountOf(att, id) {
    if (!att || !att.skillUseCount) return 0;
    return Math.max(0, Math.floor(Number(att.skillUseCount[id]) || 0));
  }
  function skillWeight(att, id) {

    if (ONLINE_COMBAT && skillUseCountOf(att, id) >= 1) return 0;
    let w = att.usedSkills[id] ? repeatRateOf(id, skillUseCountOf(att, id)) : UNUSED_WEIGHT;

    const boost = Number(att.skillBoost && att.skillBoost[id]) || 0;
    if (boost > 0) w *= 1 + boost;
    return w;
  }

  function weaponWeight(att, w) {
    const id = w && typeof w === 'object' ? w.id : w;
    const weapon = w && typeof w === 'object'
      ? w
      : ((att.weapons || []).find((x) => Number(x.id) === Number(id)) || null);
    const used = !!(att.usedWeapons && att.usedWeapons[id]);
    const count = att.weaponUseCount && att.weaponUseCount[id] != null
      ? Math.max(0, Math.floor(Number(att.weaponUseCount[id]) || 0))
      : (used ? 1 : 0);
    const specialThrowRepeat = Number(id) === 7 || Number(id) === 10;
    if (ONLINE_COMBAT) {

      const maxUses = DOUBLE_THROW_IDS.has(Number(id)) ? 2 : 1;
      if (count >= maxUses) return 0;
    }
    if (weapon && weapon.type === '投掷' && !specialThrowRepeat) {
      return count < 2 ? UNUSED_WEIGHT : RULES.repeatWeapon;
    }
    return used ? RULES.repeatWeapon : UNUSED_WEIGHT;
  }


  // 把两边的实际候选权重加总，再和「徒手」权重一起抽一次：
  // 抽签仍然只消耗一次 Math.random()，所以既有的随机序列长度不变。

  function commonWeightFor(toolWeight) {
    const r = Math.max(0, Math.min(0.9, Number(RULES.minCommonShare) || 0));
    const floor = r > 0 ? (Number(toolWeight) || 0) * (r / (1 - r)) : 0;
    return Math.max(RULES.commonAttackWeight, floor);
  }
  function pickKind(att, weapons, actives) {
    let weaponSum = 0;
    for (const w of weapons || []) weaponSum += weaponWeight(att, w);
    let skillSum = 0;
    for (const id of actives || []) skillSum += skillWeight(att, id);
    const commonWeight = commonWeightFor(weaponSum + skillSum);
    const total = weaponSum + skillSum + commonWeight;
    const roll = Math.random() * total;
    if (roll < weaponSum) return 'weapon';
    if (roll < weaponSum + skillSum) return 'skill';
    return 'common';
  }

  function pickNpcKind() {
    return Math.random() * 100 < RULES.npcSkillChance ? 'skill' : 'common';
  }


  function kindWeights(att, weapons, actives) {
    let weapon = 0;
    for (const w of weapons || []) weapon += weaponWeight(att, w);
    let skill = 0;
    for (const id of actives || []) skill += skillWeight(att, id);
    const common = commonWeightFor(weapon + skill);
    const total = weapon + skill + common;
    return { weapon, skill, common, total, weaponShare: weapon / total, skillShare: skill / total, commonShare: common / total };
  }

  // 固定循环出招：按「技能表的轮转顺序」依次放技能，缺一个就顺延到下一个能用的。
  // 现在 skillOrder 固定不变（不受本场已用过滤影响），循环因此稳定可预告。
  function nextPatternSkill(att, actives) {
    const order = (att.skillOrder && att.skillOrder.length) ? att.skillOrder : actives.slice().sort((a, b) => a - b);
    const n = order.length;
    for (let i = 0; i < n; i++) {
      const id = order[(att.patternSkillIdx + i) % n];
      const sid = Number(id);
      if (actives.includes(sid)) { att.patternSkillIdx = (att.patternSkillIdx + i + 1) % n; return sid; }
    }
    return Number(actives[0]);
  }
  function pickSkill(att, actives) {
    return pickWeighted(actives, (id) => skillWeight(att, id));
  }

  function pickWeapon(att, pool) {
    return pickWeighted(pool && pool.length ? pool : att.weapons, (w) => weaponWeight(att, w));
  }


  function dodgeChance(att, def) {
    // 练功木桩不闪避：原版 `Stakes.beAttack()` 只有 `reduceBlood(currentRound.harm)`，
    // 这里从唯一的闪避出口挡住，武器/技能/幻兽的所有闪避判定一起生效。
    if (def && (def.practice || def.npcType === 'wood')) return 0;
    if (att.mods && (att.mods.mustHitAll || att.mods.firstStrikeAll)) return 0;
    const wMust = att.mustHitNext;
    if (wMust) return 0;
    let d = 6 + 26 * effAgility(def) / (effAgility(def) + effAgility(att) * 1.2 + 40);
    const shift = skill(def, 11)
      ? (5 + 2 * (Math.min(skill(def, 11), 10) - 1) + trueVal(11, skill(def, 11))) * (1 + effect(def, 35) / 100)
      : 0;
    d *= 1 + (shift + def.swordDodge + def.meteorDodge) / 100;
    if (def.mods && def.mods.dodgeBonus) d += Number(def.mods.dodgeBonus);
    if (def.mods && def.mods.dodgeMul) d *= 1 + Number(def.mods.dodgeMul);
    return clamp(d, 0, RULES.dodgeCap);
  }

  function critChance(att) {
    return clamp(rawCritChance(att), 0, RULES.critCap);
  }

  // 「被动技能触发提升」—— 秘技通神（C33）选中绝对防御 / 龟甲术之后写进
  // 所以它们不吃 skillWeight 那套权重，必须在这里单独乘一次。
  function passiveSkillBoost(f, id) {
    if (!f) return 0;
    const v = Number(f.skillBoost && f.skillBoost[id]);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  const BOOSTED_AGAIN_CAP = 45;
  const BOOSTED_FIRST_CAP = 90;
  // 题面·熔核·炽壳的减伤层数上限（= 封顶 / 每层）。
  function coreMaxStacks() {
    const per = Math.max(0.01, Number(RULES.coreReducePerRound) || 0.10);
    return Math.max(1, Math.round((Number(RULES.coreReduceCap) || 0.70) / per));
  }

  function coreReduceOf(count) {
    const per = Math.max(0, Number(RULES.coreReducePerRound) || 0);
    const cap = Math.max(0, Number(RULES.coreReduceCap) || 0);
    const n = Math.max(0, Math.min(coreMaxStacks(), Math.floor(Number(count) || 0)));
    return Math.round(Math.min(cap, n * per) * 100) / 100;
  }
  function jueDuiChanceOf(def, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const lv = Math.max(1, Math.floor(Number(def && def.skills && def.skills[16]) || 1));
    let base;
    if (lv <= 10) {

      base = n === 0 ? RULES.jueDuiFirstBase + RULES.jueDuiFirstStep * (lv - 1) : RULES.jueDuiRepeat;
    } else {
      const t = Math.max(1, Math.min(5, lv - 10));

      base = n === 0 ? RULES.jueDuiTrueFirst
        : n === 1 ? Math.min(RULES.jueDuiTrueSecondMax, RULES.jueDuiTrueSecond + RULES.jueDuiTrueSecondStep * (t - 1))
          : RULES.jueDuiTrueRepeat;
    }
    const boost = passiveSkillBoost(def, 16);
    const out = base * (1 + boost);
    if (!boost) return out;
    return Math.max(base, Math.min(out, n === 0 ? BOOSTED_FIRST_CAP : BOOSTED_AGAIN_CAP));
  }

  function shellChanceOf(def, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const lv = Math.max(1, Math.floor(Number(def && def.skills && def.skills[7]) || 1));
    let base;
    if (lv <= 10) {
      base = n === 0 ? RULES.shellFirstBase + RULES.shellFirstStep * (lv - 1) : RULES.shellRepeat;
    } else {
      base = n === 0 ? RULES.shellTrueFirst : trueVal(7, lv);
    }
    const boost = passiveSkillBoost(def, 7);
    const out = base * (1 + boost);
    if (!boost) return out;
    return Math.max(base, Math.min(out, n === 0 ? BOOSTED_FIRST_CAP : BOOSTED_AGAIN_CAP));
  }

  // 绝对防御这一次出手是否发动 —— 一次出手只判一次（多段攻击整段挡下 / 整段不挡）。
  // 为什么必须「一次」：西瓜刀连击（2 段）、螳螂双击（2 段）、疾风镰刀舞（4 段）原先每一段
  function jueDuiDecide(def, weaponType) {
    if (!def || !def.skills || !def.skills[16]) return null;
    if (Number(def.silence) > 0) return null;

    if (weaponType === '投掷') return null;
    if (!chance(jueDuiChanceOf(def, def.jueDuiCount || 0))) return 'miss';
    def.jueDuiCount = Math.max(0, Math.floor(Number(def.jueDuiCount) || 0)) + 1;
    return 'block';
  }

  function jueDuiBlock(def, dmg, out) {
    const pct = 40 + 4 * (Math.min(def.skills[16], 10) - 1) + trueVal(16, def.skills[16]) +
      Math.max(0, Number(effect(def, 47)) || 0);
    out.jueDui = dmg;
    out.rebound = Math.round(dmg * pct / 100);
    out.dmg = 0;
    return out;
  }
  function dmgReduce(def, dmg, opts) {
    opts = opts || {};
    let out = { dmg, guiJia: 0, jueDui: 0, rebound: 0 };
    const gearReduction = opts.action === 'weapon' ? effect(def, opts.weaponType === '投掷' ? 10 : 9) : opts.action === 'skill' ? effect(def, 11) : 0;
    out.dmg = Math.round(out.dmg * (1 - clamp(gearReduction, 0, 80) / 100));

    const jueDui = opts.counter ? 'miss' : (opts.jueDuiLock === undefined ? jueDuiDecide(def, opts.weaponType) : opts.jueDuiLock);
    if (jueDui === 'block') return jueDuiBlock(def, out.dmg, out);
    if (def.skills[7] && def.silence <= 0) {
      const shellCount = Math.max(0, Math.floor(Number(def.shellCount) || 0));
      const canTrigger = def.shellCharges > 0
        || chance(shellChanceOf(def, shellCount));
      if (canTrigger) {
        if (def.shellCharges > 0) def.shellCharges--;
        else def.shellCount = shellCount + 1;
        const pct = clamp(20 + 5 * (Math.min(def.skills[7], 10) - 1), 0, 100);
        out.guiJia = Math.round(out.dmg * pct / 100);
        out.dmg -= out.guiJia;
      }
    }
    if (skill(def, 10)) {
      const pct = clamp((5 + (Math.min(skill(def, 10), 10) - 1)) * (1 + effect(def, 34) / 100), 0, 80);
      out.dmg = Math.round(out.dmg * (100 - pct) / 100);
    }
    if (def.mods && def.mods.takenMul) out.dmg = Math.round(out.dmg * (1 + Number(def.mods.takenMul)));
    if (def.mods && Number(def.mods.lowHpTakenMul)) {
      out.dmg = lowHpTakenDamage(def, out.dmg, Number(def.mods.lowHpTakenMul));
    }
    if (def.mech.includes('trialCore')) {

      const dr = coreReduceOf(def.mechState.coreStack || 0);
      if (dr > 0) out.dmg = Math.round(out.dmg * (1 - dr));
    }
    out.dmg = Math.max(1, out.dmg);
    return out;
  }



  function simulate(f0, f1, options) {
    options = options || {};
    const rules = {
      masterHpRatio: Number.isFinite(options.masterHpRatio) ? clamp(options.masterHpRatio, 0, 1) : RULES.masterHpRatio,
      masterChance: Number.isFinite(options.masterChance) ? clamp(options.masterChance, 0, 100) : RULES.masterChance,
    };
    const A = makeCombatant(f0, 0), B = makeCombatant(f1, 1);
    // 无敌模式（见 guardGodHp）：开战先把玩家血量顶到上限 ——
    // 塔里连战继承进来的残血不会让它在 60 手超时里按血量比例判负；
    if (godSave(A)) { A.hp = A.maxHp; guardGodHp(A); }
    // 枯泉·涸井（封疗机制）：从战斗开始就封，而不是等它第一次出手 ——
    // 否则先手玩家在它出手前打出的吸血 / 回血会整段漏过去（用户报「枯泉没生效」的另一半）。
    // 机制清单以 tower-data 的 `mechSealsHeal` 为准（塔外没有 TowerData 时退回硬编码清单）。
    (function sealHealingAtStart() {
      const TD = window.TowerData;
      const seals = (mechs) => (TD && typeof TD.mechSealsHeal === 'function'
        ? TD.mechSealsHeal(mechs)
        : (mechs || []).indexOf('trialDry') >= 0);
      if (seals(B.mech)) A.healMul = 0;
      if (seals(A.mech)) B.healMul = 0;
    })();
    // 开局护盾值（石像鬼机制 / 塔 buff「坚韧壁垒」）：给界面用 ——
    // 战斗一开始就要能把护盾画出来，不能等第一次挨打。
    const startShell = [Math.max(0, A.shell || 0), Math.max(0, B.shell || 0)];
    const rounds = [];
    // 原版战斗上限 60（`combat maxRounds=60`，数据表也写「战斗回合数设置上限为60」）。
    const MAX_ACTIONS = 60;

    const practice = A.practice ? A : (B.practice ? B : null);
    const actionCap = practice && practice.practiceRounds > 0
      ? Math.min(MAX_ACTIONS, practice.practiceRounds) : MAX_ACTIONS;
    let actions = 0;

    function pushRound(r) {
      if (A.hp <= 0 && godSave(A)) A.hp = 1;
      if (B.hp <= 0 && godSave(B)) B.hp = 1;
      if (r && r.attacker != null) {
        const c = r.attacker === 0 ? A : B;
        if (c.pendingNote) { r.noteText = (r.noteText ? r.noteText + '·' : '') + c.pendingNote; c.pendingNote = null; }
      }
      r.hpAfter = [Math.max(0, A.hp), Math.max(0, B.hp)];
      // 调试用实时三维：只有调用方显式要才落快照，避免每场战斗都多存对象。
      // 快照取这一拍结算之后的有效值（含降低属性/增益），现代战斗的调试层直接读它。
      if (options.collectStats) {
        r.effStats = [
          { power: effPower(A), agility: effAgility(A), speed: effSpeed(A) },
          { power: effPower(B), agility: effAgility(B), speed: effSpeed(B) },
        ];
      }
      r.shellAfter = [Math.max(0, A.shell || 0), Math.max(0, B.shell || 0)];

      r.stripLeft = [Math.max(0, Number(A.stripTurns) || 0), Math.max(0, Number(B.stripTurns) || 0)];

      if (A.practiceHealPending) { r.practiceHeal = (Number(r.practiceHeal) || 0) + A.practiceHealPending; A.practiceHealPending = 0; }
      if (B.practiceHealPending) { r.practiceHeal = (Number(r.practiceHeal) || 0) + B.practiceHealPending; B.practiceHealPending = 0; }
      rounds.push(r);
    }

    // 追加行动排队：装死排在其它追加行动之前（一方一个，排过就不再排），
    // 其它追加行动按「马上行动」的语义插到最前；同一方只保留一个，后写替换先写。
    const pendingImmediate = [];
    function queueImmediate(entry) {
      if (!entry || !entry.actor || entry.actor.hp <= 0) return;
      const queue = pendingImmediate;
      const same = queue.findIndex((x) => x.actor === entry.actor);
      if (entry.reason === 'fakeDie' && same >= 0) {
        if (queue[same].reason === 'fakeDie') return;
        queue.splice(same, 1);
      } else if (same >= 0) {
        if (queue[same].reason === 'fakeDie') return;
        queue[same] = entry;
        return;
      }
      const firstOther = queue.findIndex((x) => x.reason !== 'fakeDie');
      queue.splice(firstOther < 0 ? queue.length : firstOther, 0, entry);
    }

    // 反伤 / 反噬打到「出手方」身上时的结算：和普通伤害走同一条致死保护链
    // 触发时装死的老规矩照旧：hp = 1、清掉眩晕、并立刻获得一次行动（同 applyDamage 那条路径）。
    function reflectHurt(target, amount, r) {
      const dmg = Math.max(0, Math.round(Number(amount) || 0));
      if (!target || dmg <= 0 || target.hp <= 0) return 0;
      if (target.hp - dmg <= 0 && target.skills && target.skills[6] && target.silence <= 0 && !target.usedFakeDie) {
        target.usedFakeDie = true;
        target.hp = 1;
        target.stun = 0;
        r.fakeDie = true;
        r.fakeDieSide = target.side;
        r.fakeDieReflect = true;
        queueFakeDiePets(target);
        queueImmediate({ actor: target, reason: 'fakeDie' });
        return dmg;
      }
      target.hp -= dmg;
      tryDeathSave(target, r);
      return dmg;
    }

    function practiceHurt(def, dmg) {
      if (!def || !def.practice) return dmg;
      def.hp = Math.max(1, def.hp - dmg);
      return dmg;
    }
    function applyDamage(att, def, rawDmg, r, opts) {
      opts = opts || {};

      if (r.crit) {
        const cut = clamp(Number(effect(def, 46)) || 0, 0, 80);
        if (cut > 0) { rawDmg = Math.round(rawDmg * (1 - cut / 100)); r.critCut = cut; }
      }
      const action = opts.action || r.action;

      if (att.heroTrueBase && action === 'skill' && !HERO_TRUE_BASE_SKIP_SKILLS.has(Number(r.id))) {
        rawDmg = Math.round(rawDmg * heroBaseMul(att, att.skills[Number(r.id)]));
      }
      if (att.mods && att.mods.dmgMul) rawDmg = Math.round(rawDmg * Number(att.mods.dmgMul));

      if (petRageActive(att) && rawDmg > 0) {
        rawDmg = Math.round(rawDmg * (1 + att.petRagePct / 100));
        r.petRage = att.petRagePct;
      }

      if (action === 'weapon' && def.petWeakPct > 0 && rawDmg > 0) {
        rawDmg = Math.round(rawDmg * (1 + def.petWeakPct / 100));
        r.petWeak = def.petWeakPct;
      }
      if (action === 'skill') {
        rawDmg = Math.round(rawDmg * (1 + effect(att, 8) / 100));

        const cc = critChanceAgainst(att, def);

        if (att.petNextCrit) {
          att.petNextCrit = false;
          r.crit = true; r.petCrit = true;
          rawDmg = Math.round(rawDmg * (2 + effect(att, 45) / 100 + effect(att, 4) / 100 + critDmgBonus(att)));
        } else if (chance(cc)) {
          const quad = trueVal(9, att.skills[9]);
          const mul = (quad > 0 && chance(quad)) ? 4 : 2;
          if (mul === 4) r.crit4 = true;
          rawDmg = Math.round(rawDmg * (mul + effect(att, 45) / 100 + effect(att, 4) / 100 + critDmgBonus(att)));
          r.crit = true;
        }
      }
      const red = dmgReduce(def, rawDmg, { action, weaponType: opts.weaponType, jueDuiLock: opts.jueDuiLock, counter: !!opts.counter });
      let dmg = red.dmg;

      if (dmg > 0 && att.mods && Number(att.mods.lowHpFinalMul) > 0 && lowHpActive(att)) {
        dmg = Math.round(dmg * (1 + Number(att.mods.lowHpFinalMul)));
        r.rageFinalMul = Number(att.mods.lowHpFinalMul);
      }
      // 塔 buff「先机预判」：每场战斗敌方第一次攻击必定闪避，随后我方立刻额外行动一次。
      // 不能被先机预判 / 风影身法这类“第一次攻击”机制吃掉。
      if (!opts.noDodge && dmg > 0 && def.mods && Number(def.mods.firstDodge) > 0 && !def.mods.firstDodgeUsed) {
        def.mods.firstDodgeUsed = true;
        dmg = 0;
        markDodge(r, def);
        r.firstDodge = true;
        r.noteText = (r.noteText ? r.noteText + '·' : '') + (def.mods.firstDodgeName || '先机预判'); r.noteSide = def.side;
        // 先机预判：闪避这一击之后，我方立刻额外行动一次且不消耗回合。
        // 与「装死」同一条路径 —— 把追加行动排给受击方，主循环下一轮直接让它出手。
        if (def.mods.firstDodgeFreeTurn && def.hp > 0) {
          r.firstDodgeFreeTurn = true;
          if (!pendingImmediate.some((x) => x.actor === def)) queueImmediate({ actor: def, reason: 'firstDodge' });
        }
      }
      if (!opts.noDodge && dmg > 0 && def.mods && def.mods.firstHitZero && !def.mods.firstHitZeroUsed) {
        def.mods.firstHitZeroUsed = true;
        dmg = 0;
        r.firstHitZero = true;
        r.noteText = (r.noteText ? r.noteText + '·' : '') + (def.mods.firstHitZeroName || '先机预判'); r.noteSide = def.side;
        // 兼容旧字段：若还有带 `firstHitZeroFreeTurn` 的来源，仍然给额外行动。
        if (def.mods.firstHitZeroFreeTurn && def.hp > 0) {
          r.firstHitZeroFreeTurn = true;
          if (!pendingImmediate.some((x) => x.actor === def)) queueImmediate({ actor: def, reason: 'firstHitZero' });
        }
      }
      if (red.jueDui) { r.jueDui = true; r.rebound = red.rebound; }
      if (red.guiJia) r.guiJia = red.guiJia;
      if (def.shell > 0 && dmg > 0) {
        const absorbed = Math.min(def.shell, dmg);
        def.shell -= absorbed; dmg -= absorbed;
        r.shellAbsorb = absorbed;
      }
      // 木桩的血量保护不能截掉测得的伤害，亦不走装死 / 复活 / 倒地分支。
      if (def.practice) {
        dmg = practiceHurt(def, dmg);
      } else if (def.hp - dmg <= 0 && def.skills[6] && def.silence <= 0 && !def.usedFakeDie && !opts.ignoreFakeDie) {
        def.usedFakeDie = true;
        dmg = Math.max(0, def.hp - 1);
        def.hp = 1;
        r.fakeDie = true;
        r.fakeDieSide = def.side;
        def.stun = 0;
        queueFakeDiePets(def);
        queueImmediate({ actor: def, reason: 'fakeDie' });
      } else if (def.hp - dmg <= 0 && def.mods && Array.isArray(def.mods.deathSaves) && def.mods.deathSaves.length) {
        // 与 tryDeathSave 共用同一份触发逻辑（含涅槃plus 的抬上限 / 减伤）。
        consumeDeathSave(def, def.mods.deathSaves.shift(), r);
      } else if (def.hp - dmg <= 0 && godSave(def)) {
        dmg = Math.max(0, def.hp - 1);
        def.hp = 1;
        r.godSave = true;
      } else {
        def.hp -= dmg;
      }
      att.mustHitNext = false;
      r.dmg = (r.dmg || 0) + dmg;
      if (red.rebound) {
        // 反击（`opts.noReflect`）：反击伤害是对出手方的直接回应，不再让原出手方的
        // 不结算反弹伤害 —— 否则玩家会看到“我反击，掉血的却是我这边”。
        if (opts.noReflect) {
          r.reflectBlocked = (r.reflectBlocked || 0) + red.rebound;
        } else if (reflectImmune(att)) {

          r.reflectBlocked = (r.reflectBlocked || 0) + red.rebound;
          r.noteText = (r.noteText ? r.noteText + '·' : '') + '反噬豁免'; r.noteSide = att.side;
        } else {
          r.reboundHurt = red.rebound;

          reflectHurt(att, red.rebound, r);
        }
      }
      if (dmg > 0) {

        const noReflect = !!opts.noReflect || reflectImmune(att);
        if (def.mech.includes('thorns') && att.hp > 0 && !noReflect) {
          const reflect = Math.max(1, Math.round(dmg * 0.15));
          r.thornsDmg = (r.thornsDmg || 0) + reflect;
          reflectHurt(att, reflect, r);
        }
        const modThorns = def.mods && Number(def.mods.thornsPct) || 0;
        const thornsPct = modThorns;
        if (thornsPct > 0 && att.hp > 0 && !noReflect) {
          const reflect = Math.max(1, Math.round(dmg * thornsPct));
          r.thornsDmg = (r.thornsDmg || 0) + reflect;

          if (modThorns > 0) { r.noteText = (r.noteText ? r.noteText + '·' : '') + '荆棘之甲'; r.noteSide = def.side; }
          reflectHurt(att, reflect, r);
        }
        const mp = (def.mechParams && def.mechParams.trialMirror) || null;
        const threshold = (mp && Number(mp.threshold)) || 0.15;
        const reflectPct = (mp && Number(mp.reflect)) || 0.6;
        if (def.mech.includes('trialMirror') && att.hp > 0 && !noReflect && dmg >= def.maxHp * threshold) {
          const reflect = Math.max(1, Math.round(dmg * reflectPct));
          r.thornsDmg = (r.thornsDmg || 0) + reflect;
          r.noteText = (r.noteText ? r.noteText + '·' : '') + '镜鳞·反噬'; r.noteSide = def.side;

          reflectHurt(att, reflect, r);
        }

        const ov = (def.mechParams && def.mechParams.trialOverflow) || null;
        const ovThreshold = (ov && Number(ov.threshold)) || 0.25;
        if (def.mech.includes('trialOverflow') && att.hp > 0 && !noReflect && dmg > def.maxHp * ovThreshold) {
          const excess = Math.max(1, Math.round(dmg - def.maxHp * ovThreshold));
          r.thornsDmg = (r.thornsDmg || 0) + excess;
          r.noteText = (r.noteText ? r.noteText + '·' : '') + '沉默之壁·溢出反弹'; r.noteSide = def.side;
          reflectHurt(att, excess, r);
        }
        if (def.mech.includes('poison') && !att.dot && chance(30)) {
          att.dot = { pct: 0.03, rounds: 3 };
          r.poisonApplied = true;
          r.noteText = (r.noteText ? r.noteText + '·' : '') + '毒藤缠绕'; r.noteSide = def.side;
        }
        let lsPct = (att.mech.includes('lifesteal') ? 0.30 : 0) + (att.mods && Number(att.mods.lifestealPct) || 0);

        if (att.mods && att.mods.lowHpLifestealPct && lowHpActive(att)) lsPct += Number(att.mods.lowHpLifestealPct) || 0;
        if (lsPct > 0 && att.hp > 0) {
          const heal = Math.min(att.maxHp - att.hp, healOf(att, dmg * lsPct));
          if (heal > 0) { att.hp += heal; r.lifesteal = (r.lifesteal || 0) + heal; }
        }
      }
      return dmg;
    }

    // 幻兽协战（原版 attackType 4）
    // 幻兽动作；`isRound:0` 表示不占 60 手行动上限。技能效果在这里结算，
    // 事件字段只负责告诉播放器「谁、哪只、命中/回血多少」。

    function petRageActive(c) {
      return !!(c && Number(c.petRagePct) > 0 && c.hp > 0 && c.hp < 200);
    }

    function queueFakeDiePets(c) {
      if (!c || c.hp <= 0 || c.petAfterFakeDie) return;
      for (const p of c.pets || []) {
        if (c.petUsed[p.slot]) continue;
        const rule = petRule(p.skillId);
        if (rule && rule.onFakeDie) { c.petAfterFakeDie = true; return; }
      }
    }
    function petSkillName(id) {
      const info = window.GData && GData.PET_SKILLS && GData.PET_SKILLS[Number(id)];
      return (info && info.name) || '幻兽技能';
    }
    function petSealCandidates(target) {
      const out = [];
      for (const w of target.weapons || []) {
        if (!w || target.petSealWeapons[w.id]) continue;
        out.push({ kind: 'weapon', id: Number(w.id), name: String(w.name || ('武器' + w.id)) });
      }

      const usableSkills = new Set((target.skillOrder || []).map(Number));
      for (const id of Object.keys(target.skills || {})) {
        const sid = Number(id);
        if (!sid || target.petSealSkills[sid]) continue;
        if (usableSkills.size && !usableSkills.has(sid)) continue;
        let name = '技能' + sid;
        try { const d = skillsMap.getValue(sid); if (d && d.name) name = d.name; } catch (e) {}
        out.push({ kind: 'skill', id: sid, name });
      }
      return out;
    }

    function petDirectDamage(att, def, amount, r) {
      let dmg = Math.max(0, Math.round(Number(amount) || 0));
      if (!def || def.hp <= 0 || dmg <= 0) { r.dmg = 0; return 0; }
      if (def.practice) {
        dmg = practiceHurt(def, dmg);
      } else if (def.hp - dmg <= 0 && def.skills && def.skills[6] && def.silence <= 0 && !def.usedFakeDie) {
        def.usedFakeDie = true;
        dmg = Math.max(0, def.hp - 1);
        def.hp = 1;
        def.stun = 0;
        r.fakeDie = true;
        r.fakeDieSide = def.side;
        queueFakeDiePets(def);
        queueImmediate({ actor: def, reason: 'fakeDie' });
      } else {
        def.hp = Math.max(0, def.hp - dmg);
        if (def.hp <= 0) tryDeathSave(def, r);
      }
      r.dmg = (r.dmg || 0) + dmg;
      return dmg;
    }
    function petHeal(att, amount, r) {
      if (!att || att.hp <= 0) return 0;
      const heal = Math.min(att.maxHp - att.hp, healOf(att, amount));
      if (heal > 0) att.hp += heal;
      r.healSelf = (r.healSelf || 0) + heal;
      return heal;
    }

    function petOnDodge(def, r) {
      if (!def || !(def.petDodgeHeal > 0) || def.hp <= 0 || def.hp >= def.maxHp) return 0;
      const heal = Math.min(def.maxHp - def.hp, healOf(def, def.petDodgeHeal));
      if (heal > 0) {
        def.hp += heal;
        r.dodgeHeal = (r.dodgeHeal || 0) + heal;
        r.dodgeHealPet = '凌波微步';
      }
      return heal;
    }

    function markDodge(r, def) {
      r.dodge = true;
      petOnDodge(def, r);
    }

    function petCleanse(c, r) {
      if (!c) return false;
      const had = !!(c.debuffs.power || c.debuffs.agility || c.debuffs.speed || c.dot ||
        c.stun > 0 || c.silence > 0 || c.disarm > 0 || c.stripTurns > 0 ||
        c.petWeakPct > 0 || c.petDotPlus || c.petHealCut ||
        Object.keys(c.petSealWeapons || {}).length || Object.keys(c.petSealSkills || {}).length);
      c.debuffs.power = 0; c.debuffs.agility = 0; c.debuffs.speed = 0;
      c.dot = null; c.stun = 0; c.silence = 0; c.disarm = 0; c.stripTurns = 0;
      c.petWeakPct = 0; c.petDotPlus = false;
      c.petSealWeapons = {}; c.petSealSkills = {};
      if (c.petHealCut) { c.healMul = Math.min(c.healMulBase, c.healMul * 2); c.petHealCut = false; }
      if (had) r.petCleanse = true;
      return had;
    }

    function petDotRounds(target, rounds) {
      return Math.max(1, Number(rounds) || 1) + (target && target.petDotPlus ? 1 : 0);
    }
    function petRoundBase(actor, pet, rule) {
      return {
        attacker: actor.side, action: 'pet', isRound: 0,
        petId: pet.id, petSlot: pet.slot, petName: pet.name, petGrade: pet.grade, petLevel: pet.level,
        petSkillId: pet.skillId, petSkillName: petSkillName(pet.skillId), petKind: rule.kind,
        noteText: pet.name + '·' + petSkillName(pet.skillId), noteSide: actor.side,
        attackPetIds: String(pet.id),
      };
    }

    function petAssist(actor, target, pushRound) {
      if (!actor || !target || !actor.pets.length || actor.hp <= 0 || target.hp <= 0) return false;
      const ready = [];
      for (const pet of actor.pets) {
        if (actor.petUsed[pet.slot]) continue;
        const rule = petRule(pet.skillId);
        if (!rule || !rule.onAction) continue;
        if (rule.hpBelow && actor.hp >= actor.maxHp * rule.hpBelow) continue;
        const value = petValue(pet.skillId, pet.level);
        if (rule.kind === 'healCut' && (target.petHealCut || target.healMul <= 0)) continue;
        if (rule.kind === 'weak' && target.petWeakPct >= value) continue;
        if (rule.kind === 'seal' && !petSealCandidates(target).length) continue;
        if (rule.kind === 'nextCrit' && actor.petNextCrit) continue;
        if (rule.kind === 'dotPlus' && target.petDotPlus) continue;
        if (rule.kind === 'cleanse' && !(actor.debuffs.power || actor.debuffs.agility || actor.debuffs.speed ||
          actor.dot || actor.stun > 0 || actor.silence > 0 || actor.disarm > 0 || actor.stripTurns > 0 ||
          actor.petWeakPct > 0 || actor.petDotPlus || actor.petHealCut ||
          Object.keys(actor.petSealWeapons || {}).length || Object.keys(actor.petSealSkills || {}).length)) continue;
        if (!chance(petTrigger(pet.skillId, pet.level))) continue;
        ready.push({ pet, rule, value });
      }
      if (!ready.length) return false;
      const chosen = ready.length === 1 ? ready[0] : ready[Math.floor(Math.random() * ready.length)];
      const { pet, rule, value } = chosen;
      actor.petUsed[pet.slot] = true;
      const r = petRoundBase(actor, pet, rule);
      if (rule.kind === 'damage') {
        petDirectDamage(actor, target, value, r);
      } else if (rule.kind === 'healCut') {
        target.petHealCut = true;
        target.healMul = Math.max(0, target.healMul * 0.5);
        r.petHealCut = 1;
      } else if (rule.kind === 'weak') {
        target.petWeakPct = Math.max(target.petWeakPct, value);
        r.petWeakPct = target.petWeakPct;
      } else if (rule.kind === 'seal') {
        const pick = pickOne(petSealCandidates(target));
        if (pick.kind === 'weapon') {
          target.petSealWeapons[pick.id] = true;
          if (target.pendingWeapon && Number(target.pendingWeapon.id) === pick.id) target.pendingWeapon = null;
        } else {
          target.petSealSkills[pick.id] = true;
        }
        r.petSeal = pick;
      } else if (rule.kind === 'nextCrit') {
        actor.petNextCrit = true;
        r.petNextCrit = true;
      } else if (rule.kind === 'cleanse') {
        petCleanse(actor, r);
      } else if (rule.kind === 'dotPlus') {
        target.petDotPlus = true;
        r.petDotPlus = true;
        if (target.dot) target.dot.rounds = Math.max(target.dot.rounds, petDotRounds(target, target.dot.rounds));
        if (target.stun > 0) target.stun += 1;
        if (target.silence > 0) target.silence += 1;
        if (target.disarm > 0) target.disarm += 1;
        if (target.stripTurns > 0) target.stripTurns += 1;
      }
      pushRound(r);
      // 这一下把对手打进装死时，先让对手的逆向推倒/回光术结算完；主行动已经挂起，
      // 等装死方自己行动完再由 resumeTurn 补（见 petAssist 之后的入队）。
      if (target.petAfterFakeDie) flushPetReactions(target, actor, pushRound);
      return true;
    }
    // 装死之后补发逆向推倒 / 回光术；同一技能一场只结算一次。
    // 取队伍顺序里第一只满足条件的（与原版“上阵顺序优先”一致）。
    function flushPetReactions(owner, foe, pushRound) {
      if (!owner || !owner.petAfterFakeDie || owner.hp <= 0) return false;
      owner.petAfterFakeDie = false;
      for (const pet of owner.pets) {
        if (owner.petUsed[pet.slot]) continue;
        const rule = petRule(pet.skillId);
        if (!rule || !rule.onFakeDie) continue;
        if (owner.petSkillUsed[pet.skillId]) continue;
        owner.petUsed[pet.slot] = true;
        owner.petSkillUsed[pet.skillId] = true;
        const r = petRoundBase(owner, pet, rule);
        const value = petValue(pet.skillId, pet.level);
        if (rule.kind === 'damage') petDirectDamage(owner, foe, value, r);
        else if (rule.kind === 'healPct') petHeal(owner, owner.maxHp * value / 100, r);
        pushRound(r);
        if (owner.hp <= 0 || foe.hp <= 0) return true;
      }
      return false;
    }


    function npcUlt(att, def) {
      const r = { attacker: att.side, action: 'skill', npcSkill: true, ult: true };
      if (att.npcType === 'tl') {
        r.ultName = '疾风镰刀舞'; r.multiHit = 4;
        if (chance(dodgeChance(att, def))) { markDodge(r, def); pushRound(r); return; }

        const jueDuiLock = jueDuiDecide(def, undefined);
        let total = 0;
        for (let i = 0; i < 4; i++) {
          const rr = { dmg: 0 };
          applyDamage(att, def, Math.round(effPower(att) * 0.36), rr, { action: 'skill', jueDuiLock: jueDuiLock });
          total += rr.dmg;
          if (rr.jueDui) r.jueDui = true;
          if (rr.reboundHurt) { r.reboundHurt = (r.reboundHurt || 0) + rr.reboundHurt; r.jueDui = true; }
          if (rr.fakeDie) inheritFakeDie(r, rr);
          if (rr.fakeDie || def.hp <= 0 || att.hp <= 0) break;
        }
        r.dmg = total; pushRound(r); return;
      }
      if (att.npcType === 'xh') {
        r.ultName = '仙鹤展翅';

        const raw = Math.round((effPower(att) + effSpeed(att) * RULES.xhSpeedShare) * 1.35);
        if (chance(dodgeChance(att, def))) { markDodge(r, def); pushRound(r); return; }
        applyDamage(att, def, raw, r, { action: 'skill' });
        pushRound(r); return;
      }
      r.ultName = '熊掌震地';
      const raw = Math.round(effPower(att) * 2.2);
      if (chance(dodgeChance(att, def))) { markDodge(r, def); pushRound(r); return; }
      applyDamage(att, def, raw, r, { action: 'skill' });
      if (def.hp > 0 && !r.fakeDie) { def.stun = Math.max(def.stun, 1); r.stunApplied = true; }
      pushRound(r);
    }


    function npcMechTurnStart(att, def) {
      if (att.mech.includes('berserk') && !att.mechState.berserk && att.hp > 0 && att.hp < att.maxHp * 0.5) {
        att.mechState.berserk = true;
        att.buffFlat.power += att.power;
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '血性狂暴';
      }
      if (att.mech.includes('freeze') && (att.npcActs || 0) % 3 === 0) {
        def.stun = Math.max(def.stun, 1);
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '寒冰禁锢';
      }

      const acts = att.npcActs || 0;

      if (att.mech.includes('trialCore')) {
        const stack = Math.min(coreMaxStacks(), Math.max(0, Math.floor(Number(att.mechState.coreStack) || 0)) + 1);
        if (stack !== att.mechState.coreStack) {
          att.mechState.coreStack = stack;
          att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') +
            '熔核·减伤 ' + Math.round(coreReduceOf(stack) * 100) + '%';
        }
      }
      if (att.mech.includes('trialCore') && !att.mechState.core && acts >= 7) {
        att.mechState.core = true;
        for (const key of ['power', 'agility', 'speed']) att.buffFlat[key] += Math.max(1, Math.round(att[key] * 0.5));
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '熔核成型';
      }
      if (att.mech.includes('trialBloodfang') && att.maxHp > 0) {
        const step = Math.floor((1 - att.hp / att.maxHp) / 0.25);
        if (step > att.mechState.bfStep) {
          const add = step - att.mechState.bfStep;
          att.mechState.bfStep = step;
          att.buffFlat.power += Math.max(1, Math.round(att.mechState.basePower * 0.20)) * add;
          att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '血牙·狂怒';
        }
      }
      if (att.mech.includes('trialFrost') && (acts - 1) % 3 === 0) {
        def.stun = Math.max(def.stun, 1);
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '霜缚';
      }
      if (att.mech.includes('trialDry')) {
        def.healMul = 0;
        if (acts % 3 === 0 && def.hp > 0) {
          const drain = Math.max(1, Math.round(def.hp * 0.1));
          def.hp = Math.max(0, def.hp - drain);
          att.hp = Math.min(att.maxHp, att.hp + drain);
          att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '枯泉·吸血';
        }
      }
      if (att.mech.includes('trialMoss') && att.hp > 0 && att.hp < att.maxHp) {
        att.hp = Math.min(att.maxHp, att.hp + Math.max(1, Math.round(att.maxHp * 0.06)));
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '苔甲再生';
      }
    }


    function npcMechAfter(att, def) {
      if (att.hp <= 0 || def.hp <= 0) return;
      if (att.mech.includes('wolf') && (att.npcActs || 0) % 2 === 0) {
        const wr = { attacker: att.side, action: 'skill', npcSkill: true, wolf: true, ultName: '唤狼协战' };
        applyDamage(att, def, Math.round(effPower(att) * 0.5), wr, {});
        pushRound(wr);
      }
      const devourPct = (att.mech.includes('devour') ? 0.02 : 0) + (att.mods && Number(att.mods.devourPct) || 0);
      if (devourPct > 0) {
        att.buffFlat.power += Math.max(1, Math.round(att.mechState.basePower * devourPct));
        att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '无尽吞噬';
      }
    }

    function npcAction(att, def) {
      const firstAction = !att.acted; att.acted = true;
      att.npcActs = (att.npcActs || 0) + 1;

      const xhEarly = att.npcType === 'xh' && att.npcActs <= 3
        ? (att.xhEarlyMul != null ? att.xhEarlyMul : 1.3) : 1;
      npcMechTurnStart(att, def);
      const rhythm = att.mech.includes('rhythmCrit') && att.npcActs % 4 === 0;
      if (rhythm) att.pendingNote = (att.pendingNote ? att.pendingNote + '·' : '') + '瞬杀节奏';
      if (!att.usedUlt && (att.npcType === 'xh' ? firstAction
        : att.npcType === 'tl' ? att.hp < att.maxHp * 0.2
        : att.npcType === 'xm' ? att.hp < att.maxHp * 0.4 : false)) {
        att.usedUlt = true; npcUlt(att, def); return;
      }
      const skillIds = Object.keys(att.skills).map(Number).filter((id) => id && !att.petSealSkills[id]);
      const useSkill = skillIds.length > 0 && pickNpcKind() === 'skill';
      const r = { attacker: att.side, action: 'common', npcSkill: false };
      if (useSkill) {
        r.action = 'skill'; r.npcSkill = true;
        const sid = skillIds[0];
        const lv = att.skills[sid];
        let raw;
        if (att.npcType === 'tl') { raw = Math.round(effPower(att) * (0.6 + Math.random() * 0.3)); r.multiHit = 2; }
        else if (att.npcType === 'xh') {
          raw = Math.round((effPower(att) + effSpeed(att) * RULES.xhSpeedShare) * (0.9 + lv * 0.1));

          if (att.xhSkillMul != null) raw = Math.round(raw * att.xhSkillMul);
        }
        else { raw = Math.round(effPower(att) * (1.3 + lv * 0.1)); }
        if (xhEarly !== 1) raw = Math.round(raw * xhEarly);
        if (att.petNextCrit) { att.petNextCrit = false; raw = Math.round(raw * 2.5); r.crit = true; r.petCrit = true; }
        else if (rhythm) { raw = Math.round(raw * 2.5); r.crit = true; }
        if (chance(dodgeChance(att, def))) { markDodge(r, def); pushRound(r); return; }

        const jueDuiLock = jueDuiDecide(def, undefined);
        let total = 0;
        const hits = r.multiHit || 1;
        for (let i = 0; i < hits; i++) {
          const rr = { dmg: 0 };
          applyDamage(att, def, raw, rr, { action: 'skill', jueDuiLock: jueDuiLock });
          total += rr.dmg;
          if (rr.jueDui) r.jueDui = true;
          if (rr.reboundHurt) { r.reboundHurt = (r.reboundHurt || 0) + rr.reboundHurt; r.jueDui = true; }
          if (rr.thornsDmg) r.thornsDmg = (r.thornsDmg || 0) + rr.thornsDmg;
          if (rr.shellAbsorb) r.shellAbsorb = (r.shellAbsorb || 0) + rr.shellAbsorb;
          if (rr.lifesteal) r.lifesteal = (r.lifesteal || 0) + rr.lifesteal;
          if (rr.guiJia) r.guiJia = rr.guiJia;
          if (rr.fakeDie) inheritFakeDie(r, rr);
          if (rr.deathSave) {
            r.deathSave = true; r.noteText = rr.noteText; r.noteSide = rr.noteSide;
            // 涅槃的属性加成标记也要一起带上来，否则界面上看不到「复活后变强」这条提示。
            if (rr.reviveStatMul) r.reviveStatMul = rr.reviveStatMul;

            if (rr.reviveTakenMul) r.reviveTakenMul = rr.reviveTakenMul;
          }
          if (rr.crit) r.crit = true;
          if (rr.fakeDie || def.hp <= 0 || att.hp <= 0) break;
        }
        r.dmg = total;
        maybeCounter(att, def, r, 'skill');
        pushRound(r);
        return;
      }
      if (chance(dodgeChance(att, def))) { markDodge(r, def); pushRound(r); return; }
      let raw = Math.round(effPower(att) * (0.8 + Math.random() * 0.4));
      if (xhEarly !== 1) raw = Math.round(raw * xhEarly);
      if (att.npcType === 'tl' && att.hp < att.maxHp * 0.25) raw = Math.round(raw * 1.3);
      if (att.petNextCrit) { att.petNextCrit = false; raw = Math.round(raw * 2.5); r.crit = true; r.petCrit = true; }
      else if (rhythm) { raw = Math.round(raw * 2.5); r.crit = true; }
      applyDamage(att, def, raw, r, {});
      maybeCounter(att, def, r, 'common');
      pushRound(r);
    }


    function maybeCounter(att, def, r, trigger) {
      if (trigger !== 'melee' && trigger !== 'common') return;
      // 练功木桩不还手：原版 `Stakes.attackBack()` 也是空函数，不能凭空反击。
      if (def.practice) return;

      if (r.fakeDie || def.hp <= 0 || att.hp <= 0) return;
      // 被闪避 / 被风影身法归零的主攻击没有“打中”，不能反被对方反击（否则回放先飘
      if (r.dodge || r.firstDodge || r.firstHitZero) return;

      if (r.thornsDmg || (r.reboundHurt && !r.jueDui)) return;

      let chanceBase = 25 + Math.max(0, Number(effect(def, 49)) || 0);
      if (def.npcType === 'xm') chanceBase = 45 + Math.max(0, Number(effect(def, 49)) || 0);
      if (!chance(clamp(chanceBase, 0, 100))) return;
      let raw = Math.round(effPower(def) * (0.6 + Math.random() * 0.4) * (1 + effect(def, 5) / 100));
      if (skill(def, 24)) raw = Math.round(raw * (1 + 0.5 + 0.06 * (Math.min(skill(def, 24), 10) - 1) + trueVal(24, skill(def, 24)) / 100));
      // 反击伤害只打原出手方：传 `noReflect` 禁止绝对防御 / 荆棘把这一下弹回反击者

      const counter = { action: 'common' };
      applyDamage(def, att, raw, counter, { noDodge: true, noReflect: true, counter: true, ignoreFakeDie: true });
      r.counterDmg = counter.dmg;

      if (counter.shellAbsorb) r.counterAbsorb = counter.shellAbsorb;

      if (!(counter.dmg > 0)) {
        if (counter.jueDui || counter.guiJia) {
          r.counterBlocked = counter.jueDui ? '绝对防御' : '龟甲术';
        } else if (counter.shellAbsorb) {
          r.counterBlocked = '护盾';
        }
      }
      if (counter.fakeDie) {
        r.counterFakeDie = true;

        if (counter.fakeDieSide != null) r.counterFakeDieSide = counter.fakeDieSide;
      }
      if (counter.deathSave) {

        r.counterDeathSave = true;
        if (counter.revive) r.counterRevive = true;
        if (counter.noteText) { r.noteText = (r.noteText ? r.noteText + '·' : '') + counter.noteText; r.noteSide = counter.noteSide; }
      }
      if (counter.reboundHurt) r.counterRebound = counter.reboundHurt;
      if (counter.thornsDmg) r.counterThorns = counter.thornsDmg;
    }

    function playerLikeAction(att, def, followup) {
      const r = { attacker: att.side };
      const forcedThrow = ONLINE_COMBAT && followup && followup.reason === 'doubleThrow' ? followup.weapon : null;
      // 真·野球拳「有N%几率可多使用一次」= 同一手再打一次野球拳，不是追加一次任意行动。
      const forcedSkill = followup && followup.reason === 'skillAgain' ? Number(followup.skill) : 0;
// 师父只在濒危时尝试救场，每场至多一次；无师父时不能凭空治疗。
      if (!forcedThrow && att.skills[13] && !att.usedMaster && att.masterLevel > 0 && att.silence <= 0 &&
          att.hp <= att.maxHp * rules.masterHpRatio && chance(rules.masterChance)) {
        att.usedMaster = true;
        const heal = Math.min(att.maxHp - att.hp, healOf(att, att.masterLevel * 4));
        att.hp += heal;
        att.mustHitNext = true;
        pushRound({ attacker: att.side, action: 'skill', id: 13, level: att.skills[13], healSelf: heal, noDmg: true });
        return;
      }
      // 幻兽·整蛊专家：被封住的武器/技能整场不能再用。这里先过滤，
      const usableWeapons = att.weapons.filter((w) => w && !att.petSealWeapons[w.id] &&
        (!ONLINE_COMBAT || weaponWeight(att, w) > 0 || (att.pendingWeapon && att.pendingWeapon.id === w.id) || (forcedThrow && forcedThrow.id === w.id)));
      const canWeapon = usableWeapons.length > 0 && att.disarm <= 0;

      // 可用技能从「这个 fighter 实际拥有的技能」里筛（att.skillOrder），
      // 而不是原版玩家那份硬编码的 ACTIVE_SKILLS 表 ——
      // 排除规则：小宇宙爆发每场一次、来点松果满血不放、本回合已用过的不能再用。
      const actives = (att.skillOrder || ACTIVE_SKILLS).filter((id) => att.skills[id] &&
        !att.petSealSkills[id] &&
        !(id === 14 && att.usedCosmos) && !(id === 17 && att.hp >= att.maxHp) &&
        !(att.pattern && att.skillCd && att.skillCd[id] > 0) &&
        !att.turnSkills[id] && (!ONLINE_COMBAT || skillWeight(att, id) > 0));
      const canSkill = actives.length > 0 && att.silence <= 0;
      const forceCosmos = !!(att.mods && att.mods.cosmosFirst) && !att.usedCosmos && canSkill &&
        actives.some((id) => Number(id) === 14);
      let kind;
      if (forceCosmos) {
        kind = 'skill';
      } else if (att.pattern) {
        const want = att.pattern[att.patternStep % att.pattern.length];
        att.patternStep++;
        if (want === 'weapon' && !canWeapon) kind = canSkill ? 'skill' : 'common';
        else if (want === 'skill' && !canSkill) kind = canWeapon ? 'weapon' : 'common';
        else kind = (want === 'weapon' || want === 'skill') ? want : 'common';
      } else {
        kind = pickKind(att, canWeapon ? usableWeapons : [], canSkill ? actives : []);
      }
      if (att.pendingWeapon && canWeapon && !att.petSealWeapons[att.pendingWeapon.id]) kind = 'weapon';
      if (forcedThrow) kind = 'weapon';
      if (forcedSkill && att.silence <= 0) kind = 'skill';

      if (kind === 'weapon') {
        const prepared = att.pendingWeapon && !att.petSealWeapons[att.pendingWeapon.id] ? att.pendingWeapon : null;
        let w;
        if (forcedThrow) w = forcedThrow;
        else if (prepared) w = prepared;
        else if (usableWeapons.length > 1 && !att.pattern) w = pickWeapon(att, usableWeapons);
        else w = usableWeapons[0];
        if (forcedThrow) r.secondThrow = true;
        att.lastWeaponId = w.id;
        att.pendingWeapon = null;
        if (w.id === 1 && !prepared) {
          att.pendingWeapon = w;
          pushRound({ attacker: att.side, action: 'rest', preparingWeapon: w.id });
          return;
        }
        att.usedWeapons[w.id] = true;
        att.weaponUseCount = att.weaponUseCount || {};
        att.weaponUseCount[w.id] = Math.max(0, Math.floor(Number(att.weaponUseCount[w.id]) || 0)) + 1;
        const needsSecondThrow = ONLINE_COMBAT && DOUBLE_THROW_IDS.has(Number(w.id)) && att.weaponUseCount[w.id] === 1;
        // 这一拍把对手打进装死时，对手先拿到立即行动，连投的第二下直接吞掉：
        // 不只是不补发，武器本场第二次使用的权重也一并扣掉，之后不能再拿出来用。
        let followupBlocked = false;
        const queueSecondThrow = () => {
          if (!needsSecondThrow) return;
          if (followupBlocked) {
            att.weaponUseCount[w.id] = Math.max(2, Math.floor(Number(att.weaponUseCount[w.id]) || 0));
            r.secondThrowCancelled = true;
            return;
          }
          if (att.hp > 0 && def.hp > 0) queueImmediate({ actor: att, reason: 'doubleThrow', weapon: w });
        };
        r.action = 'weapon'; r.id = w.id; r.level = w.level; r.wtype = w.type;

        att.weaponUses = (Number(att.weaponUses) || 0) + 1;
        const wUse = att.weaponUses;
        const freeCap = Number(att.mods && att.mods.weaponFreeUses) || 0;
        const boostCap = Number(att.mods && att.mods.weaponBoostUses) || 0;
        const boosted = boostCap > 0 && wUse <= boostCap;
        att.weaponBoostImmune = boosted && Number(att.mods && att.mods.weaponBoostReflectImmune) > 0;
        const grantFreeTurn = () => {
          if (freeCap <= 0 || wUse > freeCap) return;
          att.usedFreeWeapon = wUse;
          r.actAgain = true;
          r.noteText = (r.noteText ? r.noteText + '·' : '') + '不消耗回合';
          r.noteSide = att.side;
        };
        let raw = R(w.lo, w.hi);
        raw = Math.round(raw * (1 + effPower(att) / 120));
        if (skill(att, 5)) raw += (GData.passiveBonus(5, skill(att, 5)) * heroBaseMul(att, skill(att, 5))) * (1 + effect(att, 31) / 100);

        const specificId = w.id <= 15 ? w.id + 11 : (w.id === 16 ? 42 : w.id === 17 ? 43 : 0);
        raw = Math.round(raw * (1 + (effect(att, w.type === '投掷' ? 7 : 6) + (specificId ? effect(att, specificId) : 0)) / 100));
        if (boosted) {
          raw = Math.round(raw * (1 + (Number(att.mods.weaponBoostPowerMul) || 0)));

          r.weaponBoost = wUse;
        }
        const mustHit = [9, 15].includes(w.id) || att.mustHitNext ||
          (boosted && Number(att.mods.weaponBoostMustHit) > 0);
        att.mustHitNext = false;
        if (w.id === 10) def.meteorDodge = 20;
        let dodgePct = dodgeChance(att, def);
        if (!mustHit && chance(dodgePct)) {
          markDodge(r, def);
          grantFreeTurn();
          pushRound(r);
          att.weaponBoostImmune = false;
          if (r.actAgain && att.hp > 0 && def.hp > 0 && !pendingImmediate.some((x) => x.actor === att)) queueImmediate({ actor: att, reason: 'freeAction' });
          queueSecondThrow();
          return;
        }
        let cc = critChanceAgainst(att, def);
        if (w.id === 11) cc += weaponEffect(w, 20, 2, 3) + trueW(w, 'crit');
        cc = clamp(cc, 0, RULES.critCap);
        if (att.petNextCrit) {
          att.petNextCrit = false;
          let mult = 2 + (Math.random() < 0.5 ? 0 : 1) + effect(att, 45) / 100 + effect(att, w.type === '投掷' ? 3 : 2) / 100 + critDmgBonus(att);
          raw = Math.round(raw * mult); r.crit = true; r.petCrit = true;
        } else if (chance(cc)) {

          let mult = 2 + (Math.random() < 0.5 ? 0 : 1) + effect(att, 45) / 100 + effect(att, w.type === '投掷' ? 3 : 2) / 100 + critDmgBonus(att);
          const quad = trueVal(9, att.skills[9]);
          if (quad > 0 && chance(quad)) { mult = 4 + effect(att, 45) / 100 + effect(att, w.type === '投掷' ? 3 : 2) / 100 + critDmgBonus(att); r.crit4 = true; }
          raw = Math.round(raw * mult); r.crit = true;
        }
        let hits = 1;
        if (w.id === 4 && chance(weaponEffect(w, 10, 2, 5) + trueW(w, 'combo'))) hits = 2;
        if (w.id === 10 && chance(weaponEffect(w, 2, 2) + trueW(w, 'triple'))) hits = 3;
        r.hits = hits;

        const jueDuiLock = jueDuiDecide(def, w.type);
        let total = 0, landedHits = 0, dodgedHits = 0;
        for (let i = 0; i < hits; i++) {
          const rr = { dmg: 0, crit: r.crit, crit4: r.crit4 };
          applyDamage(att, def, raw, rr, { ignoreFakeDie: w.id === 7 || trueW(w, 'ignoreFakeDie') > 0, action: 'weapon', weaponType: w.type, jueDuiLock: jueDuiLock });
          total += rr.dmg;
          if (rr.dmg > 0) landedHits++;
          if (rr.dodge) dodgedHits++;
          // 「绝对防御触发了」这条标记必须独立于反弹伤害传播：投掷类被挡下时刻意不反弹
          if (rr.jueDui) r.jueDui = true;
          if (rr.reboundHurt) r.reboundHurt = (r.reboundHurt || 0) + rr.reboundHurt;
          if (rr.thornsDmg) r.thornsDmg = (r.thornsDmg || 0) + rr.thornsDmg;
          if (rr.shellAbsorb) r.shellAbsorb = (r.shellAbsorb || 0) + rr.shellAbsorb;
          if (rr.lifesteal) r.lifesteal = (r.lifesteal || 0) + rr.lifesteal;
          if (rr.guiJia) r.guiJia = rr.guiJia;
          if (rr.fakeDie) inheritFakeDie(r, rr);
          if (rr.deathSave) {
            r.deathSave = true; r.noteText = rr.noteText; r.noteSide = rr.noteSide;
            // 涅槃的属性加成标记也要一起带上来，否则界面上看不到「复活后变强」这条提示。
            if (rr.reviveStatMul) r.reviveStatMul = rr.reviveStatMul;

            if (rr.reviveTakenMul) r.reviveTakenMul = rr.reviveTakenMul;
          }
          if (rr.fakeDie || def.hp <= 0 || att.hp <= 0) break;
        }
        r.dmg = total;
        // 连击 / 三扔每一段都被先机预判 / 风影身法归零时，这一手整体算闪避：
        // 回放播闪避，并且不能反过来触发对方反击（只要有一段真的打中就不算）。
        if (!landedHits && dodgedHits) r.dodge = true;
        if (w.id === 3 && att.hp > 0) { att.swordDodge = Math.max(att.swordDodge, weaponEffect(w, 3, 3)); r.dodgeBuff = att.swordDodge; }

        const shellAntiDrop = r.guiJia > 0 && skill(def, 7) && def.silence <= 0
          ? clamp(Number(effect(def, 44)) || 0, 0, 100) / 100 : 0;
        const dropMul = 1 - shellAntiDrop;
        if (shellAntiDrop > 0) r.debuffCut = Math.round(shellAntiDrop * 100);
        if (def.hp > 0 && !r.fakeDie) {
          // `debuffStat` 是给战斗动画用的结构化字段（`debuffText` 是给人看的中文）：
          if (w.id === 5) { def.debuffs.agility = Math.max(def.debuffs.agility, weaponEffect(w, 10, 2) * dropMul); r.debuffText = '敏捷降低！'; r.debuffStat = 'agility'; }
          if (w.id === 6) { def.debuffs.speed = Math.max(def.debuffs.speed, weaponEffect(w, 10, 2) * dropMul); r.debuffText = '速度降低！'; r.debuffStat = 'speed'; }
          if (w.id === 8) { def.debuffs.power = Math.max(def.debuffs.power, weaponEffect(w, 10, 1) * dropMul); r.debuffText = '力量降低！'; r.debuffStat = 'power'; }
          if (w.id === 12 && chance(35)) { def.dot = { dmg: weaponEffect(w, 4, 3, 6) + trueW(w, 'dot'), rounds: petDotRounds(def, 4) }; r.dotApplied = true; }
          if (w.id === 13 && chance(weaponEffect(w, 10, 3, 3) + trueW(w, 'stun'))) { def.stun = Math.max(def.stun, petDotRounds(def, 1)); r.stunApplied = true; }
          if (w.id === 16 && chance(weaponEffect(w, 10, 4, 4) + trueW(w, 'silence'))) { def.silence = Math.max(def.silence, petDotRounds(def, 4)); r.silenceApplied = true; }
        }

        if (w.id === 14 && att.hp > 0 && total > 0) {
          const pct = weaponEffect(w, 10, 4) + trueW(w, 'lifesteal');
          const heal = Math.min(att.maxHp - att.hp, healOf(att, raw * pct / 100));
          att.hp += heal;
          r.lifesteal = (r.lifesteal || 0) + heal;
        }
        if (w.id === 17 && att.hp > 0) { const self = Math.round(att.hp * 0.1); att.hp -= self; r.selfBurn = self; tryDeathSave(att, r); }
        maybeCounter(att, def, r, (w.type === '近战' && w.id !== 2) ? 'melee' : 'ranged');
        // 反击 / 反伤也可能在这一拍把对手打进装死，追加行动要按最终队列判断。
        followupBlocked = pendingImmediate.some((x) => x.reason === 'fakeDie' && x.actor === def);
        grantFreeTurn();
        pushRound(r);
        att.weaponBoostImmune = false;
        if (r.actAgain && att.hp > 0 && def.hp > 0 && !followupBlocked && !pendingImmediate.some((x) => x.actor === att)) queueImmediate({ actor: att, reason: 'freeAction' });
        queueSecondThrow();
        return;
      }

      if (kind === 'skill') {
        const sid = forcedSkill ? forcedSkill
          : forceCosmos ? 14
          : (att.pattern
            ? nextPatternSkill(att, actives)                            // 固定循环：按技能表的轮转顺序出
            : pickSkill(att, actives));
        att.usedSkills[sid] = true;
        att.skillUseCount[sid] = skillUseCountOf(att, sid) + 1;
        att.turnSkills[sid] = true;
        att.lastSkillId = sid;

        if (att.pattern) att.skillCd[sid] = Number(RULES.skillCooldown) + 1;
        const lv = att.skills[sid];
        r.action = 'skill'; r.id = sid; r.level = lv;
        if (forcedSkill) r.repeatUse = true;
        const freeSkill = att.mods && att.mods.firstSkillFree && !att.usedFreeSkill;
        switch (sid) {
          case 8: {
            const raw = Math.round((R(15, 25) + 7 * (Math.min(lv, 10) - 1)) * (1 + effect(att, 33) / 100));
            // 色诱之术不占本次行动：命中/闪避都立即追加一次行动；不再给对手挂眩晕，
            // 也不产生眩晕图标。真化只保留脱装。
            r.actAgain = true;
            if (chance(dodgeChance(att, def))) { att.mustHitNext = false; markDodge(r, def); break; }
            applyDamage(att, def, raw, r, {});
            if (def.hp > 0 && !r.fakeDie && !r.dodge) {
              const stripPct = trueVal(8, lv) * (ONLINE_COMBAT ? 1 : 100);
              if (stripPct > 0 && chance(stripPct)) {
                def.stripTurns = petDotRounds(def, 4);
                def.stripVersion = (Number(def.stripVersion) || 0) + 1;
                r.stripApplied = Math.round(stripPct);
                r.specialEffect = 1;          // 原版日志字段：中了脱装备特效
              }
            }
            break;
          }
          case 12: {
            const raw = Math.round((effPower(att) + effSpeed(att)) * (1.2 + 0.15 * (Math.min(lv, 10) - 1)));
            // 真阶只加「多使用一次」的几率，不加伤害；第二下是再一次野球拳（forcedSkill 那一拍不再掷）。
            const doublePct = forcedSkill ? 0 : trueVal(12, lv);
            // 命中判定必须先于真化判定：非真化野球拳不额外消耗随机数；第一下被闪避也要补第二下。
            const dodged = chance(dodgeChance(att, def) * 0.7);
            if (dodged) { att.mustHitNext = false; markDodge(r, def); }
            else applyDamage(att, def, raw, r, {});
            if (doublePct > 0 && att.hp > 0 && (dodged || def.hp > 0) && chance(doublePct)) {
              r.actAgain = true; r.doubleHit = true; r.repeatSkill = 12;
            }
            break;
          }
          case 14: {
            att.usedCosmos = true;
            const cosmosPct = ((Math.min(lv, 10) + trueVal(14, lv)) / 100) * heroBaseMul(att, lv);
            for (const [key, id] of [['power', 36], ['agility', 37], ['speed', 38]]) {
              att.buffFlat[key] = Math.max(1, att.baseStats[key] * cosmosPct) + effect(att, id);
            }
            r.buffUp = true; r.noDmg = true; r.actAgain = true;
            r.statBonus = { ...att.buffFlat };
            break;
          }
          case 15: {
            const raw = Math.round(def.hp * (35 + 2 * (Math.min(lv, 10) - 1)) / 100) + 7 + effect(att, 39) + trueVal(15, lv);
            if (chance(dodgeChance(att, def))) { att.mustHitNext = false; markDodge(r, def); break; }
            applyDamage(att, def, raw, r, { ignoreFakeDie: false });
            break;
          }
          case 17: {
            const healBase = (20 + 2 * (Math.min(lv, 10) - 1) + trueVal(17, lv)) * Math.max(1, effect(att, 40));
            const heal = Math.min(att.maxHp - att.hp, healOf(att, healBase * heroBaseMul(att, lv)));
            att.hp += heal;
            r.healSelf = heal; r.noDmg = true; r.actAgain = true;
            break;
          }
          case 18: {
            // 原版 `skillsArray` 18 号「吸铁大法」没有“必中”：这里必须先走 `dodgeChance`。
            const raw = Math.round((R(5, 20) + 4 * (Math.min(lv, 10) - 1)) * (1 + effect(att, 41) / 100));
            if (chance(dodgeChance(att, def))) { att.mustHitNext = false; markDodge(r, def); break; }

            applyDamage(att, def, raw, r, { ignoreFakeDie: true });
            const disarmPct = 10 + 4 * (Math.min(lv, 10) - 1) + trueVal(18, lv);
            if (chance(disarmPct)) {
              def.disarm = Math.max(def.disarm, petDotRounds(def, 4));
              r.disarmApplied = true;
              r.specialEffect = 1;          // 原版日志字段：中了缴械特效
            }
            break;
          }
          case 23: {
            const mult = R(1, 6);
            const raw = (15 + 8 * (Math.min(lv, 10) - 1) + trueVal(23, lv) + Math.max(0, Number(effect(att, 48)) || 0)) * mult;
            r.multiple = mult;
            // 原版协议第 15 字段 `boomCount` = 这一拍分裂成几个球（`MainMovie.as:17983`
            r.boomCount = mult;
            applyDamage(att, def, raw, r, {});
            break;
          }
        }
        if (freeSkill) { att.usedFreeSkill = true; r.actAgain = true; }

        maybeCounter(att, def, r, 'skill');
        pushRound(r);
        const followupBlocked = pendingImmediate.some((x) => x.reason === 'fakeDie' && x.actor === def);
        const canFollow = att.hp > 0 && def.hp > 0 && !followupBlocked && !pendingImmediate.some((x) => x.actor === att);
        // 装死抢到下一手时第二下野球拳作废（与双投同口径），不能留到之后的回合再补。
        if (r.repeatSkill) {
          if (canFollow) queueImmediate({ actor: att, reason: 'skillAgain', skill: r.repeatSkill });
          else r.repeatCancelled = true;
        } else if (r.actAgain && canFollow) {
          queueImmediate({ actor: att, reason: 'freeAction' });
        }
        return;
      }

      r.action = 'common';
      const dodge = chance(dodgeChance(att, def));
      att.mustHitNext = false;
      if (dodge) { markDodge(r, def); pushRound(r); return; }
      let raw = Math.round(effPower(att) * (0.8 + Math.random() * 0.4) * (1 + effect(att, 5) / 100));
      if (att.petNextCrit) {
        att.petNextCrit = false;
        raw = Math.round(raw * (2 + Math.random() + effect(att, 45) / 100 + effect(att, 1) / 100 + critDmgBonus(att)));
        r.crit = true; r.petCrit = true;
      } else if (chance(critChance(att))) {
        raw = Math.round(raw * (2 + effect(att, 45) / 100 + effect(att, 1) / 100 + critDmgBonus(att))); r.crit = true;
      }
      applyDamage(att, def, raw, r, {});
      maybeCounter(att, def, r, 'common');
      pushRound(r);
    }

    function tickRestrictions(actor) {
      if (actor.silence > 0) actor.silence--;
      if (actor.disarm > 0) actor.disarm--;
      if (!ONLINE_COMBAT && actor.stripTurns > 0) actor.stripTurns--;
    }

    // 一拍的主行动（NPC / 玩家共用）。幻兽协战把对手打进装死时，这一半会被拆出来，
    // 等装死方行动完再由 resumeTurn 补上，不再重跑回合前摇（回复 / 持续伤害 / 协战）。
    function takeMainAction(unit, foe, continuation) {
      if (unit.npcType) { npcAction(unit, foe); npcMechAfter(unit, foe); return; }
      if (unit.mech.length) { unit.npcActs = (unit.npcActs || 0) + 1; npcMechTurnStart(unit, foe); }
      playerLikeAction(unit, foe, continuation);
      if (unit.mech.length) npcMechAfter(unit, foe);
      if (foe.mech.includes('trialErode') && unit.hp > 0) {
        const stacks = Math.min(RULES.erodeMax, foe.mechState.erode + 1);
        if (stacks > foe.mechState.erode) {
          foe.mechState.erode = stacks;
          unit.buffFlat.power -= Math.max(1, Math.round(unit.mechState.basePower * 0.03));
        }
      }
    }

    if (A.mods && A.mods.openStrikePct && B.hp > 1) {
      const dmg = Math.max(1, Math.round(B.maxHp * Number(A.mods.openStrikePct)));
      B.hp = Math.max(1, B.hp - dmg);
      pushRound({ attacker: 0, action: 'dot', dmg, noteText: '先手制敌' });
    }


    if (A.mods && A.mods.openKill && B.hp > 0) {
      const dmg = Math.max(1, Math.round(B.hp));
      const saves = (B.mods && Array.isArray(B.mods.deathSaves)) ? B.mods.deathSaves : [];
      const bossLife = saves.findIndex((sv) => sv && sv.bossLife);
      B.hp = 0;
      // E17 是「直接赢」，不是一次普通伤害：敌方护盾也一并作废，否则 HUD 会留下
      B.shell = 0;
      B.shellCharges = 0;
      const rr = { attacker: 0, action: 'dot', dmg: dmg, noteText: '假如我直接赢', noteSide: 0 };
      if (bossLife >= 0) consumeDeathSave(B, saves.splice(bossLife, 1)[0], rr);
      if (B.hp <= 0 && !godSave(B)) { A.shell = 0; A.shellCharges = 0; }
      pushRound(rr);
    }

    let lastApActor = null, apRun = 0;

    function tryTimeoutRevive() {
      if (practice) return false;
      if (A.hp <= 0 || B.hp <= 0) return false;
      if (A.hp / A.maxHp >= B.hp / B.maxHp) return false;
      const saves = A.mods && Array.isArray(A.mods.deathSaves) ? A.mods.deathSaves : null;
      if (!saves || !saves.length) return false;

      const rr = { attacker: A.side, action: 'regen', isRound: 0, timeoutRevive: 1 };
      const before = A.hp;
      consumeDeathSave(A, saves.shift(), rr);
      rr.heal = Math.max(0, A.hp - before);
      pushRound(rr);
      return true;
    }
    // 装死 / 补完的主行动不占 60 手窗口：正好卡在第 60 手的装死不能被超时判负吞掉。
    // 双投 / 魅惑保持原口径：只在联机（非木桩）里越过上限。
    const capExemptAction = () => {
      const front = pendingImmediate[0];
      if (!front) return false;
      if (front.reason === 'fakeDie' || front.reason === 'resumeTurn') return true;
      return !!(ONLINE_COMBAT && !practice && front.reason === 'doubleThrow');
    };
    while (A.hp > 0 && B.hp > 0) {
      while (pendingImmediate.length && pendingImmediate[0].actor.hp <= 0) pendingImmediate.shift();
      // 一个窗口 = 60 手。窗口打满、双方都没死时：先把装死触发的幻兽协战补齐
      // （回光术可能改变血量比例），再判断要不要先走涅槃复活；
      if (actions >= actionCap && !capExemptAction()) {
        flushPetReactions(A, B, pushRound);
        flushPetReactions(B, A, pushRound);
        if (A.hp <= 0 || B.hp <= 0) break;
        if (!tryTimeoutRevive()) break;
        actions = 0;
      }
      const followup = pendingImmediate.shift() || null;
      const resumeTurn = !!(followup && followup.reason === 'resumeTurn');
      let actor = followup && followup.actor;
      if (!actor) {

        if (practice) {
          actor = practice === A ? B : A;
        } else {
          if (A.ap < 100 && B.ap < 100) {
            const elapsed = Math.min((100 - A.ap) / effSpeed(A), (100 - B.ap) / effSpeed(B));
            A.ap += elapsed * effSpeed(A); B.ap += elapsed * effSpeed(B);
          }
          let pick = A.ap >= B.ap ? A : B;

          if (pick === lastApActor && apRun >= RULES.maxConsecutiveActions) {
            const other = pick === A ? B : A;
            const gap = Math.max(0, 100 - other.ap);
            if (gap > 0) {
              const elapsed = gap / effSpeed(other);
              other.ap += elapsed * effSpeed(other);
              pick.ap += elapsed * effSpeed(pick);
            }
            other.ap = Math.max(other.ap, 100);
            if (pick.ap >= 100) pick.ap = 99;
            pick = other;
          }
          actor = pick;
          actor.ap -= 100;
          if (actor === lastApActor) apRun++;
          else { lastApActor = actor; apRun = 1; }
        }
      }
      const def = actor === A ? B : A;
      if (resumeTurn) {
        takeMainAction(actor, def, followup.resume || followup);
        if (A.hp <= 0 && godSave(A)) A.hp = 1;
        if (B.hp <= 0 && godSave(B)) B.hp = 1;
        continue;
      }
      actions++;
      const stripAtStart = ONLINE_COMBAT ? [A.stripTurns > 0 ? (A.stripVersion || 0) : null, B.stripTurns > 0 ? (B.stripVersion || 0) : null] : null;
      const tickOnlineStrips = () => {
        if (!stripAtStart) return;
        if (stripAtStart[0] !== null && stripAtStart[0] === (A.stripVersion || 0) && A.stripTurns > 0) A.stripTurns--;
        if (stripAtStart[1] !== null && stripAtStart[1] === (B.stripVersion || 0) && B.stripTurns > 0) B.stripTurns--;
      };
      actor.turnId = Number(actor.turnId || 0) + 1;
      actor.acts = Number(actor.acts || 0) + 1;
      actor.turnSkills = {};
      for (const cdId of Object.keys(actor.skillCd || {})) if (actor.skillCd[cdId] > 0) actor.skillCd[cdId]--;

      if (def.practice && def.hp < def.maxHp) {
        const heal = Math.max(0, def.maxHp - def.hp);
        def.hp = def.maxHp;
        def.practiceHealPending = (Number(def.practiceHealPending) || 0) + heal;
      }

      flushPetReactions(A, B, pushRound);
      flushPetReactions(B, A, pushRound);
      if (A.hp <= 0 || B.hp <= 0) break;

      applyRoundAuras(actor, def, pushRound);

      const drainPct = Math.max(0, Number(actor.mods && actor.mods.enemyHpDrainPct) || 0);
      if (drainPct > 0 && def.hp > 0) {
        const drainDmg = Math.max(1, Math.round(def.hp * Math.min(1, drainPct)));
        def.hp = Math.max(0, def.hp - drainDmg);
        const drainRound = { attacker: actor.side, action: 'dot', dmg: drainDmg,
          noteText: (actor.mods && actor.mods.enemyHpDrainNote) || '血蚀' };
        tryDeathSave(def, drainRound);
        pushRound(drainRound);
        if (def.hp <= 0) { if (godSave(def)) def.hp = 1; else break; }
      }
      const regenPct = (actor.mech.includes('regen') ? 0.03 : 0) + (actor.mods && Number(actor.mods.regenPct) || 0);

      const lrPct = (actor.mods && Number(actor.mods.lowHpRegenPct) || 0);
      if (lrPct > 0 && actor.hp > 0) {
        const gate = Number(actor.mods.lowHpRegenAt) || 0.5;
        if (actor.hp <= actor.maxHp * gate) {
          const ceil = Math.max(1, Math.round(actor.maxHp * gate));
          const room = Math.max(0, Math.min(actor.maxHp, ceil) - actor.hp);
          if (room > 0) {
            const heal = Math.min(room, healOf(actor, Math.max(1, Math.round(actor.maxHp * lrPct))));
            if (heal > 0) {
              actor.hp = Math.min(actor.maxHp, actor.hp + heal);
              pushRound({ attacker: actor.side, action: 'regen', heal: heal, lowHpRegen: true,
                noteText: '浴血重生', noteSide: actor.side });
              if (B.hp <= 0 || A.hp <= 0) break;
            }
          }
        }
      }
      if (regenPct > 0 && actor.hp > 0 && actor.hp < actor.maxHp) {
        const heal = Math.min(actor.maxHp - actor.hp, healOf(actor, Math.max(1, Math.round(actor.maxHp * regenPct))));
        actor.hp += heal;
        pushRound({ attacker: actor.side, action: 'regen', heal, noteText: actor.mech.includes('regen') ? '百草回春' : '回复' });
        if (B.hp <= 0 || A.hp <= 0) break;
      }
      if (actor.dot) {
        const dotDmg = actor.dot.pct ? Math.max(1, Math.round(actor.hp * actor.dot.pct)) : actor.dot.dmg;
        actor.hp -= dotDmg;
        const dotRound = { attacker: actor.side, action: 'dot', dmg: dotDmg, selfDot: true };
        tryDeathSave(actor, dotRound);
        pushRound(dotRound);
        actor.dot.rounds--;
        if (actor.dot.rounds <= 0) actor.dot = null;
        if (actor.hp <= 0) break;
      }
      if (actor.restNext) { actor.restNext = false; pushRound({ attacker: actor.side, action: 'rest' }); if (!followup) tickRestrictions(actor); tickOnlineStrips(); continue; }
      if (actor.stun > 0) { actor.stun--; pushRound({ attacker: actor.side, action: 'stunned' }); if (!followup) tickRestrictions(actor); tickOnlineStrips(); continue; }


      if (petAssist(actor, def, pushRound)) {
        if (A.hp <= 0 || B.hp <= 0) {
          if (A.hp <= 0 && godSave(A)) A.hp = 1;
          if (B.hp <= 0 && godSave(B)) B.hp = 1;
          if (A.hp <= 0 || B.hp <= 0) break;
        }
        // 幻兽协战把对手打进装死：先让装死方行动，这一拍的主行动等它打完再补，
        // 否则 1 血的目标在「立即行动」之前就被主行动补刀，装死等于白触发。
        if (pendingImmediate.some((x) => x.reason === 'fakeDie' && x.actor === def)) {
          const resume = followup && followup.reason === 'doubleThrow' ? followup : null;
          queueImmediate({ actor, reason: 'resumeTurn', resume });
          if (!followup) tickRestrictions(actor);
          tickOnlineStrips();
          continue;
        }
      }

      takeMainAction(actor, def, followup);
      if (!followup) tickRestrictions(actor);
      tickOnlineStrips();
      if (A.hp <= 0 && godSave(A)) A.hp = 1;
      if (B.hp <= 0 && godSave(B)) B.hp = 1;
    }

    // 60 手上限刚好卡在装死那一拍时，装死触发的幻兽协战仍要补发（可能改变胜负）。
    flushPetReactions(A, B, pushRound);
    flushPetReactions(B, A, pushRound);

    let winner;
    if (A.hp <= 0 && B.hp <= 0) winner = 0;
    else if (B.hp <= 0) winner = 0;
    else if (A.hp <= 0) winner = 1;
    // 超时按血量比例（前面已经把玩家侧能用的涅槃加时窗口打完，这里才是最终判负）。
    else winner = A.hp / A.maxHp >= B.hp / B.maxHp ? 0 : 1;

    return { rounds, winner, maxHp: [A.maxHp, B.maxHp], startShell: startShell, names: [A.name, B.name] };
  }


  window.Sim = {
    simulate, rules: RULES,
    // 幻兽技能数值 / 触发几率的唯一出口（State 的牧场详情也读 GData 同一份）。
    petSkillValueOf: petValue, petSkillTriggerOf: petTrigger,
// 供 tools/test-combat-rules.cjs 直接校验出手权重（不用统计近似）
    actionWeights: { skill: skillWeight, weapon: weaponWeight },
    // 三个「有效属性」的唯一出口（供测试/调参直接核对：终乘类加成到底乘在哪一层）。
    effStatsOf: (c) => ({ power: effPower(c), agility: effAgility(c), speed: effSpeed(c) }),

    _applyRoundAuras: applyRoundAuras,
    repeatRateOf, skillUseCountOf,

    kindWeights,

    coreReduceOf, coreMaxStacks,

    jueDuiChanceOf, shellChanceOf, passiveSkillBoost,

    dmgReduce,
    // 闪避率的唯一出口（同样供测试/调参直接核对，不用统计近似）。
    dodgeChanceOf: (att, def) => dodgeChance(att, def),
    // 暴击率 / 暴击伤害的唯一出口（供测试直接核对 70% 上限与 1:1 溢出转化）。
    critChanceOf: (att) => critChance(att),
    critChanceVs: critChanceAgainst,
    critDmgBonusOf: (att) => critDmgBonus(att),
    critCap: RULES.critCap,

    lowHpTakenDamage,
    defenseCaps: { again: BOOSTED_AGAIN_CAP, first: BOOSTED_FIRST_CAP },
  };
})();
