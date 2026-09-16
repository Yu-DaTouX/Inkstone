/**
 * 切片安全规则 —— 压缩/折叠/清扫**不该压坏什么**（方案 §12.4 + §13.4 三条补强，N21-10）。
 *
 * 为什么先做这一件：阶段 4 的三种变换（Tool Sweep / Episode Fold / Structured Compaction）
 * 都会「把一段历史变成状态」。真正难归因的事故不是压得不够，而是**压坏了**：
 *   · 留下一条没有结果的 tool_call（provider 直接报错，或模型对着空气说话）；
 *   · 把用户刚给的硬约束降级成背景摘要（表现是"聊着聊着模型忘了要求"）；
 *   · 把用户正在看的 diff 总结掉（表现是"它把我刚让它改的地方改回去了"）。
 * 所以规则写成**纯函数 + 不变式**：阶段 4 的扩展调它，坏了在单测里红，
 * 而不是等用户在真实会话里觉得"模型变笨了"。
 *
 * 输入是与 pi 无关的**条目视图**（`SliceEntry`）：调用方负责把 pi 的 messages 适配过来。
 * 现状的对应关系（见 `src/main/normalize.ts`）：
 *   · `assistant` 内容块里的 `toolCall{id}` → `toolCalls`
 *   · 紧随的 `role: 'toolResult'` 消息 → `role: 'tool'` + `toolCallId`
 *   · `role: 'bashExecution'` → `role: 'bash'`
 * 适配层不做语义推断（谁是约束、哪个 diff 在用），那些由**调用方**给了就传（`protect` / `paths`）。
 *
 * 硬约束（对齐 §12.4，2026-09-17 补三条）与它们的落点：
 *   ① 不得删除**当前正在使用的 diff** → `planTailCut` 把它拉回保留区；`sweepCandidates` 跳过它。
 *   ② 用户明确约束**不得降级**为普通历史信息 → 被切掉时进 `carryOver().constraints`
 *      （状态层必须把它们作为约束带下去，而不是当背景摘要）；`routeEntries` 保证它们只进 constraints 桶。
 *   ③ 不得从 assistant reasoning / output 中间切割 → 切割只在单元边界；`sweepCandidates` 只考虑 `tool` 条目。
 *
 * **两条"保护"的强度不同，别混**：
 *   · 硬留（必须留在原始窗口里）：`system-contract`、`active-diff`；
 *   · 可切但必须带走（留在状态里）：`user-constraint`、`unresolved-error` ——
 *     它们的原始消息可以离开窗口，但只要"约束/未解决"这件事在状态里还在，就没有违反规则②③。
 *     这一区分很重要：若把约束也当成"硬留"，cut 就永远退不到约束之后，实际永远压不动。
 */

/** 保护标记：给了就必须保住（硬留，或由状态层带走） */
export const PROTECTIONS = ['system-contract', 'user-constraint', 'active-diff', 'unresolved-error']

/** 必须**留在原始窗口**的保护（切不动） */
const HARD_KEEP = ['system-contract', 'active-diff']

/** 可以离开窗口、但必须被状态带走的保护 */
const CARRY = ['user-constraint', 'unresolved-error']

/**
 * @typedef {'system'|'user'|'assistant'|'tool'|'bash'} SliceRole
 * @typedef {'system-contract'|'user-constraint'|'active-diff'|'unresolved-error'} Protection
 * @typedef {object} SliceEntry
 * @property {string} entryId
 * @property {SliceRole} role
 * @property {number} [tokens]       该条目的 token 量（缺省按 0 计；估算由调用方负责）
 * @property {string[]} [toolCalls]  assistant 发起的工具调用 id
 * @property {string} [toolCallId]   tool 结果回答的调用 id
 * @property {Protection[]} [protect]
 * @property {string[]} [paths]      该条目涉及的文件路径（用于 active-diff 判定）
 * @property {boolean} [isError]     tool / bash 是否失败
 * @property {boolean} [resolved]    失败是否**已经解决**（已解决的可回收，§12.6）
 */

const tokensOf = (e) => (e && Number.isFinite(e.tokens) ? Math.max(0, e.tokens) : 0)
const protects = (e) => (Array.isArray(e?.protect) ? e.protect : [])

/** 必须硬留（system 提示 / 契约、正在使用的 diff） */
function isHardKeep(e) {
  if (!e) return false
  if (e.role === 'system') return true
  return HARD_KEEP.some((p) => protects(e).includes(p))
}

/** 被切掉时必须由状态带走（用户约束、未解决的错误） */
function mustCarry(e) {
  if (!e) return false
  return CARRY.some((p) => protects(e).includes(p))
}

/**
 * 是否属于"当前正在使用的 diff"。
 *
 * 两种来源：调用方直接打了 `protect: ['active-diff']`（它已经判定过），
 * 或者这条条目涉及的路径与调用方给的 `activePaths` 相交（调用方只给路径清单，判定在这里）。
 */
function isActiveDiff(e, activePaths = []) {
  if (!e) return false
  if (protects(e).includes('active-diff')) return true
  return (e.paths ?? []).some((x) => activePaths.includes(x))
}

/** 必须留在原始窗口里：系统提示/契约 + 正在使用的 diff */
function mustStay(e, activePaths = []) {
  return isHardKeep(e) || isActiveDiff(e, activePaths)
}

/**
 * 原子上下文单元（§12.4）。
 *
 * 切割的**最细粒度**：一个单元要么整体留下、要么整体走。
 *   · `system`：系统提示 / 当前任务契约 —— 永不可回收；
 *   · `agent-turn`：一条 user 消息 + 到下一个 user/system 之前的所有 assistant/tool 条目。
 *     切割对齐到它，所以不会出现「留 tool_call 丢 tool_result」这类半条；
 *   · `bash`：RPC 直执行的 bash（命令与输出是一件事）；
 *   · `orphan-tool`：找不到对应 tool_call 的 tool 结果（调用在窗口之外）——
 *     单独成单元，**不擅自丢弃**（凭空删内容要由调用方决定）。
 *
 * @param {SliceEntry[]} entries
 * @returns {{ kind: string, entryIds: string[], tokens: number }[]}
 */
export function atomicUnits(entries) {
  /** @type {{ kind: string, entryIds: string[], tokens: number }[]} */
  const units = []
  const callIds = new Set()
  for (const e of entries) for (const id of e.toolCalls ?? []) callIds.add(id)

  for (const e of entries) {
    const last = units[units.length - 1]
    if (e.role === 'system') {
      /* 连续的 system 合成一个单元：它们同属"提示/契约"，分开没有意义 */
      if (last && last.kind === 'system') {
        last.entryIds.push(e.entryId)
        last.tokens += tokensOf(e)
      } else {
        units.push({ kind: 'system', entryIds: [e.entryId], tokens: tokensOf(e) })
      }
      continue
    }
    if (e.role === 'bash') {
      units.push({ kind: 'bash', entryIds: [e.entryId], tokens: tokensOf(e) })
      continue
    }
    if (e.role === 'user') {
      units.push({ kind: 'agent-turn', entryIds: [e.entryId], tokens: tokensOf(e) })
      continue
    }
    if (e.role === 'tool' && (!e.toolCallId || !callIds.has(e.toolCallId))) {
      units.push({ kind: 'orphan-tool', entryIds: [e.entryId], tokens: tokensOf(e) })
      continue
    }
    /* assistant / 有主的 tool：挂进当前回合（没有当前回合时自成单元，例如历史被截过） */
    if (last && (last.kind === 'agent-turn' || last.kind === 'orphan-tool')) {
      last.entryIds.push(e.entryId)
      last.tokens += tokensOf(e)
    } else {
      units.push({ kind: 'agent-turn', entryIds: [e.entryId], tokens: tokensOf(e) })
    }
  }
  return units
}

/** 找成对的 tool_call / tool_result（两边都在输入里才算一对） */
function pairsOf(entries) {
  const resultByCall = new Map()
  for (const e of entries) if (e.toolCallId) resultByCall.set(e.toolCallId, e.entryId)
  const pairs = []
  for (const e of entries) {
    for (const c of e.toolCalls ?? []) {
      const r = resultByCall.get(c)
      if (r) pairs.push({ call: e.entryId, result: r, toolCallId: c })
    }
  }
  return pairs
}

/**
 * 从尾部切出「保留区」（§12.4）。
 *
 * 规则：
 *   · 从新往旧累加到 ≥ `target` 为止，然后**对齐到单元边界**（不硬截）；
 *   · 超过 `max` 不再额外处理 —— 语义完整优先于精确 token 数，只在结果里标 `overMax`；
 *   · 硬留条目（系统提示/契约、正在使用的 diff）若落在丢弃区 → 把边界往前挪到它所在的单元；
 *   · 成对的 tool_call / tool_result 若一个留一个走 → 同样把边界往前挪（补强 ③）；
 *   · 可带走的保护（用户约束、未解决错误）**不**阻止切割，但会出现在 `carryOver()` 里，
 *     调用方必须把它们带进状态（`violations()` 会检查）。
 *
 * @param {SliceEntry[]} entries
 * @param {{ target: number, max: number }} budget
 * @param {{ activePaths?: string[] }} [opts] `activePaths` 里的文件视为"正在使用"（硬留，规则 ①）
 */
export function planTailCut(entries, budget, opts = {}) {
  const activePaths = opts.activePaths ?? []
  const target = Math.max(0, budget?.target ?? 0)
  const max = Math.max(target, budget?.max ?? target)
  const units = atomicUnits(entries)
  const byId = new Map(entries.map((e) => [e.entryId, e]))
  const unitOf = new Map()
  units.forEach((u, i) => u.entryIds.forEach((id) => unitOf.set(id, i)))
  const pairs = pairsOf(entries)

  if (units.length === 0) {
    return {
      keptEntryIds: [], droppedEntryIds: [], keptTokens: 0, droppedTokens: 0,
      boundaryEntryId: null, overMax: false, rescued: [], units
    }
  }

  /* 1. 从尾部累加到 ≥ target（对齐到单元边界：循环按单元走，天然对齐） */
  let start = units.length
  let acc = 0
  for (let i = units.length - 1; i >= 0; i--) {
    acc += units[i].tokens
    start = i
    if (acc >= target) break
  }

  /* 2. 把边界往前挪到满足硬留与配对的位置（反复进行，因为往前挪会带进新的单元） */
  const isKept = (id, s) => {
    const i = unitOf.get(id)
    return i !== undefined && i >= s
  }
  const rescued = []
  const seen = new Set()
  const push = (entryId, why) => {
    const key = `${entryId}|${why}`
    if (seen.has(key)) return
    seen.add(key)
    rescued.push({ entryId, why })
  }

  for (;;) {
    let nextStart = start
    /* 2a. 硬留条目 */
    for (let i = 0; i < start; i++) {
      const objs = units[i].entryIds.map((id) => byId.get(id)).filter(Boolean)
      if (objs.some((e) => mustStay(e, activePaths))) {
        for (const e of objs) {
          if (mustStay(e, activePaths)) push(e.entryId, '必须留在原始窗口（系统提示/契约 或 正在使用的 diff）')
        }
        nextStart = Math.min(nextStart, i)
      }
    }
    /* 2b. tool 调用与结果不可分离 */
    for (const p of pairs) {
      const keepCall = isKept(p.call, nextStart)
      const keepResult = isKept(p.result, nextStart)
      if (keepCall === keepResult) continue
      const missing = keepCall ? p.result : p.call
      const idx = unitOf.get(missing)
      if (idx === undefined) continue
      push(missing, `tool 调用与结果不可分离（${p.toolCallId}）`)
      nextStart = Math.min(nextStart, idx)
    }
    if (nextStart === start) break
    start = nextStart
  }

  const keptIds = []
  for (let i = start; i < units.length; i++) keptIds.push(...units[i].entryIds)
  const kept = new Set(keptIds)
  const droppedIds = entries.map((e) => e.entryId).filter((id) => !kept.has(id))

  return {
    keptEntryIds: keptIds,
    droppedEntryIds: droppedIds,
    keptTokens: keptIds.reduce((n, id) => n + tokensOf(byId.get(id)), 0),
    droppedTokens: droppedIds.reduce((n, id) => n + tokensOf(byId.get(id)), 0),
    boundaryEntryId: keptIds[0] ?? null,
    overMax: keptIds.reduce((n, id) => n + tokensOf(byId.get(id)), 0) > max,
    rescued,
    units
  }
}

/**
 * 被切掉、但**必须由状态层带走**的条目（补强 ② 与"未解决的错误不得丢"）。
 *
 * 调用方拿到之后：`constraints` 进状态的 constraints 字段（保持"约束"身份，不是背景摘要），
 * `unresolved` 进 unresolved / failedAttempts 字段。`violations()` 会核对这件事做过没有。
 *
 * @param {SliceEntry[]} entries
 * @param {{ droppedEntryIds: string[] }} plan
 */
export function carryOver(entries, plan) {
  const dropped = new Set(plan?.droppedEntryIds ?? [])
  const out = { constraints: [], unresolved: [] }
  for (const e of entries) {
    if (!dropped.has(e.entryId)) continue
    if (protects(e).includes('user-constraint')) out.constraints.push(e.entryId)
    if (protects(e).includes('unresolved-error') || (e.isError === true && e.resolved !== true)) {
      out.unresolved.push(e.entryId)
    }
  }
  return out
}

/**
 * 把条目分派到注入用的桶里。
 *
 * 规则 ② 的落点就在这里：用户约束只能进 `constraints`，**不许**进 `history`
 * （进了 history 就意味着它会被当成"背景信息"压掉或降级）。
 *
 * 判定顺序（先到先得）：system → constraints → activeDiff → unresolved → history。
 *
 * @param {SliceEntry[]} entries
 * @param {{ activePaths?: string[] }} [opts]
 */
export function routeEntries(entries, opts = {}) {
  const activePaths = opts.activePaths ?? []
  const out = { system: [], constraints: [], activeDiff: [], unresolved: [], history: [] }
  for (const e of entries) {
    const p = protects(e)
    if (e.role === 'system' || p.includes('system-contract')) out.system.push(e.entryId)
    else if (p.includes('user-constraint')) out.constraints.push(e.entryId)
    else if (isActiveDiff(e, activePaths)) out.activeDiff.push(e.entryId)
    else if (p.includes('unresolved-error') || (e.isError === true && e.resolved !== true)) out.unresolved.push(e.entryId)
    else out.history.push(e.entryId)
  }
  return out
}

/**
 * Tool Sweep 的候选（§12.5）：把**大块的工具输出**换成墓碑（`ctx://` 引用），
 * 不是删除整条会话内容 —— 调用仍然在，只是结果变成一条指向归档的占位。
 *
 * 返回 `candidates`（可以换）与 `skipped`（不可以换，带原因），原因用于排障与断言语义。
 * 规则 ①（正在使用的 diff）与"未解决的错误"在这里被排除；`assistant` 条目永不入选
 * （补强 ③：reasoning / output 不从中间切）。
 *
 * @param {SliceEntry[]} entries
 * @param {{ activePaths?: string[], minTokens?: number }} [opts]
 */
export function sweepCandidates(entries, opts = {}) {
  const activePaths = opts.activePaths ?? []
  const minTokens = opts.minTokens ?? 0
  const candidates = []
  const skipped = []
  for (const e of entries) {
    if (e.role !== 'tool') {
      if (e.role === 'assistant' && minTokens > 0 && tokensOf(e) >= minTokens) {
        skipped.push({ entryId: e.entryId, reason: 'assistant 的推理/正文不参与清扫（不得从中间切割）' })
      }
      continue
    }
    if (tokensOf(e) < minTokens) {
      skipped.push({ entryId: e.entryId, reason: `小于清扫门槛（${tokensOf(e)} < ${minTokens}）` })
      continue
    }
    const p = protects(e)
    if (isActiveDiff(e, activePaths)) {
      skipped.push({ entryId: e.entryId, reason: '当前正在使用的 diff，不得删除' })
      continue
    }
    if (p.includes('user-constraint')) {
      skipped.push({ entryId: e.entryId, reason: '承载用户约束，不得降级/回收' })
      continue
    }
    if (p.includes('unresolved-error') || (e.isError === true && e.resolved !== true)) {
      skipped.push({ entryId: e.entryId, reason: '未解决的错误，不得丢（§12.6）' })
      continue
    }
    candidates.push({ entryId: e.entryId, tokens: tokensOf(e), toolCallId: e.toolCallId ?? null })
  }
  return { candidates, skipped }
}

/**
 * 不变式检查（切割结果的**合法性**）。
 *
 * 任何时候返回非空数组都表示这个切片方案是坏的 —— 阶段 4 在真正动 messages 之前调它，
 * 生产上也应当把结果记进日志（宁可放弃这次压缩，也不要发出坏上下文）。
 *
 * @param {{ keptEntryIds: string[], droppedEntryIds: string[] }} plan
 * @param {SliceEntry[]} entries
 * @param {{ activePaths?: string[], carriedIds?: string[] }} [opts]
 *        `carriedIds`：调用方声明已经把哪些被切掉的条目带进状态（`carryOver()` 的结果）。
 * @returns {string[]} 违规描述（空数组 = 合法）
 */
export function violations(plan, entries, opts = {}) {
  const bad = []
  const kept = new Set(plan?.keptEntryIds ?? [])
  const dropped = new Set(plan?.droppedEntryIds ?? [])
  const carried = new Set(opts.carriedIds ?? [])
  const byId = new Map(entries.map((e) => [e.entryId, e]))

  /* 1. 单元整体性：一个单元要么全留、要么全走（不得从中间切） */
  for (const u of atomicUnits(entries)) {
    const inKept = u.entryIds.filter((id) => kept.has(id)).length
    if (inKept !== 0 && inKept !== u.entryIds.length) {
      bad.push(`单元被切开（${u.kind}）：${u.entryIds.join(', ')}`)
    }
  }

  /* 2. tool 配对：不得留 tool_call 丢 tool_result，也不得反过来 */
  for (const p of pairsOf(entries)) {
    if (kept.has(p.call) !== kept.has(p.result)) {
      bad.push(`tool 调用与结果被分开：${p.toolCallId}（${p.call} / ${p.result}）`)
    }
  }

  /* 3. 系统提示 / 契约必须在保留区 */
  for (const e of entries) {
    if (e.role === 'system' && !kept.has(e.entryId)) bad.push(`系统提示/契约被回收：${e.entryId}`)
  }

  /* 4. 硬留（系统提示/契约、正在使用的 diff）必须在保留区 */
  const activePaths = opts.activePaths ?? []
  for (const e of entries) {
    if (mustStay(e, activePaths) && !kept.has(e.entryId)) {
      const why = protects(e).join('/') || (isActiveDiff(e, activePaths) ? 'active-diff' : 'system')
      bad.push(`硬留条目被回收（${why}）：${e.entryId}`)
    }
  }

  /* 5. 可带走的保护：要么留在窗口里，要么被状态带走（规则 ②） */
  for (const e of entries) {
    if (!mustCarry(e)) continue
    const inState = carried.has(e.entryId) || protects(e).some((p) => carried.has(`${e.entryId}:${p}`))
    if (!kept.has(e.entryId) && !inState) {
      bad.push(`受保护内容既没留在窗口、也没被状态带走（${protects(e).join('/')}）：${e.entryId}`)
    }
  }

  /* 5. 保留/丢弃必须互补（不许同时出现在两边，也不许漏掉） */
  for (const e of entries) {
    const inK = kept.has(e.entryId)
    const inD = dropped.has(e.entryId)
    if (inK && inD) bad.push(`条目同时保留又丢弃：${e.entryId}`)
    if (!inK && !inD) bad.push(`条目既没保留也没丢弃：${e.entryId}`)
  }

  return bad
}

/**
 * 路由的合法性：用户约束不得出现在 history 桶里（补强 ② 的守门）。
 *
 * @param {ReturnType<typeof routeEntries>} routed
 * @param {SliceEntry[]} entries
 */
export function routingViolations(routed, entries) {
  const bad = []
  const constraints = new Set(routed?.constraints ?? [])
  for (const e of entries) {
    if (protects(e).includes('user-constraint')) {
      if (!constraints.has(e.entryId)) bad.push(`用户约束没有进 constraints 桶：${e.entryId}`)
      if ((routed?.history ?? []).includes(e.entryId)) bad.push(`用户约束被降级成普通历史：${e.entryId}`)
    }
    if (e.role === 'system' && !(routed?.system ?? []).includes(e.entryId)) {
      bad.push(`系统提示/契约没有进 system 桶：${e.entryId}`)
    }
  }
  return bad
}
