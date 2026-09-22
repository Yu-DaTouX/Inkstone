import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PiPackageActivationTarget } from '../../shared/acquisition'
import { goalContinueSummary, isActiveGoalPhase } from '../../shared/goal'
import { formatSkillSecurityReview } from '../../shared/skill-security'
import { GoalStore, clearGoalResumeSnapshotIfOperation, goalResumeContinuationWasConsumed, writeGoalResumeSnapshotIfVacant } from '../goal-service'
import type { PackageListing } from '../packages'
import type { AgentController } from '../agent'
import { AcquisitionService, stagingDirOf } from './acquisition-service'
import { PackageAuthorizationService } from './package-authorization-service'
import { reviewPiPackageSkills } from './pi-package-smoke'
import type { PiPackageCheck, PiPackageInstallCheck, PiPackageRunnerSnapshot, PiPackageSchedulerPorts } from './pi-package-scheduler'

export type PiPackageActivationHostDeps = {
  root: string
  agentDir: string
  service: AcquisitionService
  authorizations: PackageAuthorizationService
  goals: GoalStore
  runners: {
    activationSnapshot(target: PiPackageActivationTarget): PiPackageRunnerSnapshot | null
    agentOf(id: string): AgentController | null
    restartOne(id: string): Promise<{ ok: boolean; error?: string }>
    hasBusyCwd(cwd: string): boolean
  }
  isTrusted(cwd: string): Promise<boolean>
  sourceHead(cwd: string): Promise<string | null>
  listPackages(cwd: string, agentDir: string): PackageListing
  install(input: {
    sourceDir: string
    managedRoot: string
    cwd: string
    name: string
    version: string
    allowLifecycleScripts: boolean
  }): Promise<{ ok: boolean; error?: string; detail?: string }>
  smoke(tx: Parameters<PiPackageSchedulerPorts['smoke']>[0]): Promise<PiPackageCheck>
}

function within(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path)) return false
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function failed(problems: string[]): PiPackageInstallCheck {
  return { ok: false, installed: false, problems }
}

function installedPackage(
  deps: PiPackageActivationHostDeps,
  target: PiPackageActivationTarget
): PiPackageInstallCheck {
  const listing = deps.listPackages(target.cwd, deps.agentDir)
  if (!listing.ok) return failed([listing.error ?? 'Pi 项目包清单无法读取'])
  const match = listing.entries.find((entry) =>
    entry.scope === 'project' && entry.name === target.packageName &&
    entry.version === target.packageVersion && entry.installed && !!entry.path
  )
  return match?.path
    ? { ok: true, installed: true, path: match.path, problems: [] }
    : { ok: true, installed: false, problems: [`项目包清单未确认 ${target.packageName}@${target.packageVersion}`] }
}

/** Build the production adapters while keeping scheduling policy independently testable. */
export function createPiPackageActivationHostPorts(deps: PiPackageActivationHostDeps): PiPackageSchedulerPorts {
  const runner = async (target: PiPackageActivationTarget) => deps.runners.activationSnapshot(target)

  const verifyActive = async (tx: Parameters<PiPackageSchedulerPorts['verifyActive']>[0]): Promise<PiPackageCheck> => {
    const target = tx.piPackageTarget
    if (!target) return { ok: false, problems: ['事务没有绑定 pi 包激活目标'] }
    const installed = installedPackage(deps, target)
    if (!installed.ok || !installed.installed || !installed.path) return {
      ok: false,
      problems: installed.problems.length ? installed.problems : ['项目包尚未安装']
    }
    try {
      const manifest = JSON.parse(await readFile(join(installed.path, 'package.json'), 'utf8')) as unknown
      const skillReview = await reviewPiPackageSkills(installed.path, manifest)
      if (!skillReview.ok) return { ok: false, problems: [formatSkillSecurityReview(skillReview)] }
    } catch (error) {
      return { ok: false, problems: [error instanceof Error ? error.message : String(error)] }
    }
    const activeRunner = await runner(target)
    if (!activeRunner || !activeRunner.ready || !activeRunner.sessionFile) {
      return { ok: false, problems: ['目标 pi runner 尚未 ready 或未载入绑定会话'] }
    }
    const agent = deps.runners.agentOf(activeRunner.id)
    if (!agent || agent.getState()?.sessionFile !== target.sessionFile) {
      return { ok: false, problems: ['当前 runner 与持久会话文件不一致'] }
    }
    const packagePaths = await agent.runtimeCommandPaths()
    const found = packagePaths.some((path) => within(installed.path!, path))
    return found
      ? { ok: true, problems: [] }
      : { ok: false, problems: ['pi 包已登记，但运行时命令 / Skill 清单未报告来自该包的资源'] }
  }

  return {
    authorization: (tx) => deps.authorizations.find({
      candidateId: tx.candidateId,
      digest: tx.digest,
      projectId: tx.projectId
    }),
    isTrusted: deps.isTrusted,
    sourceHead: deps.sourceHead,
    async goalSnapshot(target) {
      await deps.goals.load()
      const goal = deps.goals.state(target.sessionFile)
      return { goalId: goal.goalId, revision: goal.revision, active: isActiveGoalPhase(goal.phase) }
    },
    runner,
    cwdBusy: (cwd) => deps.runners.hasBusyCwd(cwd),
    verifyStaged: async (tx) => deps.service.verifyStaged(tx.operationId),
    verifyInstalled: async (tx) => {
      const target = tx.piPackageTarget
      return target ? installedPackage(deps, target) : failed(['事务没有绑定 pi 包激活目标'])
    },
    smoke: deps.smoke,
    async install(tx, grant) {
      const target = tx.piPackageTarget
      if (!target) return { ok: false, error: '事务没有绑定 pi 包激活目标' }
      const managedRoot = stagingDirOf(deps.root, tx.operationId)
      const result = await deps.install({
        sourceDir: resolve(managedRoot, 'payload', 'package'),
        managedRoot,
        cwd: target.cwd,
        name: target.packageName,
        version: target.packageVersion,
        allowLifecycleScripts: grant.allowLifecycleScripts
      })
      return result.ok ? { ok: true } : { ok: false, error: [result.error, result.detail].filter(Boolean).join('：') }
    },
    async restartRunner(target, snapshot) {
      const current = await runner(target)
      if (!current || current.id !== snapshot.id || current.busy || !current.ready) {
        return { ok: false, error: '重载前目标 runner 身份或空闲状态已变化' }
      }
      return deps.runners.restartOne(current.id)
    },
    verifyActive,
    async writeContinuation(tx, snapshot) {
      const target = tx.piPackageTarget
      if (!target) throw new Error('事务没有绑定 pi 包激活目标')
      await deps.goals.load()
      const goal = deps.goals.state(target.sessionFile)
      if (goal.goalId !== target.goalId || goal.revision !== target.goalRevision || !isActiveGoalPhase(goal.phase)) {
        throw new Error('续接前目标身份 / 修订已变化或目标已结束')
      }
      const pending = deps.goals.resumeOf(target.sessionFile)
      if (pending && pending.operationId !== target.continueId) {
        const pendingConsumed = await goalResumeContinuationWasConsumed(snapshot.id, pending.operationId, deps.root)
        if (!pendingConsumed) throw new Error('该会话另有尚未消费的目标续行，不能覆盖')
      }
      const written = await writeGoalResumeSnapshotIfVacant(snapshot.id, {
        operationId: target.continueId,
        at: Date.now(),
        summary: `${goalContinueSummary(goal, 1)}\n\n能力包已验证并激活，继续原目标。续接编号：${target.continueId}`,
        kind: 'continue'
      }, deps.root)
      if (!written) throw new Error('运行时续行槽已有另一条未消费请求，拒绝覆盖')
    },
    async clearContinuation(tx, snapshot) {
      const target = tx.piPackageTarget
      if (!target) return
      const resolved = snapshot ?? await runner(target)
      if (!resolved) return
      await clearGoalResumeSnapshotIfOperation(resolved.id, target.continueId, deps.root)
    },
    continuationConsumed: (tx, snapshot) => {
      const target = tx.piPackageTarget
      return target
        ? goalResumeContinuationWasConsumed(snapshot.id, target.continueId, deps.root)
        : Promise.resolve(false)
    }
  }
}
