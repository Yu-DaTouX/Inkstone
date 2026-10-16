# features/terminal（P3 / R2）

v3 右侧工作区的终端页。契约导出：

```ts
export function TerminalPane({ owner, visible = true }: TerminalPaneProps): JSX.Element
```

`TerminalPaneProps` / `WorkspaceOwner` 来自 `features/workbench/types.ts`（R0 唯一真源，本目录不修改）。

## 文件

| 文件 | 职责 |
| --- | --- |
| `TerminalPane.tsx` | React + xterm 表面：主题、ResizeObserver/缩放/DPR、复制粘贴与键盘、工具栏、错误/未激活态 |
| `terminal-session.ts` | **纯逻辑**控制器：owner 归属、create/attach/resize/write/exit、epoch 隔离、重试。无 React / xterm / DOM 依赖 |
| `terminal-theme.ts` | 从 `design/tokens.css` 解析 xterm 主题与字体；环境变化观察 |
| `terminal-text.ts` | v3 终端独有的窄文案（不新增 i18n 键） |
| `terminal.css` | `@layer features` 版面，只用 tokens |

## 接上的正式接口

- **归属**：`state/resource-owners.ts` 的 `resourceOwner` / `claimResource` / `releaseResource`，
  资源 id 形态 `terminal:<id>`。`owner.key` 只表达「挂在哪条会话旁边」，不是授权。
- **PTY**：`window.yan.terminal`（`available/list/start/write/resize/kill/attach`）+ `window.yan.onPush`
  的 `terminal` 通道（`data` / `exit` / `status`）。直接走 bridge，不经 store（原因见下）。
- **渲染复用**：`components/terminal/terminal-appearance.ts` 的纯渲染 helper
  （`installTerminalRenderer` / `ImeFallback` / `terminalFontReady`）与第三方 `@xterm/*`；
  不导入 v2 组件或 v2 CSS。
- **类型**：`shared/ipc.ts` 的 `TerminalSnapshot` / `TerminalStartRequest` 等，只读不改。

## 行为约定（合同 R2）

- **未激活**（`owner.active=false`）：不 create/attach/write/resize，也不接收推送，只显示「先激活」提示；`active` 恢复后才 attach。
- **隐藏**（`visible=false`）：只隐藏、不发 resize，**不 kill**；重新可见补一次当前尺寸。
- **卸载**：只本地 detach + 退订，不 kill；后台终端（含 agent-hub 工具 PTY）保留，下次 `attach` 接回。只有用户显式「结束」才 `kill`。
- **迟到消息隔离**：owner key/generation 变化即递增 `epoch`，异步 `start`/`attach` 回包核对 epoch 后才落地；推送按 `payload.id === 当前 terminalId` 过滤。快速切会话后旧终端的 `data`/`exit` 不会串进新终端。
- **启动失败**：壳 / cwd 失败或 attach 失败 → 可重试错误态，不把模块标成永久不可用；原生依赖不可用同样提供重试。
- **cwd**：只取 `owner.cwd`（同时作为 `fallbackCwd`），调用方没有塞任意根目录的入口。
- **归属筛选**：只显示 `resource-owners` 里记到本 owner 的终端；**不主动认领未登记终端**，避免误抓工具 PTY。

## 已知边界 / 需父会话接线

- 主进程 `yan:terminal:*` 没有 `detach` 与 owner 参数：`start` 只接受 cwd/cols/rows。
  因此「正式 owner 标识」是渲染端登记（`terminal:<id>` → owner key），不是后端字段。
  若将来要后端级 owner，需要父会话在 IPC / 主进程侧加参数。
- `store.startTerminal` 在 shell/cwd spawn 失败时会把 `terminalAvailable` 置 false（永久禁用）。
  本面板为避免该行为**不走 store**，自己调 bridge；`store.terminals` 不会登记本面板新建的终端。
  如需与 store 列表统一，请父会话调整 `startTerminal` 的失败分支。
- 多终端切换：本面板只显示 owner 下最后创建的一个终端（`pickOwnedTerminal`）。
  合同提到「动态页签（多个终端）可关闭」由 R0 面板管理；若 R0 需要暴露终端列表/选中回调，需在 `TerminalPaneProps` 上扩展 props（本目录不单方面改 types）。
- `components/terminal/terminal-appearance.ts` 目前仍在 v2 目录下；v2 组件退役时需把这三个纯 helper 迁到本目录或共享位置。

## 测试

```bash
node scripts/test-v3-terminal.mjs
```

esbuild 编译纯控制器 + 隔离 mock bridge，覆盖归属筛选、激活门控、迟到消息隔离、回放去重、resize 可见性、卸载不 kill、显式 kill、启动/能力失败可重试。不启动 Electron、不碰 node-pty、不发真实 shell 命令。
