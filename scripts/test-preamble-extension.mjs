export async function runPreambleExtensionTests(ok, mod) {
  const { NATIVE_PREAMBLE, YAN_PREAMBLE, PROGRESS_GUIDANCE, WORK_RULES, default: extension } = mod
  const GUIDANCE = [PROGRESS_GUIDANCE, ...WORK_RULES.map((rule) => `- ${rule}`)].join('\n')

  ok(typeof NATIVE_PREAMBLE === 'string' && NATIVE_PREAMBLE.startsWith('You are an expert coding assistant'), '导出的原生句就是 pi 的英文 preamble')
  ok(typeof YAN_PREAMBLE === 'string' && YAN_PREAMBLE.includes('Inkstone'), '导出的砚开场白包含产品名 Inkstone')
  ok(YAN_PREAMBLE.includes('underlying execution engine') && !YAN_PREAMBLE.includes('inside pi,'), '开场白保持英文措辞，只换产品名')

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (base) => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {})

  const base = `${NATIVE_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>`
  const out = run(base)
  ok(out?.systemPrompt?.startsWith(YAN_PREAMBLE), '原生开场白被替换成砚的英文开场白', String(out?.systemPrompt).slice(0, 60))
  ok(out.systemPrompt === `${YAN_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n${GUIDANCE}`, '原生规则逐字保留，末尾追加简短进展约定与工作规则')
  ok(!out.systemPrompt.includes(NATIVE_PREAMBLE), '替换后不再包含原生英文句')

  ok(run('BASE').systemPrompt === `BASE\n\n${YAN_PREAMBLE}\n\n${GUIDANCE}`, '未知原生开场白保留原文并补充砚身份和进展约定')
  ok(run('').systemPrompt.includes(YAN_PREAMBLE), '空系统提示仍包含砚身份')
  ok(run(out.systemPrompt) === undefined, '幂等：身份和进展约定不重复追加')
  ok(run(`${YAN_PREAMBLE}\n\n<tools>`).systemPrompt.endsWith(GUIDANCE),'旧身份提示补齐进展约定')
  {
    const docs = '<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: C:\\pi\\README.md\n- Additional docs: C:\\pi\\docs\n</docs>'
    const withDocs = run(`${NATIVE_PREAMBLE}\n\n${docs}\n\n<cwd>\nC:/x\n</cwd>`)
    ok(withDocs.systemPrompt.includes('<docs>\nPi documentation') && withDocs.systemPrompt.includes('C:\\pi\\README.md') && !withDocs.systemPrompt.includes('Additional docs'), 'pi 文档段压成一行，保留主文档路径')
    ok(withDocs.systemPrompt.includes('<cwd>\nC:/x\n</cwd>'), '压缩文档段不影响后面的段落')
    ok(run(withDocs.systemPrompt) === undefined, '幂等：已压缩的文档段不再改动')
    const sections = {}
    handlers.before_agent_start({ systemPrompt: `${NATIVE_PREAMBLE}\n\n${docs}`, systemPromptOptions: { sections } }, {})
    ok(typeof sections.docs === 'string' && sections.docs.includes('C:\\pi\\README.md'), '同名分区 docs 写入压缩版')
    ok(run(`${NATIVE_PREAMBLE}\n\n<docs>\nsomething else\n</docs>`).systemPrompt.includes('something else'), '认不出的文档段原样保留')
  }
  {
    const docs = '<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: C:\\pi\\README.md\n- Additional docs: C:\\pi\\docs\n</docs>'
    const sections = {}
    const promptGuidelines = ['Existing rule', WORK_RULES[0]]
    const result = handlers.before_agent_start({ systemPrompt: `${NATIVE_PREAMBLE}\n\n${docs}`, systemPromptOptions: { sections, promptGuidelines } }, {})
    ok(result === undefined, '有具名分区时不返回整段提示（否则 pi 会固定整段提示，其他扩展的分区失效）')
    ok(sections.inkstone_progress === PROGRESS_GUIDANCE && sections.docs?.includes('C:\\pi\\README.md'), '进展约定与压缩文档写进具名分区')
    ok(promptGuidelines.length === 1 + WORK_RULES.length && promptGuidelines[0] === 'Existing rule' && WORK_RULES.every((rule) => promptGuidelines.filter((item) => item === rule).length === 1), '工作规则逐条加进 pi 原生 <rules>，不重复')

    ok(typeof handlers.context_with_system === 'function', '扩展注册了 context_with_system')
    const system = { role: 'system', content: '', sections: { preamble: NATIVE_PREAMBLE, tools: '<tools>\n- read\n</tools>' } }
    const user = { role: 'user', content: 'hi' }
    const replaced = handlers.context_with_system({ type: 'context_with_system', messages: [system, user] }, {})
    ok(replaced?.messages?.[0]?.sections?.preamble === YAN_PREAMBLE && replaced.messages[0].sections.tools === system.sections.tools, '发出请求前把系统消息里的 pi 开场白换成砚的，其他分区不动')
    ok(system.sections.preamble === NATIVE_PREAMBLE && replaced.messages[1] === user, '不改原消息对象，非系统消息原样保留')
    ok(handlers.context_with_system({ type: 'context_with_system', messages: replaced.messages }, {}) === undefined, '幂等：已是砚开场白时不再改动')
    ok(handlers.context_with_system({ type: 'context_with_system', messages: [user] }, {}) === undefined, '没有系统消息时不改动')
  }
  ok(PROGRESS_GUIDANCE.includes('requests silence') && PROGRESS_GUIDANCE.includes('Work quietly') && PROGRESS_GUIDANCE.includes('Do not narrate routine steps') && PROGRESS_GUIDANCE.includes('Inkstone internals') && !PROGRESS_GUIDANCE.includes('After each batch of tool calls'), '进展约定：安静干活，只在关键节点说话，不讲砚内部机制，尊重静默要求')
  ok(PROGRESS_GUIDANCE.includes('claiming only what you observed'), '进展约定只声称观察到的结果')
  ok(WORK_RULES.length === 1 && /whole files or large ranges.*parallel/.test(WORK_RULES[0]), '工作规则只留整段读取、并行发出；测试怎么跑交给模型')
  ok(!WORK_RULES.some((rule) => /stop and report|every case|\| tail/.test(rule)), '不再规定测试通过即停、检查脚本跑全、测试不接 tail/head')
}
