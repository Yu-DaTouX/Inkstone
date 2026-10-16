# R4 · 改动页（`features/changes`）

右侧工作区的「改动」页。**首版只读**：只查 Git 状态与未跟踪文件，不暂存 / 不还原 /
不提交 / 不推送 / 不删除，从不调用 `window.yan.git.action`。

## 导出

```ts
export function ChangesPane(props: ChangesPaneProps): ReactElement
```

| prop | 说明 |
| --- | --- |
| `owner` | R0 `WorkspaceOwner`（`ChangesOwner` 是它的别名），必须带 `cwd`。 |
| `gitSource?` | 只读 Git 数据源；缺省包住正式 `window.yan.git`（含 `yan:git:changes` 逐文件通道）。 |
| `loadPatch?` | 按路径读单文件补丁；缺省走正式 `yan:git:diff`，也可注入替身返回 `ChangesPatch`。 |
| `lang?` | 文案语言，缺省中文。 |
| `className?` | 追加版面类。 |

## 行为

- 按 `owner.cwd` 读 `yan:git:state`（聚合状态）与 `yan:git:changes`（逐文件条目）。
- 选中文件后按 `loadPatch` 读 `yan:git:diff`：已暂存 + 未暂存两个真实片段拼接，
  未跟踪文件给安全的新文件补丁；二进制只回说明行，超大按行截断并标注。
- 请求带序号闸门：owner 变化（`key` / `cwd` / `generation`）或组件卸载后，旧响应被丢弃。
- 非 Git 目录 → 明确提示；Git 缺失 / 失败 → 明确提示，**不自动安装**。
- `owner.active === false` 仍可只读查看，但顶部显示「未激活」提示。

## 数据来源

- 逐文件条目走 `yan:git:changes`（返回 `GitChangesResult`）；只有在宿主**没有**这条通道时，
  才退回只列未跟踪文件并写明「未提供」。
- 单文件补丁走 `yan:git:diff`（返回 `GitDiffResult`）；读取失败在界面上说明，
  不静默装空列表，也不伪造数据。
- 逐文件通道已含未跟踪文件；有它时不再单独调 `yan:git:untracked`（那条返回仓库根相对
  路径，授权范围收窄到子目录时会把范围外文件也列出来）。

## 授权与只读边界

- `yan:git:changes` / `yan:git:diff` 的目录授权复用主进程的 `resolveFileContext`；
  仓库根会再授权一次，用户只授权子目录时读取范围收窄到该子目录。
- 命令形状固定在主进程，`--no-ext-diff --no-textconv --no-color`、
  `--literal-pathspecs`、`--` 与只读开关（`GIT_OPTIONAL_LOCKS=0`）都在主进程。
- 面板**从不**调用 `window.yan.git.action`；没有写按钮。
