'use strict';
const assert = require('node:assert/strict');
const db = require('../server/db');
const rt = require('../server/game/runtime');
const battle = require('../server/game/battle');
const snapshot = require('../server/game/snapshot');
const opponent = require('../server/game/opponents');
const auth = require('../server/auth');
const social = require('../server/api/social');
const store = require('../server/game/store');
rt.boot();
const row = db.get('SELECT * FROM accounts WHERE name=?', '魔王');
assert(row);
const levels = db.all('SELECT * FROM battle_snapshots WHERE account_id=? ORDER BY level', row.id);
assert.equal(levels.length,90);
assert.deepEqual(levels.map(x => x.level), Array.from({length:90},(_,i) => i+1));
assert.equal(levels.filter(x=>x.is_current).length,1);
assert.equal(snapshot.currentSnapshot(row.id).level,90);
for (const lv of [1,10,30,60,90]) {
  const f = snapshot.snapshotById(levels[lv-1].id).fighter;
  assert.equal(f.level,lv);
  for (const prohibited of ['props','goldPoint','friends','battles']) assert(!(prohibited in f));
  let wins = 0;
  rt.withState(null, ({api}) => {
    for (let i=0;i<30;i++) {
      const foe = battle.withSeed(1000 + lv*100+i, () => opponent.buildRandomFoe(api, lv));
      if (battle.simulate(2000+lv*100+i, f, foe).winner === 0) wins++;
    }
  });
  console.log(`level ${lv}: wins ${wins}/30; weapons ${f.weapons.length}, skills ${f.skills.length}, gear ${f.gears.length}`);
  if (lv < 90) assert(snapshot.historical('classic', {excludeAccountId:0,minLevel:lv,maxLevel:lv,limit:5,includeInactiveSimulated:true}).some(x=>x.accountId===row.id));
}
db.run('UPDATE accounts SET last_seen=0 WHERE id=?',row.id);
assert(snapshot.historical('classic',{minLevel:10,maxLevel:10,includeInactiveSimulated:true}).some(x=>x.accountId===row.id));
assert(!snapshot.historical('classic',{minLevel:10,maxLevel:10}).some(x=>x.accountId===row.id));
const offerings=opponent.candidates(999999,{level:10},{kind:'random',recentIds:[]});
assert(offerings.some(x=>x.accountId===row.id && x.player && x.level>=1));
assert.equal(auth.findAccountStrict(String(auth.publicAccount(row).playerId)).id,row.id);
if (process.env.DEMON_TEST_PASSWORD) {
  const device = {hash:'a'.repeat(64),platform:'windows',provider:'machine-guid',weak:false};
  assert.equal(auth.login({name:auth.publicAccount(row).display,password:process.env.DEMON_TEST_PASSWORD,device,ip:'127.0.0.1'}).id,row.id);
  const other = auth.register({name:'itest' + Date.now().toString(36).slice(-6), password:'test-only-password1',device:{...device,hash:'b'.repeat(64)},ip:'127.0.0.1'}).account;
  store.createSave(other.id, other.name);
  social.addFriend({account:other,body:{target:String(auth.publicAccount(row).playerId)}});
  const friends = social.friends({account:other,query:{}}).friends;
  assert(friends.some(f => f.accountId === row.id && f.level === 90 && f.fighter.level === 90));
  console.log('normal password login and level-90 friend checks passed');
}
console.log('snapshot, inactive random matching and public-ID checks passed');
