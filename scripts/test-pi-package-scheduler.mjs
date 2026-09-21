import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runPiPackageSchedulerTests(ok, { AcquisitionService, PiPackageActivationScheduler }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-pi-package-scheduler-'))
  const at = '2026-09-20T12:00:00.000Z'
  const sourceHead = 'b'.repeat(40)

  const makeTransaction = async (service, suffix = 'a', runnerGeneration = 1) => {
    const tx = await service.begin({
      planId: `plan-${suffix}`,
      planRevision: 2,
      candidateId: `npm:@fixture/${suffix}@1.2.3`,
      digest: `digest-${suffix}`,
      projectId: 'project-a',
      at
    })
    const pending = await service.markBoundary(tx.operationId, '等调度', at)
    await service.bindPiPackageTarget(tx.operationId, {
      runnerId: 'runner-a',
      runnerGeneration,
      cwd: 'C:/project-a',
      sessionFile: 'C:/sessions/original.jsonl',
      projectId: 'project-a',
      goalId: 'goal-original',
      goalRevision: 7,
      sourceHead,
      continueId: tx.operationId,
      packageName: `@fixture/${suffix.replace(/[^A-Za-z0-9._-]/g, '-')}`,
      packageVersion: '1.2.3'
    })
    return pending
  }

  const makePorts = (overrides = {}) => {
    const calls = []
    const runner = {
      id: 'runner-a',
      generation: 1,
      cwd: 'c:/PROJECT-A/',
      sessionFile: 'C:/sessions/original.jsonl',
      projectId: 'project-a',
      ready: true,
      busy: false
    }
    let installed = false
    let consumed = false
    let active = false
    const ports = {
      async authorization() { calls.push('authorization'); return { allowLifecycleScripts: false } },
      async isTrusted() { calls.push('trust'); return true },
      async sourceHead() { calls.push('head'); return sourceHead },
      async goalSnapshot() { calls.push('goal'); return { goalId: 'goal-original', revision: 7, active: true } },
      async runner() { calls.push('runner'); return { ...runner } },
      cwdBusy() { calls.push('cwd-busy'); return runner.busy },
      async verifyStaged() { calls.push('staged'); return { ok: true, problems: [] } },
      async verifyInstalled() {
        calls.push('installed-check')
        return { ok: true, installed, ...(installed ? { path: 'C:/project-a/.pi/npm/fixture' } : {}), problems: [] }
      },
      async smoke() { calls.push('smoke'); return { ok: true, problems: [] } },
      async install(_tx, grant) {
        calls.push(`install:scripts=${grant.allowLifecycleScripts}`)
        installed = true
        return { ok: true }
      },
      async restartRunner() {
        calls.push('restart')
        runner.generation += 1
        consumed = true
        active = true
        return { ok: true }
      },
      async verifyActive() { calls.push('active'); return { ok: active, problems: active ? [] : ['包尚未在 runner 加载'] } },
      async writeContinuation() { calls.push('write-continuation') },
      async clearContinuation() { calls.push('clear-continuation') },
      async continuationConsumed() { calls.push('consumed'); return consumed },
      ...overrides
    }
    return {
      ports,
      calls,
      runner,
      setInstalled: (value) => { installed = value },
      setConsumed: (value) => { consumed = value },
      setActive: (value) => { active = value }
    }
  }

  try {
    /* End-to-end orchestration with a deterministic installer/smoke adapter. */
    {
      const service = new AcquisitionService({ root: join(root, 'success') })
      const tx = await makeTransaction(service)
      const fake = makePorts()
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const [result] = await scheduler.tick()
      ok(result.state === 'resumed', '调度闭环：待边界事务经 smoke / 安装 / 定向重载 / 消费续接后 resumed', result.detail)
      ok((await service.get(tx.operationId))?.attempts === 0, '调度闭环：pending-boundary 续接不额外计安装 attempt')
      ok(fake.calls.indexOf('smoke') < fake.calls.indexOf('install:scripts=false'), '调度闭环：先隔离 smoke，后执行安装')
      ok(fake.calls.indexOf('write-continuation') < fake.calls.indexOf('restart'), '调度闭环：续接快照先持久化，再重载 runner')
      ok(fake.calls.filter((call) => call === 'restart').length === 1, '调度闭环：只定向重载目标一次')
      ok((await service.get(tx.operationId))?.receipt?.verification === 'smoke-passed', '调度闭环：receipt 记录真实 smoke 级别')
    }

    /* A busy cwd, missing grant, or stale snapshot must have no write side effects. */
    for (const [name, override, expected] of [
      ['runner 忙碌', { cwdBusy: () => true }, '等待目标项目全部 runner 空闲'],
      ['授权缺失', { authorization: async () => null }, '精确候选 / 指纹 / 项目授权已撤销或不可读'],
      ['goal revision 漂移', { goalSnapshot: async () => ({ goalId: 'goal-original', revision: 8, active: true }) }, '原目标身份 / 修订已变化或已结束'],
      ['sourceHead 漂移', { sourceHead: async () => 'c'.repeat(40) }, '项目 sourceHead 已变化']
    ]) {
      const service = new AcquisitionService({ root: join(root, `defer-${name}`) })
      await makeTransaction(service, `defer-${name}`)
      const fake = makePorts(override)
      if (name === 'runner 忙碌') fake.runner.busy = true
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const result = await scheduler.schedule((await service.list())[0].operationId)
      ok(result.state === 'deferred' && result.detail.includes(expected), `前置门禁：${name} 时事务保持待处理`, result.detail)
      ok(!fake.calls.some((call) => call === 'smoke' || call.startsWith('install:') || call === 'restart'), `前置门禁：${name} 时没有运行包代码 / 安装 / 重启`)
    }

    /* Smoke failure is terminal for this attempt and never reaches install. */
    {
      const service = new AcquisitionService({ root: join(root, 'smoke-fail') })
      const tx = await makeTransaction(service, 'smoke-fail')
      const fake = makePorts({ async smoke() { return { ok: false, problems: ['未发现包内 Skill'] } } })
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const result = await scheduler.schedule(tx.operationId)
      ok(result.state === 'failed' && result.detail.includes('未发现包内 Skill'), 'smoke 失败：事务如实失败')
      ok(!fake.calls.some((call) => call.startsWith('install:') || call === 'restart'), 'smoke 失败：没有安装或重启')
    }

    /* Restart crash recovery: a matching newer runner and consumed continueId are proof, not a reason to restart again. */
    {
      const service = new AcquisitionService({ root: join(root, 'recover') })
      const tx = await makeTransaction(service, 'recover')
      await service.markAcquiring(tx.operationId, 'recover fixture', at)
      await service.markVerifying(tx.operationId, 'smoke passed', at)
      await service.activate({
        operationId: tx.operationId,
        receipt: {
          planId: tx.planId,
          planRevision: tx.planRevision,
          candidateId: tx.candidateId,
          digest: tx.digest,
          scope: 'project-managed',
          projectId: tx.projectId,
          installedPaths: ['C:/project-a/.pi/npm/fixture'],
          verification: 'smoke-passed'
        },
        verify: async () => ({ ok: true, problems: [] }),
        at
      })
      const fake = makePorts()
      fake.runner.generation = 2
      fake.setInstalled(true)
      fake.setConsumed(true)
      fake.setActive(true)
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const result = await scheduler.schedule(tx.operationId)
      ok(result.state === 'resumed', '崩溃恢复：已重载 runner + 已消费 continueId 后可补记 resumed')
      ok(!fake.calls.includes('restart'), '崩溃恢复：不重复重启 runner')
    }

    /* A process restart can recreate the same session with a new runner id and a reset generation. */
    {
      const service = new AcquisitionService({ root: join(root, 'cold-recover') })
      const tx = await makeTransaction(service, 'cold-recover', 4)
      await service.markAcquiring(tx.operationId, 'recover fixture', at)
      await service.markVerifying(tx.operationId, 'smoke passed', at)
      await service.activate({
        operationId: tx.operationId,
        receipt: {
          planId: tx.planId,
          planRevision: tx.planRevision,
          candidateId: tx.candidateId,
          digest: tx.digest,
          scope: 'project-managed',
          projectId: tx.projectId,
          installedPaths: ['C:/project-a/.pi/npm/fixture'],
          verification: 'smoke-passed'
        },
        verify: async () => ({ ok: true, problems: [] }),
        at
      })
      const fake = makePorts()
      fake.runner.id = 'runner-recovered'
      fake.setInstalled(true)
      fake.setActive(true)
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const result = await scheduler.schedule(tx.operationId)
      ok(result.state === 'resumed', '冷启动恢复：按原 cwd / session / project 身份接受新 runner id 与重置代次')
      ok(fake.calls.filter((call) => call === 'restart').length === 1, '冷启动恢复：为让新实例消费续接而只重载一次')
    }

    /* Same-operation concurrent wakeups are single-flight. */
    {
      const service = new AcquisitionService({ root: join(root, 'single-flight') })
      const tx = await makeTransaction(service, 'single-flight')
      const fake = makePorts()
      const scheduler = new PiPackageActivationScheduler(service, fake.ports)
      const first = scheduler.schedule(tx.operationId)
      const second = scheduler.schedule(tx.operationId)
      ok(first === second, '并发唤醒：同 operationId 合并为同一调度 Promise')
      const results = await Promise.all([first, second])
      ok(results.every((result) => result.state === 'resumed'), '并发唤醒：只执行一次且终态一致')
      ok(fake.calls.filter((call) => call === 'restart').length === 1, '并发唤醒：没有重复重启')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
