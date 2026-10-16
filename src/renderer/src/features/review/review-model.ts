import type {
  ReviewAnnotation,
  ReviewChangeSet,
  ReviewChangeSetQuery,
  ReviewChangeSource,
  ReviewFinding,
  ReviewGitErrorCode,
  ReviewGitOutcome
} from '../../../../shared/review'
import { parseReviewFindings } from '../../../../shared/review'
import { parsePatch } from '../diff/parse'

export interface ReviewOwner {
  key: string
  cwd: string
  projectId?: string
  sessionId?: string
  sessionPath?: string
  active?: boolean
}

export function reviewOwnerKey(owner: ReviewOwner): string {
  return [owner.key, owner.cwd, owner.projectId ?? '', owner.sessionId ?? ''].join('|')
}

export function sameReviewOwner(a: ReviewOwner, b: ReviewOwner): boolean {
  return reviewOwnerKey(a) === reviewOwnerKey(b)
}

export interface ReviewSourceOption {
  source: ReviewChangeSource
  available: boolean
  note?: 'sessionShare' | 'worktreeNeedsPath'
}

export function reviewSourceOptions(owner: Pick<ReviewOwner, 'cwd'>): ReviewSourceOption[] {
  const hasCwd = !!owner.cwd
  return [
    { source: 'session', available: hasCwd, note: 'sessionShare' },
    { source: 'branch', available: hasCwd },
    { source: 'worktree', available: hasCwd, note: 'worktreeNeedsPath' },
    { source: 'uncommitted', available: hasCwd }
  ]
}

export interface ReviewQueryExtras {
  base?: string
  branch?: string
  worktreePath?: string
}

export function reviewQueryForSource(
  source: ReviewChangeSource,
  owner: ReviewOwner,
  extras: ReviewQueryExtras = {}
): ReviewChangeSetQuery {
  return {
    source,
    cwd: owner.cwd,
    ...(source === 'session' && owner.sessionId ? { sessionId: owner.sessionId } : {}),
    ...(extras.base ? { base: extras.base } : {}),
    ...(extras.branch ? { branch: extras.branch } : {}),
    ...(extras.worktreePath ? { worktreePath: extras.worktreePath } : {})
  }
}

export function reviewDiffQueryForChangeSet(
  changeSet: Pick<ReviewChangeSet, 'source' | 'cwd' | 'base' | 'branch'>,
  owner: ReviewOwner,
  path: string
): (ReviewChangeSetQuery & { path: string }) | null {
  if (changeSet.source === 'session' && !owner.sessionId) return null
  return {
    source: changeSet.source,
    cwd: changeSet.cwd,
    path,
    ...(changeSet.base ? { base: changeSet.base } : {}),
    ...(changeSet.branch ? { branch: changeSet.branch } : {}),
    ...(changeSet.source === 'session' && owner.sessionId ? { sessionId: owner.sessionId } : {})
  }
}

export class ReviewRequestGate {
  private seq = 0
  next(): number {
    this.seq += 1
    return this.seq
  }
  current(): number {
    return this.seq
  }
  invalidate(): void {
    this.seq += 1
  }
  isCurrent(token: number): boolean {
    return token === this.seq
  }
}

export interface GuardedResult<T> {
  stale: boolean
  value?: T
  error?: string
}

export async function guardedLoad<T>(isCurrent: () => boolean, work: () => Promise<T>): Promise<GuardedResult<T>> {
  try {
    const value = await work()
    return isCurrent() ? { stale: false, value } : { stale: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return isCurrent() ? { stale: false, error: message } : { stale: true }
  }
}

export function changeSetUsable(changeSet: ReviewChangeSet | null): boolean {
  return !!changeSet && changeSet.ok && !!changeSet.repoRoot
}

export function groupAnnotationsByPath(annotations: readonly ReviewAnnotation[]): Map<string, ReviewAnnotation[]> {
  const map = new Map<string, ReviewAnnotation[]>()
  for (const annotation of annotations) {
    const list = map.get(annotation.path)
    if (list) list.push(annotation)
    else map.set(annotation.path, [annotation])
  }
  for (const list of map.values()) list.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd)
  return map
}

export function annotationIsStale(annotation: ReviewAnnotation, changeSetRevision: string | undefined): boolean {
  if (!changeSetRevision) return false
  if (!annotation.anchorRevision) return false
  return annotation.anchorRevision !== changeSetRevision
}

export interface ReviewLineAnchors {
  newLines: number[]
  oldLines: number[]
  minNew: number
  maxNew: number
  minOld: number
  maxOld: number
  binary: boolean
}

export function reviewLineAnchors(patch: string): ReviewLineAnchors {
  const parsed = parsePatch(patch ?? '')
  const newSet = new Set<number>()
  const oldSet = new Set<number>()
  let binary = false
  for (const file of parsed.files) {
    if (file.binary) binary = true
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== null) newSet.add(line.newLine)
        if (line.oldLine !== null) oldSet.add(line.oldLine)
      }
    }
  }
  const newLines = [...newSet].sort((a, b) => a - b)
  const oldLines = [...oldSet].sort((a, b) => a - b)
  return {
    newLines,
    oldLines,
    minNew: newLines[0] ?? 0,
    maxNew: newLines[newLines.length - 1] ?? 0,
    minOld: oldLines[0] ?? 0,
    maxOld: oldLines[oldLines.length - 1] ?? 0,
    binary
  }
}

export interface AnchorValidation {
  ok: boolean
  error?: string
}

export function validateReviewAnchor(
  anchors: ReviewLineAnchors,
  side: ReviewAnnotation['side'],
  lineStart: number,
  lineEnd: number
): AnchorValidation {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return { ok: false, error: 'invalidLine' }
  if (lineStart < 1 || lineEnd < lineStart) return { ok: false, error: 'invalidRange' }
  if (side === 'file') return { ok: true }
  const list = side === 'old' ? anchors.oldLines : anchors.newLines
  if (list.length === 0) return { ok: false, error: 'noTextLines' }
  if (!list.includes(lineStart) || !list.includes(lineEnd)) return { ok: false, error: 'notAnAnchor' }
  return { ok: true }
}

export interface ParsedFindings {
  findings: ReviewFinding[]
  error?: string
}

export function parseFindingsText(text: string): ParsedFindings {
  return parseReviewFindings(text)
}

export function fileAnnotationCount(changeSet: ReviewChangeSet, path: string): number {
  return changeSet.files.find((file) => file.path === path)?.annotations ?? 0
}

export function suggestedCommitMessage(changeSet: ReviewChangeSet): string {
  if (!changeSet.ok || changeSet.files.length === 0) return ''
  const scope = changeSet.branch ? `${changeSet.branch}: ` : ''
  const names = changeSet.files.slice(0, 6).map((file) => file.path)
  const more = changeSet.files.length > names.length ? ` 等 ${changeSet.files.length} 个文件` : ''
  return `${scope}更新 ${names.join('、')}${more}`
}

export function suggestedPullRequestTitle(changeSet: ReviewChangeSet): string {
  if (changeSet.branch) return changeSet.branch
  const first = changeSet.files[0]?.path
  return first ? `评审：${first}` : ''
}

export type ReviewGitOutcomeKind =
  | 'ok'
  | 'gh-missing'
  | 'gh-not-authenticated'
  | 'network'
  | 'timeout'
  | 'not-confirmed'
  | 'invalid'
  | 'failed'

export function classifyGitOutcome(outcome: ReviewGitOutcome): ReviewGitOutcomeKind {
  if (outcome.ok) return 'ok'
  const code: ReviewGitErrorCode | undefined = outcome.code
  switch (code) {
    case 'gh-missing':
      return 'gh-missing'
    case 'gh-not-authenticated':
      return 'gh-not-authenticated'
    case 'network':
      return 'network'
    case 'timeout':
      return 'timeout'
    case 'not-confirmed':
      return 'not-confirmed'
    case 'invalid-input':
    case 'not-a-repo':
    case 'no-remote':
      return 'invalid'
    default:
      return 'failed'
  }
}

export function ghStatusDegrade(status: { ok: boolean; installed: boolean; authenticated: boolean } | null): 'ready' | 'missing' | 'unauthenticated' | 'unknown' {
  if (!status) return 'unknown'
  if (!status.installed) return 'missing'
  if (!status.authenticated) return 'unauthenticated'
  return status.ok ? 'ready' : 'unknown'
}
