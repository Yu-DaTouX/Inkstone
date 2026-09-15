# 砚（Yan）· 项目工作须知

> 这份文件会被 pi **自动加载进每次会话的系统提示**。唯一的例外是生成会话标题的
> 短任务 —— `src/main/title.ts` 给它显式传了 `--no-context-files`（连同
> `--no-skills` / `--no-prompt-templates`），不会读这份文件。
> 所以这里只放「每次都得知道」的东西。当前状态与待办统一放在
> `docs/dev/HANDOFF.md`，不要往这里堆 —— 它一长，每轮对话都在付这个成本。
> 历史决定从 Git 查看。

Electron + React + TypeScript 桌面端。pi 作为 `--mode rpc` 子进程提供模型循环与工具执行；
界面只是订阅层，**不直接 import pi 内部模块**。

## 一、动手前

1. 读 `docs/dev/HANDOFF.md` —— 当前决定、未完成项、验证基线（首要入口；排障经验见 docs/dev/MAINTENANCE.md）。
2. `docs/WORKSPACE.md` 用于定位代码与脚本；`docs/dev/TESTING.md` 是测试约定的单一真源。
3. `git status --short` 看现有改动，**保留它们**。

## 二、工作区铁律

- **不要**用 `git reset` / `checkout` / `clean` / `rm` 处理不相关的现有改动。
  工作区常年带着大量未提交修改 —— 那是在进行的工作，不是垃圾。
- `release/砚数据/` 是用户真实数据，**只读**；验证升级只能用它的备份副本。
- `resources/pi-runtime/` 是生成物（Git 忽略），**不手改**；换版本用 `npm run upgrade:pi`。
- `resources/pi-extensions/` 是**源码**（随包分发），可以改。两者不要混为一谈。
- `docs/design/preview/` 里的截图与 GIF 是用户视觉证据，不删不覆盖；要更新就另存新名。
- `启动-砚.cmd` / `开发-砚.cmd` 是用户双击入口，保留在根目录。
- `build/icon.ico`、`build/icon.png` 受版本管理，不要当缓存清理。

## 三、命令

| 命令 | 用途 |
|---|---|
| `npm run launch` / `launch:dev` | 启动应用 / 开发模式 |
| `npm run typecheck` | TS（node + web）+ CSS 约定 + CSS layer 自检 |
| `npm run build` | 构建 `out/` |
| `npm run test:unit` | 纯逻辑单测（**依赖 `out/`**，先 build） |
| `npm run test:live -- <场景>` | 单个真实 Electron 场景（场景名见 `scripts/test-live.mjs` 的 `CASES`） |
| `npm run check` | 全量门槛：typecheck + build + 单测 + vendor 校验 + 设计测量 + 配置中的 live 场景（很慢） |
| `npm run vendor:pi:check -- --if-present` | 校验内置 pi 能否启动、RPC 握手是否正常 |
| `npm run upgrade:pi` | 对比版本并按需重提取内置 pi（`--check` 只报版本） |
| `npm run dist:dir` / `test:packaged` | 解包目录 / 解包产物验收 |
| `npm run dist` / `dist:portable-fast` | Windows 安装包 / 便携 ZIP |
| `npm run probe:chrome` | 外部 Chrome 通道冒烟（无 Chrome 时跳过） |

### 三个会浪费时间或造成误判的坑

1. **`test:live` 不会自动构建。** 改完源码必须先 `npm run build`，
   否则你验的是旧 `out/`，现象会像"改动根本没生效"。
2. **跑 Electron 前确认环境里没有 `ELECTRON_RUN_AS_NODE=1`。** pi 运行时会注入它；
   带着它 `npx electron` 会当纯 Node 跑，报
   `does not provide an export named 'BrowserWindow'`，看着像启动失败。
3. **旧产物存在 ≠ 构建成功。** `out/`、`release/` 中有历史文件；
   下结论前确认时间戳是本次构建。

## 四、交付口径

本项目**不接受**"代码写完就算完成"。每个工程项要六栏齐备才能勾选：
**实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制**
（定义见 `docs/dev/ENGINEERING-CHECKLIST-2026-09-15.md` 第 6 节）。

静态 CSS、mock fixture、探针打印 `ok`、文件存在，都不能替代真实窗口或视觉证据。
先在 `docs/dev/HANDOFF.md` 的状态表里补齐证据，再改状态。

## 五、已确认的产品边界（不要改回去）

这些是用户明确拍过的决定。重新"修好"它们会被当成回归：

- **任务面板保持现状**：继续读取会话中的扩展任务清单，不重构，
  也不改造用户扩展来改变任务引导。
- **记忆模块已移除**：记忆存储、remember/recall/forget、记忆扩展和提示词注入都不恢复；
  用户遗留数据也不要顺手删。
- **旧会话树浏览链路（`get_tree`）是主动移除的**，不是缺失功能；
  不要重新实现，也不要再列进待办。
- **推理块默认展开但限高省略**：`--reason-max-h`（`min(32vh, 260px)`）、裁掉开头、
  `scrollTop` 贴底显示**最新**内容、顶部 mask 渐隐、「展开全部 / 收起」出口，
  **不引入第二条滚动条**。早期"不设固定高度、不用内部滚动"的方案已废止。
- **推理语言**：不注入"必须用某语言思考"之类的额外提示；界面语言只由
  `languageSystemPrompt()` 生成的一句 `--append-system-prompt` 约束，
  并且永远保留模型返回的原文。
- **登录只预留**：本地档案不得显示虚假的"已登录 / 已同步"状态。
  订阅制里只有 ChatGPT（`openai-codex`）能在应用内登录，其余必须走终端。
- 深浅主题、设置面板、模型接入 UI、Windows 打包、内置浏览器、本机 Chrome 接入
  **都已经实现**，不要再列为未开发项。

## 六、代码约定

- 主进程入口 `src/main/index.ts`；pi 协议集中在 `protocol.ts` / `agent.ts` / `normalize.ts`。
- 渲染端只能经 preload 和 `src/shared/ipc.ts` 调主进程、消费 `MainPush`。
- 分支 `entryId` 来自 `get_fork_messages`，不从 DOM 或归一化消息 id 猜测。
- 设计令牌**先改** `docs/design/DESIGN.md`，再同步 `src/renderer/src/styles/tokens.css`。
- grid 弹性列一律 `minmax(0, 1fr)`，否则长内容会撑破布局。
- `styles/` 里 `stage1` / `stage2` / `redesign` 等名字旧不代表无用；
  删除前核对导入顺序和动态类名。
- 注释写当前职责、边界条件和**为什么**，不写"本次改动"这类流水账。
- `tsconfig` 开了 `noUnusedLocals` / `noUnusedParameters`，未使用的声明直接报错。
- 内置浏览器是原生 `WebContentsView`，永远盖在渲染层之上；
  坐标换算必须乘 `win.webContents.getZoomFactor()`，否则非 100% 缩放时位置会偏。

## 七、测试约定

完整规则见 `docs/dev/TESTING.md`，要点：

- 三层：纯逻辑 `test:unit` ／ UI 接线 `test:live`（默认不调模型）／ 真行为（`cost: 1` 的场景）。
- 用 `YAN_USER_DATA`、`YAN_SESSIONS_DIR`、`YAN_DATA_DIR`、`YAN_PI_DIR` 隔离，
  **不要**在真实用户目录里造测试数据。唯一会读到的真实文件是 pi 自己的
  `~/.pi/agent/auth.json`（调模型要凭证，只读）。
- 会花钱/耗额度的场景：`tokens`、`conn`、`e2e`、`queue`、`ask`、`image`
  （`image` 还需要视觉模型）。默认用免费模型，换模型用 `YAN_TEST_MODEL`。
- 按 fixture 路径定位会话，不依赖会被模型重写的标题。
- 用条件轮询代替固定 `sleep`；布局测量等几何稳定后再读数值。

## 八、文档索引

| 文件 | 作用 |
|---|---|
| `docs/dev/HANDOFF.md` | **首要入口**：当前决定、未完成项、验证基线 |
| `docs/PROJECT.md` | **实现总览**：每个功能怎么实现的、要改它该动哪里、注意事项与索引 |
| `docs/dev/CODE-MAP.md` | 文件 → 功能 / 联动；含真实窗口实测数据（§11）与改动波及面速查（§9） |
| `docs/WORKSPACE.md` | 目录与脚本导航 |
| `docs/dev/ENGINEERING-CHECKLIST-2026-09-15.md` | 逐项工程清单与勾选口径 |
| `docs/dev/实施方案-2026-09-15.md` | 会话编排架构与分阶段方案 |
| `docs/dev/TESTING.md` | 测试约定的单一真源 |
| `docs/dev/MAINTENANCE.md` | 可复用的实现与排障经验 |
| `docs/dev/RELEASING.md` | Windows 打包、数据与发布门槛 |
| `docs/design/DESIGN.md` | 设计令牌与视觉规范 |
| `docs/README.md` | 文档总索引 |
| `docs/dev/STATUS-2026-09-14.md`、`docs/dev/WORK-PLAN-2026-09-14.md` | 历史盘点（日期快照，可能已被后续决定覆盖） |

文档维护规则：只记录**当前**决定、可操作待办和可复用经验。
历史性能数字、套餐价格、临时工具路径、被后续实现推翻的决策，不作为当前事实保留。
