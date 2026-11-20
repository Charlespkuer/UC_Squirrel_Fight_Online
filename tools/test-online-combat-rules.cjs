'use strict';
const assert=require('node:assert/strict');
require('../server/game/runtime').boot();
const {withSeed,mulberry32}=require('../server/game/battle');
const S=globalThis.Sim;
const fighter=(extra={})=>({name:'test',level:90,power:40,agility:1,speed:10,hp:100000,maxHp:100000,weapons:[],skills:[],gears:[],...extra});
const run=(seed,a,b)=>withSeed(seed,()=>S.simulate(a,b));
const d16 = (lv, n) => S.jueDuiChanceOf({ skills: { 16: lv }, effects: {}, skillBoost: {} }, n);
assert.deepEqual([1, 5, 10].map((lv) => d16(lv, 0)), [20, 22, 24.5]);
assert.deepEqual([11, 13, 15].map((lv) => d16(lv, 1)), [5, 15, 24]);
assert.equal(d16(10, 1), 0.5); assert.equal(d16(15, 2), 0.5);
const s7 = (lv, n) => S.shellChanceOf({ skills: { 7: lv }, effects: {}, skillBoost: {} }, n);
assert.deepEqual([1, 5, 10].map((lv) => s7(lv, 0)), [20, 22, 24.5]);
/* 真化：首次仍是 24.5；「可多次使用」按原表 N% = 20/40/60/80/100。 */
assert.deepEqual([11, 13, 15].map((lv) => s7(lv, 1)), [20, 60, 100]);
assert.equal(s7(10, 1), 1); assert.equal(s7(15, 2), 100);
for (const lv of [1,15]) {
  for (const id of [1,2,3,4,7,10,11,12,15,16,17]) {
    for(let seed=0;seed<30;seed++) {
      const r=run(seed,fighter({weapons:[{id,level:lv}]}),fighter({speed:20})).rounds;
      assert(r.filter(x=>x.attacker===0&&x.action==='weapon'&&x.id===id).length <= 1);
    }
  }
  for (const id of [8,12,15,18,23]) for(let seed=0;seed<30;seed++) {
    const r=run(seed,fighter({skills:[{id,level:lv}]}),fighter({speed:20})).rounds;
    assert(r.filter(x=>x.attacker===0&&x.action==='skill'&&x.id===id).length <= 1);
  }
}
for(const id of [5,6,8,9,13,14]) {
  let observed=0, dodged=0;
  for(let seed=0;seed<60;seed++) {
    const rounds=run(seed,fighter({weapons:[{id,level:1}]}),fighter({speed:300,agility:10000})).rounds;
    const i=rounds.findIndex(r=>r.attacker===0&&r.action==='weapon'&&r.id===id);
    if(i<0)continue;
    observed++;
    if(rounds[i].dodge) dodged++;
    assert(rounds[i+1] && rounds[i+1].attacker===0 && rounds[i+1].action==='weapon' && rounds[i+1].id===id,'second throw must be next turn');
    assert.equal(rounds[i+1].secondThrow,true,'second throw must be marked');
    assert.equal(rounds.filter(r=>r.attacker===0&&r.action==='weapon'&&r.id===id).length,2);
  }
  assert(observed>0);
  if(id!==9) assert(dodged>0,'missed first throw still triggers second');
}
let casts=0, strips=0, freeActions=0, stunMarks=0, stunnedTurns=0;
for(let seed=0;seed<500;seed++) {
  const rounds=run(seed,fighter({skills:[{id:8,level:15}]}),fighter({speed:200})).rounds;
  for(let i=0;i<rounds.length;i++) {
    const r=rounds[i];
    if(r.action==='stunned') stunnedTurns++;
    if(r.attacker!==0||r.action!=='skill'||r.id!==8)continue;
    casts++;
    if(r.stunApplied) stunMarks++;
    if(r.stripApplied) {
      strips++;
      const actions=rounds.slice(i+1).filter(x=>['weapon','skill','common','rest','stunned'].includes(x.action));
      if(actions.length>=5 && !actions.slice(0,4).some(x=>x.stripApplied)) {
        assert(actions.slice(0,4).every(x=>x.stripLeft[1]>0),'strip covers four actions');
        assert.equal(actions[4].stripLeft[1],0,'strip expires after four actions');
      }
    }
    const next=rounds[i+1];
    if(next && next.hpAfter && next.hpAfter[0]>0 && next.hpAfter[1]>0) {
      assert.equal(next.attacker,0,'charm must give immediate next attack');
      assert.notEqual(next.action,'stunned','charm must not stun the target');
      freeActions++;
    }
  }
}
assert(casts>20&&strips>10&&freeActions>20&&stunMarks===0&&stunnedTurns===0,{casts,strips,freeActions,stunMarks,stunnedTurns});
for(const level of [1,10]) {
  for(let seed=0;seed<100;seed++) {
    const rounds=run(seed,fighter({skills:[{id:8,level}]}),fighter({speed:200})).rounds;
    for(const x of rounds) if(x.attacker===0 && x.action==='skill' && x.id===8 && !x.dodge) {
      assert(!x.stripApplied,'normal charm cannot strip');
    }
  }
}
/* 2026-10-29 反击口径：不可闪避；绝对防御 / 龟甲术 / 荆棘只能挡成 0，不能弹回反击者。
 * 旧实现先掷 dodgeChance(def,att)*0.5（被打方闪避顶到 55% 上限时 = 27.5%），
 * 再复用 applyDamage 让原出手方的反伤打到反击者。这里把两种旧病放在同一场景里守。 */
let counterRounds=0, counterBlocked=0, counterDodged=0, counterRebound=0, counterThorns=0, counterExtraLoss=0, counterZeroUnblocked=0;
for(let seed=0;seed<120;seed++) {
  const att=fighter({power:80,agility:10000,speed:50,weapons:[{id:3,level:10}],
    skills:[{id:16,level:15},{id:7,level:15}],mods:{dodgeBonus:100,thornsPct:0.5}});
  const def=fighter({power:80,agility:30,speed:50});
  let prev=[att.hp,def.hp];
  for(const r of run(seed,att,def).rounds) {
    if(r.counterDmg!=null || r.counterBlocked || r.counterFakeDie || r.counterDodge) {
      counterRounds++;
      if(r.counterBlocked) counterBlocked++;
      if(r.counterDodge) counterDodged++;
      if(r.counterRebound!=null) counterRebound++;
      if(r.counterThorns!=null) counterThorns++;
      if(!r.counterBlocked && !(r.counterDmg>0)) counterZeroUnblocked++;
      /* 反击方 = 这一拍的非出手方；除主攻击 r.dmg 外不该再掉血。 */
      const side=1-r.attacker;
      if((prev[side]-r.hpAfter[side])-(r.dmg||0)>0) counterExtraLoss++;
    }
    if(r.hpAfter) prev=r.hpAfter;
  }
}
assert(counterRounds>500 && counterBlocked===0,`counter sample ${counterRounds}/${counterBlocked}`);
assert.equal(counterDodged,0,'反击不能被闪避');
assert.equal(counterBlocked,0,'反击不能被绝对防御挡下');
assert.equal(counterRebound,0,'反击伤害不能被绝对防御弹回反击者');
assert.equal(counterThorns,0,'反击伤害不能被荆棘弹回反击者');
assert.equal(counterZeroUnblocked,0,'没被挡下的反击必须造成伤害');
assert.equal(counterExtraLoss,0,'反击者不能因反击掉血');

/* 随机 600 场（随机武器/技能/等级/熊猫 npcType）扫描所有反击回合，守住同一条不反弹口径。 */
function randomCounterFighter(rng,name) {
  const level=1+Math.floor(rng()*90), hp=500+Math.floor(rng()*5000);
  const weapons=[]; for(let i=0,n=Math.floor(rng()*4);i<n;i++) weapons.push({id:1+Math.floor(rng()*17),level:1+Math.floor(rng()*15)});
  const skills=[]; for(let i=0,n=Math.floor(rng()*6);i<n;i++) skills.push({id:1+Math.floor(rng()*24),level:1+Math.floor(rng()*15)});
  return {name,level,hp,maxHp:hp,power:10+rng()*80,agility:10+rng()*80,speed:10+rng()*80,
    weapons,skills,gears:[],effects:{},npcType:rng()<0.5?'xm':null};
}
const rng=mulberry32(20261029);
let scanRounds=0, scanBlocked=0;
for(let i=0;i<600;i++) {
  for(const r of run(10000+i,randomCounterFighter(rng,'甲'),randomCounterFighter(rng,'乙')).rounds) {
    if(r.counterDmg==null && !r.counterBlocked && !r.counterFakeDie) continue;
    scanRounds++; if(r.counterBlocked) scanBlocked++;
    assert.equal(r.counterRebound,undefined,'第 '+i+' 场：反击伤害被弹回反击者');
    assert.equal(r.counterThorns,undefined,'第 '+i+' 场：反击伤害被荆棘弹回反击者');
  }
}
assert(scanRounds>1000,`random counter scan ${scanRounds}/${scanBlocked}`);
assert.equal(scanBlocked,0,'随机反击也不能被绝对防御挡下');
console.log(`PASS counter: no dodge, no block, no reflect (${counterRounds} deterministic, ${scanRounds} random scanned)`);

/* 装死（技能 6）触发后，下一手必须是装死方自己的行动：双投的第二下、幻兽协战之后的
 * 主攻击都不能抢在它前面，否则 1 血的目标还没出手就被补刀。 */
const nextActingRound = (rounds, i) => {
  for (let j = i + 1; j < rounds.length; j++) {
    if (rounds[j].action === 'pet' || rounds[j].isRound === 0) continue;
    return rounds[j];
  }
  return null;
};
let fakeDieEvents = 0, swallowedSecondThrows = 0;
const scanFakeDie = (tag, makeAtt, makeDef) => {
  for (let seed = 0; seed < 40; seed++) {
    const rounds = run(seed, makeAtt(), makeDef()).rounds;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      if (!r.fakeDie || r.fakeDieSide == null) continue;
      const next = nextActingRound(rounds, i);
      if (!next) continue;
      fakeDieEvents++;
      assert.equal(Number(next.attacker), Number(r.fakeDieSide),
        tag + '：装死触发后下一手必须是装死方（seed ' + seed + '，第 ' + i + ' 拍）');
      /* 装死的立即行动会把出手方这一拍的连投（第二下）吞掉：装死触发后不能再补一投。 */
      assert.ok(!rounds.slice(i + 1).some((x) => x.secondThrow === true),
        tag + '：装死方立即行动之后不能再补第二投（seed ' + seed + '，第 ' + i + ' 拍）');
      /* 被吞掉的必须是整次“第二次使用”：武器权重一起扣掉，不能留到后续再拿出来打。 */
      const firstDoubleThrow = r.action === 'weapon' && r.secondThrow !== true &&
        [5, 6, 8, 9, 13, 14].includes(Number(r.id)) && Number(r.fakeDieSide) !== Number(r.attacker);
      if (firstDoubleThrow) {
        swallowedSecondThrows++;
        assert.equal(r.secondThrowCancelled, true,
          tag + '：装死打断的连投要标记为已吞掉（seed ' + seed + '，第 ' + i + ' 拍）');
        assert.ok(!rounds.slice(i + 1).some((x) =>
          x.attacker === r.attacker && x.action === 'weapon' && Number(x.id) === Number(r.id)),
          tag + '：被装死吞掉的第二投不能留到后续再用（seed ' + seed + '，第 ' + i + ' 拍）');
      }
    }
  }
};
const dieOwner = () => fighter({ speed: 1, hp: 50, maxHp: 50, skills: [{ id: 6, level: 1 }, { id: 17, level: 10 }] });
for (const id of [5, 6, 8, 9, 13, 14]) {
  scanFakeDie('双投 ' + id, () => fighter({ speed: 60, power: 500, weapons: [{ id, level: 10 }], pattern: ['weapon'] }), dieOwner);
}
scanFakeDie('幻兽协战', () => fighter({ speed: 60, power: 500, agility: 100, weapons: [{ id: 1, level: 10 }], pattern: ['weapon'],
  pets: [{ id: 1, name: '蛮犀牛', grade: 5, level: 15, skillId: 1 }] }),
  () => fighter({ speed: 1, hp: 50, maxHp: 50, skills: [{ id: 6, level: 1 }] }));
assert(fakeDieEvents > 100, '样本里应出现装死，实际 ' + fakeDieEvents);
assert(swallowedSecondThrows > 0, '样本里应出现被装死吞掉的第二投，实际 ' + swallowedSecondThrows);
console.log(`PASS fake die takes the next action and swallows the second throw (${fakeDieEvents} events, ${swallowedSecondThrows} swallowed)`);
console.log(`PASS throws, ordinary/true defensive limits, charm free action and 4 action strip (${casts} casts, ${freeActions} free, ${strips} strip)`);
