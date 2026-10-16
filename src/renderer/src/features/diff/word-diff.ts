import { DIFF_LIMITS } from './limits'

export interface WordSegment {
  text: string
  changed: boolean
}

export interface WordDiff {
  left: WordSegment[]
  right: WordSegment[]
  changed: boolean
}

const TOKEN_RE = /\s+|[A-Za-z0-9_]+|./gu

export function tokenizeLine(line: string): string[] {
  return line.match(TOKEN_RE) ?? []
}

function merge(flags: { token: string; changed: boolean }[]): WordSegment[] {
  const out: WordSegment[] = []
  for (const item of flags) {
    const last = out[out.length - 1]
    if (last && last.changed === item.changed) last.text += item.token
    else out.push({ text: item.token, changed: item.changed })
  }
  return out
}

function wholeLine(oldLine: string, newLine: string): WordDiff {
  return {
    left: [{ text: oldLine, changed: true }],
    right: [{ text: newLine, changed: true }],
    changed: true
  }
}

export function wordDiff(oldLine: string, newLine: string, limits: { maxWordTokens: number; maxWordChars: number } = DIFF_LIMITS): WordDiff {
  if (oldLine === newLine) return { left: [{ text: oldLine, changed: false }], right: [{ text: newLine, changed: false }], changed: false }
  if (oldLine.length > limits.maxWordChars || newLine.length > limits.maxWordChars) return wholeLine(oldLine, newLine)

  const a = tokenizeLine(oldLine)
  const b = tokenizeLine(newLine)
  if (a.length === 0 || b.length === 0 || a.length > limits.maxWordTokens || b.length > limits.maxWordTokens) {
    return wholeLine(oldLine, newLine)
  }

  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Uint16Array((n + 1) * width)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * width + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * width + (j - 1)] + 1
          : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)])
    }
  }

  const aMatch = new Array<boolean>(n).fill(false)
  const bMatch = new Array<boolean>(m).fill(false)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      aMatch[i - 1] = true
      bMatch[j - 1] = true
      i -= 1
      j -= 1
    } else if (dp[(i - 1) * width + j] >= dp[i * width + (j - 1)]) {
      i -= 1
    } else {
      j -= 1
    }
  }

  const left = merge(a.map((token, idx) => ({ token, changed: !aMatch[idx] })))
  const right = merge(b.map((token, idx) => ({ token, changed: !bMatch[idx] })))
  return { left, right, changed: true }
}
