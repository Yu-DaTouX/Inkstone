import type { ForkRefState } from './fork-rebind'

export const FORK_CONTEXT_TAG = 'yan-fork-context'

export interface ForkContextEnv {
  branch: string | null
  detached: boolean
  head: string | null
  ahead: number
  behind: number
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
  forkId: string
  worktree: string
  repoName: string
  env: ForkContextEnv
  source: { sessionId: string; cwd: string } | null
  refs: ForkContextRefs | null
  attachments: { total: number } | null
}

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

function problemText(item: ForkContextRefProblem): string {
  if (item.state === 'outside') return `${item.ref}（在仓库之外，按设计不迁移）`
  if (item.state === 'type-mismatch') return `${item.ref}（类型变了：引用时是目录，现在是文件）`
  return `${item.ref}（这个工作树里没有）`
}

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

  lines.push('', FOOTER)
  return lines.join('\n')
}

export function hasForkContextEvidence(rawText: unknown, forkId: string): boolean {
  const id = String(forkId ?? '').trim()
  if (!id) return false
  const text = typeof rawText === 'string' ? rawText : ''
  if (!text) return false
  return text.includes(forkContextMarker(id))
}
