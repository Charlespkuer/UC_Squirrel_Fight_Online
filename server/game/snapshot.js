'use strict';
/* ============================================================
 * server/game/snapshot.js — 每级战斗快照
 * ------------------------------------------------------------
 * 用户要求：**玩家每升一级都保存一份存档快照**。同时它承担三件事：
 *  1. 异步对手/防守阵容只读快照（不读实时存档，避免被挑战后立刻换装针对）；
 *  2. 历史对手可以从邻近等级的旧 revision 里抽；
 *  3. 战斗录像长期可复算：combats 记 snapshot_id。
 *
 * 生命周期（与 docs/联机实现方案.md §11.6.2 一致）：
 *  · 升级 → 新等级写 revision=1，is_current=1；
 *  · 同级换装/换武技/换幻兽/加点 → 同一级写新 revision，is_current 指到最新；
 *  · 每级最多 `snapshotsPerLevel` 条，超了删最旧的（is_current 永不删）。
 * ============================================================ */

const crypto = require('node:crypto');
const db = require('../db');
const { config } = require('../config');
const { fighterFromState, fighterFingerprint } = require('./fighter');

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

/** 只要「当前快照是哪一条」的元数据，不解析 fighter JSON。
 *  好友列表/摘要只要 id+level；以前每条好友都 `currentSnapshot()` 一次，
 *  50 位好友就多解析 50 份约 1.5 KB 的 JSON。 */
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

/**
 * 保证「当前等级 + 当前面板」有一条 is_current 的快照。
 * 必须在 `runtime.withState()` 的回调里（同步）调用。
 * @returns {{snapshot:object|null, created:boolean, revision:number}}
 */
function ensureCurrent(accountId, mode, source) {
  const m = mode || 'classic';
  let fighter;
  try { fighter = fighterFromState({ useProps: false }); } catch (_) { return { snapshot: null, created: false, revision: 0 }; }
  const level = Math.max(1, Math.round(Number(fighter.level) || 1));
  const fp = fighterFingerprint(fighter);
  const current = currentSnapshot(accountId, m);
  if (current && current.level === level && fighterFingerprint(current.fighter) === fp) {
    return { snapshot: current, created: false, revision: current.revision };
  }
  /* 同一个面板已经在某一级的历史里出现过（例如读档后回到同级）→ 直接把 is_current 挪过去，
   * 不再新写一条，避免每读一次档就膨胀一条 revision。 */
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

/** 候选对手：同赛区（或同等级段）的当前快照，排除自己/最近打过/长期不登录。
 *  `minLevel` / `maxLevel` 给天梯赛区用（整个 10 级赛区）；不传就按 `levelSpread` 取邻级。 */
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
  const params = [m, selfId, lo, hi, idleCut, o.includeInactiveSimulated ? 1 : 0];
  /* 只取列表需要的列：以前 `b.*` 会把每条快照的 `json` BLOB（约 1.5 KB/条）一起读出来，
   * 但这里只用到 id / account_id / level / revision。等级段人一多就是纯浪费。 */
  let sql = `SELECT b.id, b.account_id, b.level, b.revision,
                    a.name AS acc_name, a.tag AS acc_tag, a.last_seen AS acc_last,
                    r.score AS score, r.season AS season
             FROM battle_snapshots b
             JOIN accounts a ON a.id = b.account_id
             JOIN saves sv ON sv.account_id = b.account_id AND sv.mode = b.mode
             LEFT JOIN ratings r ON r.account_id = b.account_id AND r.season = ?
             WHERE b.mode = ? AND b.is_current = 1 AND b.account_id <> ?
               AND b.level BETWEEN ? AND ? AND b.level = sv.level
               AND a.banned = 0
               /* 天梯匹配池不放任何模拟/AI 账号（魔王等）；真人榜与真人匹配同一口径。 */
               AND NOT EXISTS (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = b.account_id)
               AND (a.last_seen >= ? OR (? = 1 AND EXISTS
                   (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = a.id)))`;
  /* 参数顺序按 SQL 里出现的先后：week 在最前面（LEFT JOIN 条件），然后 mode/self/level/levelCut。 */
  params.unshift(o.week || o.season || '');
  const rows = db.all(sql, ...params);
  let list = rows.map((row) => ({
    snapshotId: String(row.id),
    accountId: Number(row.account_id),
    name: String(row.acc_name),
    tag: String(row.acc_tag),
    level: Number(row.level),
    revision: Number(row.revision),
    score: Number(row.score || 0),
    lastSeen: Number(row.acc_last || 0),
  })).filter((x) => x.accountId !== selfId && !recent.includes(x.accountId));
  if (o.ratingSpread != null) {
    const mine = Number(o.myScore) || 0;
    const spread = Number(o.ratingSpread);
    const near = list.filter((x) => Math.abs(x.score - mine) <= spread);
    if (near.length >= 1) list = near;
  }
  /* 排序：等级差小 + 分数差小 + 一点随机（服务端 seed 由调用方在事务里定）。 */
  const myScore = Number(o.myScore) || 0;
  const rand = typeof o.random === 'function' ? o.random : Math.random;
  return list.map((item) => ({ item, order: Math.abs(item.level - level) * 2 + Math.abs(item.score - myScore) / 100 + rand() }))
    .sort((a, b) => a.order - b.order).map(({ item }) => item);
}

/** 历史对手：同等级区间的旧 revision（非 current），用于「往期对手」。 */
function historical(mode, opts) {
  const o = opts || {};
  const rows = db.all(
    `SELECT b.id, b.account_id, b.level, a.name AS acc_name, a.tag AS acc_tag FROM battle_snapshots b
     JOIN accounts a ON a.id = b.account_id
      WHERE b.mode = ? AND b.is_current = 0 AND b.account_id <> ? AND b.level BETWEEN ? AND ? AND a.banned = 0
        AND (a.last_seen >= ? OR (? = 1 AND EXISTS
            (SELECT 1 FROM simulated_accounts sa WHERE sa.account_id = a.id)))
     ORDER BY b.created_at DESC LIMIT ?`,
    mode || 'classic', Number(o.excludeAccountId || 0), Number(o.minLevel || 1), Number(o.maxLevel || 90),
    Date.now() - config.opponentIdleDays * 86400000, o.includeInactiveSimulated ? 1 : 0, Number(o.limit || 10)
  );
  return rows.map((row) => ({
    snapshotId: String(row.id), accountId: Number(row.account_id),
    name: String(row.acc_name), tag: String(row.acc_tag), level: Number(row.level),
  })).filter((row) => !(o.recentIds || []).includes(row.accountId));
}

/** 改名后同步**当前防守快照**里的显示名：面板/指纹不变，不新增 revision。
 *  历史 revision 保留当时的名字（老战报本来就该显示当时的名字）。 */
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

module.exports = { ensureCurrent, currentSnapshot, currentSnapshotMeta, snapshotById, candidates, historical, renameCurrent };
