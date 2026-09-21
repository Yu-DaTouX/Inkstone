/**
 * 请求前预算诊断与硬闸门（实施-05 S4）。
 *
 * ══════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════
 * 主进程的 `compact()`（`shared/context-policy.ts` 的工作集线）发生在**回合结束之后** ——
 * 它能防止上下文一路涨到物理极限，但管不了「**这一次请求本身**已经装不下」：
 * 一次巨大的工具输出 / 一次粘贴进来的长文，会让下一个请求带着必然被拒的体积发出去，
 * 代价是 provider 报错、这一轮白跑、用户还得自己想办法。
 *
 * 所以这一层补的是**发起请求前**的那一眼：
 *   · `soft`     —— 估算已到工作集线：**先清理旧工具结果**（`context.js` 用零门槛
 *                    再跑一次 Tool Sweep），压缩仍然等宿主在 settled 后做；
 *   · `physical` —— 连「估算 + 输出预留」都超过模型窗口：**不发送**这个请求，
 *                    由 `context.js` 调 `ctx.abort()` 结束本轮并留下明确原因
 *                    （宁可这一轮空转，也不要发出一个已知装不下的请求）。
 *
 * ── 与 `emergency` 的区别（别合并）──
 *   · `emergency = min(90% 窗口, 窗口 − 输出预留)`：**压缩的兜底线**，用于「已经settled，
 *     现在必须压」；
 *   · 这里的 `physical`：**请求能不能发**。它比 emergency 更晚（紧急压缩本身也要发一次
 *     请求，那次请求的体积是压缩器的事），所以判定用「估算 + 输出预留 > 窗口」。
 *   两者用途不同，把 physical 写成 `>= emergency` 会让 90% 那条线变成「发不出去」，
 *   等于把 pi 的原生自动压缩也一并废掉。
 *
 * ── 公式的单一真源 ──
 *   公式在 `src/shared/context-policy.ts` 的 `contextBudget()`。这里是**同一套公式的 JS 版**
 *   （扩展不能 import TS）。两边必须一致：`scripts/test-context-budget.mjs` 用同一组窗口
 *   **交叉校验**两边的 `workingSet` / `emergency` / `responseReserve` —— 不一致就红。
 *   改公式时两处都要改，且以 shared 那份为准。
 *
 * ── 为什么估算而不是真实 usage ──
 *   请求发出之前拿不到 usage。估算必须**偏保守**（宁可早一点判 soft），
 *   但**不能用来判 physical 的精确边界** —— 所以 physical 那条线留了完整的输出预留，
 *   给估算误差当缓冲。真实 usage 用于**校准**（诊断里同时记 `usage`，见 context.js）。
 */

import { estimateTokens } from './context-transform.js'

/** 与 `shared/context-policy.ts` 的 `DEFAULT_CONTEXT_POLICY` 对应（只放预算相关字段）。 */
export const DEFAULT_BUDGET_POLICY = {
  workingSetCap: 240_000,
  windowRatio: 0.7,
  responseReservePreferred: 32_000,
  responseReserveMin: 16_000,
  safetyMarginMin: 8_000,
  safetyMarginRatio: 0.02,
  emergencyRatio: 0.9,
  triggerRatios: { sweep: 0.7, fold: 0.85, compact: 1 }
}

/** 每条消息的固定开销（角色标记、分隔符）。少了它，长会话会系统性低估。 */
const MESSAGE_OVERHEAD_TOKENS = 4

/** 认得出的数值型覆盖（其余字段一律忽略，写坏的值不能让预算变成 NaN）。 */
const NUMERIC_FIELDS = [
  'workingSetCap',
  'windowRatio',
  'responseReservePreferred',
  'responseReserveMin',
  'safetyMarginMin',
  'safetyMarginRatio',
  'emergencyRatio'
]

/** 比例类字段的合法区间（超出就忽略，回落默认值）。 */
const RATIO_FIELDS = new Set(['windowRatio', 'safetyMarginRatio', 'emergencyRatio'])

/**
 * 从 `YAN_CONTEXT_POLICY` 解析出的覆盖值里挑出预算字段。
 *
 * 与 `src/shared/context-policy.ts` 的 `applyOverrides` 同一套接受规则：
 * 正数、比例类 ≤ 1；非法值**整项忽略**（不是回落 0）。
 */
export function budgetOverridesFromPolicy(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const field of NUMERIC_FIELDS) {
    const value = raw[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    if (RATIO_FIELDS.has(field) && value > 1) continue
    out[field] = value
  }
  const ratios = raw.triggerRatios
  if (ratios && typeof ratios === 'object' && !Array.isArray(ratios)) {
    const picked = {}
    for (const key of ['sweep', 'fold', 'compact']) {
      const value = ratios[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) picked[key] = value
    }
    if (Object.keys(picked).length) out.triggerRatios = picked
  }
  return out
}

/**
 * 算一份预算（`shared/context-policy.ts` 公式的 JS 版）。
 *
 * 窗口未知或小到装不下预留与余量 → `null`（策略在这种模型上不生效，
 * 而不是给一条 ≤ 0 的线 —— 那会让每一轮都判定为 soft）。
 */
export function budgetOf(contextWindow, overrides = {}) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null
  const ratio = overrides.triggerRatios ?? {}
  const policy = {
    ...DEFAULT_BUDGET_POLICY,
    ...overrides,
    triggerRatios: { ...DEFAULT_BUDGET_POLICY.triggerRatios, ...ratio }
  }
  const win = Math.round(contextWindow)
  const responseReserve = Math.max(
    policy.responseReserveMin,
    Math.min(policy.responseReservePreferred, Math.round(win * 0.25))
  )
  const safetyMargin = Math.max(policy.safetyMarginMin, Math.round(win * policy.safetyMarginRatio))
  const workingSet = Math.min(
    policy.workingSetCap,
    Math.round(win * policy.windowRatio),
    win - responseReserve - safetyMargin
  )
  if (workingSet <= 0) return null
  return {
    contextWindow: win,
    responseReserve,
    safetyMargin,
    workingSet,
    triggers: {
      sweep: Math.round(workingSet * policy.triggerRatios.sweep),
      fold: Math.round(workingSet * policy.triggerRatios.fold),
      compact: Math.round(workingSet * policy.triggerRatios.compact)
    },
    emergency: Math.min(Math.round(win * policy.emergencyRatio), win - responseReserve)
  }
}

/** 内容块数组 / 字符串 → 文本（toolCall 的参数也算，它们真的占 token）。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block.text === 'string') parts.push(block.text)
    if (typeof block.content === 'string') parts.push(block.content)
    else if (Array.isArray(block.content)) parts.push(contentText(block.content))
    if (block.type === 'toolCall' || block.type === 'tool_call') {
      parts.push(String(block.name ?? ''))
      try {
        parts.push(JSON.stringify(block.arguments ?? block.args ?? {}))
      } catch {
        /* 参数里有循环引用：只算名字 */
      }
    }
  }
  return parts.join('\n')
}

/**
 * 估算一次请求里 messages 的 token 量。
 *
 * 口径（对齐 `context-transform.js` 的条目估算 + 一点保守量）：
 * 每条消息的**正文字符**、toolCall 名与参数、toolCallId、工具名，外加固定开销。
 * 不估 thinking（provider 侧一般不回灌）与图片（形状差异大，且 S4 的判据是文本体积）。
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    total += MESSAGE_OVERHEAD_TOKENS
    total += estimateTokens(String(message.role ?? message.type ?? ''))
    total += estimateTokens(contentText(message.content ?? message.text ?? ''))
    if (typeof message.toolCallId === 'string') total += estimateTokens(message.toolCallId)
    if (typeof message.name === 'string') total += estimateTokens(message.name)
    if (typeof message.summary === 'string') total += estimateTokens(message.summary)
  }
  return total
}

/** 估算工具表的 token 量（name + description + parameters schema）。 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools)) return 0
  let total = 0
  for (const tool of tools) {
    const fn = tool?.function ?? tool
    if (!fn || typeof fn !== 'object') continue
    total += estimateTokens(String(fn.name ?? ''))
    total += estimateTokens(String(fn.description ?? ''))
    try {
      total += estimateTokens(JSON.stringify(fn.parameters ?? fn.input_schema ?? {}))
    } catch {
      /* schema 里有循环引用：只算名字与描述 */
    }
  }
  return total
}

/** 估算**整个请求体**（messages + tools + 顶层 system）。 */
export function estimateRequestTokens(payload) {
  const messages = estimateMessagesTokens(payload?.messages)
  const tools = estimateToolsTokens(payload?.tools)
  const system = typeof payload?.system === 'string' ? estimateTokens(payload.system) : 0
  return { messages, tools, system, total: messages + tools + system }
}

/**
 * 这一次请求该不该发、要不要先清扫。
 *
 * 三条线都来自 `budget`（同一份公式），判定用**预测值**而不是当前值：
 * `projected = 估算 + 输出预留` —— 模型要能完整写出一段回答才算「装得下」。
 *
 * 边界写死为「严格大于」：正好等于窗口时**不算** physical（provider 的窗口口径
 * 通常留了余量，把等号判成硬拒会让临界请求全部空转）。
 */
export function requestBudgetLevel({ estimatedTokens, budget }) {
  const estimated = Math.max(0, Math.round(Number.isFinite(estimatedTokens) ? estimatedTokens : 0))
  if (!budget) {
    return {
      level: 'unknown',
      estimatedTokens: estimated,
      projectedTokens: estimated,
      reason: '窗口未知：预算不生效，回落 pi 原生自动压缩'
    }
  }
  const projected = estimated + budget.responseReserve
  if (projected > budget.contextWindow) {
    return {
      level: 'physical',
      estimatedTokens: estimated,
      projectedTokens: projected,
      reason: `估算 ${estimated} + 输出预留 ${budget.responseReserve} = ${projected} 超过窗口 ${budget.contextWindow}：不发送这个请求`
    }
  }
  if (estimated >= budget.workingSet) {
    return {
      level: 'soft',
      estimatedTokens: estimated,
      projectedTokens: projected,
      reason: `估算 ${estimated} 已到工作集线 ${budget.workingSet}：先清理旧工具结果，压缩留给宿主`
    }
  }
  return {
    level: 'normal',
    estimatedTokens: estimated,
    projectedTokens: projected,
    reason: `估算 ${estimated}（工作集线 ${budget.workingSet}）`
  }
}

/*
 * ══════════════════════════════════════════════════════════════════
 * 宿主交过来的生效策略（实施-11 C-4）
 * ══════════════════════════════════════════════════════════════════
 *
 * 数值覆盖住在桌面端设置里，而扩展按设计**不读** `desktop.json` 的那些数值
 * （只读两个布尔开关）。于是扩展永远按默认 240K 算阈值，界面却按用户设置
 * 显示 —— 两边说的不是一件事。
 *
 * 宿主把解析后的**分层覆盖**写进 `<YAN_DATA_DIR>/context-policy.effective.json`，
 * 这里读它、按当前模型挑一份、再与 `YAN_CONTEXT_POLICY`（测试通道，优先级更高）
 * 合并。下面两个函数是纯的，与 `src/shared/context-policy.ts` 的同名实现由
 * `scripts/test-context-budget.mjs` 用同一批输入交叉校验。
 */

/** 文档版本；不认识的版本一律当「没有这份文档」（宁可回落默认）。 */
export const EFFECTIVE_POLICY_VERSION = 1

/**
 * 从文档里挑出当前模型那份覆盖。
 *
 * 顺序：精确 `provider/model` → provider 段 → 文档默认层。
 * 形状不对返回 `{}`，不让坏 JSON 把预算变成 NaN。
 */
export function overridesOfEffectiveDocument(doc, modelKey) {
  if (!doc || typeof doc !== 'object') return {}
  if (doc.v !== EFFECTIVE_POLICY_VERSION) return {}
  const byModel = doc.byModel && typeof doc.byModel === 'object' ? doc.byModel : {}
  const provider = typeof modelKey === 'string' && modelKey.includes('/') ? modelKey.split('/')[0] : ''
  if (modelKey && byModel[modelKey]) return { ...byModel[modelKey] }
  if (provider && byModel[provider]) return { ...byModel[provider] }
  return { ...(doc.default && typeof doc.default === 'object' ? doc.default : {}) }
}

/**
 * 合并两份覆盖：`env`（测试通道）逐字段盖在宿主文档之上。
 *
 * 逐字段而不是整份替换：env 只给一个字段时，文档里其余字段必须保留
 * （整份替换会让「只调 workingSetCap 的测试」把模型级 windowRatio 清掉）。
 */
export function mergeBudgetOverrides(envOverrides, hostOverrides) {
  return { ...(hostOverrides ?? {}), ...(envOverrides ?? {}) }
}
