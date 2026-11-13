import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'
import * as mode from '../resources/pi-extensions/session-mode.js'
import { GIT_INSPECT_TOOL, WEB_DOCS_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../resources/pi-extensions/readonly-tools.js'

function fakePi() {
  const handlers = new Map()
  const registered = []
  return {
    handlers,
    registered,
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerTool(tool) {
      registered.push(tool.name)
    },
    async emit(name, event, ctx) {
      let result
      for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result
      return result
    }
  }
}

const marker = (value) => ({ type: 'custom_message', customType: mode.SESSION_MODE_TYPE, details: { mode: value } })
const user = { type: 'message', message: { role: 'user', content: 'hi' } }

await runSuite(import.meta.url, async (ok, compile) => {
  const readonlyNames = [GIT_INSPECT_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_DOCS_TOOL].map((tool) => tool.name)
  ok(JSON.stringify(mode.READ_TOOLS) === JSON.stringify(['read', 'grep', 'find', 'ls', ...readonlyNames]), '读类白名单 = 内置读工具 + readonly-tools.js 的工具定义', mode.READ_TOOLS.join(','))

  for (const active of ['ask', 'plan']) {
    for (const tool of [...mode.READ_TOOLS, 'todos', 'question', 'codemode']) ok(!mode.blocksTool(active, tool), `${active}：放行 ${tool}`)
    for (const tool of ['bash', 'write', 'edit', 'multi_edit', 'apply_patch', 'powershell', 'tool_search', 'phone_ui', 'mcp__github__create_issue', 'some_future_tool', undefined]) {
      ok(mode.blocksTool(active, tool), `${active}：拦下 ${tool ?? '无名工具'}（未知即拦）`)
    }
  }
  for (const idle of ['off', 'approved', undefined]) {
    for (const tool of ['bash', 'write', 'edit', 'some_future_tool']) ok(!mode.blocksTool(idle, tool), `${idle ?? '未设'}：不拦 ${tool}`)
  }
  ok(mode.blockReason('ask') === mode.ASK_BLOCK && /Read-only mode/.test(mode.ASK_BLOCK) && /nothing ran/.test(mode.ASK_BLOCK), '只读模式的拦截说明')
  ok(mode.blockReason('plan') === mode.PLAN_BLOCK && /Approve button/.test(mode.PLAN_BLOCK), '计划模式的拦截说明指向批准按钮')
  ok(!/never|guarantee|cannot change/i.test(mode.ASK_BLOCK + mode.PLAN_BLOCK), '拦截说明不承诺绝对不改动')

  ok(mode.lastAnnouncement([]) === 'off', '没有记录视为关闭')
  ok(mode.lastAnnouncement([user, marker('plan'), user]) === 'plan', '取最近一次模式记录')
  ok(mode.lastAnnouncement([marker('ask'), { type: 'compaction' }, user]) === 'off', '压缩后视为未通告')

  const pick = (current, last) => mode.chooseReminder(current, last)?.mode
  ok(pick('ask', 'off') === 'ask', '开启只读时通告一次')
  ok(pick('ask', 'ask') === undefined, '只读已通告不重复')
  ok(pick('plan', 'off') === 'plan' && pick('plan', 'ask') === 'plan', '开启计划时通告指引')
  ok(pick('plan', 'plan') === undefined, '计划已通告不重复')
  ok(pick('approved', 'plan') === 'approved', '批准后通告按计划执行')
  ok(pick('approved', 'approved') === undefined, '批准通告只发一次')
  ok(pick('off', 'ask') === 'off' && pick('off', 'plan') === 'off', '退出模式通告一次')
  ok(pick('off', 'off') === undefined && pick('off', 'approved') === undefined && pick('approved', 'off') === undefined, '未开启时不加任何消息')
  const planText = mode.chooseReminder('plan', 'off').text
  ok(/step-by-step plan/.test(planText) && /todos tool/.test(planText) && /stop and wait/.test(planText), '计划指引要求分步计划、写进待办并停下等批准')
  ok(/approved the plan/.test(mode.chooseReminder('approved', 'plan').text), '批准通告要求按计划执行')

  const dir = mkdtempSync(join(tmpdir(), 'yan-session-mode-'))
  try {
    const env = { YAN_DATA_DIR: dir, YAN_RUNNER_ID: 's1', YAN_SESSION_ID: 's1' }
    const file = join(dir, mode.SESSION_MODE_FILE)
    const pi = fakePi()
    mode.default(pi, env)
    ok([...pi.handlers.keys()].sort().join(',') === 'before_agent_start,tool_call', '只挂 before_agent_start 与 tool_call，不改请求体')
    ok(pi.registered.length === 0, '不注册工具，工具表不变')
    const ctx = (branch = []) => ({ sessionManager: { getSessionId: () => 's1', getBranch: () => branch } })

    ok(await pi.emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf x' } }, ctx()) === undefined, '没有状态文件时放行全部')
    ok(await pi.emit('before_agent_start', { prompt: 'hi' }, ctx()) === undefined, '没有状态文件时不加消息')

    writeFileSync(file, JSON.stringify({ other: 'ask' }))
    ok(await pi.emit('tool_call', { toolName: 'write' }, ctx()) === undefined, '别的会话开着只读不影响本会话')

    writeFileSync(file, JSON.stringify({ s1: 'ask' }))
    const blocked = await pi.emit('tool_call', { toolName: 'bash', input: { command: 'yan subagent start --task x' } }, ctx())
    ok(blocked?.block === true && blocked.reason === mode.ASK_BLOCK, '只读模式拦下 bash（含 yan 命令）')
    ok(await pi.emit('tool_call', { toolName: 'read', input: { path: 'a' } }, ctx()) === undefined, '只读模式放行 read')
    ok((await pi.emit('tool_call', { toolName: 'write', parentToolCallId: 'cm1' }, ctx()))?.block === true, 'codemode 里的写调用同样被拦')
    const askMessage = await pi.emit('before_agent_start', { prompt: 'hi' }, ctx())
    ok(askMessage?.message?.customType === mode.SESSION_MODE_TYPE && askMessage.message.display === false && askMessage.message.details.mode === 'ask', '只读通告是隐藏消息')
    ok(askMessage.systemPrompt === undefined, '不改系统提示')
    ok(await pi.emit('before_agent_start', { prompt: 'x', messageType: 'custom' }, ctx()) === undefined, '自定义消息触发的轮次不通告')

    writeFileSync(file, JSON.stringify({ s1: 'plan' }))
    ok((await pi.emit('tool_call', { toolName: 'edit' }, ctx()))?.reason === mode.PLAN_BLOCK, '计划模式拦下 edit')
    ok(await pi.emit('tool_call', { toolName: 'todos' }, ctx()) === undefined, '计划模式放行 todos（计划写进待办面板）')
    ok((await pi.emit('before_agent_start', { prompt: 'p' }, ctx([marker('ask')])))?.message?.details?.mode === 'plan', '从只读切到计划时发计划指引')

    writeFileSync(file, JSON.stringify({ s1: 'approved' }))
    ok(await pi.emit('tool_call', { toolName: 'bash' }, ctx()) === undefined, '批准后撤掉拦截')
    ok((await pi.emit('before_agent_start', { prompt: 'go' }, ctx([marker('plan')])))?.message?.details?.mode === 'approved', '批准后下一轮通告按计划执行')
    ok(await pi.emit('before_agent_start', { prompt: 'go' }, ctx([marker('approved')])) === undefined, '批准通告之后不再加消息')

    writeFileSync(file, '{broken')
    ok(await pi.emit('tool_call', { toolName: 'bash' }, ctx()) === undefined, '状态文件损坏时按关闭处理')

    const forkPi = fakePi()
    mode.default(forkPi, { ...env, YAN_RUNNER_KIND: 'fork' })
    ok(forkPi.handlers.size === 0, 'fork 子代理不加载模式拦截')
    const subPi = fakePi()
    mode.default(subPi, { ...env, YAN_RUNNER_ID: 'sub-1' })
    ok(subPi.handlers.size === 0, '运行 ID 与会话不同的子代理不加载模式拦截')

    const shared = await compile('src/shared/session-mode.ts')
    ok(shared.SESSION_MODE_FILE === mode.SESSION_MODE_FILE, '主进程与扩展使用同一个状态文件名')
    ok(shared.nextStoredMode(undefined, 'ask') === 'ask' && shared.nextStoredMode('plan', 'ask') === 'ask', '切到只读')
    ok(shared.nextStoredMode('plan', 'approve') === 'approved', '计划模式下批准')
    ok(shared.nextStoredMode('ask', 'approve') === null && shared.nextStoredMode(undefined, 'approve') === null, '不在计划模式时批准无效')
    ok(shared.nextStoredMode('ask', 'off') === undefined && shared.nextStoredMode('plan', 'off') === undefined, '退出模式')
    ok(shared.nextStoredMode('approved', 'off') === 'approved', '批准后再退出保留待发的执行通告')
    ok(JSON.stringify(shared.sessionModeState(undefined)) === '{}' && JSON.stringify(shared.sessionModeState('approved')) === '{}', '关闭与已批准时会话状态不带模式字段')
    ok(shared.sessionModeState('plan').sessionMode === 'plan', '开启时会话状态带模式字段')
    ok(shared.isSessionModeChange('approve') && !shared.isSessionModeChange('delete'), '只接受四种切换')

    const store = await compile('src/main/session-modes.ts')
    const stateFile = join(dir, 'main-modes.json')
    writeFileSync(stateFile, JSON.stringify({ stale: 'ask' }))
    const modes = store.createSessionModes(stateFile)
    modes.clearStale()
    ok(!existsSync(stateFile), '主进程启动后第一次启动 pi 前清掉上次留下的模式（重启后默认关闭）')
    modes.set('s1', 'plan')
    ok(JSON.parse(readFileSync(stateFile, 'utf8')).s1 === 'plan' && modes.get('s1') === 'plan', '设置后写入状态文件')
    modes.set('s2', 'ask')
    modes.set('s1', undefined)
    ok(JSON.stringify(JSON.parse(readFileSync(stateFile, 'utf8'))) === '{"s2":"ask"}', '会话之间互不影响')
    ok(modes.get('s3') === undefined, '新会话默认关闭')
    modes.set('s2', undefined)
    ok(!existsSync(stateFile), '全部关闭后删掉状态文件')

    const { submitComposerInput } = await compile('src/renderer/src/lib/composer-submit.ts')
    const submit = async (text, sessionMode, result = true) => {
      const calls = { modes: [], sent: [], restored: null }
      const port = {
        text,
        attachments: [],
        commands: [{ name: 'ask', source: 'yan', executable: true }, { name: 'plan', source: 'yan', executable: true }],
        models: [],
        t: (key) => key,
        actions: { setSessionMode: async (change) => { calls.modes.push(change); return result }, notify: () => {} },
        session: { sessionId: 's1', ...(sessionMode ? { sessionMode } : {}) },
        thinkingLevels: [],
        roundRunning: false,
        isCompacting: false,
        clearText: () => {},
        clearAll: () => {},
        restoreText: (raw) => { calls.restored = raw },
        restoreAttachments: () => {},
        readAttachments: () => [],
        send: async (outgoing) => { calls.sent.push(outgoing); return true },
        holdSend: () => {},
        focusComposer: () => {}
      }
      calls.outcome = await submitComposerInput(port)
      return calls
    }
    const askOn = await submit('/ask')
    ok(askOn.modes.join() === 'ask' && askOn.sent.length === 0, '/ask 开启只读模式，不发消息')
    const askOff = await submit('/ask', 'ask')
    ok(askOff.modes.join() === 'off', '只读模式下再发 /ask 退出')
    const planTask = await submit('/plan 重构登录流程', undefined)
    ok(planTask.modes.join() === 'plan' && planTask.sent.join() === '重构登录流程', '/plan <任务> 先开计划模式再把任务发出去')
    const planAgain = await submit('/plan 再细一点', 'plan')
    ok(planAgain.modes.length === 0 && planAgain.sent.join() === '再细一点', '已在计划模式时 /plan <任务> 直接发任务')
    const failed = await submit('/ask', undefined, false)
    ok(failed.restored === '/ask' && failed.sent.length === 0, '切换失败时恢复输入框文字')
    const failedTask = await submit('/plan 任务', undefined, false)
    ok(failedTask.sent.length === 0, '切换失败时不发出任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
