'use strict';
// server/game/snapshot.js — 每级战斗快照
// 1. 异步对手/防守阵容只读快照（不读实时存档，避免被挑战后立刻换装针对）；

const crypto = require('node:crypto');
const db = require('../db');
const { config } = require('../config');
const visibility = require('./visibility');
const { fighterFromState, fighterFingerprint } = require('./fighter');
const vip = require('./vip');

function newId() {
  return 's_' + crypto.randomBytes(9).toString('base64url');
}

function gz(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function unz(blob) {
  try { return JSON.parse(Buffer.from(blob).toString('utf8')); } catch (_) { return null; }
}

function currentSnapshot(accountId, mode) {
  const row = db.get(
    'SELECT * FROM battle_snapshots WHERE account_id = ? AND mode = ? AND is_current = 1 ORDER BY level DESC, revision DESC LIMIT 1',
    Number(accountId), mode || 'classic'
  );
  return row ? hydrate(row) : null;
}

// 只要「当前快照是哪一条」的元数据，不解析 fighter JSON。
function currentSnapshotMeta(accountId, mode) {
  const row = db.get(
    'SELECT id, level, revision, created_at FROM battle_snapshots WHERE account_id = ? AND mode = ? AND is_current = 1 ORDER BY level DESC, revision DESC LIMIT 1',
    Number(accountId), mode || 'classic'
  );
  return row ? {
    id: String(row.id), level: Number(row.level), revision: Number(row.revision), createdAt: Number(row.created_at),
  } : null;
}

function snapshotById(id) {
  const row = db.get('SELECT * FROM battle_snapshots WHERE id = ?', String(id));
  return row ? hydrate(row) : null;
}

// 批量取快照（好友列表一次查完，避免每个好友一次 SELECT + fighter JSON 解析）。
function snapshotByIds(ids) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  const marks = list.map(() => '?').join(',');
  for (const row of db.all(`SELECT * FROM battle_snapshots WHERE id IN (${marks})`, ...list)) {
    out.set(String(row.id), hydrate(row));
  }
  return out;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    accountId: Number(row.account_id),
    mode: String(row.mode),
    level: Number(row.level),
    revision: Number(row.revision),
    isCurrent: !!Number(row.is_current),
    fighter: unz(row.json),
    createdAt: Number(row.created_at),
  };
}

// 保证「当前等级 + 当前面板」有一条 is_current 的快照。
// 必须在 `runtime.withState()` 的回调里（同步）调用。
function ensureCurrent(accountId, mode, source) {
  const m = mode || 'classic';
  let fighter;
  // 徒弟的师父升级后，防守快照也要带新的 masterLevel；只改内存存档，
  // 调用方（runOnSave）会在回调结束后统一落库。
  try {
    const st = globalThis.State && globalThis.State.state ? globalThis.State.state() : null;
    if (st) require('./apprentice').refreshMasterLevelInto(accountId, st);
  } catch (_) {}
  try { fighter = fighterFromState({ useProps: false }); } catch (_) { return { snapshot: null, created: false, revision: 0 }; }
  const level = Math.max(1, Math.round(Number(fighter.level) || 1));
  const fp = fighterFingerprint(fighter);
  const current = currentSnapshot(accountId, m);
  if (current && current.level === level && fighterFingerprint(current.fighter) === fp) {
    return { snapshot: current, created: false, revision: current.revision };
  }

  const sameLevelRows = db.all(
    'SELECT * FROM battle_snapshots WHERE account_id = ? AND mode = ? AND level = ? ORDER BY revision DESC',
    Number(accountId), m, level
  );
  for (const row of sameLevelRows) {
    const f = unz(row.json);
    if (fighterFingerprint(f) === fp) {
      db.tx(() => {
        db.run('UPDATE battle_snapshots SET is_current = 0 WHERE account_id = ? AND mode = ? AND is_current = 1', Number(accountId), m);
        db.run('UPDATE battle_snapshots SET is_current = 1 WHERE id = ?', row.id);
      });
      return { snapshot: hydrate(Object.assign({}, row, { is_current: 1 })), created: false, revision: Number(row.revision) };
    }
  }
  const revision = sameLevelRows.length
    ? Math.max(...sameLevelRows.map((r) => Number(r.revision))) + 1
    : 1;
  const id = newId();
  const ts = Date.now();
  db.tx(() => {
    db.run('UPDATE battle_snapshots SET is_current = 0 WHERE account_id = ? AND mode = ? AND is_current = 1', Number(accountId), m);
    db.run(
      `INSERT INTO battle_snapshots (id, account_id, mode, level, revision, is_current, json, summary, source, created_at)
       VALUES (?,?,?,?,?,1,?,?,?,?)`,
      id, Number(accountId), m, level, revision, gz(fighter),
      String(fighter.name || '') + '|' + level + '|' + fighter.power + '/' + fighter.agility + '/' + fighter.speed + '/' + fighter.maxHp,
      String(source || 'sync'), ts
    );
    prune(accountId, m, level);
  });
  return { snapshot: { id, accountId: Number(accountId), mode: m, level, revision, isCurrent: true, fighter, createdAt: ts }, created: true, revision };
}

function prune(accountId, mode, level) {
  const keep = Math.max(1, config.snapshotsPerLevel);
  const rows = db.all(
    'SELECT id, is_current FROM battle_snapshots WHERE account_id = ? AND mode = ? AND level = ? ORDER BY is_current DESC, revision DESC',
    Number(accountId), mode, level
  );
  if (rows.length <= keep) return;
  const drop = rows.slice(keep).filter((r) => !Number(r.is_current)).map((r) => String(r.id));
  for (const id of drop) db.run('DELETE FROM battle_snapshots WHERE id = ?', id);
}

// 候选对手：同赛区（或同等级段）的当前快照，排除自己/最近打过/长期不登录。
function candidates(mode, opts) {
  const o = opts || {};
  const m = mode || 'classic';
  const selfId = Number(o.excludeAccountId || 0);
  const level = Number(o.level) || 1;
  const levelSpread = o.levelSpread != null ? Number(o.levelSpread) : config.opponentLevelSpread;
  const lo = o.minLevel != null ? Math.max(1, Number(o.minLevel)) : Math.max(1, level - levelSpread);
  const hi = o.maxLevel != null ? Math.min(90, Number(o.maxLevel)) : level + levelSpread;
  const recent = (o.recentIds || []).map(Number).filter(Boolean);
  const idleCut = Date.now() - config.opponentIdleDays * 86400000;
  const viewerHidden = o.viewerHidden != null ? !!o.viewerHidden : visibility.isHidden(selfId);
  const params = [m, selfId, lo, hi, idleCut, o.includeInactiveSimulated ? 1 : 0];
  if (!viewerHidden) params.push(Date.now());

  let sql = `SELECT b.id, b.account_id, b.level, b.revision,
                    a.name AS acc_name, a.tag AS acc_tag, a.last_seen AS acc_last,
                    sv.vip_level AS vip_level, sv.vip_until AS vip_until,
                    r.score AS score, r.season AS season
             FROM battle_snapshots b
             JOIN accounts a ON a.id = b.account_id
             JOIN saves sv ON sv.account_id = b.account_id AND sv.mode = b.mode
             LEFT JOIN ratings r ON r.account_id = b.account_id AND r.season = ?
             WHERE b.mode = ? AND b.is_current = 1 AND b.account_id <> ?
               AND b.level BETWEEN ? AND ? AND b.level = sv.level
               AND a.banned = 0

               AND NOT EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = b.account_id)
               AND (a.last_seen >= ? OR (? = 1 AND EXISTS
                   (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = a.id)))
               AND ${visibility.hiddenSqlFor('b.account_id', viewerHidden)}`;
  // 参数顺序按 SQL 里出现的先后：week 在最前面（LEFT JOIN 条件），然后 mode/self/level/levelCut。
  params.unshift(o.week || o.season || '');
  const rows = db.all(sql, ...params);
  const list = rows.map((row) => ({
    snapshotId: String(row.id),
    accountId: Number(row.account_id),
    name: String(row.acc_name),
    tag: String(row.acc_tag),
    level: Number(row.level),
    revision: Number(row.revision),
    vipLevel: vip.levelAt(row.vip_level, row.vip_until),
    score: Number(row.score || 0),
    lastSeen: Number(row.acc_last || 0),
  })).filter((x) => x.accountId !== selfId && !recent.includes(x.accountId));
  // 天梯的积分差权重由调用方 `opponents.rankCandidates` 在抽取时计算；
  // 这里返回赛区内全部候选，不再按分数或等级预先排序/截断。
  return list;
}

function historical(mode, opts) {
  const o = opts || {};
  const viewerHidden = o.viewerHidden != null ? !!o.viewerHidden : visibility.isHidden(o.excludeAccountId);
  const params = [mode || 'classic', Number(o.excludeAccountId || 0), Number(o.minLevel || 1), Number(o.maxLevel || 90),
    Date.now() - config.opponentIdleDays * 86400000, o.includeInactiveSimulated ? 1 : 0];
  if (!viewerHidden) params.push(Date.now());
  params.push(Number(o.limit || 10));
  const rows = db.all(
    `SELECT b.id, b.account_id, b.level, a.name AS acc_name, a.tag AS acc_tag FROM battle_snapshots b
     JOIN accounts a ON a.id = b.account_id
      WHERE b.mode = ? AND b.is_current = 0 AND b.account_id <> ? AND b.level BETWEEN ? AND ? AND a.banned = 0
        AND (a.last_seen >= ? OR (? = 1 AND EXISTS
            (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = a.id)))
        AND ${visibility.hiddenSqlFor('b.account_id', viewerHidden)}
     ORDER BY b.created_at DESC LIMIT ?`,
    ...params
  );
  return rows.map((row) => ({
    snapshotId: String(row.id), accountId: Number(row.account_id),
    name: String(row.acc_name), tag: String(row.acc_tag), level: Number(row.level),
  })).filter((row) => !(o.recentIds || []).includes(row.accountId));
}

// 改名后同步当前防守快照里的显示名：面板/指纹不变，不新增 revision。
function renameCurrent(accountId, mode, name) {
  const m = mode || 'classic';
  const row = db.get(
    'SELECT * FROM battle_snapshots WHERE account_id = ? AND mode = ? AND is_current = 1 ORDER BY level DESC, revision DESC LIMIT 1',
    Number(accountId), m
  );
  if (!row) return false;
  const fighter = unz(row.json);
  if (!fighter) return false;
  fighter.name = String(name || '');
  const level = Math.max(1, Number(fighter.level) || Number(row.level) || 1);
  db.run('UPDATE battle_snapshots SET json = ?, summary = ? WHERE id = ?',
    gz(fighter),
    String(fighter.name || '') + '|' + level + '|' + fighter.power + '/' + fighter.agility + '/' + fighter.speed + '/' + fighter.maxHp,
    row.id
  );
  return true;
}

module.exports = { ensureCurrent, currentSnapshot, currentSnapshotMeta, snapshotById, snapshotByIds, candidates, historical, renameCurrent };
