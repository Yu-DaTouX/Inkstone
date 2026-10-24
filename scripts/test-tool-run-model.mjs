import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

async function load(dir) {
  const entry = join(dir, 'entry.ts')
  const session = posix(join(ROOT, 'src/renderer/src/features/session'))
  await writeFile(entry, [
    `export * from '${session}/tool-run-model.ts'`,
    `export * from '${session}/tool-expansion.ts'`,
    `export { sessionText } from '${session}/text.ts'`
  ].join('\n'))
  const outfile = join(dir, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', jsx: 'automatic' })
  return import(pathToFileURL(outfile).href)
}

const call = (id, name, args = {}, extra = {}) => ({ id, name, args, status: 'ok', ...extra })
const diff = (path, added, removed, status = 'modified') => ({ fileDiff: { path, before: {}, after: {}, added, removed, patch: '', status } })

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-tool-run-'))
  try {
    const m = await load(dir)
    assert.equal(m.liveToolGlowId([call('container', 'codemode', {}, { status: 'running' }), call('write', 'write', {}, { status: 'pending', parentToolCallId: 'container' })]), 'write', '容器与正在生成参数的子工具只突出子工具')
    assert.equal(m.liveToolGlowId([call('older', 'read', {}, { status: 'running' }), call('newer', 'write', {}, { status: 'pending' })]), 'newer', '跨段多个活动工具只突出最新一项')
    assert.equal(m.liveToolGlowId([call('done', 'read')]), null, '已结束工具不保留辉光')
    const zh = (key, vars) => m.sessionText('zh-CN', key, vars)
    const en = (key, vars) => m.sessionText('en-US', key, vars)
    const webTools = [
      call('code-parent', 'codemode', { code: 'fixture' }),
      call('nested-read', 'read', { path: 'data.json' }, { parentToolCallId: 'code-parent' }),
      call('nested-search', 'web_search', { query: 'Minecraft MCP' }, { parentToolCallId: 'code-parent' }),
      call('nested-fetch', 'web_fetch', { url: 'https://example.invalid/docs' }, { parentToolCallId: 'code-parent' }),
      call('after-read', 'read', { path: 'result.json' })
    ]
    const webRows = m.buildToolRows(webTools)
    for (const id of ['nested-search', 'nested-fetch']) {
      assert.ok(webRows.some((row) => row.kind === 'single' && row.standalone && row.id === id), '搜索和网页读取从 codemode 提升成独立卡片')
    }
    const codeRow = webRows.find((row) => row.id === 'code-parent')
    assert.deepEqual(codeRow.node.children.map((node) => node.call.id), ['nested-read'], '原工具中不重复嵌套搜索卡片，普通读取仍保留')

    assert.equal(m.toolCategory(call('a', 'read', { path: 'a.ts' })), 'read')
    assert.equal(m.toolCategory(call('a', 'bash', { command: 'npm test' })), 'command')
    assert.equal(m.toolCategory(call('a', 'bash', { command: 'yan subagent start --task x' })), 'agent')
    assert.equal(m.toolCategory(call('a', 'bash', { command: 'yan search "q"' })), 'web')
    assert.equal(m.toolCategory(call('a', 'write', { path: 'n.ts' }, { details: diff('n.ts', 3, 0, 'created') })), 'create')
    assert.equal(m.toolCategory(call('a', 'mcp__srv__read_file')), 'other')
    assert.equal(m.isStandaloneTool({ name: 'ask_user_question' }), true)
    assert.equal(m.normalizeToolPath('C:\\Repo\\Src\\A.ts'), 'c:/repo/src/a.ts', 'Windows 路径归一时折叠大小写')
    assert.equal(m.normalizeToolPath('/repo/Src/A.ts'), '/repo/Src/A.ts', 'POSIX 路径归一保留大小写')
    assert.equal(m.normalizeToolPath('/repo/Src/A.ts/'), '/repo/Src/A.ts', '归一去掉结尾斜杠')
    assert.equal(m.normalizeToolPath('Src\\A.ts'), 'src/a.ts', '相对路径按 Windows 习惯折叠大小写与分隔符')

    const single = m.buildToolRows([call('r1', 'read', { path: 'a.ts' })])
    assert.equal(single.length, 1)
    assert.equal(single[0].kind, 'single')

    const mixed = [
      call('r1', 'read', { path: 'src/a.ts' }),
      call('e1', 'edit', { path: 'src/b.ts' }, { details: diff('src/b.ts', 11, 1) }),
      call('c1', 'bash', { command: 'npm test' })
    ]
    const rows = m.buildToolRows(mixed)
    assert.equal(rows.length, 1, '连续 2 条以上不同类也成组')
    assert.equal(rows[0].kind, 'group')
    assert.equal(rows[0].id, 'group:r1')
    assert.equal(rows[0].firstId, 'r1')
    const summary = rows[0].summary
    assert.equal(summary.added, 11)
    assert.equal(summary.removed, 1)
    assert.equal(summary.state, 'ok')
    assert.equal(m.formatToolRun(summary, zh), '读取 1 个文件，编辑 1 个文件，运行 1 条命令')
    assert.equal(m.formatToolRun(summary, en), 'Read a file, edited a file, ran a command')

    const broken = m.buildToolRows([
      call('r1', 'read', { path: 'a.ts' }),
      call('q1', 'question', {}),
      call('r2', 'read', { path: 'b.ts' }),
      call('r3', 'grep', { pattern: 'x' })
    ])
    assert.deepEqual(broken.map((row) => row.kind), ['single', 'single', 'group'], '提问工具独立并断开分组')
    assert.equal(broken[1].standalone, true)

    const nested = m.buildToolRows([
      call('r1', 'read'),
      call('p1', 'codemode'),
      call('k1', 'read', {}, { parentToolCallId: 'p1' }),
      call('r2', 'read'),
      call('r3', 'read')
    ])
    assert.deepEqual(nested.map((row) => row.kind), ['group'], '带子调用的脚本与相邻工具合并成一组')
    assert.deepEqual(nested[0].nodes.map((node) => node.call.id), ['r1', 'p1', 'r2', 'r3'])
    assert.equal(nested[0].nodes[1].children.length, 1, '组内脚本保留自己的子调用')
    assert.equal(m.formatToolRun(nested[0].summary, zh), '读取 4 个文件', '组的汇总按脚本内部调用计数，不把脚本本身算成命令')

    const scripts = m.buildToolRows([
      call('s1', 'codemode', { code: 'x' }),
      call('s1/1', 'bash', { command: 'git status' }, { parentToolCallId: 's1' }),
      call('s1/2', 'read', { path: 'a.ts' }, { parentToolCallId: 's1' }),
      call('t1', 'todos'),
      call('s2', 'codemode', { code: 'y' }),
      call('s2/1', 'edit', { path: 'b.ts' }, { parentToolCallId: 's2', details: diff('b.ts', 5, 2) })
    ])
    assert.equal(scripts.length, 1, '连续的 codemode 脚本与中间的单个工具合并成一行')
    assert.equal(m.formatToolRun(scripts[0].summary, zh), '运行 1 条命令，读取 1 个文件，更新待办，编辑 1 个文件')
    assert.equal(scripts[0].summary.added, 5)
    assert.equal(scripts[0].summary.removed, 2)

    const liveScript = m.buildToolRows([
      call('d1', 'read', { path: 'a.ts' }),
      call('s3', 'codemode', { code: 'z' }, { status: 'running' }),
      call('s3/1', 'read', { path: 'b.ts' }, { parentToolCallId: 's3' })
    ])[0].summary
    assert.equal(liveScript.state, 'running', '组内脚本仍在运行时整组显示运行中')
    assert.equal(liveScript.running?.id, 's3')

    const failedScript = m.buildToolRows([
      call('d2', 'read', { path: 'a.ts' }),
      call('s4', 'codemode', { code: 'w' }, { status: 'error' }),
      call('s4/1', 'read', { path: 'b.ts' }, { parentToolCallId: 's4' })
    ])[0].summary
    assert.equal(failedScript.failed, 1, '脚本本身失败时计入组的失败数')

    const samePath = m.summarizeToolRun([
      call('r1', 'read', { path: 'src/style.css' }),
      call('e1', 'edit', { path: 'src\\style.css' }, { details: diff('src/style.css', 2, 2) })
    ])
    assert.equal(samePath.path, 'src/style.css')
    assert.equal(samePath.segments.length, 1)
    assert.equal(m.formatToolRun(samePath, zh), '读取并编辑 style.css')
    assert.equal(m.formatToolRun(samePath, en), 'Read and edited style.css')

    const rereads = m.summarizeToolRun(Array.from({ length: 4 }, (_, i) => call(`r${i}`, 'read', { path: 'a.md' })))
    assert.equal(m.formatToolRun(rereads, zh), '读取 a.md（4 次）', '同一路径多次读取不算多个文件')
    assert.equal(m.formatToolRun(rereads, en), 'Read a.md (4 times)')

    const distinct = m.summarizeToolRun([
      call('r1', 'read', { path: 'a.ts' }),
      call('r2', 'read', { path: 'b.ts' }),
      call('r3', 'read', { path: 'A.ts' })
    ])
    assert.equal(m.formatToolRun(distinct, en), 'Read 2 files', '路径按大小写与分隔符合并')

    const failures = m.summarizeToolRun([
      call('c1', 'bash', { command: 'a' }, { status: 'error' }),
      call('c2', 'bash', { command: 'b' }, { status: 'error', cancelled: true }),
      call('e1', 'edit', { path: 'x.ts' }, { status: 'error' }),
      call('e2', 'edit', { path: 'x.ts' }, { details: diff('x.ts', 1, 1) })
    ])
    assert.equal(failures.failed, 1, '中断不算失败，同一路径重试成功覆盖旧失败')
    assert.equal(failures.state, 'ok', '组状态取最后一个成员')
    assert.equal(m.formatToolRun(failures, zh), '运行 2 条命令（1 个失败），编辑 1 个文件', '失败数挂在失败的那类工具后面')
    assert.equal(m.formatToolRun(failures, en), 'Ran 2 commands (1 failed), edited a file')

    const agentRun = m.summarizeToolRun([
      call('r1', 'read', { path: 'a.md' }),
      call('b1', 'bash', { command: 'yan subagent start --task x' }),
      call('b2', 'bash', { command: 'sleep 8; yan subagent get --id x' }, { status: 'error' })
    ])
    assert.equal(m.formatToolRun(agentRun, zh), '读取 1 个文件，派出 1 个子 Agent，运行 1 条命令（1 个失败）', '命令失败不算到子 Agent 上')

    const notCounted = m.summarizeToolRun([
      call('e1', 'edit', { path: 'x.ts' }, { status: 'error', details: diff('x.ts', 9, 9) }),
      call('e2', 'edit', { path: 'y.ts' }, { cancelled: true, details: diff('y.ts', 5, 5) }),
      call('e3', 'edit', { path: 'z.ts' }, { details: diff('z.ts', 3, 2) })
    ])
    assert.equal(notCounted.added, 3, '失败与中断的成员不计行数')
    assert.equal(notCounted.removed, 2)
    const unknownLines = m.summarizeToolRun([call('w1', 'write', { path: 'big.bin' }, { details: diff('big.bin', -1, -1) }), call('r1', 'read')])
    assert.equal(unknownLines.added, null)
    assert.equal(unknownLines.changedFiles, 1)

    const live = [call('r1', 'read', { path: 'a' }), call('c1', 'bash', { command: 'rm x' }, { status: 'running' })]
    const approvals = m.approvalCallIds([{ sessionId: 's1', tool: 'bash' }], live, 's1')
    assert.deepEqual([...approvals], ['c1'], '审批按工具名匹配到运行中的调用')
    assert.equal(m.approvalCallIds([{ sessionId: 's2', tool: 'bash' }], live, 's1').size, 0, '别的会话的审批不算')
    assert.equal(m.approvalCallIds([{ subagentId: 'x', tool: 'bash' }], live, 's1').size, 0, '子代理的审批不算')
    assert.deepEqual([...m.approvalCallIds([{ toolCallId: 'r1' }], live)], ['r1'], '有调用 id 时直接使用')
    const blocked = m.buildToolRows(live, approvals)[0].summary
    assert.equal(blocked.state, 'blocked')
    assert.equal(blocked.needsApproval, true)
    assert.equal(blocked.running.id, 'c1')
    assert.equal(m.buildToolRows(live)[0].summary.state, 'running')
    const lone = m.buildToolRows([live[1]], approvals)
    assert.equal(lone[0].kind, 'single')
    assert.equal(lone[0].blocked, true, '单行也带需要审批')

    const others = m.summarizeToolRun([call('m1', 'mcp__x__thing'), call('m2', 'mcp__x__thing'), call('t1', 'todo_write')])
    assert.equal(m.formatToolRun(others, zh), '调用 mcp__x__thing 2 次，更新待办')

    const coalesced = m.coalesceNodes([
      { call: call('r1', 'read', { path: 'a.ts' }), children: [] },
      { call: call('r2', 'read', { path: 'a.ts' }), children: [] },
      { call: call('e1', 'edit', { path: 'a.ts' }), children: [] },
      { call: call('r3', 'read', { path: 'a.ts' }), children: [] },
      { call: call('r4', 'read', { path: 'a.ts' }, { status: 'error' }), children: [] }
    ])
    assert.deepEqual(coalesced.map((item) => [item.node.call.id, item.repeat]), [['r2', 2], ['e1', 1], ['r3', 1], ['r4', 1]], '相邻同路径同操作折成一行，结果不同不合并')

    const store = m.createExpansionStore(3)
    let notified = 0
    const off = store.subscribe(() => { notified += 1 })
    store.set('s1', 'group:a', true)
    store.set('s1', 'group:b', false)
    store.set('s2', 'group:a', true)
    assert.equal(store.get('s1', 'group:a'), true)
    assert.equal(store.get('s2', 'group:a'), true, '同一调用 id 按会话分开')
    store.set('s1', 'group:a', true)
    store.set('s1', 'group:c', true)
    assert.equal(store.size(), 3, '容量上限')
    assert.equal(store.get('s1', 'group:b'), undefined, '最久未写的被淘汰')
    assert.equal(store.get('s1', 'group:a'), true, '重写会刷新新近度')
    store.forget('s1')
    assert.equal(store.get('s1', 'group:a'), undefined, '重试时清掉该会话')
    assert.equal(store.get('s2', 'group:a'), true, '其他会话不受影响')
    assert.ok(notified >= 4)
    off()
    assert.equal(m.EXPANSION_LIMIT, 1000)
    const big = m.createExpansionStore()
    for (let i = 0; i < 1005; i += 1) big.set('s', `g${i}`, true)
    assert.equal(big.size(), 1000)
    assert.equal(big.get('s', 'g0'), undefined)
    assert.equal(big.get('s', 'g1004'), true)

    let held = m.holdRunLabel(null, { key: 'c1', label: 'bash npm test' }, 1000).held
    assert.equal(held.label, 'bash npm test')
    let step = m.holdRunLabel(held, { key: 'c2', label: 'read a.ts' }, 1300)
    assert.equal(step.held.key, 'c1', '650ms 内不切换')
    assert.equal(step.wakeAt, 1650)
    step = m.holdRunLabel(step.held, { key: 'c1', label: 'bash npm test --watch' }, 1400)
    assert.equal(step.held.label, 'bash npm test --watch', '同一 key 的增量立即更新且不重新计时')
    assert.equal(step.held.since, 1000)
    step = m.holdRunLabel(step.held, { key: 'c2', label: 'read a.ts' }, 1650)
    assert.equal(step.held.key, 'c2', '到时后切换')
    step = m.holdRunLabel(step.held, { key: null, label: '' }, 1700)
    assert.equal(step.held.key, 'c2', '回到收敛态也要等满 650ms')
    step = m.holdRunLabel({ key: null, label: '', since: 1690 }, { key: 'c3', label: 'x' }, 1700)
    assert.equal(step.held.key, 'c3', '从收敛态离开立即生效')
    assert.equal(m.RUN_LABEL_HOLD_MS, 650)

    console.log('tool-run-model：全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
