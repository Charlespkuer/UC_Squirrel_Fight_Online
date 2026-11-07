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
  console.log('PASS installed client API/session lifecycle, expired login and response-body deadline');

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
  const uiStyleSrc = fs.readFileSync(path.join(__dirname, '../js/online-ui.js'), 'utf8');
  const onlineCss = fs.readFileSync(path.join(__dirname, '../css/online.css'), 'utf8');
  assert.ok(/campaign-result-dialog/.test(uiStyleSrc)
    && /\.campaign-result-dialog \.modal-buttons\s*\{[^}]*margin-top:\s*44px/.test(onlineCss)
    && /min-width:\s*300px/.test(onlineCss) && /min-height:\s*88px/.test(onlineCss),
    '征战结果的确定键要放大并下移');
  console.log('PASS campaign result confirm button is enlarged and lowered');

  /* 天梯按原版自动匹配：客户端不能再有「选择对手」页。 */
  const uiSrc=fs.readFileSync(path.join(__dirname,'../js/online-ui.js'),'utf8');
  const ceSrc=fs.readFileSync(path.join(__dirname,'../js/classic-extras.js'),'utf8');
  assert.ok(/async function autoMatch/.test(uiSrc) && !/pickOpponent/.test(uiSrc)
    && /OnlineUI\.autoMatch/.test(ceSrc) && !/pickOpponent/.test(ceSrc));
  console.log('PASS 天梯自动匹配：没有「选择对手」页');
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
    && /label: '返回天梯赛'/.test(battleSrc));
  console.log('PASS 天梯战果使用 rank 容器、CG/三选一、不开宝箱、回天梯挑战页');
  /* 设置页账号额度 x/y + 第二端登录顶号提示 + 联机账号栏的修改昵称入口。 */
  assert.ok(/data-device-quota/.test(uiSrc) && /\/api\/device\/quota/.test(uiSrc)
    && /kickedSessions/.test(uiSrc)
    && /function renameDialog/.test(uiSrc) && /\/api\/account\/name/.test(uiSrc)
    && /button\('修改昵称', 'rename'\)/.test(uiSrc),
  '设置页要显示设备已创建账号 x/y；登录顶掉旧设备时要有提示；联机账号栏要有修改昵称');
  console.log('PASS 设置页显示设备账号额度 x/y；第二端登录提示顶号；联机账号可修改昵称');
})().catch(e=>{console.error(e);process.exitCode=1;});
