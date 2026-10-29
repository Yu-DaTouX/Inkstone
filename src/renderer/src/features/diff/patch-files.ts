import type { FileDiffLoadedFiles, FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
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

function stripEol(line: string | undefined): string {
  return (line ?? '').replace(/\r?\n$/, '')
}

function sideLines(file: FileDiffMetadata, side: SelectionSide): Map<number, string> {
  const map = new Map<number, string>()
  const lines = side === 'additions' ? file.additionLines : file.deletionLines
  if (!file.isPartial) {
    lines.forEach((line, index) => map.set(index + 1, stripEol(line)))
    return map
  }
  for (const hunk of file.hunks) {
    let number = side === 'additions' ? hunk.additionStart : hunk.deletionStart
    for (const content of hunk.hunkContent) {
      const start = side === 'additions' ? content.additionLineIndex : content.deletionLineIndex
      const count = content.type === 'context' ? content.lines : side === 'additions' ? content.additions : content.deletions
      for (let offset = 0; offset < count; offset += 1) {
        map.set(number, stripEol(lines[start + offset]))
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

export interface DiffContents {
  before: string
  after: string
}

export function canExpandContext(file: FileDiffMetadata): boolean {
  return file.isPartial && (file.type === 'change' || file.type === 'rename-changed') && file.hunks.length > 0
}

function splitContent(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function contentsMatchPatch(file: FileDiffMetadata, contents: DiffContents): boolean {
  if (!canExpandContext(file)) return false
  const before = splitContent(contents.before)
  const after = splitContent(contents.after)
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart - 1
    let newLine = hunk.additionStart - 1
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const expected = stripEol(file.additionLines[content.additionLineIndex + offset])
          if (before[oldLine] !== expected || after[newLine] !== expected) return false
          oldLine += 1
          newLine += 1
        }
        continue
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        if (before[oldLine] !== stripEol(file.deletionLines[content.deletionLineIndex + offset])) return false
        oldLine += 1
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        if (after[newLine] !== stripEol(file.additionLines[content.additionLineIndex + offset])) return false
        newLine += 1
      }
    }
  }
  return true
}

export function loadedFiles(file: FileDiffMetadata, contents: DiffContents): FileDiffLoadedFiles {
  const key = file.cacheKey ?? `${file.prevName ?? ''}:${file.name}`
  return {
    oldFile: { name: file.prevName ?? file.name, contents: contents.before.replace(/\r\n/g, '\n'), cacheKey: `${key}:old` },
    newFile: { name: file.name, contents: contents.after.replace(/\r\n/g, '\n'), cacheKey: `${key}:new` }
  }
}

export type DiffKeyLineKind = 'context' | 'addition' | 'deletion'

export interface DiffKeyLine {
  fileId: string
  fileIndex: number
  hunkIndex: number
  side: SelectionSide
  lineNumber: number
  oldLineNumber: number
  kind: DiffKeyLineKind
  text: string
}

function numberOn(line: DiffKeyLine, side: SelectionSide): number {
  if (line.kind === 'context') return side === 'deletions' ? line.oldLineNumber : line.lineNumber
  return line.lineNumber
}

function onSide(line: DiffKeyLine, side: SelectionSide): boolean {
  return line.kind === 'context' || line.side === side
}

export function keyboardLines(files: readonly FileDiffMetadata[]): DiffKeyLine[] {
  const out: DiffKeyLine[] = []
  files.forEach((file, fileIndex) => {
    const fileId = fileDiffId(file, fileIndex)
    file.hunks.forEach((hunk, hunkIndex) => {
      const push = (
        side: SelectionSide,
        lineNumber: number,
        oldLineNumber: number,
        kind: DiffKeyLineKind,
        line: string | undefined
      ): void => {
        out.push({ fileId, fileIndex, hunkIndex, side, lineNumber, oldLineNumber, kind, text: stripEol(line) })
      }
      let oldLine = hunk.deletionStart
      let newLine = hunk.additionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let offset = 0; offset < content.lines; offset += 1) {
            push('additions', newLine, oldLine, 'context', file.additionLines[content.additionLineIndex + offset])
            oldLine += 1
            newLine += 1
          }
          continue
        }
        for (let offset = 0; offset < content.deletions; offset += 1) {
          push('deletions', oldLine, oldLine, 'deletion', file.deletionLines[content.deletionLineIndex + offset])
          oldLine += 1
        }
        for (let offset = 0; offset < content.additions; offset += 1) {
          push('additions', newLine, oldLine, 'addition', file.additionLines[content.additionLineIndex + offset])
          newLine += 1
        }
      }
    })
  })
  return out
}

export interface DiffKeyCursor {
  anchor: number
  focus: number
}

export function firstChangedLine(lines: readonly DiffKeyLine[]): number {
  const index = lines.findIndex((line) => line.kind !== 'context')
  return index < 0 ? 0 : index
}

export function moveKeyCursor(
  lines: readonly DiffKeyLine[],
  cursor: DiffKeyCursor | null,
  delta: number,
  extend: boolean
): DiffKeyCursor | null {
  if (lines.length === 0) return null
  if (!cursor) {
    const start = firstChangedLine(lines)
    return { anchor: start, focus: start }
  }
  if (!extend) {
    const focus = Math.max(0, Math.min(lines.length - 1, cursor.focus + delta))
    return { anchor: focus, focus }
  }
  const anchor = lines[cursor.anchor]
  const step = delta < 0 ? -1 : 1
  let remaining = Math.abs(delta)
  let focus = cursor.focus
  for (let index = cursor.focus + step; index >= 0 && index < lines.length && remaining > 0; index += step) {
    const line = lines[index]
    if (line.fileId !== anchor.fileId || line.hunkIndex !== anchor.hunkIndex) break
    if (!onSide(line, anchor.side)) continue
    focus = index
    remaining -= 1
  }
  return { anchor: cursor.anchor, focus }
}

export interface DiffKeyRange {
  fileId: string
  fileIndex: number
  side: SelectionSide
  start: number
  end: number
  count: number
}

export function keyCursorRange(lines: readonly DiffKeyLine[], cursor: DiffKeyCursor | null): DiffKeyRange | null {
  if (!cursor) return null
  const anchor = lines[cursor.anchor]
  const focus = lines[cursor.focus]
  if (!anchor || !focus) return null
  const same = anchor.fileId === focus.fileId && anchor.hunkIndex === focus.hunkIndex && onSide(focus, anchor.side)
  const side = same ? anchor.side : focus.side
  const first = same ? numberOn(anchor, side) : focus.lineNumber
  const last = same ? numberOn(focus, side) : focus.lineNumber
  const start = Math.min(first, last)
  const end = Math.max(first, last)
  return {
    fileId: focus.fileId,
    fileIndex: focus.fileIndex,
    side,
    start,
    end,
    count: end - start + 1
  }
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
