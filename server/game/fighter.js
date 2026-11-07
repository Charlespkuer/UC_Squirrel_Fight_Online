'use strict';
/* ============================================================
 * server/game/fighter.js — 存档 → 战斗体 / 快照
 * ------------------------------------------------------------
 * 面板口径刻意与客户端 `js/main.js:1082-1094` 完全一致：
 * `State.totalStats({useProps})` → 武器/技能/外观 → `applySetBonuses` → `petTeam` →
 * `applyPetBonuses`。任何一处偏离，回放的血条和伤害就跟服务端对不上。
 *
 * ⚠ 顺序不能改：`totalStats` 已经把「套装属性 + 被动技能 + 装备主属性」算进去了，
 *   `applySetBonuses` 只补**战斗修正**（fighter.setFx），不要再加一次属性。
 * ============================================================ */

const runtime = require('./runtime');
const nickname = require('../../js/nickname');

function State() { return globalThis.State; }
function Engine() { return globalThis.Engine; }

/**
 * 从**当前内存里的 State** 构一个战斗体。
 * 调用前必须已经 `restorePayload` 过（见 runtime.withState）。
 */
function fighterFromState(opts) {
  const o = opts || {};
  const S = State();
  const s = S.state();
  if (!s) throw new Error('fighter: 没有载入存档');
  /* 联机天梯 / 好友切磋 / 征战 / 竞技场不用临时药剂（与现有天梯同口径）；
   * 随机挑战与关卡由各自的调用点决定（关卡原版也没有药丸）。 */
  const useProps = o.useProps === true;
  const stats = S.totalStats({ useProps });
  const pets = typeof S.petTeam === 'function' ? S.petTeam() : [];
  const usedGears = (S.myGears() || []).filter((g) => g && g.used);
  const f = {
    /* 旧账号名字最多 12 个汉字（36 个单位），保留原样；新昵称在注册时已按 7 个字收口。 */
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
  try { f.wears = Engine().wearsFor(usedGears); } catch (_) { f.wears = []; }
  /* 套装战斗修正 + 幻兽。两件都必须**在 totalStats 之后**。 */
  S.applySetBonuses(f);
  if (pets.length) {
    f.pets = pets;
    S.applyPetBonuses(f, pets);
  } else {
    f.pets = [];
  }
  return f;
}

/** 把快照里存的战斗体还原成这一场可用的入参（快照本身就是最终面板）。 */
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

/** 面板指纹：用来判断「这一级的快照要不要刷新」。 */
function fighterFingerprint(f) {
  if (!f) return '';
  const part = (list, keys) => JSON.stringify((list || []).map((x) => keys.map((k) => x[k])));
  return JSON.stringify([
    f.level, f.power, f.agility, f.speed, f.maxHp,
    part(f.weapons, ['id', 'level']), part(f.skills, ['id', 'level']),
    part(f.gears, ['id', 'ext', 'attr', 'gem', 'orange']),
    (f.pets || []).map((p) => [p.id, p.level, p.skillId]),
    f.masterLevel, f.effects, f.setFx || null,
  ]);
}

module.exports = { fighterFromState, fighterFromSnapshot, fighterFingerprint, runtime };
