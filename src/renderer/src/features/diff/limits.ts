/**
 * Diff 渲染的降级阈值与判断（纯函数，无 IO）。
 *
 * 「明确降级」的意思是：二进制补丁与超大补丁不硬塞进 DOM —— 前者渲染出来
 * 只会是一堆乱码，后者会让主线程卡死。两种情况都给一句人话，并保留文件名。
 */

export const DIFF_LIMITS = {
  /** 两侧合计超过这个行数就改用虚拟列表（virtua），避免长补丁一次全挂 DOM。 */
  virtualizeAt: 300,
  /** 补丁文本超过这个字节数就默认不渲染正文（约 1.5 MB）。 */
  maxBytes: 1_500_000,
  /** 用户点「仍然渲染」也拒绝的上限，防止极端输入拖死页面（约 12 MB）。 */
  hardMaxBytes: 12_000_000,
  /** 词级差异单侧的最大 token 数；超过只做整行标红 / 标绿。 */
  maxWordTokens: 400,
  /** 词级差异单侧的最大字符数；超过只做整行标红 / 标绿。 */
  maxWordChars: 4000,
  /** 折叠未改动段时默认保留的上下文行数。 */
  contextLines: 3
} as const

/** UTF-8 字节数（只用作上界判断，不依赖 Buffer）。 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function patchExceedsLimit(patch: string, maxBytes: number = DIFF_LIMITS.maxBytes): boolean {
  return byteLength(patch) > maxBytes
}

export function patchExceedsHardLimit(patch: string, maxBytes: number = DIFF_LIMITS.hardMaxBytes): boolean {
  return byteLength(patch) > maxBytes
}

/** `git diff` 对二进制文件只写这一行（或整段 `GIT binary patch`），没有 +/- 行。 */
const BINARY_RE = /(^|\n)(Binary files .+? differ|GIT binary patch)\s*(\n|$)/

export function isBinaryPatch(patch: string): boolean {
  return BINARY_RE.test(patch)
}

/** 人类可读的体量，用于降级提示。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
