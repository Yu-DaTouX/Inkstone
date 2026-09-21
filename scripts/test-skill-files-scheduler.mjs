import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = await mkdtemp(join(tmpdir(), 'yan-skill-files-scheduler-'))
try {
  await build({ entryPoints: ['src/main/capabilities/skill-files-scheduler.ts'], outfile: 'out/test/skill-files-scheduler.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  await build({ entryPoints: ['src/main/capabilities/acquisition-service.ts'], outfile: 'out/test/acquisition-service.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const { SkillFilesActivationScheduler } = await import('../out/test/skill-files-scheduler.mjs')
  const { AcquisitionService } = await import('../out/test/acquisition-service.mjs')
  const sourceHead = 'b'.repeat(40)
  const service = new AcquisitionService({ root })
  const started = await service.begin({ planId: 'skill-plan', planRevision: 3, candidateId: 'skill:fixture', digest: 'digest', projectId: 'project-a' })
  const pending = await service.markBoundary(started.operationId, '等安全边界')
  await service.bindSkillFilesTarget(started.operationId, {
    runnerId: 'runner-a', runnerGeneration: 1, cwd: 'C:/project-a', sessionFile: 'C:/sessions/original.jsonl',
    projectId: 'project-a', goalId: 'goal-original', goalRevision: 7, sourceHead, continueId: started.operationId
  })

  const calls = []
  const runner = { id: 'runner-a', generation: 1, cwd: 'c:/PROJECT-A/', sessionFile: 'C:/sessions/original.jsonl', projectId: 'project-a', ready: true, busy: false }
  let filesActive = false
  let runtimeActive = false
  let consumed = false
  const ports = {
    async authorization() { calls.push('authorization'); return { allowLifecycleScripts: false } },
    async isTrusted() { calls.push('trust'); return true },
    async sourceHead() { calls.push('head'); return sourceHead },
    async goalSnapshot() { calls.push('goal'); return { goalId: 'goal-original', revision: 7, active: true } },
    async runner() { calls.push('runner'); return { ...runner } },
    cwdBusy() { calls.push('cwd-busy'); return runner.busy },
    async verifyStaged() { calls.push('staged'); return { ok: true, problems: [] } },
    async activateFiles() { calls.push('activate-files'); filesActive = true; return { ok: true, problems: [], paths: ['C:/yan/active/project-a/skills/fixture/SKILL.md'] } },
    async verifyFiles() { calls.push('verify-files'); return filesActive ? { ok: true, problems: [], paths: ['C:/yan/active/project-a/skills/fixture/SKILL.md'] } : { ok: false, problems: ['active 文件缺失'] } },
    async verifyActive() { calls.push('verify-active'); return runtimeActive ? { ok: true, problems: [], paths: ['C:/yan/active/project-a/skills/fixture/SKILL.md'] } : { ok: false, problems: ['runner 尚未加载 Skill'] } },
    async restartRunner() { calls.push('restart'); runner.generation += 1; runtimeActive = true; consumed = true; return { ok: true } },
    async writeContinuation() { calls.push('write-continuation') },
    async clearContinuation() { calls.push('clear-continuation') },
    async continuationConsumed() { calls.push('consumed'); return consumed }
  }
  const scheduler = new SkillFilesActivationScheduler(service, ports)
  const result = await scheduler.tick()
  if (result.length !== 1 || result[0].state !== 'resumed') throw new Error(`Skill 调度闭环未 resumed：${JSON.stringify(result)}`)
  if (calls.indexOf('activate-files') < 0 || calls.indexOf('write-continuation') < 0 || calls.indexOf('restart') < 0) throw new Error(`Skill 调度缺少关键步骤：${calls.join(',')}`)
  if (calls.indexOf('write-continuation') > calls.indexOf('restart')) throw new Error('Skill 调度没有先写续接快照再重启')

  const busyRoot = join(root, 'busy')
  const busyService = new AcquisitionService({ root: busyRoot })
  const busyTx = await busyService.begin({ planId: 'busy-plan', planRevision: 1, candidateId: 'skill:busy', digest: 'busy', projectId: 'project-a' })
  await busyService.markBoundary(busyTx.operationId, '等安全边界')
  await busyService.bindSkillFilesTarget(busyTx.operationId, {
    runnerId: 'runner-a', runnerGeneration: 1, cwd: 'C:/project-a', sessionFile: 'C:/sessions/original.jsonl',
    projectId: 'project-a', goalId: 'goal-original', goalRevision: 7, sourceHead, continueId: busyTx.operationId
  })
  const busyPorts = { ...ports, cwdBusy() { return true } }
  const deferred = await new SkillFilesActivationScheduler(busyService, busyPorts).schedule(busyTx.operationId)
  if (deferred.state !== 'deferred' || !deferred.detail.includes('等待目标项目全部 runner 空闲')) throw new Error(`忙碌 runner 未延迟：${JSON.stringify(deferred)}`)
  console.log('skill-files scheduler tests: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
