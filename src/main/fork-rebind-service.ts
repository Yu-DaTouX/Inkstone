/**
 * 工作树 Fork 的文件引用重绑定（实施-07 S2b-3 的服务层）。
 *
 * 输入的「源会话」是**用户当前所在的那条会话**（他正准备派生到工作树去）：
 * 把它里面 `@` 过的仓库内文件捞出来，拿到**目标工作树的仓库根**下重新解析并验证存在性。
 *
 * 为什么不在这里做「历史平铺」：形态是 Fork —— 新会话拿到的应该是**知识**（哪些文件在谈），
 * 不是「曾经打开过的绝对路径」。所以这一层只回答一个问题：
 * **源会话提到的文件，在这个工作树里还剩几个能对上。**
 *
 * ⚠️ 反模式（形态决策 §3）：**不做**绝对路径前缀替换。
 * 绝对路径先转成仓库相对路径（`toRepoRelative`），转不了就报 `outside`（不迁移，如实说明）。
 */
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
  /** 目标工作树目录 */
  worktree: string
  /** 源会话的 JSONL 绝对路径（渲染端给；没有就没法从会话里提取） */
  sourceFile?: string
  /** 源会话的工作目录（用来定源仓库根，并据此过滤掉“源仓库里本来就没有”的噪音） */
  sourceCwd?: string
  /**
   * 显式引用列表：给了就**不再从会话里提取**。
   * 用途是测试与将来的「显式交接」—— 写死一份引用比伪造会话文件诚实。
   */
  explicitRefs?: string[]
}

export interface ForkRefsReport {
  worktree: string
  /** 目标（工作树）仓库根；不是 Git 仓库时为 null */
  root: string | null
  /** 源仓库根（用来判断引用当初是不是这个仓库里的东西） */
  sourceRoot: string | null
  sourceFile: string | null
  refs: ForkRefResolution[]
  summary: ForkRefSummary
  /** 出问题时给一句可读原因（界面照实显示，不假装算过） */
  error?: string
}

/** 真实文件系统查询：只区分 file / dir / 不存在（符号链接跟随，与用户看到的一致） */
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
      /*
       * 只捞**用户说的话**：助手提过的路径往往是它自己编的/工具输出里的噪音，
       * 而「用户 `@` 过的文件」才是他真正在意的交付面。
       */
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

/* ── Fork 的语义注入正文（实施-07 S2b-4）────────────────── */

export interface ForkContextRequest {
  /** 目标工作树目录 */
  worktree: string
  /** 源会话（用户点「派生新会话」之前所在的那条） */
  sourceFile?: string
  sourceCwd?: string
  sourceSessionId?: string
  /**
   * 显式附件数：给了就**不看源会话**（测试与将来的显式交接用）。
   * 与 `explicitRefs` 同一个道理：写一个数字比伪造一份带图的会话文件诚实。
   */
  explicitAttachmentCount?: number
}

export interface ForkContextResult {
  forkId: string
  /** 交给新会话的正文（渲染端作为输入框草稿） */
  text: string
  /** 诊断字段：界面与断言直接看它们，不再去解析文本 */
  branch: string | null
  head: string | null
  detached: boolean
  changedCount: number
  ahead: number
  behind: number
  refsTotal: number
  refsResolved: number
  /** 源会话里的图片附件数（S2b-5：不迁移，只如实告知） */
  attachments: number
  hasPackage: boolean
  error?: string
}

/**
 * 数源会话里的图片附件。
 *
 * 只看**用户消息**（`images`）：助手消息不带附件，而工具输出里的图不是用户给的。
 * 读不到会话来时返回 null —— “没数到”与“一个都没有”是两件事，
 * 不能把前者说成「没有附件要带」。
 *
 * ⚠️ 这会再读一遍会话文件（`forkFileRefs` 里已经读过一次）。两份职责不同（引用 vs 附件），
 * 而会话文件是 KB 级的小文件；合并成一个“什么都要读”的函数反而不好维护。
 */
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

/**
 * 构造 Fork 上下文正文。
 *
 * `packageOf` 由调用方注入（主进程手里才有 `HandoffStore`）—— 这一层不去碰存储，
 * 好处是单测能直接给一份假交接包。
 *
 * ⚠️ 环境派生状态（分支 / HEAD / 领先落后 / 变更数）**一律在目标工作树上重读**，
 * 函数里没有“源会话的状态”这个入参 —— 想让外部把源会话的状态塞进来都没有地方塞。
 */
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

  /*
   * 附件（S2b-5）：只数、不搬。给了显式数量就不再读会话（测试用）。
   */
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
