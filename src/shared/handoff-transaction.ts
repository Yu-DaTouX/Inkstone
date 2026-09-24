/**
 * 跨会话交接的**事务状态机**（实施-05 S5b-3a）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * §8 的事务有七步，每一步都可能崩在中间。交接与别处最大的不同是：
 * **它的失败后果是「两个会话同时在干活」或「两边都不干」**，
 * 而这两种都比「干脆没交接」更糟 —— 任务会被重复执行，或者悄无声息地停住。
 *
 * 所以这里不做任何 IO，只回答四个问题（全部可单测）：
 *   ① 这一步**能不能走**（顺序固定，不许跳步，不许倒退）；
 *   ② 同一份交接被重复推进时是不是幂等（每一层都可能重放）；
 *   ③ 崩在中间之后**该做什么**（`recoveryAction`：重发 / 放弃 / 补记完成 / 什么都不做）；
 *   ④ 「已提交」到底意味着什么（`committed` 才切活动段，之前任何阶段都还在源会话上）。
 *
 * ── 为什么顺序不能跳 ──
 *   `destination-created` **必须**在 `committed` 之前：目的会话要先建出来、
 *   关系（`session-chains.json`）要先写好，才能切活动段 —— 顺序反了会产生
 *   「已经指向新会话，但那个会话不存在」的状态，崩溃后连源会话都回不去。
 *
 * ── 为什么 resumed 要单独的消费证据，而不是「发出即完成」──
 *   发送与确认之间是进程随时可能死掉的窗口。`resumed` 只能由**磁盘上的证据**
 *   （目的会话 JSONL 里那条 resume 消息）来置位；否则重启后会再发一遍，
 *   而那一遍会变成用户看得见的重复消息（甚至重复执行）。
 */

import type { HandoffPackage } from './handoff'

/** 事务阶段（§8 的七步 + failed）。 */
export type HandoffStage =
  /** 已决定交接，开始截水位 */
  | 'pending'
  /** 水位与交接包都拿到了 */
  | 'snapshot'
  /** 交接包过完了三道闸门（形状 + 必填 + 来源覆盖） */
  | 'validated'
  /** 目的会话已创建、关系已写、**但还没切** */
  | 'destination-created'
  /** 已提交：活动段切到目的会话，旧实例释放 cwd 租约 */
  | 'committed'
  /** 目的会话里已能看到那条 resume（磁盘证据） */
  | 'resumed'
  /** 放弃：保留源会话，不继续往下走 */
  | 'failed'

/** 允许的前进顺序（`failed` 从任何非终态可达，单独处理）。 */
export const HANDOFF_STAGE_ORDER: HandoffStage[] = [
  'pending',
  'snapshot',
  'validated',
  'destination-created',
  'committed',
  'resumed'
]

export type HandoffRecoveryAction = 'none' | 'resend' | 'abandon' | 'complete'

export interface HandoffStep {
  at: number
  from: HandoffStage
  to: HandoffStage
  detail?: string
}

/**
 * 续接的**回执**（实施-15 A-3 / 审核 R6）。
 *
 * 为什么要分开记：`resumed` 一直是用「会话文件里出现了续行标记」判的，
 * 那只能证明**已投递**，证明不了「模型真的开始跑了」（正文是本地拼的，
 * 写进文件不需要模型参与）。把三件事分开落盘之后，
 * 界面与恢复都能说清楚「到哪一步了」：
 *   · `sentAt` —— 已经把续行交给目的实例；
 *   · `persistedAt` —— 已在目的会话文件里看到（= 现在 `resumed` 的依据）；
 *   · `startedAt` —— 续接扩展在同一 operationId 的 `before_provider_request` 中写下启动回执。
 *
 * 现状（如实）：`resumed` 仍以 `persistedAt` 为准，`startedAt` 只做附加观察，
 * **未当门槛** —— 把它当门槛会让交接在模型未启动时长时间挂住。
 */
export interface HandoffReceipts {
  sentAt?: number
  persistedAt?: number
  startedAt?: number
}

export interface HandoffTransaction {
  handoffId: string
  /** 源会话文件路径（宿主侧的键） */
  sourceSession: string
  /** 目的会话文件路径（建出来之后才有） */
  destinationSession: string | null
  /** 交接包本体（事务日志里也留一份：崩溃恢复时不必再调一次模型） */
  package: HandoffPackage | null
  /** 发 resume 时用的稳定 id（消费证据按它判重） */
  resumeId: string
  /**
   * 已经尝试发送 resume 的次数（含正常提交那一次）。
   *
   * 为什么需要它：§8 第 6 条要求「崩溃在发送后确认前时不盲发两遍」。
   * 没有计数器时，只要证据一直没落地，每次启动都会重发一遍 ——
   * 而 resume 是会真的起一轮模型的，重发就是重复执行。
   * 规则：`0` 从未发过（可以发一次、也可以由恢复重发一次）；
   * `>= 2` 说明已经重发过一次仍无证据 → 不再自动重发，交给人判断。
   */
  resumeAttempts: number
  /** 续接回执（A-3）：见 `HandoffReceipts` 的注释。 */
  receipts: HandoffReceipts
  stage: HandoffStage
  /** 每一步的转移日志（可恢复日志的最小形态） */
  steps: HandoffStep[]
  error: string | null
  createdAt: number
  updatedAt: number
}

export function handoffStages(): HandoffStage[] {
  return [...HANDOFF_STAGE_ORDER]
}

/** 终态：`resumed` 与 `failed` 都不再前进。 */
export function isTerminalStage(stage: HandoffStage): boolean {
  return stage === 'resumed' || stage === 'failed'
}

/** 这一步在不在允许的顺序里、是不是正好往前走一格。 */
export function canAdvance(
  tx: HandoffTransaction,
  to: HandoffStage
): { ok: boolean; reason: string } {
  if (!tx || !tx.stage) return { ok: false, reason: 'no-transaction' }
  if (tx.stage === to) return { ok: false, reason: 'already-there' }
  if (isTerminalStage(tx.stage)) return { ok: false, reason: `terminal:${tx.stage}` }
  if (to === 'failed') return { ok: true, reason: 'fail' }
  const from = HANDOFF_STAGE_ORDER.indexOf(tx.stage)
  const next = HANDOFF_STAGE_ORDER.indexOf(to)
  if (next < 0) return { ok: false, reason: 'unknown-stage' }
  if (next !== from + 1) return { ok: false, reason: next < from ? 'backwards' : 'skipped' }
  /*
   * 目标会话与交接包是「能不能往下走」的硬前提：
   * 没有目的会话就谈不上 committed，没有包就谈不上 validated。
   */
  if (to === 'validated' && !tx.package) return { ok: false, reason: 'no-package' }
  if ((to === 'destination-created' || to === 'committed') && !tx.destinationSession) {
    return { ok: false, reason: 'no-destination' }
  }
  return { ok: true, reason: 'ok' }
}

/**
 * 推进一格（幂等：重复推进 / 跳步 / 倒退都返回 `advanced:false` + 可读原因）。
 *
 * 返回值里带回新事务（不可变），调用方负责落盘 —— 顺序必须是**先落盘再动作**，
 * 否则崩溃一次就会出现「动作做了但日志没有」。
 */
export function advance(
  tx: HandoffTransaction,
  to: HandoffStage,
  opts: { at?: number; detail?: string } = {}
): { tx: HandoffTransaction; advanced: boolean; reason: string } {
  const verdict = canAdvance(tx, to)
  if (!verdict.ok) return { tx, advanced: false, reason: verdict.reason }
  const at = opts.at ?? Date.now()
  const step: HandoffStep = { at, from: tx.stage, to, ...(opts.detail ? { detail: opts.detail } : {}) }
  return {
    tx: {
      ...tx,
      stage: to,
      steps: [...tx.steps, step].slice(-40),
      updatedAt: at,
      ...(to === 'failed' ? { error: opts.detail ?? tx.error } : {})
    },
    advanced: true,
    reason: verdict.reason
  }
}

/** 补上目的会话（建出来之后调；已提交之后再改就是 bug，所以只允许在 committed 之前）。 */
export function attachDestination(
  tx: HandoffTransaction,
  destinationSession: string,
  at = Date.now()
): { tx: HandoffTransaction; ok: boolean; reason: string } {
  const dest = typeof destinationSession === 'string' ? destinationSession.trim() : ''
  if (!dest) return { tx, ok: false, reason: 'empty-destination' }
  if (tx.destinationSession && tx.destinationSession !== dest) {
    return { tx, ok: false, reason: 'destination-locked' }
  }
  if (tx.stage === 'committed' || tx.stage === 'resumed') {
    /* 已提交之后再换目的会话 = 把用户指向一个没有任务上下文的会话，宁可报错 */
    return { tx, ok: false, reason: 'already-committed' }
  }
  if (tx.destinationSession === dest) return { tx, ok: true, reason: 'unchanged' }
  return { tx: { ...tx, destinationSession: dest, updatedAt: at }, ok: true, reason: 'attached' }
}

/** 带上交接包（生成完之后调；已校验过之后再换包要重走校验，所以只允许一次）。 */
export function attachPackage(
  tx: HandoffTransaction,
  pkg: HandoffPackage,
  at = Date.now()
): { tx: HandoffTransaction; ok: boolean; reason: string } {
  if (!pkg) return { tx, ok: false, reason: 'no-package' }
  if (tx.package) return { tx, ok: false, reason: 'package-locked' }
  const next = { ...tx, package: pkg, updatedAt: at }
  /* 在 snapshot 阶段拿到包 → 顺手前进到 validated（那是同一个事实的两面） */
  if (tx.stage === 'snapshot') {
    const moved = advance(next, 'validated', { at, detail: 'package-attached' })
    return { tx: moved.tx, ok: moved.advanced, reason: moved.reason }
  }
  return { tx: next, ok: true, reason: 'attached' }
}

export function createTransaction(input: {
  handoffId: string
  sourceSession: string
  resumeId: string
  at?: number
}): HandoffTransaction {
  const at = input.at ?? Date.now()
  return {
    handoffId: input.handoffId,
    sourceSession: input.sourceSession,
    destinationSession: null,
    package: null,
    resumeId: input.resumeId,
    resumeAttempts: 0,
    receipts: {},
    stage: 'pending',
    steps: [],
    error: null,
    createdAt: at,
    updatedAt: at
  }
}

/**
 * 崩溃之后的处置（§8 第 6/7 条）。
 *
 * `destinationHasResume` 必须是**磁盘证据**（目的会话 JSONL 里有没有那条 resume），
 * 不是内存里记的「我发过了」—— 内存里记的恰恰是崩溃会丢的那部分。
 */
export function recoveryAction(
  tx: HandoffTransaction,
  evidence: { destinationHasResume: boolean }
): { action: HandoffRecoveryAction; reason: string } {
  if (!tx) return { action: 'none', reason: 'no-transaction' }
  switch (tx.stage) {
    case 'resumed':
      return { action: 'none', reason: 'already-resumed' }
    case 'failed':
      return { action: 'none', reason: 'failed' }
    case 'committed':
      /*
       * 最危险的那一格：日志说「已提交」，但发没发出去不知道。
       * 有证据 → 补记完成；没证据 → **允许重发一次**（resumeId 相同，
       * 消费去重能挡住重复执行）—— 这就是「不盲发两遍」的落点。
       */
      return evidence.destinationHasResume
        ? { action: 'complete', reason: 'evidence-found' }
        : { action: 'resend', reason: 'no-evidence' }
    case 'destination-created':
      /*
       * 已建目的会话但没提交：会话关系已经写了，但活动段还在源会话上。
       * 回源是对的（§7「未提交回源」）—— 目的会话是个空壳，留着不影响任何人。
       */
      return { action: 'abandon', reason: 'not-committed' }
    default:
      /* pending / snapshot / validated：还没动过任何外部状态，直接回源 */
      return { action: 'abandon', reason: 'nothing-to-recover' }
  }
}

/**
 * 记一次 resume 发送尝试（发送**之前**记：崩溃在发送途中也算发过）。
 *
 * 与阶段推进分开是因为它不是状态转移（阶段还是 `committed`），
 * 但它是「不盲发两遍」的判据 —— 只留在内存里等于没记（恰恰是崩溃会丢的部分）。
 */
export function recordResumeAttempt(tx: HandoffTransaction, at = Date.now()): HandoffTransaction {
  return {
    ...tx,
    resumeAttempts: Math.max(0, Math.floor(tx.resumeAttempts ?? 0)) + 1,
    receipts: { ...(tx.receipts ?? {}), sentAt: tx.receipts?.sentAt ?? at },
    updatedAt: at
  }
}

/** 回执种类（与 `HandoffReceipts` 的字段一一对应，调用方只管说“哪一步”）。 */
export type ReceiptKind = 'sent' | 'persisted' | 'started'

const RECEIPT_FIELD: Record<ReceiptKind, keyof HandoffReceipts> = {
  sent: 'sentAt',
  persisted: 'persistedAt',
  started: 'startedAt'
}

/**
 * 记一条回执（A-3）。
 *
 * 同一个 kind 只记**第一次**：回执的意义是「什么时候第一次到达这一步」，
 * 反复重写会把「早就到了」的时间推后，反而看不出真实的停顿发生在哪。
 */
export function recordReceipt(tx: HandoffTransaction, kind: ReceiptKind, at = Date.now()): HandoffTransaction {
  const field = RECEIPT_FIELD[kind]
  const receipts = tx.receipts ?? {}
  if (typeof receipts[field] === 'number') return tx
  return { ...tx, receipts: { ...receipts, [field]: at }, updatedAt: at }
}

/** 一行摘要（界面 / 日志）。 */
export function transactionSummary(tx: HandoffTransaction | null): string {
  if (!tx) return '没有交接事务'
  const dest = tx.destinationSession ? tx.destinationSession.split(/[\\/]/).pop() : '（未建）'
  return `${tx.stage} · 源 ${tx.sourceSession.split(/[\\/]/).pop() ?? '?'} → ${dest}${tx.error ? ` · ${tx.error}` : ''}`
}
