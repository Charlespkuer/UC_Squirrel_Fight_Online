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
/* 真化：首次仍是 24.5；「可多次使用」的 N% 只决定第二次，第三次起走 30% 递减尾链。 */
assert.deepEqual([11, 13, 15].map((lv) => s7(lv, 1)), [20, 60, 100]);
assert.equal(s7(10, 1), 1); assert.equal(s7(15, 2), 0, 'shellChanceOf 只管前两次');
assert.equal(S.shellTailChanceOf({ skills: { 7: 15 }, effects: {}, skillBoost: {} }), 30);
for (const lv of [1,15]) {
  for (const id of [1,2,3,4,7,10,11,12,15,16,17]) {
    for(let seed=0;seed<30;seed++) {
      const r=run(seed,fighter({weapons:[{id,level:lv}]}),fighter({speed:20})).rounds;
      /* 西瓜刀连击是同一把武器的追加攻击（再打一次，不消耗回合）；流星锤前两投必出、第三投才判定。 */
      const cap = id===4 ? 2 : id===10 ? 3 : 1;
      assert(r.filter(x=>x.attacker===0&&x.action==='weapon'&&x.id===id).length <= cap);
    }
  }
  for (const id of [8,12,15,18,23]) for(let seed=0;seed<30;seed++) {
    const r=run(seed,fighter({skills:[{id,level:lv}]}),fighter({speed:20})).rounds;
    /* 真·野球拳是「一次使用打两下」的唯一例外，见下方专项。 */
    const cap = id===12 && lv>10 ? 2 : 1;
    assert(r.filter(x=>x.attacker===0&&x.action==='skill'&&x.id===id).length <= cap);
  }
}
/* 流星锤（10）连投：前两投 100% 必出（与菜刀 / 屎坨坨同口径），第三投才掷三连几率。
 * 固定随机 0 必中第三投、0.99 必不中 —— 两档分别应打出 3 投 / 2 投。 */
for (const [rnd, expect] of [[0, 3], [0.99, 2]]) {
  const realRandom = Math.random;
  Math.random = () => rnd;
  let rounds;
  try { rounds = S.simulate(fighter({weapons:[{id:10,level:1}], pattern:['weapon']}), fighter({speed:200})).rounds; }
  finally { Math.random = realRandom; }
  const mine = rounds.filter((r) => r.attacker === 0 && r.action === 'weapon' && Number(r.id) === 10);
  assert.equal(mine.length, expect, '流星锤连投次数（随机 ' + rnd + '）');
  assert.equal(mine[1].secondThrow, true, '第二投必须是连投追加');
  if (expect === 3) assert.equal(mine[2].secondThrow, true, '第三投也要标记为连投追加');
}
/* 流星锤没有必中：连投只保证「投得出」，三投各自掷闪避。固定随机 0.01 时三投全被闪避。
 * 对手敏捷 80 → 每投闪避率约 28%，远低于 100%；这里用固定随机流，不靠概率抽样。 */
{
  const realRandom = Math.random;
  Math.random = () => 0.01;
  let rounds;
  try {
    rounds = S.simulate(fighter({ weapons: [{ id: 10, level: 1 }], pattern: ['weapon'] }),
      fighter({ speed: 200, agility: 80 })).rounds;
  } finally { Math.random = realRandom; }
  const mine = rounds.filter((r) => r.attacker === 0 && r.action === 'weapon' && Number(r.id) === 10);
  assert.equal(mine.length, 3, '固定随机 0.01 应投满三投');
  assert.ok(mine.every((r) => r.dodge === true), '流星锤每一投都要掷闪避，不能是必中');
}
/* 真·野球拳（12）：原表「有N%几率可多使用一次」= 同一手再打一次野球拳，不是白送一次任意行动；
 * 第一下被闪避也要补（原攻略「就算没打中不是还有第2下么」），真5 的 100% 必须连打两下。 */
let fistPairs=0, fistFirstDodged=0;
for(let seed=0;seed<60;seed++) {
  const rounds=run(seed,fighter({skills:[{id:12,level:15}]}),fighter({speed:200,agility:150})).rounds;
  const idx=rounds.map((r,i)=>i).filter(i=>rounds[i].attacker===0&&rounds[i].action==='skill'&&rounds[i].id===12);
  assert.equal(idx.length,2,'真5 野球拳必须连打两下（seed '+seed+'）');
  assert.equal(rounds[idx[0]].doubleHit,true,'第一下要标记真化触发');
  assert.equal(rounds[idx[1]].repeatUse,true,'第二下必须是同技能追加');
  for(let j=idx[0]+1;j<idx[1];j++) {
    assert(!['weapon','skill','common','rest','stunned'].includes(rounds[j].action),
      '第二下野球拳不能被别的行动插队（seed '+seed+'）');
  }
  fistPairs++;
  if(rounds[idx[0]].dodge) fistFirstDodged++;
}
assert.equal(fistPairs,60,'真5 每场都要打满两下');
assert.ok(fistFirstDodged>0,'样本里应出现「第一下被闪避、第二下照打」，实际 '+fistFirstDodged);
/* 第二拳只结算 60%：固定随机 0.2（不闪避 / 不暴击），两段伤害应正好 60%。 */
{
  const oldRandom = Math.random;
  Math.random = () => 0.2;
  let rounds;
  try {
    rounds = S.simulate(fighter({ power: 100, agility: 100, speed: 100, hp: 4000, maxHp: 4000,
      skills: [{ id: 12, level: 15 }], pattern: ['skill'] }),
      fighter({ power: 1, agility: 1, speed: 1, hp: 999999, maxHp: 999999 })).rounds;
  } finally { Math.random = oldRandom; }
  const idx = rounds.map((r, i) => i).filter(i => rounds[i].attacker === 0 && rounds[i].action === 'skill' && rounds[i].id === 12);
  assert.equal(idx.length, 2, '真5 野球拳应有两段');
  assert.ok(rounds[idx[0]].dmg > 0, '第一段应命中');
  assert.equal(rounds[idx[1]].dmg, Math.round(rounds[idx[0]].dmg * 0.6), '第二段只结算 60% 伤害');
}
for(let seed=0;seed<60;seed++) {
  const rounds=run(seed,fighter({skills:[{id:12,level:10}]}),fighter({speed:200})).rounds;
  assert.equal(rounds.filter(r=>r.attacker===0&&r.action==='skill'&&r.id===12).length,1,'10 级野球拳没有第二下');
}
console.log(`PASS true fist: same skill twice (${fistPairs} doubles, ${fistFirstDodged} first-punch dodges)`);
/* 西瓜刀（4）连击：判定成功后不消耗回合、立刻用同一把刀再打一次完整攻击，不再把两段伤害并进同一拍。
 * 固定 Math.random = 0.2：闪避 12% 不中、连击 38% 必中、暴击 5% 不触发，两拍伤害可逐值比较。
 * 对手速度 999：若第二下走正常出手权，中间必然插进对手的行动。 */
{
  const oldRandom = Math.random;
  Math.random = () => 0.2;
  let rounds;
  try {
    rounds = S.simulate(fighter({ power: 100, agility: 100, speed: 100, hp: 4000, maxHp: 4000,
      weapons: [{ id: 4, level: 12 }], pattern: ['weapon'] }),
      fighter({ power: 1, agility: 1, speed: 999, hp: 4000, maxHp: 4000 })).rounds;
  } finally { Math.random = oldRandom; }
  const i = rounds.findIndex((r) => r.attacker === 0 && r.action === 'weapon' && r.id === 4);
  assert.ok(i >= 0, '样本里要出现西瓜刀出手');
  assert.equal(rounds[i].combo, true, '连击判定成功要记账');
  assert.equal(rounds[i].hits, 1, '连击不再把两段并进同一拍');
  const second = rounds[i + 1];
  assert.ok(second, '连击判定成功后必须补第二下');
  assert.equal(second.attacker, 0, '第二下必须是我方立即出手');
  assert.equal(second.action, 'weapon'); assert.equal(second.id, 4);
  assert.equal(second.comboFollow, true, '第二下要标记为连击追加');
  assert.equal(second.hits, 1);
  assert.ok(second.dmg > 0 && second.dmg === rounds[i].dmg, '两拍各打一次完整伤害，不能合并成一拍');
  assert.equal(rounds[i + 2] && rounds[i + 2].attacker, 1, '追加只补一次：第二下之后轮到对手，不能连环');
  console.log(`PASS watermelon combo: immediate extra attack without a turn (${rounds[i].dmg} x2)`);
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
/* 装死只给先手、不给行动点：色诱的追加攻击之后，装死方不能再用行动条接一次正常行动。 */
{
  const fast = fighter({ level: 60, power: 300, agility: 60, speed: 1100, hp: 3000, maxHp: 3000, pattern: ['common'], mods: { mustHitAll: 1 } });
  const die = fighter({ level: 60, power: 100, agility: 80, speed: 1000, hp: 200, maxHp: 200,
    skills: [{ id: 6, level: 1 }, { id: 8, level: 10 }, { id: 14, level: 10 }, { id: 17, level: 10 }] });
  const rounds = run(5, fast, die).rounds;
  const i = rounds.findIndex((r) => r.fakeDie && Number(r.fakeDieSide) === 1);
  assert.ok(i >= 0, 'seed 5 必须出现装死');
  const seq = [];
  for (let j = i + 1; j < rounds.length; j++) {
    const r = rounds[j];
    if (Number(r.attacker) !== 1) break;
    if (r.action === 'pet' || r.isRound === 0) continue;
    seq.push(r.action + (r.id ? '#' + r.id : ''));
  }
  assert.deepEqual(seq, ['skill#8', 'common'],
    '装死立即行动（色诱）消耗行动点后不能再接一次正常行动，实测 ' + seq.join('>'));
}
console.log('PASS fake die grants initiative without an extra action point (charm follow-up only)');
console.log(`PASS throws, ordinary/true defensive limits, charm free action and 4 action strip (${casts} casts, ${freeActions} free, ${strips} strip)`);
