'use strict';
// server/game/cheer.js — 徒弟给师父的「加油」加成
// · 师父主动战斗时由 fighterFromState({ cheerAccountId }) 叠加；防守快照/被动战斗不叠加；

const crypto = require('node:crypto');
const db = require('../db');

const ACTIVE = 'active';
const STATS = ['power', 'agility', 'speed'];
const LABELS = { power: '力量', agility: '敏捷', speed: '速度' };
const PERCENT = 5;
const MAX_STACKS = 3;

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

function rowsForMaster(masterId) {
  return db.all(
    `SELECT c.prentice_id, c.stat, c.created_at, a.name AS prentice_name
       FROM apprentice_cheers c
       JOIN apprenticeships ap ON ap.prentice_id = c.prentice_id
        AND ap.status = ? AND ap.master_kind = 'account' AND ap.master_id = ?
       JOIN accounts a ON a.id = c.prentice_id
      ORDER BY c.created_at ASC, c.prentice_id ASC`,
    ACTIVE, Number(masterId)
  );
}

function summaryFor(masterId) {
  const counts = { power: 0, agility: 0, speed: 0 };
  const members = [];
  for (const row of rowsForMaster(masterId)) {
    if (members.length >= MAX_STACKS) break;
    const stat = String(row.stat || '');
    if (!STATS.includes(stat)) continue;
    if (counts[stat] >= MAX_STACKS) continue;
    counts[stat] += 1;
    members.push({
      accountId: Number(row.prentice_id),
      name: String(row.prentice_name || ''),
      stat, statLabel: LABELS[stat], percent: PERCENT,
    });
  }
  const count = members.length;
  return { counts, count, percent: Math.min(MAX_STACKS * PERCENT, count * PERCENT), members, maxPercent: MAX_STACKS * PERCENT };
}

function forPrentice(prenticeId) {
  const row = db.get(
    `SELECT c.stat, c.created_at, ap.master_id, ap.master_kind
       FROM apprentice_cheers c
       LEFT JOIN apprenticeships ap ON ap.prentice_id = c.prentice_id AND ap.status = ?
      WHERE c.prentice_id = ?`,
    ACTIVE, Number(prenticeId)
  );
  if (!row) return null;
  const stat = String(row.stat || '');
  if (!STATS.includes(stat)) return null;
  return {
    stat, statLabel: LABELS[stat], percent: PERCENT,
    active: row.master_kind === 'account' && Number(row.master_id) > 0,
    masterId: Number(row.master_id) || 0,
    createdAt: Number(row.created_at) || 0,
  };
}

function apply(masterId, fighter) {
  if (!fighter || !(Number(masterId) > 0)) return null;
  const sum = summaryFor(masterId);
  for (const stat of STATS) {
    const stacks = Math.min(MAX_STACKS, Number(sum.counts[stat]) || 0);
    if (!stacks) continue;
    const base = Number(fighter[stat]) || 0;
    if (base <= 0) continue;
    fighter[stat] = Math.max(0, Math.round(base * (1 + PERCENT * stacks / 100)));
  }
  return sum;
}

function mark(prenticeId) {
  const id = Number(prenticeId);
  const ap = db.get('SELECT master_id, master_kind, status FROM apprenticeships WHERE prentice_id = ? AND status = ?', id, ACTIVE);
  if (!ap || ap.master_kind !== 'account' || !(Number(ap.master_id) > 0)) {
    throw err('CONFLICT', '现在没有真人师父，不能加油');
  }
  const masterId = Number(ap.master_id);
  const existing = db.get('SELECT stat, created_at FROM apprentice_cheers WHERE prentice_id = ?', id);
  if (existing) {
    const stat = String(existing.stat || '');
    const sum = summaryFor(masterId);
    const stacks = Math.min(MAX_STACKS, Number(sum.counts[stat]) || 0);
    return {
      ok: true, already: true, stat, statLabel: LABELS[stat] || '',
      percent: PERCENT, stacks, totalPercent: sum.percent,
      msg: '已经为师父加过油了：' + (LABELS[stat] || stat) + ' +5%（当前 ' + (LABELS[stat] || stat) + ' +' + (stacks * PERCENT) + '%）',
      oiling: sum,
    };
  }
  const stat = STATS[crypto.randomInt(0, STATS.length)];
  db.run('INSERT INTO apprentice_cheers (prentice_id, stat, created_at) VALUES (?,?,?)', id, stat, Date.now());
  const sum = summaryFor(masterId);
  const stacks = Math.min(MAX_STACKS, Number(sum.counts[stat]) || 0);
  return {
    ok: true, already: false, stat, statLabel: LABELS[stat],
    percent: PERCENT, stacks, totalPercent: sum.percent,
    msg: '为师父加油成功！' + LABELS[stat] + ' +5%（当前 ' + LABELS[stat] + ' +' + (stacks * PERCENT) + '%）',
    oiling: sum,
  };
}

module.exports = { STATS, LABELS, PERCENT, MAX_STACKS, rowsForMaster, summaryFor, forPrentice, apply, mark };
