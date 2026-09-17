/**
 * 状态生成器（N21-4 剩余项 / N21-5 的语义部分）——**纯逻辑**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决的问题
 * ══════════════════════════════════════════════════════════════════
 * 在它之前，`session_before_compact` **实际上总是**降级回 pi 自己的摘要
 * （没有状态文件就没有结构化接管）。而状态文件里的语义内容
 * （objective / decisions / constraints / assumptions / nextActions…）
 * 不可能机械拼出来 —— 机械拼的「摘要」缺 decisions，比不上 pi 的原生摘要。
 *
 * 所以这里做**混合式**生成（方案 §16.2 第 4 条、§16.6.1 的共识）：
 *   · **确定性 reducer**（零模型成本）：`files` / `commandsRun` / `testsRun`
 *     从真实工具调用与真实输出里**抄**出来，带真实 `entryId`；
 *   · **一次无工具 completion**：只让模型产出语义字段
 *     （objective / decisions / constraints / …），全部标
 *     `source: { kind: 'model', confidence: 'hypothesis' }`；
 *   · 落盘前**确定性 evidence 覆盖模型返回的同名字段** ——
 *     模型编不出「跑过什么命令」，那段只能由 reducer 提供，这是防幻觉的第一道闸门。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么整块逻辑是纯的
 * ══════════════════════════════════════════════════════════════════
 * 生成器是**唯一**会调模型、会写用户派生数据的部分。它的失败模式
 * （编造约束、把陈旧状态当有效、迟到结果覆盖新快照、状态自身膨胀到吃掉工作集）
 * 都发生在真实会话里且极难复现 —— 所以判定全部落在这里，由单测钉死；
 * `context.js` 只负责「取消息 → 调 completion → 落盘」这三件有 IO 的事。
 *
 * 不 import 任何 IO 模块、不读环境变量（`kinds` / 阈值由调用方传入）。
 */
import {
  RECALL_PREFIX,
  RECALL_STUB_PREFIX,
  estimateTokens,
  isTombstoneText,
  messageText,
  renderTaskState,
  toolCallsOf,
  toolPaths
} from './context-transform.js'

/* ══════════════════════════════════════════════════════════════════
 * 预算与裁剪上限（方案 §16.6.2 的字段级口径）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 状态自身的 token 预算。
 *
 * 状态是**要喂给模型的前置块**，它自己也会膨胀 —— 一份 10k token 的
 * 「状态」等于又加了一轮上下文，压缩的收益被它吃掉（Codex 补的第 1 条硬要求）。
 * `target` 是常态目标，`hard` 是任何情况下都不许越过的上限。
 * 硬上限取 `min(6000, max(2500, workingSet × 0.025))`（§16.6.2）。
 */
export const PRODUCER_BUDGET = {
  target: 3_500,
  hardFloor: 2_500,
  hardCeil: 6_000,
  hardRatio: 0.025
}

/** 各字段的裁剪上限（§16.6.2 的优先级：objective 永不删 → 约束不删 → 其余按表） */
export const CLIP_LIMITS = {
  currentState: 10,
  decisions: 12,
  constraints: 20,
  completed: 10,
  failedAttempts: 8,
  unresolved: 8,
  nextActions: 8,
  assumptions: 8,
  hypothesis: 6,
  files: 40,
  commands: 6,
  tests: 4,
  symbols: 24,
  /** 语义条目的单条长度上限（超长的不是结论，是转录） */
  textLength: 300
}

/** 单次语义生成的输出字段（白名单：模型多说的一律丢掉） */
export const SEMANTIC_FIELDS = [
  'objective',
  'currentPhase',
  'currentState',
  'decisions',
  'constraints',
  'completed',
  'failedAttempts',
  'unresolved',
  'nextActions',
  'assumptions',
  'hypothesis'
]

/** 一眼是「测试命令」的判据（只用来分类，不改变命令本身） */
const TEST_COMMAND_RE =
  /(?:^|[\s&|;])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest|typecheck|lint)|vitest|jest|pytest|go\s+test|cargo\s+test|ctest|dotnet\s+test|mocha|playwright\s+test|\btest:unit\b|--runInBand/i

/** bash 类工具名（拿 `command` 参数） */
const SHELL_TOOL_RE = /(?:^|_|\b)(?:bash|shell|exec|terminal|command)(?:$|_|\b)/i
/** 会改文件的工具名 */
const WRITE_TOOL_RE = /write|edit|apply_patch|create|patch|replace/i

/* ══════════════════════════════════════════════════════════════════
 * ① 确定性 evidence reducer
 * ══════════════════════════════════════════════════════════════════ */

function firstLine(text, max = 160) {
  const line = String(text ?? '').trim().split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 从工具输出里读退出码（读不到 = undefined，**绝不猜**） */
export function exitCodeOf(text) {
  if (typeof text !== 'string' || !text) return undefined
  const patterns = [
    /exit code[:=]\s*(-?\d+)/i,
    /exited with (?:code|status)\s+(-?\d+)/i,
    /process exited with code\s+(-?\d+)/i
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return Number(m[1])
  }
  return undefined
}

/** 从测试输出里读 passed / failed 计数（读不到就不写） */
export function testCountsOf(text) {
  if (typeof text !== 'string' || !text) return {}
  const out = {}
  const passed = /(\d+)\s+passed/i.exec(text)
  if (passed) out.passed = Number(passed[1])
  const failed = /(\d+)\s+failed/i.exec(text)
  if (failed) out.failed = Number(failed[1])
  return out
}

/**
 * 从真实消息里抄出确定性 evidence。
 *
 * 输入约定与 `context-transform.js` 的 `adaptMessages` 一致：
 * `entryIds` 与 `messages` **必须等长**（不等长直接返回空 evidence ——
 * 宁可这次没有 evidence，也不能把别人的 entryId 记到这条命令上，
 * 那样 Recall 会取回别的历史）。
 *
 * 只抄，不推断：命令原文、路径、退出码、测试计数全部来自消息本身；
 * 读不到就留空。
 *
 * @returns {{ok: boolean, commandsRun: object[], testsRun: object[], files: object[], reason?: string}}
 */
export function evidenceFromMessages({ messages, entryIds } = {}) {
  const empty = { ok: false, commandsRun: [], testsRun: [], files: [], reason: 'no-identity' }
  if (!Array.isArray(messages) || messages.length === 0) return empty
  if (!Array.isArray(entryIds) || entryIds.length !== messages.length) return empty

  /** toolCallId → { name, args, entryId } */
  const pending = new Map()
  const commandsRun = []
  const testsRun = []
  const files = new Map()

  const noteFile = (path, state, entryId) => {
    const key = path
    const prev = files.get(key)
    /* 同一文件先读后改 → 记 modified（最终状态才是重要的） */
    if (prev && prev.state === 'modified') return
    files.set(key, {
      path,
      state,
      source: { kind: 'file', path, ...(entryId ? { entryId } : {}), confidence: 'observed' }
    })
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const entryId = typeof entryIds[i] === 'string' ? entryIds[i] : undefined

    for (const call of toolCallsOf(message)) {
      pending.set(call.id, { name: call.name, args: call.args, entryId })
      /* 文件状态：工具参数里就有路径，不必等结果 */
      for (const path of toolPaths(call.args)) {
        noteFile(path, WRITE_TOOL_RE.test(call.name) ? 'modified' : 'read', entryId)
      }
    }

    if (message?.role !== 'toolResult') continue
    const callId = message.toolCallId
    const call = callId ? pending.get(callId) : undefined
    if (!call) continue
    const output = messageText(message)

    if (typeof call.args?.command === 'string' && call.args.command.trim() && SHELL_TOOL_RE.test(call.name)) {
      const command = firstLine(call.args.command, 200)
      const exitCode = exitCodeOf(output)
      if (TEST_COMMAND_RE.test(call.args.command)) {
        const counts = testCountsOf(output)
        testsRun.push({
          command,
          ...(counts.passed === undefined ? {} : { passed: counts.passed }),
          ...(counts.failed === undefined ? {} : { failed: counts.failed }),
          source: { kind: 'tool', ...(call.entryId ? { entryId: call.entryId } : {}), confidence: 'observed' }
        })
      } else {
        commandsRun.push({
          command,
          ...(exitCode === undefined ? {} : { exitCode }),
          source: { kind: 'tool', ...(call.entryId ? { entryId: call.entryId } : {}), confidence: 'observed' }
        })
      }
    }
  }

  /*
   * 失败的与最近的都留：命令只留最近 CLIP_LIMITS.commands 条，
   * 但这几条里失败的优先（§16.6.2：失败的优先留）。
   */
  const rankedCommands = [
    ...commandsRun.filter((c) => c.exitCode !== undefined && c.exitCode !== 0),
    ...commandsRun.filter((c) => c.exitCode === undefined || c.exitCode === 0)
  ]
  const seenCommands = new Set()
  const keptCommands = []
  for (const c of rankedCommands) {
    if (seenCommands.has(c.command)) continue
    seenCommands.add(c.command)
    keptCommands.push(c)
    if (keptCommands.length >= CLIP_LIMITS.commands) break
  }

  const failedTests = testsRun.filter((t) => (t.failed ?? 0) > 0)
  const okTests = testsRun.filter((t) => (t.failed ?? 0) === 0)
  const keptTests = [...failedTests, ...okTests.slice(-1)]

  return {
    ok: true,
    commandsRun: keptCommands,
    testsRun: keptTests,
    files: [...files.values()]
  }
}

/**
 * 最近 N 条用户消息的**原样**摘录（供约束做 verbatim 对齐；不启发式改写）。
 *
 * 返回 `{ text, entryId }` 而不是裸字符串：命中约束时要能把**真实 entryId**
 * 写进 provenance（可追溯、可校验）—— 只有文本就查不出这条约束出自哪一轮。
 */
export function userDirectives(messages, entryIds, limit = 8, maxLength = 240) {
  if (!Array.isArray(messages)) return []
  const ids = Array.isArray(entryIds) ? entryIds : []
  const out = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = messageText(message).trim()
    if (!text) continue
    const entryId = typeof ids[i] === 'string' && ids[i] ? ids[i] : undefined
    out.push({ text: text.length > maxLength ? `${text.slice(0, maxLength)}…` : text, ...(entryId ? { entryId } : {}) })
  }
  return out.reverse()
}

/* ══════════════════════════════════════════════════════════════════
 * ② 提示词（一次无工具 completion）
 * ══════════════════════════════════════════════════════════════════ */

export const PRODUCER_SYSTEM_PROMPT = [
  'You maintain the working state of a coding session. You are given:',
  '  · the previous state (if any),',
  '  · the user messages that carry constraints and intent,',
  '  · deterministic facts the host already extracted (files touched, commands run, tests run).',
  '',
  'Reply with ONE JSON object and nothing else. Fields (all optional, all arrays of short strings unless noted):',
  '  objective (string, one line, what the user is trying to achieve),',
  '  currentPhase (string, short),',
  '  currentState, decisions, constraints, completed, failedAttempts, unresolved, nextActions, assumptions, hypothesis.',
  '',
  'Rules:',
  '  · Only state things you can support from the material given. If unsure, leave the array empty.',
  '  · constraints must be things the USER actually required — quote their own words where possible.',
  '  · Do NOT invent files, commands or test results: the host owns those fields and will override yours.',
  '  · nextActions must be concrete and still pending; do not repeat completed work.',
  '  · Write values in the same language the user writes in.',
  '  · Keep every item under one sentence. No markdown, no code fences.'
].join('\n')

/**
 * 拼生成器的用户消息。
 *
 * 只把**必要材料**放进去：上一版状态的渲染、用户原话摘录、确定性 evidence。
 * 不放整段对话 —— 那是 pi 自己摘要的活，不是状态生成的活（放进去只会
 * 让模型把状态写成聊天摘要，正是 §12.6 明确反对的）。
 */
export function buildProducerPrompt({ previousTask, directives, evidence } = {}) {
  const parts = []
  const previous = previousTask ? renderTaskState(previousTask) : ''
  parts.push('<previous_state>')
  parts.push(previous || '(none)')
  parts.push('</previous_state>')
  parts.push('')
  parts.push('<user_messages>')
  for (const d of Array.isArray(directives) ? directives : []) parts.push(`- ${typeof d === 'string' ? d : d.text}`)
  if (!directives || !directives.length) parts.push('(none)')
  parts.push('</user_messages>')
  parts.push('')
  parts.push('<verified_facts>')
  const files = evidence?.files ?? []
  const commands = evidence?.commandsRun ?? []
  const tests = evidence?.testsRun ?? []
  parts.push(
    `files: ${files.length ? files.map((f) => `${f.path} (${f.state})`).join(', ') : '(none)'}`
  )
  parts.push(`commands: ${commands.length ? commands.map((c) => `${c.command}${c.exitCode === undefined ? '' : ` [exit ${c.exitCode}]`}`).join(' | ') : '(none)'}`)
  parts.push(
    `tests: ${tests.length ? tests.map((t) => `${t.command}${t.failed ? ` [${t.failed} failed]` : t.passed !== undefined ? ` [${t.passed} passed]` : ''}`).join(' | ') : '(none)'}`
  )
  parts.push('</verified_facts>')
  parts.push('')
  parts.push('Reply with the JSON object now.')
  return parts.join('\n')
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 解析与清洗（模型输出不可信）
 * ══════════════════════════════════════════════════════════════════ */

function stringList(value, limit, maxLength) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const clipped = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
    if (seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= limit) break
  }
  return out
}

/** 从自由文本里抠出第一个 JSON 对象（容忍 code fence 与前后废话） */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  /* 从后往前找最后一个 `}`：模型偶尔会在 JSON 后面再写一句解释 */
  const end = cleaned.lastIndexOf('}')
  if (end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 解析并清洗模型输出。
 *
 * 白名单 + 逐字段裁剪 + 去重。`objective` 缺失即视为这次生成失败 ——
 * 没有目标的「状态」就是一份剪辑过的聊天记录，会误导模型。
 */
export function parseProducerOutput(text) {
  const raw = extractJsonObject(text)
  if (!raw) return { ok: false, reason: 'not-json' }
  const objective = typeof raw.objective === 'string' ? raw.objective.replace(/\s+/g, ' ').trim() : ''
  if (!objective) return { ok: false, reason: 'no-objective' }
  const value = {
    objective: objective.length > CLIP_LIMITS.textLength ? objective.slice(0, CLIP_LIMITS.textLength - 1) + '…' : objective,
    currentPhase: typeof raw.currentPhase === 'string' ? raw.currentPhase.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    currentState: stringList(raw.currentState, CLIP_LIMITS.currentState, CLIP_LIMITS.textLength),
    decisions: stringList(raw.decisions, CLIP_LIMITS.decisions, CLIP_LIMITS.textLength),
    constraints: stringList(raw.constraints, CLIP_LIMITS.constraints, CLIP_LIMITS.textLength),
    completed: stringList(raw.completed, CLIP_LIMITS.completed, CLIP_LIMITS.textLength),
    failedAttempts: stringList(raw.failedAttempts, CLIP_LIMITS.failedAttempts, CLIP_LIMITS.textLength),
    unresolved: stringList(raw.unresolved, CLIP_LIMITS.unresolved, CLIP_LIMITS.textLength),
    nextActions: stringList(raw.nextActions, CLIP_LIMITS.nextActions, CLIP_LIMITS.textLength),
    assumptions: stringList(raw.assumptions, CLIP_LIMITS.assumptions, CLIP_LIMITS.textLength),
    hypothesis: stringList(raw.hypothesis, CLIP_LIMITS.hypothesis, CLIP_LIMITS.textLength)
  }
  return { ok: true, value }
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 合并：语义（模型）+ evidence（reducer）+ 上一版（生命周期）
 * ══════════════════════════════════════════════════════════════════ */

const norm = (text) => String(text ?? '').replace(/\s+/g, '').toLowerCase()

/**
 * 把一条模型给出的「约束」与用户原话对齐。
 *
 * 这是 §13.1 / N21-10 规则②要求的落地：**用户约束不得降级为普通历史**。
 * 模型说「用户要求不要动 X」时，如果能在真实 user 消息里找到对应原文，
 * 这条就升级成 `kind: 'user' / confidence: 'observed'` 并带上 `entryId`
 * （可追溯、可校验）；找不到就老实标成 hypothesis —— 不伪造 provenance。
 */
export function matchDirective(text, directives) {
  const target = norm(text)
  if (target.length < 6) return null
  for (const entry of Array.isArray(directives) ? directives : []) {
    const source = norm(entry?.text)
    if (!source) continue
    if (source.includes(target) || target.includes(source)) return entry
    /* 长条目做片段包含（模型一般会缩写，不会逐字复述） */
    const probe = target.slice(0, Math.min(24, target.length))
    if (probe.length >= 8 && source.includes(probe)) return entry
  }
  return null
}

function toEntries(list, now, { userMatched = false, directives = null } = {}) {
  return list.map((text) => {
    const hit = userMatched ? matchDirective(text, directives) : null
    return {
      text,
      status: 'active',
      source: hit
        ? { kind: 'user', ...(hit.entryId ? { entryId: hit.entryId } : {}), confidence: 'observed' }
        : { kind: 'model', confidence: 'hypothesis' },
      updatedAt: now
    }
  })
}

/**
 * 组装完整的 TaskState。
 *
 * 三条硬规则（顺序即优先级）：
 *   ① `files` / `commandsRun` / `testsRun` / `symbolsTouched` **只能**来自 reducer ——
 *      模型给的同名字段一律丢弃（防幻觉污染 durable state，§16.6.1）；
 *   ② 上一版里 `status !== 'active'` 的条目原样保留（那是历史，不是垃圾）；
 *   ③ `constraints` 命中用户原话就带上 `entryId`（可校验），否则标 hypothesis。
 *
 * @returns {object|null} 合法则返回 TaskState，`objective` 缺失返回 null
 */
export function mergeTaskState({ semantics, evidence, previous, directives, now } = {}) {
  if (!semantics?.objective) return null
  const at = Number.isFinite(now) ? now : Date.now()
  const prev = previous && typeof previous === 'object' ? previous : null

  const keptInactive = (key) => (Array.isArray(prev?.[key]) ? prev[key].filter((item) => item && item.status !== 'active' && typeof item.text === 'string') : [])

  const mergeEntries = (key, list, opts) => [...toEntries(list, at, opts), ...keptInactive(key)]

  return {
    task: {
      objective: semantics.objective,
      currentPhase: semantics.currentPhase || prev?.task?.currentPhase || ''
    },
    currentState: mergeEntries('currentState', semantics.currentState ?? []),
    decisions: mergeEntries('decisions', semantics.decisions ?? []),
    constraints: mergeEntries('constraints', semantics.constraints ?? [], {
      userMatched: true,
      directives
    }),
    completed: mergeEntries('completed', semantics.completed ?? []),
    failedAttempts: mergeEntries('failedAttempts', semantics.failedAttempts ?? []),
    unresolved: mergeEntries('unresolved', semantics.unresolved ?? []),
    nextActions: mergeEntries('nextActions', semantics.nextActions ?? []),
    assumptions: mergeEntries('assumptions', semantics.assumptions ?? []),
    hypothesis: mergeEntries('hypothesis', semantics.hypothesis ?? []),
    /* ② 确定性字段：只认 reducer；reducer 读不到就沿用上一版（不是模型） */
    files: evidence?.files?.length ? evidence.files : (prev?.files ?? []),
    commandsRun: evidence?.commandsRun?.length ? evidence.commandsRun : (prev?.commandsRun ?? []),
    testsRun: evidence?.testsRun?.length ? evidence.testsRun : (prev?.testsRun ?? []),
    symbolsTouched: prev?.symbolsTouched ?? [],
    episodeRefs: prev?.episodeRefs ?? [],
    archiveRefs: prev?.archiveRefs ?? []
  }
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 裁剪：状态自己也会膨胀
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 按优先级裁剪 TaskState，并给出裁剪后的估算 token。
 *
 * 优先级（§16.6.2）：`objective` 永不删 → 约束不删 → 其余按上限表；
 * `files` 40 / `commands` 6 / `symbols` 24 / `assumptions` 8 / `hypothesis` 6 / `nextActions` 8。
 * **失败的测试永远优先于通过的**：它是当前要做的事。
 */
export function clipTaskState(task) {
  if (!task || typeof task !== 'object') return task
  const clip = (list, limit) => (Array.isArray(list) ? list.slice(-limit) : [])
  const activeFirst = (list, limit, predicate) => {
    const items = Array.isArray(list) ? list : []
    const priority = items.filter(predicate)
    const rest = items.filter((item) => !predicate(item))
    return [...priority, ...rest].slice(0, limit)
  }
  return {
    ...task,
    currentState: clip(task.currentState, CLIP_LIMITS.currentState),
    decisions: clip(task.decisions, CLIP_LIMITS.decisions),
    /* 约束不删：只去重与限长（上限是防爆，不是常规路径） */
    constraints: clip(task.constraints, CLIP_LIMITS.constraints),
    completed: clip(task.completed, CLIP_LIMITS.completed),
    failedAttempts: clip(task.failedAttempts, CLIP_LIMITS.failedAttempts),
    unresolved: clip(task.unresolved, CLIP_LIMITS.unresolved),
    nextActions: clip(task.nextActions, CLIP_LIMITS.nextActions),
    assumptions: clip(task.assumptions, CLIP_LIMITS.assumptions),
    hypothesis: clip(task.hypothesis, CLIP_LIMITS.hypothesis),
    files: clip(task.files, CLIP_LIMITS.files),
    commandsRun: activeFirst(task.commandsRun, CLIP_LIMITS.commands, (c) => c?.exitCode !== undefined && c.exitCode !== 0),
    testsRun: activeFirst(task.testsRun, CLIP_LIMITS.tests, (t) => (t?.failed ?? 0) > 0),
    symbolsTouched: clip(task.symbolsTouched, CLIP_LIMITS.symbols)
  }
}

/** 状态渲染出来的估算 token（用于预算判定与诊断） */
export function taskStateTokens(task) {
  const text = renderTaskState(task)
  return text ? estimateTokens(text) : 0
}

/**
 * 状态自身的硬上限：`min(hardCeil, max(hardFloor, workingSet × hardRatio))`。
 * 工作集未知（0）时用 `hardCeil`（宁可按最宽松的算，也不要为了省 token 丢约束）。
 */
export function taskStateHardLimit(workingSet) {
  const set = Number.isFinite(workingSet) && workingSet > 0 ? workingSet : 0
  if (!set) return PRODUCER_BUDGET.hardCeil
  return Math.min(PRODUCER_BUDGET.hardCeil, Math.max(PRODUCER_BUDGET.hardFloor, Math.round(set * PRODUCER_BUDGET.hardRatio)))
}

/**
 * 反复裁剪直到低于硬上限：先丢 `hypothesis` → `assumptions` → `decisions`
 * → `currentState` → `completed`，**绝不**丢 objective / constraints /
 * failedAttempts / unresolved（它们是「接着干下去」的最小集）。
 * 仍超限时返回 `{ task, over: true }`，由调用方决定是否放弃这次生成。
 */
export function clipTaskStateToBudget(task, workingSet) {
  const hard = taskStateHardLimit(workingSet)
  let current = clipTaskState(task)
  const dropOrder = ['hypothesis', 'assumptions', 'decisions', 'currentState', 'completed', 'symbolsTouched', 'files', 'commandsRun', 'testsRun']
  for (const key of dropOrder) {
    if (taskStateTokens(current) <= hard) return { task: current, tokens: taskStateTokens(current), over: false }
    const list = current[key]
    if (!Array.isArray(list) || list.length === 0) continue
    /* 一轮砍一半，直到为空 */
    let next = list
    while (next.length > 0 && taskStateTokens(current) > hard) {
      next = next.slice(0, Math.floor(next.length / 2))
      current = { ...current, [key]: next }
    }
  }
  const tokens = taskStateTokens(current)
  return { task: current, tokens, over: tokens > hard }
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ Freshness：水位对不上不等于状态没价值（§16.2 第 3 条）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 算状态水位与当前会话的关系与「落后了多少条」。
 *
 * 为什么不能只认「完全一致」：生成是**异步**的，快照落盘时原始会话
 * 往往又前进了 —— 精确匹配会让异步生成几乎永不生效（availability cliff）。
 * 判据改成 **ancestry 正确 + 有界陈旧**：
 *   · `same`     —— 完全一致；
 *   · `older`    —— 状态的水位是当前条目的前缀（能定位，只是旧）；
 *   · `diverged` —— 状态里那条 entryId 在当前会话里找不到（被裁剪 / 回退 / 换会话）。
 */
export function freshnessOf({ stateWatermark, entries } = {}) {
  const ids = Array.isArray(entries) ? entries.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean) : []
  const count = ids.length
  const lastEntryId = count ? ids[count - 1] : null
  const w = stateWatermark
  /* 落后**回合**数（旧快照之后又过了几个用户回合）；定位不到 lastEntryId 时返回 null */
  const turnsGap = turnsSince(entries, stateWatermark)
  /* 新增的是不是「只有用户刚说的那一条」（尚未 settled）—— 见 freshView 的说明 */
  const pendingOnly = pendingUserOnly(entries, stateWatermark)
  if (!w || !Number.isFinite(w.entryCount)) {
    return { relation: 'diverged', gap: Infinity, turnsGap, pendingOnly, count, lastEntryId }
  }
  if (w.entryCount === count && (w.lastEntryId ?? null) === lastEntryId) {
    return { relation: 'same', gap: 0, turnsGap: turnsGap ?? 0, pendingOnly: false, count, lastEntryId }
  }
  if (w.entryCount <= count && (w.entryCount === 0 || ids.includes(w.lastEntryId))) {
    return { relation: 'older', gap: count - w.entryCount, turnsGap, pendingOnly, count, lastEntryId }
  }
  return { relation: 'diverged', gap: Infinity, turnsGap, pendingOnly, count, lastEntryId }
}

/**
 * 水位之后新增的是不是「只有用户刚说的那一条」（尚未 settled）。
 *
 * 判据（第四轮复核 Q3 的原话是「唯一新增的是当前尚未 settled 的 user turn」）：
 *   · 恰好一条 user 消息；
 *   · 其余新增条目**都不是执行事实**（即不是 assistant / toolResult）——
 *     pi 会写一些非执行的包装条目（custom_message / branch_summary / compaction），
 *     它们不影响「用户又说了句话」这个事实。
 * 一旦出现新的执行事实，就不适用（该走真实的 stale 分档）。
 */
export function pendingUserOnly(entries, watermark) {
  const tail = tailEntries(entries, watermark)
  if (!tail || !tail.length) return false
  const users = tail.filter(isUserEntry)
  if (users.length !== 1) return false
  /*
   * **反向判据**：只要出现 assistant / toolResult 这类「执行事实」，就不再是
   * 「只落后用户刚开口的那一条」。反过来，**非 message 的条目一律不构成执行事实** ——
   * pi 会写多种包装条目（`session_info` / `custom_message` / `branch_summary` / `compaction`…），
   * 用白名单枚举它们是必然会漏的：线上第一次就是被 `session_info` 卡住的
   * （诊断里 `tail: ["session_info","user"]`，于是明明只落后 1 条 user 却判成了 partial）。
   */
  return tail.every((e) => e?.type !== 'message' || e?.message?.role === 'user')
}

/** 水位之后的条目（定位不到水位条目时返回 null） */
function tailEntries(entries, watermark) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.type !== 'session') : []
  const lastId = watermark && typeof watermark.lastEntryId === 'string' ? watermark.lastEntryId : null
  if (!lastId) return null
  const at = list.findIndex((e) => e?.id === lastId)
  if (at < 0) return null
  return list.slice(at + 1)
}

/**
 * 水位之后新增条目的**角色指纹**（诊断用）。
 *
 * 为什么要有它：`freshness` 到底是 fresh 还是 partial，取决于水位之后到底多了几条、
 * 都是什么 —— 只看一个 `gap` 数字排查不了（线上第一次就碰到这个：真实链路里
 * 注入的档位是 partial，而单看数字看不出多出来的那一条是什么）。
 */
export function tailRolesOf(entries, watermark) {
  const tail = tailEntries(entries, watermark)
  if (!tail) return null
  return tail.map((e) => (e?.type === 'message' ? (e.message?.role ?? 'message') : (e?.type ?? 'unknown')))
}

/**
 * freshness 的**注入视角**：把「只落后当前这一条尚未 settled 的用户消息」视为与快照同步。
 *
 * 为什么必须这样（第四轮外部复核 Q3）：生成在回合 N 结束（`agent_settled`），注入发生在
 * **下一次** `context`；而用户必然要在回合 N+1 里先开口，钩子才会被调到。所以**正常消费路径上
 * 水位必然落后 1 条 user 消息**。把它叫 stale，等于让 `fresh` 在稳态下永远不可达 ——
 * 模型每轮都被告知「你拿到的状态不可靠」，那是主动削弱这个功能本身的价值。
 * 真正的陈旧应当是「已经有新的**执行事实**」（新的 tool result / assistant 执行 / 额外回合），
 * 而不仅是「用户又说了句话」——后者已经被 authority 优先级覆盖（新用户指令 > 本块）。
 *
 * 为什么不是「只给 hypothesis 标 stale」：易变性不是 hypothesis 独有（一句「别做 A 了」
 * 同样能改写 nextActions / currentPhase / objective），在字段层猜哪个最容易失效治不了根。
 *
 * **代价（明确记录）**：极端情况下用户消息已经推翻了 `nextActions`，头行仍写 `fresh`。
 * 三层缓冲：① 那条用户消息本身比状态新且在上下文里；② authority 已声明用户指令优先；
 * ③ `sourceHead` 仍是真实水位（没有伪造 provenance）。
 */
export function freshView(fresh) {
  if (!fresh || typeof fresh !== 'object') return fresh
  if (fresh.pendingOnly !== true) return fresh
  return { ...fresh, relation: 'same', gap: 0 }
}

/** 这个条目是不是「用户真的说了话」（回合的边界） */
export function isUserEntry(entry) {
  return entry?.type === 'message' && entry?.message?.role === 'user'
}

/**
 * 旧快照之后过了**几个用户回合**（§16.6.2 的「落后 ≥2 回合」）。
 *
 * 为什么不是条目数差：一个回合会产生**多条** entry（user + assistant + N 个
 * toolResult），用条目差当「落后几回合」会把一个回合算成 3–8 个回合并提前刷新，
 * 让 dirty 权重（≥6）那个闸门在长会话里形同虚设 ——
 * 而「打开 `episode-fold` 到底花多少钱」正是由这个闸门决定的。
 *
 * 定位不到水位条目（被压缩 / 换分支 / 换会话）时返回 `null`，由调用方决定兜底。
 */
export function turnsSince(entries, watermark) {
  const tail = tailEntries(entries, watermark)
  if (!tail) return null
  return tail.filter(isUserEntry).length
}

/**
 * 转录的规模统计：用户回合数与估算 token。
 *
 * 两样都从**原始条目**数/估 —— 不读 `get_messages`（压缩过的会话只剩尾巴）。
 * token 用「UTF-16 长度 ÷ 4」的同一近似（`estimateTokens`），只用于门槛判定。
 */
export function transcriptStats(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.type !== 'session') : []
  let userTurns = 0
  let tokens = 0
  for (const entry of list) {
    const message = entry?.type === 'message' ? entry.message : null
    if (message?.role === 'user') userTurns += 1
    tokens += estimateTokens(messageText(message ?? { role: 'custom', summary: entry?.summary ?? '' }))
  }
  return { userTurns, tokens }
}

/* ══════════════════════════════════════════════════════════════════
 * 生成器输入的自净（第四轮外部评审 P0-1）
 * ══════════════════════════════════════════════════════════════════
 * 要防的不是「模型看到自己写的状态」本身（上一版状态**有意**进 prompt，那是
 * 「Existing State + Delta」的增量设计），而是「我们注入/改写过的内容被当成事实源」：
 *
 *   注入的 <TASK_STATE> → 又被下一版生成器读回去 → 漂移变成递归压缩。
 *
 * 目前的三条注入通道都**不进** `sessionManager.getEntries()`（注入是临时消息、
 * 墓碑与召回只在当轮 working copy 上），所以真实条目里本来就干净。
 * 但「本来就干净」不是契约 —— 一旦将来任何一条落盘（或者用户把状态粘进提问），
 * 污染会静默发生。所以这里做**显式自净**，并且在诊断里报告丢了几条。
 */

/** 这段文本是不是我们自己注入/改写出来的（墓碑 / 召回正文 / 状态块） */
export function isSyntheticText(text) {
  if (typeof text !== 'string' || !text) return false
  if (isTombstoneText(text)) return true
  const head = text.trimStart()
  if (head.startsWith(RECALL_PREFIX) || head.startsWith(RECALL_STUB_PREFIX)) return true
  return head.includes('<TASK_STATE') || head.includes('</TASK_STATE>')
}

/**
 * 把这些内容从生成器输入里剔掉（保持 `entryIds` 与 `messages` 一一对应）。
 *
 * `custom` / `branchSummary` / `compactionSummary` 三类角色本身就**不是**用户或
 * 工具说的话（前两类还是我们提示的「已经压缩过」的拐弯），对 evidence 没有贡献，
 * 一并剔掉反而少一层误读。
 */
export function stripSyntheticMessages(messages, entryIds) {
  if (!Array.isArray(messages)) return { messages: [], entryIds: [], removed: 0 }
  const keptMessages = []
  const keptIds = []
  let removed = 0
  messages.forEach((message, i) => {
    const role = message?.role
    const structural = role === 'custom' || role === 'branchSummary' || role === 'compactionSummary'
    if (structural || isSyntheticText(messageText(message))) {
      removed += 1
      return
    }
    keptMessages.push(message)
    if (Array.isArray(entryIds)) keptIds.push(entryIds[i])
  })
  return { messages: keptMessages, entryIds: keptIds, removed }
}

/* ══════════════════════════════════════════════════════════════════
 * 会话级 eligibility gate（第四轮外部评审第四问 A）
 * ══════════════════════════════════════════════════════════════════
 * 默认关的代价是整条状态层空转；无条件默认开的代价是**短任务也背上闭环误差风险**
 * （错误 hypothesis → 模型据此行动 → 行动进 transcript → 新状态又认为它成立）。
 * 所以最终形态不是二元开关，而是「允许（kinds）+ 够大了吗（本函数）+ 脏吗（shouldRefresh）」。
 *
 * 与外部建议的差异（已记录在方案 §17.6）：它另外要 `contextUsage ≥ 60% workingSet`
 * 与 `compactionIsImminent` 两个信号 —— 工作集在**主进程**，扩展侧拿不到，
 * 所以这里只用三个可得信号：长会话（回合数 + 转录 token）与「已经清扫过东西」。
 */

/** 少于这几个用户回合不生成 —— 短任务不需要状态 */
export const FOLD_MIN_TURNS = 4
/** 转录估算 token 的下限；不到这个量级，没有东西可折叠 */
export const FOLD_MIN_TOKENS = 48_000

export function foldEligible({
  settledTurns = 0,
  transcriptTokens = 0,
  firstSweep = false,
  minTurns = FOLD_MIN_TURNS,
  minTokens = FOLD_MIN_TOKENS
} = {}) {
  /*
   * 最低回合数是**全局地板**（第四轮复核 Q1 第 2 条）：早期一个回合产生一个巨大的工具输出
   * 就可能触发 Tool Sweep；若让清扫分支绕过地板，就会把「出现过一个肥工具输出」
   * 误当成「已有足够历史值得提炼」，而且 sticky 之后再也不会退回来。
   */
  if (Number(settledTurns) < minTurns) return { eligible: false, reason: 'too-early' }
  if (firstSweep) return { eligible: true, reason: 'first-sweep' }
  if (Number(transcriptTokens) >= minTokens) return { eligible: true, reason: 'long-session' }
  return { eligible: false, reason: 'small-transcript' }
}

/**
 * 分档（§16.6.2 的口径）：
 *   gap 0      → 全用
 *   gap 1–2    → 全用，但 `hypothesis` / `nextActions` / `assumptions` 标 stale
 *   gap 3–6    → 只留 objective / constraints / 确定性 evidence（语义推测全丢）
 *   gap > 6 或 diverged → 不注入
 */
export function applyFreshness(task, { relation, gap } = {}) {
  if (!task) return { task: null, tier: 'none', dropped: [], stale: [] }
  if (relation === 'same') return { task, tier: 'fresh', dropped: [], stale: [] }
  if (relation !== 'older') return { task: null, tier: 'diverged', dropped: ['*'], stale: [] }
  if (gap <= 2) {
    const staleFields = ['hypothesis', 'nextActions', 'assumptions']
    const next = { ...task }
    for (const key of staleFields) {
      if (Array.isArray(task[key])) next[key] = task[key].map((item) => ({ ...item, stale: true }))
    }
    return { task: next, tier: 'stale-soft', dropped: [], stale: staleFields }
  }
  if (gap <= 6) {
    const dropped = ['currentState', 'decisions', 'completed', 'failedAttempts', 'unresolved', 'nextActions', 'assumptions', 'hypothesis']
    const next = { ...task }
    for (const key of dropped) next[key] = []
    return { task: next, tier: 'stale-hard', dropped, stale: [] }
  }
  return { task: null, tier: 'too-old', dropped: ['*'], stale: [] }
}

/* ══════════════════════════════════════════════════════════════════
 * ⑦ 刷新判定：dirty 位掩码（§16.6.2）
 * ══════════════════════════════════════════════════════════════════ */

export const DIRTY = {
  USER_INTENT: 1 << 0,
  CONSTRAINT: 1 << 1,
  FILE_CHANGE: 1 << 2,
  SYMBOL_CHANGE: 1 << 3,
  COMMAND_RESULT: 1 << 4,
  TEST_CHANGE: 1 << 5,
  FAILURE: 1 << 6,
  ASSUMPTION_RISK: 1 << 7,
  CONTEXT_GROWTH: 1 << 8
}

const DIRTY_WEIGHT = {
  [DIRTY.CONSTRAINT]: 8,
  [DIRTY.FAILURE]: 5,
  [DIRTY.TEST_CHANGE]: 5,
  [DIRTY.USER_INTENT]: 4,
  [DIRTY.ASSUMPTION_RISK]: 4,
  [DIRTY.FILE_CHANGE]: 2,
  [DIRTY.SYMBOL_CHANGE]: 2,
  [DIRTY.COMMAND_RESULT]: 1,
  [DIRTY.CONTEXT_GROWTH]: 2
}

/** 硬触发位：命中任何一个就必须刷新（不看权重累计） */
export const HARD_DIRTY = DIRTY.CONSTRAINT | DIRTY.FAILURE | DIRTY.TEST_CHANGE

/** 从「自上次水位之后的新条目」算 dirty 位掩码 */
export function dirtyMask(entries) {
  let mask = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type === 'message') {
      const role = entry.message?.role
      if (role === 'user') mask |= DIRTY.USER_INTENT | DIRTY.CONSTRAINT
      else if (role === 'toolResult') mask |= DIRTY.COMMAND_RESULT
      continue
    }
    if (entry?.type === 'compaction') mask |= DIRTY.CONTEXT_GROWTH
  }
  /* 文件/命令/测试/失败的存在本身就是信号（由 evidence reducer 判定的那些） */
  return mask
}

/** 把 evidence 的实际情况折进掩码（有失败命令 → FAILURE，有文件改动 → FILE_CHANGE…） */
export function dirtyMaskWithEvidence(mask, evidence) {
  let out = mask
  if (Array.isArray(evidence?.files) && evidence.files.some((f) => f.state === 'modified')) out |= DIRTY.FILE_CHANGE
  if (Array.isArray(evidence?.commandsRun)) {
    if (evidence.commandsRun.length) out |= DIRTY.COMMAND_RESULT
    if (evidence.commandsRun.some((c) => c.exitCode !== undefined && c.exitCode !== 0)) out |= DIRTY.FAILURE
  }
  if (Array.isArray(evidence?.testsRun) && evidence.testsRun.length) out |= DIRTY.TEST_CHANGE
  return out
}

export function dirtyScore(mask) {
  let score = 0
  for (const [bit, weight] of Object.entries(DIRTY_WEIGHT)) {
    if (mask & Number(bit)) score += weight
  }
  return score
}

/**
 * 该不该刷新状态。
 *
 * `stateMissing` 与 `hard dirty` 是硬触发；其余看累计权重（≥6）、
 * 落后回合数（≥2）或净增 token（≥6000）。
 * 纯只读操作不会命中任何位 —— 不因为「模型读了个文件」就多花一次 completion。
 */
export function shouldRefresh({ stateMissing, mask = 0, settledGap = 0, deltaTokens = 0 } = {}) {
  if (stateMissing) return { needed: true, reason: 'state-missing', score: 0 }
  if (mask & HARD_DIRTY) return { needed: true, reason: 'hard-dirty', score: dirtyScore(mask) }
  const score = dirtyScore(mask)
  if (score >= 6) return { needed: true, reason: 'dirty-score', score }
  if (settledGap >= 2) return { needed: true, reason: 'settled-gap', score }
  if (deltaTokens >= 6_000) return { needed: true, reason: 'context-growth', score }
  return { needed: false, reason: 'clean', score }
}

/* ══════════════════════════════════════════════════════════════════
 * ⑧ CAS：迟到结果不许覆盖新快照（§16.6.1）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 提交前置条件。
 *
 * `abort` 只省算力，**不是正确性机制** —— 一次 20 秒的 completion 完成时，
 * 会话可能已经又跑了两个回合、甚至换了分支。所以落盘前必须核对：
 *   · `expectedRevision` 与磁盘上的 `revision` 一致（没有别人的更新插入）；
 *   · 这次生成基于的水位（`baseEntryCount`）仍然是当前条目的前缀。
 */
export function casAllows({ current, precondition } = {}) {
  const p = precondition ?? {}
  const revision = Number.isFinite(current?.revision) ? current.revision : 0
  if (Number.isFinite(p.expectedRevision) && p.expectedRevision !== revision) {
    return { ok: false, reason: 'revision-changed', revision, expected: p.expectedRevision }
  }
  const baseCount = Number.isFinite(p.baseEntryCount) ? p.baseEntryCount : null
  const currentCount = Number.isFinite(current?.entryCount) ? current.entryCount : 0
  if (baseCount !== null && currentCount < baseCount) {
    return { ok: false, reason: 'watermark-regressed', revision, currentCount, baseCount }
  }
  return { ok: true, revision }
}

/** 写盘前统一组装（元数据由宿主附加，不接受模型自报） */
export function buildStateFile({ sessionId, watermark, task, episodes, now, revision }) {
  const at = Number.isFinite(now) ? now : Date.now()
  return {
    schemaVersion: 1,
    sessionId,
    revision: Number.isFinite(revision) ? revision : 0,
    sourceWatermark: watermark,
    createdAt: at,
    updatedAt: at,
    task,
    episodes: Array.isArray(episodes) ? episodes : []
  }
}
