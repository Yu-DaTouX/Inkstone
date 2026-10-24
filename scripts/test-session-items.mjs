import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-session-items-'))
try {
  const outfile = join(dir, 'items.mjs')
  await build({
    stdin: {
      contents: [
        "export * from './src/main/session-items/projector'",
        "export * from './src/main/session-items/tool-events'",
        "export * from './src/shared/session-items'",
        "export { normalizeMessage, restoreNestedCalls, imagesOf, assistantError } from './src/main/normalize'"
      ].join('\n'),
      resolveDir: process.cwd()
    },
    outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
  })
  const m = await import(pathToFileURL(outfile).href)
  const localize = (mimeType, data) => `local:${mimeType}:${data.length}`
  const png = { type: 'image', mimeType: 'image/png', data: 'AAAA' }

  const history = [
    { role: 'system', content: 'sys' },
    { role: 'custom', customType: 'notice', display: true, content: 'note before any user', timestamp: 1 },
    { role: 'user', content: [{ type: 'text', text: 'first' }, png], timestamp: 2 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan ' }, { type: 'text', text: 'Hello ' }, { type: 'toolCall', id: 'call_a', name: 'bash', arguments: { command: 'ls' } }, { type: 'thinking', thinking: 'more' }, { type: 'text', text: 'world' }, { type: 'toolCall', id: 'call_b', name: 'edit', arguments: { path: 'a.ts' } }], usage: { input: 10, output: 5 }, model: 'm', provider: 'p', timestamp: 3 },
    { role: 'toolResult', toolCallId: 'call_a', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], timestamp: 4 },
    { role: 'toolResult', toolCallId: 'call_b', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'failed' }, png], details: { diff: '-a' }, timestamp: 5 },
    { role: 'toolResult', toolCallId: 'orphan', toolName: 'mcp__srv__x', content: 'plain', timestamp: 6 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_c', name: 'subagent', arguments: {} }], timestamp: 7 },
    { role: 'toolResult', toolCallId: 'call_c', toolName: 'subagent', content: [{ type: 'text', text: 'done' }],
      nestedCalls: { complete: false, calls: [{ id: 'call_c/1', name: 'read', status: 'ok', arguments: { path: 'x' } }, { id: 'call_c/1/2', name: 'bash', status: 'error', error: 'boom' }, { id: 'bad', name: 'x', status: 'ok' }] }, timestamp: 8 },
    { role: 'assistant', content: [{ type: 'text', text: 'oops' }], stopReason: 'error', errorMessage: 'rate limited', timestamp: 9 },
    { role: 'bashExecution', command: 'git status', exitCode: 1, cancelled: false, content: 'not a repo', timestamp: 10 },
    { role: 'user', content: 'second', timestamp: 11 },
    { role: 'assistant', content: 'string content is ignored', timestamp: 12 },
    { role: 'branchSummary', summary: 'went elsewhere', timestamp: 13 },
    { role: 'custom', display: false, content: 'hidden' },
    { role: 'toolResult', toolCallId: 'call_a', toolName: 'bash', content: [{ type: 'text', text: 'replayed' }], cancelled: true, isError: true }
  ]
  const entryIds = history.map((_, index) => (index % 3 === 0 ? undefined : `e${index}`))

  const legacyHistory = (raw, localizeImage, ids) => {
    const out = []
    const index = new Map()
    let seq = 0
    raw.forEach((message, position) => {
      if (message?.role === 'system') return
      const norm = m.normalizeMessage(message, seq, localizeImage, ids?.[position])
      if (!norm) return
      const first = norm.toolCalls?.[0]
      const hit = message.role === 'toolResult' && first ? index.get(first.id) : undefined
      if (hit) {
        hit.call.status = first.status
        hit.call.output = first.output
        hit.call.cancelled = first.cancelled
        hit.call.details = first.details
        if (first.images?.length) hit.call.images = first.images
        m.restoreNestedCalls(message, hit.msg, hit.call, index)
        return
      }
      seq += 1
      for (const call of norm.toolCalls ?? []) index.set(call.id, { msg: norm, call })
      out.push(norm)
      if (message.role === 'toolResult' && first) m.restoreNestedCalls(message, norm, first, index)
    })
    return out
  }
  const legacy = legacyHistory(structuredClone(history), localize, entryIds)
  const projected = m.projectHistory(structuredClone(history), localize, entryIds)
  assert.deepStrictEqual(projected, legacy, '历史回放：投影器与迁移前的历史构建输出完全相同')
  assert.deepStrictEqual(m.projectHistory(structuredClone(history)), legacyHistory(structuredClone(history)), '无 entryId、无图片本地化时也相同')
  assert.deepStrictEqual(m.projectHistory([]), [])

  const projector = new m.SessionItemProjector(localize)
  history.forEach((raw, index) => projector.appendPersisted(structuredClone(raw), entryIds[index]))
  const items = projector.items()
  const user = items.find((item) => item.kind === 'user')
  assert.equal(user.id, 'm1')
  assert.equal(user.turnId, 'm1', 'turn id 取首条用户消息 id')
  assert.equal(items[0].kind, 'note')
  assert.equal(items[0].turnId, m.PRELUDE_TURN_ID)
  const firstTurn = items.filter((item) => item.turnId === 'm1')
  assert.deepEqual(firstTurn.filter((item) => item.kind === 'reasoning').map((item) => item.id), ['m1:0:0', 'm1:0:3'], '思考块 id = turn + 步 + 块序')
  assert.deepEqual(firstTurn.filter((item) => item.kind === 'assistant-text').map((item) => item.id), ['m1:0:1', 'm1:0:4', 'm1:3:0'])
  const tools = firstTurn.filter((item) => item.kind === 'tool')
  assert.deepEqual(tools.map((item) => item.id), ['call_a', 'call_b', 'orphan', 'call_c', 'call_c/1', 'call_c/1/2'], '工具沿用 toolCallId')
  assert.deepEqual(tools.map((item) => item.tool), ['bash', 'file-change', 'mcp', 'subagent', 'tool', 'bash'])
  assert.deepEqual(tools.map((item) => item.status), ['cancelled', 'error', 'ok', 'ok', 'ok', 'error'])
  assert.deepEqual(tools.map((item) => item.step), [0, 0, 1, 2, 2, 2])
  const status = firstTurn.find((item) => item.kind === 'status')
  assert.deepEqual([status.id, status.text], ['m1:3:status', legacy.find((msg) => msg.error)?.error])
  assert.equal(firstTurn.find((item) => item.kind === 'shell').command, 'git status')
  assert.equal(tools[0].entryId, undefined)
  assert.equal(tools[3].entryId, 'e7')
  const turns = projector.turns()
  assert.deepEqual(turns.map((turn) => turn.id), [m.PRELUDE_TURN_ID, 'm1', 'm7'])
  assert.equal(turns[2].items.at(-1).kind, 'note')

  projector.appendPersistedEntry({ id: 'c1', type: 'compaction', tokensBefore: 900 }, null)
  assert.deepEqual(projector.items().at(-1), { kind: 'compaction', id: 'compaction:c1', turnId: 'm7', messageId: '', entryId: 'c1', status: 'ok', tokensBefore: 900 })

  const legacyStart = (call, now) => { call.status = 'running'; call.startedAt = now }
  const legacyUpdate = (call, partial) => {
    call.output = (partial?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
    call.details = partial?.details
  }
  const legacyEnd = (call, evt, now) => {
    const result = evt.result
    const cancelled = evt.cancelled === true
    call.cancelled = cancelled || undefined
    call.status = evt.isError && !cancelled ? 'error' : 'ok'
    call.output = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
    call.images = m.imagesOf(result?.content)
    call.details = result?.details
    call.endedAt = now
  }
  const legacyMerge = (call, key, value) => {
    const base = call.details && typeof call.details === 'object' && !Array.isArray(call.details) ? call.details : {}
    call.details = { ...base, [key]: value }
  }
  const endEvents = [
    { result: { content: [{ type: 'text', text: 'ok' }, png], details: { a: 1 } }, isError: false },
    { result: { content: [{ type: 'text', text: 'bad' }] }, isError: true },
    { result: { content: [] }, isError: true, cancelled: true },
    { isError: false },
    { result: { content: [{ type: 'text', text: 'x' }], details: [1, 2] }, cancelled: false }
  ]
  for (const [index, evt] of endEvents.entries()) {
    const before = { id: `c${index}`, name: 'edit', args: { path: 'a' }, status: 'pending', details: index === 4 ? 'prior' : { prior: true } }
    const oldCall = structuredClone(before)
    const newCall = structuredClone(before)
    legacyStart(oldCall, 10); m.startToolExecution(newCall, 10)
    legacyUpdate(oldCall, { content: [{ type: 'text', text: 'partial' }], details: { p: 1 } }); m.updateToolExecution(newCall, { content: [{ type: 'text', text: 'partial' }], details: { p: 1 } })
    assert.deepStrictEqual(newCall, oldCall, `工具进度事件 ${index}：新旧路径一致`)
    legacyUpdate(oldCall, undefined); m.updateToolExecution(newCall, undefined)
    legacyEnd(oldCall, evt, 20); m.endToolExecution(newCall, evt, 20)
    assert.deepStrictEqual(newCall, oldCall, `工具结束事件 ${index}：新旧路径一致`)
    legacyMerge(oldCall, 'fileDiff', { added: 1 }); m.mergeToolDetails(newCall, { fileDiff: { added: 1 } })
    assert.deepStrictEqual(newCall, oldCall, `工具细节合并 ${index}：新旧路径一致`)
  }

  const live = new m.SessionItemProjector()
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 100 }
  const liveUser = live.liveMessageStart(userMessage, 100)
  assert.equal(liveUser.id, 'm0')
  live.liveCompaction({ type: 'compaction_start', reason: 'threshold' })
  const compaction = live.liveCompaction({ type: 'compaction_end', aborted: false, result: { tokensBefore: 1234 } })
  assert.deepEqual([compaction.status, compaction.reason, compaction.tokensBefore, compaction.turnId], ['ok', 'threshold', 1234, 'm0'])
  live.liveMessageStart({ role: 'assistant' }, 101)
  live.liveAssistantDelta({ type: 'thinking_start', contentIndex: 0 }, 101)
  live.liveAssistantDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }, 101)
  live.liveAssistantDelta({ type: 'thinking_end', contentIndex: 0 }, 101)
  live.liveAssistantDelta({ type: 'text_delta', contentIndex: 1, delta: 'Hi ' }, 101)
  live.liveAssistantDelta({ type: 'text_delta', contentIndex: 1, delta: 'there' }, 101)
  const started = live.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 2, id: 'tmp', toolName: 'bash' }, 102)
  live.liveAssistantDelta({ type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"ls"}' }, 102)
  assert.deepEqual(started.args, { command: 'ls' })
  live.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call_live', name: 'bash', arguments: { command: 'ls' } } }, 102)
  assert.equal(started.id, 'call_live')
  const ended = live.liveMessageEnd({ usage: { input: 1, output: 2 }, model: 'p/m', text: 'ignored' })
  assert.deepEqual([ended.text, ended.thinking, ended.toolCalls.map((call) => call.id), ended.usage.output], ['Hi there', 'hmm', ['call_live'], 2])
  live.liveToolStart({ toolCallId: 'call_live', toolName: 'bash', args: { command: 'ls' } }, 103)
  live.liveToolUpdate('call_live', { content: [{ type: 'text', text: 'par' }] })
  live.liveToolEnd('call_live', { result: { content: [{ type: 'text', text: 'a.txt' }] }, isError: false }, 104)
  const orphan = live.liveToolStart({ toolCallId: 'late', toolName: 'read', args: { path: 'x' } }, 105)
  assert.equal(orphan.call.status, 'running')
  assert.equal(orphan.ownerId, `t${(105).toString(36)}`)
  assert.deepEqual(orphan.created?.toolCalls, [orphan.call], '无主工具新建一条消息并交给宿主推送')
  live.liveToolEnd('late', { result: { content: [{ type: 'text', text: 'body' }] } }, 106)
  const nestedStart = live.liveToolStart({ toolCallId: 'call_live/1', toolName: 'read', parentToolCallId: 'call_live' }, 107)
  assert.equal(nestedStart.ownerId, 'm1')
  assert.equal(nestedStart.created, undefined)
  const nested = nestedStart.call
  const liveMessages = live.uiMessages()
  assert.deepEqual(liveMessages.map((msg) => msg.id), ['m0', 'm1', `t${(105).toString(36)}`], '直播 id 与旧路径相同：用户/助手按位置编号，无主工具单独成条')
  assert.ok(liveMessages[1].toolCalls.includes(nested), '带父调用的工具挂到父调用所在消息')
  const liveItems = live.items()
  assert.deepEqual(liveItems.map((item) => item.id), ['m0', 'compaction:1', 'm0:0:0', 'm0:0:1', 'call_live', 'call_live/1', 'late'])

  {
    const stopping = new m.SessionItemProjector()
    stopping.appendMessage({ id: 'older-user', role: 'user', text: 'old' })
    stopping.appendMessage({ id: 'older-assistant', role: 'assistant', text: '', toolCalls: [{ id: 'older-call', name: 'bash', status: 'running' }] })
    stopping.appendMessage({ id: 'stop-user', role: 'user', text: 'stop this turn' })
    const done = { id: 'done-write', name: 'write', status: 'ok', args: { path: '01.txt' }, output: 'written', details: { fileDiff: { added: 63 } }, endedAt: 400 }
    const root = { id: 'root-call', name: 'codemode', status: 'running', args: { code: 'tools.bash()' } }
    const nested = { id: 'nested-call', name: 'bash', status: 'running', parentToolCallId: 'root-call', output: 'partial output', details: { progress: 1 } }
    const pending = { id: 'pending-write', name: 'write', status: 'pending', argsRaw: '{"path":"04.txt","content":"partial' }
    stopping.appendMessage({ id: 'stop-assistant', role: 'assistant', text: '', toolCalls: [done, root, nested, pending] })
    stopping.appendMessage({ id: 'independent-bash', role: 'bash', text: 'separate command', toolCalls: [{ id: 'independent-call', name: 'bash', status: 'running' }] })
    const finishedBefore = structuredClone(done)
    assert.deepEqual(stopping.cancelUnfinishedTools(500).map(call => call.id), ['root-call', 'nested-call', 'pending-write'], '只收尾本轮未完成的模型工具，包含嵌套和未生成完参数的调用')
    assert.deepEqual(done, finishedBefore, '完成的写入和差异记录不变')
    assert.deepEqual([nested.output, nested.details], ['partial output', { progress: 1 }], '取消收尾保留部分输出与详情')
    assert.equal(pending.argsRaw, '{"path":"04.txt","content":"partial', '保留未生成完的参数原文')
    assert.equal(pending.args, undefined)
    for (const call of [root, nested, pending]) {
      assert.equal(call.status, 'ok')
      assert.equal(call.cancelled, true)
      assert.equal(call.endedAt, 500)
      assert.equal(stopping.items().find(item => item.id === call.id).status, 'cancelled', '语义投影与 UI 调用状态同步')
    }
    assert.equal(stopping.call('older-call').status, 'running', '不改历史轮次')
    assert.equal(stopping.call('independent-call').status, 'running', '独立命令由其自己的终止通道收尾')
    assert.deepEqual(stopping.cancelUnfinishedTools(600), [], '重复停止不重复改写或推送')
    stopping.liveToolUpdate('nested-call', { content: [{ type: 'text', text: 'late output' }] })
    assert.equal(stopping.call('nested-call').cancelled, true, '迟到进度不会恢复运行态')
    stopping.liveToolEnd('nested-call', { result: { content: [{ type: 'text', text: 'native result' }] } }, 700)
    assert.equal(stopping.call('nested-call').cancelled, undefined, '原生最终结果优先于兜底状态')
    assert.equal(stopping.call('nested-call').output, 'native result')
  }

  const persisted = [
    userMessage,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hi there' }, { type: 'toolCall', id: 'call_live', name: 'bash', arguments: { command: 'ls' } }], timestamp: 101 },
    { role: 'toolResult', toolCallId: 'call_live', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], timestamp: 104 }
  ]
  const replay = new m.SessionItemProjector()
  for (const raw of persisted) replay.appendPersisted(raw)
  const shape = (item) => ({ kind: item.kind, id: item.id, turnId: item.turnId, ...(item.kind === 'tool' ? { status: item.status, output: item.call.output } : { text: item.text }) })
  const liveCore = liveItems.filter((item) => item.kind !== 'compaction' && !['late', 'call_live/1'].includes(item.id)).map(shape)
  assert.deepEqual(replay.items().map(shape), liveCore, '直播与回放走同一个投影器，得到相同的 turn/item id 与内容')

  {
    const progressUser = { role: 'user', content: 'go', timestamp: 300 }
    const progress = new m.SessionItemProjector()
    progress.liveMessageStart(progressUser, 300)
    progress.liveMessageStart({ role: 'assistant', model: 'claude-opus-5-5' }, 301)
    progress.liveAssistantDelta({ type: 'thinking_start', contentIndex: 0 }, 301)
    progress.liveAssistantDelta({ type: 'thinking_end', contentIndex: 0 }, 301)
    progress.liveAssistantDelta({ type: 'thinking_start', contentIndex: 1 }, 301)
    progress.liveAssistantDelta({ type: 'thinking_delta', contentIndex: 1, delta: 'Found it, checking config next.' }, 301)
    progress.liveAssistantDelta({ type: 'thinking_end', contentIndex: 1 }, 301)
    assert.equal(progress.streamingContent().thinking, 'Found it, checking config next.', '工具调用出现前仍按思考显示')
    progress.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 2, id: 'p1', toolName: 'read' }, 302)
    assert.deepEqual(progress.streamingContent(), { id: progress.streamingContent().id, text: 'Found it, checking config next.', thinking: '', calls: progress.streamingContent().calls }, '紧贴工具调用前的思考块转为正文')
    progress.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'p1', name: 'read', arguments: { path: 'a' } } }, 302)
    progress.liveMessageEnd({ model: 'claude-opus-5-5' })
    const progressBlocks = [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'Found it, checking config next.' }, { type: 'toolCall', id: 'p1', name: 'read', arguments: { path: 'a' } }]
    const progressReplay = new m.SessionItemProjector()
    progressReplay.appendPersisted(progressUser)
    progressReplay.appendPersisted({ role: 'assistant', model: 'claude-opus-5-5', content: progressBlocks, timestamp: 301 })
    const kinds = (p) => p.items().filter((item) => item.kind !== 'user').map((item) => [item.kind, item.id, item.kind === 'tool' ? item.call.id : item.text])
    assert.deepEqual(kinds(progressReplay), [['reasoning', 'm0:0:0', ''], ['assistant-text', 'm0:0:1', 'Found it, checking config next.'], ['tool', 'p1', 'p1']], '回放时进度更新为正文，空推理块保持推理')
    assert.deepEqual(kinds(progress), kinds(progressReplay), '直播与回放一致')
    const older = new m.SessionItemProjector()
    older.appendPersisted(progressUser)
    older.appendPersisted({ role: 'assistant', model: 'claude-opus-4-6', content: progressBlocks, timestamp: 301 })
    assert.equal(older.items().find((item) => item.id === 'm0:0:1').kind, 'reasoning', '其他模型的交错思考不改')
  }
  const pick = (msg) => ({ id: msg.id, role: msg.role, text: msg.text, thinking: msg.thinking, calls: (msg.toolCalls ?? []).map((call) => [call.id, call.status, call.output]) })
  assert.deepEqual(replay.uiMessages().map(pick), liveMessages.slice(0, 2).map(pick).map((msg) => ({ ...msg, calls: msg.calls.filter(([id]) => id === 'call_live') })), '映射回 UIMessage 后直播与回放结构一致')

  const turnRaw = [
    { role: 'user', content: [{ type: 'text', text: 'fix it' }], timestamp: 200 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'look ' }, { type: 'text', text: 'Reading.' }, { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } }, { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'a.ts' } }], usage: { input: 3, output: 4 }, model: 'm', provider: 'p', timestamp: 201 },
    { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'body' }, png], timestamp: 202 },
    { role: 'toolResult', toolCallId: 'e1', toolName: 'edit', isError: true, cancelled: true, content: [{ type: 'text', text: 'stopped' }], details: { d: 1 }, timestamp: 203 },
    { role: 'custom', customType: 'notice', display: true, content: 'heads up', timestamp: 204 },
    { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'overloaded', timestamp: 205 },
    { role: 'user', content: 'again', timestamp: 206 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'ok' }, { type: 'text', text: 'Done' }], timestamp: 207 }
  ]
  const feedLive = (projector) => {
    const added = []
    projector.liveMessageStart(turnRaw[0], 200)
    projector.liveMessageStart({ role: 'assistant' }, 201)
    projector.liveAssistantDelta({ type: 'thinking_start', contentIndex: 0 }, 201)
    projector.liveAssistantDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'lo' }, 201)
    projector.liveAssistantDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'ok ' }, 201)
    projector.liveAssistantDelta({ type: 'thinking_end', contentIndex: 0 }, 201)
    projector.liveAssistantDelta({ type: 'text_delta', contentIndex: 1, delta: 'Read' }, 201)
    projector.liveAssistantDelta({ type: 'text_delta', contentIndex: 1, delta: 'ing.' }, 201)
    projector.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 2, id: 'r1', toolName: 'read' }, 201)
    projector.liveAssistantDelta({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"a.ts"}' }, 201)
    projector.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } } }, 201)
    projector.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 3, toolName: 'edit' }, 201)
    projector.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 3, toolCall: { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'a.ts' } } }, 201)
    projector.liveMessageEnd({ usage: { input: 3, output: 4 }, model: 'p/m', timestamp: 201, error: m.assistantError(turnRaw[1]) })
    projector.liveToolStart({ toolCallId: 'r1', toolName: 'read', args: { path: 'a.ts' } }, 202)
    projector.liveToolUpdate('r1', { content: [{ type: 'text', text: 'bo' }] })
    projector.liveToolEnd('r1', { result: { content: [{ type: 'text', text: 'body' }, png] }, isError: false }, 202)
    projector.liveToolStart({ toolCallId: 'e1', toolName: 'edit', args: { path: 'a.ts' } }, 203)
    projector.liveToolEnd('e1', { result: { content: [{ type: 'text', text: 'stopped' }], details: { d: 1 } }, isError: true, cancelled: true }, 203)
    added.push(projector.liveMessageStart(turnRaw[4], 204))
    projector.liveCompaction({ type: 'compaction_start', reason: 'threshold' })
    projector.liveCompaction({ type: 'compaction_end', result: { tokensBefore: 77 } })
    projector.liveMessageStart({ role: 'assistant' }, 205)
    projector.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'partial' }, 205)
    projector.liveMessageEnd({ timestamp: 205, error: m.assistantError(turnRaw[5]) })
    added.push(projector.liveMessageStart(turnRaw[6], 206))
    projector.liveMessageStart({ role: 'assistant' }, 207)
    projector.liveAssistantDelta({ type: 'thinking_delta', contentIndex: 0, delta: 'ok' }, 207)
    projector.liveAssistantDelta({ type: 'text_delta', contentIndex: 1, delta: 'Done' }, 207)
    projector.liveMessageEnd({ timestamp: 207 })
    return added
  }
  const liveTurn = new m.SessionItemProjector(localize)
  const liveAdded = feedLive(liveTurn)
  const replayTurn = new m.SessionItemProjector(localize)
  turnRaw.forEach((raw, index) => replayTurn.appendPersistedEntry({ id: `x${index}` }, raw))
  replayTurn.appendPersistedEntry({ id: 'cmp', type: 'compaction', tokensBefore: 77 }, null)
  const imageView = (images) => images?.map((image) => image.mimeType)
  const callView = (call) => ({ id: call.id, name: call.name, args: call.args, status: call.status, output: call.output, cancelled: call.cancelled, details: call.details, images: imageView(call.images) })
  const messageView = (msg) => ({ id: msg.id, role: msg.role, text: msg.text, thinking: msg.thinking, images: imageView(msg.images), note: msg.note, error: msg.error, calls: (msg.toolCalls ?? []).map(callView) })
  assert.deepEqual(liveTurn.uiMessages().map(messageView), replayTurn.uiMessages().map(messageView), '多步回合：直播与回放的 UIMessage（id、正文、思考、工具、错误、附注）一致')
  assert.equal(liveAdded[0].role, 'note')
  const itemView = (item) => ({ kind: item.kind, id: item.kind === 'compaction' ? 'compaction' : item.id, turnId: item.turnId, status: item.status, text: item.text, tokensBefore: item.tokensBefore })
  const liveItemsTurn = liveTurn.items().map(itemView)
  const replayItemsTurn = replayTurn.items().map(itemView)
  const replayCompaction = replayItemsTurn.pop()
  const liveCompactionAt = liveItemsTurn.findIndex((item) => item.kind === 'compaction')
  const [liveCompactionItem] = liveItemsTurn.splice(liveCompactionAt, 1)
  assert.deepEqual(liveItemsTurn, replayItemsTurn, '多步回合：直播与回放的条目（turn/块/工具 id、状态）一致')
  assert.deepEqual({ ...liveCompactionItem, turnId: 'm0' }, { ...replayCompaction, turnId: 'm0' }, '压缩条目状态与压缩前 token 一致')
  assert.deepEqual(liveTurn.turns().map((turn) => turn.id), ['m0', 'm4'])

  const projectTurn = () => m.projectHistory(structuredClone(turnRaw), localize)
  const frozen = Object.freeze(projectTurn().map((msg) => Object.freeze(msg)))
  const loaded = new m.SessionItemProjector()
  loaded.load(frozen)
  assert.deepStrictEqual(loaded.uiMessages(), projectTurn(), '载入已投影的 UIMessage 后原样产出（不改冻结的输入）')
  const stable = loaded.uiMessages()[1]
  stable.artifacts = [{ id: 'a' }]
  assert.equal(loaded.uiMessages()[1], stable, '产出的消息对象稳定，宿主就地补充的字段保留')
  assert.deepEqual(loaded.uiMessages()[1].artifacts, [{ id: 'a' }])
  loaded.liveMessageStart({ role: 'assistant' }, 300)
  loaded.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'stream' }, 300)
  assert.equal(loaded.uiMessages().length, frozen.length, '流式中的消息不进入已定稿列表')
  assert.deepEqual(loaded.streamingContent(), { id: `m${frozen.length}`, text: 'stream', thinking: '', calls: [] })
  loaded.load(frozen)
  loaded.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'ing' }, 300)
  assert.equal(loaded.streamingContent()?.text, 'streaming', '重新载入历史时保留正在流式的消息')
  const settled = loaded.liveMessageEnd({ timestamp: 301 })
  assert.deepEqual([settled.id, settled.text, loaded.uiMessages().at(-1)], [`m${frozen.length}`, 'streaming', settled])
  loaded.liveMessageStart({ role: 'assistant' }, 302)
  loaded.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'lost' }, 302)
  const restarted = loaded.liveMessageStart({ role: 'assistant' }, 303)
  assert.equal(restarted.id, `m${frozen.length + 1}`, '未结束的流式消息被新流式替换时沿用同一位置编号')
  assert.equal(loaded.streamingContent()?.text, '')
  loaded.discardStreaming()
  assert.equal(loaded.streamingContent(), null)
  assert.equal(loaded.uiMessages().length, frozen.length + 1)
  const appended = loaded.appendMessage({ id: 'bash-1', role: 'bash', text: 'ls', bash: { command: 'ls', exitCode: null, cancelled: false }, toolCalls: [{ id: 'bash-1', name: 'bash', args: { command: 'ls' }, status: 'running' }] })
  assert.equal(loaded.call('bash-1'), appended.toolCalls[0])
  assert.equal(loaded.ownerOf('bash-1'), 'bash-1')
  assert.equal(loaded.ownerOf('r1'), 'm1')
  loaded.reset()
  assert.deepEqual([loaded.uiMessages(), loaded.items(), loaded.call('r1')], [[], [], undefined])

  const noIndex = new m.SessionItemProjector()
  noIndex.liveMessageStart({ role: 'assistant' }, 1)
  for (const delta of ['a', 'b']) noIndex.liveAssistantDelta({ type: 'text_delta', delta }, 1)
  noIndex.liveAssistantDelta({ type: 'thinking_start' }, 1)
  noIndex.liveAssistantDelta({ type: 'thinking_delta', delta: 'x' }, 1)
  noIndex.liveAssistantDelta({ type: 'thinking_end' }, 1)
  noIndex.liveAssistantDelta({ type: 'text_delta', delta: 'c' }, 1)
  assert.deepEqual(noIndex.items().map((item) => [item.kind, item.id, item.text]), [['assistant-text', 'prelude:0:0', 'ab'], ['reasoning', 'prelude:0:1', 'x'], ['assistant-text', 'prelude:0:2', 'c']], '缺 contentIndex 时连续增量并入同一块')

  const interleaved = new m.SessionItemProjector()
  interleaved.liveMessageStart({ role: 'user', content: 'go' }, 1)
  interleaved.liveMessageStart({ role: 'assistant' }, 2)
  interleaved.liveAssistantDelta({ type: 'text_delta', contentIndex: 0, delta: 'Let me look.' }, 2)
  interleaved.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 1, id: 'call_ls', toolName: 'ls' }, 2)
  interleaved.liveAssistantDelta({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"."}' }, 2)
  interleaved.liveAssistantDelta({ type: 'toolcall_start', contentIndex: 2, id: 'call_read', toolName: 'read' }, 2)
  interleaved.liveAssistantDelta({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"n.txt"}' }, 2)
  const endedLs = interleaved.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call_ls', name: 'ls', arguments: { path: '.' } } }, 2)
  const endedRead = interleaved.liveAssistantDelta({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'n.txt' } } }, 2)
  assert.deepEqual([endedLs.name, endedRead.name], ['ls', 'read'], '并行工具的结束事件按 contentIndex 落到各自的调用')
  interleaved.liveMessageEnd({ timestamp: 2 })
  assert.equal(interleaved.liveToolStart({ toolCallId: 'call_ls', toolName: 'ls' }, 3).created, undefined, '并行工具结束后两个调用都仍可按 id 找到')
  assert.equal(interleaved.liveToolStart({ toolCallId: 'call_read', toolName: 'read' }, 3).created, undefined)
  interleaved.liveToolEnd('call_ls', { result: { content: [{ type: 'text', text: 'Tool ls not found' }] }, isError: true }, 4)
  interleaved.liveToolEnd('call_read', { result: { content: [{ type: 'text', text: 'hello' }] }, isError: false }, 4)
  const interleavedReplay = m.projectHistory([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'toolCall', id: 'call_ls', name: 'ls', arguments: { path: '.' } }, { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'n.txt' } }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'call_ls', toolName: 'ls', isError: true, content: [{ type: 'text', text: 'Tool ls not found' }] },
    { role: 'toolResult', toolCallId: 'call_read', toolName: 'read', content: [{ type: 'text', text: 'hello' }] }
  ])
  assert.deepEqual(interleaved.uiMessages().map(messageView), interleavedReplay.map(messageView), '并行工具调用：直播与回放一致')

  for (const [index, chunks] of [['{"a":', '1}'], ['[1,', '2]'], ['{"bad"', ':}'], []].entries()) {
    const ev = index === 3 ? { type: 'toolcall_start' } : { type: 'toolcall_start', id: `s${index}`, toolName: 'bash' }
    const oldCall = { id: String(ev.id ?? `call-${index}`), name: String(ev.toolName ?? 'tool'), args: undefined, argsRaw: '', status: 'running', startedAt: 5 }
    const newCall = m.streamingToolCall(ev, index, 5)
    assert.deepStrictEqual(newCall, oldCall, `流式工具开始 ${index}：新旧路径一致`)
    for (const delta of chunks) {
      oldCall.argsRaw = (oldCall.argsRaw ?? '') + String(delta ?? '')
      try { if (/[}\]]\s*$/.test(oldCall.argsRaw)) oldCall.args = JSON.parse(oldCall.argsRaw) } catch { }
      m.appendToolCallArgs(newCall, delta)
      assert.deepStrictEqual(newCall, oldCall, `流式参数增量 ${index}：新旧路径一致`)
    }
    const tc = index === 2 ? undefined : { type: 'toolCall', id: `final${index}`, ...(index === 1 ? {} : { name: 'edit' }), arguments: index === 0 ? { a: 2 } : undefined }
    if (tc) { if (tc.id) oldCall.id = tc.id; if (tc.name) oldCall.name = tc.name; if (tc.arguments !== undefined) oldCall.args = tc.arguments }
    m.finishToolCallArgs(newCall, tc)
    assert.deepStrictEqual(newCall, oldCall, `流式工具结束 ${index}：新旧路径一致`)
  }

  assert.equal(m.toolItemKind('PowerShell'), 'bash')
  assert.equal(m.toolItemKind('question'), 'question')
  assert.equal(m.toolItemKind('todos'), 'todos')
  assert.equal(m.toolItemStatus({ status: 'pending' }), 'running')

  process.env.YAN_DATA_DIR = join(dir, 'data')
  process.env.YAN_PI_DIR = join(dir, 'pi')
  process.env.YAN_TEST_APP_DIR = join(dir, 'app')
  const agentFile = join(process.cwd(), 'out', 'test', 'session-items-agent.mjs')
  await build({
    entryPoints: ['src/main/agent.ts'], outfile: agentFile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [{ name: 'items-electron-boundary', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'items-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'items-electron' }, () => ({ contents: [
        "export class BrowserWindow { constructor() { throw new Error('no electron') } }",
        "export const session = { fromPartition() { throw new Error('no electron') } }",
        'export const app = { getLocale: () => "zh-CN", getPath: (name) => process.env.YAN_TEST_APP_DIR + "/" + name }'
      ].join('\n') }))
    } }]
  })
  const { AgentController } = await import(pathToFileURL(agentFile).href)
  const agentRaw = turnRaw.map((raw) => raw.role === 'toolResult' && raw.toolName === 'edit' ? { ...raw, toolName: 'grep' } : raw)
  agentRaw[1] = { ...agentRaw[1], content: agentRaw[1].content.map((block) => block.name === 'edit' ? { ...block, name: 'grep' } : block) }
  const pushes = []
  const ctl = new AgentController({ push: (msg) => pushes.push(msg), cwd: dir })
  const emit = (evt) => ctl.handleEvent(evt)
  const update = (assistantMessageEvent) => emit({ type: 'message_update', assistantMessageEvent })
  emit({ type: 'message_start', message: agentRaw[0] })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  update({ type: 'thinking_start', contentIndex: 0 })
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'look ' })
  update({ type: 'thinking_end', contentIndex: 0 })
  update({ type: 'text_delta', contentIndex: 1, delta: 'Reading.' })
  update({ type: 'toolcall_start', contentIndex: 2, id: 'r1', toolName: 'read' })
  update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"a.ts"}' })
  update({ type: 'toolcall_end', contentIndex: 2, toolCall: agentRaw[1].content[2] })
  update({ type: 'toolcall_start', contentIndex: 3, toolName: 'grep' })
  update({ type: 'toolcall_end', contentIndex: 3, toolCall: agentRaw[1].content[3] })
  emit({ type: 'message_end', message: agentRaw[1] })
  emit({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'a.ts' } })
  emit({ type: 'tool_execution_update', toolCallId: 'r1', partialResult: { content: [{ type: 'text', text: 'bo' }] } })
  emit({ type: 'tool_execution_end', toolCallId: 'r1', result: { content: agentRaw[2].content }, isError: false })
  emit({ type: 'tool_execution_start', toolCallId: 'e1', toolName: 'grep', args: { path: 'a.ts' } })
  emit({ type: 'tool_execution_end', toolCallId: 'e1', result: { content: agentRaw[3].content, details: agentRaw[3].details }, isError: true, cancelled: true })
  emit({ type: 'message_start', message: agentRaw[4] })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  update({ type: 'text_delta', contentIndex: 0, delta: 'partial' })
  emit({ type: 'message_end', message: agentRaw[5] })
  emit({ type: 'message_start', message: agentRaw[6] })
  emit({ type: 'message_start', message: { role: 'assistant' } })
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'ok' })
  update({ type: 'text_delta', contentIndex: 1, delta: 'Done' })
  emit({ type: 'message_end', message: agentRaw[7] })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const agentView = (msg) => ({ ...messageView(msg), usage: msg.usage, model: msg.model, timestamp: msg.timestamp })
  const liveAgent = (await ctl.getMessages()).map(agentView)
  const replayAgent = m.projectHistory(structuredClone(agentRaw)).map(agentView)
  assert.deepEqual(liveAgent, replayAgent, '宿主直播事件经投影器产出的 UIMessage 与刷新后回放一致')
  const added = pushes.filter((msg) => msg.ch === 'msg-add').map((msg) => msg.payload.id)
  assert.deepEqual(added, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'], '直播推送的消息 id 与回放位置编号一致')
  const endPushes = pushes.filter((msg) => msg.ch === 'msg-update' && msg.payload.patch.role === 'assistant').map((msg) => agentView(msg.payload.patch))
  assert.deepEqual(endPushes.map((msg) => msg.id), ['m1', 'm3', 'm5'])
  assert.deepEqual(endPushes[2], replayAgent[5], 'message_end 推送的整条消息与回放一致')
  const streamed = pushes.filter((msg) => msg.ch === 'msg-update' && msg.payload.id === 'm1').map((msg) => msg.payload.patch)
  assert.equal(streamed.map((patch) => patch.textDelta ?? '').join(''), 'Reading.', '流式正文增量拼接等于最终正文')
  assert.equal(streamed.map((patch) => patch.thinkingDelta ?? '').join(''), 'look ', '流式思考增量拼接等于最终思考')
  {
    const progressPushes = []
    const progressCtl = new AgentController({ push: (msg) => progressPushes.push(msg), cwd: dir })
    const progressUpdate = (assistantMessageEvent) => progressCtl.handleEvent({ type: 'message_update', assistantMessageEvent })
    progressCtl.handleEvent({ type: 'message_start', message: { role: 'user', content: 'go' } })
    progressCtl.handleEvent({ type: 'message_start', message: { role: 'assistant', model: 'claude-opus-5-5' } })
    progressUpdate({ type: 'thinking_start', contentIndex: 0 })
    progressUpdate({ type: 'thinking_delta', contentIndex: 0, delta: 'Found it.' })
    progressUpdate({ type: 'thinking_end', contentIndex: 0 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    progressUpdate({ type: 'toolcall_start', contentIndex: 1, id: 'p1', toolName: 'read' })
    const view = { text: '', thinking: '' }
    for (const msg of progressPushes) {
      if (msg.ch !== 'msg-update') continue
      const patch = msg.payload.patch
      if (patch.thinking !== undefined) view.thinking = patch.thinking
      if (patch.thinkingDelta) view.thinking += patch.thinkingDelta
      if (patch.text !== undefined) view.text = patch.text
      if (patch.textDelta) view.text += patch.textDelta
    }
    assert.ok(progressPushes.some((msg) => msg.ch === 'msg-update' && msg.payload.patch.thinkingDelta === 'Found it.'), '\u5de5\u5177\u8c03\u7528\u524d\u5148\u6309\u601d\u8003\u63a8\u9001')
    assert.deepEqual(view, { text: 'Found it.', thinking: '' }, '\u8fdb\u5ea6\u66f4\u65b0\u8f6c\u6b63\u6587\u65f6\u63a8\u9001\u5b8c\u6574\u601d\u8003\uff0c\u6e32\u67d3\u7aef\u4e0d\u6b8b\u7559\u65e7\u601d\u8003')
    await progressCtl.stop()
  }
  await ctl.stop()
  assert.deepEqual(await ctl.getMessages(), [])
  for (const via of ['abort', 'agent-settled']) {
    const stopPushes = []
    const stopping = new AgentController({ push: msg => stopPushes.push(msg), cwd: dir })
    stopping.state = { sessionId: 'stop-args', cwd: dir }
    stopping.rpc = { command: async () => ({ success: true, data: {} }) }
    stopping.refreshState = async () => undefined
    stopping.refreshStats = async () => undefined
    stopping.refreshTodos = async () => undefined
    stopping.maybeGenerateTitle = async () => undefined
    stopping.persistTurnTiming = async () => undefined
    const stopEmit = evt => stopping.handleEvent(evt)
    stopEmit({ type: 'message_start', message: { role: 'user', content: 'write files' } })
    stopEmit({ type: 'message_start', message: { role: 'assistant' } })
    stopEmit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', id: 'stopped-write', toolName: 'write', contentIndex: 0 } })
    stopEmit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"04.txt","content":"partial' } })
    stopping.items.liveToolStart({ toolCallId: 'stopped-child', toolName: 'read', parentToolCallId: 'stopped-write' }, 10)
    stopping.items.liveToolUpdate('stopped-child', { content: [{ type: 'text', text: 'partial output' }] })
    if (via === 'abort') assert.equal((await stopping.abort()).error, undefined)
    else stopEmit({ type: 'agent_settled', aborted: true })
    for (const id of ['stopped-write', 'stopped-child']) {
      const call = stopping.items.call(id)
      assert.equal(call.cancelled, true, `${via}：取消仍在生成参数及嵌套卡片`)
      assert.ok(call.endedAt)
      const pushed = stopPushes.find(msg => msg.ch === 'tool' && msg.payload.call.id === id && msg.payload.call.cancelled)
      assert.ok(pushed, `${via}：不是仅改内存，必须推送已取消的卡片`)
      assert.equal(pushed.payload.msgId, stopping.items.ownerOf(id))
    }
    assert.equal(stopping.items.call('stopped-child').output, 'partial output')
  }

  {
    const unconfirmed = new AgentController({ push() {}, cwd: dir })
    unconfirmed.state = { sessionId: 'unconfirmed-stop', cwd: dir }
    unconfirmed.rpc = { command: async command => command === 'abort' ? { success: false, error: 'stop not confirmed' } : { success: true, data: {} } }
    unconfirmed.items.appendMessage({ id: 'user-stop', role: 'user', text: 'go' })
    unconfirmed.items.appendMessage({ id: 'assistant-stop', role: 'assistant', text: '', toolCalls: [{ id: 'not-confirmed', name: 'write', status: 'running' }] })
    assert.match((await unconfirmed.abort()).error, /stop not confirmed/)
    assert.equal(unconfirmed.items.call('not-confirmed').status, 'running', '停止未确认时不伪造取消成功')
    assert.equal(unconfirmed.items.call('not-confirmed').cancelled, undefined)
  }

  console.log('session items ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
