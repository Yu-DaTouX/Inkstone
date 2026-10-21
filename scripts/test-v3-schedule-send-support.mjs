import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-schedule-send-'))
let checks = 0
const verify = (value, label) => {
  assert.ok(value, label)
  checks++
}
const bundle = async (file, name) => {
  const output = join(work, name + '.mjs')
  await build({ entryPoints: [file], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(output).href)
}

const makeRegistry = () => {
  const agents = []
  const registry = new RunnerRegistry({
    limit: 3,
    now: () => 1000,
    createAgent: (id, cwd) => {
      const agent = {
        id,
        state: { sessionId: `pending:${id}`, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
        getState() {
          return this.state
        },
        getConn() {
          return { state: 'ready' }
        },
        hasRunningBash() {
          return this.runningBash === true
        },
        hasWrittenThisRun() {
          return true
        },
        getPendingUiCount() {
          return 0
        },
        setRunnerGeneration() {},
        async start() {
          return { ok: true }
        },
        async stop() {},
        queueSnapshot() {
          return { steering: [], followUp: [] }
        },
        async newSession() {
          return { ok: true }
        },
        async switchSession(file) {
          this.state = { ...this.state, sessionId: file, sessionFile: file }
          return { ok: true }
        },
        async setModel() {
          return { ok: true }
        },
        async send() {
          return { ok: true }
        }
      }
      agents.push(agent)
      return agent
    }
  })
  return { registry, agents }
}

const { RunnerRegistry } = await bundle('src/main/runners.ts', 'runners')
const guard = await bundle('src/main/session-send-guard.ts', 'guard')
const { sameRuntimeEnvelope } = await bundle('src/core/run-state.ts', 'run-state')

try {
  verify(
    sameRuntimeEnvelope(
      { runId: 'r1', generation: 3, sessionId: 'pending:r1' },
      { runId: 'r1', generation: 3, sessionId: 'real-uuid' }
    ),
    'pending→real 同代视为同一实例'
  )
  verify(
    sameRuntimeEnvelope({ runId: 'r1', generation: 3, sessionId: 'session-a' }, { runId: 'r1', generation: 3, sessionId: 'session-b' }) === false,
    '同代不同真实 sessionId 视为换会话'
  )
  verify(
    sameRuntimeEnvelope({ runId: 'r1', generation: 3, sessionId: 'pending:r1' }, { runId: 'r1', generation: 4, sessionId: 'pending:r1' }) === false,
    'runId 相同但换代必须判为不一致'
  )
  verify(
    sameRuntimeEnvelope({ runId: 'r1', generation: 1, sessionId: 'x' }, { runId: 'r2', generation: 1, sessionId: 'x' }) === false,
    '不同 runId 必须判为不一致'
  )
  verify(sameRuntimeEnvelope(null, { runId: 'r1', generation: 1 }) === false, '缺封套不回退为同实例')

  const lookupTrue = () => true
  verify(guard.guardSameCwdExecute({ runnerId: 'r2', cwd: '/w', selfBusy: false }, lookupTrue).ok === false, '同 cwd 另有忙碌实例拒绝')
  verify(guard.guardSameCwdExecute({ runnerId: 'r1', cwd: '/w', selfBusy: true }, lookupTrue).ok === true, '发起者自己忙放行插话 / 排队')
  verify(guard.guardSameCwdExecute({ runnerId: 'r2', cwd: '', selfBusy: false }, lookupTrue).ok === true, 'cwd 为空交后续既有检查')
  verify(guard.guardSameCwdExecute(null, lookupTrue).ok === true, '无输入放行')
  verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r2', 5) === true, 'claim 归属同实例同代')
  verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r2', 6) === false, '换代后旧 claim 失效')
  verify(guard.admissionClaimedBy({ token: 1, runId: 'r2', generation: 5, cwd: '/w' }, 'r1', 5) === false, '别的实例不能认领 claim')

  const { registry, agents } = makeRegistry()
  const cwd = join(work, 'fixture-cwd')
  const first = await registry.select({ cwd })
  verify(first.ok && first.id && first.runId === first.id, '首个实例建成并带身份')
  const r1 = first.id
  const second = await registry.select({ cwd, sessionFile: 'second-session', activate: false })
  verify(second.ok && second.id && second.id !== r1, '同 cwd 另建一个空闲实例')
  const r2 = second.id
  agents[0].state.isAgentRunning = true

  verify(registry.guardExecute(r2).ok === false, '同 cwd busy 冲突：对空闲实例发送被拒')
  verify(registry.guardExecute(r1).ok === true, '同 cwd busy：对忙碌实例自己的插话放行')
  verify(registry.guardExecute('missing').ok === true, '目标不存在交后续检查')

  agents[0].state.isAgentRunning = false
  const claim1 = registry.admitExecute(r1)
  verify(claim1.ok === true, '空闲 cwd 第一个实例取得 claim')
  const claim1Again = registry.admitExecute(r1)
  verify(claim1Again.ok === true && claim1Again.token === claim1.token, '同实例重入返回同一 token')
  const claim2 = registry.admitExecute(r2)
  verify(claim2.ok === false && claim2.error === guard.SAME_CWD_ADMISSION_ERROR, '同 cwd 第二个实例 claim 被明确拒绝')
  verify(registry.confirmExecute(r1, claim1.token) === true, '持有者入队前 confirm 通过')

  registry.releaseExecute(r1, claim1.token)
  verify(registry.confirmExecute(r1, claim1.token) === false, '释放后旧 token 不再 confirm')
  const claim3 = registry.admitExecute(r2)
  verify(claim3.ok === true, '释放后同 cwd 另一个实例可取得 claim')
  verify(registry.confirmExecute(r2, claim3.token) === true, '新持有者 confirm 通过')

  const r2runner = registry.runners.get(r2)
  r2runner.generation += 10
  const claim4 = registry.admitExecute(r2)
  verify(claim4.ok === true && claim4.token !== claim3.token, '换代后旧 claim 被回收并发放新 token')
  verify(registry.confirmExecute(r2, claim3.token) === false, '换代后旧代次 token 拒绝入队')
  verify(registry.confirmExecute(r2, claim4.token) === true, '换代后新 token confirm 通过')
  registry.releaseExecute(r2, claim4.token)
  verify(registry.admitExecute(r1).ok === true, '再次释放后 cwd 重新可用')

  console.log(`Schedule send support: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
