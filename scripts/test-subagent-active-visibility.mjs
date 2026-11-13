import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function runSubagentActiveVisibilityTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (condition, label) => { if (!condition) throw new Error(`✗ ${label}`) }

  const run = (id, extra = {}) => ({
    id,
    task: `task-${id}`,
    cwd: '/tmp/fixture',
    isolation: 'worktree',
    status: 'running',
    startedAt: 1,
    transcript: [],
    review: 'none',
    ...extra
  })

  const selectorDir = await mkdtemp(join(tmpdir(), 'yan-active-subagents-'))
  try {
    const selectorOut = join(selectorDir, 'subagent-view.mjs')
    await build({
      entryPoints: ['src/renderer/src/state/subagent-view.ts'],
      outfile: selectorOut,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent'
    })
    const { selectSubagentRuns, subagentScopeForView } = await import(pathToFileURL(selectorOut).href)

    const sessionWins = selectSubagentRuns(
      [run('contradict', { parentSessionId: 'OTHER', parentRunId: 'R1' })],
      { sessionIds: ['S'], runIds: ['R1'] }
    )
    check(sessionWins.foreign.length === 1 && sessionWins.all.length === 0, '有 parentSessionId 时以它为准，parentRunId 兜底不改判')

    const runnersAB = [
      { id: 'rA', runId: 'rA', sessionId: 'A', sessionFile: 'C:\\proj\\a.jsonl' },
      { id: 'rB', runId: 'rB', sessionId: 'B', sessionFile: 'c:/PROJ/b.jsonl' }
    ]
    const scopeB = subagentScopeForView({
      peekedSessionId: 'B',
      peekedPath: null,
      session: { sessionId: 'A', sessionFile: 'C:\\proj\\a.jsonl', conversationId: 'A-conv' },
      runners: runnersAB
    })
    check(scopeB.sessionIds.length === 1 && scopeB.sessionIds[0] === 'B', '后台查看 B 时归属只认 B，不并入活动 A 的 conversationId')
    check(scopeB.runIds?.length === 1 && scopeB.runIds[0] === 'rB', '旧记录的兜底实例取 B 的 runner，不是 active 的 A')

    const runsAB = [
      run('b-sid', { parentSessionId: 'B' }),
      run('b-legacy', { parentRunId: 'rB' }),
      run('a-sid', { parentSessionId: 'A' }),
      run('a-legacy', { parentRunId: 'rA' }),
      run('foreign', { parentSessionId: 'OTHER', parentRunId: 'rB' })
    ]
    const pickedB = selectSubagentRuns(runsAB, scopeB).all.map((r) => r.id)
    check(pickedB.includes('b-sid') && pickedB.includes('b-legacy'), 'B 的有 sid 与仅 parentRunId 的任务都归到当前视图')
    check(!pickedB.includes('a-sid') && !pickedB.includes('a-legacy'), 'A 的任务（含 legacy）不串进 B 视图')
    check(!pickedB.includes('foreign'), '有明确 parentSessionId 的 foreign 不会被 parentRunId 兜底拉进来')

    const scopeA = subagentScopeForView({ peekedSessionId: null, peekedPath: null, session: { sessionId: 'A', conversationId: 'A-conv' }, runners: runnersAB })
    check(scopeA.sessionIds.includes('A-conv'), '显示的就是当前会话时才并入 conversationId（同一显示 view）')

    const scopePath = subagentScopeForView({
      peekedSessionId: null,
      peekedPath: null,
      session: { sessionId: 'X', sessionFile: 'C:\\Proj\\B.jsonl\\' },
      runners: runnersAB
    })
    check(scopePath.runIds?.[0] === 'rB', '稳定路径命中视图实例（分隔符 / 大小写 / 尾斜杠不敏感）')

    const scopePending = subagentScopeForView({ peekedSessionId: null, peekedPath: 'C:/PROJ/B.jsonl', session: null, runners: runnersAB })
    check(scopePending.sessionIds.length === 0 && scopePending.runIds?.[0] === 'rB', '按路径预览（pending）时仍按路径找到视图实例')
  } finally {
    await rm(selectorDir, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let passed = 0
  let failed = 0
  try {
    await runSubagentActiveVisibilityTests((condition, label) => {
      if (condition) {
        passed++
        console.log(`  ok  ${label}`)
      } else {
        failed++
        console.log(`  ✗ ${label}`)
      }
    })
    console.log(failed ? `\n✗ 常驻子代理区：失败 ${failed} 项` : `\n✓ 常驻子代理区：${passed} 项通过`)
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
