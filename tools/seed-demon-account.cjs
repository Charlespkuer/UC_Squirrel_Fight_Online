'use strict';
/* One-off, reproducible synthetic progression. Never run over an existing account.
 * Rewards are modeled, not real combat logs. Invoke with SSDZ_SEED_DEMON=1. */
const crypto = require('node:crypto');
const db = require('../server/db');
const auth = require('../server/auth');
const runtime = require('../server/game/runtime');
const { fighterFromState } = require('../server/game/fighter');
const battle = require('../server/game/battle');
const settlement = require('../server/game/settlement');

if (process.env.SSDZ_SEED_DEMON !== '1') throw new Error('Explicit SSDZ_SEED_DEMON=1 required');
// Enforce online economy even when running outside the HTTP server.
globalThis.__SSDZ_ONLINE__ = true;
runtime.boot();
const snapshots = [];
const trace = [];
const result = battle.withSeed(0x4d6f7761, () => runtime.withState(null, ({ api: S, save }) => {
  save.name = '魔王';
  const choiceScore = (x) => {
    const n = x.name || '';
    const prefer = ['幸运一击', '反击', '吸血', '致命', '狂暴', '闪避', '连击', '护体', '力王', '敏捷', '速度'];
    const idx = prefer.findIndex(k => n.includes(k));
    return idx < 0 ? (x.kind === 'weapon' ? 1 : 2) : 30 - idx;
  };
  for (let level = 1; level <= 90; level++) {
    if (level > 1) {
      const previous = level - 1;
      // Approximate winning challenges required for the XP; currency and
      // material income are synthetic estimates, not logged real battles.
      const xp = Math.max(0, GData.nextExp(previous) - save.exp);
      const wins = Math.max(1, Math.ceil(xp / S.challengeExp(previous, previous)));
      save.allWins += wins;
      S.addGold(wins * 4);
      save.props[21] = (save.props[21] || 0) + Math.min(30, Math.ceil(wins / 30));
      save.props[22] = (save.props[22] || 0) + Math.min(30, Math.ceil(wins / 30));
      for (const id of [24, 25, 26]) save.props[id] = (save.props[id] || 0) + Math.min(20, Math.ceil(wins / 25));
      S.gainExp(xp);
      while (S.pendingPoints()) S.allocatePoint(['power','agility','speed','hp'][level % 4]);
      while (S.pendingWS()) {
        const choices = S.currentWSChoices().slice().sort((a,b) => choiceScore(b) - choiceScore(a));
        if (!choices.length || !S.chooseWS(choices[0].kind, choices[0].id).ok) throw new Error('Cannot resolve skill selection');
      }
      // Respect level limits, costs, upgrade probability and failure pity.
      let attempts = 0;
      for (const kind of ['weapon','skill']) {
        const list = kind === 'weapon' ? S.myWeapons() : S.mySkills();
        for (const item of list) {
          for (let i = 0; i < 5 && attempts < 48; i++) {
            const info = S.upgradeInfo(kind, item.id);
            if (!info || info.max || info.levelLimit > level || info.item.level >= Math.min(S.TRUE_SKILL_MAX_LEVEL, 1 + Math.floor(level / 8)) || save.goldPoint < info.coin || (save.props[info.bookId] || 0) < info.book) break;
            S.doUpgrade(kind, item.id); attempts++;
          }
        }
      }
      if (level === 5) S.grantStarterGear();
      if (level >= 5) {
        // Simulated long-term event rewards; cards are then opened using
        // ordinary game rules. These are not claims of actual event history.
        if (level >= 60) {
          save.props[80] = (save.props[80] || 0) + 2;
          while ((save.props[80] || 0) > 0) if (!S.useProp(80, 71).ok) break;
          while ((save.props[77] || 0) >= 10) if (!S.composeGear(77).ok) break;
        }
        for (const id of [24,25,26]) {
          for (let i = 0; i < 2 && (save.props[id] || 0) >= 10; i++) if (!S.composeGear(id).ok) break;
        }
        // Fuse only spare pieces, keeping each currently worn item intact.
        for (let q = 0; q < 4; q++) {
          for (let i = 0; i < 2; i++) {
            const parts = S.myGears().filter(g => !g.used && g.quality === q);
            if (parts.length < 6) break;
            if (!S.mergeGears(parts.slice(0,3).map(g => g.key)).ok) break;
          }
        }
        const gear = S.myGears().filter(g => g.useLevel <= level);
        for (let type = 0; type < 4; type++) {
          const best = gear.filter(g => g.type === type).sort((a,b) => b.quality - a.quality || b.abilityVal - a.abilityVal)[0];
          if (best) S.wear(best.key);
        }
      }
      // Open the level 71–90 reward chests through the game's own implementation.
      while ((save.props[90] || 0) > 0) {
        if (!S.beginChest(90).ok) break;
        for (let i = 0; i < 10; i++) {
          const chest = S.chestState();
          if (chest && chest.reward.kind === 'points' && chest.reward.count >= 10) break;
          if (!S.reopenChest().ok) break;
        }
        if (!S.confirmChest().ok) throw new Error('Cannot confirm chest');
        while (S.pendingPoints()) if (!S.allocatePoint(['power','agility','speed','hp'][level % 4]).ok) break;
      }
    }
    const fighter = fighterFromState({ useProps: false });
    if (fighter.level !== level) throw new Error('Unexpected level ' + level);
    snapshots.push(fighter);
    trace.push({ level, wins: save.allWins, weapons: fighter.weapons.length, skills: fighter.skills.length, gear: fighter.gears.length });
  }
}));
if (snapshots.length !== 90 || result.payload.level !== 90) throw new Error('Incomplete progression');
if (db.get('SELECT id FROM accounts WHERE name = ?', '魔王')) throw new Error('Account 魔王 already exists; refusing to overwrite');
const password = crypto.randomBytes(18).toString('base64url') + 'a1';
let info;
db.tx(() => {
  const device = { hash: crypto.randomBytes(32).toString('hex'), platform: 'windows', provider: 'machine-guid', weak: false };
  const { account } = auth.register({ name: '魔王', password, ip: '', device });
  // Synthetic bootstrap identity is not a real device and must not occupy one.
  db.run('DELETE FROM account_devices WHERE account_id = ? AND device_hash = ?', account.id, device.hash);
  db.run('INSERT INTO simulated_accounts(account_id,note) VALUES (?,?)', account.id, 'Synthetic progression, seed 0x4d6f7761; modeled rewards');
  const p = result.payload, sum = require('../server/game/store').summaryOf(p), ts = Date.now();
  db.run(`INSERT INTO saves (account_id,mode,revision,payload,level,name,power,agility,speed,hp,gold,gold_cup,integral,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    account.id,'classic',1,Buffer.from(JSON.stringify(p)),sum.level,sum.name,sum.power,sum.agility,sum.speed,sum.hp,sum.gold,sum.goldCup,sum.integral,ts);
  for (const f of snapshots) db.run(`INSERT INTO battle_snapshots (id,account_id,mode,level,revision,is_current,json,summary,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    's_' + crypto.randomBytes(9).toString('base64url'), account.id,'classic',f.level,1,f.level === 90 ? 1 : 0,Buffer.from(JSON.stringify(f)),`${f.name}|${f.level}|${f.power}/${f.agility}/${f.speed}/${f.maxHp}`,'synthetic-progression',ts + f.level);
  settlement.ensureRating(account.id);
  info = { ...auth.publicAccount(account), password, trace, finalFighter: snapshots[89] };
});
console.log(JSON.stringify(info));
