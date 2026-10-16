# Inkstone 品牌设计真源

`inkstone-design.json` 是**唯一设计真源**：几何 SVG、16/24 像素 mask（`frame` /
`prompt` / `question` 分层）、配色、透明度与缓动、各状态四段时长都只在这里定义。
平台中立的纯数据，可版本控制、可评审；脚本与 runtime 不重复手写这些值。

## 生成与校验

| 命令 | 作用 |
| --- | --- |
| `npm run icon` | 生成 `build/prompt-stone.svg`、`build/icon.png`、`build/icon.ico`、`build/tray/`（静态托盘 + 去重动画帧 + `manifest.json`）、`src/shared/brand-geometry.ts` |
| `npm run icon -- --check` | 只校验产物与真源一致，不写任何文件 |
| `node scripts/test-brand-assets.mjs` | 核对真源结构 / mask 逐格 / 750-1500ms 时间线 / 各 DPI / manifest / 石框逐帧不变 |
| `node scripts/test-v3-tray-animation.mjs` | 托盘播放器（虚拟时钟、状态切换、减少动态、timer 清理、跳帧、常量缓存、缺素材回退） |

`build/prompt-stone.svg` 与 `src/shared/brand-geometry.ts` 是生成物，不要手改。
`build/` 除少数静态文件外被 `.gitignore` 忽略，托盘与图标位图都是可复现生成物；
设计真源本身可跟踪，公开构建只依赖真源 + `npm run icon`，不读本地资料或主工作区。

## 状态规则（摘要，完整版见 `docs/DESIGN_SYSTEM.md` §3.4.1）

- 托盘点单色、无状态点、外框不动；符号颜色不承担语义。
- `idle`：`>_` 静态高亮。
- `running`：`>_` 柔和闪动，周期 750ms（亮 300 / 缓降 125 / 暗 200 / 缓升 125）。
- `waiting`（**需要用户操作 / 确认**，不是普通网络等待）：`?` 柔和闪动，周期 1500ms（亮 600 / 缓降 250 / 暗 400 / 缓升 250）。
- 优先级 `waiting > running > idle`；`failed` / `done` 不新增闪动符号。
- 减少动态效果时符号保留、静态高亮，tooltip / 可访问文字仍区分状态。
