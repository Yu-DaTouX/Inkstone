export async function runQuestionTests(ok) {
  const mod = await import(new URL('../resources/pi-extensions/question.js', import.meta.url))
  const factory = mod.default
  ok(typeof factory === 'function', 'question.js 默认导出扩展工厂函数')

  const handlers = {}
  let registerCalls = 0
  factory({
    on: (evt, handler) => {
      handlers[evt] = handler
    },
    registerTool: () => {
      registerCalls += 1
    }
  })

  ok(registerCalls === 0, '没有宿主能力端点时不注册 question 工具，提示回退到 yan question ask')
  ok(typeof handlers.before_agent_start === 'function', '仍保留提问提示钩子')

  const std = handlers.before_agent_start({ systemPrompt: 'BASE' })
  ok(
    typeof std?.systemPrompt === 'string' &&
      std.systemPrompt.includes('BASE') &&
      /Interactive questions/.test(std.systemPrompt) &&
      /yan question ask/.test(std.systemPrompt),
    '系统提示指引模型调用 yan question ask'
  )
  ok(
    /at most 3 concrete options/.test(std?.systemPrompt ?? ''),
    '提示词把选项上限写成 3（与宿主硬校验同口径）'
  )
  ok(/materially different reading/.test(std?.systemPrompt ?? '') && !/frequency/i.test(std?.systemPrompt ?? ''), '提问时机写成「理解分歧会改变结果才问」，不再提已删除的频率设置')

  const sections = {}
  const sectioned = handlers.before_agent_start({ systemPrompt: 'BASE', systemPromptOptions: { sections } })
  ok(sectioned === undefined && /yan question ask/.test(sections.inkstone_question ?? ''), '有具名分区时只写分区、不返回整段提示')
}
