export const DIFF_LIMITS = {
  virtualizeAt: 300,
  maxBytes: 1_500_000,
  hardMaxBytes: 12_000_000,
  maxWordTokens: 400,
  maxWordChars: 4000,
  contextLines: 3
} as const

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function patchExceedsLimit(patch: string, maxBytes: number = DIFF_LIMITS.maxBytes): boolean {
  return byteLength(patch) > maxBytes
}

export function patchExceedsHardLimit(patch: string, maxBytes: number = DIFF_LIMITS.hardMaxBytes): boolean {
  return byteLength(patch) > maxBytes
}

const BINARY_RE = /(^|\n)(Binary files .+? differ|GIT binary patch)\s*(\n|$)/

export function isBinaryPatch(patch: string): boolean {
  return BINARY_RE.test(patch)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
