/**
 * 交接事务的**执行器**（实施-05 S5b-3b）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * S5b-3a 把 §8 的七个阶段做成了可恢复的状态机，但**不含任何外部动作**。
 * 这一层就是那些动作，顺序与状态机严格对齐（每一步先落盘、再动外部状态）：
 *
 *   snapshot → validated              截水位、拿到交接包
 *   validated → destination-created   停源实例（释放同 cwd 租约）→ 建目的会话
 *   destination-created → committed   写会话链（前端「一条会话」的落点）
 *   committed → resumed               发一次 resume，等**磁盘证据**
 *
 * ── 三条不能破的顺序 ──
 *   ① **先停源、再建目的**：两个忙实例不能共用一个物理 cwd（`runners.ts` 的
 *      同 cwd 防线）。§8 第 4 条要求「旧 runner 释放租约、新 runner 获取，
 *      不得绕过同 cwd 防线」—— 绕过就是拿文件写入冲突换交接，代价不对等。
 *   ② **链只在目的会话真的建出来之后写**：链一写，侧栏就只显示代表段
 *      （目的会话）。若此刻会话文件还不存在，界面会指向一个不存在的东西。
 *   ③ **`resumed` 只认磁盘证据**：发送与确认之间是进程随时会死掉的窗口；
 *      内存里记「我发过了」恰恰是崩溃会丢的那部分。
 *
 * ── 失败一律回源 ──
 *   §8 第 7 条「失败保留源会话；未提交回源」。任何一步失败都把阶段记成
 *   `failed` 并把视图切回源会话 —— 宁可这次交接没发生，也不能出现
 *   「两侧都以为对方在干」。
 *
 * ⚠️ 这一层不直接 import agent / runners，全部经 `deps` 注入 ——
 *    单测用假依赖就能覆盖全部顺序与失败路径（真 Electron 只验接线）。
 */

import type { HandoffPackage } from '../shared/handoff'
import {
  buildResumeText,
  containsResumeEvidence,
  resumeMarker,
  resumePreview
} from '../shared/handoff-resume'
import {
  recoveryAction,
  type HandoffStage,
  type HandoffTransaction
} from '../shared/handoff-transaction'
import type { HandoffTransactionStore } from './handoff-transaction-service'
import type { SessionChainStore } from './session-chain-service'
import { normalizeChainKey } from '../shared/session-chain'

/** 目的会话里等 resume 证据的上限（判「真的发出去了」）。 */
export const RESUME_EVIDENCE_TIMEOUT_MS = 20_000
const RESUME_EVIDENCE_POLL_MS = 400

export interface HandoffSessionTarget {
  cwd: string
  projectId?: string
  /** 缺省 = 新建会话（交接的默认路径） */
  sessionFile?: string
  /**
   * 打开后是否把它设为**当前选中会话**（缺省 true）。
   *
   * 后台交接必须传 false（实施-14 F3）：用户可能正在看另一条会话，
   * 一次后台换段不该把他的视图抢走。
   */
  activate?: boolean
}

export interface HandoffSessionHandle {
  ok: boolean
  runId?: string
  sessionFile?: string
  error?: string
}

export interface HandoffRunnerDeps {
  transactions: HandoffTransactionStore
  chains: SessionChainStore
  /** 停掉一个运行实例（释放它的 cwd 租约）。不存在也算成功。 */
  stopRunner: (runId: string) => Promise<boolean>
  /**
   * 在指定 cwd 上打开（新建或切换到）一个会话实例。
   *
   * `cwd` 为空 = 崩溃恢复路径（重启后不知道当时的 cwd）：
   * 实现方用当前项目目录兜底 —— 恢复只是把实例接回来，不重新决定工作目录。
   */
  openSession: (target: HandoffSessionTarget) => Promise<HandoffSessionHandle>
  /**
   * 把交接 resume 交给实例（实施-14 F4）。
   *
   * `resumeId` 一并给出：宿主侧用它写续行快照（薄层按 `operationId` 做消费幂等），
   * 也从它拼出磁盘证据标记。
   */
  send: (runId: string, text: string, resumeId: string) => Promise<{ ok: boolean; error?: string }>
  /** 读会话文件原文（判消费证据；读不到返回 null） */
  readSessionText: (sessionFile: string) => Promise<string | null>
  notify: (message: string, type: 'info' | 'warning' | 'error') => void
  /**
   * 这次交接的源实例是不是用户当前正在看的那一个（实施-14 F3）。
   * 决定目的片段要不要抢选中：后台交接传 false。缺省 true（保留旧行为）。
   */
  shouldActivate?: (sourceRunId: string) => boolean
  /**
   * 目的片段已建好、**resume 还没发**：宿主在这里继承模式与宿主级目标事实
   * （实施-14 F3）。必须比 resume 早 —— 否则目的段第一轮会按默认档 /
   * 空目标启动，用户看到的自主长任务会停在第一个回合。
   *
   * 回调自身抛错不阻断交接（继承失败不该让整次换段失败），但宿主应自己留诊断。
   */
  onDestinationReady?: (info: {
    sessionFile: string
    runId: string
    sourceSession: string
  }) => Promise<void>
  now?: () => number
  /** 等证据的轮询（单测注入一个立即返回的实现） */
  pollEvidence?: (probe: () => Promise<boolean>, timeoutMs: number) => Promise<boolean>
}

export interface HandoffCommitInput {
  handoffId: string
  sourceRunId: string
  sourceSession: string
  cwd: string
  projectId?: string
  pkg: HandoffPackage
  /** 证据等待上限覆盖（测试用） */
  evidenceTimeoutMs?: number
}

export interface HandoffCommitResult {
  ok: boolean
  stage: HandoffStage
  destinationSession: string | null
  error?: string
}

async function defaultPollEvidence(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, RESUME_EVIDENCE_POLL_MS))
  }
}

export class HandoffRunner {
  private readonly poll: (probe: () => Promise<boolean>, timeoutMs: number) => Promise<boolean>

  constructor(private readonly deps: HandoffRunnerDeps) {
    this.poll = deps.pollEvidence ?? defaultPollEvidence
  }

  /**
   * 提交一次交接：状态机往前走到底（或停在明确的可恢复位置）。
   *
   * 幂等：同一 `handoffId` 重放不会建第二条事务、不会重复写链；
   * 已经在 `resumed` / `failed` 的事务直接返回现状。
   */
  async commit(input: HandoffCommitInput): Promise<HandoffCommitResult> {
    const { transactions, chains } = this.deps
    await transactions.load()
    await chains.load()

    const begun = await transactions.begin({
      handoffId: input.handoffId,
      sourceSession: input.sourceSession,
      resumeId: input.handoffId
    })
    let tx = begun.tx
    if (tx.stage === 'resumed' || tx.stage === 'failed') {
      return {
        ok: tx.stage === 'resumed',
        stage: tx.stage,
        destinationSession: tx.destinationSession,
        ...(tx.error ? { error: tx.error } : {})
      }
    }

    /* ① 水位与包：把 pending 推到 validated（每一步都先落盘） */
    if (tx.stage === 'pending') {
      const moved = await transactions.step(input.handoffId, 'snapshot', 'source-head-captured')
      tx = moved.tx ?? tx
    }
    if (!tx.package) {
      const attached = await transactions.setPackage(input.handoffId, input.pkg)
      tx = attached.tx ?? tx
      if (!attached.ok || !tx.package) return this.fail(input, '交接包没能写进事务日志')
    }
    if (tx.stage === 'snapshot') {
      const moved = await transactions.step(input.handoffId, 'validated', 'package-attached')
      tx = moved.tx ?? tx
    }

    /*
     * ② 已建目的会话但还没提交（崩溃后走到这里）：继续走完剩下的。
     *    这是**幂等重放**，不会重新建一个会话 —— 目的会话锁定过，不会漂。
     */
    if (tx.stage === 'destination-created' && tx.destinationSession) {
      return this.finishCommit(input, tx)
    }

    /*
     * ⚠️ 是否激活必须在**停源之前**问（实施-14 F3）：`stopRunner` 之后
     * `activeRunnerId` 已经不是源了，再问只会得到 false —— 后果是新建的目的
     * 实例永远不被激活，交接后 `getGoal` / `getHandoff` 全部读到「无活动实例」
     *（探针现场：`rev0 phase=planning mode=standard`，全部是空值）。
     */
    const activate = this.deps.shouldActivate?.(input.sourceRunId) ?? true
    /* ③ 释放源租约 → 建目的会话（同 cwd 防线不允许两步并行） */
    await this.deps.stopRunner(input.sourceRunId)
    const opened = await this.deps.openSession({
      cwd: input.cwd,
      activate,
      ...(input.projectId ? { projectId: input.projectId } : {})
    })
    if (!opened.ok || !opened.sessionFile || !opened.runId) {
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, opened.error ?? '目的会话没能建起来')
    }

    const attachedDest = await transactions.setDestination(input.handoffId, opened.sessionFile)
    if (!attachedDest.ok || !attachedDest.tx) {
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, `目的会话没能记进事务日志（${attachedDest.reason}）`)
    }
    const created = await transactions.step(input.handoffId, 'destination-created', 'destination-opened')
    if (!created.advanced || !created.tx) {
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, `目的会话阶段没能落盘（${created.reason}）`)
    }
    /*
     * 目的片段已建好、**resume 还没发**：把模式与用户级目标事实继承过去
     * （实施-14 F3）。失败不阻断交接 —— 宁可第一轮按默认档起步，
     * 也不能把一次已经走完大半的健康交接卡在继承上。
     */
    if (this.deps.onDestinationReady) {
      await this.deps
        .onDestinationReady({ sessionFile: opened.sessionFile, runId: opened.runId, sourceSession: input.sourceSession })
        .catch(() => undefined)
    }
    return this.finishCommit(input, created.tx, opened.runId)
  }

  /** 从 `destination-created` 往后：写链 → 提交 → 发 resume → 等证据。 */
  private async finishCommit(
    input: HandoffCommitInput,
    tx: HandoffTransaction,
    knownRunId?: string
  ): Promise<HandoffCommitResult> {
    const dest = tx.destinationSession
    if (!dest) return this.fail(input, '没有目的会话，无法提交')

    /*
     * 链：前端「一条会话」的唯一落点。
     * 键不可用 / 目的已属于另一条链都算失败 —— 宁可这次不交接，也不要两条会话。
     * ⚠️ `link` 在「目的已属于另一条链」时会返回**那条链**（而不是 null），
     *    所以判据必须是「这条链上真的有源和目的两段」。
     */
    if (!(await this.ensureLinked(input.sourceSession, dest, input.handoffId))) {
      return this.fail(input, '会话链没写成（前端会出现两条会话）')
    }

    if (tx.stage === 'destination-created') {
      const committed = await this.deps.transactions.step(input.handoffId, 'committed', 'chain-linked')
      if (!committed.advanced || !committed.tx) return this.fail(input, `提交阶段没能落盘（${committed.reason}）`)
      tx = committed.tx
    }

    /* 已在 committed：先看磁盘证据，有就直接补记完成（崩溃后不重发） */
    if (await this.hasEvidence(dest, tx.resumeId)) {
      const done = await this.deps.transactions.step(input.handoffId, 'resumed', 'evidence-found')
      if (done.tx) tx = done.tx
      this.deps.notify('交接已在目的会话继续（磁盘证据确认）。', 'info')
      return { ok: true, stage: tx.stage, destinationSession: dest }
    }

    /* 发一次 resume。发送失败不算终结：committed 留在日志里，下次启动恢复会重发。 */
    const runId = knownRunId ?? (await this.openDestination(input.cwd, input.projectId, dest))
    if (!runId) return this.midway(input, dest, '目的实例没能打开，resume 未发送（下次启动会重试）')

    /*
     * **发送之前**先记一次尝试：崩溃在发送途中也算「已经发过」——
     * 记在发送之后的话，恰好那个窗口会丢计数，下次启动又当成从没发过。
     */
    await this.deps.transactions.noteResumeAttempt(input.handoffId)
    const text = buildResumeText(tx.package, tx.resumeId)
    const sent = await this.deps.send(runId, text, tx.resumeId)
    if (!sent.ok) return this.midway(input, dest, `resume 发送失败：${sent.error ?? '未知原因'}`)

    const confirmed = await this.poll(
      () => this.hasEvidence(dest, tx.resumeId),
      input.evidenceTimeoutMs ?? RESUME_EVIDENCE_TIMEOUT_MS
    )
    if (!confirmed) {
      return this.midway(input, dest, 'resume 已发出，但还没在会话文件里看到证据（下次启动会核对，不重发）')
    }
    const done = await this.deps.transactions.step(input.handoffId, 'resumed', 'evidence-found')
    if (done.tx) tx = done.tx
    this.deps.notify(`交接完成，已在新会话继续：${resumePreview(text)}`, 'info')
    return { ok: true, stage: tx.stage, destinationSession: dest }
  }

  /**
   * 启动时的崩溃恢复（§8 第 6/7 条）。
   *
   * 每个未终结事务按 `recoveryAction` 处置：
   *   · `complete` —— 有磁盘证据，补记 `resumed`；
   *   · `resend`   —— 已提交但没证据，**重发一次**（`resumeId` 相同，消费去重挡住重复）；
   *   · `abandon`  —— 还没提交，记 `failed` 并把视图交还源会话。
   *
   * 返回每个事务的处置摘要（排障 / 探针）。
   */
  async recover(): Promise<{ handoffId: string; action: string; stage: HandoffStage }[]> {
    const { transactions } = this.deps
    await transactions.load()
    await this.deps.chains.load()
    const out: { handoffId: string; action: string; stage: HandoffStage }[] = []
    for (const tx of transactions.openTransactions()) {
      const dest = tx.destinationSession
      const evidence = dest ? await this.hasEvidence(dest, tx.resumeId) : false
      const verdict = recoveryAction(tx, { destinationHasResume: evidence })

      if (verdict.action === 'complete') {
        const moved = await transactions.step(tx.handoffId, 'resumed', 'recovered:evidence-found')
        out.push({ handoffId: tx.handoffId, action: verdict.action, stage: moved.tx?.stage ?? tx.stage })
        continue
      }

      if (verdict.action === 'resend' && dest) {
        /* 提交过就一定有链；链没了说明日志与磁盘不一致，按失败回源处置 */
        const linked = await this.ensureLinked(tx.sourceSession, dest, tx.handoffId)
        if (!linked || !tx.package) {
          const moved = await transactions.step(tx.handoffId, 'failed', 'recovered:chain-missing')
          await this.reopenSource(tx.sourceSession, '')
          out.push({ handoffId: tx.handoffId, action: 'abandon', stage: moved.tx?.stage ?? tx.stage })
          continue
        }
        /*
         * 已经重发过一次还是没证据 → 不再自动重发（§8 第 6 条「不盲发两遍」）。
         * 继续发只会重复起一轮模型，而重复执行比“停下来等人”贵得多。
         */
        if (tx.resumeAttempts >= 2) {
          this.deps.notify('交接重发过一次仍未看到消费证据，不再自动重发（目的会话需要人工确认）。', 'warning')
          out.push({ handoffId: tx.handoffId, action: 'none', stage: tx.stage })
          continue
        }
        const runId = await this.openDestination('', undefined, dest)
        if (runId) {
          await transactions.noteResumeAttempt(tx.handoffId)
          await this.deps.send(runId, buildResumeText(tx.package, tx.resumeId), tx.resumeId).catch(() => undefined)
          if (await this.poll(() => this.hasEvidence(dest, tx.resumeId), RESUME_EVIDENCE_TIMEOUT_MS)) {
            const moved = await transactions.step(tx.handoffId, 'resumed', 'recovered:evidence-found')
            out.push({ handoffId: tx.handoffId, action: 'complete', stage: moved.tx?.stage ?? tx.stage })
            continue
          }
        }
        out.push({ handoffId: tx.handoffId, action: verdict.action, stage: tx.stage })
        continue
      }

      const moved = await transactions.step(tx.handoffId, 'failed', `recovered:${verdict.reason}`)
      /* 未提交回源：目的会话是空壳，把视图交还给源文件 */
      await this.reopenSource(tx.sourceSession, '')
      out.push({ handoffId: tx.handoffId, action: 'abandon', stage: moved.tx?.stage ?? tx.stage })
    }
    return out
  }

  private async hasEvidence(sessionFile: string, resumeId: string): Promise<boolean> {
    const text = await this.deps.readSessionText(sessionFile).catch(() => null)
    return containsResumeEvidence(text, resumeId)
  }

  /**
   * 把目的段接到源段后面，并确认链上**真的有这两段**。
   *
   * `SessionChainStore.link` 在「目的已属于另一条链」时返回的是**那条链**
   * （表示拒绝），只看返回值非空会把拒绝当成功 —— 那种情况下写链根本没发生，
   * 而前端会据此显示两条会话。
   */
  private async ensureLinked(source: string, dest: string, handoffId: string): Promise<boolean> {
    try {
      const chain = await this.deps.chains.link(source, dest, handoffId)
      if (!chain) return false
      const from = normalizeChainKey(source)
      const to = normalizeChainKey(dest)
      if (!from || !to) return false
      const keys = new Set(chain.segments.map((segment) => normalizeChainKey(segment.sessionFile)))
      return keys.has(from) && keys.has(to)
    } catch {
      return false
    }
  }

  /** 打开目的会话实例（已存在时走 switch）。cwd 为空 = 崩溃恢复的兜底路径。 */
  private async openDestination(
    cwd: string,
    projectId: string | undefined,
    dest: string
  ): Promise<string | null> {
    const opened = await this.deps.openSession({
      cwd,
      ...(projectId ? { projectId } : {}),
      sessionFile: dest
    })
    return opened.ok ? (opened.runId ?? null) : null
  }

  /** 回源：把视图交还源会话（交接失败时 §8 第 7 条的唯一出口）。 */
  private async reopenSource(sourceSession: string, cwd: string): Promise<void> {
    if (!sourceSession) return
    await this.deps.openSession({ cwd, sessionFile: sourceSession }).catch(() => undefined)
  }

  /** 明确的失败：记 `failed` + 回源（未提交回源）。 */
  private async fail(input: HandoffCommitInput, reason: string): Promise<HandoffCommitResult> {
    const moved = await this.deps.transactions.step(input.handoffId, 'failed', reason)
    this.deps.notify(`交接没有完成：${reason}（源会话保留，工作没丢）`, 'warning')
    return {
      ok: false,
      stage: moved.tx?.stage ?? 'failed',
      destinationSession: moved.tx?.destinationSession ?? null,
      error: reason
    }
  }

  /**
   * 中途停住：不是失败，但也没完成（发送失败 / 证据未到）。
   *
   * `committed` 留在日志里，下次启动恢复会按证据决定重发还是补记；
   * 所以这里**不能**记 `failed` —— 那会把「其实已经发出去了」的一次交接判死。
   */
  private midway(_input: HandoffCommitInput, dest: string, reason: string): HandoffCommitResult {
    this.deps.notify(reason, 'warning')
    return { ok: false, stage: 'committed', destinationSession: dest, error: reason }
  }
}

/** 一句可读摘要（日志 / 探针）。 */
export function resumeSummary(pkg: HandoffPackage | null, resumeId: string): string {
  return `${resumeMarker(resumeId)} · ${pkg ? resumePreview(pkg.goal, 80) : '（无包）'}`
}
