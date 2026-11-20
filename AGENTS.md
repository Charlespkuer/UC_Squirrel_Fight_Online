# 松鼠大战 Online —— 项目入口

> 这是**联机版**（服务器权威）仓库；单机版在 `E:\Squirrel_Fight`，两边共用大量 `js/` 代码，
> 差异都挂在 `window.__SSDZ_ONLINE__` 上（见 §3）。
> **本仓库只有联机版网页入口** `scripts/index-online.html`。单机版入口、现代 canvas 战斗、
> 单机出包链已于 2026-11-10 退役到 `reference/retired/2026-11-10-online-b0/`（见 §5）。
> **联机版只开放经典界面**：原版有元件的页面一律用 `images/ssfight/ui/` 渲染；原版没有的
> 联机功能（登录 / 征战 / 论坛 / 设置 / 无尽塔）用经典配色自建 DOM，不自绘原版已有元件。

## 0. 服务器凭据在哪儿（新窗口不用再问用户）

| 要什么 | 看哪里 |
|---|---|
| 主机 / 账号 / **密码** / 端口 | `server/deploy/credentials.local.json`（**已 gitignore**） |
| 机器规格、部署形态、安全善后 | `docs/服务器与部署.md` |
| 联机协议与架构决策 | `docs/联机实现方案.md`（§11 起为准） |
| 经济口径（该删/该降的奖励渠道） | `docs/奖励与经济.md` |
| **GitHub 远端 / Release** | `https://github.com/Charlespkuer/UC_Squirrel_Fight_Online`（`origin`，分支 `main`；发版打 `v<版本>` tag，Release 附五个安装包） |

密码**不要写进命令行历史**，用 `Get-Content ... | ConvertFrom-Json` 读进变量再传给 ssh / scp。

## 0.5 部署边界（用户明确要求才上线）

- **未经用户明确要求，不要部署线上**：用户没说「部署 / 上线 / 发布到线上 / 更新服务器」时，只改代码、跑本地测试、出本地包；不要上传服务器、不要重启 `ssdz-online`、不要替换 `/var/lib/ssdz/downloads`、不要改线上版本清单。
- 每次线上发版都会让所有玩家收到更新提示并拉包：消耗服务器流量，也会打断玩家。频繁发版等于反复拉取玩家的更新需求；把改动攒到一个明确的发布点再一次部署。
- 用户明确要求发布时，按 `docs/服务器与部署.md` §3 执行，并一次完成版本号 / 客户端包 / 服务端包；发布后验证 `/api/health`、`/api/update` 和下载页。
- 自动更新提示只负责通知，**只有设置页**允许从服务器下载整包；不要在启动弹窗或后台检查里直接下载/替换客户端。

## 0.6 发布包只留最新版（旧包直接删）

> 用户 2026-11-18 口径：pack **永远只保留最新版本**的包，旧包直接删掉，不做归档。

- **本地** `src-tauri/dist`：`tools/prune-dist.cjs` 按 `scripts/version.json` 只留当前版本的 EXE + arm64 / x86_64 APK + 两个 iOS IPA；旧版本直接删除。出包成功后自动调用，也可手动 `node tools/prune-dist.cjs --dry` 预览。
- **服务器** `/var/lib/ssdz/downloads`：`server/deploy/ssdz-deploy.sh` 在部署末尾按 `scripts/version.json` 清理，只留当前版本五个包（`manifests/` 除外）；旧版本直链随包一起删除。
- **发版前**确认当前版本五个包都已上传：EXE、arm64 APK、x86_64 APK、iOS IPA、iOS legacy IPA。缺包时部署脚本只告警、仍按版本清理旧包（所以缺哪个端，那个端会暂时没有下载包）。

## 1. 跑起来

**线上（已部署）**：`http://140.143.142.110:5896/` → 纯网页游玩端（手机/平板/电脑，无需安装；
`/play` 同页）；`http://140.143.142.110:5896/api/health` → `{"ok":true,...,"db":"ok"}`。
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

**出 EXE**（两种产物、共用一份源码）：

- **轻壳**（开发机，仓库根 `squirrel_fight_online.exe`，几 MB）：`node tools/build-online-app.cjs --shell`。
  不带前端快照：启动时由 `src-tauri/src/shell.rs` 接管 `tauri://` 协议，从**仓库目录**读
  `js/ css/ images/`。所以**改代码不用重新打包**，刷新窗口（F5）或重开一次就是新的；
  只有改 Rust / 窗口配置才要重编（约 10~60 秒）。
- **完整包**（给玩家 / 发布，`src-tauri/dist/squirrel_fight_online.exe`，约 67 MB）：
  `node tools/build-online-app.cjs`。前端快照与清单编进 exe，裸机可跑；**不再覆盖根目录的轻壳**。

改服务器地址：`--api https://example.com` 或改 `src-tauri/online-api.json` 的 `base` / `fallbacks`。

> **从 Windows 对端同步源码**（开发机专用，不进客户端包）：先 `node tools/pull-win.cjs --dry` 看差异，
> 去掉 `--dry` 实拉；按对端 `.gitignore` 过滤，覆盖前备份到 `~/.peer/trash/win-pull/`。

> 轻壳排查：设 `SSDZ_SHELL_LOG=1` 后启动，找目录的结果与每个请求的「状态 / 路径 / 字节数」都会
> 追加写到 `%TEMP%\ssdz-online-shell.log`（改了文件但页面还是旧的，先看这里的字节数）。

> **构建只做一次验证**：`--web` 已经算过的快照指纹与逐文件 sha256 必须复用，不许构建完再
> spawn 一次 `--check`（同一份 96 MB 源码再读一遍）；`.so` 的 ABI / 16 KiB 对齐只在最终 APK
> 上验一次；签名 / badging / zipalign 各一次。`--check` 只用于单独检查已有快照。
> 细则见 `tools/AGENTS.md` 第 8 条 —— 不要为“保险”重复跑等价验证。

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
js/online-ui.js             登录 / 公告 / 安全提醒 / OnlineUI 门面（共享件在 OnlineUI._）
js/online-campaign.js       征战页（原版 3437）+ 报名 / 匹配 watcher / 掷骰
js/online-social.js         天梯对手 / 好友 / 邀请 / 论坛
js/online-settings.js       联机设置 / 账号弹窗 / 主人同步
js/campaign-data.js         征战首领表 / 门票 / 奖励池（浏览器与服务端共用）
js/tower-loader.js          无尽塔脚本 / 样式按需加载（首次进塔时才拉）
js/state.js 等              与单机版同源；联机差异全部挂在 __SSDZ_ONLINE__ 上
js/ui-base.js              共用界面基础件（toast / hitRegion / 图标 / favicon）

scripts/index-online.html   联机版唯一网页入口与脚本加载链（不含现代战斗 / 调试 / 单机页）

src-tauri/src/lib.rs        桌面命令注册（设备指纹 / 主人同步 / 一键打包）
src-tauri/src/shell.rs      轻壳：接管 tauri:// 协议，从仓库磁盘读页面（--features thin-shell）
src-tauri/src/client_update.rs  主人「一键同步更改」：下载完整包并整包替换
```

## 3. 三条不要破坏的约定

1. **服务器权威**：进度只由 `POST /api/action`（或 `/api/battle`）在服务端改。
   客户端 `State.save()` 是空操作；`gainExp/addGold/fightReward/recordBattle` 等发奖函数被替换成抛错。
   页面要发奖就跑服务端动作，不要绕过。
2. **动作分类**：`shared/actions.json` 里
   `sync`（确定性，可本地预测）由 `js/online.js` 自动包一层「本地算 + 上行确认」；
   `async`（含随机数）必须 `await Online.call('名字', …)`，**不许本地算**；
   `local` 只影响界面偏好。新增动作时先改这个 JSON，再改服务端执行器（一般不用改）。
3. **只有经典界面**：`UIMODES` 只有 `classic`、`switchMode` 恒拒绝、存档不写 `__dual*`。
   现代 canvas 战斗 / 调试入口 / 挑战塔**不在联机版**（对应文件已退役到 `reference/retired/`）；
   无尽塔是唯一保留的非原版 DOM 界面（村庄右上角小径，20 级解锁）。
   `js/debug.js` 只作为测试夹具保留，**不加载、不打包**。
   新增界面先查 `images/ssfight/ui/symbol-index.json` 有没有原版元件，**能复用就不要自绘**；
   原版没有的联机页（登录 / 设置 / 论坛）用经典配色自建，不要引入现代整屏图。

## 4. 验证

| 命令 | 守什么 |
|---|---|
| `node tools/test-online-api.cjs` | 服务器端到端：注册/登录/动作白名单/战斗/回放/天梯/好友/征战/静态 |
| `node tools/test-online-apprentice.cjs` | 联机师徒端到端：拜师人机 / 打师父收徒 / 真人日供 10%+10% / 逐出 / 出师 |
| `node tools/test-online-economy.cjs` | 联机版经济收口（任务/礼包/日贡/重开/商店/碎片合成/征战令） |
| `node tools/test-online-swap.cjs` | 防守视角交换：随机 200 场，交换两次必须回原值 |
| `node tools/test-online-creator.cjs` | 创作者设备白名单：浏览器端 / 注册名额 / 一机多号；普通设备仍受限 |
| `node tools/test-online-client.cjs` | 客户端会话生命周期 / 轻壳 / 战斗回放 / 征战页 |
| `node tools/test-online-api-surface.cjs` | 加载链里的 `State.<名字>` 都存在；融合价唯一真值 `fusionCostOf` |
| `node tools/test-state.cjs` | 数值规则（联机差异不该动它） |
| `node tools/test-ssfight-render.cjs` | 经典界面显示层 |
| `node tools/check-asset-paths.cjs` / `check-encodings.cjs` | 资源引用（已退役现代素材按前缀跳过）、文本编码 |

> **测试先静音**：安卓模拟器（`SSDZ_ONLINE_ABI=x86_64` 的测试包）一律带 `-no-audio` 启动，Chrome 带
> `--mute-audio`，桌面壳 / 真机先关系统媒体音量，测完恢复；只有要验音频才单独放开。
> 别用游戏内「静音」顶替 —— 那是持久化偏好（`ssdz-online-settings`），会留给下次打开的人。

> `test-ssfight-render.cjs` 2026-11-10 修过一次“假绿”：`checkConcurrentAssetLoad` 的失败重试请求没有应答，
> Promise 永不 resolve、事件循环空了就以 0 退出，约 40 项断言从未执行。现在它会真正跑完（含
> `checkDualSaveAndDebugGate` 的联机口径：只有 classic、加载链不引入 debug）。改这个套件前先确认它真的打印 PASS。

## 5. 文档与素材

- 经典界面维护：`js/ssfight/AGENTS.md` + 项目 skill `.agents/skills/classic-ui-maintenance/SKILL.md`。
- 变更日志只有一份：`docs/更新记录.md`（**最新批次在最上面**）。不要新增过程报告。
- 运行时素材在 `images/ssfight/ui/`；本机参考素材目录叫 **`reference/`**（单数；历史文档里写作
  `references/`，`check-*` 工具两种拼写都跳过）。它不进仓库、不被运行时依赖；
  `reference/retired/` 存放已退场素材（2026-11 起，附 `deadset.json` 清单），已加入 `.gitignore`。
- **2026-11-10 退役批次**：单机入口 / 现代 canvas 战斗 / 单机启动器 / 单机出包链 / 现代整屏图
  共 59 个文件、7.4 MB，移到 `reference/retired/2026-11-10-online-b0/`（`deadset.json` 有逐文件原因）。
  `js/debug.js` 与 `css/debug.css` 是**测试夹具**，保留但不加载、不打包（`build-online-app.cjs` 排除）。

## 6. 注释规范（唯一口径）

注释只写**代码本身表达不了的约束**，给下一个 agent 改代码时避坑；不写历史、不写用户原话、不写“这段在做什么”。

保留（一条最多 3 行，优先 `//`）：

- 不变量 / 调用顺序 / 唯一真值：谁必须先于谁、哪个字段只能有一个写入口。
- 跨文件耦合：改这里必须同步改 X。
- 平台或运行时坑：iOS / Android / WebView、缓存、异步生命周期、缩放与裁切。
- 数据来源：生成文件、服务端下发字段、原版元件号。
- 安全 / 权威边界：服务端权威、不可信输入、回放校验。

删除：

- `/* ===== */`、`/* ---- */` 横幅、章节号、【UC1】目录、Ctrl+F 索引。
- “以前 / 原来 / 旧版 / 用户 2026-xx 口径 / 报的 bug”等历史叙述和用户原话。
- 复述代码的 JSDoc / 行内注释、被注释掉的代码、过时引用。
- 面向人的排版说明、日期、署名、emoji 强调（`⚠` 只用于真陷阱）。

格式：

- 文件头最多 2 行：文件名 + 生成 / 不要手改（如适用）。
- 局部注释用 `//`；只有跨多行的契约才用 `/* */`，且不超过 3 行。
- 需要标签时用 `// TRAP:` / `// CONTRACT:` / `// WHY:`，不要自造标签。
- 改代码时顺手删掉不再成立的注释；注释与代码冲突时以代码为准，先改注释再改代码。
