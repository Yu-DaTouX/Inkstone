import type { HandoffPackage } from '../shared/handoff'
import {
  buildResumeText,
  containsResumeEvidence,
  hasExplicitHandoffStartReceipt,
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

export const RESUME_EVIDENCE_TIMEOUT_MS = 20_000
const RESUME_EVIDENCE_POLL_MS = 400

export interface HandoffSessionTarget {
  cwd: string
  projectId?: string
  sessionFile?: string
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
  stopRunner: (runId: string) => Promise<boolean>
  openSession: (target: HandoffSessionTarget) => Promise<HandoffSessionHandle>
  send: (runId: string, text: string, resumeId: string) => Promise<{ ok: boolean; error?: string }>
  readSessionText: (sessionFile: string) => Promise<string | null>
  notify: (message: string, type: 'info' | 'warning' | 'error') => void
  shouldActivate?: (sourceRunId: string) => boolean
  onDestinationReady?: (info: {
    sessionFile: string
    runId: string
    sourceSession: string
  }) => Promise<void>
  onLinked?: (sourceRunId: string, destinationRunId: string) => Promise<void>
  now?: () => number
  pollEvidence?: (probe: () => Promise<boolean>, timeoutMs: number) => Promise<boolean>
}

export interface HandoffCommitInput {
  handoffId: string
  sourceRunId: string
  sourceSession: string
  cwd: string
  projectId?: string
  pkg: HandoffPackage
  evidenceTimeoutMs?: number
  canContinue?: () => boolean
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

    if (tx.stage === 'destination-created' && tx.destinationSession) {
      return this.finishCommit(input, tx)
    }

    const activate = this.deps.shouldActivate?.(input.sourceRunId) ?? true
    if (input.canContinue?.() === false) return this.fail(input, '交接已取消')
    const stopped = await this.deps.stopRunner(input.sourceRunId)
    if (!stopped) {
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, '源运行实例未能停止，已取消交接')
    }
    const opened = await this.deps.openSession({
      cwd: input.cwd,
      activate,
      ...(input.projectId ? { projectId: input.projectId } : {})
    })
    if (!opened.ok || !opened.sessionFile || !opened.runId) {
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, opened.error ?? '目的会话没能建起来')
    }

    if (input.canContinue?.() === false) {
      await this.deps.stopRunner(opened.runId)
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, '交接已取消')
    }
    const attachedDest = await transactions.setDestination(input.handoffId, opened.sessionFile)
    if (!attachedDest.ok || !attachedDest.tx) {
      await this.deps.stopRunner(opened.runId)
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, `目的会话没能记进事务日志（${attachedDest.reason}）`)
    }
    const created = await transactions.step(input.handoffId, 'destination-created', 'destination-opened')
    if (!created.advanced || !created.tx) {
      await this.deps.stopRunner(opened.runId)
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, `目的会话阶段没能落盘（${created.reason}）`)
    }
    if (this.deps.onDestinationReady) {
      await this.deps
        .onDestinationReady({ sessionFile: opened.sessionFile, runId: opened.runId, sourceSession: input.sourceSession })
        .catch(() => undefined)
    }
    return this.finishCommit(input, created.tx, opened.runId)
  }

  private async finishCommit(
    input: HandoffCommitInput,
    tx: HandoffTransaction,
    knownRunId?: string
  ): Promise<HandoffCommitResult> {
    const dest = tx.destinationSession
    if (!dest) return this.fail(input, '没有目的会话，无法提交')

    if (!(await this.ensureLinked(input.sourceSession, dest, input.handoffId))) {
      if (knownRunId) await this.deps.stopRunner(knownRunId)
      await this.reopenSource(input.sourceSession, input.cwd)
      return this.fail(input, '会话链没写成（前端会出现两条会话）')
    }

    if (tx.stage === 'destination-created') {
      const committed = await this.deps.transactions.step(input.handoffId, 'committed', 'chain-linked')
      if (!committed.advanced || !committed.tx) return this.fail(input, `提交阶段没能落盘（${committed.reason}）`)
      tx = committed.tx
    }

    if (knownRunId) await this.deps.onLinked?.(input.sourceRunId, knownRunId)

    if (await this.hasEvidence(dest, tx.resumeId)) {
      await this.noteResumeReceipts(input.handoffId, dest, tx.resumeId)
      const done = await this.deps.transactions.step(input.handoffId, 'resumed', 'evidence-found')
      if (done.tx) tx = done.tx
      this.deps.notify('上下文已整理，续接记录已确认。', 'info')
      return { ok: true, stage: tx.stage, destinationSession: dest }
    }

    const runId = knownRunId ?? (await this.openDestination(input.cwd, input.projectId, dest))
    if (!runId) return this.midway(input, dest, '目的实例没能打开，resume 未发送（下次启动会重试）')

    if (input.canContinue?.() === false) return this.fail(input, '交接已暂停，不发送续接')
    await this.deps.transactions.noteResumeAttempt(input.handoffId)
    const text = buildResumeText(tx.package, tx.resumeId)
    if (input.canContinue?.() === false) return this.fail(input, '交接已暂停，不发送续接')
    const sent = await this.deps.send(runId, text, tx.resumeId)
    if (!sent.ok) return this.midway(input, dest, `resume 发送失败：${sent.error ?? '未知原因'}`)

    const confirmed = await this.poll(
      () => this.hasEvidence(dest, tx.resumeId),
      input.evidenceTimeoutMs ?? RESUME_EVIDENCE_TIMEOUT_MS
    )
    if (!confirmed) {
      return this.midway(input, dest, 'resume 已发出，但还没在会话文件里看到证据（下次启动会核对，不重发）')
    }
    await this.noteResumeReceipts(input.handoffId, dest, tx.resumeId)
    const done = await this.deps.transactions.step(input.handoffId, 'resumed', 'evidence-found')
    if (done.tx) tx = done.tx
    this.deps.notify(`上下文已整理，正在继续当前任务：${resumePreview(text)}`, 'info')
    return { ok: true, stage: tx.stage, destinationSession: dest }
  }

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
        const linked = await this.ensureLinked(tx.sourceSession, dest, tx.handoffId)
        if (!linked || !tx.package) {
          const moved = await transactions.step(tx.handoffId, 'failed', 'recovered:chain-missing')
          await this.reopenSource(tx.sourceSession, '')
          out.push({ handoffId: tx.handoffId, action: 'abandon', stage: moved.tx?.stage ?? tx.stage })
          continue
        }
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
      await this.reopenSource(tx.sourceSession, '')
      out.push({ handoffId: tx.handoffId, action: 'abandon', stage: moved.tx?.stage ?? tx.stage })
    }
    return out
  }

  private async hasEvidence(sessionFile: string, resumeId: string): Promise<boolean> {
    const text = await this.deps.readSessionText(sessionFile).catch(() => null)
    return containsResumeEvidence(text, resumeId)
  }

  private async noteResumeReceipts(handoffId: string, dest: string, resumeId: string): Promise<void> {
    await this.deps.transactions.noteReceipt(handoffId, 'persisted')
    const text = await this.deps.readSessionText(dest).catch(() => null)
    if (hasExplicitHandoffStartReceipt(text, resumeId)) {
      await this.deps.transactions.noteReceipt(handoffId, 'started')
    }
  }

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

  private async reopenSource(sourceSession: string, cwd: string): Promise<void> {
    if (!sourceSession) return
    await this.deps.openSession({ cwd, sessionFile: sourceSession }).catch(() => undefined)
  }

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

  private midway(_input: HandoffCommitInput, dest: string, reason: string): HandoffCommitResult {
    this.deps.notify(reason, 'warning')
    return { ok: false, stage: 'committed', destinationSession: dest, error: reason }
  }
}

export function resumeSummary(pkg: HandoffPackage | null, resumeId: string): string {
  return `${resumeMarker(resumeId)} · ${pkg ? resumePreview(pkg.goal, 80) : '（无包）'}`
}
