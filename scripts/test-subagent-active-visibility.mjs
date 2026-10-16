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
    const { activeSubagentRuns, selectSubagentRuns, subagentScopeForView } = await import(pathToFileURL(selectorOut).href)

    const now = Date.now()
    const fixture = [
      run('live', { parentSessionId: 'S' }),
      run('starting', { parentSessionId: 'S', status: 'starting' }),
      run('wrapping', { parentSessionId: 'S', wrapUp: { reason: 'timeout', since: now } }),
      run('failed', { parentSessionId: 'S', status: 'error', review: 'none' }),
      run('timeout', { parentSessionId: 'S', status: 'error', endReason: 'timeout' }),
      run('budget', { parentSessionId: 'S', status: 'done', endReason: 'budget' }),
      run('review', { parentSessionId: 'S', status: 'done', review: 'pending', endedAt: now }),
      run('conflict', { parentSessionId: 'S', status: 'done', review: 'conflict', endedAt: now }),
      run('finished', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now }),
      run('merged', { parentSessionId: 'S', status: 'done', review: 'merged', endedAt: now }),
      run('discarded', { parentSessionId: 'S', status: 'done', review: 'discarded', endedAt: now }),
      run('cancelled', { parentSessionId: 'S', status: 'cancelled', review: 'none', endedAt: now }),
      run('foreign', { parentSessionId: 'OTHER' }),
      run('orphan')
    ]
    const ids = activeSubagentRuns(fixture, { sessionIds: ['S'] }).map((r) => r.id)
    const has = (id) => ids.includes(id)

    check(has('live') && has('starting') && has('wrapping'), '运行中 / 启动中 / 收尾中的常驻')
    check(has('failed') && has('timeout') && has('budget') && has('review') && has('conflict'), '出错 / 超时 / 调用用完 / 待审阅 / 冲突的常驻')
    check(!has('finished') && !has('merged') && !has('discarded') && !has('cancelled'), '完成无需处理 / 已合并 / 已放弃 / 被停止的撤下')
    check(!has('foreign'), '别的会话的子代理不串进当前会话')
    check(!has('orphan'), '没有归属字段且不属于当前视图的旧记录不猜当前会话')

    const fallback = activeSubagentRuns(
      [run('legacy', { parentRunId: 'R1' }), run('other-run', { parentRunId: 'R2' })],
      { sessionIds: ['S'], runIds: ['R1'] }
    ).map((r) => r.id)
    check(fallback.includes('legacy'), '没有 parentSessionId 但 parentRunId 命中当前视图的运行实例 → 仍留下')
    check(!fallback.includes('other-run'), '挂在别的运行实例下的旧记录仍不猜当前视图')
    const sessionWins = selectSubagentRuns(
      [run('contradict', { parentSessionId: 'OTHER', parentRunId: 'R1' })],
      { sessionIds: ['S'], runIds: ['R1'] }
    )
    check(sessionWins.foreign.length === 1 && sessionWins.all.length === 0, '有 parentSessionId 时以它为准，parentRunId 兜底不改判')

    const deduped = activeSubagentRuns([
      run('dup', { parentSessionId: 'S', status: 'running' }),
      run('dup', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now })
    ], { sessionIds: ['S'] })
    check(deduped.length === 0, '同一 runId 重复推送时以最后一次为准（已完成无需处理就撤下）')
    const revived = activeSubagentRuns([
      run('dup', { parentSessionId: 'S', status: 'done', review: 'none', endedAt: now }),
      run('dup', { parentSessionId: 'S', status: 'running' })
    ], { sessionIds: ['S'] })
    check(revived.length === 1 && revived[0].status === 'running', '同一 runId 以最后一次（运行中）为准')

    const empty = activeSubagentRuns([], { sessionIds: ['S'] })
    check(empty.length === 0, '没有任务时选择器返回空数组')

    const chain = activeSubagentRuns([run('child', { parentSessionId: 'CHILD' })], { sessionIds: ['S', 'CHILD'] })
    check(chain.length === 1, '显式会话链里的任务算当前会话')

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
