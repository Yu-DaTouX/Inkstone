/**
 * 运行注册表宿主接线单测（v3 WP-10 接线）。
 *
 * 现场用 esbuild 编译 `src/main/runs-host.ts`（含它 import 的注册表 / 编号 /
 * 历史 / 推送合并 / 停滞监测），在隔离临时目录里跑，不启动 Electron、不碰 pi、
 * 不写用户数据目录。可独立执行：
 *
 *   node scripts/test-v3-runs-host.mjs
 *
 * 覆盖：初始化为了不改主入口可以失败降级、snapshot 的 flush + revision 对齐、
 * 编号未就绪时的信号缓冲、agent_settled 才终态、markSeen、危险确认按 id 归还、
 * dispose 等写盘。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-v3-runs-host-'))
  try {
    const hostMod = await compile('src/main/runs-host.ts', join(dir, 'host.mjs'))
    const pushes = []
    let seq = 0
    let now = 1_000
    const root = join(dir, 'data')
    const host = await hostMod.createRunsHost({
      root,
      push: (msg) => pushes.push(msg),
      now: () => now,
      newRunId: () => `run-${++seq}`
    })

    /* ── 初始快照：revision 0、空列表 ── */
    let snap = host.snapshot()
    assert.equal(snap.revision, 0)
    assert.deepEqual(snap.runs, [])

    /* ── 编号未就绪时缓冲信号；就绪后按序重放 ── */
    const observe = host.observerFor({ generation: 1 })
    const ctx1 = { sessionId: 's1', sessionPath: '/tmp/s1.jsonl', title: '会话一', model: { provider: 'p', id: 'm', label: 'M' } }
    observe(ctx1, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, 0, '编号分配完成前不登记运行（但已缓冲，不丢 agent_start）')
    await waitFor(() => host.snapshot().runs.length === 1)
    now = 2_000
    observe(ctx1, { type: 'activity', activity: 'streaming' })
    observe(ctx1, { type: 'agent-settled', aborted: false })
    snap = host.snapshot()
    assert.equal(snap.runs.length, 1)
    assert.equal(snap.runs[0].phase.kind, 'done', 'agent_settled 才是终态依据')
    assert.equal(snap.runs[0].code, 'S1')
    assert.equal(snap.runs[0].sessionId, 's1')
    assert.equal(snap.runs[0].title, '会话一')
    assert.equal(snap.runs[0].model.label, 'M')
    assert.ok(snap.revision > 0, 'snapshot 返回的 revision 必须 > 0')

    /* ── snapshot 前 flush：普通变化先合并、snapshot 后 revision 对齐 ── */
    const ctx2 = { sessionId: 's2' }
    observe(ctx2, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((r) => r.sessionId === 's2'))
    pushes.length = 0
    observe(ctx2, { type: 'activity', activity: 'thinking' })
    assert.equal(pushes.length, 0, '非状态类变化先留在合并窗口里')
    const flushed = host.snapshot()
    assert.equal(pushes.length, 1, 'snapshot 同步冲出待发增量')
    assert.equal(pushes[0].ch, 'runs')
    assert.equal(pushes[0].payload.revision, flushed.revision, 'push 的 revision 与 snapshot 返回一致')
    assert.equal(flushed.runs.find((r) => r.sessionId === 's2').phase.activity, 'thinking')

    /* ── revision 单调递增 ── */
    const revisions = pushes.map((p) => p.payload.revision)
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))

    /* ── markSeen：done 的运行标记已读并立即推送 ── */
    const doneRun = flushed.runs.find((r) => r.sessionId === 's1')
    const seen = host.markSeen(doneRun.runId)
    assert.equal(seen.ok, true)
    assert.equal(host.markSeen('不存在').ok, false)
    const marked = host.snapshot().runs.find((r) => r.runId === doneRun.runId)
    assert.equal(marked.phase.seen, true)

    /* ── 危险确认：按正式 id 进入等你确认，resolve（含拒绝）归还运行态 ── */
    const ctx3 = { sessionId: 's3' }
    observe(ctx3, { type: 'agent-start' })
    await waitFor(() => host.snapshot().runs.some((r) => r.sessionId === 's3'))
    host.observeApproval({ id: 'danger-1', kind: 'danger', sessionId: 's3', title: '危险操作确认' })
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you')
    host.observeApproval({ id: 'consent-1', kind: 'consent', sessionId: 's3', title: '普通同意' })
    assert.equal(
      host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind,
      'needs-you',
      '普通同意也是阻塞请求，但只是观察正式请求，不执行或授权'
    )
    host.resolveApproval('danger-1')
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you', '还有另一个同意请求时不能提前恢复运行态')
    host.resolveApproval('consent-1')
    assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'running', '全部请求 resolved 后才恢复，拒绝 / 超时同样算 resolved')
    for (const kind of ['outside', 'permission', 'delete', 'move']) {
      const id = `approval-${kind}`
      host.observeApproval({ id, kind, sessionId: 's3', title: `${kind} 确认` })
      assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'needs-you', `${kind} 批准也必须显示等待用户`)
      host.resolveApproval(id)
      assert.equal(host.snapshot().runs.find((r) => r.sessionId === 's3').phase.kind, 'running')
    }

    /* ── 进程退出（意外）记失败，不是 done ── */
    observe(ctx3, { type: 'pi-exit', code: 1, signal: null })
    const failed = host.snapshot().runs.find((r) => r.sessionId === 's3')
    assert.equal(failed.phase.kind, 'failed')
    assert.equal(failed.phase.cause, 'pi-exit')

    /* ── 子 Agent：归到父会话编号下，agent_end 不终态、agent_settled 才终态 ── */
    const s2Run = host.snapshot().runs.find((r) => r.sessionId === 's2')
    host.observeSubagentEvent(
      { id: 'sub-1', parentSessionId: 's2', task: '子任务' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }
    )
    const sub = host.snapshot().runs.find((r) => r.kind === 'subagent')
    assert.equal(sub.code, 'S2·1', '子 Agent 归到父会话编号下')
    assert.equal(sub.parentRunId, s2Run.runId)
    host.observeSubagentEvent({ id: 'sub-1', parentSessionId: 's2' }, { type: 'agent_end', willRetry: false })
    assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').phase.kind, 'running', 'agent_end 不是终态')
    host.observeSubagentEvent({ id: 'sub-1', parentSessionId: 's2' }, { type: 'agent_settled', aborted: false })
    assert.equal(host.snapshot().runs.find((r) => r.kind === 'subagent').phase.kind, 'done', 'agent_settled 才是子代理终态')

    /* ── dispose 等写盘；之后不再接收事件 ── */
    await host.dispose()
    const beforeCount = host.snapshot().runs.length
    observe(ctx1, { type: 'agent-start' })
    assert.equal(host.snapshot().runs.length, beforeCount, 'dispose 后不再登记新运行')

    const historyFiles = await readdir(join(root, 'runs'))
    assert.ok(historyFiles.some((name) => name.endsWith('.jsonl')), '运行历史写盘完成（dispose 已等待）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
  console.log('v3-runs-host: 全部通过')
}
