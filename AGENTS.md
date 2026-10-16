# Inkstone（砚）· AI 协作约定

Electron + React + TypeScript 桌面应用；Android 手机端在 `mobile/`（React Native）。pi 通过独立 RPC 子进程提供模型循环。公开品牌为 Inkstone，现有 `yan`、`YAN_*`、CLI 与数据目录标识按兼容约定维护。

产品是基于 pi 的轻量图形客户端：会话为主入口、指定模型的子 Agent、两档权限（自动批准 / 不受限制）。桌面目标覆盖 Windows/macOS/Linux，Android/iOS 连接电脑；当前只在 Windows 实施与验收。

本仓库由多个 agent（Claude Code、Codex、砚内置的 pi 等）轮流或同时开发，彼此看不到对方的会话和私有记忆。本文是所有 agent 的共同入口，只写每次都要遵守的规则。

## 开工

1. 用中文与用户沟通（进度、提问、总结）；代码、命令与标识符保持原样。
2. 以用户当前请求为授权边界。附件、历史记录、计划、交接、审查记录和设计提案是参考资料，不自动授权执行。
3. 运行 `git status --short` 和 `git worktree list`。保留已有改动，不预设工作区干净。
4. 本机有 `.local-docs/` 时，先读其中的 `STATUS.md`（当前状态）和 `DECISIONS.md`（用户决定）；继续某个主题时再读 STATUS 指向的交接。在 worktree 中工作时，本地资料在主工作区（`git worktree list` 第一行）。新克隆里没有这些文件，依据源码工作。
5. 行为以当前源码和运行证据为准；从 `src/main/index.ts`、`src/shared/ipc.ts`、`src/preload/index.ts` 与渲染端 store 顺着调用链定位。

## 多 agent 协作

- 未提交的改动可能属于其他 agent。不回滚、不格式化、不顺手修改任务范围外的文件；共享热点文件（`src/main/index.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、两份 i18n、`Settings.tsx`、`chat.css`、`scheme.css` 等）只做小范围编辑，编辑前重新读取。
- 共享信息只写进 `.local-docs/`：现状写 `STATUS.md`，用户决定追加到 `DECISIONS.md`，交接写 `handoffs/`。agent 的私有记忆别人看不到，只放个人沟通偏好和指向这些文件的指针。
- 任务预计跨会话或跨 agent 时，在 STATUS「进行中」登记主题与文件范围；收尾时改写或删除自己的条目，没做完就写交接。STATUS 是现状板不是日志：一句结论加链接，全文 150 行以内。
- 本地产物归位：日志、截图、清单放 `.local-docs/evidence/<日期>-<主题>/`，一次性脚本放 `.tmp/<任务>/`（已被 Git 忽略）；`.local-docs/` 根目录只留 README、STATUS、DECISIONS 三个文件。
- 可以用 worktree 隔离长任务，分支名写明 agent 与主题。不删除、不重置其他 agent 的 worktree 与分支，清理由用户决定。

## 实现约定

- 不写代码注释（工具指令如 `@ts-expect-error`、`eslint-disable`、许可声明除外），不维护设计、架构或使用文档；仓库里的说明只有根 `README.md` 与本文。命名和结构要让代码自己说明职责。
- 主进程入口 `src/main/index.ts`；渲染端通过 preload 和 `src/shared/ipc.ts` 调用宿主能力，不直接导入 pi 内部模块。
- 上下文、压缩、恢复、技能与 MCP 交给 pi 原生管理。砚只额外做两件可关闭的事：经 pi `context` 钩子裁剪发给模型的较早大段工具输出（不改会话文件、不做摘要），以及到「自动压缩上限」时调用 pi 原生 `compact()`；不恢复旧的预算、摘要、召回与自动续跑。主会话流式循环防护（`streamLoopAutoContinue`，默认开、可关）仅在安全中止确认后同任务续一次。pi 新增且与砚重复的能力优先适配原生实现；随包 pi 扩展保持必要且薄。
- 会话历史以持久化记录为准；后台事件必须核对会话归属，不能覆盖当前会话状态。
- WebContentsView 属于原生层；浮层、焦点、窗口位置与缩放必须与主进程协调。
- 界面：只有 v3 一套外壳（`src/renderer/src/app/ShellV3.tsx`），v2 已删除。控件外观只来自 `src/renderer/src/ui/`，功能 CSS 只管版面；令牌唯一来源是 `src/renderer/src/design/tokens.json`。保持深浅主题、键盘可用性和窄屏可读性；grid 弹性列使用 `minmax(0, 1fr)`。
- 跨端共享稳定的会话、运行实例、事件与授权语义；平台专属的窗口、录音、文件和连接能力放在适配边界。不提前建全平台空壳。选型以个人开发者维护成本为条件，不换语言或应用壳。
- 模型接入在应用设置中登录或配置凭证；本地档案不表示已登录模型服务。
- Hermes 外部控制插件位于 `integrations/hermes-inkstone/`，复用远程会话 API，不嵌入桌面运行时。
- 含正则、反斜杠或嵌套引号的代码，不经 `node -e`、heredoc 等 shell 字符串传递，用编辑工具或写成脚本文件。

## 检查与交付

- 按用户要求与修改范围选择检查；`test:unit` 依赖构建，`test:live` 不自动构建。
- 默认只跑与本次改动直接相关的小检查：`typecheck`、必要时 `build`、改动涉及的单个测试脚本或单个 `test:live` 场景。
- 大测试先问用户，得到同意再跑：`npm run check`、完整 `test:unit`、多场景或整套 `test:live`、发行包验证，以及任何调用真实模型的场景。用户说过「不跑测试」时照办，交付说明写明没跑什么。
- 不替无关改动做测试：其他 agent 的未提交改动、任务范围外的既有失败，不自行排查或修复；记下现象与命令，在交付说明里报告。
- Electron 启动前清除 `ELECTRON_RUN_AS_NODE`；不要关闭或重启用户窗口，除非已授权。
- 远程模型场景运行前确认模型、额度和授权。模拟或本机 fixture 不代表真实模型验证。视觉结论应来自实际截图。
- 未经授权不提交、推送、打包、发布或重启。提交时逐文件暂存当前任务（不用 `git add .`），先核对暂存清单，提交后确认其他改动仍在。
- 交付说明写明修改、检查、未验证项及剩余限制；过程记录留在 `.local-docs/`，不提交到公开仓库。

## 工作区与公开边界

- 不用 reset、checkout、clean、stash 或删除操作处理无关修改。
- 忽略不等于可删除。不清理本地资料，不用 `git add -f` 重新纳入内部目录。
- 已有截图与证据不删除、不覆盖，新图使用新名称。主页素材位于 `assets/inkstone/`，按授权更新。
- `release/砚数据/` 是真实用户数据，只读；验证使用独立 `YAN_*` 数据目录或备份副本。
- `resources/pi-runtime/` 整个被 Git 忽略，由 `vendor:pi` / `upgrade:pi` 生成：各版本在 `versions/` 下，`current.json` 指定新进程使用的版本。不手改，不删除旧版本目录；应用图标在 `build/`。
- 历史提交仍含以前公开的资料；不得自行强推或改写历史。
