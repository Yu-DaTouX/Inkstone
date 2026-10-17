import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let passed = 0
let failed = 0
function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

const electronStub = {
  name: 'test-electron-boundary',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-electron' }, () => ({ contents: `
      export class BrowserWindow { constructor() { throw new Error('no electron in test') } }
      export const session = { fromPartition() { throw new Error('no electron in test') } }
      export const app = {
        getLocale: () => 'zh-CN',
        getPath: (name) => (process.env.YAN_TEST_APP_DIR || process.env.YAN_DATA_DIR) + '/' + (name || 'documents')
      }
    ` }))
  }
}

async function bundle(entry, outName, platform, plugins = []) {
  const outfile = join('out', 'test', outName)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform,
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins,
    logLevel: 'silent'
  })
  return import(`${pathToFileURL(join(process.cwd(), outfile)).href}?t=${Date.now()}`)
}

const dataDir = await mkdtemp(join(tmpdir(), 'yan-pi-native-events-'))
process.env.YAN_DATA_DIR = dataDir
process.env.YAN_TEST_APP_DIR = dataDir
process.env.YAN_SESSIONS_DIR = join(dataDir, 'sessions')

try {
  const { normalizeMessage, normalizeHistory } = await bundle('src/main/normalize.ts', 'pi-native-normalize.mjs', 'node')
  const { groupIntoTurns, createTurnProjector } = await bundle('src/shared/turns.ts', 'pi-native-turns.mjs', 'neutral')
  const { NativeSessionRuntime, parseReceipt } = await bundle('src/main/native-session-runtime.ts', 'pi-native-runtime.mjs', 'node')
  const { AgentController } = await bundle('src/main/agent.ts', 'pi-native-agent.mjs', 'node', [electronStub])

  console.log('custom / branchSummary 消息归一化')
  {
    const shown = normalizeMessage({ role: 'custom', customType: 'todo', display: true, content: '**提醒**', timestamp: 5 }, 3, undefined, 'e1')
    ok(shown?.role === 'note' && shown.note?.kind === 'custom' && shown.note.customType === 'todo', 'display:true 的 custom 归为 note', shown)
    ok(shown?.text === '**提醒**' && shown.entryId === 'e1' && shown.id === 'm3', 'note 保留正文、entryId 与序号')
    const blocks = normalizeMessage({ role: 'custom', customType: 'pic', display: true, content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }] }, 0)
    ok(blocks?.text === 'a' && blocks.images?.length === 1, '数组内容取文字与图片')
    ok(normalizeMessage({ role: 'custom', customType: 'x', display: false, content: '隐藏' }, 0) === null, 'display:false 的 custom 不显示')
    ok(normalizeMessage({ role: 'custom', display: true, content: '   ' }, 0) === null, '空 custom 不显示')
    const summary = normalizeMessage({ role: 'branchSummary', summary: '之前试过 A 方案', fromId: 'x', timestamp: 9 }, 1)
    ok(summary?.role === 'note' && summary.note?.kind === 'branchSummary' && summary.text === '之前试过 A 方案', 'branchSummary 归为 note')
    ok(normalizeMessage({ role: 'branchSummary', summary: '' }, 0) === null, '空分支摘要不显示')
    const history = normalizeHistory([
      { role: 'user', content: '问' },
      { role: 'branchSummary', summary: '摘要' },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] }
    ])
    ok(history.map((m) => m.role).join(',') === 'user,note,assistant', '历史回放保留 note 的位置', history.map((m) => m.role))
  }

  console.log('会话文件回放 custom_message / branch_summary 条目')
  {
    const { readSessionMessages } = await bundle('src/main/session-reader.ts', 'pi-native-session-reader.mjs', 'node')
    const file = join(dataDir, 'replay.jsonl')
    const lines = [
      { type: 'session', version: 3, id: 'sx', timestamp: '2026-10-18T01:00:00.000Z', cwd: dataDir },
      { type: 'message', id: 'a', parentId: null, timestamp: '2026-10-18T01:00:01.000Z', message: { role: 'user', content: '问' } },
      { type: 'branch_summary', id: 'b', parentId: 'a', timestamp: '2026-10-18T01:00:02.000Z', fromId: 'z', summary: '放弃的方案：改用缓存' },
      { type: 'custom_message', id: 'c', parentId: 'b', timestamp: '2026-10-18T01:00:03.000Z', customType: 'todo', content: '还剩 2 项', display: true },
      { type: 'custom_message', id: 'd', parentId: 'c', timestamp: '2026-10-18T01:00:04.000Z', customType: 'secret', content: '不显示', display: false },
      { type: 'custom', id: 'e', parentId: 'd', timestamp: '2026-10-18T01:00:05.000Z', customType: 'state', data: { x: 1 } },
      { type: 'message', id: 'f', parentId: 'e', timestamp: '2026-10-18T01:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } }
    ]
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const read = await readSessionMessages(file)
    const rows = read?.messages ?? []
    ok(rows.map((m) => m.role).join(',') === 'user,note,note,assistant', '回放包含分支摘要与可见扩展消息', rows.map((m) => m.role))
    ok(rows[1]?.note?.kind === 'branchSummary' && rows[1].entryId === 'b', '分支摘要带 entryId')
    ok(rows[2]?.note?.customType === 'todo' && rows[2].timestamp === Date.parse('2026-10-18T01:00:03.000Z'), '扩展消息带类型与时间')
  }

  console.log('note 回合分组')
  {
    const rows = [
      { id: 'u1', role: 'user', text: '问' },
      { id: 'a1', role: 'assistant', text: '先答' },
      { id: 'n1', role: 'note', note: { kind: 'custom', customType: 'todo' }, text: '扩展提醒' },
      { id: 'a2', role: 'assistant', text: '再答' }
    ]
    const turns = groupIntoTurns(rows)
    ok(turns.map((t) => t.kind).join(',') === 'user,assistant,note,assistant', 'note 单独成回合并切开前后助手回合', turns.map((t) => t.kind))
    ok(turns[2].msg?.id === 'n1', 'note 回合携带原消息')
    const project = createTurnProjector()
    ok(JSON.stringify(project(rows)) === JSON.stringify(turns), '缓存投影与完整分组同口径')
  }

  console.log('原生桥 model_select 收据')
  {
    const signals = []
    const runtime = new NativeSessionRuntime({ command: async () => ({ success: true }) }, undefined, (receipt) => signals.push(receipt))
    const ext = await import(`${pathToFileURL(join(process.cwd(), 'resources', 'pi-extensions', 'native-session-bridge.js')).href}?t=${Date.now()}`)
    const handlers = {}
    const notes = []
    const prev = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    ext.default({ on: (name, fn) => { handlers[name] = fn }, registerCommand: () => undefined })
    process.env.YAN_NATIVE_BRIDGE = prev
    ok(typeof handlers.model_select === 'function', '桥扩展监听 model_select')
    handlers.model_select({ model: { provider: 'p', id: 'm2' }, source: 'set' }, { ui: { notify: (message) => notes.push(message) } })
    const receipt = parseReceipt(notes[0])
    ok(receipt?.op === 'model_select' && receipt.result?.id === 'm2', '桥扩展经收据转发换模型', notes[0])
    ok(runtime.handleUi({ method: 'notify', message: notes[0] }) === true, '收据被原生运行时吞掉，不进通知')
    ok(signals.length === 1 && signals[0].op === 'model_select', '未登记的收据交给信号回调')
  }

  console.log('原生桥分支摘要与书签')
  {
    const ext = await import(`${pathToFileURL(join(process.cwd(), 'resources', 'pi-extensions', 'native-session-bridge.js')).href}?t=${Date.now()}-tree`)
    const handlers = {}
    const commands = {}
    const labels = []
    const navigations = []
    const prev = process.env.YAN_NATIVE_BRIDGE
    process.env.YAN_NATIVE_BRIDGE = '1'
    ext.default({
      on: (name, fn) => { handlers[name] = fn },
      registerCommand: (name, def) => { commands[name] = def },
      setLabel: (id, label) => labels.push([id, label])
    })
    process.env.YAN_NATIVE_BRIDGE = prev
    const timeouts = []
    let runtime
    const ctx = {
      ui: { notify: (message) => runtime.handleUi({ method: 'notify', message }) },
      isIdle: () => true,
      navigateTree: async (id, options) => { navigations.push([id, options]); return { cancelled: false } },
      sessionManager: { getLeafId: () => 'leaf', getBranch: () => [{ id: 'leaf' }], getSessionFile: () => 'f.jsonl' }
    }
    const transport = {
      command: async (_type, { message }, opts) => {
        timeouts.push(opts?.timeoutMs)
        const [name, ...rest] = message.slice(1).split(' ')
        await commands[name].handler(rest.join(' '), ctx)
        return { success: true, data: { disposition: 'handled' } }
      }
    }
    runtime = new NativeSessionRuntime(transport)
    handlers.session_start({ reason: 'startup' }, ctx)
    ok(runtime.bridgeCapabilities.includes('set_label') && runtime.bridgeCapabilities.includes('navigate_tree_summary'), '桥报到含 set_label 能力')
    await runtime.navigateTree('e1')
    await runtime.navigateTree('e2', { summarize: true })
    ok(navigations[0][1].summarize === false && navigations[1][1].summarize === true, 'navigate_tree 按请求决定是否摘要', navigations)
    ok(timeouts[1] >= 300000 && timeouts[0] < timeouts[1], '摘要切换放宽超时到 5 分钟', timeouts)
    const set = await runtime.setLabel('e1', '  里程碑  ')
    await runtime.setLabel('e1', '')
    ok(set.label === '里程碑' && labels[0][1] === '里程碑' && labels[1][1] === undefined, 'set_label 去空格写入、空值清除', labels)
  }

  console.log('原生会话请求校验')
  {
    const { validateNativeSessionRequest } = await bundle('src/main/native-session-guard.ts', 'pi-native-guard.mjs', 'node')
    const idle = { sessionId: 's1', isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0, cwd: '' }
    ok(validateNativeSessionRequest({ action: 'set-label', expectedSessionId: 's1', entryId: 'e1', label: 'x' }, idle).ok, '书签请求通过校验')
    ok(!validateNativeSessionRequest({ action: 'set-label', expectedSessionId: 's1', label: 'x' }, idle).ok, '书签请求缺 entryId 被拒')
    ok(!validateNativeSessionRequest({ action: 'set-label', expectedSessionId: 's1', entryId: 'e1', label: 'x'.repeat(201) }, idle).ok, '书签名过长被拒')
    ok(!validateNativeSessionRequest({ action: 'set-label', expectedSessionId: 's1', entryId: 'e1', label: 'x' }, { ...idle, isAgentRunning: true }).ok, '运行中不能改书签')
    ok(!validateNativeSessionRequest({ action: 'navigate', expectedSessionId: 's1', entryId: 'e1', summarize: 'yes' }, idle).ok, 'summarize 必须是布尔值')
  }

  console.log('事件处理')
  {
    const pushes = []
    const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
    ctl.state = { sessionId: 's-1' }
    const titles = () => pushes.filter((m) => m.ch === 'session-title')

    ctl.handleEvent({ type: 'session_info_changed', name: '  扩展起的名  ' })
    ok(titles().length === 1 && titles()[0].payload.sessionId === 's-1' && titles()[0].payload.title === '扩展起的名', 'session_info_changed 推送 session-title', titles())
    ctl.handleEvent({ type: 'session_info_changed' })
    ok(titles().length === 1, '名字被清除时不改砚标题')

    ctl.handleEvent({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' })
    const retry = pushes.filter((m) => m.ch === 'notify').at(-1)
    ok(retry?.payload.notifyType === 'warning' && /分支摘要失败（terminated），2 秒后第 1\/3 次重试/.test(retry.payload.message), '摘要重试提示含原因、延时与次数', retry?.payload.message)
    ctl.handleEvent({ type: 'compaction_start', reason: 'threshold' })
    ctl.handleEvent({ type: 'summarization_retry_scheduled', attempt: 2, maxAttempts: 3, delayMs: 500 })
    const compactRetry = pushes.filter((m) => m.ch === 'notify').at(-1)
    ok(/^压缩失败，1 秒后第 2\/3 次重试/.test(compactRetry?.payload.message ?? ''), '压缩中重试标为压缩、无原因时不留空括号', compactRetry?.payload.message)
    const before = pushes.length
    ctl.handleEvent({ type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold' })
    ctl.handleEvent({ type: 'summarization_retry_finished' })
    ok(pushes.slice(before).every((m) => m.ch !== 'notify'), '重试开始与结束不刷屏')

    const custom = { role: 'custom', customType: 'todo', display: true, content: '直播提醒', timestamp: 1 }
    ctl.handleEvent({ type: 'message_start', message: custom })
    const added = pushes.filter((m) => m.ch === 'msg-add').at(-1)
    ok(added?.payload.role === 'note' && added.payload.text === '直播提醒', '直播 custom 消息推 msg-add note', added?.payload)
    const count = pushes.filter((m) => m.ch === 'msg-add').length
    ctl.handleEvent({ type: 'message_start', message: { ...custom, display: false } })
    ok(pushes.filter((m) => m.ch === 'msg-add').length === count, '直播 display:false 不推')

    let threw = false
    try {
      ctl.handleEvent({ type: 'entry_appended', entry: { type: 'usage', kind: 'cache_warm' } })
      ctl.handleEvent({ type: 'entry_appended', entry: { type: 'custom', customType: 'x' } })
    } catch {
      threw = true
    }
    ok(!threw, 'entry_appended 不抛错')
  }
  console.log('自动重试进度')
  {
    const pushes = []
    const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
    ctl.state = { sessionId: 's1', isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0, cwd: process.cwd() }
    const states = () => pushes.filter((m) => m.ch === 'state').map((m) => m.payload)
    ctl.handleEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '500 Internal Server Error' })
    const started = states().at(-1)?.retry
    ok(started?.attempt === 2 && started.maxAttempts === 3 && started.delayMs === 4000 && started.at > 0, 'auto_retry_start 写入 state.retry', started)
    ctl.handleEvent({ type: 'auto_retry_end', success: true, attempt: 2 })
    ok(states().at(-1)?.retry === undefined, 'auto_retry_end 清除 state.retry')
    ctl.handleEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: '500' })
    const count = states().length
    ctl.handleEvent({ type: 'agent_settled' })
    ok(states().length > count && states().at(-1)?.retry === undefined, 'agent_settled 清除 state.retry')
    const quiet = states().length
    ctl.handleEvent({ type: 'auto_retry_end', success: true })
    ok(states().length === quiet, '没有重试时结束事件不重复推 state')
  }
  console.log('切换会话时的扩展挂件与状态')
  {
    const pushes = []
    const ctl = new AgentController({ push: (m) => pushes.push({ ...m, sid: ctl.state?.sessionId }), cwd: process.cwd() })
    let switchTo = 's-new'
    let cancel = false
    const ui = (req) => ctl.ui.handleUi(req)
    ctl.rpc = {
      command: async (type) => {
        if (type === 'switch_session') {
          ui({ method: 'setWidget', widgetKey: 'old-only', widgetLines: undefined })
          if (cancel) {
            ui({ method: 'setStatus', statusKey: 'build', statusText: '取消后仍更新' })
            return { success: true, data: { cancelled: true } }
          }
          ui({ method: 'setWidget', widgetKey: 'tests', widgetLines: ['12/15 通过'], widgetPlacement: 'belowEditor' })
          ui({ method: 'setStatus', statusKey: 'build', statusText: '新会话构建中' })
          return { success: true, data: {} }
        }
        if (type === 'get_state') return { success: true, data: { sessionId: switchTo, thinkingLevel: 'off', isStreaming: false, messageCount: 0 } }
        if (type === 'get_messages') return { success: true, data: { messages: [] } }
        return { success: true, data: {} }
      },
      on: () => undefined
    }
    ctl.state = { sessionId: 's-old' }
    ui({ method: 'setWidget', widgetKey: 'old-only', widgetLines: ['旧会话挂件'] })
    ui({ method: 'setWidget', widgetKey: 'tests', widgetLines: ['旧测试'] })
    ui({ method: 'setStatus', statusKey: 'build', statusText: '旧状态' })
    ui({ method: 'setStatus', statusKey: 'legacy', statusText: '新会话不再设置' })
    const baseline = pushes.length
    const res = await ctl.switchSession('x.jsonl')
    const after = pushes.slice(baseline).filter((m) => m.ch === 'widget' || m.ch === 'status')
    ok(res.ok, '假 rpc 切换成功', res)
    ok(after.length > 0 && after.every((m) => m.sid === 's-new'), '切换期间的挂件在归属新会话后才补发', after.map((m) => [m.ch, m.payload.key, m.sid]))
    const tests = after.find((m) => m.ch === 'widget' && m.payload.key === 'tests')
    ok(tests?.payload.lines?.[0] === '12/15 通过' && tests.payload.placement === 'belowEditor', '新会话挂件内容与位置补发正确')
    ok(after.some((m) => m.ch === 'widget' && m.payload.key === 'old-only' && !m.payload.lines?.length), '旧会话独有挂件补发删除')
    ok(after.some((m) => m.ch === 'status' && m.payload.key === 'build' && m.payload.text === '新会话构建中'), '状态补发为新会话的值')
    ok(after.some((m) => m.ch === 'status' && m.payload.key === 'legacy' && m.payload.text === undefined), '新会话未触及的旧状态补发清除')

    cancel = true
    switchTo = 's-new'
    const beforeCancel = pushes.length
    ui({ method: 'setWidget', widgetKey: 'keep', widgetLines: ['保留'] })
    const cancelled = await ctl.switchSession('y.jsonl')
    const afterCancel = pushes.slice(beforeCancel).filter((m) => m.ch === 'widget' || m.ch === 'status')
    ok(!cancelled.ok, '扩展取消切换返回失败')
    ok(afterCancel.some((m) => m.ch === 'status' && m.payload.text === '取消后仍更新'), '取消时不丢期间的更新')
    ok(!afterCancel.some((m) => m.ch === 'widget' && m.payload.key === 'keep' && !m.payload.lines?.length), '取消时不删当前会话的挂件')
  }
  console.log('原生模型与思考循环')
  {
    const ctl = new AgentController({ push: () => undefined, cwd: process.cwd() })
    const calls = []
    const ring = ['a', 'b', 'c']
    let at = 0
    let scoped = []
    let thinking = { level: 'high' }
    ctl.rpc = {
      command: async (type) => {
        calls.push(type)
        if (type === 'cycle_model') {
          if (ring.length < 2) return { success: true, data: null }
          at = (at + 1) % ring.length
          return { success: true, data: { model: { provider: 'p', id: ring[at], name: `模型${ring[at].toUpperCase()}` }, thinkingLevel: 'off', isScoped: false } }
        }
        if (type === 'cycle_thinking_level') return { success: true, data: thinking }
        if (type === 'get_available_models') return { success: true, data: { models: ['a', 'b', 'c', 'x'].map((id) => ({ provider: 'p', id, name: id })) } }
        if (type === 'get_state') return { success: true, data: { sessionId: 's', thinkingLevel: 'off' } }
        return { success: true, data: {} }
      },
      on: () => undefined
    }
    ctl.nativeRuntime = { getScopedModels: async () => ({ scopedModels: scoped, enabledModels: [], scopeIsAll: !scoped.length }) }
    const version = () => ctl.loopGuardContinuationVersion

    let v0 = version()
    const forward = await ctl.cycleModel()
    ok(forward.ok && forward.to === '模型B' && calls.filter((c) => c === 'cycle_model').length === 1, '下一个模型走一次原生 cycle_model', forward)
    ok(!calls.includes('set_model'), '不再自己调 set_model')
    ok(version() === v0 + 1, '换模型递增续跑版本号')

    calls.length = 0
    at = 1
    scoped = ['a', 'b', 'c', 'gone'].map((id) => ({ key: `p/${id}`, provider: 'p', id, name: id }))
    v0 = version()
    const back = await ctl.cycleModelBack()
    ok(back.ok && back.to === '模型A' && calls.filter((c) => c === 'cycle_model').length === 2, '上一个模型按可用 scoped 数连续前进 N-1 次', { back, calls })
    ok(version() === v0 + 1, '上一个模型只递增一次版本号')

    calls.length = 0
    scoped = []
    at = 0
    await ctl.cycleModelBack()
    ok(calls.filter((c) => c === 'cycle_model').length === 3, '无 scoped 时按全部可用模型数计算步数')

    ring.length = 1
    const single = await ctl.cycleModel()
    ok(!single.ok && single.error === '只有一个可用模型', 'cycle_model 返回 null 时提示只有一个模型')

    v0 = version()
    const level = await ctl.cycleThinking()
    ok(level.ok && level.to === 'high' && calls.includes('cycle_thinking_level'), '思考循环走原生 cycle_thinking_level', level)
    ok(version() === v0 + 1, '换思考档位递增续跑版本号')
    thinking = null
    const none = await ctl.cycleThinking()
    ok(!none.ok && none.error === '当前模型不支持思考', 'cycle_thinking_level 返回 null 时提示不支持思考')
  }

  {
    const { piRuntimePrefsOf, readPiRuntimePrefs } = await bundle('src/main/pi-runtime-prefs.ts', 'pi-native-prefs.mjs', 'node', [electronStub])
    const defaults = piRuntimePrefsOf({})
    ok(defaults.autoRetry === true && defaults.steeringMode === 'one-at-a-time' && defaults.followUpMode === 'one-at-a-time', 'pi 设置缺省时重试开、投递逐条', defaults)
    const custom = piRuntimePrefsOf({ retry: { enabled: false }, steeringMode: 'all', followUpMode: 'bogus' })
    ok(custom.autoRetry === false && custom.steeringMode === 'all' && custom.followUpMode === 'one-at-a-time', '读取 retry.enabled 与投递模式，未知值回落逐条', custom)
    const missing = await readPiRuntimePrefs(join(dataDir, 'no-such-settings.json'))
    ok(missing.autoRetry === true, '设置文件缺失时回落缺省')
  }

  console.log('原生 MCP 操作结果识别')
  {
    const { isNativeMcpActionResult, isNativeMcpSignInPrompt, isNativeMcpStatus } = await bundle('src/renderer/src/lib/native-mcp-status.ts', 'pi-native-mcp-status.mjs', 'neutral')
    ok(isNativeMcpActionResult('Reconnected to MCP server "docs" (connected).'), '识别重连结果')
    ok(isNativeMcpActionResult('Signed out of MCP server "docs".') && isNativeMcpActionResult('No stored credentials for MCP server "docs".'), '识别登出结果')
    ok(isNativeMcpActionResult('Sign-in cancelled.') && isNativeMcpActionResult('No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.'), '识别取消与不支持 OAuth')
    ok(!isNativeMcpActionResult('已切换模型'), '无关通知不截获')
    ok(isNativeMcpSignInPrompt('Sign in to MCP server "docs" in your browser:\nhttps://auth.example/x'), '识别浏览器登录提示，继续等结果')
    ok(!isNativeMcpStatus('Reconnected to MCP server "docs" (connected).'), '状态查询不误收操作结果')
  }

} finally {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

console.log(`\n${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
