# 松鼠大战 Online（联机版）

服务端权威的《松鼠大战》怀旧复刻联机版：**客户端只负责显示和发送动作**，等级、装备、战斗、
掉落、天梯、征战、师徒与每日进度全部由服务器计算并落库，客户端不能本地发奖。

- 线上网页版：`http://140.143.142.110:5896/`（手机 / 平板 / 电脑浏览器直接玩，无需安装；进度与客户端互通）
- 线上 API：`http://140.143.142.110:5896/api/health`（部署见 [docs/服务器与部署.md](docs/服务器与部署.md)）
- 本仓库**只包含联机版**；单机版在 `E:\Squirrel_Fight`
- 当前只开放**经典界面**（原版 ssfight 元件渲染）；现代首页 / 现代 canvas 战斗 / 挑战塔不在联机版

## 快速开始

需要 Node 24（服务端用内置 `node:sqlite`）。

```powershell
# 起联机服务（静态页 + /api，默认 127.0.0.1:3100）
node server/index.js

# 浏览器打开
#   http://127.0.0.1:3100/        → 联机版入口 scripts/index-online.html
```

同源访问时 `js/net.js` 自动用 `/api`；分离部署时：
`Net.configure({ base: 'http://<host>:3100' })`，或写 `localStorage['ssdz-online-base']`。
客户端地址由 `src-tauri/online-api.json` 的 `base` / `fallbacks` 决定，启动时会并行探测。

## 构建客户端

两种产物共用同一份源码：

- **轻壳**（开发机，仓库根 `squirrel_fight_online.exe`，几 MB）：
  `node tools/build-online-app.cjs --shell`。不带前端快照，启动时由 `src-tauri/src/shell.rs`
  接管 `tauri://` 协议从仓库目录读 `js/ css/ images/` —— **改代码刷新窗口即可**。
- **完整包**（给玩家，`src-tauri/dist/squirrel_fight_online.exe`）：
  `node tools/build-online-app.cjs`。前端快照与清单编进 exe，裸机可跑。
- `src-tauri/dist` 只保留最新一版 APK（同版本 arm64/x86_64 一起留）和最新一个 EXE，IPA 全部保留；
  出包成功后由 `tools/prune-dist.cjs` 自动清理旧版本。

其它平台：

```powershell
node tools/build-online-apk.cjs                 # 安卓 arm64 正式包
$env:SSDZ_ONLINE_ABI='x86_64'; node tools/build-online-apk.cjs   # 本机模拟器测试包
node tools/build-online-ios.cjs                 # iOS（需要已配对的 Mac + scripts/sync 服务）
```

`--web` 只生成前端快照 + `server/web-manifest.json`；`--check` 只校验已有快照。
不要在一次构建里重复跑等价的哈希/对齐验证（见 `tools/AGENTS.md` 第 8 条）。

## 测试

```powershell
node tools/run-tests.cjs --jobs 4      # 35 个套件，4 路并行约 44s
node tools/check-asset-paths.cjs       # 资源引用 / 大小写 / 断链
node tools/check-encodings.cjs         # UTF-8 与 .ps1 BOM
```

联机专属套件：`test-online-api` / `test-online-apprentice` / `test-online-campaign` /
`test-online-client` / `test-online-combat-rules` / `test-online-creator` / `test-online-economy` /
`test-online-swap` / `test-online-tower` / `test-online-api-surface`（State 接口面 + 融合价唯一真值）。

## 目录

```
server/                 服务器权威（HTTP 入口、SQLite、动作白名单、战斗/天梯/征战/师徒/论坛）
shared/actions.json     动作白名单（mode=async|sync|local），客户端从 /api/meta 拿同一份
js/                     客户端游戏代码
  net.js                唯一网络出口（令牌 / 超时 / 全局串行队列）
  online.js             权威镜像 + 动作流水线 + State 口子收口
  state.js sim.js ...   与单机版同源的数值内核（服务端也加载这几支）
  ssflight/             经典界面渲染器 + 13 个页面模块
  ui-base.js            共用界面基础件（toast / hitRegion / 图标）；原现代页 ui.js 已退役
scripts/                联机入口（start-online / build-online）、双机同步
src-tauri/              轻壳 / 完整包 / 安卓 / iOS 外壳与设备指纹
images/ssfight/ui/      原版导出素材（运行时唯一的经典界面素材来源）
reference/              本机参考资料（不进仓库）；retired/ 存已退役文件与 deadset.json
```

## 三条不能破坏的约定

1. **服务器权威**：进度只由 `POST /api/action`（或 `/api/battle`）在服务端改；客户端
   `State.save()` 是空操作，发奖函数被替换成抛错。
2. **动作分类**：`sync` 动作本地预测 + 上行确认；`async` 动作必须 `await Online.call(...)`，
   不许本地算；`local` 只影响界面偏好。
3. **只有经典界面**：`UIMODES` 只有 `classic`，`switchMode` 恒拒绝，存档不写 `__dual*`；
   新增界面先查 `images/ssfight/ui/symbol-index.json` 有没有原版元件。

## 文档

- [AGENTS.md](AGENTS.md)：项目入口、模块地图、验证与部署要点
- [docs/联机实现方案.md](docs/联机实现方案.md)：协议与架构决策（§11 起为准）
- [docs/服务器与部署.md](docs/服务器与部署.md)：部署、安全与排障
- [docs/奖励与经济.md](docs/奖励与经济.md)：经济口径
- [docs/更新记录.md](docs/更新记录.md)：唯一的变更日志

## 许可

本项目以 [MIT License](LICENSE) 发布，Copyright (c) 2026 Charlespkuer。

本项目是《松鼠大战》（UC 乐园）的同人复刻：与原作者 / 原厂商无隶属或授权关系；原作素材
（名称、角色、美术、音频、原始数值数据）版权归原厂商所有，不在 MIT 许可范围内，权利人要求时
会立即下架或调整。

## 退役说明（2026-11-10）

单机网页入口、现代 canvas 战斗、单机启动器、单机出包链与现代整屏图已移到
`reference/retired/2026-11-10-online-b0/`（逐文件原因见该目录 `deadset.json`）。
`js/debug.js` 与 `css/debug.css` 作为测试夹具保留，但不加载、不打包。
