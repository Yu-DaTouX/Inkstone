# R4 · Diff 视图（`features/diff`）

通用**纯 UI** diff 组件与纯逻辑解析器。给它一段统一 diff 文本就能渲染，不关心数据
来自哪里（`git diff`、工具结果里的 patch、宿主以后的 diff 通道都一样）。

## 导出

```ts
export function DiffView(props: DiffViewProps): ReactElement
```

`DiffViewProps`：`patch`（统一 diff 文本）、`title?`、`mode?` / `defaultMode?` /
`onModeChange?`、`context?`（折叠保留行数，默认 3）、`showFileHeader?`、`lang?`、
`className?`、`maxBytes?`。

纯逻辑（`features/diff/pure.ts`，无 React / DOM / IO，供单测复用）：

```ts
parsePatch(text): { files: DiffFile[]; preamble: string[] }
alignHunk(lines): DiffSideRow[]
wordDiff(oldLine, newLine): WordDiff
foldLines(lines, keep?): FoldRow[]
DIFF_LIMITS, byteLength, formatBytes, isBinaryPatch, patchExceedsLimit, patchExceedsHardLimit
unquotePath(path)  // 还原 git 的引号 / 八进制路径
```

## 能力

- **统一 / 并排**两种视图；并排视图对成对的删 / 增做**词级差异**高亮（纯 LCS，无新依赖）。
- **红删绿加**，保留原始符号；行号只取补丁里真实写着的（缺 `@@` 头时留空），
  增删统计只数实际的 `+` / `-` 行。
- **折叠未改动段**，可逐段展开。
- **hunk 上下跳转**，显示「第 X / N 处改动」。
- 长补丁（行数 ≥ 阈值）用 **virtua** 虚拟列表。
- **二进制 / 超大内容明确降级**：二进制文件显示一行说明；超过软上限默认不渲染正文，
  可手动「仍然渲染」（超过硬上限则拒绝）。

## 测试

`node scripts/test-v3-diff.mjs` —— 用 esbuild 打包 `pure.ts`，在系统临时目录里造
合成补丁，验证解析 / 对齐 / 词差 / 折叠 / 降级。不启动 Electron、不跑真实 git、
不碰用户仓库。
