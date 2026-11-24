'use strict';
/* 临时隐身：他人看到的天梯/公开候选不可见；隐身自己的排名与周奖励按含隐身的全榜正常计算；
 * 搜索、好友、师徒、直连切磋保持可用；存档与分数不变；到期自动恢复。 */
const path = require('node:path');
const fs = require('node:fs');
const OUT = path.resolve(__dirname, '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(OUT, '_visibility-api-'));
process.env.DATA_DIR = DATA;
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.LOG_LEVEL = 'warn';
process.env.ALLOW_BROWSER_DEVICES = 'true';
process.env.ACCOUNTS_PER_IP = '0';
process.env.ACCOUNT_DAILY_LIMIT = '0';
process.env.OWNER_IP_ONLY = 'true';

const { start } = require('../server/index.js');
const db = require('../server/db');
const settlement = require('../server/game/settlement');
const visibility = require('../server/game/visibility');
let BASE = '', running;

function cleanup() {
  try { if (running) running.close(); } catch (_) {}
  try { db.close(); } catch (_) {}
  if (path.dirname(DATA) !== OUT || !path.basename(DATA).startsWith('_visibility-api-')) throw new Error('invalid test data path');
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const tokenDevices = new Map();
const qaDevice = (id) => ({ 'x-device-id': id.padEnd(32, '_'), 'x-device-platform': 'browser', 'x-device-provider': 'installation' });
async function call(method, url, body, token, device) {
  const dev = device || tokenDevices.get(token) || {};
  const headers = { 'content-type': 'application/json', ...dev };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + ' ' + (json && json.error ? json.error.code + ':' + json.error.msg : text.slice(0, 160)));
    e.status = res.status; e.body = json; throw e;
  }
  if (json.token && device) tokenDevices.set(json.token, device);
  return json;
}
const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : (extra ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')));
}

async function main() {
  const started = await start(0);
  running = started.server; BASE = 'http://127.0.0.1:' + started.port;
  const A = await call('POST', '/api/register', { name: '隐甲', password: 'pass-a1' }, undefined, qaDevice('vis-a'));
  const B = await call('POST', '/api/register', { name: '隐乙', password: 'pass-b1' }, undefined, qaDevice('vis-b'));
  const C = await call('POST', '/api/register', { name: '隐丙', password: 'pass-c1' }, undefined, qaDevice('vis-c'));
  const aId = Number(A.profile.account.accountId), bId = Number(B.profile.account.accountId), cId = Number(C.profile.account.accountId);
  const store = require('../server/game/store');
  for (const id of [aId, bId, cId]) {
    db.tx(() => store.runOnSave(id, ({ save }) => { save.level = 30; }, { snapshotSource: 'test-visibility' }));
  }
  const stA = await call('GET', '/api/state', undefined, A.token);
  const stB = await call('GET', '/api/state', undefined, B.token);
  const stC = await call('GET', '/api/state', undefined, C.token);
  ok('setup: three level 30 accounts with snapshots', stA.save.level === 30 && stB.save.level === 30 && stC.save.level === 30 && stA.snapshot && stB.snapshot && stC.snapshot);

  const week = settlement.weekKey();
  // 高分 + 至少一场天梯：保证三个人都在人机之上，且满足周奖励的 played>0。
  // 两个隐身号刻意高于 A：A 的榜/领奖若把隐身算进去就会掉到第 3，能钉住「普通玩家不计隐身」。
  db.run('UPDATE ratings SET score = 500, wins = 1 WHERE account_id = ? AND season = ?', aId, week);
  db.run('UPDATE ratings SET score = 600, wins = 1 WHERE account_id IN (?,?) AND season = ?', bId, cId, week);
  const ladderBefore = await call('GET', '/api/ladder?limit=200', undefined, A.token);
  const bBefore = ladderBefore.top.find((x) => Number(x.accountId) === bId);
  const rankBefore = settlement.rankOf(bId);
  ok('before hide: B is in A ladder and has a rank', !!bBefore && rankBefore > 0, { rankBefore });

  visibility.setHidden([bId, cId], Date.now() + 86400000, 'test visibility');

  const ladderA = await call('GET', '/api/ladder?limit=200', undefined, A.token);
  const ladderB = await call('GET', '/api/ladder?limit=200', undefined, B.token);
  ok('hidden: B/C absent from A ladder top', !ladderA.top.some((x) => Number(x.accountId) === bId || Number(x.accountId) === cId));
  ok('hidden: B own ladder includes hidden C and keeps a real rank', ladderB.hidden === true
    && ladderB.me.hidden === true && ladderB.me.rank === 1 && ladderB.me.score === 600
    && ladderB.top.some((x) => Number(x.accountId) === cId));
  ok('hidden: settlement.rankOf(B) matches inclusive ladder rank', settlement.rankOf(bId) === 1
    && settlement.rankOf(bId) === ladderB.me.rank);
  const awardB = settlement.rankAwardStatus(bId);
  ok('hidden: B is eligible for the weekly top-30 award', awardB.hidden === true && awardB.eligible === true
    && awardB.rank > 0 && awardB.rank <= 30 && awardB.surpassedBot === true, awardB);
  // 普通玩家 A 的榜/领奖排名不计隐身 B/C：A 仍是第 1。
  const awardA = settlement.rankAwardStatus(aId);
  ok('normal: A rank/award ignores hidden B/C', awardA.rank === 1 && awardA.eligible === true
    && settlement.rankOf(aId) === 1, awardA);
  const bBeforeClaim = await call('GET', '/api/state', undefined, B.token);
  const bClaim = await call('POST', '/api/ladder/award', {}, B.token);
  const bAfterClaim = await call('GET', '/api/state', undefined, B.token);
  ok('hidden: B can claim the weekly top-30 award', bClaim.ok === true && Number(bClaim.cups) === 50
    && Number(bClaim.rank) === awardB.rank
    && bAfterClaim.save.goldCup === bBeforeClaim.save.goldCup + 50
    && bClaim.award && bClaim.award.claimed === true, { bClaim, before: bBeforeClaim.save.goldCup, after: bAfterClaim.save.goldCup });
  const aClaim = await call('POST', '/api/ladder/award', {}, A.token);
  ok('normal: A can claim with hidden players excluded from its rank', aClaim.ok === true
    && Number(aClaim.rank) === 1 && Number(aClaim.cups) === 50, aClaim);

  /* 固定随机流取池头真人：隐身者 B 的池里应有 A 和 C 两个真人。 */
  async function opponentsAt(who, value) {
    const saved = Math.random;
    try { Math.random = () => value; return await call('GET', '/api/opponents', undefined, who); }
    finally { Math.random = saved; }
  }
  const rankOpp = await opponentsAt(A.token, 0.000001);
  const bOpp = await opponentsAt(B.token, 0.000001);
  ok('hidden: B rank pool still includes visible A and hidden C', bOpp.ok === true
    && bOpp.match.poolReal === 2 && bOpp.match.poolBots === 30
    && bOpp.opponents.length === 1
    && bOpp.opponents.every((x) => Number(x.accountId) !== bId));
  ok('hidden: B absent from A rank candidates', !rankOpp.opponents.some((x) => Number(x.accountId) === bId));
  const randomRows = require('../server/game/opponents').randomPlayers(aId, 30, []);
  ok('hidden: B absent from randomPlayers pool', !randomRows.some((x) => Number(x.accountId) === bId));

  const bOffer = bOpp.opponents.find((x) => Number(x.accountId) === aId);
  ok('hidden: hidden B can see visible A as a rank opponent', !!bOffer);
  if (bOffer) {
    const bState = await call('GET', '/api/state', undefined, B.token);
    const rankFight = await call('POST', '/api/battle', {
      kind: 'rank', snapshotId: bOffer.snapshotId, rev: bState.rev, idemKey: 'vis-hidden-rank',
    }, B.token);
    const aMsgs = await call('GET', '/api/messages', undefined, A.token);
    const leaked = aMsgs.messages.filter((m) => m.from && Number(m.from.accountId) === bId && /^rank_/.test(m.kind));
    ok('hidden: B rank attack leaves no defense report for A', rankFight.ok === true && leaked.length === 0);
    const revenge = require('../server/game/fight').revengeInfoFor(aId, rankFight.combatId);
    ok('hidden: B rank attack is not revengeable by A', revenge === null);
  }

  let direct = null;
  try { direct = await call('GET', '/api/fighter?snapshotId=' + encodeURIComponent(stB.snapshot.id), undefined, A.token); } catch (e) { direct = e; }
  let byAccount = null;
  try { byAccount = await call('GET', '/api/fighter?accountId=' + bId, undefined, A.token); } catch (e) { byAccount = e; }
  ok('hidden: direct snapshot/account fighter view stays available for social play',
    direct && direct.ok === true && Number(direct.accountId) === bId
    && byAccount && byAccount.ok === true && Number(byAccount.accountId) === bId);

  const search = await call('GET', '/api/players?q=' + encodeURIComponent('隐乙'), undefined, A.token);
  ok('hidden: player search finds hidden B', Array.isArray(search.results) && search.results.some((x) => Number(x.accountId) === bId));
  const searchCByB = await call('GET', '/api/players?q=' + encodeURIComponent('隐丙'), undefined, B.token);
  const searchCByA = await call('GET', '/api/players?q=' + encodeURIComponent('隐丙'), undefined, A.token);
  ok('hidden: hidden B and visible A can both search hidden C', searchCByB.results.some((x) => Number(x.accountId) === cId)
    && searchCByA.results.some((x) => Number(x.accountId) === cId));

  const addB = await call('POST', '/api/friends', { accountId: bId }, A.token);
  const reqB = await call('GET', '/api/friends/requests', undefined, B.token);
  ok('hidden: A can send B a friend request and B sees it',
    addB.ok === true && addB.pending === true && reqB.requests.some((x) => Number(x.accountId) === aId));
  const addA = await call('POST', '/api/friends', { accountId: aId }, B.token);
  ok('hidden: B can accept/add A back', addA.ok === true && addA.accepted === true);
  await call('POST', '/api/friends', { accountId: aId }, C.token);
  const reqA = await call('GET', '/api/friends/requests', undefined, A.token);
  ok('hidden: hidden C friend request is visible to A', reqA.requests.some((x) => Number(x.accountId) === cId));
  const apprA = await call('GET', '/api/apprentice/candidates', undefined, A.token);
  ok('hidden: B appears in apprentice recruit candidates', apprA.prentices.some((x) => Number(x.accountId) === bId));

  db.tx(() => {
    db.run('INSERT OR IGNORE INTO friendships(account_id,friend_id,created_at) VALUES (?,?,?)', aId, bId, Date.now());
    db.run('INSERT OR IGNORE INTO friendships(account_id,friend_id,created_at) VALUES (?,?,?)', bId, aId, Date.now());
    db.run('INSERT OR IGNORE INTO friendships(account_id,friend_id,created_at) VALUES (?,?,?)', bId, cId, Date.now());
    db.run('INSERT OR IGNORE INTO friendships(account_id,friend_id,created_at) VALUES (?,?,?)', cId, bId, Date.now());
  });
  const friendsA = await call('GET', '/api/friends', undefined, A.token);
  const friendsB = await call('GET', '/api/friends', undefined, B.token);
  ok('hidden: A sees hidden B in friends; hidden B still sees A and hidden C',
    friendsA.friends.some((x) => Number(x.accountId) === bId)
    && friendsB.friends.some((x) => Number(x.accountId) === aId)
    && friendsB.friends.some((x) => Number(x.accountId) === cId));
  const friendSpar = await call('POST', '/api/battle', {
    kind: 'friend', snapshotId: stB.snapshot.id,
    rev: (await call('GET', '/api/state', undefined, A.token)).rev, idemKey: 'vis-hidden-friend-spar',
  }, A.token);
  ok('hidden: friend spar with hidden B still works', friendSpar.ok === true);

  // 存档与天梯分数不受隐身影响
  const stB2 = await call('GET', '/api/state', undefined, B.token);
  ok('hidden: B level untouched by hiding and rank attack', stB2.save.level === 30);
  const stA2 = await call('GET', '/api/state', undefined, A.token);
  ok('hidden: A unaffected', stA2.save.level === 30 && stA2.hidden === false);

  // 到期恢复
  db.run('UPDATE hidden_accounts SET hidden_until=? WHERE account_id=?', Date.now() - 1, bId);
  const ladderAfter = await call('GET', '/api/ladder?limit=200', undefined, A.token);
  const bAfter = ladderAfter.top.find((x) => Number(x.accountId) === bId);
  const ladderBAfter = await call('GET', '/api/ladder?limit=200', undefined, B.token);
  ok('expired: B reappears in ladder and rank', !!bAfter && settlement.rankOf(bId) > 0 && ladderBAfter.hidden === false && ladderBAfter.me.rank > 0);
  const fighterAfter = await call('GET', '/api/fighter?snapshotId=' + encodeURIComponent(stB.snapshot.id), undefined, A.token);
  ok('expired: direct snapshot view still works', fighterAfter.ok === true && Number(fighterAfter.accountId) === bId);

  const failed = results.filter((x) => !x.pass);
  console.log('');
  console.log('visibility test: ' + (results.length - failed.length) + '/' + results.length + ' PASS');
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; }).finally(cleanup);
