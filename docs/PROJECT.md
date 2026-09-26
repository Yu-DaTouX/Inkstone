# 代码导览

[架构简介](ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md)

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程入口与宿主集成 |
| `src/main/agent.ts` | 模型运行与 pi 交互 |
| `src/preload/index.ts` | 渲染端可用的宿主接口 |
| `src/shared/ipc.ts` | IPC 契约与类型 |
| `src/renderer/src/components/` | React 界面组件 |
| `src/renderer/src/components/workbench/` | 日常模式的中栏视图：工作台首页、空间工作台（概览 / 资料 / 成果 / 学习）与会话地图（`WorkbenchHome.tsx` / `SpaceWorkbench.tsx` / `SpaceOverview.tsx` / `LibraryView.tsx` / `ArtifactView.tsx` / `LearningView.tsx` / `SessionMap.tsx` / `SessionPreview.tsx`） |
| `src/shared/space.ts` + `src/main/space-store.ts` | 主题空间：非 Git 的会话归属与项目关联 |
| `src/shared/library.ts` + `src/main/library-store.ts` / `library-parser.ts` / `library-service.ts` | 资料库：唯一事实源、版本绑定与解析 |
| `src/shared/activity-flow.ts` + `src/shared/context-assembly.ts` / `src/main/context-assembler.ts` | 活动流程与建任务阈值、按活动的上下文装配（引用可回原文） |
| `src/shared/artifact-doc.ts` + `src/main/artifact-doc-store.ts` | 可编辑成果：版本推进、「用户改过的段落不被 agent 整篇覆盖」、结构化清单（Markdown 任务列表）、引用回原文与导出 Markdown |
| `src/shared/course.ts` + `src/main/course-store.ts` / `course-service.ts` | 课程与路线：三条入口（资料 / 主题 / 卡点）、材料与补充的强制区分、单元顺序调整 |
| `src/shared/study.ts` + `src/main/learning-store.ts` / `learning-service.ts` | 学习状态与继续：阶段推进（进等待要问题、出等待要作答）、`waiting_for_learner` 持久化与续跑闸门 |
| `src/shared/conversation-turns.ts` | 轮次投影（一轮问答 = 一个块），会话地图的轮次级基础 |
| `src/shared/session-map.ts` | 会话地图纯投影（泳道 / 深度 / 边 / 折叠） |
| `src/renderer/src/state/` | 会话状态与事件投影 |
| `src/renderer/src/styles/` | 样式、令牌与主题 |
| `resources/pi-extensions/` | 随包 pi 适配 |
| `resources/yan-cli/` | 本机能力 CLI |
| `scripts/` | 启动、构建、检查与截图工具 |
| `scripts/design/` | 图标生成、原型检查及 CSS 生成清单 |
| `scripts/audit/` | 仓库审计工具 |
| `build/` | 应用图标与打包资源 |
| `docs/assets/inkstone/` | 公开品牌与主页图片 |

`resources/pi-runtime/`、`out/`、`release/` 是运行时或构建产物目录，按生成流程维护。`Yan`、`yan` 与 `YAN_*` 是现有工程标识；公开品牌名为 Inkstone（砚）。

## 后续 agent 的资料入口与操作边界

1. 先读根目录 [AGENTS.md](../AGENTS.md)，再读 [贡献指南](CONTRIBUTING.md) 和当前任务涉及的源码；公开文档入口是 [docs/README.md](README.md)。
2. 维护者本地的 `docs/plan/`、`docs/design/`、`docs/archive/` 与大部分 `docs/dev/` 是已忽略的内部资料。它们可能存在，也可能在新克隆中缺失；不作为构建、贡献或理解当前实现的前置依赖。
3. 内部资料按需只读参考，不能把旧计划当作当前执行授权。旧文档的“先读 HANDOFF / 实施计划 / 回填阶段表”不再覆盖根 AGENTS 的新规则。
4. 已忽略不等于允许删除。保留本地原文、截图与用户数据；不要重新跟踪内部目录、不要强制添加或改写 Git 历史。
5. 本轮原文备份与移出索引清单位于本地 `.local-docs/public-cleanup-2026-09-24/`；完整的内部资料仍在原目录。新的过程记录放在本地忽略目录中。
6. 对外提交只包含用户授权的相关改动；先查看工作区与暂存区，保留其他任务的未提交代码。目录或文档边界变更时同步 AGENTS、PROJECT、文档索引与 README。
