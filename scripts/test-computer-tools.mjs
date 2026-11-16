import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const computer = await import(new URL('../resources/pi-extensions/computer-tools.js', import.meta.url))
const guide = await import(new URL('../resources/pi-extensions/capability-guide.js', import.meta.url))

const WINDOWS_MCP_089_PARAMS = {
  Snapshot: ['use_vision', 'use_dom', 'use_annotation', 'use_ui_tree', 'width_reference_line', 'height_reference_line', 'display', 'region', 'save_path'],
  Screenshot: ['use_annotation', 'width_reference_line', 'height_reference_line', 'display', 'region', 'save_path'],
  DisplayInventory: [],
  Click: ['loc', 'label', 'button', 'clicks'],
  Type: ['text', 'loc', 'label', 'clear', 'caret_position', 'press_enter'],
  Scroll: ['loc', 'label', 'type', 'direction', 'wheel_times'],
  Move: ['loc', 'label', 'drag', 'from_loc', 'duration'],
  Shortcut: ['shortcut'],
  Wait: ['duration'],
  WaitFor: ['condition', 'text', 'window_name', 'timeout', 'interval', 'use_dom'],
  App: ['mode', 'name', 'window_loc', 'window_size', 'executable', 'args', 'cwd'],
  MultiSelect: ['locs', 'labels', 'press_ctrl'],
  MultiEdit: ['locs', 'labels'],
  ControlStatus: ['release']
}

const hostEnv = { YAN_RUNNER_ID: 'primary', YAN_CLI_URL: 'http://127.0.0.1:1/', YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' }
const signal = new AbortController().signal
const root = await mkdtemp(join(tmpdir(), 'inkstone-computer-tools-'))
const originalEnv = { ...process.env }
const restoreEnv = () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
}

try {
  const calls = []
  const tools = computer.createComputerTools(async (input) => {
    calls.push(input)
    return { ok: true, summary: { kind: 'mcp' }, data: { text: '["line1\\nline2"]\n[Image image/png saved to: C:/r/a.png.]', toolError: false, images: ['C:/r/a.png'] } }
  })
  assert.deepEqual(tools.map((tool) => tool.name), [
    'computer_snapshot', 'computer_screenshot', 'computer_displays', 'computer_click', 'computer_type', 'computer_scroll', 'computer_move',
    'computer_shortcut', 'computer_wait', 'computer_wait_for', 'computer_app', 'computer_multi_select', 'computer_multi_edit', 'computer_control'
  ])
  assert.ok(tools.every((tool) => tool.exposure === 'deferred'), '电脑工具全部按需加载，不进固定前缀')
  assert.ok(tools.every((tool) => tool.parameters.type === 'object' && tool.parameters.additionalProperties === false))

  for (const tool of tools) {
    await tool.execute(`tc-${tool.name}`, {}, signal, undefined, { cwd: 'C:/w' })
  }
  const mcpTools = calls.map((call) => call.params.tool)
  assert.deepEqual(new Set(mcpTools), new Set(Object.keys(WINDOWS_MCP_089_PARAMS)), '覆盖 windows-mcp 白名单工具与 ControlStatus')
  assert.ok(calls.every((call) => call.command === 'mcp.call' && call.params.server === 'windows-mcp' && call.cwd === 'C:/w'), '全部经宿主 mcp.call（含审批）调用 windows-mcp')
  for (const tool of tools) {
    const name = calls.find((call) => call.toolCallId === `tc-${tool.name}`).params.tool
    const allowed = WINDOWS_MCP_089_PARAMS[name]
    const extra = Object.keys(tool.parameters.properties).filter((key) => !allowed.includes(key))
    assert.deepEqual(extra, [], `${tool.name} 只暴露 windows-mcp 0.8.9 的 ${name} 参数`)
    assert.ok(!('save_path' in tool.parameters.properties), `${tool.name} 不暴露 save_path，图片仍由宿主落盘`)
    for (const key of tool.parameters.required ?? []) assert.ok(allowed.includes(key))
  }

  calls.length = 0
  const click = tools.find((tool) => tool.name === 'computer_click')
  const clicked = await click.execute('tc-1', { loc: [10, 20], clicks: 2 }, signal, undefined, { cwd: 'C:/w' })
  assert.deepEqual(calls[0].params, { server: 'windows-mcp', tool: 'Click', arguments: { loc: [10, 20], clicks: 2 }, via: 'computer_click' })
  assert.equal(calls[0].toolCallId, 'tc-1')
  assert.equal(clicked.content[0].text, 'line1\nline2\n[Image image/png saved to: C:/r/a.png.]', 'windows-mcp 的 JSON 字符串数组展开成原文，图片路径保留')
  assert.deepEqual(clicked.details.images, ['C:/r/a.png'])
  assert.equal(clicked.isError, undefined)

  assert.equal(computer.computerResult({ ok: true, data: { text: '{"code": "USER_CONTROL"}', toolError: true } }).isError, true, 'windows-mcp 报错原样回给模型并标错')
  assert.equal(computer.computerResult({ ok: false, error: '没有得到用户确认', code: 'mcp_call_denied' }).isError, true, '审批拒绝标错')
  assert.match(computer.computerResult({ ok: false, error: 'x', code: 'mcp_call_denied' }).content[0].text, /^Computer action failed: x$/)
  assert.equal(computer.computerResult({ ok: false, cancelled: true }).isError, undefined, '取消不算错误')
  assert.equal(computer.computerResult({ ok: true, data: { text: '[not json' } }).content[0].text, '[not json')
  assert.equal(computer.computerResult({ ok: true, summary: { a: 1 } }).content[0].text, '{"a":1}')

  const serversFile = join(root, 'mcp-servers.json')
  process.env.YAN_MCP_SERVERS_FILE = serversFile
  await writeFile(serversFile, JSON.stringify({ servers: [{ id: 'windows-mcp', enabled: false }] }))
  assert.equal(computer.computerUseEnabled(), false, '停用的条目不算启用')
  await writeFile(serversFile, JSON.stringify([{ id: 'windows-mcp' }]))
  assert.equal(computer.computerUseEnabled(), true, '数组形式且未写 enabled 视为启用')

  const register = () => {
    const seen = []
    computer.default({ registerTool: (tool) => seen.push(tool.name) })
    return seen
  }
  assert.equal(register().length, 0, '没有宿主入口（子代理）不注册')
  Object.assign(process.env, hostEnv)
  assert.equal(register().length, process.platform === 'win32' ? 14 : 0, 'Windows 上开启电脑操作时注册全部工具')
  await writeFile(serversFile, JSON.stringify([]))
  assert.equal(register().length, 0, '没开电脑操作不注册')
  await writeFile(serversFile, JSON.stringify([{ id: 'windows-mcp' }]))

  const vision = { input: ['text', 'image'] }
  const textOnly = { input: ['text'] }
  const toolGuide = guide.computerUseGuide(vision, true)
  assert.match(toolGuide, /`tool_search` "computer"/)
  assert.match(toolGuide, /computer_snapshot \(use_vision=false\)/)
  assert.match(toolGuide, /call computer_screenshot .* only when you need to see the picture/)
  assert.match(toolGuide, /computer_control with release=true/)
  assert.doesNotMatch(toolGuide, /yan mcp|call\.json/, '有原生工具时不再要求写 call.json')
  const toolText = guide.computerUseGuide(textOnly, true)
  assert.match(toolText, /never call computer_screenshot/)
  assert.doesNotMatch(toolText, /read tool/)
  const cliGuide = guide.computerUseGuide(vision)
  assert.match(cliGuide, /yan mcp call --request-file call\.json/, '没有原生工具时保留 yan mcp 路线')
  assert.match(cliGuide, /Snapshot \(use_vision=false\)/)
  assert.match(cliGuide, /ControlStatus with release=true/)
  assert.equal(guide.COMPUTER_USE_GUIDE, cliGuide)

  const hookFor = (allTools) => {
    let hook
    guide.default({
      registerTool: () => {},
      on: (name, fn) => { if (name === 'before_agent_start') hook = fn },
      getActiveTools: () => ['read', 'tool_search'],
      getAllTools: () => allTools.map((name) => ({ name }))
    })
    return hook
  }
  const withTools = {}
  hookFor(['tool_search', 'computer_snapshot'])({ systemPrompt: 'BASE', systemPromptOptions: { sections: withTools } }, { model: vision })
  assert.equal(withTools.inkstone_computer_use, toolGuide, '工具已注册且有 tool_search 时提示指向 computer_* 工具')
  const withoutTools = {}
  hookFor(['tool_search'])({ systemPrompt: 'BASE', systemPromptOptions: { sections: withoutTools } }, { model: vision })
  assert.equal(withoutTools.inkstone_computer_use, cliGuide, '工具没注册（会话中途才开启）时退回 yan mcp 说明')
  await writeFile(serversFile, JSON.stringify([]))
  const disabled = {}
  hookFor(['tool_search', 'computer_snapshot'])({ systemPrompt: 'BASE', systemPromptOptions: { sections: disabled } }, { model: vision })
  assert.equal(disabled.inkstone_computer_use, '', '没开电脑操作时分区为空')

  const sizes = tools.map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length)
  console.log(`computer tools ok (${tools.length} deferred tools, definitions ${sizes.reduce((a, b) => a + b, 0)} chars; guide ${toolGuide.length} chars vs ${cliGuide.length})`)
} finally {
  restoreEnv()
  await rm(root, { recursive: true, force: true })
}
