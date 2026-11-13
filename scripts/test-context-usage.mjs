import { runSuite } from './lib/test-suite.mjs'
import { fakePiEvents } from './lib/fake-pi-events.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const ext = await import('../resources/pi-extensions/context-usage.js')
  const metrics = await compile('src/shared/session-metrics.ts')
  const sourcesMod = await compile('src/renderer/src/state/context-sources.ts')
  const view = await compile('src/renderer/src/features/workbench/context-pane-view.ts')

  const samples = ['', 'hello world', '你好，世界', 'mixed 中文 and English 123', '😀 emoji ✓', 'x'.repeat(4097), '<skill>\n  <name>a</name>\n</skill>']
  ok(samples.every((text) => ext.estimateTextTokens(text) === metrics.estimateTextTokens(text)), '扩展与 estimateTextTokens 算法一致')
  ok(ext.CONTEXT_USAGE_STATUS_KEY === sourcesMod.CONTEXT_USAGE_STATUS_KEY, '扩展与界面使用同一状态键')

  const memoryA = '<project_instructions path="E:\\proj\\AGENTS.md">\n项目规则：用中文。\n</project_instructions>'
  const memoryB = '<project_instructions path="C:\\Users\\u\\.pi\\agent\\AGENTS.md">\nglobal rules here\n</project_instructions>'
  const projectContext = `<project_context>\nProject-specific instructions and guidelines:\n\n${memoryA}\n\n${memoryB}\n</project_context>`
  const skillA = '  <skill>\n    <name>artifact</name>\n    <description>Make &amp; preview HTML</description>\n    <location>/s/artifact/SKILL.md</location>\n  </skill>'
  const skillB = '  <skill>\n    <name>office</name>\n    <description>docs</description>\n    <location>/s/office/SKILL.md</location>\n  </skill>'
  const skills = `<skills>\nThe following skills provide specialized instructions.\n<available_skills>\n${skillA}\n${skillB}\n</available_skills>\n</skills>`
  const mcpServers = '<mcp_servers>\nMCP servers whose tools are not declared to you.\n- github: code hosting\n</mcp_servers>'
  const hosted = '<inkstone_hosted_mcp>\nInkstone-hosted MCP servers: figma.\n</inkstone_hosted_mcp>'
  const preamble = 'You are a coding assistant.'
  const rules = '<rules>\n- be concise\n</rules>'
  const systemText = [preamble, '<tools>\n- read: Read files\n</tools>', rules, projectContext, skills, mcpServers, hosted, '<cwd>\nE:/proj\n</cwd>'].join('\n\n')

  const sections = ext.splitSections(systemText)
  ok(sections.map((s) => s.text).join('') === systemText, '分段覆盖整段系统提示，不丢不重')
  ok(sections.filter((s) => s.name).map((s) => s.name).join(',') === 'tools,rules,project_context,skills,mcp_servers,inkstone_hosted_mcp,cwd', '按 pi 段落标签拆分')

  const registered = [
    { name: 'read', description: 'Read files', parameters: { type: 'object' }, exposure: 'direct' },
    { name: 'bash', description: 'Run commands', parameters: { type: 'object' }, exposure: 'direct' },
    { name: 'grep', description: 'Search', parameters: { type: 'object' }, exposure: 'direct' },
    { name: 'secret_hidden', description: 'hidden', parameters: {}, exposure: 'hidden' },
    { name: 'mcp__figma__get_file', description: 'Get file', parameters: { type: 'object' }, exposure: 'deferred', namespace: { name: 'figma' } },
    { name: 'mcp__figma__list', description: 'List', parameters: { type: 'object' }, exposure: 'deferred', namespace: { name: 'figma' } },
    { name: 'github_issue', description: 'Native MCP tool', parameters: { type: 'object' }, exposure: 'direct', namespace: { name: 'github' } }
  ]
  const readTool = { name: 'Read', description: 'Read files', input_schema: { type: 'object' } }
  const bashTool = { name: 'bash', description: 'Run commands', input_schema: { type: 'object' } }
  const ghTool = { name: 'github_issue', description: 'Native MCP tool', input_schema: { type: 'object' } }
  const loaded = { name: 'mcp__figma__list', description: 'List', input_schema: { type: 'object' } }
  const anthropic = {
    model: 'claude',
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    tools: [readTool, bashTool, ghTool, { name: '__pi_deferred_placeholder__', description: 'x', input_schema: {}, defer_loading: true }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '用户消息不算系统' }] },
      { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: loaded } }] }
    ]
  }
  const before = JSON.stringify(anthropic)
  const a = ext.contextUsageReport({ payload: anthropic, systemPrompt: 'unused', tools: registered })
  ok(JSON.stringify(anthropic) === before, '统计不改动请求负载')
  const est = ext.estimateTextTokens
  const tok = (value) => est(JSON.stringify(value))
  ok(a.memory === est(projectContext) && a.memoryFiles.length === 2, 'anthropic：记忆文件段与两个文件', JSON.stringify(a.memoryFiles))
  ok(a.memoryFiles.find(([path]) => path === 'E:\\proj\\AGENTS.md')?.[1] === est(memoryA), '记忆文件按路径给出各自大小')
  ok(a.skills === est(skills) && a.skillList.map(([n]) => n).sort().join(',') === 'artifact,office', 'anthropic：技能清单')
  ok(a.mcpInfo === est(mcpServers) + est(hosted), 'anthropic：MCP 服务说明含 pi 原生与砚托管两段')
  const promptExpected = est(systemText) - 0
  ok(a.prompt + a.memory + a.skills + a.mcpInfo >= promptExpected - 8 && a.prompt + a.memory + a.skills + a.mcpInfo <= promptExpected + 8, '各段之和与整段估算基本一致')
  ok(a.builtin === tok(readTool) + tok(bashTool), 'anthropic：内置工具含大小写改名的 Read，不含占位工具')
  ok(a.mcp === tok(ghTool) + tok(loaded), 'anthropic：MCP 工具含原生命名空间工具与中途加载的 tool_addition')
  ok(a.deferred.mcp === tok({ name: 'mcp__figma__get_file', description: 'Get file', parameters: { type: 'object' } }), '未发出的 MCP 工具计为延迟加载')
  ok(a.deferred.builtin === tok({ name: 'grep', description: 'Search', parameters: { type: 'object' } }), '未激活的内置工具计为延迟加载，hidden 不计')
  ok(a.mcpTools.length === 3 && a.mcpTools.at(-1)[0] === 'mcp__figma__get_file' && a.mcpTools.at(-1)[2] === 1, 'MCP 清单列出已发出与延迟的工具，延迟的排后并带标记')

  const responses = {
    instructions: systemText,
    tools: [{ type: 'function', name: 'read', description: 'Read files', parameters: { type: 'object' } }],
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '<inkstone_language>\nReply in Chinese\n</inkstone_language>' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'tool_search_output', tools: [{ type: 'function', name: 'mcp__figma__list', description: 'List', parameters: {}, defer_loading: true }] }
    ]
  }
  const r = ext.contextUsageReport({ payload: responses, tools: registered })
  ok(r.memoryFiles.length === 2 && r.skillList.length === 2, 'responses：instructions 中的记忆文件与技能')
  ok(r.prompt > a.prompt, 'responses：developer 消息计入系统提示')
  ok(r.builtin === tok(responses.tools[0]) && r.mcp === tok(responses.input[2].tools[0]), 'responses：tools 与 tool_search_output 分别计入内置与 MCP')
  ok(r.deferred.builtin === tok({ name: 'bash', description: 'Run commands', parameters: { type: 'object' } }) + tok({ name: 'grep', description: 'Search', parameters: { type: 'object' } }), 'responses：未发出的 bash、grep 计为延迟')

  const twice = { ...responses, input: [...responses.input, responses.input[2]] }
  const rt = ext.contextUsageReport({ payload: twice, tools: registered })
  ok(rt.mcpTools.filter(([name]) => name === 'mcp__figma__list').length === 1 && rt.mcp === 2 * r.mcp, '同名工具重复加载时清单合并、用量累加')

  const completions = {
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: 'hello' }
    ],
    tools: [
      { type: 'function', function: { name: 'read', description: 'Read files', parameters: {} } },
      { type: 'function', function: { name: 'mcp__figma__get_file', description: 'Get file', parameters: {} } }
    ]
  }
  const c = ext.contextUsageReport({ payload: completions, tools: registered })
  ok(c.memory === a.memory && c.skills === a.skills && c.mcpInfo === a.mcpInfo, 'chat completions：system 消息拆分与 anthropic 一致')
  ok(c.builtin === tok(completions.tools[0]) && c.mcp === tok(completions.tools[1]), 'chat completions：function.name 识别并区分 MCP')
  ok(!c.mcpTools.some(([name, , deferred]) => name === 'mcp__figma__get_file' && deferred), '已发出的 MCP 工具不重复算延迟')

  const fallback = ext.contextUsageReport({ payload: { messages: [] }, systemPrompt: systemText, tools: [] })
  ok(fallback.memory === a.memory, '负载里没有系统文本时用 getSystemPrompt 兜底')

  const pushed = []
  const handlers = new Map()
  const fakePi = { on: (name, fn) => handlers.set(name, fn), events: fakePiEvents(), getAllTools: () => registered }
  ext.default(fakePi)
  const ctx = { ui: { setStatus: (key, text) => pushed.push([key, text]) }, getSystemPrompt: () => '' }
  const handler = handlers.get('before_provider_request')
  ok(handler({ type: 'before_provider_request', payload: anthropic }, ctx) === undefined, '处理器不返回值，不改写请求')
  handler({ type: 'before_provider_request', payload: anthropic }, ctx)
  ok(pushed.length === 1 && pushed[0][0] === ext.CONTEXT_USAGE_STATUS_KEY, '内容不变时只推送一次')
  handler({ type: 'before_provider_request', payload: completions }, ctx)
  ok(pushed.length === 2, '内容变化时再推送')
  handlers.get('session_before_switch')?.()
  handler({ type: 'before_provider_request', payload: completions }, ctx)
  ok(pushed.length === 3, '切换会话后重新推送')
  ok(pushed[0][1].length < 4000, '推送体积小', String(pushed[0][1].length))

  const sources = sourcesMod.parseContextSources(pushed[0][1])
  ok(sources && sources.parts.memory === a.memory && sources.mcpTools.length === 3 && sources.mcpTools.at(-1).deferred === true, '界面能解析状态 JSON')
  ok(sourcesMod.parseContextSources('not json') === null && sourcesMod.parseContextSources('{"v":2}') === null, '无法识别的状态返回 null')

  const total = sourcesMod.sourcesTotal(sources)
  const split = sourcesMod.splitSystem(5000, sources, false)
  ok(split.reduce((n, p) => n + p.tokens, 0) === 5000, '有测量时各系统部分按比例缩放到测得总量')
  const compacted = sourcesMod.splitSystem(total + 700, sources, true)
  ok(compacted.at(-1).id === 'summary' && compacted.at(-1).tokens === 700, '压缩后多出的部分归为压缩摘要')
  ok(sourcesMod.splitSystem(5000, null, false) === null, '没有扩展数据时不拆分')

  const slices = [{ id: 'system', tokens: 4000 }, { id: 'user', tokens: 100 }, { id: 'assistant', tokens: 0 }]
  const parts = view.contextParts(slices, sources, false, true)
  ok(parts.filter((p) => p.id !== 'user' && p.id !== 'assistant').reduce((n, p) => n + p.tokens, 0) === 4000 && parts.every((p) => p.id === 'user' || p.id === 'assistant' || p.approx), '只有估算时系统部分标记为约数')
  ok(view.contextParts(slices, null, false, true)[0].id === 'system', '数据未到时保持原五类')

  const usage = { known: true, tokens: 50_000, windowSize: 200_000, compactAt: 180_000 }
  const reserve = view.contextReserve(usage)
  ok(reserve.buffer === 20_000 && reserve.free === 130_000, '自动压缩预留与剩余空间')
  const off = view.contextReserve({ ...usage, compactAt: null })
  ok(off.buffer === null && off.free === 150_000, '自动压缩关闭时没有预留，剩余为窗口减已用')
})
