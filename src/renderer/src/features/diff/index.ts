/**
 * R4 diff 模块出口。
 *
 * `DiffView` 是通用纯 UI：给它一段统一 diff 文本就能渲染，不关心数据来自哪。
 * 纯解析 / 对齐 / 词差 / 折叠以下面的具名导出暴露，供 `ChangesPane` 与
 * `scripts/test-v3-diff.mjs` 复用。
 */
export { DiffView, type DiffViewProps } from './DiffView'
export { diffViewText, type DiffViewText } from './text'
export * from './types'
export { unquotePath, parsePatch } from './parse'
export { alignHunk, type DiffSideRow, type DiffSideRowKind } from './align'
export { tokenizeLine, wordDiff, type WordDiff, type WordSegment } from './word-diff'
export { foldLines, type FoldRow } from './fold'
export { byteLength, DIFF_LIMITS, formatBytes, isBinaryPatch, patchExceedsHardLimit, patchExceedsLimit } from './limits'
