/**
 * 砚内置「上下文状态化压缩」扩展（N21-4 / S2–S6）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它负责的三件事
 * ══════════════════════════════════════════════════════════════════
 * ① **Tool Sweep**（§12.5）：把 `recentTail` 之外的大块工具输出换成
 *    指向 `ctx://tool/<原始 entryId>` 的墓碑。原文一条不动 ——
 *    模型需要时用 `context_recall` 取回。确定性、不调模型、幂等。
 * ② **Task State 前置注入**（§13.1 第 1 条）：状态文件存在且水位与
 *    当前会话**完全一致**时，把 `<TASK_STATE>` 放在历史**之前**。
 *    没有状态文件就不注入（绝不拿过期状态去误导模型）。
 * ③ **Recall + 预算 / TTL / 审计**（§12.9）：`context_recall` 工具按
 *    单次上限与累计上限拒绝超预算请求，召回内容带回合号，
 *    下一轮用户输入到来时正文被清成只留引用的存根。
 *
 * 另外接管 `session_before_compact`（§12.8）——但**只在**已经有一份
 * 水位一致、六类字段齐备的 Task State 时才接管；否则原样返回
 * `undefined`，让 pi 用它自己的摘要。这是 §12.0 要求的降级路径：
 * 结构化生成失败/缺失 → 交回 pi 原生行为，不产生半状态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界：默认**不调模型**，打开 `episode-fold` 才生成
 * ══════════════════════════════════════════════════════════════════
 * 状态生成器（N21-4 剩余项 / N21-5 的语义部分）挂在 `agent_settled` 上，
 * 由扩展自己调一次无工具 completion（`ctx.modelRegistry.complete()`，
 * 方案 §16.1 已核实可行），产出 TaskState 的**语义字段**；
 * `files` / `commandsRun` / `testsRun` 由确定性 reducer 从真实工具调用里抄，
 * 落盘前**覆盖**模型返回的同名字段（防幻觉污染 durable state）。
 *
 * 它只在 `kinds` 含 **`episode-fold`** 时工作 —— 默认 kinds 是
 * `['tool-sweep', 'recall', 'compaction']`（用户 2026-09-17 拍板），
 * 所以默认路径与生成器落地前**完全一致**；打开 `episode-fold` 才会多花
 * 一次 completion（额度与延迟已由用户 2026-09-17 拍板可接受）。
 * 生成失败 / 超时（20s）/ 水位对不上 / CAS 失败 一律**保留旧状态**，不落半成品。
 *
 * 两道额外的闸（第四轮外部评审，2026-09-17 晚）：
 *   · **分路开关** `state: { generate, inject }`（P0-5）—— 可以只生成不注入
 *     （shadow 模式：先看它写得对不对、贵不贵），也可以只注入不生成；
 *   · **会话级门槛** `foldEligible`（第四问 A）—— 短会话不生成：回合数、
 *     转录 token、是否已经清扫过东西三个信号，命中后本会话 sticky。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么所有钩子都包在 try/catch 里、失败返回 undefined
 * ══════════════════════════════════════════════════════════════════
 * 这个扩展会重写发给模型的消息。任何一次异常如果不能安全退出，
 * 坏上下文就会直接进推理。所以规则是：**宁可这次什么都没做，
 * 也不发出半份结果**。诊断写进 `YAN_CONTEXT_EXT_LOG`，真实链路靠探针取证。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_RECALL,
  DEFAULT_RECENT_TAIL,
  DEFAULT_SWEEP,
  activePathsOf,
  activeRecallTokens,
  alignEntryIds,
  applyToolSweep,
  buildStructuredSummary,
  contextEntries,
  diagnostic,
  entryProducesMessage,
  estimateTokens,
  injectTaskState,
  messageText,
  planToolSweep,
  recallBudget,
  renderTaskState,
  stripStaleRecalls,
  sweepViolations,
  userTurnCount,
  watermarkOfEntries,
  wrapRecall
} from './context-transform.js'
import {
  PRODUCER_SYSTEM_PROMPT,
  applyFreshness,
  buildProducerPrompt,
  buildStateFile,
  casAllows,
  citableEntries,
  clipTaskStateToBudget,
  dirtyMask,
  dirtyMaskWithEvidence,
  evidenceFromMessages,
  foldEligible,
  freshView,
  freshnessOf,
  mergeTaskState,
  parseProducerOutput,
  provenanceCounts,
  shouldRefresh,
  stateItemCounts,
  stripSyntheticMessages,
  tailRolesOf,
  transcriptStats,
  userDirectives
} from './context-producer.js'

/* ---------------------------------------------------------------- 环境与设置 */

function dataDir() {
  const dir = process.env.YAN_DATA_DIR?.trim()
  return dir || join(homedir(), '.pi', 'agent', 'yan')
}

function stateDir() {
  return join(dataDir(), 'context-state')
}

function trace(hook, payload) {
  const file = process.env.YAN_CONTEXT_EXT_LOG
  if (!file) return
  try {
    appendFileSync(file, diagnostic(hook, payload) + '\n')
  } catch {
    /* 诊断写不进去不影响变换本身 */
  }
}

/**
 * 扩展侧的策略读取。
 *
 * 与主进程的 `shared/context-policy.ts` 是**同一份 env**（pi 子进程继承
 * `process.env`），所以「哪些阶段已接管」只有一个真源（`kinds`）。
 * 这里额外认几个只在扩展里用的门槛（recentTail / sweep / recall），
 * 主进程不认识它们、也不需要认识 —— 它们只影响「怎么改消息」。
 */
function policy() {
  const raw = process.env.YAN_CONTEXT_POLICY ?? ''
  const base = {
    /*
     * 与 `src/shared/context-policy.ts` 的 `DEFAULT_CONTEXT_POLICY.kinds` **必须一致**：
     * 主进程读同一份 env，两边不一致时界面（主进程侧）会与真实生效的扩展行为不同。
     * `recall` 与 `tool-sweep` 捆绑：墓碑引用的唯一取回通道就是它。
     */
    kinds: ['tool-sweep', 'recall', 'compaction'],
    recentTail: { ...DEFAULT_RECENT_TAIL },
    sweep: { ...DEFAULT_SWEEP },
    recall: { ...DEFAULT_RECALL },
    /* kinds 不含 `episode-fold` 时两条分路都是关的（总闸优先） */
    state: { generate: false, inject: false, minTurns: 0, minTokens: 0, refreshRatio: 0 }
  }
  if (!raw.trim()) return base
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const kinds = Array.isArray(parsed.kinds)
    ? parsed.kinds.filter((k) => typeof k === 'string')
    : base.kinds
  const pick = (source, defaults) => {
    const out = { ...defaults }
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value
        else if (key === 'ttl' && (value === 'turn' || value === 'episode')) out.ttl = value
      }
    }
    return out
  }
  return {
    kinds,
    recentTail: pick(parsed.recentTail, base.recentTail),
    sweep: pick(parsed.sweep, base.sweep),
    recall: pick(parsed.recall, base.recall),
    state: stateSwitches(parsed.state, kinds)
  }
}

/**
 * 「生成」与「注入」分开的两个分路（第四轮外部评审 P0-5）。
 *
 * `kinds` 是**总闸**（不含 `episode-fold` 就什么都不做）；这两个是闸内的分路：
 *   · `generate:false` → 只用已有状态（不再花钱生成）；
 *   · `inject:false`  → 只生成不注入，即 **shadow 模式**：
 *     先看它写得对不对、贵不贵，再决定让它进上下文。
 * 出问题时的期望操作是「先关注入、保留生成」或「先停生成、保留已注入的状态」，
 * 而不是把整个 context 扩展拔掉（那就连 Tool Sweep 也没了）。
 *
 * **`inject` 的准确含义是「允许 TaskState 参与任何模型可见的上下文」**，不只是
 * 「插入 `<TASK_STATE>` 块」—— 压缩接手（`session_before_compact` 的结构化摘要）也算在内；
 * **以后任何新增的模型可见消费点都必须走这个开关**，否则 `inject:false` 的语义就是假的。
 * 两个组合的行为契约：`generate:false + inject:true` 时没有合法已有状态就 no-op（**不临时生成**）；
 * `generate:true + inject:false` 允许落盘与诊断，但任何模型可见路径都不得消费它。
 */
function stateSwitches(raw, kinds) {
  const on = kindEnabled({ kinds }, 'episode-fold')
  const out = { generate: on, inject: on, minTurns: 0, minTokens: 0, refreshRatio: 0 }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.generate === 'boolean') out.generate = raw.generate && on
    if (typeof raw.inject === 'boolean') out.inject = raw.inject && on
    if (raw.gate && typeof raw.gate === 'object' && !Array.isArray(raw.gate)) {
      if (Number.isFinite(raw.gate.minTurns) && raw.gate.minTurns > 0) out.minTurns = raw.gate.minTurns
      if (Number.isFinite(raw.gate.minTokens) && raw.gate.minTokens > 0) out.minTokens = raw.gate.minTokens
      /* State Refresh 档的窗口比例（N21-6）；不设就用 `FOLD_REFRESH_RATIO` */
      if (Number.isFinite(raw.gate.refreshRatio) && raw.gate.refreshRatio > 0) {
        out.refreshRatio = raw.gate.refreshRatio
      }
    }
  }
  return out
}

const kindEnabled = (policyValue, kind) => policyValue.kinds.includes(kind)

/* ---------------------------------------------------------------- 文件 IO */

/** 原子写：临时文件 → rename。失败时不动旧文件（与 S1 的 store 同一约定） */
function writeJsonAtomic(target, value) {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* 临时文件清不掉不是致命问题 */
    }
    throw error
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function sessionFilePath(sessionId, suffix) {
  return join(stateDir(), `${sessionId}${suffix}`)
}

/**
 * 读派生状态（只做**形状 + 水位**的轻检查）。
 *
 * 完整的 schema 执法在主进程的 `context-state-store`（TS），扩展侧拿不到它。
 * 所以这里故意只信「这份状态是不是给这个会话、水位是不是同一刻」这两件事：
 * 其余交给主进程的读取路径；扩展侧的最坏情况是**少注入一次**，不是注入错状态。
 */
function loadState(sessionId) {
  const state = readJson(sessionFilePath(sessionId, '.json'))
  if (!state || typeof state !== 'object') return { status: 'missing' }
  if (state.sessionId !== sessionId) return { status: 'invalid', reason: 'session-mismatch' }
  if (!state.task || typeof state.task !== 'object') return { status: 'invalid', reason: 'no-task' }
  return { status: 'ok', state }
}

function loadArchive(sessionId) {
  const archive = readJson(sessionFilePath(sessionId, '.archive.json'))
  if (!archive || typeof archive !== 'object' || !Array.isArray(archive.entries)) return null
  return archive
}

/** 合并归档元数据（按 ref 去重；最多保留最近 MAX_ARCHIVE_ENTRIES 条） */
const MAX_ARCHIVE_ENTRIES = 500

function mergeArchive(sessionId, additions, now, watermark) {
  const existing = loadArchive(sessionId)
  const entries = Array.isArray(existing?.entries) ? existing.entries.slice() : []
  const known = new Set(entries.map((e) => e?.ref))
  let added = 0
  for (const addition of additions) {
    if (!addition?.ref || known.has(addition.ref)) continue
    known.add(addition.ref)
    entries.push({
      ref: addition.ref,
      kind: addition.kind ?? 'tool',
      label: addition.label || 'tool',
      createdAt: now,
      tokens: addition.tokens ?? 0,
      recallable: addition.recallable ?? 'agent',
      sourceRange: addition.sourceRange ?? { from: '', to: '' },
      watermark: addition.watermark ?? watermark,
      contentStored: false
    })
    added++
  }
  if (!added) return { added: 0 }
  const trimmed = entries.length > MAX_ARCHIVE_ENTRIES ? entries.slice(entries.length - MAX_ARCHIVE_ENTRIES) : entries
  writeJsonAtomic(sessionFilePath(sessionId, '.archive.json'), {
    schemaVersion: 1,
    sessionId,
    updatedAt: now,
    entries: trimmed
  })
  return { added }
}

function findArchiveEntry(sessionId, ref) {
  const archive = loadArchive(sessionId)
  return archive?.entries?.find((entry) => entry?.ref === ref) ?? null
}

/* ---------------------------------------------------------------- 召回账本 */

/**
 * 召回账本（`<sessionId>.recall.json`）：只记「当前 active context 里
 * 召回内容占了多少 token」与「当前回合号」。工具用它做累计预算判定；
 * 上下文钩子每轮用真实消息重算一遍（账本与真实上下文对不上时以钩子为准）。
 */
function loadLedger(sessionId) {
  const ledger = readJson(sessionFilePath(sessionId, '.recall.json'))
  if (!ledger || typeof ledger !== 'object') return { turn: 0, activeTokens: 0 }
  return {
    turn: Number.isFinite(ledger.turn) ? ledger.turn : 0,
    activeTokens: Number.isFinite(ledger.activeTokens) ? ledger.activeTokens : 0
  }
}

function saveLedger(sessionId, ledger) {
  writeJsonAtomic(sessionFilePath(sessionId, '.recall.json'), ledger)
}

function audit(sessionId, record) {
  try {
    appendFileSync(sessionFilePath(sessionId, '.recall.jsonl'), JSON.stringify(record) + '\n')
  } catch {
    /* 审计失败不影响召回本身 */
  }
}

/* ---------------------------------------------------------------- 钩子实现 */

/**
 * 取当前会话的原始 entry 身份。
 * `sessionManager` 在 RPC 模式下由扩展上下文提供（§13.3 已核实）。
 */
function entryIdsFor(ctx, messages) {
  const manager = ctx?.sessionManager
  if (!manager || typeof manager.getBranch !== 'function') return null
  try {
    return alignEntryIds(manager.getBranch(), messages)
  } catch {
    return null
  }
}

function sessionIdOf(ctx) {
  const manager = ctx?.sessionManager
  try {
    const id = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : null
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * `context` 钩子：唯一的消息改写点。
 *
 * 顺序（每一步都基于上一步的结果，任一步异常就整轮放弃）：
 *   ① TTL 清理（上一轮召回的正文 → 存根）；
 *   ② Tool Sweep（kinds 含 `tool-sweep`）；
 *   ③ Task State 前置注入（kinds 含 `episode-fold` 且状态水位一致）；
 *   ④ 校验：`sweepViolations` 非空则整轮放弃（回退到原始消息）。
 */
function onContext(event, ctx) {
  const messages = event?.messages
  if (!Array.isArray(messages) || messages.length === 0) return
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  const p = policy()

  try {
    let next = messages
    const currentTurn = userTurnCount(next)
    let swept = 0
    let injectedTaskState = false
    let expiredRecalls = 0

    /* ① TTL：上一轮的召回正文只在当轮有效 */
    const cleaned = stripStaleRecalls(next, currentTurn)
    if (cleaned.changed) {
      next = cleaned.messages
      expiredRecalls = cleaned.changed
    }

    /* ② Tool Sweep */
    if (kindEnabled(p, 'tool-sweep')) {
      const entryIds = entryIdsFor(ctx, next)
      if (entryIds) {
        const manager = ctx.sessionManager
        const watermark = watermarkOfEntries(manager.getEntries?.() ?? [])
        const planned = planToolSweep({
          messages: next,
          entryIds,
          watermark,
          recentTail: p.recentTail,
          sweep: p.sweep,
          /*
           * 硬约束①：**本回合正在动的文件**不得清扫。呼叫方只给路径清单，判定在 context-safety。
           * 旧回合的编辑不在此列 —— 它们已经不在“正在使用”，否则清扫永远压不动。
           */
          opts: { activePaths: activePathsOf(next) }
        })
        if (planned.ok) {
          const applied = applyToolSweep(next, planned.plan)
          if (applied.changed > 0) {
            const bad = sweepViolations(applied.messages, entryIds, { activePaths: activePathsOf(next) })
            if (bad.length === 0) {
              next = applied.messages
              swept = applied.changed
              sweepSeen.add(sessionId)
              mergeArchive(sessionId, planned.archiveEntries ?? [], Date.now(), watermark)
            } else {
              trace('context', { sessionId, hook: 'sweep-rejected', violations: bad })
            }
          }
        } else {
          trace('context', { sessionId, hook: 'sweep-skipped', reason: planned.reason, details: planned.details ?? null })
        }
      } else {
        trace('context', { sessionId, hook: 'sweep-skipped', reason: 'entry-identity-unavailable' })
      }
    }

    /*
     * ③ Task State 前置注入（freshness 分档，§16.2 第 3 条）。
     * `p.state.inject` 是**独立分路**（第四轮外部评审 P0-5）：关掉它 = shadow 模式，
     * 状态照生成、只是不进上下文 —— 出问题时不必把整个扩展拔掉。
     */
    if (kindEnabled(p, 'episode-fold') && p.state.inject) {
      const loaded = loadState(sessionId)
      if (loaded.status === 'ok') {
        const entries = ctx.sessionManager?.getEntries?.() ?? []
        /* `freshView`：只落后「用户刚开口的那一条」不算陈旧（见 context-producer 的说明） */
        const fresh = freshView(freshnessOf({ stateWatermark: loaded.state.sourceWatermark, entries }))
        const applied = applyFreshness(loaded.state.task, fresh)
        if (applied.task) {
          const text = renderTaskState(applied.task, {
            freshness: freshnessLabel(applied.tier),
            sourceHead: loaded.state.sourceWatermark?.entryCount
          })
          if (text) {
            const injected = injectTaskState(next, text)
            next = injected.messages
            injectedTaskState = injected.injected
            /*
             * 记下**真的注入了什么档位**：注入块本身不进任何落盘文件（它是临时消息），
             * 所以这条诊断行就是“契约头到底写了什么”在真实链路里的唯一取证点。
             */
            if (injected.injected) {
              trace('context', {
                sessionId,
                hook: 'task-state-injected',
                freshness: freshnessLabel(applied.tier),
                sourceHead: loaded.state.sourceWatermark?.entryCount ?? null,
                tokens: estimateTokens(text),
                /*
                 * 条目状态分布：`skipped` 就是被 `activeTexts` 挡在注入块之外的旧条目
                 * （`superseded` / `resolved`）。渲染侧过滤了它们，但注入块不落盘 ——
                 * 这是「被推翻的旧决策真的没进去」唯一能取证的地方。
                 */
                items: stateItemCounts(applied.task),
                /* 排查用：水位之后到底多了几条、都是什么（只看 gap 数字排查不了） */
                gap: fresh.gap,
                turnsGap: fresh.turnsGap,
                pendingOnly: fresh.pendingOnly === true,
                tail: tailRolesOf(entries, loaded.state.sourceWatermark)
              })
            }
            if (applied.tier !== 'fresh') {
              trace('context', {
                sessionId,
                hook: 'task-state-freshness',
                tier: applied.tier,
                gap: fresh.gap,
                stale: applied.stale,
                dropped: applied.dropped
              })
            }
          }
        } else {
          /* 太旧 / 对不上：**不注入**比注入一份过期世界模型安全（宁少不错） */
          trace('context', { sessionId, hook: 'task-state-skipped', reason: `freshness-${applied.tier}`, gap: fresh.gap })
        }
      }
    }

    /*
     * 召回账本用**真实消息**重算（账本记录当轮回合号，供工具包装召回内容用）。
     *
     * 只在「召回真的可能发生时」才落盘（`tool-sweep` / `recall` 已接管）：
     * 若显式把 `kinds` 收窄到只有 `compaction`，就不该给每个会话都多出一份文件。
     * 为什么不能“有召回才写”：工具要拿当轮回合号给召回内容打 TTL 标记，
     * 而第一次召回的**那一刻**账本还不存在 —— 那时只能读到 0，会让刚召回
     * 的正文在同一回合的下一个请求里就被误清理（实测踩过：模型被迫二次召回）。
     */
    if (kindEnabled(p, 'tool-sweep') || kindEnabled(p, 'recall')) {
      const active = activeRecallTokens(next)
      const ledger = loadLedger(sessionId)
      if (ledger.activeTokens !== active || ledger.turn !== currentTurn) {
        saveLedger(sessionId, { turn: currentTurn, activeTokens: active })
      }
    }

    if (swept === 0 && !injectedTaskState && expiredRecalls === 0) return
    trace('context', {
      sessionId,
      hook: 'context',
      swept,
      injectedTaskState,
      expiredRecalls,
      activeRecallTokens: activeRecallTokens(next)
    })
    return { messages: next }
  } catch (error) {
    trace('context', { sessionId, hook: 'error', message: errorText(error) })
    return undefined
  }
}

/**
 * `session_before_compact` 钩子：结构化压缩的**接管闸门**。
 *
 * 接管条件（N21-4 生成器落地后放宽，§16.6.2）：
 *   ① 状态文件存在（`loadState` 为 ok）；
 *   ② 水位按 **freshness 分档**可用 —— 完全一致最好，“有效但较早”也接（带 stale 标记），
 *      对不上就交回 pi 原生摘要（不是“必须完全一致”）；
 *   ③ `buildStructuredSummary` 通过 —— 它不再要求六类字段齐备，
 *      `requiredFields` 默认为空数组（形状合法性由 schema 校验负责）。
 * 接管时保留 pi 给的 `firstKeptEntryId` 与 `tokensBefore`（我们只换摘要文本）。
 */
function onBeforeCompact(event, ctx) {
  const sessionId = sessionIdOf(ctx)
  /*
   * 「钩子**被调到**」本身是一条独立事实，必须在任何早退之前记下来。
   * 在此之前分不清两种情况：pi 压根没调（prepareCompaction 返回 falsy 时它直接跳过），
   * 还是调了但我们在某个分支里早退 —— 两者的日志**都是空的**，排查只能靠猜。
   * 它只在压缩真的发生时产生，不会污染常规运行的日志。
   */
  trace('compact', {
    sessionId,
    hook: 'entered',
    hasPreparation: !!event?.preparation,
    reason: event?.reason ?? null
  })
  if (!sessionId) return
  const p = policy()
  /*
   * 与注入同一条分路（第四轮外部评审 P0-5）：`inject=false` 的含义是
   * 「不让派生状态进入发给模型的上下文」，压缩接手也属于其中。
   * 关掉它不会连带停掉生成（那是 `state.generate` 的事）。
   */
  if (!p.state.inject) {
    trace('compact', { sessionId, hook: 'fallback', reason: 'inject-off' })
    return
  }
  try {
    const loaded = loadState(sessionId)
    if (loaded.status !== 'ok') {
      trace('compact', { sessionId, hook: 'fallback', reason: 'no-state' })
      return
    }
    const entries = ctx.sessionManager?.getEntries?.() ?? []
    const state = loaded.state
    /*
     * 水位判定改用 freshness 分档（同注入路径）：完全一致最好，
     * “有效但较早”也接（带 stale 标记）；对不上就不接 —— 交回 pi 原生摘要。
     */
    const fresh = freshView(freshnessOf({ stateWatermark: state.sourceWatermark, entries }))
    const applied = applyFreshness(state.task, fresh)
    if (!applied.task) {
      trace('compact', { sessionId, hook: 'fallback', reason: `freshness-${applied.tier}`, gap: fresh.gap })
      return
    }
    const built = buildStructuredSummary(
      { ...state, task: applied.task },
      /* 头行要写**真实**档位，不能默写 fresh（它已经是 stale-soft / stale-hard） */
      { freshness: freshnessLabel(applied.tier) }
    )
    if (!built.ok) {
      trace('compact', { sessionId, hook: 'fallback', reason: built.reason, missing: built.missing ?? null })
      return
    }
    const preparation = event?.preparation ?? {}
    const firstKeptEntryId = preparation.firstKeptEntryId
    const tokensBefore = Number(preparation.tokensBefore)
    if (typeof firstKeptEntryId !== 'string' || !firstKeptEntryId || !Number.isFinite(tokensBefore)) {
      trace('compact', { sessionId, hook: 'fallback', reason: 'bad-preparation' })
      return
    }
    trace('compact', { sessionId, hook: 'takeover', fields: built.fields, tier: applied.tier, gap: fresh.gap })
    return { compaction: { summary: built.summary, firstKeptEntryId, tokensBefore } }
  } catch (error) {
    trace('compact', { sessionId, hook: 'error', message: errorText(error) })
    return undefined
  }
}

/* ---------------------------------------------------------------- 状态生成器（N21-4 剩余项） */

/**
 * `sessionManager.getEntries()` → 与 `entryIds` 等长的消息数组。
 *
 * 为什么要自己配对：`onContext` 用的是 `event.messages`（模型即将看到的上下文），
 * 而 `agent_settled` 只给得到 entry 列表。两者必须用**同一套**「哪条 entry
 * 产生哪条消息」的规则，否则 evidence 里的 `entryId` 会贴到别的条目上
 * （那会让 Recall 取回别人的历史）。配对不成功就返回 null —— 宁可这次不生成。
 */
function messagePairsFromEntries(entries) {
  const list = contextEntries(entries)
  const messages = []
  const entryIds = []
  for (const entry of list) {
    if (!entryProducesMessage(entry)) continue
    if (typeof entry.id !== 'string' || !entry.id) return null
    let message = null
    if (entry.type === 'message') message = entry.message ?? null
    else if (entry.type === 'custom_message') message = { role: 'custom', summary: entry.summary ?? '' }
    else if (entry.type === 'branch_summary') message = { role: 'branchSummary', summary: entry.summary ?? '' }
    else if (entry.type === 'compaction') message = { role: 'compactionSummary', summary: entry.summary ?? '' }
    if (!message) return null
    messages.push(message)
    entryIds.push(entry.id)
  }
  return messages.length ? { messages, entryIds } : null
}

/** 生成器一次调用的墙钟上限（§16.6.1 建议 20s；超时保留旧状态，绝不落半成品） */
const PRODUCER_TIMEOUT_MS = 20_000
/** 输出上限：状态是短 JSON，给太多会让模型写散文 */
const PRODUCER_MAX_TOKENS = 1_200

/**
 * 单飞标志（§16.6.1）。epoch 用 sessionId 代替：换会话 = 换 epoch，
 * 旧会话的结果在 CAS 阶段自然被拒（不需要显式的 epoch 对账）。
 */
let producerFlight = null

/**
 * 会话级 eligibility gate 的两个会话内标记（第四轮外部评审第四问 A）。
 *
 * 都是**进程内**状态，不落盘：
 *   · `sweepSeen`   —— 本会话真的清扫过东西（说明上下文已经大到需要回收）；
 *   · `foldSticky`  —— 本会话已经满足过激活条件（一旦命中不再退回）。
 * 为什幺要 sticky：压缩之后用量会掉下来，不 sticky 会出现「开→关→开」，
 * 状态生命周期会变得没有意义。进程重启后重新判定是可接受的代价。
 */
const sweepSeen = new Set()
const foldSticky = new Set()

/** freshness 分档 → 注入契约里的 `freshness`（机器可读，取值只有三个） */
function freshnessLabel(tier) {
  if (tier === 'fresh') return 'fresh'
  if (tier === 'stale-hard') return 'stale'
  return 'partial'
}

function contentTextOf(response) {
  const content = response?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 一次生成尝试的 token 开销（估算口径统一）。
 *
 * 为什么失败路径也记：**失败也花钱**（20s 超时 / 返回空文本 / JSON 解析失败都是真的调了模型），
 * 只统计成功那几次会把开销系统性低估。
 */
function producerUsage(prompt, text, response) {
  const real = response?.usage
  const realIn = real && typeof real === 'object' ? Number(real.input) || 0 : 0
  const realOut = real && typeof real === 'object' ? Number(real.output) || 0 : 0
  /*
   * 「pi 给了 usage」不等于「数字有意义」：请求失败（超时 / 空响应）时 pi 会把
   * 一个 input/output 全 0 的 usage 递过来。若直接当真实值用，诊断会显示
   * 「生成开销 = 0」——比不显示更误导（实测于 2026-09-17 晚的 not-json 路径）。
   * 所以两个都取 0 时当作「没拿到」，让消费方退回估算。
   */
  const realUsable = realIn > 0 || realOut > 0
  return {
    input: estimateTokens(prompt),
    output: estimateTokens(text || ''),
    /* pi 到底给不给真实 usage：记个布尔，下次排查不用再猜 */
    reported: !!real,
    /* 有没有可用的真实数字（可能与 reported 不一致，见上） */
    realUsable,
    /* 给了就把数字也留下 —— 估算值与真实值可以对账（实测 pi 0.85.1 是给的） */
    real:
      real && typeof real === 'object'
        ? {
            input: realIn,
            output: realOut,
            cacheRead: Number(real.cacheRead) || 0
          }
        : null
  }
}

/**
 * `agent_settled`：状态生成器的唯一触发点。
 *
 * 为什么只在这里：① 它是「这一轮真的结束了」的稳定边界（retry / follow-up 都跑完）；
 * ② 生成要读整回合的 evidence，中途生成只会拿到半截会话；
 * ③ 绝不能阻塞下一次输入 —— 整个流程异步，失败就保留旧状态。
 */
function onAgentSettled(_event, ctx) {
  const p = policy()
  /*
   * 总闸是 `episode-fold`（默认 kinds 不含它 —— 所以默认**不调模型、不花钱**，
   * 行为与生成器落地前一致）；闸内还有两条独立分路（`p.state.generate` /
   * `p.state.inject`，第四轮外部评审 P0-5）与一道**会话级门槛**（`foldEligible`，
   * 第四问 A）：短会话不生成 —— 它没有东西可折叠，却要背上「语义状态变成
   * 下一轮推理输入」的闭环误差风险。
   */
  if (!kindEnabled(p, 'episode-fold') || !p.state.generate) return
  const sessionId = sessionIdOf(ctx)
  if (!sessionId) return
  if (!foldSticky.has(sessionId)) {
    const stats = transcriptStats(ctx?.sessionManager?.getEntries?.() ?? [])
    /*
     * State Refresh 档（N21-6）要一个「窗口有多大」的近似值。`ctx.model` 是 pi 暴露的
     * 当前模型对象，实测能拿到 `contextWindow`（拿不到就是 0 → 那条分支自动跳过）；
     * 把值一并记进诊断，以后再出问题不用猜。
     */
    const windowTokens = Number(ctx?.model?.contextWindow) || 0
    const gate = foldEligible({
      settledTurns: stats.userTurns,
      transcriptTokens: stats.tokens,
      firstSweep: sweepSeen.has(sessionId),
      windowTokens,
      ...(p.state.minTurns ? { minTurns: p.state.minTurns } : {}),
      ...(p.state.minTokens ? { minTokens: p.state.minTokens } : {}),
      ...(p.state.refreshRatio ? { refreshRatio: p.state.refreshRatio } : {})
    })
    if (!gate.eligible) {
      trace('producer', {
        sessionId,
        stage: 'producer',
        hook: 'gate',
        reason: gate.reason,
        turns: stats.userTurns,
        tokens: stats.tokens,
        window: windowTokens
      })
      return
    }
    foldSticky.add(sessionId)
    trace('producer', {
      sessionId,
      stage: 'producer',
      hook: 'gate',
      reason: gate.reason,
      activated: true,
      window: windowTokens
    })
  }
  if (producerFlight) {
    trace('producer', { sessionId, stage: 'producer', hook: 'skipped', reason: 'in-flight' })
    return
  }
  producerFlight = { sessionId, startedAt: Date.now() }
  void produceAndCommit(sessionId, ctx).finally(() => {
    producerFlight = null
  })
}

/**
 * 生成 → 合并 → CAS 落盘。任一环节失败都**不动**旧状态文件。
 */
async function produceAndCommit(sessionId, ctx) {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() ?? []
    const pairs = messagePairsFromEntries(entries)
    if (!pairs) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-message-identity' })
      return
    }
    /*
     * 生成器输入的自净（第四轮外部评审 P0-1）：把**我们注入/改写过的内容**
     * 从输入里剔掉，免得「漂移」变成「递归压缩」。详见 `stripSyntheticMessages`。
     */
    const cleaned = stripSyntheticMessages(pairs.messages, pairs.entryIds)
    if (!cleaned.messages.length) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-real-input' })
      return
    }
    if (cleaned.removed) {
      trace('producer', { sessionId, stage: 'producer', hook: 'input-cleaned', removed: cleaned.removed })
    }
    const loaded = loadState(sessionId)
    const previous = loaded.status === 'ok' ? loaded.state : null
    const watermark = watermarkOfEntries(entries)
    const evidence = evidenceFromMessages({ messages: cleaned.messages, entryIds: cleaned.entryIds })
    const fresh = freshnessOf({ stateWatermark: previous?.sourceWatermark, entries })
    /*
     * 落后**回合**数（不是条目数）：一个回合会产生多条 entry，用条目差算
     * 会让脏闸门提前触发、把权重（≥6）与净增（≥6000）两道门槛绕过去。
     * 水位条目定位不到（压缩 / 换分支）时退回条目差 —— 宁可多刷新一次，
     * 也不能因为数不出来就把闸门关掉。
     */
    const settledGap = previous
      ? fresh.relation === 'older'
        ? (fresh.turnsGap ?? fresh.gap)
        : fresh.relation === 'same'
          ? 0
          : 99
      : 0
    const mask = dirtyMaskWithEvidence(dirtyMask(entries), evidence)
    const decision = shouldRefresh({ stateMissing: !previous, mask, settledGap })
    if (!decision.needed) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: decision.reason, score: decision.score })
      return
    }

    const registry = ctx?.modelRegistry
    const model = ctx?.model
    if (!registry || typeof registry.complete !== 'function' || !model) {
      trace('producer', { sessionId, stage: 'producer', hook: 'skip', reason: 'no-model-registry' })
      return
    }

    const directives = userDirectives(cleaned.messages, cleaned.entryIds)
    /*
     * 可引用清单（第五轮外部意见 Q1 的 P0-③ provenance）：**只装本轮材料** ——
     * 用户原话与确定性 reducer 证据。上一版状态的 id 刻意不在其中，
     * 所以「因为上一版这么说」不能充当证据（那正是语义递归固化的通道）。
     */
    const citable = citableEntries({ directives, evidence })
    const prompt = buildProducerPrompt({ previousTask: previous?.task, directives, evidence, citable })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PRODUCER_TIMEOUT_MS)
    let response
    try {
      response = await registry.complete(
        model,
        {
          systemPrompt: PRODUCER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }]
        },
        { maxTokens: PRODUCER_MAX_TOKENS, signal: controller.signal }
      )
    } catch (error) {
      trace('producer', { sessionId, stage: 'producer', hook: 'error', message: errorText(error) })
      return
    } finally {
      clearTimeout(timer)
    }
    if (response?.stopReason === 'aborted') {
      trace('producer', { sessionId, stage: 'producer', hook: 'aborted', usage: producerUsage(prompt, '', response) })
      return
    }

    const text = contentTextOf(response)
    const usageTokens = producerUsage(prompt, text, response)
    const parsed = parseProducerOutput(text)
    if (!parsed.ok) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: parsed.reason, sample: text.slice(0, 200), usage: usageTokens })
      return
    }
    const merged = mergeTaskState({ semantics: parsed.value, evidence, previous: previous?.task, directives, citable, now: Date.now() })
    if (!merged) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: 'merge-failed', usage: usageTokens })
      return
    }
    /* 工作集在扩展侧拿不到（那是主进程的策略），用它自己的硬上限即可 */
    const clipped = clipTaskStateToBudget(merged, 0)
    if (clipped.over) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: 'over-budget', tokens: clipped.tokens, usage: usageTokens })
      return
    }

    /* CAS：读到的 revision 必须仍是生成开始前那一个（§16.6.1） */
    const currentRaw = readJson(sessionFilePath(sessionId, '.json'))
    const allowed = casAllows({
      current: {
        revision: Number.isFinite(currentRaw?.revision) ? currentRaw.revision : 0,
        entryCount: Number(currentRaw?.sourceWatermark?.entryCount) || 0
      },
      precondition: {
        expectedRevision: Number.isFinite(previous?.revision) ? previous.revision : 0,
        baseEntryCount: previous?.sourceWatermark?.entryCount ?? 0
      }
    })
    if (!allowed.ok) {
      trace('producer', { sessionId, stage: 'producer', hook: 'rejected', reason: allowed.reason, expected: allowed.expected, revision: allowed.revision })
      return
    }

    const state = buildStateFile({
      sessionId,
      watermark,
      task: clipped.task,
      /*
       * Episode 旁路防线（第四轮外部评审 P0-4）：旧 EpisodeState 的语义生成
       * 还没接上 provenance/freshness 这套契约，所以**不沿用上一版**。
       * 宁可不注入 Episode（少一段可追溯的引用），也不能让旧语义从旁边混进推理。
       */
      episodes: [],
      now: Date.now(),
      revision: allowed.revision + 1
    })
    writeJsonAtomic(sessionFilePath(sessionId, '.json'), state)
    trace('producer', {
      sessionId,
      stage: 'producer',
      hook: 'committed',
      revision: state.revision,
      files: evidence.files.length,
      commands: evidence.commandsRun.length,
      tests: evidence.testsRun.length,
      tokens: clipped.tokens,
      gap: fresh.gap,
      turnsGap: fresh.turnsGap,
      /*
       * provenance 分布。`hypothesis` 占比高 = 模型给不出证据（这些条目注入时会带
       * `inferred` 标记），也是「语义递归有没有被挡住」的唯一观测量。
       */
      provenance: provenanceCounts(clipped.task),
      citable: citable.length,
      usage: usageTokens,
      trigger: decision.reason
    })
  } catch (error) {
    trace('producer', { sessionId, stage: 'producer', hook: 'error', message: errorText(error) })
  }
}

/**
 * `context_recall` 工具。
 *
 * 原文来自**会话本身**（`sessionManager.getEntry`），不是归档副本 ——
 * 与「原始 JSONL 是事实源」一致，S1 的归档也只存元数据。
 * 预算超限一律**拒绝并解释**，不静默截断（§12.9）。
 */
function registerRecallTool(pi) {
  pi.registerTool({
    name: 'context_recall',
    label: 'Context recall',
    description:
      'Read back the original content of an archived tool result (a message you see as "[Archived tool result]" with a Ref). ' +
      'Archived content does NOT stay in context: recalling it counts against the context budget, and it expires after this turn. ' +
      'Prefer recalling only when the tombstone metadata is not enough.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ctx://tool/<id> reference shown on the archived result' },
        reason: { type: 'string', description: 'Optional: why the original content is needed' }
      },
      required: ['ref'],
      additionalProperties: false
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ref = String(params?.ref ?? '').trim()
      if (!/^ctx:\/\/(tool|file|diff|episode)\/[A-Za-z0-9._~%:-]{1,200}$/.test(ref)) {
        return textResult(`无法召回：${ref || '(空)'} 不是合法的 ctx:// 引用。`)
      }
      const sessionId = sessionIdOf(ctx)
      if (!sessionId) return textResult('无法召回：当前会话没有可用的存储位置。')

      const now = Date.now()
      const entry = findArchiveEntry(sessionId, ref)
      if (!entry) {
        return textResult(`无法召回 ${ref}：归档元数据里没有这条记录（可能已被清理）。`)
      }
      if (entry.recallable !== 'agent') {
        return textResult(`无法召回 ${ref}：这条内容不允许模型自行取回（recallable=${entry.recallable}）。`)
      }
      if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) {
        return textResult(`无法召回 ${ref}：这条归档内容已过期（expiresAt=${new Date(entry.expiresAt).toISOString()}）。`)
      }

      const entryId = ref.slice(ref.lastIndexOf('/') + 1)
      const raw = rawTextOf(ctx, entryId)
      if (raw === null) {
        return textResult(`无法召回 ${ref}：原始会话里已经找不到这条内容了（可能被压缩或裁剪）。`)
      }
      const tokens = estimateTokens(raw)
      const ledger = loadLedger(sessionId)
      const p = policy()
      const decision = recallBudget(p.recall, { tokens, count: 1 }, { tokens: ledger.activeTokens })
      if (!decision.ok) {
        audit(sessionId, { ts: now, kind: 'recall', ref, tokens, by: 'agent', result: 'rejected', reason: decision.reason })
        const message =
          decision.reason === 'too-large'
            ? `这次召回约 ${tokens} token，超过单次上限 ${decision.limit}；请缩小范围（例如只召回其中一段）。`
            : decision.reason === 'active-budget'
              ? `当前已召回内容约 ${decision.active} token，再加这次 ${tokens} 会超过上限 ${decision.limit}；请先整理已有结论。`
              : `一次最多召回 ${decision.limit} 条，本次请求被拒绝。`
        return textResult(`召回被拒绝：${message}`)
      }

      saveLedger(sessionId, { turn: ledger.turn, activeTokens: ledger.activeTokens + tokens })
      audit(sessionId, { ts: now, kind: 'recall', ref, tokens, by: 'agent', result: 'ok', reason: params?.reason ?? null })
      return textResult(wrapRecall(raw, ref, ledger.turn))
    }
  })
}

/** 从会话里按原始 entry id 取回工具结果的原文（取不到返回 null） */
function rawTextOf(ctx, entryId) {
  try {
    const manager = ctx?.sessionManager
    if (!manager || typeof manager.getEntry !== 'function') return null
    const entry = manager.getEntry(entryId)
    if (!entry) return null
    if (entry.type === 'message') return messageText(entry.message) || null
    if (typeof entry.summary === 'string') return entry.summary
    if (typeof entry.content === 'string') return entry.content
    return null
  } catch {
    return null
  }
}

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------------------------------------------------------- 导出 */

export default function contextExtension(pi) {
  pi.on('context', (event, ctx) => onContext(event, ctx))
  pi.on('session_before_compact', (event, ctx) => onBeforeCompact(event, ctx))
  /*
   * N21-4 生成器：`agent_settled` 是「这一轮真的结束」的稳定边界。
   * 只在 `kinds` 含 `episode-fold` 时才真的会调模型（见 onAgentSettled）。
   */
  pi.on('agent_settled', (event, ctx) => onAgentSettled(event, ctx))
  registerRecallTool(pi)
}

/**
 * 供单测直接调用的内部函数（扩展默认导出之外）。
 * 命名带下划线，避免与 pi 的扩展 API 混淆。
 */
export const __internals = {
  policy,
  onContext,
  onBeforeCompact,
  onAgentSettled,
  mergeArchive,
  findArchiveEntry,
  loadState,
  rawTextOf,
  audit,
  loadLedger,
  saveLedger,
  messagePairsFromEntries,
  contentTextOf,
  produceAndCommit,
  resetProducerFlight: () => {
    producerFlight = null
  }
}
