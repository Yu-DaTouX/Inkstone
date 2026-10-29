import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
import { parsePatchFiles } from '@pierre/diffs'

export type PatchFiles = { kind: 'files'; files: FileDiffMetadata[] } | { kind: 'raw'; text: string }

function hash(input: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return `${input.length}:${value.toString(36)}`
}

function compactPartialOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file
  let splitLineStart = 0
  let unifiedLineStart = 0
  const hunks = file.hunks.map((hunk) => {
    const next = { ...hunk, splitLineStart, unifiedLineStart }
    splitLineStart += hunk.splitLineCount
    unifiedLineStart += hunk.unifiedLineCount
    return next
  })
  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact` } : {})
  }
}

function parse(patch: string, scope: string): FileDiffMetadata[] {
  return parsePatchFiles(patch, `${scope}:${hash(patch)}`).flatMap((parsed) => parsed.files.map(compactPartialOffsets))
}

export function patchFiles(patch: string, fallbackName: string, scope = 'diff'): PatchFiles {
  const text = patch.replace(/\r\n/g, '\n').trim()
  if (!text) return { kind: 'files', files: [] }
  try {
    const files = parse(`${text}\n`, scope)
    if (files.length > 0) return { kind: 'files', files }
    if (/^@@ /m.test(text)) {
      const name = fallbackName || 'patch'
      const wrapped = parse(`--- ${name}\n+++ ${name}\n${text}\n`, scope)
      if (wrapped.length > 0) return { kind: 'files', files: wrapped }
    }
  } catch {
    return { kind: 'raw', text }
  }
  return { kind: 'raw', text }
}

export function fileDiffPath(file: FileDiffMetadata): string {
  return file.name || file.prevName || ''
}

export function fileDiffId(file: FileDiffMetadata, index: number): string {
  return `${index}:${file.prevName ?? ''}:${file.name}`
}

export function fileDiffStat(file: FileDiffMetadata): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    added += hunk.additionLines
    removed += hunk.deletionLines
  }
  return { added, removed }
}

function sideLines(file: FileDiffMetadata, side: SelectionSide): Map<number, string> {
  const map = new Map<number, string>()
  const lines = side === 'additions' ? file.additionLines : file.deletionLines
  for (const hunk of file.hunks) {
    let number = side === 'additions' ? hunk.additionStart : hunk.deletionStart
    for (const content of hunk.hunkContent) {
      const start = side === 'additions' ? content.additionLineIndex : content.deletionLineIndex
      const count = content.type === 'context' ? content.lines : side === 'additions' ? content.additions : content.deletions
      for (let offset = 0; offset < count; offset += 1) {
        map.set(number, (lines[start + offset] ?? '').replace(/\r?\n$/, ''))
        number += 1
      }
    }
  }
  return map
}

export interface AnnotationRange {
  side: SelectionSide
  start: number
  end: number
  code: string
}

export function annotationRange(file: FileDiffMetadata, range: SelectedLineRange): AnnotationRange | null {
  const side: SelectionSide = range.endSide ?? range.side ?? 'additions'
  const first = Math.min(range.start, range.end)
  const last = Math.max(range.start, range.end)
  const pick = (which: SelectionSide): string[] => {
    const map = sideLines(file, which)
    const out: string[] = []
    for (let number = first; number <= last; number += 1) {
      const line = map.get(number)
      if (line !== undefined) out.push(line)
    }
    return out
  }
  let code = pick(side)
  let resolved = side
  if (code.length === 0) {
    resolved = side === 'additions' ? 'deletions' : 'additions'
    code = pick(resolved)
  }
  if (code.length === 0) return null
  return { side: resolved, start: first, end: last, code: code.join('\n') }
}

export interface HunkTarget {
  id: string
  lineNumber: number
  side: SelectionSide
}

export function hunkTargets(files: readonly FileDiffMetadata[]): HunkTarget[] {
  const out: HunkTarget[] = []
  files.forEach((file, index) => {
    const id = fileDiffId(file, index)
    for (const hunk of file.hunks) {
      const additions = hunk.additionCount > 0
      out.push({
        id,
        lineNumber: Math.max(1, additions ? hunk.additionStart : hunk.deletionStart),
        side: additions ? 'additions' : 'deletions'
      })
    }
  })
  return out
}
