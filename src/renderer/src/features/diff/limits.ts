export const DIFF_LIMITS = {
  maxBytes: 1_500_000,
  hardMaxBytes: 12_000_000
} as const

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
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
