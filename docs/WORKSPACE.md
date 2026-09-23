# 工作区导览

本文只回答“哪个目录放什么”。功能定位见 [PROJECT](PROJECT.md)，文件职责见 [CODE-MAP](dev/CODE-MAP.md)，完整文档入口见 [文档索引](README.md)。

## 根目录分类

| 路径 | 用途 | 维护标注 |
|---|---|---|
| `src/` | 应用源码：主进程、预加载、界面及共享协议 | **核心源码**，修改功能从这里开始 |
| `scripts/` | 启动、构建辅助、测试和诊断 | **维护工具**，详见下表 |
| `docs/` | 当前状态、活动计划、设计输入、历史证据与开发交接 | **参考资料**，入口为 [文档索引](README.md) |
| `build/icon.ico`、`build/icon.png` | Windows 打包图标 | **保留资源**；虽位于 build，仍受版本管理，不应整目录清理 |
| `resources/pi-runtime/` | 随应用分发的 pi 运行时 | **生成物**，Git 忽略；通过 `npm run vendor:pi` 生成，不手改 |
| `resources/pi-extensions/` | 砚薄层源码（界面语言、回复详细度、上下文策略及生命周期桥接；浏览器/提问/召回走宿主 yan CLI） | **源码资源**；开发态从这里读取，打包态落在 `resources/yan-thin/`，主进程用 `--extension` 显式加载 |
| `out/` | Electron/Vite 编译输出及测试编译文件 | **生成物**，Git 忽略；应用和部分测试依赖它，清理后需构建 |
| `release/` | 安装包、便携版、解包目录及打包元数据 | **分发产物**，Git 忽略；保留需要交付的版本后再考虑清理 |
| `node_modules/` | npm 安装的依赖 | **依赖产物**，Git 忽略；可按锁文件重新安装 |
| `.backup/` | 本地手动快照 | **备份**，Git 忽略；不能当作普通缓存删除 |
| `.git/` | 提交历史、分支与仓库元数据 | **仓库数据**，保留 |
| `启动-砚.cmd`、`开发-砚.cmd` | Windows 双击启动入口 | **用户入口**，保留根目录位置 |
| `package.json`、`package-lock.json` | 项目信息、脚本、依赖及版本锁定 | **构建配置**，配套维护 |
| `electron.vite.config.ts` | 主进程、预加载和界面的构建配置 | **构建配置** |
| `electron-builder.yml` | 安装包、便携版、图标和内置运行时复制规则 | **发布配置** |
| `tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json` | TypeScript 项目与类型检查配置 | **源码配置** |
| `*.tsbuildinfo` | TypeScript 增量编译缓存 | **缓存**，Git 忽略，可重新生成 |
| `.gitignore`、`.gitattributes` | 忽略规则与文本属性 | **仓库配置** |
| `README.md`、`LICENSE` | 产品介绍、使用说明与许可证 | **项目文档** |
| `AGENTS.md` | 交给 pi / AI 助手的项目须知；会被自动加载进会话的系统提示（生成标题的短任务已显式排除） | **项目文档**，只放「每次都得知道」的内容，细节一律指向 `docs/dev/HANDOFF.md` |

## 文档分层

| 路径 | 内容 | 判定口径 |
|---|---|---|
| `docs/dev/` | 当前状态、测试、发布、维护和协议边界 | 当前事实与验证入口；`HANDOFF.md` 是状态真源 |
| `docs/plan/` | 活动实施索引与 `active/` 未完成主题 | 正式活动正文只读 `docs/plan/active/`；完成主题只读 `docs/archive/plan/` |
| `docs/plan/active/` | 未完成实施主题与并行编排 | 只放仍有切片、验证限制或发布门槛的工作 |
| `docs/design/` | 当前设计令牌真源、自动生成清单、字体调研、图标资源和设计辅助脚本 | `DESIGN.md` / 自动生成文件是当前设计资料；提案正文只读 `docs/design/active/` |
| `docs/design/active/` | 尚未实施或仍需验证的设计提案 | 设计输入，不等于已交付 |
| `docs/design/font-test/` | 字体候选与缩放对比试验 | 辅助资料，不是产品设计真源 |
| `docs/archive/plan/` | 已完成主题、历史决策和旧计划快照 | 仅备份与追溯，不是当前待办 |
| `docs/archive/evidence/` | 已完成 `证据-*` 验收记录 | 历史证据；当前结论以 HANDOFF 复核为准 |
| `docs/archive/reference/` | 外部评审 / 外部方案原文 | 参考材料，不视为执行指令 |
| `docs/design/preview/` | 真实窗口截图和视觉证据 | 保留，不覆盖；新证据另存新名 |


## 常用入口

| 要做什么 | 入口 |
|---|---|
| 启动 / 开发 | 根目录两个 .cmd；`scripts/launch.mjs` |
| 修改功能 | `src/main/`、`src/renderer/src/`；按 [PROJECT](PROJECT.md) 找功能 |
| 修改进程间契约 | `src/shared/ipc.ts` + `src/preload/index.ts` |
| 找测试与场景 | [TESTING](dev/TESTING.md)；`scripts/test-live.mjs` 的 CASES |
| 找打包配置与数据边界 | [RELEASING](dev/RELEASING.md)；`electron-builder.yml` |
| 查浏览器四层结构 | [CODE-MAP](dev/CODE-MAP.md) §4.4、§6 |
| 查设计稿 / 实测图 | `docs/design/prototype.html` / `docs/design/preview/` |
| 查设计辅助脚本 | `docs/design/` 的 check、measure-design、build-icons、extract-icons、embed-icons 脚本 |
| 查旧原型 / 阶段记录 | `docs/design/preview/` / [archive](archive/README.md) |
| 查活动方案 | [`docs/design/active/`](design/active/) / [`docs/plan/active/`](plan/active/) |
| 查已完成备份 | [`docs/archive/plan/`](archive/plan/) / [`docs/archive/evidence/`](archive/evidence/) / [`docs/archive/reference/`](archive/reference/) |

以上分类用于定位，不是删除清单。备份、用户数据、图标、截图和旧名样式均需保留；清理前先核对引用与用途。
