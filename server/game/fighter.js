'use strict';
// server/game/fighter.js — 存档 → 战斗体 / 快照
// `applyPetBonuses`。任何一处偏离，回放的血条和伤害就跟服务端对不上。
// ⚠ 顺序不能改：`totalStats` 已经把「被动技能 + 装备主属性」算进去了，

const runtime = require('./runtime');
const cheer = require('./cheer');
const nickname = require('../../js/nickname');

function State() { return globalThis.State; }

// 从当前内存里的 State 构一个战斗体。
// 调用前必须已经 `restorePayload` 过（见 runtime.withState）。
function fighterFromState(opts) {
  const o = opts || {};
  const S = State();
  const s = S.state();
  if (!s) throw new Error('fighter: 没有载入存档');

  const useProps = o.useProps === true;
  const stats = S.totalStats({ useProps });
  const pets = typeof S.petTeam === 'function' ? S.petTeam() : [];
  const usedGears = (S.myGears() || []).filter((g) => g && g.used);
  const f = {

    name: nickname.truncate(s.name || '', 36) || '小松鼠',
    level: Math.max(1, Math.round(Number(s.level) || 1)),
    power: Math.round(stats.power),
    agility: Math.round(stats.agility),
    speed: Math.round(stats.speed),
    hp: Math.max(1, Math.round(stats.hp)),
    maxHp: Math.max(1, Math.round(stats.hp)),
    baseStats: { power: s.power, agility: s.agility, speed: s.speed, hp: s.maxHp },
    weapons: (S.myWeapons() || []).map((w) => ({ id: w.id, level: w.level, harmLo: w.harmLo, harmHi: w.harmHi })),
    skills: (S.mySkills() || []).map((x) => ({ id: x.id, level: x.level })),
    gears: S.normalizeFoeGears(usedGears),
    effects: S.equipmentEffects(),
    masterLevel: s.master ? Math.max(0, Number(s.master.level) || 0) : 0,
    npcType: o.npcType || null,
    isPrentice: o.isPrentice === true,
  };
  // 幻兽加成必须在 totalStats 之后。
  if (pets.length) {
    f.pets = pets;
    S.applyPetBonuses(f, pets);
  } else {
    f.pets = [];
  }
  // 徒弟加油：只在主动战斗的调用点传 cheerAccountId；防守快照 / 被动战斗不传，
  if (o.cheerAccountId) {
    try { cheer.apply(Number(o.cheerAccountId), f); } catch (_) {  }
  }
  return f;
}

// 把快照里存的战斗体还原成这一场可用的入参（快照本身就是最终面板）。
function fighterFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const f = JSON.parse(JSON.stringify(snapshot));
  f.hp = Math.max(1, Math.round(Number(f.hp) || Number(f.maxHp) || 1));
  f.maxHp = Math.max(f.hp, Math.round(Number(f.maxHp) || f.hp));
  if (!Array.isArray(f.pets)) f.pets = [];
  if (!Array.isArray(f.weapons)) f.weapons = [];
  if (!Array.isArray(f.skills)) f.skills = [];
  if (!Array.isArray(f.gears)) f.gears = [];
  if (!f.effects || typeof f.effects !== 'object') f.effects = {};
  return f;
}

// 面板指纹：用来判断「这一级的快照要不要刷新」。
function fighterFingerprint(f) {
  if (!f) return '';
  const part = (list, keys) => JSON.stringify((list || []).map((x) => keys.map((k) => x[k])));
  return JSON.stringify([
    f.level, f.power, f.agility, f.speed, f.maxHp,
    part(f.weapons, ['id', 'level']), part(f.skills, ['id', 'level']),
    part(f.gears, ['id', 'ext', 'attr', 'gem', 'orange']),
    (f.pets || []).map((p) => [p.id, p.level, p.skillId]),
    f.masterLevel, f.effects,
  ]);
}

module.exports = { fighterFromState, fighterFromSnapshot, fighterFingerprint, runtime };
