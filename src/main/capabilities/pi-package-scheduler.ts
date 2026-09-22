import type { AcquisitionTransaction, PiPackageActivationTarget } from '../../shared/acquisition'
import { AcquisitionService } from './acquisition-service'

export type PiPackageGrant = { allowLifecycleScripts: boolean }
export type PiPackageRunnerSnapshot = {
  id: string
  generation: number
  cwd: string
  sessionFile: string | null
  projectId: string | null
  ready: boolean
  busy: boolean
}
export type PiPackageCheck = { ok: boolean; problems: string[] }
export type PiPackageInstallCheck = PiPackageCheck & { installed: boolean; path?: string }

export interface PiPackageSchedulerPorts {
  authorization(tx: AcquisitionTransaction): Promise<PiPackageGrant | null>
  isTrusted(cwd: string): Promise<boolean>
  sourceHead(cwd: string): Promise<string | null>
  goalSnapshot(target: PiPackageActivationTarget): Promise<{ goalId: string; revision: number; active: boolean }>
  runner(target: PiPackageActivationTarget): Promise<PiPackageRunnerSnapshot | null>
  cwdBusy(cwd: string): boolean
  verifyStaged(tx: AcquisitionTransaction): Promise<PiPackageCheck>
  verifyInstalled(tx: AcquisitionTransaction): Promise<PiPackageInstallCheck>
  smoke(tx: AcquisitionTransaction): Promise<PiPackageCheck>
  install(tx: AcquisitionTransaction, grant: PiPackageGrant): Promise<{ ok: boolean; error?: string }>
  restartRunner(target: PiPackageActivationTarget, runner: PiPackageRunnerSnapshot): Promise<{ ok: boolean; error?: string }>
  verifyActive(tx: AcquisitionTransaction): Promise<PiPackageCheck>
  writeContinuation(tx: AcquisitionTransaction, runner: PiPackageRunnerSnapshot): Promise<void>
  clearContinuation(tx: AcquisitionTransaction, runner?: PiPackageRunnerSnapshot | null): Promise<void>
  continuationConsumed(tx: AcquisitionTransaction, runner: PiPackageRunnerSnapshot): Promise<boolean>
}

export type PiPackageScheduleResult = {
  operationId: string
  state: AcquisitionTransaction['state'] | 'deferred'
  detail: string
}

function sameCwd(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() ===
    b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * Consumes durable `pending-boundary` npm pi-package transactions only when the
 * original project, goal snapshot, grant, trust and idle runner still match.
 * Every external effect is behind a port so crash/replay branches are testable
 * without installing or executing a real package.
 */
export class PiPackageActivationScheduler {
  private readonly inFlight = new Map<string, Promise<PiPackageScheduleResult>>()
  private readonly cwdTails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly service: AcquisitionService,
    private readonly ports: PiPackageSchedulerPorts
  ) {}

  async tick(): Promise<PiPackageScheduleResult[]> {
    const transactions = await this.service.list()
    const actionable = transactions.filter((tx) =>
      !!tx.piPackageTarget &&
      (tx.state === 'pending-boundary' || tx.state === 'acquiring' || tx.state === 'verifying' || tx.state === 'activated')
    )
    return Promise.all(actionable.map((tx) => this.schedule(tx.operationId)))
  }

  schedule(operationId: string): Promise<PiPackageScheduleResult> {
    const pending = this.inFlight.get(operationId)
    if (pending) return pending
    const work = this.enqueueByCwd(operationId).catch(async (error): Promise<PiPackageScheduleResult> => {
      return {
        operationId,
        /* Keep exceptions retryable and visible; the durable state may already
         * be `activated`, but the post-activation boundary is not complete. */
        state: 'deferred',
        detail: `调度步骤异常，保持事务现场等待复核：${error instanceof Error ? error.message : String(error)}`
      }
    }).finally(() => {
      if (this.inFlight.get(operationId) === work) this.inFlight.delete(operationId)
    })
    this.inFlight.set(operationId, work)
    return work
  }

  private async enqueueByCwd(operationId: string): Promise<PiPackageScheduleResult> {
    const initial = await this.service.get(operationId)
    const cwd = initial?.piPackageTarget?.cwd
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

  private async run(operationId: string): Promise<PiPackageScheduleResult> {
    let tx = await this.service.get(operationId)
    if (!tx) return { operationId, state: 'deferred', detail: '事务已不存在' }
    const target = tx.piPackageTarget
    if (!target || !['pending-boundary', 'acquiring', 'verifying', 'activated'].includes(tx.state)) {
      return { operationId, state: tx.state, detail: '事务没有可消费的 pi 包激活目标' }
    }

    const blocked = await this.preflight(target)
    if (blocked) return { operationId, state: 'deferred', detail: blocked }
    const grant = await this.ports.authorization(tx)
    if (!grant) return { operationId, state: 'deferred', detail: '精确候选 / 指纹 / 项目授权已撤销或不可读' }

    if (tx.state === 'pending-boundary') {
      const staged = await this.ports.verifyStaged(tx)
      if (!staged.ok) return this.fail(tx, `staging 复核失败：${staged.problems.join('；')}`)
      tx = await this.service.markAcquiring(operationId, '目标 runner 空闲，开始隔离验证与项目级安装')
    }

    if (tx.state === 'acquiring') {
      const smoke = await this.ports.smoke(tx)
      if (!smoke.ok) return this.fail(tx, `隔离 smoke 未通过：${smoke.problems.join('；')}`)
      tx = await this.service.markVerifying(operationId, '隔离 smoke 通过，复核后执行固定版本项目级安装')
    }

    if (tx.state === 'verifying') {
      const latestBlock = await this.preflight(target)
      if (latestBlock) return { operationId, state: 'deferred', detail: latestBlock }
      const currentGrant = await this.ports.authorization(tx)
      if (!currentGrant) return { operationId, state: 'deferred', detail: '安装前精确授权复核未通过' }

      let installed = await this.ports.verifyInstalled(tx)
      if (!installed.ok) return this.fail(tx, `安装清单无法复核：${installed.problems.join('；')}`)
      if (!installed.installed) {
        const install = await this.ports.install(tx, currentGrant)
        if (!install.ok) return this.fail(tx, install.error ?? 'pi install 失败')
        installed = await this.ports.verifyInstalled(tx)
        if (!installed.ok || !installed.installed || !installed.path) {
          return this.fail(tx, `pi install 后没有确认固定包名 / 版本：${installed.problems.join('；')}`)
        }
      }
      if (!installed.path) return this.fail(tx, '项目包清单没有返回可登记的安装路径')

      const activated = await this.service.activate({
        operationId,
        receipt: {
          planId: tx.planId,
          planRevision: tx.planRevision,
          candidateId: tx.candidateId,
          digest: tx.digest,
          scope: 'project-managed',
          projectId: tx.projectId,
          installedPaths: [installed.path],
          verification: 'smoke-passed'
        },
        verify: async () => {
          const [stagedCheck, installedCheck] = await Promise.all([
            this.ports.verifyStaged(tx!),
            this.ports.verifyInstalled(tx!)
          ])
          return {
            ok: stagedCheck.ok && installedCheck.ok && installedCheck.installed,
            problems: [...stagedCheck.problems, ...installedCheck.problems]
          }
        }
      })
      tx = activated
    }

    if (tx.state !== 'activated') return { operationId, state: tx.state, detail: '未进入激活后恢复阶段' }
    const finalBlock = await this.preflight(target)
    if (finalBlock) return { operationId, state: 'deferred', detail: finalBlock }
    const finalGrant = await this.ports.authorization(tx)
    if (!finalGrant) return { operationId, state: 'deferred', detail: '激活后精确授权复核未通过，暂不重启或续接' }

    let runner = await this.ports.runner(target)
    if (!runner || !this.matchesTargetRunner(runner, target)) {
      return { operationId, state: 'deferred', detail: '原 runner / 会话没有按持久身份恢复' }
    }
    if (this.ports.cwdBusy(target.cwd)) return { operationId, state: 'deferred', detail: '目标项目仍有 runner 忙碌' }

    /*
     * Runner ids and generations are process-local. After an app restart the
     * exact session can be recovered under a new id/generation, so loaded-state
     * evidence takes precedence over comparing it with the old process counter.
     */
    let active = await this.ports.verifyActive(tx)
    let consumed = await this.ports.continuationConsumed(tx, runner)
    const alreadyRestarted = runner.generation > target.runnerGeneration
    const resumeNeedsKick = !consumed
    /* Do not restart again while the thin layer's one-shot continuation is
     * waiting for its idle confirmation; a second reload resets that timer. */
    const needsRestart = !alreadyRestarted && (!active.ok || resumeNeedsKick)
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

    if (!active.ok) return this.fail(tx, `重载后运行时验证失败：${active.problems.join('；')}`)
    const resumeCheck = await this.service.resumeCheck({
      operationId,
      expected: { planId: tx.planId, planRevision: tx.planRevision, digest: tx.digest },
      verify: () => this.ports.verifyActive(tx!)
    })
    if (!resumeCheck.ok) return this.fail(tx, `恢复复核失败：${resumeCheck.reasons.join('；')}`)
    const resumedRunner = await this.ports.runner(target)
    if (!resumedRunner || !this.matchesTargetRunner(resumedRunner, target)) {
      return { operationId, state: 'deferred', detail: '续接消费后原会话身份尚未恢复' }
    }
    if (!(await this.ports.continuationConsumed(tx, resumedRunner))) {
      return { operationId, state: 'deferred', detail: '运行时已重载；等待薄层一次性续接消费证据' }
    }
    const resumed = await this.service.markResumed(operationId, `receipt、运行时技能与 continueId=${target.continueId} 消费证据均已复核`)
    return { operationId, state: resumed.state, detail: '原目标续接已消费一次' }
  }

  private async preflight(target: PiPackageActivationTarget): Promise<string | null> {
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
    if (!runner || !this.matchesTargetRunner(runner, target)) {
      return '原 runner、项目或会话身份尚未恢复'
    }
    if (!runner.ready) return '目标 pi runner 尚未 ready'
    if (runner.busy || this.ports.cwdBusy(target.cwd)) return '等待目标项目全部 runner 空闲'
    return null
  }

  private matchesTargetRunner(
    runner: PiPackageRunnerSnapshot,
    target: PiPackageActivationTarget
  ): boolean {
    return sameCwd(runner.cwd, target.cwd) &&
      runner.sessionFile === target.sessionFile &&
      runner.projectId === target.projectId &&
      Number.isSafeInteger(runner.generation) && runner.generation > 0
  }

  private async fail(tx: AcquisitionTransaction, detail: string): Promise<PiPackageScheduleResult> {
    const failed = await this.service.fail(tx.operationId, detail)
    const runner = tx.piPackageTarget ? await this.ports.runner(tx.piPackageTarget).catch(() => null) : null
    await this.ports.clearContinuation(tx, runner).catch(() => undefined)
    return { operationId: tx.operationId, state: failed.state, detail }
  }
}
