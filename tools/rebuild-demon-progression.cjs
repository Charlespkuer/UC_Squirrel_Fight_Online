'use strict';
/* Administrator-only reconstruction of the explicitly marked synthetic account.
 * The old immutable snapshots stay available to existing replay references. */
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const db=require('../server/db');
const runtime=require('../server/game/runtime');
const store=require('../server/game/store');
const {fighterFromState}=require('../server/game/fighter');
if(process.env.SSDZ_REBUILD_DEMON!=='1') throw Error('Set SSDZ_REBUILD_DEMON=1');
runtime.boot();
const a=db.get(`SELECT a.id,p.player_id FROM accounts a JOIN player_ids p ON p.account_id=a.id
 JOIN simulated_accounts s ON s.account_id=a.id WHERE a.name=? AND p.player_id=?`,'魔王',100001);
assert(a,'Expected the marked synthetic 魔王 account 100001');
const accountId=Number(a.id), original=store.getRow(accountId), before=store.decode(original.payload);
assert.equal(before.level,90);
const rows=db.all('SELECT * FROM battle_snapshots WHERE account_id=? AND mode=? ORDER BY level,revision DESC',accountId,'classic');
const history=new Map();for(const row of rows) if(!history.has(Number(row.level))) history.set(Number(row.level),JSON.parse(Buffer.from(row.json).toString('utf8')));
assert.equal(history.size,90);
const acquisition={weapon:new Map(),skill:new Map()};
for(let lv=1;lv<=90;lv++) for(const [kind,key] of [['weapon','weapons'],['skill','skills']]) {
  const f=history.get(lv); assert(f && f.level===lv);
  for(const it of f[key]||[]) if(!acquisition[kind].has(Number(it.id))) acquisition[kind].set(Number(it.id),lv);
}
const currentWeaponIds=before.weapons.map(x=>Number(String(x).split(':')[0]));
const currentSkillIds=before.skills.map(x=>Number(String(x).split(':')[0]));
assert.equal(new Set([...currentWeaponIds.map(x=>'w'+x),...currentSkillIds.map(x=>'s'+x)]).size,24);
const black=before.gears.filter(g=>g.used).map(g=>structuredClone(g));
assert.equal(black.length,4);
runtime.withState(before,({api})=>{
  assert(black.every(g=>api.gearQuality(g)===5));
  assert.equal(new Set(black.map(g=>api.gearInst(g.id).type)).size,4);
});
// Upgrade permissions are checked against the same table used by the game.
function levelFor(kind,id,level) {
  if(kind==='skill' && [6,13].includes(id)) return 1;
  const acquired=acquisition[kind].get(id)||level;
  const doneBy=83+(id*7+(kind==='skill'?3:0))%8;
  const progress=Math.max(0,Math.min(1,(level-acquired)/Math.max(1,doneBy-acquired)));
  // Invest early in a learned move, then finish individual true levels at
  // different times; the actual upgrade-table level limits still apply.
  let target=1+Math.floor(14*Math.pow(progress,0.65));
  let legal=1;
  while(legal<15 && Number(upgradeMap.getValue(legal).levelLimit)<=level) legal++;
  return Math.min(target,legal,15);
}
const finalGear=black.map((g,i)=>{
  g.ext=(g.ext||[]).map(x=>({id:Number(x.id),level:3}));
  assert.equal(g.ext.length,3);
  g.attr=Math.round(State.gearBaseAttr(g.id)*(1+State.GEAR_ATTR_JITTER));
  g.gem={id:107,ext:28};g.used=true;
  return g;
});
/* ---------------- 幻兽成长线 ----------------
 * 25 级解锁「幻兽牧场」后开始有幻兽；按玩家等级分批获得，星级随进度升级：
 *   25~34：1★；35~46：2★；47~61：3★；62+：4★。
 * 每只幻兽的等级从获得时的 1 级开始，按 1.6 级/玩家级成长，到自身 maxLevel 封顶；
 * 出战队伍最多 3 只，并且受「牧场等级 → 领导力」限制（牧场随玩家等级从 1 长到 30）。 */
const PET_PLAN = [
  { at: 25, id: 1 },   // 蛮犀牛 1★
  { at: 28, id: 3 },   // 冰原狼 1★
  { at: 31, id: 5 },   // 小花仙 1★
  { at: 35, id: 8 },   // 铁桶雪人 2★
  { at: 39, id: 10 },  // 沈王爷 2★
  { at: 43, id: 12 },  // 菜婶婶 2★
  { at: 47, id: 15 },  // 长角飞龙 3★
  { at: 51, id: 17 },  // 绿踪仙鹿 3★
  { at: 55, id: 26 },  // 铁嘴蜂 3★
  { at: 58, id: 28 },  // 招财熊猫 3★
  { at: 62, id: 19 },  // 南瓜大亨 4★
  { at: 66, id: 20 },  // 深海幽鲨 4★
  { at: 70, id: 31 },  // 神灯 4★
  { at: 74, id: 32 },  // 仙玲 4★
  { at: 80, id: 30 },  // 酷法 3★（后期补的板凳）
];
const PET_DEFS = new Map(State.PETS.map((p) => [Number(p.id), p]));
function makePet(def, level) {
  return { key: 'demon_pet_' + def.id, id: def.id, name: def.name, grade: def.grade,
    maxLevel: def.maxLevel, leadership: def.leadership, skillId: def.skillId,
    level, exp: 0, nextExp: Math.max(100, Math.round(100 * level)) };
}
function petsAt(level) {
  const owned = PET_PLAN.filter((e) => e.at <= level).map((e) => {
    const def = PET_DEFS.get(e.id);
    assert(def, 'missing pet def ' + e.id);
    const lv = Math.max(1, Math.min(def.maxLevel, 1 + Math.floor((level - e.at) * 2)));
    return makePet(def, lv);
  });
  /* 牧场等级随玩家等级 25→1、90→30；领导力 = (等级-1)*3+7。 */
  const ranch = Math.max(1, Math.min(30, Math.round(1 + (level - 25) * 29 / 65)));
  const cap = (ranch - 1) * 3 + 7;
  const ordered = owned.slice().sort((a, b) => b.grade - a.grade || b.level - a.level || a.id - b.id);
  const team = [];
  let lead = 0;
  for (const p of ordered) {
    if (team.length >= 3) break;
    if (lead + p.leadership > cap) continue;
    team.push(p.key);
    lead += p.leadership;
  }
  return { pets: owned, team };
}
assert.equal(petsAt(24).pets.length, 0, '幻兽 25 级才解锁');
assert.equal(petsAt(25).pets.length, 1, '25 级应有第一只幻兽');
const PET_AT_90 = petsAt(90);
assert.equal(PET_AT_90.team.length, 3, '90 级出战队伍应为 3 只');
const generated=[];
for(let level=1;level<=90;level++) {
  const prior=history.get(level);
  const clone=structuredClone(before);
  clone.level=level;clone.exp=0;clone.name='魔王';
  clone.power=prior.baseStats.power;clone.agility=prior.baseStats.agility;clone.speed=prior.baseStats.speed;clone.maxHp=prior.baseStats.hp;
  clone.weapons=(prior.weapons||[]).map(x=>`${Number(x.id)}:${levelFor('weapon',Number(x.id),level)}`);
  clone.skills=(prior.skills||[]).map(x=>`${Number(x.id)}:${levelFor('skill',Number(x.id),level)}`);
  const petState = petsAt(level);
  clone.pets = petState.pets;
  clone.petsTeam = petState.team;
  if(level<90) clone.master=null;
  const worn=(prior.gears||[]).map((g,i)=>({id:Number(g.id),key:'historic_'+level+'_'+i,used:true,ext:structuredClone(g.ext||[]),attr:g.attr||undefined,...(g.gem?{gem:structuredClone(g.gem)}:{})}));
  if(level>=45) for(const g of worn) {
    if(State.gearInst(g.id).quality>=4 && !g.gem) {
      const gem=Math.min(7,1+Math.floor((level-45)/7));
      g.gem={id:100+gem,ext:3*gem};
    }
  }
  const installed=Math.max(0,Math.min(4,Math.floor((level-60)/5)+1));
  for(let i=0;i<installed;i++) {
    const full=structuredClone(finalGear[i]);
    const type=State.gearInst(full.id).type;
    for(let j=worn.length-1;j>=0;j--) if(State.gearInst(worn[j].id).type===type) worn.splice(j,1);
    full.ext=full.ext.map(x=>({...x,level:level>=85?3:level>=75?2:1}));
    if(level<85) full.attr=State.gearBaseAttr(full.id);
    if(level>=65){const gem=Math.min(7,1+Math.floor((level-65)/4));full.gem={id:100+gem,ext:4*gem};} else delete full.gem;
    full.key='historic_black_'+i;worn.push(full);
  }
  clone.gears=worn;
  const out=runtime.withState(clone,({api,save})=>{
    const f=fighterFromState({useProps:false});
    assert.equal(f.level,level);
    assert(f.weapons.length+f.skills.length<=api.wsLimit());
    for(const w of f.weapons) assert.equal(w.level,levelFor('weapon',w.id,level));
    for(const s of f.skills) assert.equal(s.level,levelFor('skill',s.id,level));
    return f;
  });
  generated.push(out.value);
}
assert(generated[89].weapons.every(w=>w.level===15));
assert(generated[89].skills.every(s=>[6,13].includes(s.id)?s.level===1:s.level===15));
assert(generated[89].gears.length===4&&generated[89].gears.every(g=>g.gem&&g.gem.id===107));
assert.equal(generated[0].pets.length,0,'1 级不应有幻兽');
assert.equal(generated[24].pets.length,1,'25 级应有第一只幻兽');
assert.equal(generated[89].pets.length,3,'90 级出战 3 只幻兽');
assert(generated[89].pets.every(p=>p.level===p.maxLevel),'90 级出战幻兽应满级');
// Preserve account inventory, money, progress, sessions and all unrelated state.
const finalPayload=structuredClone(before);
finalPayload.weapons=before.weapons.map(x=>`${String(x).split(':')[0]}:15`);
finalPayload.skills=before.skills.map(x=>{const id=Number(String(x).split(':')[0]);return `${id}:${[6,13].includes(id)?1:15}`;});
for(const g of finalGear) {const idx=finalPayload.gears.findIndex(x=>x.key===g.key);assert(idx>=0);finalPayload.gears[idx]=g;}
finalPayload.upgradeFails={};
/* 90 级存档也要和 90 级快照一致：带上满级 4★ 三只、扩到能装下这批幻兽的牧场/存储格。 */
finalPayload.pets = PET_AT_90.pets;
finalPayload.petsTeam = PET_AT_90.team;
finalPayload.petsCapacity = Math.max(Number(finalPayload.petsCapacity) || 6, 35);
if (finalPayload.buildings && finalPayload.buildings.beast) {
  finalPayload.buildings.beast.level = Math.max(Number(finalPayload.buildings.beast.level) || 1, 30);
  finalPayload.buildings.beast.upgrading = false;
  finalPayload.buildings.beast.doneAt = 0;
}
const final=runtime.withState(finalPayload,()=>fighterFromState({useProps:false}));
assert.deepEqual(final.value,generated[89],'90-level snapshot must match the real current save');
const sum=store.summaryOf(final.payload), now=Date.now();
db.tx(()=>{
  const current=store.getRow(accountId);
  assert.equal(Number(current.revision),Number(original.revision),'Account changed while rebuilding; retry');
  db.run('UPDATE battle_snapshots SET is_current=0 WHERE account_id=? AND mode=?',accountId,'classic');
  for(const f of generated) {
    const revision=Number(db.get('SELECT COALESCE(MAX(revision),0)+1 AS n FROM battle_snapshots WHERE account_id=? AND mode=? AND level=?',accountId,'classic',f.level).n);
    db.run(`INSERT INTO battle_snapshots(id,account_id,mode,level,revision,is_current,json,summary,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      's_'+crypto.randomBytes(9).toString('base64url'),accountId,'classic',f.level,revision,f.level===90?1:0,Buffer.from(JSON.stringify(f)),`${f.name}|${f.level}|${f.power}/${f.agility}/${f.speed}/${f.maxHp}`,'synthetic-elite-v2',now+f.level);
  }
  db.run(`UPDATE saves SET revision=?,payload=?,level=?,name=?,power=?,agility=?,speed=?,hp=?,gold=?,gold_cup=?,integral=?,updated_at=? WHERE account_id=? AND mode='classic'`,
    Number(original.revision)+1,store.encode(final.payload),sum.level,sum.name,sum.power,sum.agility,sum.speed,sum.hp,sum.gold,sum.goldCup,sum.integral,now,accountId);
  db.run('UPDATE simulated_accounts SET note=? WHERE account_id=?','Synthetic elite progression v3; modeled levels + pets from 25, not real battle history',accountId);
});
console.log(JSON.stringify({accountId,playerId:100001,levels:generated.length,final:{weapons:generated[89].weapons,skills:generated[89].skills,gears:generated[89].gears,pets:generated[89].pets},milestones:generated.filter(f=>[1,10,25,30,40,50,60,70,80,90].includes(f.level)).map(f=>({level:f.level,weapons:f.weapons.length,skills:f.skills.length,highest:Math.max(0,...f.weapons.map(w=>w.level),...f.skills.map(s=>s.level)),gears:f.gears.length,pets:f.pets.length,petLevels:f.pets.map(p=>p.grade+':'+p.level)}))}));
