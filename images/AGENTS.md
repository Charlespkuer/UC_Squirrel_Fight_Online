# images/ 入口（图像素材）

按用途分区：`ui/`（按钮 / 卡片 / 数字 / 界面块）、`atlas/`（图集）、`battle/`
（`fx/` 战斗特效）、
`ssfight/`（经典模式）。**运行期只有这四个目录**。

- 运行时按硬编码路径取图（`js/gamedict.js`、引擎与经典界面里都有 `images/...` 字面量）——
  改目录名 / 挪文件前先跑 `node tools/check-asset-paths.cjs` 看引用会不会断。
- `ssfight/ui/` 是 `tools/gen-ssfight-ui.cjs` 从原版导出的素材：导出物，别手改 —— 改生成器或源码再重导。
- `ssfight/ui/bitmap/` 的 1x 原件归档在 `reference/.bak-upscale/`（有 `.hd.jpg|.hd.png` 时生成器不再落 1x）。
- `ssfight/ui/bitmap/*.webp` 是 3182/6835 的 WebP 派生件（页面优先加载，同名 JPG 保留回退）；
  重新导出素材后按 quality 82 / method 6 重生成，别手改像素。
- **退场素材**：2026-11 把现代界面时代留下的、运行期零引用的图（原 `classic/` 整棵 973 张、
  `ui/skins/`、`ui/sprites/` 里没被拼到的切图、`ui/characters/*-card.png` 等）统一移到了
  `reference/retired/2026-11-08/`（保留原相对路径 + `deadset.json` 清单）。
  2026-11-11 又清了一批零引用图（`atlas/fightBg_seaWorld_*`、`battle/fx/crit.png`、
  `ui/characters/woodman.png`、`ui/numbers/shuzi.png`、`ui/sprites` 里未接线的
  `draw-0/50`、`resource_16-3` 与 46 张 `resource_6-*`）到
  `reference/retired/2026-11-11-assets/`，同样保留原相对路径 + `deadset.json`。
  同日再清 **483 个文件 / 24.0 MiB** 到 `reference/retired/2026-11-11-vector-assets/`：
  21 张联机不加载的 atlas、8 张按钮切图、2 张旧角色头像、13 张掉落/竞技场 sprite、
  315 张现代 canvas 穿戴层（`battle/outfit`），以及 124 张已有同名 SVG 的
  prop/weapon/skill 图片。那里是**归档**：不进仓库、
  不进发布包，运行时也不再读；要复活某张图，先拷回对应素材目录再改代码。

截图 / 对比图一律写 `out/`。
