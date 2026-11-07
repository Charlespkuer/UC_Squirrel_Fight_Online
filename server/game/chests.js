'use strict';
// Original lottery semantics: four revealed items, exactly one server reward.
// The selected box receives the first rolled prize; the other three are display.
const db = require('../db');
const store = require('./store');
const battle = require('./battle');
const settlement = require('./settlement');
const { fail } = require('../http');

function descriptor(row) {
  return { combatId: String(row.combat_id), kind: String(row.kind), choices: 4,
    claimed: row.picked != null, createdAt: Number(row.created_at) };
}

function create({ id, attackerId, kind, seed, settlement, packet, revenge }) {
  /* ssfight 原版 `rank.do` 只发积分/金杯/经验，没有战后宝箱；竞技/关卡/好友也没有。
   * 现在只有随机挑战保留四选一宝箱；复仇战明确不发。 */
  if (revenge) return null;
  if (kind !== 'random' || (settlement && settlement.practice)) return null;
  const D = globalThis.BattleDrops;
  const pool = D && D.poolFor ? D.poolFor('challenge') : [];
  const total = pool.reduce((sum, p) => sum + Math.max(0, Number(p.weight) || 0), 0);
  if (!(total > 0)) return null;
  const random = battle.mulberry32(seed ^ 0x2545f491);
  function take() {
    let value = random() * total, hit = pool[pool.length - 1];
    for (const p of pool) { value -= Math.max(0, Number(p.weight) || 0); if (value < 0) { hit = p; break; } }
    return hit;
  }
  const prizes = [];
  for (let i = 0; i < 4; i++) {
    let hit = take();
    for (let retry = 0; retry < 2 && prizes.some(p => p.id === hit.id); retry++) hit = take();
    prizes.push({ id: Number(hit.id), name: String(hit.name || ''), count: Math.max(1, Math.round(Number(hit.count) || 1)) });
  }
  const createdAt = Date.now();
  db.run('INSERT INTO combat_chests (combat_id, account_id, kind, prizes, created_at) VALUES (?,?,?,?,?)',
    String(id), Number(attackerId), kind, store.encode(prizes), createdAt);
  const chest = { combatId: String(id), kind, choices: 4, claimed: false, createdAt };
  if (packet) packet.chest = chest;
  return chest;
}

function pending(accountId) {
  const rows = db.all('SELECT combat_id, kind, picked, created_at FROM combat_chests WHERE account_id = ? AND claimed_at IS NULL ORDER BY created_at, combat_id LIMIT 50', Number(accountId));
  const count = db.get('SELECT COUNT(*) AS count FROM combat_chests WHERE account_id = ? AND claimed_at IS NULL', Number(accountId));
  return { ok: true, chests: rows.map(descriptor), pendingCount: Number(count.count) };
}

function status(combatId, accountId) {
  const row = db.get('SELECT combat_id, kind, picked, created_at FROM combat_chests WHERE combat_id = ? AND account_id = ?', String(combatId), Number(accountId));
  return row ? descriptor(row) : null;
}

function revealed(prizes, index) {
  const rest = prizes.slice(1);
  return [0, 1, 2, 3].map(i => i === index ? prizes[0] : rest.shift());
}

function claim(accountId, combatId, index) {
  if (typeof combatId !== 'string' || !/^c_[A-Za-z0-9_-]{10,80}$/.test(combatId) || !Number.isInteger(index) || index < 0 || index > 3)
    throw fail('BAD_REQUEST', '请选择有效的战斗宝箱与位置（0—3）');
  return db.tx(() => {
    const row = db.get('SELECT * FROM combat_chests WHERE combat_id = ? AND account_id = ?', combatId, Number(accountId));
    if (!row) throw fail('NOT_FOUND', '没有可领取的这场战斗宝箱');
    const prizes = store.decode(row.prizes);
    const duplicate = row.picked != null;
    const picked = duplicate ? Number(row.picked) : index;
    let out;
    if (!duplicate) {
      out = store.runOnSave(accountId, ({ api: S, save }) => {
        const prize = prizes[0];
        const ups = prize.id === 15 ? S.gainExp(prize.count) : [];
        if (prize.id === 8) S.addGold(prize.count);
        else if (prize.id !== 15) save.props[prize.id] = (Number(save.props[prize.id]) || 0) + prize.count;
        return { ups };
      }, { snapshotSource: 'battle-chest' });
      // Same transaction as the save: neither a lost response nor a restart can
      // turn one chest into a second grant. A different retry index is ignored.
      db.run('UPDATE combat_chests SET picked = ?, claimed_at = ? WHERE combat_id = ? AND picked IS NULL', picked, Date.now(), combatId);
    }
    /* 首次领取直接用 `runOnSave` 返回的 after payload，不再回表解码一次；
     * 重试（duplicate）才需要读当前行，因为那时没有任何写入。 */
    const current = out ? null : store.getRow(accountId);
    return { ok: true, combatId, duplicate, picked, prize: prizes[0], items: revealed(prizes, picked),
      chest: { ...descriptor(row), claimed: true }, ups: out ? out.value.ups : [],
      rev: out ? out.rev : Number(current.revision), patch: out ? out.patch : null,
      save: settlement.syncIntegral(accountId, out ? out.payload : store.decode(current.payload)) };
  });
}

module.exports = { create, pending, status, claim };
