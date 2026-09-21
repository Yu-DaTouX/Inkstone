/**
 * 工作树 Fork 的语义注入正文（实施-07 S2b-4）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 用户在主仓库里干活，然后「派生新会话」到工作树 —— 新会话在**另一个目录**里跑，
 * 它什么都不知道：源会话在谈什么、这个工作树现在是什么状态、哪些文件还在。
 *
 * 这一层负责把「接手时**必须**知道的东西」写成一段正文，交给新会话：
 *
 *   · **可迁移的知识**：源会话的交接包（目标 / 交付物 / 未完成 / 下一步）—— 有就带，没有就说没有；
 *   · **必须重算的环境派生状态**：分支、HEAD、领先落后、未提交变更 —— 一律由调用方
 *     以**当前工作树**重新读出来后传进来（`env`），本文档里**不存在**任何从源会话抄状态的路径；
 *   · **文件引用对照**：S2b-3 的解析结果（几个能对上、哪几个对不上）。
 *
 * ── 为什么正文里要显式说「历史没有带过来」──
 *   模型在不知道这件事的时候，会**假装**自己记得（编造前面的对话），或者问用户
 *   「你能再说一遍吗」——两种都糟。如实告知 + 给出「需要哪一段问我」的出口，
 *   比把历史灌进来便宜得多（形态决策明确：默认不整段注入）。
 *
 * ── 为什么标记行要独占一行 ──
 *   与交接续接（`handoff-resume.ts`）同一个理由：证据检测是字符串包含，
 *   标记独占一行才能在会话文件里被 grep 到、也不会被模型复述误命中。
 */

import type { ForkRefState } from './fork-rebind'
import type { HandoffPackage } from './handoff'

/** 标记前缀（`[yan-fork-context:<id>]`）。改它等于让已有证据全部失效。 */
export const FORK_CONTEXT_TAG = 'yan-fork-context'

export interface ForkContextEnv {
  /** 分支名；detached 时为 null */
  branch: string | null
  detached: boolean
  /** HEAD 短 sha */
  head: string | null
  /** 相对 upstream 的领先 / 落后提交数 */
  ahead: number
  behind: number
  /** 未提交变更数（去重后） */
  changedCount: number
}

export interface ForkContextRefProblem {
  ref: string
  state: ForkRefState
}

export interface ForkContextRefs {
  total: number
  resolved: number
  problems: ForkContextRefProblem[]
}

export interface ForkContextInput {
  /** 本次派生的标识（写进正文首行的标记行；宿主给） */
  forkId: string
  /** 目标工作树目录（新会话的 cwd） */
  worktree: string
  /** 仓库名（显示用） */
  repoName: string
  /** **以当前工作树重算**的环境派生状态 */
  env: ForkContextEnv
  /** 源会话（派生自哪里）；宿主拿不到时为 null（如刚 fork 还没落盘） */
  source: { sessionId: string; cwd: string } | null
  /** 文件引用对照（S2b-3）；没有引用时为 null */
  refs: ForkContextRefs | null
  /**
   * 源会话里的附件（图片）计数（S2b-5）。
   *
   * 附件**按设计不迁移**（第一版就这么定）—— 数一下只是为了让新会话知道
   * 「有几张图没跟过来」，而不是递中它们。为 null / 0 时不写这一段。
   * `文件`类附件不在这里：它们表现为路径引用，已经由 S2b-3 的对照盖住。
   */
  attachments: { total: number } | null
  /** 可迁移的知识：源会话的交接包（没有就 null，正文里不出现「交接包」字样） */
  pkg: HandoffPackage | null
}

/** `forkId` 的标记行（证据检测认这一行）。 */
export function forkContextMarker(forkId: string): string {
  return `[${FORK_CONTEXT_TAG}:${String(forkId ?? '').trim()}]`
}

const HEADER =
  '这段上下文来自**砚的工作树派生（Fork）**：我从另一个会话派生到这条工作树上接手，' +
  '**不是**同一条会话的继续 —— 源会话的对话历史没有带过来。' +
  '需要哪一段直接说，我按需去读源会话文件，不要凭印象复述。'

const FOOTER =
  '按上面的定位继续推进：不要重新确认已经确认过的信息、不要重做已经完成的部分。' +
  '需要源会话里的原始对话时明确说要哪一段（文件 / 结论 / 决定），我去读，不要猜。'

/** 问题项的人话（`missing` 与 `outside` 的处置完全不同，不能让模型只看见状态名） */
function problemText(item: ForkContextRefProblem): string {
  if (item.state === 'outside') return `${item.ref}（在仓库之外，按设计不迁移）`
  if (item.state === 'type-mismatch') return `${item.ref}（类型变了：引用时是目录，现在是文件）`
  return `${item.ref}（这个工作树里没有）`
}

function bullets(label: string, items: readonly string[]): string[] {
  const clean = items.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (!clean.length) return []
  return [`${label}：`, ...clean.map((x) => `- ${x}`)]
}

/**
 * 构造交给新会话的正文。
 *
 * 只写「接手需要知道的」：不写源会话的模型 / 模式 / token 数（对模型没意义），
 * 也不写任何**无法当场核对**的进度声明（进度以 goal 为准，正文里只转述交接包原话）。
 */
export function buildForkContext(input: ForkContextInput): string {
  const env = input.env
  const lines: string[] = [forkContextMarker(input.forkId), HEADER, '']

  const branch = env.detached
    ? `detached @ ${env.head ?? '(未知)'}`
    : (env.branch ?? '(未知分支)') + (env.head ? ` @ ${env.head}` : '')
  const track = env.ahead || env.behind ? `，相对 upstream +${env.ahead}/-${env.behind} 个提交` : ''
  lines.push('当前工作树的**实际**状态（接手时在目标目录重新读的，不是从源会话抄来的）：')
  lines.push(`- 目录：${input.worktree}（仓库 ${input.repoName}）`)
  lines.push(`- 分支：${branch}${track}`)
  lines.push(`- 工作区：${env.changedCount} 个未提交变更`)
  if (input.source) {
    lines.push(`- 来源会话：${input.source.sessionId}（原工作目录 ${input.source.cwd}）`)
  }

  if (input.refs && input.refs.total > 0) {
    const r = input.refs
    const head = `源会话里提到过的文件在这个工作树里的对照：共 ${r.total} 个，${r.resolved} 个能对上`
    lines.push('', r.problems.length ? `${head}；对不上的：` : `${head}。`)
    if (r.problems.length) lines.push(...r.problems.map((item) => `- ${problemText(item)}`))
  }

  if (input.attachments && input.attachments.total > 0) {
    lines.push(
      '',
      `源会话里有 ${input.attachments.total} 个图片附件**没有带过来**（附件不迁移）。` +
        '需要哪张就在新会话里重新添加/截图发给我 —— 不要去猜它们的内容。'
    )
  }

  if (input.pkg) {
    const pkg = input.pkg
    lines.push('', '上一个会话留下的交接包（可迁移的知识部分）：')
    lines.push(`- 目标：${pkg.goal}`)
    lines.push(`- 交付物：${pkg.deliverable}`)
    lines.push(...bullets('约束与授权', pkg.constraints))
    lines.push(...bullets('验收标准', pkg.acceptance))
    lines.push(...bullets('已完成', pkg.done))
    lines.push(...bullets('未完成', pkg.remaining))
    lines.push(...bullets('阻塞', pkg.blockers))
    lines.push(...bullets('交接时认定的下一步', pkg.nextActions))
    if (pkg.files.length) {
      lines.push(...bullets('交接包里列的文件', pkg.files))
    }
  } else {
    lines.push('', '上一个会话**没有留下交接包**：只有上面这些（工作树状态 + 文件对照）。缺什么直接问。')
  }

  lines.push('', FOOTER)
  return lines.join('\n')
}

/**
 * 这段文本里有没有这个 `forkId` 的标记（用来判「已经注入过」）。
 *
 * 与 `handoff-resume.ts` 的同类判据同形：标记独占一行，所以按整行包含判断；
 * 空 id 一律 false（不能因为参数漏了就说注入过）。
 */
export function hasForkContextEvidence(rawText: unknown, forkId: string): boolean {
  const id = String(forkId ?? '').trim()
  if (!id) return false
  const text = typeof rawText === 'string' ? rawText : ''
  if (!text) return false
  return text.includes(forkContextMarker(id))
}
