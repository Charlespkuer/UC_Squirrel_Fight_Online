#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
// One installed-client session lifecycle: package API, persistence, expiry, and bounded reads.
(async()=>{
  const memory=new Map(),calls=[],timers=new Map();
  let serial=0,reply;
  const c={URL,AbortController,Promise,console,
    __TAURI_INTERNALS__:{invoke:async()=>({id:'a'.repeat(64),platform:'windows',provider:'machine-guid'})},
    __SSDZ_ONLINE_API__:'http://140.143.142.110:5896',
    location:{protocol:'http:',origin:'http://tauri.localhost',host:'tauri.localhost'},
    localStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},
    setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,opts)=>{calls.push({url,opts});return reply(opts);},
  };
  c.window=c;vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/net.js'),'utf8'),c);
  const N=c.Net;
  assert.equal(N.base(),'http://140.143.142.110:5896','installed assets must not send API calls to tauri.localhost');
  N.configure({token:'test-session'});N.setAccount({name:'QA'});
  reply=()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,serverTime:1})});
  await N.health();
  assert.equal(calls[0].url,'http://140.143.142.110:5896/api/health');
  assert.equal(calls[0].opts.headers.authorization,undefined,'health is public');
  reply=()=>({ok:false,status:401,text:async()=>JSON.stringify({ok:false,error:{code:'AUTH',msg:'expired'}})});
  await assert.rejects(N.get('/api/profile'),e=>e.code==='AUTH');
  assert.equal(calls.at(-1).opts.headers['x-device-id'],'a'.repeat(64));
  assert.equal(calls.at(-1).opts.headers['x-device-platform'],'windows');
  assert.equal(calls.at(-1).opts.headers['x-device-provider'],'machine-guid');
  assert.equal(N.token(),'');assert.equal(N.account(),null,'expired credentials must be cleared without a ReferenceError');
  N.setToken('another-session');N.configure({base:'https://example.com'});
  assert.equal(N.token(),'','a new server must not receive the old server token');
  assert.throws(()=>N.configure({base:'https://user:password@example.com'}));
  reply=()=>({ok:true,status:200,text:async()=>'<html>not an API</html>'});
  await assert.rejects(N.meta(),e=>e.code==='PROTOCOL');
  reply=opts=>({ok:true,status:200,text:()=>new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  const pending=N.meta();
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(timers.size,1,'body read must still have a deadline');
  for(const fn of [...timers.values()])fn();
  await assert.rejects(pending,e=>e.code==='NETWORK');
  reply=()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true})});
  await N.health();
  const failedDevice={...c,__TAURI_INTERNALS__:{invoke:async()=>{throw Error('device bridge failed');}}};
  failedDevice.window=failedDevice;vm.createContext(failedDevice);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/net.js'),'utf8'),failedDevice);
  await assert.rejects(failedDevice.Net.deviceIdentity(),e=>e.code==='DEVICE_UNAVAILABLE');
  assert.equal(memory.has('ssdz-online-browser-device'),false,'native identity failure must not generate a disposable browser identity');
  /* Polling reads pass `parallel`: a slow queued request must not delay the badge/update read. */
  const pendingReplies=[];
  reply=()=>new Promise((resolve)=>pendingReplies.push(resolve));
  const busy=N.get('/api/profile');
  for(let i=0;i<6;i++)await Promise.resolve();
  const before=calls.length;
  const parallel=N.get('/api/messages/badge',{parallel:true});
  for(let i=0;i<6;i++)await Promise.resolve();
  assert.equal(calls.length,before+1,'parallel read must reach fetch while another request is still in flight');
  assert.equal(calls.at(-1).url.endsWith('/api/messages/badge'),true,'parallel read reached fetch out of the queue');
  for(const done of pendingReplies)done({ok:true,status:200,text:async()=>JSON.stringify({ok:true})});
  await Promise.all([busy,parallel]);
  console.log('PASS installed client API/session lifecycle, expired login, response-body deadline and parallel polling');

  // Device preferences and a battle-retry save must survive authority resync,
  // while logout/expiration actually detach the previous account.
  const prefs=new Map(),events=new Map();
  let save=null,token='',cancelled=0,loginShown=0;
  const authoritative={name:'QA',settings:{volume:1,muted:false,showSkip:true}};
  const mirror={console,Promise,
    localStorage:{getItem:k=>prefs.get(k)||null,setItem:(k,v)=>prefs.set(k,String(v))},
    addEventListener:(name,fn)=>events.set(name,fn),
    State:{state:()=>save,restorePayload:s=>{save=JSON.parse(JSON.stringify(s));return true;},
      setSettings:p=>Object.assign(save.settings,p), setTutorialStep:n=>{save.tutorial={step:n};return true;},save(){}},
    SfFight:{cancelOnlineChest:()=>cancelled++},
    OnlineUI:{showLogin:()=>loginShown++},
    Net:{discover:async()=>{},meta:async()=>({ok:true,actions:{setSettings:{mode:'local'},setTutorialStep:{mode:'sync'}}}),
      get:async p=>p==='/api/state'?{ok:true,rev:1,save:authoritative}:null,
      post:async p=>p==='/api/login'?{ok:true,token:'session',profile:{account:{name:'QA'}}}:
        p==='/api/battle'?{ok:true,rev:3,save:{...authoritative,goldPoint:17}}:
        p==='/api/action'?{ok:true,rev:3,patch:{set:{tutorial:{step:2}}}}:{ok:true},
      setToken:t=>token=t,setAccount(){},clearSession:()=>token=''},
  };
  mirror.window=mirror;vm.createContext(mirror);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online.js'),'utf8'),mirror);
  const O=mirror.Online;
  await O.login('QA','local-test');
  mirror.State.setSettings({volume:.4,muted:true,showSkip:false,backgroundRun:true,uiMode:'modern'});
  await O.syncState();
  assert.equal(save.settings.showSkip,false);assert.equal(save.settings.volume,.4);assert.equal(save.settings.backgroundRun,true);assert.equal(save.settings.uiMode,'classic');
  await O.post('/api/battle',{rev:1});
  assert.equal(O.rev,3);assert.equal(save.goldPoint,17,'a lost battle reply can be recovered from its authoritative retry save');
  assert.equal(save.settings.showSkip,false);
  /* 连点保护：固定开启、没有设置开关；同参数 250ms 内只上行一次。 */
  let actionPosts = 0;
  const actionPost = mirror.Net.post;
  mirror.Net.post = async (p, body, ...rest) => {
    if (p === '/api/action') actionPosts++;
    return actionPost(p, body, ...rest);
  };
  assert.equal(O.antiClick, undefined, '连点保护不再是可以关闭的本机偏好');
  await Promise.all([mirror.StateCall('setTutorialStep', 2), mirror.StateCall('setTutorialStep', 2)]);
  assert.equal(actionPosts, 1, '连点保护：0.25s 内同参数重复点击只上行一次');
  await Promise.all([mirror.StateCall('setTutorialStep', 2), mirror.StateCall('setTutorialStep', 2)]);
  assert.equal(actionPosts, 1, '没有开关可关：再点同参数仍然不上行');
  const directBefore = actionPosts;
  mirror.State.setTutorialStep(4);
  mirror.State.setTutorialStep(4);
  await O.post('/api/noop', {});
  assert.equal(actionPosts, directBefore + 1, '直接调 State 同步动作也受连点保护');
  mirror.Net.post = actionPost;
  const beforeChest=save;
  await O.post('/api/battle',{rev:3},{preserveMirror:true});
  assert.equal(save,beforeChest,'claiming a chest must not replace the running battle save');
  mirror.State.setTutorialStep(2);
  await O.post('/api/noop', {});
  assert.equal(save,beforeChest,'tutorial progress must not replace the active battle save');
  assert.equal(save.tutorial.step,2);
  assert.equal(save.settings.showSkip,false);
  await O.logout();
  assert.equal(O.ready,false);assert.equal(O.rev,0);assert.equal(token,'');assert.equal(cancelled,1);
  await O.login('QA','local-test');
  events.get('ssdz-online-session-expired')();
  assert.equal(O.ready,false);assert.equal(token,'');assert.equal(loginShown,1);
  await O.login('QA','local-test');
  console.log('PASS account/device lifecycle: settings resync, battle recovery, logout and session expiry');

  // A sync action's own patch is not a divergence: only a result mismatch may force /api/state.
  let stateGets = 0;
  const netGet = mirror.Net.get, netPost = mirror.Net.post;
  mirror.Net.get = async (p, ...rest) => { if (p === '/api/state') stateGets++; return netGet(p, ...rest); };
  mirror.Net.post = async (p, body, ...rest) => p === '/api/action'
    ? { ok: true, rev: 4, result: { ok: true }, patch: { set: { goldPoint: 5 } }, summary: {}, daily: {} }
    : netPost(p, body, ...rest);
  O.predict('buyProp', [1], { ok: true });
  await O.post('/api/noop', {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stateGets, 0, 'sync action patch must not trigger a full state resync');
  assert.equal(save.goldPoint, 5, 'the authoritative patch still lands');

  mirror.Net.post = async (p, body, ...rest) => p === '/api/action'
    ? { ok: true, rev: 5, result: { ok: false }, patch: { set: { goldPoint: 1 } }, summary: {}, daily: {} }
    : netPost(p, body, ...rest);
  O.predict('buyProp', [1], { ok: true });
  await O.post('/api/noop', {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stateGets, 1, 'divergent sync result must resync');
  console.log('PASS sync patch is applied without a full resync; real divergence still resyncs');

  /* 被动消息红点：主界面 NEW 读 `Online.badge`；打开消息页才清零，主动动作不碰它。 */
  const restoreGet = mirror.Net.get, restorePost = mirror.Net.post;
  mirror.Net.get = async (p, ...rest) => p === '/api/messages/badge'
    ? { ok: true, unread: 2, requests: 1, total: 3 } : restoreGet(p, ...rest);
  mirror.Net.post = async (p, body, ...rest) => p === '/api/messages/seen'
    ? { ok: true, unread: 0, requests: 0, total: 0 } : restorePost(p, body, ...rest);
  await O.refreshBadge();
  assert.equal(O.badge.total, 3, '被动消息计数进入 Online.badge');
  await O.markMessagesSeen();
  assert.equal(O.badge.total, 0, '打开消息页后红点立即清零');
  mirror.Net.get = restoreGet; mirror.Net.post = restorePost;
  console.log('PASS passive message badge drives NEW and clears only when the message page opens');

  // Replay must use the battle snapshots returned by the server, including boss and gear.
  let played;
  const localMemory=new Map();
  const replay={console,Promise,document:{},setTimeout,clearTimeout,
    localStorage:{getItem:k=>localMemory.get(k)||null,setItem:(k,v)=>localMemory.set(k,String(v)),removeItem:k=>localMemory.delete(k)},
    Net:{account:()=>({accountId:1})},
    Online:{ready:true,get:async()=>({result:{winner:0,names:['甲','首领'],maxHp:[100,500],rounds:[{attacker:0}]},
      me:{name:'甲',level:35,gears:[{id:123}]},foe:{name:'首领',level:40,campaign:{bossId:2}}}),toast(){},emit(){}},
    Main:{startBattle:async(foe,opts)=>{played={foe,me:opts.me};opts.onEnd(0);}},
  };
  replay.window=replay;vm.createContext(replay);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online-battle.js'),'utf8'),replay);
  await replay.Online.battle.replay('c_test');
  assert.equal(played.me.level,35);assert.equal(played.me.gears[0].id,123);
  assert.equal(played.foe.level,40);assert.equal(played.foe.campaign.bossId,2);
  console.log('PASS replay uses authoritative fighter snapshots');
  // 普通战斗服务端只留 60 分钟；断线/过期后必须能从客户端本地缓存回放。
  played=null;
  localMemory.set('ssdz-online-local-battles:1',JSON.stringify([{combatId:'c_local',kind:'random',
    result:{winner:0,names:['本地甲','本地乙'],maxHp:[1,1],rounds:[{attacker:0}]},
    me:{name:'本地甲',level:2},foe:{name:'本地乙',level:3},settlement:null,opponent:null}]));
  replay.Online.get=async()=>{const e=Error('gone');e.code='NOT_FOUND';throw e;};
  await replay.Online.battle.replay('c_local');
  assert.equal(played.me.name,'本地甲');assert.equal(played.foe.name,'本地乙');
  console.log('PASS ordinary replay falls back to local cache after server retention');
  replay.Online.rev=1;replay.Online.post=async()=>({me:{name:'甲'},foe:{name:'乙'},result:{winner:0,rounds:[{attacker:0}]},stage:{settle:{win:true}}});
  let afterCancel=0;replay.Online.toast=()=>afterCancel++;replay.Online.emit=()=>afterCancel++;
  replay.Main.startBattle=async(_foe,opts)=>opts.onCancel();
  await replay.Online.battle.stage(1);
  assert.equal(afterCancel,0,'canceled battle must not display or emit a result');
  console.log('PASS canceled continuation battle releases its flow');

  /* 关卡胜利的战果页必须盖在挑战页上：先 resumePageAfterBattle，再 SfFightResult.open。
   * 少了这一步 `#ui` 在战斗页撤掉后是空的，弹窗背景会露出 canvas 最后一帧（启动加载 95%）。 */
  const order=[];
  let resumed=null, resultSpec=null;
  replay.SfChallenge={
    holdPageForBattle:()=>({host:{}}),
    resumePageAfterBattle:(_hold,tab,opts)=>{order.push('resume');resumed={tab,opts};return true;},
  };
  replay.SfFightResult={open:async(spec)=>{order.push('result');resultSpec=spec;return {};}};
  replay.UI={currentUiMode:()=>'classic',classic:{}};
  replay.Online.ready=true;replay.Online.rev=1;
  replay.Online.post=async()=>({me:{name:'甲'},foe:{name:'乙'},result:{winner:0,rounds:[{attacker:0}]},
    stage:{settle:{win:true,exp:3},npc:{name:'1星螳螂学徒'}}});
  replay.Main.startBattle=async(_foe,opts)=>{opts.onEnd(0);};
  await replay.Online.battle.stage(7);
  assert.deepEqual(order,['resume','result'],'战果页之前要先把挑战页放回背景');
  assert.equal(resumed.tab,'gates');
  assert.equal(resumed.opts.keepSub,true);
  assert.equal(resultSpec.actions.map((a)=>a.label).join(','),'确定,继续挑战','关卡胜利页：确定在左、继续挑战在右');
  console.log('PASS stage result opens over the restored challenge page');

  /* 复活次数用完 / 挑战书不足：服务端 CONFLICT 不能只 toast（经典确认页只有战斗/返回，
   * 玩家会永远卡在这一轮）；必须弹「结束本轮」。 */
  replay.Online.errText=(e)=>String((e&&e.message)||e);
  const blocked=[];
  let abandoned=null;
  replay.State={stageRun:()=>({needsRevive:true,revives:2}),abandonStageRun:(id)=>{abandoned=id;}};
  replay.SfFightResult={open:async(spec)=>{blocked.push(spec);return {};}};
  replay.SfChallenge={holdPageForBattle:()=>({host:{}}),resumePageAfterBattle:()=>true,refreshGateAt:()=>{},openGateAt:()=>{}};
  const conflict=Object.assign(new Error('本轮已用完2次复活机会，请结束本轮后重新挑战。'),{
    code:'CONFLICT',body:{error:{code:'CONFLICT',msg:'本轮已用完2次复活机会，请结束本轮后重新挑战。',extra:{}}}});
  replay.Online.post=async()=>{throw conflict;};
  await replay.Online.battle.stage(7);
  assert.equal(blocked.length,1,'拒绝时要弹结果面板而不是只 toast');
  assert.ok(blocked[0].actions.some((a)=>a.label==='结束本轮'),'要有结束本轮');
  blocked[0].actions.find((a)=>a.label==='结束本轮').run();
  assert.equal(abandoned,7,'结束本轮要真的清掉这一轮');
  console.log('PASS stage conflict offers abandon-run exit');

  /* 开打前被服务端拒（挑战书不足）不是「打完一场」：不能按战后语义重挂页签，
   * 也不能拿全屏战果页把关卡页整块盖住（部分安卓上会看成页面卡没）。 */
  let failedResume=0,battleResume=0,bookNotice=null;
  replay.UI.classic.notice=(msg,actions)=>{bookNotice={msg,actions};};
  replay.SfChallenge={
    holdPageForBattle:()=>({host:{}}),
    resumePageAfterFailedRequest:()=>{failedResume++;return true;},
    resumePageAfterBattle:()=>{battleResume++;return true;},
    refreshGateAt:()=>{},openGateAt:()=>{},
  };
  replay.SfFightResult={open:async()=>{throw new Error('pre-battle rejection must not open the full-screen result');}};
  replay.State={stageRun:()=>null,abandonStageRun:()=>{}};
  const noBook=Object.assign(new Error('挑战书不足，快去商店中购买吧！'),{
    code:'CONFLICT',body:{error:{code:'CONFLICT',msg:'挑战书不足，快去商店中购买吧！',extra:{needsBook:true}}}});
  replay.Online.post=async()=>{throw noBook;};
  await replay.Online.battle.stage(7);
  assert.equal(failedResume,1,'开打前被拒只放回按住页');
  assert.equal(battleResume,0,'不能按战后语义重挂页签');
  assert.ok(bookNotice&&bookNotice.actions.some((a)=>a.label==='购买挑战书'),'要用小提示给购买挑战书出口');
  console.log('PASS pre-battle stage rejection restores the held page and keeps it behind a small notice');

  /* 战败且复活次数用完：结果页也不能再给「复活再战」。 */
  let lossSpec=null;
  replay.SfFightResult={open:async(spec)=>{lossSpec=spec;return {};}};
  replay.Online.post=async()=>({me:{name:'甲'},foe:{name:'乙'},result:{winner:1,rounds:[{attacker:1}]},
    stage:{settle:{win:false,run:{revives:2}},npc:{name:'1星螳螂学徒'}}});
  replay.Main.startBattle=async(_foe,opts)=>{opts.onEnd(1);};
  await replay.Online.battle.stage(7);
  assert.ok(lossSpec&&lossSpec.actions.some((a)=>a.label==='结束本轮'),'复活用完要给结束本轮');
  assert.ok(!lossSpec.actions.some((a)=>a.label==='复活再战'),'复活用完不能再给复活再战');
  console.log('PASS stage loss with no revives left offers abandon-run');

  /* 竞技场每场都要先摆**原版战果页**（经验 + 战斗中悬浮奖品三格），再回竞技场面板。
   * 以前没传 `resultInBattle`（`skipResultPanel` 为真），那张战果页刚画出来就被竞技场
   * 面板盖掉 —— 用户 2026-11 报的「联机竞技场战斗后完全没有收益提示」。
   * 半决赛没有经验，`rewardFor` 必须回 null（否则原版 `maxlevel` 会停在烤死的经验文案上）。 */
  let arenaOpts=null,arenaSpec=null;
  replay.SfChallenge={holdPageForBattle:()=>({host:{}}),resumePageAfterBattle:()=>true};
  replay.SfFightResult={open:async(spec)=>{arenaSpec=spec;return {};}};
  replay.UI={currentUiMode:()=>'classic',classic:{}};
  replay.Online.ready=true;replay.Online.rev=1;
  const arenaFight=async(rewards)=>{
    arenaOpts=null;arenaSpec=null;
    replay.Online.post=async()=>({me:{name:'甲'},foe:{name:'乙'},result:{winner:0,rounds:[{attacker:0}]},pickups:[],
      arena:{win:true,kind:0,rewards}});
    replay.Main.startBattle=async(_foe,opts)=>{arenaOpts=opts;opts.onEnd(0);};
    await replay.Online.battle.arenaFight({target:{arenaPage:'rules'}});
  };
  await arenaFight({phase:'semi',next:'final',win:true,gem:null});
  assert.equal(arenaOpts.skipResultPanel,false,'竞技场每场都要摆原版战果页');
  assert.equal(arenaOpts.rewardFor(),null,'没有经验的场次不要给 rewardFor（避免烤死的经验文案）');
  assert.equal(arenaOpts.resultNote,'','半决赛没有名次奖励，不写奖励行');
  assert.equal(arenaSpec.kind,'arena','竞技场续战面板仍是 arena 容器');
  assert.equal(arenaSpec.player && arenaSpec.player.name,'甲','竞技战果左侧要填本人');
  assert.equal(arenaSpec.foe && arenaSpec.foe.name,'乙','竞技战果右侧要填对手');
  assert.equal(arenaSpec.arenaSubtitle,'','半决赛沿用原版「进入下一轮…」副标题');
  await arenaFight({phase:'final',position:0,win:true,exp:150,ups:[],shards:0,hatch:0,gem:null,buffNote:'',title:'冠军'});
  assert.equal(JSON.stringify(arenaOpts.rewardFor()),JSON.stringify({exp:150,gold:0,ups:[]}),'决赛经验要进原版战果页');
  assert.equal(arenaOpts.resultNote,'','经验场已经有经验数字，不重复写文字');
  assert.equal(arenaSpec.arenaSubtitle,'获得冠军','决赛冠军不能再写「进入下一轮」');
  assert.ok(/经验 \+150/.test(arenaSpec.text) && !/获得冠军/.test(arenaSpec.text),'名次进副标题，正文不重复');
  /* 碎片 / 幻兽竞技场没有经验格：战果页用一行文字写名次奖励（用户 2026-11）。 */
  await arenaFight({phase:'final',position:0,win:true,exp:0,ups:[],shards:8,hatch:0,gem:null,buffNote:'',title:'冠军'});
  assert.equal(arenaOpts.resultNote,'蓝色碎片 +8','碎片竞技场要在战果页写清奖励');
  await arenaFight({phase:'final',position:1,win:false,exp:0,ups:[],shards:0,hatch:40,gem:null,buffNote:'',title:'亚军'});
  assert.equal(arenaOpts.resultNote,'孵化点 +40','幻兽竞技场要在战果页写清奖励');
  const fightSrc=fs.readFileSync(path.join(__dirname,'../js/ssfight/ui-fight.js'),'utf8');
  assert.ok(/const note = String\(o\.resultNote \|\| ''\)\.trim\(\)/.test(fightSrc) && /sf-result-note/.test(fightSrc),
    'SfFight 战果页要真的画出 resultNote');
  const challengeSrc=fs.readFileSync(path.join(__dirname,'../js/ssfight/ui-challenge.js'),'utf8');
  const extrasSrc=fs.readFileSync(path.join(__dirname,'../js/classic-extras.js'),'utf8');
  assert.ok(!/text:\s*'本轮进度/.test(challengeSrc)&&!/第二战无需再消耗体力/.test(extrasSrc),
    '竞技对局弹窗不再写「本轮进度已保留 / 第二场不扣体力」');
  console.log('PASS arena battles show the original result page with exp, floating prizes and shard/hatch notes');

  // Campaign cards are renderer MovieClips; their confirmation owns the campaign page.
  const mkClip=(frames=1)=>({g:{style:{},isConnected:true},frame:0,frames,playing:true,
    gotoAndStop(n){this.frame=Math.max(0,(n|0)-1);this.playing=false;},
    byName(){return null;},byNameDeep(){return null;},frameCount(){return this.frames;}});
  const cards=Array.from({length:5},()=>mkClip(3)), main=mkClip(2), host={isConnected:true,style:{}};
  main.byName=n=>/^boss[1-5]$/.test(n)?cards[Number(n.slice(-1))-1]:null;
  const view=mkClip(5), controls={main_mc:main,left:mkClip(3),right:mkClip(3),button1:mkClip(2),button2:mkClip(2),back:mkClip(2)};
  view.byName=n=>controls[n]||null;
  const root={innerHTML:'',querySelector:()=>host};let confirm,freezes=0;
  const campaign={console,Promise,document:{getElementById:()=>root,querySelector:()=>host},
    Online:{ready:true,get:async()=>({bosses:[{name:'狡兔',level:35,unlockLevel:35,bossId:1,unlocked:true,enoughTicket:true}],records:[]}),toast(){}},
    UI:{currentUiMode:()=> 'classic',classic:{}},
    SfChallenge:{openOriginalConfirm:async o=>{confirm=o;return {}; }},
    SfUiMain:{toolkit:{freezeDescendants(){freezes++;},addHitArea(){}}},
    SfRender:{loadExtra:async()=>{},mountSymbol:async()=>view},
  };
  campaign.window=campaign;vm.createContext(campaign);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online-ui.js'),'utf8'),campaign);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online-campaign.js'),'utf8'),campaign);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online-social.js'),'utf8'),campaign);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/online-settings.js'),'utf8'),campaign);
  assert.equal(await campaign.OnlineUI.campaignPage(),true);
  assert.ok(freezes>0,'征战页必须套静态策略，否则多帧 UI 会一直自播频闪');
  assert.equal(typeof cards[0].g.onclick,'function');
  controls.right.g.onclick();
  assert.equal(main.frame,1,'右箭头必须切到第 2 页');
  assert.equal(controls.left.g.style.visibility,'visible');
  assert.equal(controls.right.g.style.visibility,'hidden');
  controls.left.g.onclick();
  assert.equal(main.frame,0,'左箭头必须回第 1 页');
  assert.equal(controls.left.g.style.visibility,'hidden');
  assert.equal(controls.right.g.style.visibility,'visible');
  controls.button1.g.onclick();
  assert.equal(view.frame,3,'战绩页是容器第 4 帧');
  controls.back.g.onclick();
  assert.equal(view.frame,0,'战绩页返回键必须回主页面');
  assert.equal(main.frame,0);
  cards[0].g.onclick();
  assert.equal(confirm.owner,host);assert.match(confirm.text,/狡兔/);
  console.log('PASS campaign page freezes multi-frame UI and its arrows/records/back work');

  /* 征战结果只有一颗确定键：用户 2026-11 截图口径要放大并下移。 */
  const uiStyleSrc = fs.readFileSync(path.join(__dirname, '../js/online-ui.js'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '../js/online-campaign.js'), 'utf8');
  const onlineCss = fs.readFileSync(path.join(__dirname, '../css/online.css'), 'utf8');
  assert.ok(/campaign-result-dialog/.test(uiStyleSrc)
    && /\.campaign-result-dialog \.modal-buttons\s*\{[^}]*margin-top:\s*44px/.test(onlineCss)
    && /min-width:\s*300px/.test(onlineCss) && /min-height:\s*88px/.test(onlineCss),
    '征战结果的确定键要放大并下移');
  console.log('PASS campaign result confirm button is enlarged and lowered');

  /* 天梯按原版自动匹配：客户端不能再有「选择对手」页。 */
  const uiSrc=['online-ui','online-campaign','online-social','online-settings']
    .map(f=>fs.readFileSync(path.join(__dirname,'../js/'+f+'.js'),'utf8')).join('\n');
  const ceSrc=fs.readFileSync(path.join(__dirname,'../js/classic-extras.js'),'utf8');
  assert.ok(/async function autoMatch/.test(uiSrc) && !/pickOpponent/.test(uiSrc)
    && /OnlineUI\.autoMatch/.test(ceSrc) && !/pickOpponent/.test(ceSrc));
  console.log('PASS 天梯自动匹配：没有「选择对手」页');
  /* 随机/天梯真人对手的「查看」要按抽到的那颗快照取，不能按 accountId 取实时存档：
     否则面板显示对方当前属性，连这一场的战斗对象也会被换成最新快照。 */
  assert.ok(/freshOnlineFoe\(foe, \{ frozen: tab !== 'friends' \}\)/.test(challengeSrc)
    && /\/api\/fighter\?snapshotId=/.test(challengeSrc)
    && /const target = foe && \(foe\.snapshotRef \|\| foe\.snapshotId\)/.test(challengeSrc)
    && /out\.snapshotRef/.test(challengeSrc)
    && !/freshOnlineFoe\(foe\)/.test(challengeSrc),
    '随机页「查看」按 snapshotId 取快照；开战优先用原始快照号，offer 过期/重启后仍能打');
  console.log('PASS 随机页「查看」取快照而不是实时存档');
  const masterBattleSrc = fs.readFileSync(path.join(__dirname, '../js/online-battle.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/async function refreshMasterLevel/.test(masterBattleSrc)
    && /\/api\/apprentice\/refresh/.test(masterBattleSrc)
    && /await refreshMasterLevel\(\)/.test(masterBattleSrc),
    '拥有师父驾到的玩家进战斗前要先请求服务端刷新师父等级');
  console.log('PASS 师父驾到：进战斗前请求服务端刷新师父等级');
  /* 游戏内不再提供任何拜师入口：设置页、活动页、好友页与好友动作菜单全部移除。 */
  const classicUiSrc = fs.readFileSync(path.join(__dirname, '../js/classic-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/button\('拜师', 'master'\)/.test(uiSrc)
    && !/bind\('master',/.test(uiSrc)
    && !/ClassicExtras\.master/.test(classicUiSrc)
    && !/master:\(\)=>fallback\('master'\)/.test(classicUiSrc)
    && !/sf-friends-master|sf-master-btn|askMaster/.test(challengeSrc)
    && !/activityButton\(noTribute && noMaster \? '拜师'/.test(classicUiSrc),
    '游戏内不再提供任何拜师入口');
  console.log('PASS 拜师入口已全部移除');
  assert.ok(/function claimTribute\(after, opts\)[\s\S]*?showLevelUps/.test(ceSrc)
    && /function showLevelUps\(ups, onDone\)/.test(classicUiSrc),
    '领取徒弟日供升级时必须走公共升级弹窗，不能只弹日供结算卡');
  console.log('PASS 徒弟日供升级走公共升级弹窗');
  /* 天梯战果必须用 3776 的 rank 容器；误用 arena 会在失败时显示「争夺季军」。 */
  const battleSrc=fs.readFileSync(path.join(__dirname,'../js/online-battle.js'),'utf8');
  assert.ok(/kind: 'rank', title: st\.win/.test(battleSrc)
    && !/kind: 'arena', title: st\.win/.test(battleSrc)
    /* 300 分以上不再有「回落人机、本场不结算积分」：人机一律按天梯规则结算。 */
    && /赛区人机 · 按天梯规则结算积分/.test(battleSrc)
    && !/本场不结算积分/.test(battleSrc)
    && /arenaPage: 'menu'/.test(battleSrc)
    && !/claimChest\(resp\.chest/.test(battleSrc)
    && /resultInBattle: true/.test(battleSrc)
    && /label: '继续挑战'/.test(battleSrc)
    && /label: '查看录像'/.test(battleSrc)
    && /label: '返回天梯赛'/.test(battleSrc)
    /* 免费 10 场用完（daily.freeLeft=0/cost>0）时不再给快速继续，回天梯页走二次确认。 */
    && /paidOrDone/.test(battleSrc)
    && /freeLeft/.test(battleSrc));
  console.log('PASS 天梯战果使用 rank 容器、CG/三选一、不开宝箱、回天梯挑战页');
  /* 免费 10 场用完后：战果页不再出现「继续挑战」（它会带 confirmed:true 绕过金松果确认），
   * 只留「返回天梯赛」，让玩家回天梯菜单点开始比赛、走原版二次确认。 */
  let paidRankSpec = null;
  replay.SfFightResult = { open: async (spec) => { paidRankSpec = spec; return {}; } };
  replay.SfChallenge = {
    holdPageForBattle: () => ({ host: {} }),
    resumePageAfterBattle: () => true,
    goArenaPage: () => {},
  };
  replay.UI = { currentUiMode: () => 'classic', classic: {} };
  replay.Main.startBattle = async (_foe, opts) => { opts.onEnd(0); };
  replay.Online.ready = true;
  replay.Online.daily = { played: 10, limit: 0, unlimited: true, left: null, freeLeft: 0, cost: 5 };
  replay.Online.post = async () => ({
    me: { name: '甲' }, foe: { name: '乙' },
    result: { winner: 0, names: ['甲', '乙'], maxHp: [1, 1], rounds: [{ attacker: 0 }] },
    settlement: { win: true },
    daily: { played: 10, limit: 0, unlimited: true, left: null, freeLeft: 0, cost: 5 },
  });
  await replay.Online.battle.rank('snap', { target: { tab: 'arena', arenaPage: 'menu' } });
  assert.ok(paidRankSpec && !paidRankSpec.actions.some((a) => a.label === '继续挑战'),
    '免费 10 场用完后不能给快速继续');
  assert.ok(paidRankSpec.actions.some((a) => a.label === '返回天梯赛'), '要能回天梯页');
  console.log('PASS 免费 10 场用完后取消快速续战，回天梯页走二次确认');
  /* 设置页账号额度 x/y + 第二端登录顶号提示 + 联机账号栏的修改昵称入口；
   * 连点保护不再提供开关，动作/开战闸门由服务端自动执行。 */
  const guardSrc = fs.readFileSync(path.join(__dirname, '../js/online.js'), 'utf8').replace(/\r\n/g, '\n');
  const stateApiSrc = fs.readFileSync(path.join(__dirname, '../server/api/state.js'), 'utf8').replace(/\r\n/g, '\n');
  const cfgSrc = fs.readFileSync(path.join(__dirname, '../server/config.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/data-device-quota/.test(uiSrc) && /\/api\/device\/quota/.test(uiSrc)
    && /kickedSessions/.test(uiSrc)
    && /function renameDialog/.test(uiSrc) && /\/api\/account\/name/.test(uiSrc)
    && /button\('修改昵称', 'rename'\)/.test(uiSrc)
    && !/button\('连点保护', 'anti-click'/.test(uiSrc) && !/antiClick/.test(guardSrc)
    && /rateLimit\('action:' \+ accountId, config\.actionRatePerMin/.test(stateApiSrc)
    && /pace\('action:' \+ accountId, config\.actionIntervalMs\)/.test(stateApiSrc)
    && /actionIntervalMs: int\(process\.env\.ACTION_INTERVAL_MS/.test(cfgSrc),
  '设置页要显示设备已创建账号 x/y；登录顶掉旧设备时要有提示；联机账号栏要有修改昵称；连点保护固定开启、由服务端闸门兜底');
  console.log('PASS 设置页显示设备账号额度 x/y；第二端登录提示顶号；联机账号可修改昵称；连点保护无开关且服务端自动限流');
  /* 开发者同步的「一键打包并重启」：面板按钮 → Tauri 命令 → 本机重建脚本。
   * 只在本机确实是开发目录（online_dev_status.ok）时才显示，普通客户端不会多出这颗键。 */
  const libSrc = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
  const devSrc = fs.readFileSync(path.join(__dirname, '../src-tauri/src/dev_build.rs'), 'utf8');
  const buildSrc = fs.readFileSync(path.join(__dirname, '../tools/build-online-app.cjs'), 'utf8');
  const rebuildSrc = fs.readFileSync(path.join(__dirname, '../tools/rebuild-online-client.cjs'), 'utf8');
  assert.ok(/data-owner-rebuild/.test(uiSrc) && /online_dev_status/.test(uiSrc) && /online_dev_rebuild/.test(uiSrc)
    && /online_dev_status/.test(libSrc) && /online_dev_rebuild/.test(libSrc)
    && /CREATE_NEW_CONSOLE/.test(devSrc) && /app\.exit\(0\)/.test(devSrc)
    && /args\.includes\('--stage'\)/.test(buildSrc)
    && /--stage/.test(rebuildSrc) && /--target/.test(rebuildSrc),
    '开发者同步要能一键打包并重启开发机客户端');
  console.log('PASS 开发者同步：一键打包并重启（本机重建 + 自动重启）');
  /* 轻壳：exe 不带前端快照，接管 tauri:// 协议从仓库目录读页面；完整包仍只落 dist，
   * 且轻壳里不能让「一键同步更改」把它整包换回完整包。 */
  const shellSrc = fs.readFileSync(path.join(__dirname, '../src-tauri/src/shell.rs'), 'utf8');
  const cargoSrc = fs.readFileSync(path.join(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
  assert.ok(/thin-shell/.test(cargoSrc)
    && /register_uri_scheme_protocol\("tauri"/.test(shellSrc)
    && /join\("scripts"\)\.join\("index-online.html"\)/.test(shellSrc)
    && /--shell/.test(buildSrc) && /TAURI_CONFIG/.test(buildSrc) && /frontendDist: 'empty'/.test(buildSrc)
    && /path\.join\(TAURI, 'dist'\)/.test(buildSrc)
    && /__SSDZ_ONLINE_SHELL__/.test(uiSrc),
    '轻壳要从仓库磁盘读页面、完整包只落 dist，且轻壳里隐藏「一键同步更改」');
  console.log('PASS 轻壳：tauri:// 读仓库磁盘；完整包只落 dist；轻壳隐藏一键同步');

  /* 更新提示：启动阶段 #ui 还没挂好页面时不能弹（会被首页重绘抹掉 = 玩家看到的「闪一下」）；
   * 需要更新时等界面稳定后弹一次，换页抹掉要补弹；自动弹窗只提示，设置页才下载。 */
  function updateSandbox(info, version, opts) {
    const options = opts || {};
    const state = { screen: '', login: false, modal: false, notice: false };
    const calls = { modals: [], opened: 0, openedUrls: [], invokes: [], apkUpdates: [], actions: [], clipboard: [], closed: 0 };
    const intervals = new Map();
    let serial = 0;
    const ctx = {
      console, Promise, JSON, Math, URL, Date,
      __SSDZ_VERSION: version,
      document: {
        hidden: false,
        addEventListener() {},
        getElementById: () => ({ firstElementChild: state.screen ? { className: state.screen } : null, childElementCount: state.screen ? 1 : 0 }),
        querySelector(sel) {
          if (sel === '#ui .classic-page') return state.screen.includes('classic-page') ? {} : null;
          if (sel === '#ui .classic-home') return state.screen.includes('classic-home') ? { classList: { contains: () => state.login } } : null;
          if (sel === '.classic-modal-overlay, .online-notice-original') return state.modal || state.notice ? {} : null;
          if (sel === '.classic-modal-overlay') return state.modal ? {} : null;
          return null;
        },
      },
      setInterval(fn, ms) { intervals.set(++serial, { fn, ms }); return serial; },
      clearInterval(id) { intervals.delete(id); },
      setTimeout() { return 0; }, clearTimeout() {},
      confirm: () => false,
      alert() {},
      navigator: {
        clipboard: { writeText: async (text) => { calls.clipboard.push(String(text)); } },
        userAgent: options.iosUa || (options.ios
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15'
          : options.android ? 'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64)' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
      },
      location: { origin: 'http://tauri.localhost' },
      Net: { base: () => 'http://140.143.142.110:5896' },
      open: (url) => { calls.opened++; calls.openedUrls.push(String(url)); return true; },
      Online: { ready: true, on() {}, toast() {}, get: async () => info },
      UI: {
        runAction(action) { calls.actions.push(action); return true; },
        classic: { modal(title, body, buttons, opts2) {
          calls.modals.push({ title, buttons, opts: opts2 });
          state.modal = true;
          return {
            close() { calls.closed++; state.modal = false; },
            element: { querySelector(sel) {
              if (sel === '.classic-modal') return { classList: { add() {} } };
              if (sel === '.modal-close') return { addEventListener: (ev, fn) => { calls.closeX = fn; } };
              return null;
            } },
          };
        } },
      },
    };
    if (options.native === true) {
      ctx.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
        calls.invokes.push({ cmd, args });
        if (options.invokeFails) throw new Error('下载失败（curl 退出码 22）');
        if (cmd === 'online_dev_status') return { ok: options.devOk !== false, root: 'E:/repo', reason: '' };
        return null;
      } };
    }
    if (options.android === true) {
      ctx.SSDZAndroid = {
        abi: () => options.abi || 'x86_64',
        startApkUpdate: (url, versionText) => {
          calls.apkUpdates.push({ url, version: versionText });
          return JSON.stringify({ ok: true });
        },
        apkUpdateStatus: () => JSON.stringify({ status: 'ready', progress: 100, version: info.version, error: '' }),
      };
    }
    if (options.shell === true) ctx.__SSDZ_ONLINE_SHELL__ = true;
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/online-update.js'), 'utf8'), ctx);
    return {
      state, calls,
      checkNow: () => ctx.OnlineUpdate.checkNow(),
      async tick(n = 1) {
        for (let i = 0; i < n; i++) {
          for (const { fn, ms } of [...intervals.values()]) if (ms <= 1000) fn();
          for (let k = 0; k < 6; k++) await Promise.resolve();
        }
      },
    };
  }

  const same = updateSandbox({ ok: true, version: '1.0.55', minVersion: '', force: false }, '1.0.55');
  same.state.screen = 'classic-home ssfight-home';
  await same.tick(6);
  assert.equal(same.calls.modals.length, 0, '版本相同不能弹更新提示');

  const optional = updateSandbox({ ok: true, version: '1.0.55', minVersion: '', force: false }, '1.0.54');
  await optional.tick(10);
  assert.equal(optional.calls.modals.length, 0, '登录页/启动阶段（#ui 还没有稳定页面）不能弹，否则会闪一下');
  optional.state.screen = 'classic-home ssfight-home';
  await optional.tick(3);
  assert.equal(optional.calls.modals.length, 1, '进入游戏后要弹出更新提示');
  const ob = Array.from(optional.calls.modals[0].buttons, (b) => String(b.label));
  assert.deepEqual(ob, ['前往设置', '知道了'], '自动更新弹窗只能提示，不能直接拉整包');
  assert.equal(optional.calls.opened, 0, '自动弹窗不能打开下载页');
  assert.equal(optional.calls.invokes.length, 0, '自动弹窗不能走原生整包替换');
  assert.equal(optional.calls.apkUpdates.length, 0, '自动弹窗不能走 APK 下载');
  optional.state.modal = false; // 换页把弹窗抹掉
  await optional.tick(2);
  assert.equal(optional.calls.modals.length, 2, '换页抹掉后要补弹，不能只闪一次就没了');
  const later = optional.calls.modals[1].buttons.find((b) => b.label === '知道了');
  assert.ok(later, '普通更新要能「知道了」');
  later.run();
  optional.state.modal = false;
  await optional.tick(4);
  assert.equal(optional.calls.modals.length, 2, '点过「知道了」后同一版本不再打扰');

  /* 右上角 X：更新弹窗要能直接忽视（强制更新也有），关掉后同一版本本局不再补弹。 */
  const withX = updateSandbox({ ok: true, version: '1.0.55', minVersion: '1.0.50', force: false }, '1.0.40');
  withX.state.screen = 'classic-home ssfight-home';
  await withX.tick(3);
  assert.equal(withX.calls.modals[0].opts.showClose, true, '更新弹窗要带 showClose（右上角 X）');
  assert.equal(withX.calls.modals[0].opts.locked, true, 'X 不能把 locked 关掉（不触发三选一）');
  assert.equal(typeof withX.calls.closeX, 'function', 'X 点击要接到 dismiss');
  withX.calls.closeX();
  withX.state.modal = false;
  await withX.tick(4);
  assert.equal(withX.calls.modals.length, 1, '点 X 后同一版本不再弹');

  const toSettings = updateSandbox({ ok: true, version: '1.0.55', minVersion: '', force: false }, '1.0.54');
  toSettings.state.screen = 'classic-page';
  await toSettings.tick(3);
  const goto = toSettings.calls.modals[0].buttons.find((b) => b.label === '前往设置');
  assert.ok(goto, '自动弹窗要引导到设置页');
  goto.run();
  assert.ok(toSettings.calls.actions.includes('settings'), '「前往设置」只切设置页，不下载整包');
  assert.equal(toSettings.calls.opened + toSettings.calls.invokes.length + toSettings.calls.apkUpdates.length, 0,
    '「前往设置」不能绕过设置页直接拉包');

  const forced = updateSandbox({ ok: true, version: '1.0.55', minVersion: '1.0.50', force: false }, '1.0.40');
  await forced.tick(6);
  assert.equal(forced.calls.modals.length, 0, '强制更新也不能在启动阶段闪');
  forced.state.screen = 'classic-page';
  await forced.tick(3);
  assert.equal(forced.calls.modals.length, 1, '低于 minVersion 要按强制更新弹');
  const fbtns = Array.from(forced.calls.modals[0].buttons, (b) => String(b.label));
  assert.deepEqual(fbtns, ['前往设置', '复制下载地址'], '强制更新也不能在弹窗里直接下载');
  assert.equal(forced.calls.opened + forced.calls.invokes.length + forced.calls.apkUpdates.length, 0,
    '强制更新弹窗只引导设置 / 复制地址，不拉服务器整包');
  forced.state.modal = false;
  await forced.tick(2);
  assert.equal(forced.calls.modals.length, 2, '强制更新被换页抹掉后必须重新出现');

  const forcedCopy = updateSandbox({ ok: true, version: '1.0.55', minVersion: '1.0.50', force: false }, '1.0.40');
  forcedCopy.state.screen = 'classic-page';
  await forcedCopy.tick(4);
  const forcedCopyBtn = forcedCopy.calls.modals[0].buttons.find((b) => b.label === '复制下载地址');
  assert.ok(forcedCopyBtn, '强制更新要有复制下载地址');
  forcedCopyBtn.run();
  await forcedCopy.tick(4);
  assert.ok(forcedCopy.calls.closed >= 1, '自动强制更新点复制后也要关闭弹窗');
  assert.equal(forcedCopy.calls.clipboard.length, 1, '自动强制更新点复制要写剪贴板');
  assert.equal(forcedCopy.calls.opened, 1, '没有原生通道时复制后立即打开下载页同步');

  /* 设置页「检查更新」是唯一允许从服务器下载的入口：Windows 完整包走原生整包替换。 */
  const native = updateSandbox({
    ok: true, version: '1.0.55', minVersion: '', force: false,
    exe: '/download/squirrel_fight_online-1.0.55.exe', exeSize: 38.8 * 1048576, url: 'http://x/download',
  }, '1.0.40', { native: true });
  await native.tick(2);
  const nativeOut = await native.checkNow();
  assert.equal(nativeOut.ok, true, '设置页手动检查要返回结果');
  assert.equal(nativeOut.latest, false, '设置页手动检查发现新版本');
  assert.deepEqual(Array.from(native.calls.modals[0].buttons, (b) => String(b.label)), ['从服务器更新', '稍后再说'],
    '设置页更新框才提供服务器下载');
  native.calls.modals[0].buttons[0].run();
  await native.tick(2);
  assert.equal(native.calls.invokes.length, 1, '设置页「从服务器更新」要走原生整包替换');
  assert.equal(native.calls.invokes[0].cmd, 'online_sync_client');
  assert.equal(native.calls.invokes[0].args.url, 'http://140.143.142.110:5896/download/squirrel_fight_online-1.0.55.exe');
  assert.equal(native.calls.invokes[0].args.version, '1.0.55');
  assert.ok(native.calls.modals.some((m) => String(m.title).includes('更新完成')), '替换完成后要提示重新打开游戏');

  /* 复制下载地址：收起原弹窗并立即走同步更新（设置页/原生通道）。 */
  const copySync = updateSandbox({
    ok: true, version: '1.0.55', minVersion: '1.0.50', force: false,
    exe: '/download/squirrel_fight_online-1.0.55.exe', exeSize: 38.8 * 1048576, url: 'http://x/download',
  }, '1.0.40', { native: true });
  await copySync.tick(2);
  await copySync.checkNow();
  const copyBtn = copySync.calls.modals[0].buttons.find((b) => b.label === '复制下载地址');
  assert.ok(copyBtn, '设置页强制更新要有复制下载地址');
  copyBtn.run();
  await copySync.tick(4);
  assert.ok(copySync.calls.closed >= 1, '点击复制下载地址后原弹窗必须关闭');
  assert.equal(copySync.calls.clipboard.length, 1, '复制下载地址要写入剪贴板');
  assert.equal(copySync.calls.clipboard[0], 'http://x/download', '复制的应该是下载地址');
  assert.equal(copySync.calls.invokes.length, 1, '复制后要立即走原生同步更新，而不是停在弹窗');
  assert.equal(copySync.calls.invokes[0].cmd, 'online_sync_client');
  assert.equal(copySync.calls.invokes[0].args.url,
    'http://140.143.142.110:5896/download/squirrel_fight_online-1.0.55.exe');
  assert.ok(copySync.calls.modals.some((m) => String(m.title).includes('正在更新')),
    '立即同步要出现下载进度弹窗');

  /* Android：设置页下载按 ABI 选 x86_64 包，下载完成后打开系统安装器。 */
  const android = updateSandbox({
    ok: true, version: '1.0.56', minVersion: '', force: false,
    apk: '/download/squirrel_fight_online-1.0.56-arm64.apk',
    apkX86: '/download/squirrel_fight_online-1.0.56-x86_64.apk',
    apkX86Size: 47.9 * 1048576, url: 'http://x/download',
  }, '1.0.55', { native: true, android: true });
  await android.tick(2);
  const androidOut = await android.checkNow();
  assert.equal(androidOut.latest, false, 'Android 设置页检查发现新版本');
  android.calls.modals[0].buttons[0].run();
  await android.tick(3);
  assert.equal(android.calls.apkUpdates.length, 1, '设置页「从服务器更新」要走原生 APK 下载');
  assert.equal(android.calls.apkUpdates[0].url,
    'http://140.143.142.110:5896/download/squirrel_fight_online-1.0.56-x86_64.apk',
    'x86_64 设备要选 x86_64 包，不能下 arm64');
  assert.equal(android.calls.apkUpdates[0].version, '1.0.56');
  assert.ok(android.calls.modals.some((m) => String(m.title).includes('安装包已下载')),
    '下载完成要提示用户去系统安装界面点安装');

  /* 主 ABI 是 arm64、SUPPORTED_ABIS 里又带 x86_64 的设备：必须选 arm64 包；
   * 32 位设备没有匹配包时不能下载，只能打开下载页（否则系统报 CPU 不兼容）。 */
  const armPrimary = updateSandbox({
    ok: true, version: '1.0.58', minVersion: '', force: false,
    apk: '/download/squirrel_fight_online-1.0.58-arm64.apk',
    apkX86: '/download/squirrel_fight_online-1.0.58-x86_64.apk',
    apkSize: 47.7 * 1048576, apkX86Size: 48.0 * 1048576, url: 'http://x/download',
  }, '1.0.57', { native: true, android: true, abi: 'arm64-v8a,x86_64' });
  await armPrimary.tick(2);
  await armPrimary.checkNow();
  armPrimary.calls.modals[0].buttons[0].run();
  await armPrimary.tick(3);
  assert.equal(armPrimary.calls.apkUpdates[0].url,
    'http://140.143.142.110:5896/download/squirrel_fight_online-1.0.58-arm64.apk',
    'SUPPORTED_ABIS 同时含 arm64/x86_64 时，主 ABI 是 arm64 就必须选 arm64 包');
  const unsupported = updateSandbox({
    ok: true, version: '1.0.58', minVersion: '', force: false,
    apk: '/download/squirrel_fight_online-1.0.58-arm64.apk', url: 'http://x/download',
  }, '1.0.57', { native: true, android: true, abi: 'armeabi-v7a,armeabi' });
  await unsupported.tick(2);
  await unsupported.checkNow();
  const unsupportedLabels = Array.from(unsupported.calls.modals[0].buttons, (b) => String(b.label));
  assert.ok(unsupportedLabels.includes('打开下载页') && !unsupportedLabels.includes('从服务器更新'),
    '32 位设备没有匹配包时不能提供「从服务器更新」按钮');
  unsupported.calls.modals[0].buttons[0].run();
  await unsupported.tick(2);
  assert.equal(unsupported.calls.apkUpdates.length, 0, '32 位设备不能下载 64 位 APK');
  assert.equal(unsupported.calls.opened, 1, '32 位设备改走下载页');

  /* iOS：设置页「从服务器更新」只打开对应 IPA（iOS 26+ 默认包 / iOS 15~25 legacy），
   * 不调用整包替换；iOS 26+ 与 15~25 必须选对包。 */
  const iosInfo = {
    ok: true, version: '1.0.64', minVersion: '', force: false,
    ipa: '/download/squirrel_fight_online_1.0.64_ios_unsigned.ipa',
    ipaLegacy: '/download/squirrel_fight_online_1.0.64_ios_legacy_unsigned.ipa',
    ipaSize: 39.2 * 1048576, ipaLegacySize: 39.0 * 1048576, url: 'http://x/download',
  };
  const ios = updateSandbox(iosInfo, '1.0.63', { native: true, ios: true });
  await ios.tick(2);
  const iosOut = await ios.checkNow();
  assert.equal(iosOut.latest, false, 'iOS 设置页检查发现新版本');
  assert.deepEqual(Array.from(ios.calls.modals[0].buttons, (b) => String(b.label)), ['从服务器更新', '稍后再说']);
  ios.calls.modals[0].buttons[0].run();
  await ios.tick(2);
  const iosModal = ios.calls.modals.find((m) => String(m.title).includes('iOS 更新'));
  assert.ok(iosModal, 'iOS 更新要先说明 IPA 安装方式');
  assert.deepEqual(Array.from(iosModal.buttons, (b) => String(b.label)), ['打开下载地址', '复制地址', '稍后再说']);
  iosModal.buttons[0].run();
  await ios.tick(2);
  assert.equal(ios.calls.openedUrls[0],
    'http://140.143.142.110:5896/download/squirrel_fight_online_1.0.64_ios_unsigned.ipa',
    'iOS 26+ 要打开默认 IPA');
  assert.equal(ios.calls.invokes.length, 0, 'iOS 不能走 Windows 整包替换');

  const iosLegacy = updateSandbox(iosInfo, '1.0.63', {
    native: true, ios: true,
    iosUa: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15',
  });
  await iosLegacy.tick(2);
  await iosLegacy.checkNow();
  iosLegacy.calls.modals[0].buttons[0].run();
  await iosLegacy.tick(2);
  const legacyModal = iosLegacy.calls.modals.find((m) => String(m.title).includes('iOS 更新'));
  legacyModal.buttons[0].run();
  await iosLegacy.tick(2);
  assert.equal(iosLegacy.calls.openedUrls[0],
    'http://140.143.142.110:5896/download/squirrel_fight_online_1.0.64_ios_legacy_unsigned.ipa',
    'iOS 15~25 要打开 legacy IPA');

  /* 设置-联机账号的手动检查：已是最新版本时只提示，不弹更新框；界面要写明推荐 QQ 群下载。 */
  const manual = updateSandbox({ ok: true, version: '1.0.56', minVersion: '', force: false }, '1.0.56');
  manual.state.screen = 'classic-page';
  await manual.tick(2);
  const manualOut = await manual.checkNow();
  assert.equal(manualOut.ok, true, '手动检查更新要返回结果');
  assert.equal(manualOut.latest, true, '版本相同要返回「已是最新」');
  assert.equal(manual.calls.modals.length, 0, '已是最新版本时不要弹更新框');
  assert.ok(/button\('检查更新', 'update'\)/.test(uiSrc) && /OnlineUpdate\.checkNow/.test(uiSrc),
    '设置-联机账号要有「检查更新」按钮，并调用 OnlineUpdate.checkNow');
  assert.ok(/QQ 群 1128710765/.test(uiSrc) && /online-update-hint/.test(uiSrc),
    '设置页要提示优先去 QQ 群 1128710765 下载最新版本');

  /* 开发轻壳不能整包替换（会变成玩家版）：设置页下载走本机重新打包 + 自动重启。 */
  const shell = updateSandbox({
    ok: true, version: '1.0.55', minVersion: '', force: false,
    exe: '/download/squirrel_fight_online-1.0.55.exe',
  }, '1.0.54', { native: true, shell: true });
  await shell.tick(2);
  const shellOut = await shell.checkNow();
  assert.equal(shellOut.latest, false, '开发轻壳设置页检查发现新版本');
  shell.calls.modals[0].buttons[0].run();
  await shell.tick(3);
  assert.deepEqual(Array.from(shell.calls.invokes, (i) => i.cmd), ['online_dev_status', 'online_dev_rebuild'],
    '开发轻壳的「从服务器更新」要本机重新打包并重启，而不是整包替换');

  /* 纯网页端设置页「下载客户端」：先展示自动识别的设备，确认后才从服务器拉整包；
   * 没有对应系统的包时只给下载页，不猜包。 */
  function downloadSandbox(opts) {
    const o = opts || {};
    const calls = { gets: [], modals: [], toasts: [], clicks: [], opened: [] };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
    const ctx = {
      console, Promise, JSON, Math, URL, Date, encodeURIComponent,
      navigator: {
        userAgent: o.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        platform: o.platform || 'Win32',
        maxTouchPoints: o.touch || 0,
        clipboard: { writeText: async (text) => { calls.clipboard.push(String(text)); } },
      },
      location: { protocol: 'https:', origin: 'http://140.143.142.110:5896' },
      setTimeout() { return 0; },
      document: {
        body: { appendChild() {} },
        createElement() { return { style: {}, click() { calls.clicks.push(this.href); } }; },
      },
      Net: { base: () => 'http://140.143.142.110:5896' },
      Online: {
        errText: (e) => String((e && e.message) || e),
        get: async (p, opt) => { calls.gets.push({ path: p, opt }); return o.reply; },
      },
      UI: { classic: {
        modal(title, body, buttons, modalOpts) {
          calls.modals.push({ title, body, buttons, opts: modalOpts });
          return { close() {} };
        },
      } },
      open: (url) => { calls.opened.push(String(url)); return true; },
      toast: (msg) => calls.toasts.push(String(msg)),
      esc,
    };
    ctx.window = ctx;
    ctx.OnlineUI = { _: { O: ctx.Online, esc, toast: ctx.toast, C: () => ctx.UI.classic } };
    if (o.native) ctx.__TAURI_INTERNALS__ = {};
    if (o.high) {
      ctx.navigator.userAgentData = {
        platform: o.uaPlatform || 'Windows',
        mobile: o.mobile === true,
        getHighEntropyValues: async () => o.high,
      };
    }
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/online-client-download.js'), 'utf8'), ctx);
    return { calls, client: ctx.OnlineClientDownload };
  }

  const winDevice = downloadSandbox({
    high: { architecture: 'x86', bitness: '64', platformVersion: '15.0.0', model: '' },
    reply: { ok: true, version: '1.0.80', package: {
      platform: 'windows', label: 'Windows 客户端',
      name: 'squirrel_fight_online-1.0.80.exe', url: '/download/squirrel_fight_online-1.0.80.exe',
      size: 70000000, version: '1.0.80', note: '',
    } },
  });
  assert.equal(winDevice.client.available(), true, '浏览器里要挂下载入口');
  const winDetected = await winDevice.client.detect();
  assert.match(winDetected.label, /Windows 11/, '要按 UA-CH 区分 Windows 11 / 10');
  assert.match(winDetected.label, /x64/);
  assert.match(winDetected.kindLabel, /桌面/);
  await winDevice.client.open();
  assert.equal(winDevice.calls.gets[0].path, '/api/client/download?os=windows&arch=x64');
  assert.equal(winDevice.calls.gets[0].opt.auth, false);
  assert.match(winDevice.calls.modals[0].body, /Windows 11/);
  assert.match(winDevice.calls.modals[0].body, /squirrel_fight_online-1\.0\.80\.exe/);
  assert.deepEqual(Array.from(winDevice.calls.modals[0].buttons, (b) => b.label), ['确认下载', '打开下载页', '取消']);
  winDevice.calls.modals[0].buttons[0].run();
  assert.equal(winDevice.calls.clicks[0], 'http://140.143.142.110:5896/download/squirrel_fight_online-1.0.80.exe',
    '确认后才用浏览器下载整包');
  assert.match(winDevice.calls.toasts.at(-1), /开始下载/);

  const androidDevice = downloadSandbox({
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', touch: 5, uaPlatform: 'Android', mobile: true,
    high: { architecture: 'arm', bitness: '64', platformVersion: '14.0.0', model: 'Pixel 8' },
    reply: { ok: true, version: '1.0.80', package: {
      platform: 'android', label: 'Android 客户端（arm64）',
      name: 'squirrel_fight_online-1.0.80-arm64.apk', url: '/download/squirrel_fight_online-1.0.80-arm64.apk',
      size: 48000000, version: '1.0.80', note: '',
    } },
  });
  const androidDetected = await androidDevice.client.detect();
  assert.match(androidDetected.label, /Android 14/);
  assert.match(androidDetected.label, /Pixel 8/, 'Android 要显示设备型号（UA-CH model）');
  assert.match(androidDetected.label, /arm64/);
  await androidDevice.client.open();
  assert.equal(androidDevice.calls.gets[0].path, '/api/client/download?os=android&arch=arm64');

  const macDevice = downloadSandbox({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    platform: 'MacIntel',
    reply: {
      ok: true, version: '1.0.80', package: null, reason: 'unsupported-platform',
      message: '服务器暂时没有 macOS 客户端；可以直接用网页版游玩，进度与客户端互通。',
      downloadPage: '/download',
    },
  });
  assert.match((await macDevice.client.detect()).label, /macOS/);
  await macDevice.client.open();
  assert.deepEqual(Array.from(macDevice.calls.modals[0].buttons, (b) => b.label), ['打开下载页', '知道了'],
    '没有对应安装包时不能给「确认下载」');
  assert.match(macDevice.calls.modals[0].body, /暂时没有 macOS 客户端/);
  macDevice.calls.modals[0].buttons[0].run();
  assert.equal(macDevice.calls.opened[0], 'http://140.143.142.110:5896/download');

  const nativeDevice = downloadSandbox({ native: true, reply: {} });
  assert.equal(nativeDevice.client.available(), false, '安装包内不再显示「下载客户端」');
  assert.ok(/button\('下载客户端', 'client-download', clientDownload\.shortLabel\(\)\)/.test(uiSrc)
    && /clientDownload\.open/.test(uiSrc)
    && /online-client-download\.js/.test(fs.readFileSync(path.join(__dirname, '../scripts/index-online.html'), 'utf8')),
    '设置-游戏设置要有「下载客户端」，入口脚本也要进加载链');
  console.log('PASS 纯网页端「下载客户端」：识别系统/型号 → 服务端选包 → 确认后下载；无包时只给下载页');

  console.log('PASS 自动更新不主动下载；复制下载地址后关闭弹窗并立即同步；设置页提示优先 QQ 群');
  console.log('PASS 设置页「从服务器更新」在 Windows 完整包里整包替换、在开发轻壳里本机重新打包');
  console.log('PASS 设置页「从服务器更新」在 Android 按 ABI 下载 APK 并打开系统安装器');
  console.log('PASS 设置页「从服务器更新」在 iOS 按系统版本打开对应 IPA（26+ 默认包 / 15~25 legacy）');
})().catch(e=>{console.error(e);process.exitCode=1;});
