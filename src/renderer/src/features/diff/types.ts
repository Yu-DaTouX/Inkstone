/**
 * Diff 视图的数据模型（纯类型，无 IO / 无 React）。
 *
 * 与 `shared/git.ts` 的分工：那边是**仓库状态**的解析器（status / refs），
 * 这里是**补丁文本**的解析结果。两者都只做「把 git 的输出变成结构化数据」，
 * 不碰 IO，因此能被 `scripts/test-v3-diff.mjs` 直接喂字符串测。
 */

/** 一行在补丁里的角色。`context` 是未改动行，来自 hunk 里的空格前缀。 */
export type DiffLineKind = 'add' | 'del' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  /** 去掉行首 `+` / `-` / 空格 之后的正文（保留行内空白）。 */
  text: string
  /** 原始整行（含前缀），导出/复制时用。 */
  raw: string
  /** 旧文件里的行号；新增行没有（`null`），**不用 0 冒充**。 */
  oldLine: number | null
  /** 新文件里的行号；删除行没有（`null`）。 */
  newLine: number | null
  /** `\ No newline at end of file` 之类，挂在它前面那一行上。 */
  noNewline?: boolean
}

export interface DiffHunk {
  /** 原始 hunk 头，例如 `@@ -1,3 +1,4 @@ fn name`。 */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** hunk 头尾部的函数/区段提示，没有就是空串。 */
  section: string
  lines: DiffLine[]
}

export interface DiffFile {
  /** 新侧路径（`b/` 前缀已剥掉）；删除文件时是旧路径。 */
  path: string
  oldPath?: string
  /** 从实际 +/- 行数出来的，不用 hunk 头里的计数冒充。 */
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** `Binary files … differ` / `GIT binary patch`：没有可渲染的文本行。 */
  binary: boolean
  newFile: boolean
  deletedFile: boolean
  renamed: boolean
  /** 文件级头部（`diff --git` / `index` / `new file mode` 等），按原样保留。 */
  headers: string[]
}

export interface DiffParseResult {
  files: DiffFile[]
  /** 不属于任何文件的原始行（例如手写补丁前面的说明）。 */
  preamble: string[]
}

export type DiffViewMode = 'unified' | 'split'

/** 一个文件在补丁里的行号是否可信：缺 `@@` 头时为 false，界面不编造行号。 */
export function hunkHasLineNumbers(hunk: DiffHunk): boolean {
  return hunk.lines.some((line) => line.oldLine !== null || line.newLine !== null)
}
