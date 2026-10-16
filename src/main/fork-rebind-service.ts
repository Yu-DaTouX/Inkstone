import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractRefsFromTexts, resolveForkRefs, summarizeForkRefs } from '../shared/fork-rebind'
import type { ForkRefResolution, ForkRefSummary } from '../shared/fork-rebind'
import { buildForkContext } from '../shared/fork-context'
import type { HandoffPackage } from '../shared/handoff'
import { readSessionMessages } from './session-reader'
import { readRepoState, resolveRepo } from './git-service'

export interface ForkRefsInput {
  worktree: string
  sourceFile?: string
  sourceCwd?: string
  explicitRefs?: string[]
}

export interface ForkRefsReport {
  worktree: string
  root: string | null
  sourceRoot: string | null
  sourceFile: string | null
  refs: ForkRefResolution[]
  summary: ForkRefSummary
  error?: string
}

function statKind(abs: string): 'file' | 'dir' | null {
  try {
    const s = statSync(abs)
    if (s.isDirectory()) return 'dir'
    if (s.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

export async function forkFileRefs(input: ForkRefsInput): Promise<ForkRefsReport> {
  const worktree = String(input.worktree ?? '').trim()
  const targetRepo = worktree ? await resolveRepo(worktree).catch(() => null) : null
  const root = targetRepo?.root ?? null

  const sourceCwd = String(input.sourceCwd ?? '').trim()
  const sourceRepo = sourceCwd ? await resolveRepo(sourceCwd).catch(() => null) : null
  const sourceRoot = sourceRepo?.root ?? (sourceCwd || null)

  let refs: string[] = []
  if (input.explicitRefs?.length) {
    refs = input.explicitRefs.map((r) => String(r ?? '')).filter(Boolean)
  } else if (input.sourceFile && sourceRoot) {
    const read = await readSessionMessages(input.sourceFile).catch(() => null)
    if (read) {
      const texts = read.messages.filter((m) => m.role === 'user').map((m) => m.text)
      refs = extractRefsFromTexts(texts, (rel) => existsSync(join(sourceRoot, rel)))
    }
  }

  const resolved = root ? resolveForkRefs(root, refs, statKind) : []
  const summary = summarizeForkRefs(resolved)
  return {
    worktree,
    root,
    sourceRoot,
    sourceFile: input.sourceFile ?? null,
    refs: resolved,
    summary,
    ...(root ? {} : { error: '这个目录不是 Git 仓库，没有可以对照的仓库相对路径' })
  }
}

export interface ForkContextRequest {
  worktree: string
  sourceFile?: string
  sourceCwd?: string
  sourceSessionId?: string
  explicitAttachmentCount?: number
}

export interface ForkContextResult {
  forkId: string
  text: string
  branch: string | null
  head: string | null
  detached: boolean
  changedCount: number
  ahead: number
  behind: number
  refsTotal: number
  refsResolved: number
  attachments: number
  hasPackage: boolean
  error?: string
}

async function countSourceAttachments(sessionFile: string): Promise<{ total: number } | null> {
  const read = await readSessionMessages(sessionFile).catch(() => null)
  if (!read) return null
  let total = 0
  for (const m of read.messages) {
    if (m.role !== 'user') continue
    total += Array.isArray(m.images) ? m.images.length : 0
  }
  return { total }
}

export async function forkContext(
  request: ForkContextRequest,
  packageOf: (sessionFile: string) => HandoffPackage | null
): Promise<ForkContextResult> {
  const worktree = String(request.worktree ?? '').trim()
  const forkId = randomUUID()
  const state = worktree ? await readRepoState(worktree, { withRefs: false }).catch(() => null) : null

  const refsReport = await forkFileRefs({
    worktree,
    ...(request.sourceFile ? { sourceFile: request.sourceFile } : {}),
    ...(request.sourceCwd ? { sourceCwd: request.sourceCwd } : {})
  })

  const sourceCwd = String(request.sourceCwd ?? '').trim()
  const source =
    request.sourceFile || request.sourceSessionId
      ? {
          sessionId: String(request.sourceSessionId ?? '').trim() || '(未知)',
          cwd: sourceCwd || '(未知)'
        }
      : null

  const pkg = request.sourceFile ? packageOf(request.sourceFile) : null

  const attachments =
    typeof request.explicitAttachmentCount === 'number'
      ? { total: Math.max(0, Math.floor(request.explicitAttachmentCount)) }
      : request.sourceFile
        ? await countSourceAttachments(request.sourceFile)
        : null

  const env = {
    branch: state?.branch ?? null,
    detached: state?.detached === true,
    head: state?.head ? state.head.slice(0, 8) : null,
    ahead: state?.ahead ?? 0,
    behind: state?.behind ?? 0,
    changedCount: state?.changedCount ?? 0
  }

  const text = buildForkContext({
    forkId,
    worktree,
    repoName: state?.name ?? (worktree ? worktree.split(/[\\/]/).filter(Boolean).pop() ?? worktree : '(未知仓库)'),
    env,
    source,
    refs:
      refsReport.summary.total > 0
        ? {
            total: refsReport.summary.total,
            resolved: refsReport.summary.resolved,
            problems: refsReport.summary.problems.map((p) => ({ ref: p.ref, state: p.state }))
          }
        : null,
    attachments,
    pkg
  })

  return {
    forkId,
    text,
    ...env,
    refsTotal: refsReport.summary.total,
    refsResolved: refsReport.summary.resolved,
    attachments: attachments?.total ?? 0,
    hasPackage: pkg !== null,
    ...(state ? {} : { error: '目标目录不是 Git 仓库（分支与变更数拿不到）' })
  }
}
