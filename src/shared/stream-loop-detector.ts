/**
 * 流式输出重复检测（纯检测器）。
 *
 * 职责边界：只根据调用方喂入的增量文本判断「末尾精确周期」和「完整行短语池」，
 * 不访问 RPC、UI、会话文件或网络，也不执行任何终止动作；命中结果由宿主决定怎么用。
 *
 * 实现来源：Inkstone 死循环防护方案里「末尾精确周期 + 短语池」的检测思路，
 * 按方案所述 dsh-loop-guard 的 trailingCycle / phrasePool 概念独立重写，
 * 阈值、排除规则、检查步进与本文件实现均非逐字复制；已知限制见文件末尾。
 *
 * 保守原则：宁可漏报，不做相似度截断，不把「思考太久」当作独立依据。
 */

export type LoopRule = 'reasoning-cycle' | 'reasoning-lines' | 'text-cycle' | 'text-lines'

export interface LoopHit {
  /** 命中的规则：reasoning-* 对应思考流，text-* 对应正文流。 */
  rule: LoopRule
  /** 触发时该流累计接收的字符数。 */
  emittedChars: number
  /** 命中的重复量：周期规则为末尾冗余重复字符数，短语池为累计重复字符数。 */
  repeatedChars: number
}

export interface StreamLoopDetector {
  onThinking(delta: string): LoopHit | null
  onText(delta: string): LoopHit | null
  reset(): void
}

/** 代码内常量，第一版不做成用户可编辑项；调参只改这里。 */
export const STREAM_LOOP_LIMITS = {
  /** 思考流末尾周期要求的最短冗余重复字符数。 */
  thinkingMinRepeat: 512,
  /** 正文流末尾周期要求的最短冗余重复字符数。 */
  textMinRepeat: 256,
  /** 周期模板的最大长度。 */
  maxCycle: 512,
  /** 每累计这么多字符检查一次；检查点只由累计字符决定，与 delta 分块无关。 */
  checkInterval: 32,
  /** 短语池触发所需的累计重复字符数。 */
  poolMinRepeat: 2048,
  /** 短语池触发所需的重复覆盖比例（重复字符 / 纳入统计的字符）。 */
  poolMinCoverage: 0.6,
  /** 短语池触发所需的平均集中度（行出现次数 / 不同行数）。 */
  poolMinConcentration: 4,
  /** 短语池纳入统计的单行最大长度；超长行按代码/数据排除。 */
  poolMaxLineLength: 200,
  /** 短语池最多跟踪的不同行数；超限即停用短语池规则（宁可漏报）。 */
  poolMaxLines: 4096
} as const

type StreamKind = 'thinking' | 'text'

interface StreamState {
  kind: StreamKind
  /** 只保留末尾有界窗口，周期检测永远只看尾巴。 */
  tail: string
  tailLimit: number
  minRepeat: number
  /** 距上次检查累计的字符数。 */
  sinceCheck: number
  /** 该流累计接收的字符数。 */
  emitted: number
  /** 完整行 -> 出现次数。 */
  pool: Map<string, number>
  /** 纳入统计的字符总数（覆盖率分母）。 */
  poolChars: number
  /** 累计重复字符数。 */
  poolRepeated: number
  /** 纳入统计的行出现总次数。 */
  poolOccurrences: number
  /** 不同行数达到上限后停用短语池，避免无界内存。 */
  poolDisabled: boolean
  /** 尚未见到换行的行尾。 */
  pending: string
  /** 当前行因超长被丢弃，需要跳过它的完成动作。 */
  skipLine: boolean
  /** Markdown 围栏内容不参与任一规则；保留跨 delta 的围栏状态。 */
  fence: { char: string; length: number } | null
}

/** 含这些符号的行按代码 / 表格 / JSON / 日志排除，避免结构性重复误停。 */
const STRUCTURAL_CHARS = new Set([
  '{', '}', '[', ']', '<', '>', '|', '\\', ';', '`', '"', '\'', '(', ')', '=', '+', '*', '#', '/'
])

/** 至少含一个字母、数字或 CJK 字符才算正文短语。 */
const WORDISH = /[\p{L}\p{N}]/u

function createStreamState(kind: StreamKind): StreamState {
  const maxCycle = STREAM_LOOP_LIMITS.maxCycle
  const minRepeat = kind === 'thinking' ? STREAM_LOOP_LIMITS.thinkingMinRepeat : STREAM_LOOP_LIMITS.textMinRepeat
  return {
    kind,
    tail: '',
    tailLimit: 2 * maxCycle + Math.max(minRepeat, maxCycle),
    minRepeat,
    sinceCheck: 0,
    emitted: 0,
    pool: new Map<string, number>(),
    poolChars: 0,
    poolRepeated: 0,
    poolOccurrences: 0,
    poolDisabled: false,
    pending: '',
    skipLine: false,
    fence: null
  }
}

function resetStreamState(state: StreamState): void {
  state.tail = ''
  state.sinceCheck = 0
  state.emitted = 0
  state.pool.clear()
  state.poolChars = 0
  state.poolRepeated = 0
  state.poolOccurrences = 0
  state.poolDisabled = false
  state.pending = ''
  state.skipLine = false
  state.fence = null
}

/**
 * 判断一行是否属于代码 / 表格 / JSON / 日志这类结构性内容。
 * 命中即不纳入短语池、也用来否决周期模板；这是保守排除，可能漏掉少数正文。
 */
function looksLikeStructuredRecord(line: string): boolean {
  if (/^[ \t]/.test(line)) return true
  const trimmed = line.trim()
  if (trimmed.length < 2) return true
  if (trimmed.length > STREAM_LOOP_LIMITS.poolMaxLineLength) return true
  if (!WORDISH.test(trimmed)) return true
  for (const ch of trimmed) if (STRUCTURAL_CHARS.has(ch)) return true
  if (/^\d{1,2}:\d{2}(:\d{2})?/.test(trimmed)) return true
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return true
  if (/^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i.test(trimmed)) return true
  return false
}

/**
 * 把一个周期旋转到从「换行之后」开始，再做行结构判断。
 *
 * 末尾周期是按需要的长度从尾巴往前切的，切出来的模板可能正好落在半行上
 * （例如 `。\n\n好` 而不是 `好。\n\n`）。若直接按换行切，`。` 这种单字符片段
 * 会被当成结构性内容而把合法循环误排除。周期仍是同一段内容，旋转只是换个起点，
 * 所以统一旋转到换行后，行边界才与真实输出对齐。
 */
function canonicalTemplate(period: string): string {
  const newline = period.indexOf('\n')
  if (newline === -1) return period
  const start = newline + 1
  if (start >= period.length) return period
  return period.slice(start) + period.slice(0, start)
}

/** 周期模板里只要有非空结构行，就整体否决，避免把代码块/日志块当成循环。 */
function templateSuppressed(template: string): boolean {
  let sawContent = false
  for (const raw of template.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) continue
    if (looksLikeStructuredRecord(line)) return true
    sawContent = true
  }
  return !sawContent
}

/** 模板至少要两种字符，且含至少一个字母/数字/CJK，排除分隔线与空白。 */
function templateQualifies(tail: string, n: number, p: number, template: string): boolean {
  if (templateSuppressed(template)) return false
  const first = tail[n - p]
  let distinct = false
  let wordish = false
  for (let i = n - p; i < n; i++) {
    const ch = tail[i]
    if (!distinct && ch !== first) distinct = true
    if (!wordish && WORDISH.test(ch)) wordish = true
    if (distinct && wordish) return true
  }
  return false
}

/**
 * 末尾精确周期：返回末尾冗余重复的字符数（把「一个模板」视为首次出现，其后按周期对齐的字符算重复），
 * 未命中返回 null。
 *
 * 条件：模板长度 p <= maxCycle；末尾已对齐的字符数 >= minRepeat 且 >= 2p（即同一模板至少约 3 次）。
 * 只看末尾有界窗口，边界截断只会少算、不会多算。匹配量在达到阈值后即封顶，
 * 既避免退化输入下重复扫全窗口，也让报告值只表示「至少这么多」。
 */
function trailingCycleRepeats(tail: string, maxPeriod: number, minRepeat: number): number | null {
  const n = tail.length
  if (n < minRepeat + 1) return null
  // 整段只有一种字符时任何模板都缺第二种字符，直接退出（退化输入保护）。
  const last = tail.charCodeAt(n - 1)
  let uniform = true
  for (let i = n - 2; i >= 0; i--) {
    if (tail.charCodeAt(i) !== last) {
      uniform = false
      break
    }
  }
  if (uniform) return null
  for (let p = 1; p <= maxPeriod; p++) {
    if (n < p + minRepeat) break
    if (tail.charCodeAt(n - 1) !== tail.charCodeAt(n - 1 - p)) continue
    const needed = Math.max(minRepeat, 2 * p)
    let matched = 0
    for (let i = n - 1; i >= p && matched < needed; i--) {
      if (tail.charCodeAt(i) !== tail.charCodeAt(i - p)) break
      matched++
    }
    if (matched < needed) continue
    if (!templateQualifies(tail, n, p, canonicalTemplate(tail.slice(n - p, n)))) continue
    return matched
  }
  return null
}

/** 围栏边界隔离候选，避免代码内容污染围栏外的周期和短语池。 */
function clearCandidates(state: StreamState): void {
  state.tail = ''
  state.pool.clear()
  state.poolChars = 0
  state.poolRepeated = 0
  state.poolOccurrences = 0
  state.poolDisabled = false
}

function fenceMarker(line: string): RegExpMatchArray | null {
  return line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
}

function processLine(state: StreamState, line: string): void {
  const marker = fenceMarker(line)
  if (state.fence) {
    if (marker && marker[1][0] === state.fence.char && marker[1].length >= state.fence.length && marker[2].trim() === '') {
      state.fence = null
      clearCandidates(state)
    }
    return
  }
  if (marker) {
    state.fence = { char: marker[1][0], length: marker[1].length }
    clearCandidates(state)
    return
  }
  countLine(state, line)
}

/** 把一行计入短语池；第二次出现起算重复质量（第二次两份都算）。 */
function countLine(state: StreamState, line: string): void {
  if (state.poolDisabled) return
  if (looksLikeStructuredRecord(line)) return
  const len = line.length
  const prev = state.pool.get(line)
  if (prev === undefined) {
    if (state.pool.size >= STREAM_LOOP_LIMITS.poolMaxLines) {
      state.poolDisabled = true
      return
    }
    state.pool.set(line, 1)
    state.poolChars += len
    state.poolOccurrences += 1
    return
  }
  state.poolRepeated += prev === 1 ? len * 2 : len
  state.pool.set(line, prev + 1)
  state.poolChars += len
  state.poolOccurrences += 1
}

/** 处理新增增量里的完整行；跨 delta 的行尾挂在 pending 上。 */
function feedLines(state: StreamState, delta: string): void {
  let rest = state.pending + delta
  state.pending = ''
  let newline = rest.indexOf('\n')
  while (newline !== -1) {
    let line = rest.slice(0, newline)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (state.skipLine) state.skipLine = false
    else processLine(state, line)
    rest = rest.slice(newline + 1)
    newline = rest.indexOf('\n')
  }
  if (rest.length > STREAM_LOOP_LIMITS.poolMaxLineLength) {
    // 超长未完成行不再保留内容，只记住要跳过它。
    // 超长围栏起始行也要记住边界，否则丢弃 pending 后会误把代码当正文。
    if (!state.fence) {
      const marker = fenceMarker(rest)
      if (marker) {
        state.fence = { char: marker[1][0], length: marker[1].length }
        clearCandidates(state)
      }
    }
    state.pending = ''
    state.skipLine = true
  } else {
    state.pending = rest
  }
}

/** 短语池规则：重复质量、覆盖率、集中度同时达标。 */
function poolTriggers(state: StreamState): boolean {
  if (state.poolDisabled) return false
  if (state.poolRepeated < STREAM_LOOP_LIMITS.poolMinRepeat) return false
  if (state.poolChars === 0) return false
  if (state.poolRepeated / state.poolChars < STREAM_LOOP_LIMITS.poolMinCoverage) return false
  const concentration = state.poolOccurrences / Math.max(1, state.pool.size)
  return concentration >= STREAM_LOOP_LIMITS.poolMinConcentration
}

/** 追加到有界尾部窗口。 */
function appendTail(state: StreamState, segment: string): void {
  state.tail += segment
  if (state.tail.length > state.tailLimit) {
    state.tail = state.tail.slice(state.tail.length - state.tailLimit)
  }
}

/** 一次检查：先周期、后短语池，命中即返回。 */
function checkStream(state: StreamState): LoopHit | null {
  // 尚未换行的起始围栏也不检测，避免围栏标记横跨检查点时误判。
  if (state.fence || fenceMarker(state.pending)) return null
  const repeats = trailingCycleRepeats(state.tail, STREAM_LOOP_LIMITS.maxCycle, state.minRepeat)
  if (repeats !== null) {
    return {
      rule: state.kind === 'thinking' ? 'reasoning-cycle' : 'text-cycle',
      emittedChars: state.emitted,
      repeatedChars: repeats
    }
  }
  if (poolTriggers(state)) {
    return {
      rule: state.kind === 'thinking' ? 'reasoning-lines' : 'text-lines',
      emittedChars: state.emitted,
      repeatedChars: state.poolRepeated
    }
  }
  return null
}

/**
 * 处理一个增量。
 *
 * 关键点：把增量切成小段，使检查恰好落在「累计接收 32、64、96……字符」处。
 * 这样检查点只由累计字符数决定，与 Provider 如何切 delta 无关；单个大 delta
 * 中间夹着循环、尾部又恢复正常时，也会在循环那一段的检查点命中，不会漏报。
 * 没有累到下一个检查点则不检查（`sinceCheck` 保留余数）。
 */
function feed(state: StreamState, delta: string): LoopHit | null {
  if (delta.length === 0) return null
  let pos = 0
  while (pos < delta.length) {
    const take = Math.min(STREAM_LOOP_LIMITS.checkInterval - state.sinceCheck, delta.length - pos)
    const segment = pos === 0 && take === delta.length ? delta : delta.slice(pos, pos + take)
    state.emitted += take
    appendTail(state, segment)
    feedLines(state, segment)
    state.sinceCheck += take
    pos += take
    if (state.sinceCheck >= STREAM_LOOP_LIMITS.checkInterval) {
      state.sinceCheck = 0
      const result = checkStream(state)
      if (result) return result
    }
  }
  return null
}

export function createStreamLoopDetector(): StreamLoopDetector {
  const thinking = createStreamState('thinking')
  const text = createStreamState('text')
  // 一条消息至多上报一次命中；思考与正文各自维护独立的尾部窗口和短语池。
  let hit = false

  const dispatch = (state: StreamState, delta: string): LoopHit | null => {
    if (hit) return null
    const result = feed(state, delta ?? '')
    if (result) hit = true
    return result
  }

  return {
    onThinking(delta: string): LoopHit | null {
      return dispatch(thinking, delta)
    },
    onText(delta: string): LoopHit | null {
      return dispatch(text, delta)
    },
    reset(): void {
      hit = false
      resetStreamState(thinking)
      resetStreamState(text)
    }
  }
}

/**
 * 已知限制（不宣称完全无误报）：
 * - 只认「严格逐字重复」；语义等价但用词不同的循环、缓慢漂移的循环不会被周期规则发现。
 * - 短语池依赖完整行与短行；混在长行里的重复、或长度超过 poolMaxLineLength 的行不参与统计。
 * - Markdown 反引号/波浪线围栏内整体排除；不完整围栏可能使后续检测持续停用，宁可漏报。
 * - 结构性排除按字符启发式判断，正文里大量出现 `()`、`#`、`/` 等符号时会被排除，因而漏报。
 * - 非结构化的短句重复（例如纯正文日志行）仍可能命中 *-lines；这是规则本身的检测目标，
 *   宿主应保留人工终止与展示，不应把它当作模型故障的最终结论。
 * - 周期窗口与短语池均有固定上限，超长会话只保留尾部窗口 / 达上限后停用短语池，宁可漏报。
 * - 周期模板旋转到换行后判断，只解决「半行切片」这一种误排除；真正的代码/日志/表格仍按字符启发式排除。
 */
