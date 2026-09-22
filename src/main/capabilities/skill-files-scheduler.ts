import type { AcquisitionTransaction, SkillFilesActivationTarget } from '../../shared/acquisition'
import type { SkillSecurityReview } from '../../shared/skill-security'
import { AcquisitionService } from './acquisition-service'
import type { PiPackageCheck, PiPackageGrant, PiPackageRunnerSnapshot } from './pi-package-scheduler'

export type SkillFilesCheck = PiPackageCheck & { paths?: string[]; securityReview?: SkillSecurityReview }

export interface SkillFilesSchedulerPorts {
  authorization(tx: AcquisitionTransaction): Promise<PiPackageGrant | null>
  isTrusted(cwd: string): Promise<boolean>
  sourceHead(cwd: string): Promise<string | null>
  goalSnapshot(target: SkillFilesActivationTarget): Promise<{ goalId: string; revision: number; active: boolean }>
  runner(target: SkillFilesActivationTarget): Promise<PiPackageRunnerSnapshot | null>
  cwdBusy(cwd: string): boolean
  verifyStaged(tx: AcquisitionTransaction): Promise<PiPackageCheck>
  activateFiles(tx: AcquisitionTransaction): Promise<SkillFilesCheck>
  verifyFiles(tx: AcquisitionTransaction): Promise<SkillFilesCheck>
  verifyActive(tx: AcquisitionTransaction): Promise<SkillFilesCheck>
  restartRunner(target: SkillFilesActivationTarget, runner: PiPackageRunnerSnapshot): Promise<{ ok: boolean; error?: string }>
  writeContinuation(tx: AcquisitionTransaction, runner: PiPackageRunnerSnapshot): Promise<void>
  clearContinuation(tx: AcquisitionTransaction, runner?: PiPackageRunnerSnapshot | null): Promise<void>
  continuationConsumed(tx: AcquisitionTransaction, runner: PiPackageRunnerSnapshot): Promise<boolean>
}

export type SkillFilesScheduleResult = {
  operationId: string
  state: AcquisitionTransaction['state'] | 'deferred'
  detail: string
}

function sameCwd(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() ===
    b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * Safe-boundary consumer for project Skill files. It deliberately shares the
 * pi-package runner/goal gates but never runs package code or lifecycle hooks.
 */
export class SkillFilesActivationScheduler {
  private readonly inFlight = new Map<string, Promise<SkillFilesScheduleResult>>()
  private readonly cwdTails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly service: AcquisitionService,
    private readonly ports: SkillFilesSchedulerPorts
  ) {}

  async tick(): Promise<SkillFilesScheduleResult[]> {
    const transactions = await this.service.list()
    const actionable = transactions.filter((tx) =>
      !!tx.skillFilesTarget &&
      (tx.state === 'pending-boundary' || tx.state === 'acquiring' || tx.state === 'verifying' || tx.state === 'activated')
    )
    return Promise.all(actionable.map((tx) => this.schedule(tx.operationId)))
  }

  schedule(operationId: string): Promise<SkillFilesScheduleResult> {
    const pending = this.inFlight.get(operationId)
    if (pending) return pending
    const work = this.enqueueByCwd(operationId).catch(async (error): Promise<SkillFilesScheduleResult> => {
      return {
        operationId,
        /* An exception after activation is still an unfinished boundary step.
         * Returning the durable state here used to make `activated` look final
         * and hid the retry reason from the host log. */
        state: 'deferred',
        detail: `调度步骤异常，保持事务现场等待复核：${error instanceof Error ? error.message : String(error)}`
      }
    }).finally(() => {
      if (this.inFlight.get(operationId) === work) this.inFlight.delete(operationId)
    })
    this.inFlight.set(operationId, work)
    return work
  }

  private async enqueueByCwd(operationId: string): Promise<SkillFilesScheduleResult> {
    const initial = await this.service.get(operationId)
    const cwd = initial?.skillFilesTarget?.cwd
    if (!cwd) return this.run(operationId)
    const key = cwd.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const previous = this.cwdTails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.run(operationId))
    const tail = current.then(() => undefined, () => undefined)
    this.cwdTails.set(key, tail)
    try {
      return await current
    } finally {
      if (this.cwdTails.get(key) === tail) this.cwdTails.delete(key)
    }
  }

  private async run(operationId: string): Promise<SkillFilesScheduleResult> {
    let tx = await this.service.get(operationId)
    if (!tx) return { operationId, state: 'deferred', detail: '事务已不存在' }
    const target = tx.skillFilesTarget
    if (!target || !['pending-boundary', 'acquiring', 'verifying', 'activated'].includes(tx.state)) {
      return { operationId, state: tx.state, detail: '事务没有可消费的 Skill 文件激活目标' }
    }

    const blocked = await this.preflight(target)
    if (blocked) return { operationId, state: 'deferred', detail: blocked }
    if (!(await this.ports.authorization(tx))) {
      return { operationId, state: 'deferred', detail: '精确候选 / 指纹 / 项目授权已撤销或不可读' }
    }

    if (tx.state === 'pending-boundary') {
      const staged = await this.ports.verifyStaged(tx)
      if (!staged.ok) return this.fail(tx, `staging 复核失败：${staged.problems.join('；')}`)
      tx = await this.service.markAcquiring(operationId, '目标 runner 空闲，开始项目 Skill 文件激活')
    }

    let securityReview: SkillSecurityReview | undefined
    if (tx.state === 'acquiring') {
      const activatedFiles = await this.ports.activateFiles(tx)
      if (!activatedFiles.ok) return this.fail(tx, `Skill 文件激活失败：${activatedFiles.problems.join('；')}`, activatedFiles.securityReview)
      securityReview = activatedFiles.securityReview
      tx = await this.service.markVerifying(operationId, '项目 Skill 文件已写入受管 active 目录，开始复核')
    }

    if (tx.state === 'verifying') {
      const files = await this.ports.verifyFiles(tx)
      if (!files.ok || !files.paths?.length) {
        return this.fail(tx, `Skill 文件 active 复核失败：${files.problems.join('；') || '没有可用 Skill 文件'}`, files.securityReview)
      }
      securityReview = files.securityReview ?? securityReview
      tx = await this.service.activate({
        operationId,
        receipt: {
          planId: tx.planId,
          planRevision: tx.planRevision,
          candidateId: tx.candidateId,
          digest: tx.digest,
          scope: 'project-managed',
          projectId: tx.projectId,
          installedPaths: files.paths,
          verification: 'files-present',
          ...(securityReview ? { securityReview } : {})
        },
        verify: async () => {
          const checked = await this.ports.verifyFiles(tx!)
          return { ok: checked.ok, problems: checked.problems }
        }
      })
    }

    if (tx.state !== 'activated') return { operationId, state: tx.state, detail: '未进入激活后恢复阶段' }
    const finalBlock = await this.preflight(target)
    if (finalBlock) return { operationId, state: 'deferred', detail: finalBlock }
    if (!(await this.ports.authorization(tx))) {
      return { operationId, state: 'deferred', detail: '激活后精确授权复核未通过，暂不重启或续接' }
    }

    let runner = await this.ports.runner(target)
    if (!runner || !this.matchesTargetRunner(runner, target)) {
      return { operationId, state: 'deferred', detail: '原 runner / 会话没有按持久身份恢复' }
    }
    if (this.ports.cwdBusy(target.cwd)) return { operationId, state: 'deferred', detail: '目标项目仍有 runner 忙碌' }

    let active = await this.ports.verifyActive(tx)
    let consumed = await this.ports.continuationConsumed(tx, runner)
    const alreadyRestarted = runner.generation > target.runnerGeneration
    /* One reload is enough. Give the thin layer time to pass its idle
     * confirmation; repeatedly replacing the runner here resets that timer and
     * makes continuation consumption impossible. */
    const needsRestart = !alreadyRestarted && (!active.ok || !consumed)
    if (needsRestart) {
      const beforeGeneration = runner.generation
      await this.ports.writeContinuation(tx, runner)
      const restarted = await this.ports.restartRunner(target, runner)
      if (!restarted.ok) {
        await this.ports.clearContinuation(tx, runner)
        return { operationId, state: 'deferred', detail: restarted.error ?? '目标 runner 重载失败，可在下一安全边界重试' }
      }
      runner = await this.ports.runner(target)
      if (!runner || !this.matchesTargetRunner(runner, target) || runner.generation <= beforeGeneration) {
        return { operationId, state: 'deferred', detail: 'runner 重载结果未能证明代次与原会话已恢复' }
      }
      active = await this.ports.verifyActive(tx)
      consumed = await this.ports.continuationConsumed(tx, runner)
    }

    if (!active.ok) return this.fail(tx, `重载后运行时验证失败：${active.problems.join('；')}`, active.securityReview)
    const resumeCheck = await this.service.resumeCheck({
      operationId,
      expected: { planId: tx.planId, digest: tx.digest, planRevision: tx.planRevision },
      verify: () => this.ports.verifyFiles(tx!)
    })
    if (!resumeCheck.ok) return this.fail(tx, `恢复复核失败：${resumeCheck.reasons.join('；')}`)
    const resumedRunner = await this.ports.runner(target)
    if (!resumedRunner || !this.matchesTargetRunner(resumedRunner, target)) {
      return { operationId, state: 'deferred', detail: '续接消费后原会话身份尚未恢复' }
    }
    if (!(await this.ports.continuationConsumed(tx, resumedRunner))) {
      return { operationId, state: 'deferred', detail: '运行时已重载；等待薄层一次性续接消费证据' }
    }
    const resumed = await this.service.markResumed(operationId, `receipt、Skill 文件与 continueId=${target.continueId} 消费证据均已复核`)
    return { operationId, state: resumed.state, detail: '原目标续接已消费一次' }
  }

  private async preflight(target: SkillFilesActivationTarget): Promise<string | null> {
    if (!(await this.ports.isTrusted(target.cwd))) return 'Pi 项目持久信任不存在；保持待处理，不使用 --approve 覆盖'
    const [sourceHead, goal, runner] = await Promise.all([
      this.ports.sourceHead(target.cwd),
      this.ports.goalSnapshot(target),
      this.ports.runner(target)
    ])
    if (sourceHead !== target.sourceHead) return '项目 sourceHead 已变化，原接入计划失效'
    if (goal.goalId !== target.goalId || goal.revision !== target.goalRevision || !goal.active) {
      return '原目标身份 / 修订已变化或已结束，拒绝续接到新目标'
    }
    if (!runner || !this.matchesTargetRunner(runner, target)) return '原 runner、项目或会话身份尚未恢复'
    if (!runner.ready) return '目标 pi runner 尚未 ready'
    if (runner.busy || this.ports.cwdBusy(target.cwd)) return '等待目标项目全部 runner 空闲'
    return null
  }

  private matchesTargetRunner(runner: PiPackageRunnerSnapshot, target: SkillFilesActivationTarget): boolean {
    return sameCwd(runner.cwd, target.cwd) &&
      runner.sessionFile === target.sessionFile &&
      runner.projectId === target.projectId &&
      Number.isSafeInteger(runner.generation) && runner.generation > 0
  }

  private async fail(
    tx: AcquisitionTransaction,
    detail: string,
    securityReview?: SkillSecurityReview
  ): Promise<SkillFilesScheduleResult> {
    const failed = securityReview
      ? await this.service.fail(tx.operationId, detail, new Date().toISOString(), securityReview)
      : await this.service.fail(tx.operationId, detail)
    const runner = tx.skillFilesTarget ? await this.ports.runner(tx.skillFilesTarget).catch(() => null) : null
    await this.ports.clearContinuation(tx, runner).catch(() => undefined)
    return { operationId: tx.operationId, state: failed.state, detail }
  }
}
