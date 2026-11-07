#!/usr/bin/env node
'use strict';
/* 征战异步化回归：真人 4/4、5 分钟超时不扣票、随机匹配补位、共享 BOSS 血量、
   3~5 份骰子分奖、单份期望≈210 金松果、1 真人保底。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'out', '_campaign-test-' + process.pid + '-' + Date.now().toString(36));
process.env.DATA_DIR = dir;
process.env.GAME_ROOT = ROOT;

const db = require(path.join(ROOT, 'server', 'db.js'));
db.open({ dir });
const runtime = require(path.join(ROOT, 'server', 'game', 'runtime.js'));
const store = require(path.join(ROOT, 'server', 'game', 'store.js'));
const settlement = require(path.join(ROOT, 'server', 'game', 'settlement.js'));
const campaign = require(path.join(ROOT, 'server', 'game', 'campaign.js'));
const battle = require(path.join(ROOT, 'server', 'game', 'battle.js'));
runtime.boot();
/* 必须在 runtime.boot() 之后取：boot 里 `require` 这支脚本时才会把
 * `window.CampaignData` 挂到 globalThis；提前 require 会先占住缓存，
 * boot 的 require 直接拿缓存、不执行副作用，campaign.js 就找不到首领表。 */
const CampaignData = require(path.join(ROOT, 'js', 'campaign-data.js'));

let seq = 0;
function makeAccount(name) {
  const ts = Date.now();
  db.run(`INSERT INTO accounts (name,tag,pass_hash,pass_salt,recovery_hash,created_at,last_seen)
          VALUES (?,?,?,?,?,?,?)`, name, String(++seq).padStart(4, '0'), 'x', 'y', 'z', ts, ts);
  const id = Number(db.get('SELECT id FROM accounts WHERE name = ?', name).id);
  store.createSave(id, name);
  store.runOnSave(id, ({ api: S, save }) => {
    save.level = 90;
    save.power = 5000; save.agility = 5000; save.speed = 5000; save.maxHp = 50000;
    save.props[87] = 2;
    S.setWS('weapon', 1, 15);
    S.setWS('skill', 1, 15);
  });
  return id;
}
function ticket(id) { return Number(store.peek(id).props[87] || 0); }
function done(id) { return settlement.todayCount(id, 'campaign'); }

const ids = ['甲', '乙', '丙', '丁', '戊', '己'].map((n) => makeAccount('征战测试' + n));
const [A, B, C, D, E, F] = ids;

try {
  /* 1) 真人匹配：前 3 人只是等待，不扣门票 */
  const first = campaign.enqueue({ accountId: A, bossId: 1 });
  assert.equal(first.room.status, 'waiting');
  assert.equal(first.room.mode, 'real');
  assert.equal(first.room.seats.filter((s) => s.kind === 'player').length, 1);
  assert.ok(first.room.remainMs > 4 * 60 * 1000 && first.room.remainMs <= 5 * 60 * 1000, '5 分钟等待');
  campaign.enqueue({ accountId: B, bossId: 1 });
  campaign.enqueue({ accountId: C, bossId: 1 });
  assert.deepEqual([ticket(A), ticket(B), ticket(C)], [2, 2, 2], '等待中不扣票');
  assert.deepEqual([done(A), done(B), done(C)], [0, 0, 0], '等待中不计次数');

  /* 2) 第 4 人立刻开打：扣票、共享血量、3~5 份骰子奖 */
  const fourth = campaign.enqueue({ accountId: D, bossId: 1 });
  const room = fourth.room;
  assert.equal(room.status, 'done');
  assert.equal(room.teamResult, 'win');
  assert.equal(room.seats.length, 4);
  assert.ok(room.seats.every((s) => s.kind === 'player'), '4 个真人座位');
  assert.ok(room.roll && room.roll.prizes.length >= 3 && room.roll.prizes.length <= 5
    && room.roll.count === room.roll.prizes.length
    && new Set(room.roll.prizes.map((p) => Number(p.index))).size === room.roll.prizes.length
    && room.roll.prizes.every((p) => p.rolls.length === 4 && p.rolls.every((r) => r.point >= 0 && r.point <= 99)),
  '分奖页拿到公开 rollDatas（3~5 份、index 唯一、每份 4 个 0~99 点数）');
  assert.deepEqual([ticket(A), ticket(B), ticket(C), ticket(D)], [1, 1, 1, 1], '开打才扣票');
  assert.deepEqual([done(A), done(B), done(C), done(D)], [1, 1, 1, 1], '开打才计次数');
  const hp = room.seats.map((s) => ({ before: s.bossHpBefore, after: s.bossHpAfter, skipped: s.skipped }));
  assert.equal(hp[0].before, room.bossMaxHp, '第一场从满血开始');
  for (let i = 1; i < hp.length; i++) assert.equal(hp[i].before, hp[i - 1].after, '下一场接上一场剩余血量');
  /* 接力回放：同一房间的成员（即使自己这一场被跳过/没出手）也能看到其它座位的战报。 */
  const relaySeat = room.seats.find((s) => s.combatId);
  assert.ok(relaySeat, '至少有一份座位战报');
  const relayReplay = require('../server/game/fight').loadCombat(relaySeat.combatId, B);
  assert.ok(relayReplay && relayReplay.me && relayReplay.foe && relayReplay.result, '同房间成员可回放接力战报');
  assert.ok(hp.some((s) => s.after < s.before), '共享血量必须真的下降');
  const rewardOf = (id) => JSON.parse(store.toBuffer(
    db.get('SELECT reward FROM campaign_members WHERE room_id = ? AND account_id = ?', room.id, id).reward
  ).toString('utf8'));
  const rewarded = [A, B, C, D].map((id) => ({ id, reward: rewardOf(id) }));
  const totalPrizes = rewarded.reduce((n, x) => n + (x.reward.gold ? 1 : 0) + (Array.isArray(x.reward.lootList) ? x.reward.lootList.length : 0), 0);
  assert.ok(totalPrizes >= 3 && totalPrizes <= 5, '一局 3~5 份 rollDatas，实际 ' + totalPrizes);
  assert.ok(rewarded.every((x) => x.reward.win && x.reward.exp > 0), '队伍胜利时每个真人都有经验');
  assert.ok(rewarded.some((x) => x.reward.gold > 0 || (x.reward.lootList || []).length), '至少一份奖品归真人');
  assert.ok(rewarded.every((x) => !x.reward.loot || (x.reward.lootList || []).some((i) =>
    Number(i.id) === Number(x.reward.loot.id) && Number(i.count) === Number(x.reward.loot.count) && i.name === x.reward.loot.name
  )), 'loot 是 lootList 的首项兼容字段');
  for (const x of rewarded) {
    const save = store.peek(x.id);
    for (const item of x.reward.lootList || []) {
      if (item.kind === 'prop') assert.ok(Number(save.props[item.id]) >= item.count, '道具奖品要入账');
      if (item.kind === 'gear') assert.ok((save.gears || []).length > 0, '紫装奖品要入背包');
      if (item.kind === 'hatch') assert.ok(Number(save.hatchPoint) >= item.count, '孵化点奖品要入账');
    }
    if (x.reward.gold) assert.ok(Number(save.goldPoint) >= x.reward.gold, '金松果奖品要入账');
  }

  /* 3) 随机匹配：立刻 done，1 真人 + 3 助战；门票开打才扣 */
  const random = campaign.randomMatch({ accountId: E, bossId: 1 });
  assert.equal(random.room.status, 'done');
  assert.equal(random.room.mode, 'random');
  assert.equal(random.room.seats.length, 4);
  assert.equal(random.room.seats.filter((s) => s.kind === 'player').length, 1);
  assert.equal(random.room.seats.filter((s) => s.kind !== 'player' && s.kind !== 'empty').length, 3);
  assert.equal(ticket(E), 1, '随机匹配开打扣 1 张');
  assert.equal(done(E), 1);
  const randomReward = random.room.me.reward || {};
  assert.ok(randomReward.gold > 0 || (Array.isArray(randomReward.lootList) && randomReward.lootList.length > 0), '随机匹配也保底至少一份');
  assert.ok(random.room.bossMaxHp > 0 && random.room.bossHp >= 0);

  /* 3a) 接力回放：第一个人极弱、被 BOSS 打死，下一席助战仍要补出战报，
   * 且同房间真人能回放这份助战战报（客户端按 seat 顺序播完整条接力）。 */
  const G = makeAccount('征战测试庚');
  store.runOnSave(G, ({ save }) => {
    save.level = 60; save.power = 1; save.agility = 1; save.speed = 1; save.maxHp = 100;
    save.ws = {}; save.props[87] = 1;
  });
  const relayRoom = campaign.randomMatch({ accountId: G, bossId: 4 }).room;
  const relayBot = relayRoom.seats.find((s) => s.kind !== 'player' && s.combatId);
  assert.ok(relayBot, '第一个人阵亡后，下一席助战必须有战报');
  const relayView = require('../server/game/fight').loadCombat(relayBot.combatId, G);
  assert.ok(relayView && relayView.result && relayView.me && relayView.foe, '同房间成员能回放助战战报');

  /* 3b) 3~5 份骰子奖的期望：4 个真人、单份约 210 金松果等值，每张 200 票有可比性。 */
  const seats = [0, 1, 2, 3].map((seat) => ({ seat, accountId: seat + 1, kind: 'player' }));
  let planValue = 0, planPrizes = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const plan = CampaignData.rewardPlan(seed, seats);
    assert.ok(plan.count >= 3 && plan.count <= 5, '每局 3~5 份');
    assert.equal(plan.prizes.length, plan.count);
    for (const win of plan.prizes) {
      assert.equal(win.winnerKind, 'player', '4 个真人时每份都归真人');
      assert.equal(win.rolls.length, 4, '每份 4 个座位各掷一次');
      planValue += win.prize.value;
      planPrizes++;
    }
  }
  const avgPrize = planValue / planPrizes;
  const avgPlayer = planValue / (300 * 4);
  assert.ok(avgPrize >= 195 && avgPrize <= 225, '单份期望约 210，实际 ' + avgPrize.toFixed(2));
  assert.ok(avgPlayer >= 195 && avgPlayer <= 225, '每张票期望约 200，实际 ' + avgPlayer.toFixed(2));
  const solo = CampaignData.rewardPlan(42, [
    { seat: 0, accountId: 1, kind: 'player' },
    { seat: 1, accountId: 0, kind: 'bot' },
    { seat: 2, accountId: 0, kind: 'bot' },
    { seat: 3, accountId: 0, kind: 'bot' },
  ]);
  assert.ok(solo.prizes.some((p) => p.winnerKind === 'player' && p.winnerAccountId === 1), '1 真人 + 3 助战至少保底一份');

  /* 4) 5 分钟超时：failed、不扣票、不计次数 */
  const wait = campaign.enqueue({ accountId: F, bossId: 1 });
  assert.equal(wait.room.status, 'waiting');
  db.run('UPDATE campaign_rooms SET resolve_at = ? WHERE id = ?', Date.now() - 1, wait.room.id);
  campaign.pump();
  const failed = campaign.roomOf(wait.room.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failed_reason, 'timeout');
  assert.equal(ticket(F), 2, '超时不扣票');
  assert.equal(done(F), 0, '超时不计次数');
  assert.equal(campaign.current({ accountId: F }).room.status, 'failed');
  campaign.ack({ accountId: F, code: wait.room.code });
  assert.equal(campaign.current({ accountId: F }).room, null, 'ack 后不再提示');

  /* 4b) 强制紫装 + 孵化点，验证 applyPrize 真的入账（不是只写 reward JSON）。 */
  const gearBefore = (store.peek(F).gears || []).length;
  const hatchBefore = Number(store.peek(F).hatchPoint) || 0;
  const originalPlan = CampaignData.rewardPlan;
  CampaignData.rewardPlan = () => ({
    count: 2,
    prizes: [
      {
        index: 0,
        prize: { kind: 'gear', quality: 3, name: '紫色装备', value: 300 },
        rolls: [], winnerSeat: 0, winnerAccountId: F, winnerKind: 'player', discarded: false,
      },
      {
        index: 1,
        prize: { kind: 'hatch', name: '孵化点', count: 400, value: 400 },
        rolls: [], winnerSeat: 0, winnerAccountId: F, winnerKind: 'player', discarded: false,
      },
      {
        /* 异常/旧数据把同一份奖品带两遍：发奖与公开 roll 都必须只认一次。 */
        index: 1,
        prize: { kind: 'hatch', name: '孵化点', count: 400, value: 400 },
        rolls: [], winnerSeat: 0, winnerAccountId: F, winnerKind: 'player', discarded: false,
      },
    ],
  });
  try {
    const forced = campaign.create({ accountId: F, bossId: 1 });
    campaign.runRoom(forced.room.id);
    const forcedRoom = (campaign.current({ accountId: F }).room || {});
    const forcedReward = forcedRoom.me ? forcedRoom.me.reward || {} : {};
    assert.equal(forcedRoom.roll.count, 2, '重复 index 只公开一份');
    assert.equal(forcedRoom.roll.prizes.length, 2, '重复 index 只画一格');
    assert.ok((forcedReward.lootList || []).some((item) => item.kind === 'gear'), '紫装出现在 reward.lootList');
    assert.ok((store.peek(F).gears || []).length > gearBefore, '紫装真的进背包');
    assert.ok((forcedReward.lootList || []).some((item) => item.kind === 'hatch'), '孵化点出现在 reward.lootList');
    assert.equal(Number(store.peek(F).hatchPoint) || 0, hatchBefore + 400, '重复 index 不能发两次孵化点');
    campaign.ack({ accountId: F, code: forced.room.code });
  } finally {
    CampaignData.rewardPlan = originalPlan;
  }

  /* 4c) 随机幻兽：奖池生成时就把种类/等级掷定；等级期望随首领提高，中奖按掷定结果入栏。 */
  const H = makeAccount('征战测试辛');
  const expectPetLevel = { 1: 8, 2: 10, 3: 13.4, 4: 19 };
  let prevPetAvg = 0;
  for (const boss of CampaignData.BOSSES) {
    const levels = [];
    for (let seed = 1; seed <= 1200; seed++) {
      const plan = CampaignData.rewardPlan(seed, seats, boss);
      for (const win of plan.prizes) {
        if (win.prize.kind !== 'pet') continue;
        assert.ok(win.prize.pet && win.prize.pet.id > 0 && win.prize.pet.level >= 1,
          boss.name + ' 的幻兽奖品必须带掷定的种类与等级');
        levels.push(win.prize.pet.level);
      }
    }
    assert.ok(levels.length > 100, boss.name + ' 奖池要能抽到幻兽');
    const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
    assert.ok(Math.abs(avg - expectPetLevel[boss.bossId]) <= 1.2,
      boss.name + ' 幻兽等级期望应约 ' + expectPetLevel[boss.bossId] + '，实际 ' + avg.toFixed(2));
    assert.ok(avg > prevPetAvg, boss.name + ' 的幻兽等级期望必须高于上一只首领');
    prevPetAvg = avg;
  }
  const petsBefore = (store.peek(H).pets || []).length;
  const originalPetPlan = CampaignData.rewardPlan;
  const forcedPet = {
    id: 3, name: '冰原狼', grade: 1, maxLevel: 10, leadership: 5,
    skillId: 3, skillName: '狂暴', level: 9, exp: 0,
  };
  CampaignData.rewardPlan = () => ({
    count: 1,
    prizes: [{
      index: 0, prize: { key: 'random_pet', kind: 'pet', name: '幻兽', value: 400, pet: forcedPet },
      rolls: [{ seat: 0, accountId: H, kind: 'player', point: 99 }],
      winnerSeat: 0, winnerAccountId: H, winnerKind: 'player', discarded: false,
    }],
  });
  try {
    const forced = campaign.create({ accountId: H, bossId: 1 });
    campaign.runRoom(forced.room.id);
    const forcedRoom = campaign.current({ accountId: H }).room || {};
    const forcedReward = forcedRoom.me ? forcedRoom.me.reward || {} : {};
    assert.equal(forcedRoom.roll.prizes[0].prize.pet.id, 3, '公开 rollDatas 必须带掷定的幻兽');
    assert.ok((forcedReward.lootList || []).some((item) => item.kind === 'pet' && item.id === 3),
      '幻兽出现在 reward.lootList');
    const pets = store.peek(H).pets || [];
    assert.equal(pets.length, petsBefore + 1, '幻兽真的入栏');
    assert.equal(pets[pets.length - 1].id, 3);
    assert.equal(pets[pets.length - 1].level, 9, '入栏等级与分奖页显示一致');
    campaign.ack({ accountId: H, code: forced.room.code });
  } finally {
    CampaignData.rewardPlan = originalPetPlan;
  }

  /* 5) 四雄是 4 人档：面板固定，同等级单人几乎打不过，4 人队能接力过。
   * 固定随机流（玩家种子 + 战斗种子）避免概率断言抖动；阈值留出平衡余量。 */
  const State = globalThis.State, Sim = globalThis.Sim;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const lastHp = (result) => {
    for (let i = result.rounds.length - 1; i >= 0; i--) {
      if (Array.isArray(result.rounds[i].hpAfter)) return result.rounds[i].hpAfter;
    }
    return null;
  };
  const teamRun = (me, foe, seed) => {
    let hp = foe.maxHp, used = 0;
    for (let seat = 0; seat < 4; seat++) {
      if (hp <= 0) break;
      const f = clone(foe); f.hp = hp;
      const r = battle.withSeed(seed ^ (seat * 2654435761), () => Sim.simulate(clone(me), f));
      const after = lastHp(r);
      hp = Math.max(0, Math.min(hp, after ? Number(after[1]) || 0 : 0));
      used++;
    }
    return { win: hp <= 0, used };
  };
  for (const boss of CampaignData.BOSSES) {
    const foe = CampaignData.buildFoe(State, boss.bossId);
    const again = CampaignData.buildFoe(State, boss.bossId);
    assert.deepEqual(
      [foe.maxHp, foe.power, foe.agility, foe.speed],
      [again.maxHp, again.power, again.agility, again.speed],
      boss.name + ' 的面板必须每局固定'
    );
    assert.ok(foe.baseStats.power === foe.power && foe.baseStats.hp === foe.maxHp,
      boss.name + ' 的 baseStats 必须与缩放后的三维一致（被色诱/卸装时不掉档）');
    let solo = 0, team = 0, seats = 0, wins = 0, n = 0;
    for (let p = 0; p < 5; p++) {
      const me = battle.withSeed(1000 + boss.bossId * 100 + p,
        () => State.genAI(boss.level, '', { levelJitter: 0, gearSelfLevel: true }));
      me.hp = me.maxHp = me.maxHp || me.hp;
      for (let i = 0; i < 4; i++) {
        const seed = 7000 + boss.bossId * 100 + p * 10 + i;
        const r = battle.withSeed(seed, () => Sim.simulate(clone(me), clone(foe)));
        if (r.winner === 0) solo++;
        const t = teamRun(me, foe, seed);
        if (t.win) { team++; seats += t.used; wins++; }
        n++;
      }
    }
    assert.ok(solo / n <= 0.15, boss.name + ' 同等级单人胜率应 ≤15%（实际 ' + (solo / n * 100).toFixed(1) + '%）');
    /* 2026-11-05 用户口径把四雄整体加强（力/敏/速 +10%、血 +20%）：
     * 同一套固定随机流下 4 人队从 70%~95% 落到 **35%~75%**，所以这里的下限跟着
     * 从 50% 调到 **30%**（仍要"4 人队明显优于单人档"这一层意思，狼王 35% / 妖狐 45% 是新的最难关）。
     * 以后调四雄数值时，先跑这条用例看落在哪一档，再决定要不要动这里。 */
    assert.ok(team / n >= 0.3, boss.name + ' 4 人队胜率应 ≥30%（实际 ' + (team / n * 100).toFixed(1) + '%）');
    assert.ok(seats / Math.max(1, wins) >= 2.4, boss.name + ' 4 人队平均至少 2.4 人上场（实际 ' + (seats / Math.max(1, wins)).toFixed(2) + '）');
  }

  console.log('PASS 征战异步匹配：真人 4/4、5 分钟超时不扣票、随机助战、共享血量、3~5 份骰子分奖、期望≈200/票、随机幻兽、四雄 4 人档 (7 项)');
} finally {
  try { db.close(); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
}
