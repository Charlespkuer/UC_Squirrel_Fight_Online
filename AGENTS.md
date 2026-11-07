# 松鼠大战 Online —— 项目入口

> 这是**联机版**（服务器权威）仓库；单机版在 `E:\Squirrel_Fight`，两边共用大量 `js/` 代码，
> 差异都挂在 `window.__SSDZ_ONLINE__` 上（见 §3）。
> 网页入口是 `scripts/index-online.html`（不是仓库根的 `index.html`，也不是单机版的 `scripts/index.html`）。
> **联机版只有经典界面**：页面一律用 `images/ssfight/ui/` 里的原版元件渲染。

## 0. 服务器凭据在哪儿（新窗口不用再问用户）

| 要什么 | 看哪里 |
|---|---|
| 主机 / 账号 / **密码** / 端口 | `server/deploy/credentials.local.json`（**已 gitignore**） |
| 机器规格、部署形态、安全善后 | `docs/服务器与部署.md` |
| 联机协议与架构决策 | `docs/联机实现方案.md`（§11 起为准） |
| 经济口径（该删/该降的奖励渠道） | `docs/奖励与经济.md` |

密码**不要写进命令行历史**，用 `Get-Content ... | ConvertFrom-Json` 读进变量再传给 ssh / scp。

## 1. 跑起来

**线上（已部署）**：`http://140.143.142.110:5896/api/health` → `{"ok":true,...,"db":"ok"}`。
旧服 `111.229.39.217` 的 ssdz 内容已删除（2026-11-04），只保留 `dota-coach-cloud`（6200）；code-server 也已删除，不再可回滚。
EXE 自带资源，只走 API；地址由 `src-tauri/online-api.json` 决定，客户端会自己探测
https/http（见 `js/net.js` 的 `discover()`）。

> 游戏 API 走 HTTP **5896**（用户 2026-11-04 选定）；新服 80/443 属于同机已有的 Docker Caddy
> （open-webui / 单机网页 / 云存档），**不要覆盖**。旧服 443 未放行的历史决定见
> `docs/服务器与部署.md` §1.2；别再劝 TLS。

**本机开发**：

```powershell
# 1) 起联机服务（静态页 + /api，默认 127.0.0.1:3100）
node server/index.js

# 2) 浏览器打开
#    http://127.0.0.1:3100/            → 联机版入口（scripts/index-online.html）
```

同源访问时 `net.js` 自动用 `/api`；分离部署（静态在 Caddy、API 在别处）时：
`Net.configure({ base: 'http://<host>:3100' })` 或在 `localStorage['ssdz-online-base']` 里写地址。

**出 EXE**：`node tools/build-online-app.cjs`（先 `--web` 只打前端快照）。
改服务器地址：`--api https://example.com` 或改 `src-tauri/online-api.json` 的 `base` / `fallbacks`。

**部署服务端**：`docs/服务器与部署.md` §3（打包上传 → `ssdz-deploy.sh` → 自检 `/api/health`）。
⚠ 服务端也要 `js/`（它把 `js/*.js` 当游戏内核加载），客户端与服务端必须**同版本**一起更新。

## 2. 模块地图

```
server/                     服务器权威（唯一真值）
  index.js                  HTTP 入口：静态 + 路由表 + 错误处理
  config.js                 端口/赛季/天梯/征战/限流等全部常量（环境变量可覆盖）
  db.js                     node:sqlite 建表 + 事务 + WAL
  auth.js                   scrypt 密码、会话令牌、恢复码
  device.js                 设备指纹 / 一设备一账号 / 新设备登录提醒
  http.js                   JSON 收发 / gzip / 限流 / 路径匹配
  game/runtime.js           把 js/*.js 装进 Node（最小 DOM 桩）；withState 的同步约定
  game/store.js             权威存档读写原语（runOnSave / patch / revision）
  game/actions.js           动作白名单执行器（shared/actions.json 是唯一真值）
  game/fighter.js           存档 → 战斗体（与 main.js 同一套面板口径）
  game/battle.js            种子 / mulberry32 / 结果哈希 / 视角交换
  game/fight.js             随机挑战 / 天梯 / 关卡 / 竞技场 / 切磋 / 收徒 / 回放
  game/apprentice.js        联机师徒：人机师父 / 收真人徒弟 / 日供 / 逐出 / 出师
  game/campaign.js          征战：四人队列 + 服务端逐人算 + 掷骰分奖
  game/snapshot.js          每级战斗快照（升级落一条、同级换装新 revision）
  game/settlement.js        天梯积分档 / 每日次数 / 周奖励 / 赛季滚动
  game/maintenance.js       追加型表的保留期清理（combats / 消息 / 账本 / 周积分等）
  game/backup.js            自动整库备份（VACUUM INTO + 完整性检查 + 保留期）
  api/*.js                  路由实现（account / state / battle / ladder / social / campaign）

shared/actions.json         服务端动作白名单：mode=async|sync|local，客户端也从 /api/meta 拿这份

js/net.js                   唯一网络出口（令牌、超时、全局串行队列）
js/online.js                权威镜像 + 动作流水线 + 把 State 的口子收好
js/online-battle.js         战斗流程（请求 → 播录像 → 原版战果页）
js/online-ui.js             登录页 + 征战页（原版 3437）+ 天梯自动匹配
js/campaign-data.js         征战首领表 / 门票 / 奖励池（浏览器与服务端共用）
js/state.js 等              与单机版同源；联机差异全部挂在 __SSDZ_ONLINE__ 上

scripts/index-online.html   联机版脚本加载链（不含 tower*/debug/ui 的现代页）
```

## 3. 三条不要破坏的约定

1. **服务器权威**：进度只由 `POST /api/action`（或 `/api/battle`）在服务端改。
   客户端 `State.save()` 是空操作；`gainExp/addGold/fightReward/recordBattle` 等发奖函数被替换成抛错。
   页面要发奖就跑服务端动作，不要绕过。
2. **动作分类**：`shared/actions.json` 里
   `sync`（确定性，可本地预测）由 `js/online.js` 自动包一层「本地算 + 上行确认」；
   `async`（含随机数）必须 `await Online.call('名字', …)`，**不许本地算**；
   `local` 只影响界面偏好。新增动作时先改这个 JSON，再改服务端执行器（一般不用改）。
3. **只有经典界面**：`UIMODES` 只有 `classic`、`switchMode` 恒拒绝、存档不写 `__dual*`、
   不加载 `tower*.js` / `debug.js`；新增界面先查 `images/ssfight/ui/symbol-index.json`
   有没有原版元件，**能复用就不要自绘**。

## 4. 验证

| 命令 | 守什么 |
|---|---|
| `node tools/test-online-api.cjs` | 服务器端到端：注册/登录/动作白名单/战斗/回放/天梯/好友/征战/静态 |
| `node tools/test-online-apprentice.cjs` | 联机师徒端到端：拜师人机 / 打师父收徒 / 真人日供 10%+10% / 逐出 / 出师 |
| `node tools/test-online-economy.cjs` | 联机版经济收口（任务/礼包/日贡/重开/商店/碎片合成/征战令） |
| `node tools/test-online-swap.cjs` | 防守视角交换：随机 200 场，交换两次必须回原值 |
| `node tools/test-online-creator.cjs` | 创作者设备白名单：浏览器端 / 注册名额 / 一机多号；普通设备仍受限 |
| `node tools/test-state.cjs` | 单机版数值规则（105 条；联机差异不该动它） |
| `node tools/test-ssfight-render.cjs` | 经典界面显示层（**有一条历史遗留失败**，见下） |
| `node tools/check-asset-paths.cjs` / `check-encodings.cjs` | 资源引用、文本编码 |

> `test-ssfight-render.cjs` 的 `checkDualSaveAndDebugGate` 在副本里是**红的**：
> 单机版把 `js/debug.js` 的 `DEBUG_IN_CLASSIC` 临时改成了 `true`（调试用）。
> 联机包不加载 `debug.js`，与本项目无关，不要去改那条断言。

## 5. 文档与素材

- 经典界面维护：`js/ssfight/AGENTS.md` + 项目 skill `.agents/skills/classic-ui-maintenance/SKILL.md`。
- 变更日志只有一份：`docs/更新记录.md`（**最新批次在最上面**）。不要新增过程报告。
- 运行时素材在 `images/ssfight/ui/`；本机参考素材目录叫 **`reference/`**（单数；历史文档里写作
  `references/`，`check-*` 工具两种拼写都跳过）。它不进仓库、不被运行时依赖；
  `reference/retired/` 存放已退场素材（2026-11 起，附 `deadset.json` 清单），已加入 `.gitignore`。
