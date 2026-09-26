/**
 * 子代理的**任务输入**与**结果汇总**（实施-25 P15）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决什么
 * ══════════════════════════════════════════════════════════════════
 * 「大任务可以并行推进，但回答仍由同一个人给出」（P15 的用户得到）。
 * 具体是三件事：
 *  ① **任务输入成形**（T15-1）：派活时把「要什么、拿什么、不许做什么」写清，
 *     而不是只给一句话 —— 并行的子任务跑偏了，主 agent 很难发现；
 *  ② **什么时候该并行**（T15-2 / T15-3）：把适合 / 不适合的清单写成可读常量，
 *     由宿主给模型看，不让每个调用方自己总结一份；
 *  ③ **结果汇总**（T15-4）：子任务回来时给主 agent 一份
 *     「摘要 / 来源 / 成果」，让主 agent 汇总之后再答用户。
 *
 * ── 一条刻意的留白：不猜「未决问题」 ──
 * `SubagentResult.openQuestions` 现在是**恒为空数组**。宿主不去从句子里找问号、
 * 猜哪句是未决 —— 「这是一个未决问题」属于理解，只有主 agent 能判断。
 * 字段留着是为了让将来的显式通道（子代理自己声明）有位置，而不是让宿主先猜一个。
 *
 * 它不碰 electron / pi / 文件系统，主进程与单测共用同一份规则。
 */

export interface SubagentBrief {
  /** 要做什么（一句话目标）。 */
  goal: string
  /** 交付物：希望拿到什么（清单 / 补丁 / 结论 / 文件）。 */
  deliverables: string[]
  /** 来源：这次只准依据哪些资料 / 目录。 */
  sources: string[]
  /** 边界：不许做什么（例如「不要改测试」「不要动 docs/」）。 */
  boundary: string
}

export const SUBAGENT_BRIEF_LIMITS = {
  maxGoal: 4000,
  maxBoundary: 2000,
  maxDeliverables: 8,
  maxSources: 20,
  /** 单条清单项最长多少字符（按 code point 数）。 */
  maxItem: 500
} as const

function charLength(text: string): number {
  return [...text].length
}

function listOf(raw: unknown, label: string, max: number): { ok: true; items: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] }
  if (!Array.isArray(raw)) return { ok: false, error: `${label}必须是数组` }
  const items: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') return { ok: false, error: `${label}里第 ${items.length + 1} 项不是字符串` }
    const trimmed = value.trim()
    if (!trimmed) continue
    if (charLength(trimmed) > SUBAGENT_BRIEF_LIMITS.maxItem) {
      return { ok: false, error: `${label}里有一项超过 ${SUBAGENT_BRIEF_LIMITS.maxItem} 字符` }
    }
    if (!items.includes(trimmed)) items.push(trimmed)
  }
  if (items.length > max) return { ok: false, error: `${label}最多 ${max} 项（实际 ${items.length}）` }
  return { ok: true, items }
}

/**
 * 把不可信的入参变成一份任务输入。
 *
 * `goal` 缺省时用任务描述顶上 —— 派活的人往往只写了一句任务，
 * 那**就是**目标；但其余字段一律不猜：不知道就没有。
 */
export function parseSubagentBrief(
  raw: unknown,
  fallbackGoal: string
): { ok: true; brief: SubagentBrief } | { ok: false; error: string } {
  const box = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const goalRaw = typeof box.goal === 'string' ? box.goal.trim() : ''
  const goal = goalRaw || fallbackGoal.trim()
  if (!goal) return { ok: false, error: '任务输入缺少目标（goal），也没有可用的任务描述' }
  if (charLength(goal) > SUBAGENT_BRIEF_LIMITS.maxGoal) {
    return { ok: false, error: `目标超过 ${SUBAGENT_BRIEF_LIMITS.maxGoal} 字符` }
  }
  const deliverables = listOf(box.deliverables, '交付物', SUBAGENT_BRIEF_LIMITS.maxDeliverables)
  if (!deliverables.ok) return deliverables
  const sources = listOf(box.sources, '来源', SUBAGENT_BRIEF_LIMITS.maxSources)
  if (!sources.ok) return sources
  const boundaryRaw = typeof box.boundary === 'string' ? box.boundary.trim() : ''
  if (charLength(boundaryRaw) > SUBAGENT_BRIEF_LIMITS.maxBoundary) {
    return { ok: false, error: `边界说明超过 ${SUBAGENT_BRIEF_LIMITS.maxBoundary} 字符` }
  }
  return {
    ok: true,
    brief: { goal, deliverables: deliverables.items, sources: sources.items, boundary: boundaryRaw }
  }
}

/**
 * 交给子代理的正文。
 *
 * 为什么要在 prompt 里重写一遍结构，而不是直接把任务原话丢过去：
 * 子代理看不到父会话的上下文，它只有这一段话。把「交付物 / 来源 / 边界」
 * 显式列出来，是让并行的它在没有回问机会的情况下也能做对。
 */
export function briefPrompt(brief: SubagentBrief, task: string): string {
  const lines: string[] = [brief.goal]
  const extra = task.trim() && task.trim() !== brief.goal.trim() ? task.trim() : ''
  if (extra) lines.push('', `任务原话：${extra}`)
  if (brief.deliverables.length > 0) {
    lines.push('', '要交回的东西：')
    for (const item of brief.deliverables) lines.push(`- ${item}`)
  }
  if (brief.sources.length > 0) {
    lines.push('', '只依据这些来源（不要自行扩大）：')
    for (const item of brief.sources) lines.push(`- ${item}`)
  }
  if (brief.boundary) lines.push('', `边界：${brief.boundary}`)
  lines.push('', '交回时先说结论（做了什么 / 结论是什么），再说依据；做不到的部分如实说做不到。')
  return lines.join('\n')
}

/** 记录列表 / 卡片上的一行输入摘要。 */
export function briefLine(brief: SubagentBrief): string {
  const parts: string[] = []
  if (brief.deliverables.length > 0) parts.push(`要交回：${brief.deliverables.join('、')}`)
  if (brief.sources.length > 0) parts.push(`依据：${brief.sources.join('、')}`)
  if (brief.boundary) parts.push(`边界：${brief.boundary}`)
  return parts.join(' · ')
}

/* ══════════════════════════════════════════════════════════════════
 * 一、什么时候该并行（T15-2 / T15-3）
 * ══════════════════════════════════════════════════════════════════ */

/** 适合拆出去的活：彼此独立、互不写同一处、回话来是一段结论。 */
export const SUBAGENT_FIT_CASES = [
  '独立来源搜集：几份彼此无关的资料各查一遍',
  '长材料分段：同一份长文档按段分头读，再汇总',
  '不同方案分析：同一问题让几个方向各给一版分析',
  '独立修改意见：对同一份代码 / 文档给出互不影响的意见'
] as const

/**
 * 不该拆的活。
 *
 * 最后一条最要紧：**导师与用户的连续交流必须留在主 agent** ——
 * 把它拆出去会让「同一个人」断掉（P15 的验收就是冲着这条来的）。
 */
export const SUBAGENT_UNFIT_CASES = [
  '短问答：派活的开销比它本身还大',
  '连续编辑同一段：两边会互相覆盖',
  '需要来回确认的一步：子代理没有回问机会',
  '导师与用户的连续交流：必须保持主 agent 同一个人'
] as const

/** 给模型看的一份说明（宿主统一出口，不让每个调用方各写一份）。 */
export function subagentFitText(): string {
  return [
    '适合拆出去并行：',
    ...SUBAGENT_FIT_CASES.map((item) => `- ${item}`),
    '不适合拆（留在主 agent）：',
    ...SUBAGENT_UNFIT_CASES.map((item) => `- ${item}`)
  ].join('\n')
}

/* ══════════════════════════════════════════════════════════════════
 * 二、结果汇总（T15-4）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 子任务交回来的东西（主 agent 汇总时的输入）。
 *
 * `summaryFrom` 是**如实标注**：这段摘要不是子代理自报的结构化结论，
 * 而是它最后一段话的摘录（或出错时的错误文本）。标出来才不会读成
 * 「子代理保证自己做对了」。
 */
export interface SubagentResult {
  summary: string
  summaryTruncated: boolean
  summaryFrom: 'last-message' | 'error' | 'none'
  /** 转录里**工具调用参数**出现过的来源（事实，不是从正文里猜的）。 */
  sources: string[]
  /** 成果：改动过的文件与结果文件位置。 */
  artifacts: string[]
  /** 未决问题 —— 当前恒为空，理由见文件头。 */
  openQuestions: string[]
  at: number
}

/** 摘要上限（按 code point 数）。 */
export const SUBAGENT_SUMMARY_MAX = 600
/** 来源 / 成果列表上限。 */
const SOURCE_MAX = 12
const ARTIFACT_MAX = 20

/** 这些工具的调用参数算「来源」（读了什么）。 */
const SOURCE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'web_search', 'fetch', 'browser'])
/**
 * 参数里这些键的值算来源**位置**。
 *
 * 刻意**不**包含 `pattern` / `query`：它们是搜索词，不是「读了哪里」——
 * 把「catch (」这种搜索词当作来源列出来，读的人会以为它依据了一份叫这名字的资料。
 */
const SOURCE_KEYS = ['path', 'file', 'filePath', 'filepath', 'dir', 'cwd', 'url']

export interface SubagentTranscriptLike {
  role: string
  text: string
  toolCalls?: { name: string; args?: unknown }[]
}

function pushUnique(list: string[], value: string, max: number): void {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500) return
  if (list.includes(trimmed)) return
  if (list.length >= max) return
  list.push(trimmed)
}

/**
 * 从一个运行（的转录 + 变更 + 结果路径）汇总出 T15-4 要的四件东西。
 *
 * 纯函数：只读入参，不碰全局，方便单测把「摘要取哪一条」这类规则钉住。
 */
export function summarizeSubagentRun(
  input: {
    transcript: readonly SubagentTranscriptLike[]
    diffPaths?: readonly string[]
    resultPath?: string
    error?: string
    status: string
  },
  now: number
): SubagentResult {
  /* 摘要 = 最后一条有正文的助手消息（流式累积的那条就是最终版） */
  let summary = ''
  let from: SubagentResult['summaryFrom'] = 'none'
  for (let i = input.transcript.length - 1; i >= 0; i -= 1) {
    const msg = input.transcript[i]
    if (msg.role !== 'assistant') continue
    const text = String(msg.text ?? '').trim()
    if (!text) continue
    summary = text
    from = 'last-message'
    break
  }
  if (from === 'none' && input.error) {
    summary = input.error.trim()
    from = 'error'
  }
  const codePoints = [...summary]
  const truncated = codePoints.length > SUBAGENT_SUMMARY_MAX
  if (truncated) summary = `${codePoints.slice(0, SUBAGENT_SUMMARY_MAX).join('')}…`

  /* 来源：只取工具调用参数里的事实，不从正文里抽词 */
  const sources: string[] = []
  for (const msg of input.transcript) {
    for (const call of msg.toolCalls ?? []) {
      if (!SOURCE_TOOLS.has(String(call.name ?? ''))) continue
      const args = call.args
      if (!args || typeof args !== 'object') continue
      const box = args as Record<string, unknown>
      for (const key of SOURCE_KEYS) {
        const value = box[key]
        if (typeof value === 'string') pushUnique(sources, value, SOURCE_MAX)
      }
    }
  }

  const artifacts: string[] = []
  for (const path of input.diffPaths ?? []) pushUnique(artifacts, String(path), ARTIFACT_MAX)
  if (input.resultPath) pushUnique(artifacts, input.resultPath, ARTIFACT_MAX)

  return {
    summary,
    summaryTruncated: truncated,
    summaryFrom: from,
    sources,
    artifacts,
    /* 刻意为空：判断「哪句是未决问题」是理解，只有主 agent 能做（见文件头） */
    openQuestions: [],
    at: now
  }
}

/** 主 agent 汇总时值不值得看：有摘要、有来源或有成果就算有内容。 */
export function resultHasContent(result: SubagentResult): boolean {
  return !!result.summary || result.sources.length > 0 || result.artifacts.length > 0
}
