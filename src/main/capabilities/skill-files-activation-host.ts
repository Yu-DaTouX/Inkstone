import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SkillFilesActivationTarget } from '../../shared/acquisition'
import { goalContinueSummary, isActiveGoalPhase } from '../../shared/goal'
import { formatSkillSecurityReview, reviewSkillFiles } from '../../shared/skill-security'
import { GoalStore, clearGoalResumeSnapshotIfOperation, goalResumeContinuationWasConsumed, writeGoalResumeSnapshotIfVacant } from '../goal-service'
import type { AgentController } from '../agent'
import { AcquisitionService } from './acquisition-service'
import { PackageAuthorizationService } from './package-authorization-service'
import { activateStagedSkillFiles, readActiveSkillFiles, reviewStagedSkillFiles, SkillSecurityError } from './skill-files'
import type { PiPackageRunnerSnapshot } from './pi-package-scheduler'
import type { SkillFilesCheck, SkillFilesSchedulerPorts } from './skill-files-scheduler'

export type SkillFilesActivationHostDeps = {
  root: string
  service: AcquisitionService
  authorizations: PackageAuthorizationService
  goals: GoalStore
  runners: {
    activationSnapshot(target: SkillFilesActivationTarget): PiPackageRunnerSnapshot | null
    agentOf(id: string): AgentController | null
    restartOne(id: string): Promise<{ ok: boolean; error?: string }>
    hasBusyCwd(cwd: string): boolean
  }
  isTrusted(cwd: string): Promise<boolean>
  sourceHead(cwd: string): Promise<string | null>
}

function within(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path)) return false
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/[\\/]+/g, '/').toLowerCase() === resolve(b).replace(/[\\/]+/g, '/').toLowerCase()
}

function failed(problems: string[], securityReview?: SkillFilesCheck['securityReview']): SkillFilesCheck {
  return { ok: false, problems, ...(securityReview ? { securityReview } : {}) }
}

/** Production ports for the Skill-file scheduler; all runner effects stay behind this adapter. */
export function createSkillFilesActivationHostPorts(deps: SkillFilesActivationHostDeps): SkillFilesSchedulerPorts {
  const runner = async (target: SkillFilesActivationTarget) => deps.runners.activationSnapshot(target)

  const verifyFiles = async (tx: Parameters<SkillFilesSchedulerPorts['verifyFiles']>[0]): Promise<SkillFilesCheck> => {
    const target = tx.skillFilesTarget
    if (!target) return failed(['事务没有绑定 Skill 文件激活目标'])
    let active: Awaited<ReturnType<typeof readActiveSkillFiles>>
    try {
      active = await readActiveSkillFiles(deps.root, tx.projectId)
    } catch (error) {
      if (error instanceof SkillSecurityError) return failed([formatSkillSecurityReview(error.review)], error.review)
      return failed([error instanceof Error ? error.message : String(error)])
    }
    if (active.length === 0) return failed(['项目 active 清单没有有效 Skill 文件'])
    const paths = active.map((skill) => skill.path)
    if (!paths.every((path) => within(resolve(deps.root, 'capabilities', 'active', tx.projectId), path))) {
      return failed(['active Skill 文件路径逃出受管目录'])
    }
    const review = reviewSkillFiles(await Promise.all(active.map(async (skill) => ({
      path: skill.relativePath,
      content: await readFile(skill.path)
    }))))
    if (!review.ok) return failed([formatSkillSecurityReview(review)], review)
    return { ok: true, problems: [], paths, securityReview: review }
  }

  const verifyActive = async (tx: Parameters<SkillFilesSchedulerPorts['verifyActive']>[0]): Promise<SkillFilesCheck> => {
    const files = await verifyFiles(tx)
    if (!files.ok || !files.paths) return files
    const target = tx.skillFilesTarget
    if (!target) return failed(['事务没有绑定 Skill 文件激活目标'])
    const activeRunner = await runner(target)
    if (!activeRunner || !activeRunner.ready || !activeRunner.sessionFile) return failed(['目标 pi runner 尚未 ready 或未载入绑定会话'])
    const agent = deps.runners.agentOf(activeRunner.id)
    if (!agent || agent.getState()?.sessionFile !== target.sessionFile) return failed(['当前 runner 与持久会话文件不一致'])
    const runtimePaths = await agent.runtimeCommandPaths()
    return files.paths.every((path) => runtimePaths.some((runtimePath) => samePath(runtimePath, path)))
      ? files
      : failed(['目标 runner 尚未报告全部项目 Skill 文件'])
  }

  return {
    authorization: (tx) => deps.authorizations.find({ candidateId: tx.candidateId, digest: tx.digest, projectId: tx.projectId }),
    isTrusted: deps.isTrusted,
    sourceHead: deps.sourceHead,
    async goalSnapshot(target) {
      await deps.goals.load()
      const goal = deps.goals.state(target.sessionFile)
      return { goalId: goal.goalId, revision: goal.revision, active: isActiveGoalPhase(goal.phase) }
    },
    runner,
    cwdBusy: (cwd) => deps.runners.hasBusyCwd(cwd),
    verifyStaged: (tx) => deps.service.verifyStaged(tx.operationId),
    async activateFiles(tx) {
      const target = tx.skillFilesTarget
      if (!target) return failed(['事务没有绑定 Skill 文件激活目标'])
      try {
        const staged = await deps.service.verifyStaged(tx.operationId)
        if (!staged.ok) return failed([`Skill staging 复核失败：${staged.problems.join('；')}`])
        const securityReview = await reviewStagedSkillFiles(deps.root, tx.operationId)
        if (!securityReview.ok) return failed([formatSkillSecurityReview(securityReview)], securityReview)
        const skills = await activateStagedSkillFiles(deps.root, {
          operationId: tx.operationId,
          candidateId: tx.candidateId,
          projectId: tx.projectId
        }, securityReview)
        return {
          ok: skills.length > 0,
          problems: skills.length > 0 ? [] : ['没有可激活的 Skill 文件'],
          paths: skills.map((skill) => skill.path),
          securityReview
        }
      } catch (error) {
        return failed([error instanceof Error ? error.message : String(error)])
      }
    },
    verifyFiles,
    verifyActive,
    async restartRunner(target, snapshot) {
      const current = await runner(target)
      if (!current || current.id !== snapshot.id || current.busy || !current.ready) return { ok: false, error: '重载前目标 runner 身份或空闲状态已变化' }
      return deps.runners.restartOne(current.id)
    },
    async writeContinuation(tx, snapshot) {
      const target = tx.skillFilesTarget
      if (!target) throw new Error('事务没有绑定 Skill 文件激活目标')
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
        summary: `${goalContinueSummary(goal, 1)}\n\n项目 Skill 文件已验证并激活，继续原目标。续接编号：${target.continueId}`,
        kind: 'continue'
      }, deps.root)
      if (!written) throw new Error('运行时续行槽已有另一条未消费请求，拒绝覆盖')
    },
    async clearContinuation(tx, snapshot) {
      const target = tx.skillFilesTarget
      if (!target) return
      const resolved = snapshot ?? await runner(target)
      if (resolved) await clearGoalResumeSnapshotIfOperation(resolved.id, target.continueId, deps.root)
    },
    continuationConsumed: (tx, snapshot) => tx.skillFilesTarget
      ? goalResumeContinuationWasConsumed(snapshot.id, tx.skillFilesTarget.continueId, deps.root)
      : Promise.resolve(false)
  }
}
