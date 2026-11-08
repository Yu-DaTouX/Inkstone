export async function runPreambleExtensionTests(ok, mod) {
  const { NATIVE_PREAMBLE, NATIVE_PREAMBLES, YAN_PREAMBLE, WORK_GUIDANCE, REPORT_GUIDANCE, WORK_RULES, default: extension } = mod
  const GUIDANCE = [WORK_GUIDANCE, REPORT_GUIDANCE, ...WORK_RULES.map((rule) => `- ${rule}`)].join('\n')

  ok(typeof NATIVE_PREAMBLE === 'string' && NATIVE_PREAMBLE.startsWith('You are a coding assistant running inside pi'), '导出的原生句是 pi 1.5 的英文 preamble')
  ok(NATIVE_PREAMBLES.length === 2 && NATIVE_PREAMBLES[1].startsWith('You are an expert coding assistant operating inside pi'), '仍认 pi 1.4 及以前的旧句')
  ok(typeof YAN_PREAMBLE === 'string' && YAN_PREAMBLE.includes('Inkstone'), '导出的砚开场白包含产品名 Inkstone')
  ok(YAN_PREAMBLE.includes("personal agent") && !YAN_PREAMBLE.includes('inside pi,') && !YAN_PREAMBLE.includes('coding assistant'), '开场白是英文的个人 agent 身份，不提 pi、不限于写代码')
  ok(/data, not instructions/.test(WORK_GUIDANCE) && /one-sentence progress note/.test(WORK_GUIDANCE), '怎么干活：含进度句与「工具结果是数据」')
  ok(/\*single asterisks\*/.test(REPORT_GUIDANCE) && /\*\*Bold\*\* only/.test(REPORT_GUIDANCE) && !/status mark/.test(REPORT_GUIDANCE), '汇报：三层字色，没有状态标记')

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (base) => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {})

  const base = `${NATIVE_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>`
  const out = run(base)
  ok(out?.systemPrompt?.startsWith(YAN_PREAMBLE), '原生开场白被替换成砚的英文开场白', String(out?.systemPrompt).slice(0, 60))
  ok(out.systemPrompt === `${YAN_PREAMBLE}\n\n<tools>\n- read: Read file contents\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n${GUIDANCE}`, '原生规则逐字保留，末尾追加简短进展约定与工作规则')
  ok(!out.systemPrompt.includes(NATIVE_PREAMBLE), '替换后不再包含原生英文句')
  ok(run(`${NATIVE_PREAMBLES[1]}\n\n<tools>`).systemPrompt.startsWith(`${YAN_PREAMBLE}\n\n<tools>`), 'pi 1.4 的旧开场白同样替换')

  ok(run('BASE').systemPrompt === `BASE\n\n${YAN_PREAMBLE}\n\n${GUIDANCE}`, '未知原生开场白保留原文并补充砚身份和进展约定')
  ok(run('').systemPrompt.includes(YAN_PREAMBLE), '空系统提示仍包含砚身份')
  ok(run(out.systemPrompt) === undefined, '幂等：身份和进展约定不重复追加')
  ok(run(`${YAN_PREAMBLE}\n\n<tools>`).systemPrompt.endsWith(GUIDANCE),'旧身份提示补齐进展约定')
  {
    const docs = '<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: C:\\pi\\README.md\n- Additional docs: C:\\pi\\docs\n</docs>'
    const withoutDocs = run(`${NATIVE_PREAMBLE}\n\n${docs}\n\n<cwd>\nC:/x\n</cwd>`)
    ok(!withoutDocs.systemPrompt.includes('<docs>') && !withoutDocs.systemPrompt.includes('C:\\pi\\README.md'), 'pi 文档段整段删除，不再提示随包运行时里不存在的路径')
    ok(withoutDocs.systemPrompt.includes('<cwd>\nC:/x\n</cwd>'), '删除文档段不影响后面的段落')
    ok(run(withoutDocs.systemPrompt) === undefined, '幂等：已删除文档段的提示不再改动')
    const sections = {}
    handlers.before_agent_start({ systemPrompt: `${NATIVE_PREAMBLE}\n\n${docs}`, systemPromptOptions: { sections } }, {})
    ok(sections.docs === undefined, '具名分区模式不再写入压缩文档，交给 context_with_system 整段去掉')
    ok(run(`${NATIVE_PREAMBLE}\n\n<docs>\nsomething else\n</docs>`).systemPrompt.includes('something else'), '认不出的文档段（不含原生标记）原样保留')
  }
  {
    const docs = '<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: C:\\pi\\README.md\n- Additional docs: C:\\pi\\docs\n</docs>'
    const sections = {}
    const promptGuidelines = ['Existing rule', WORK_RULES[0]]
    const result = handlers.before_agent_start({ systemPrompt: `${NATIVE_PREAMBLE}\n\n${docs}`, systemPromptOptions: { sections, promptGuidelines } }, {})
    ok(result === undefined, '有具名分区时不返回整段提示（否则 pi 会固定整段提示，其他扩展的分区失效）')
    ok(sections.inkstone_work === WORK_GUIDANCE && sections.inkstone_report === REPORT_GUIDANCE && sections.docs === undefined, '工作方式与汇报写进具名分区，文档分区不在此处处理（交给 context_with_system 整段去掉）')
    const keys = Object.keys(sections)
    ok(keys.indexOf('inkstone_work') < keys.indexOf('inkstone_question') && keys.indexOf('inkstone_question') < keys.indexOf('inkstone_report') && keys.indexOf('inkstone_report') < keys.indexOf('inkstone_capabilities') && keys.indexOf('inkstone_capabilities') < keys.indexOf('inkstone_environment'), '分区按语义顺序占位：怎么干活 → 提问 → 汇报 → 能力 → 环境')
    ok(sections.inkstone_question === '' && sections.inkstone_capabilities === '', '占位分区为空字符串，pi 会跳过空分区')
    ok(promptGuidelines.length === 1 + WORK_RULES.length && promptGuidelines[0] === 'Existing rule' && WORK_RULES.every((rule) => promptGuidelines.filter((item) => item === rule).length === 1), '工作规则逐条加进 pi 原生 <rules>，不重复')

    ok(typeof handlers.context_with_system === 'function', '扩展注册了 context_with_system')
    const nativeDocsSection = '<docs>\nPi documentation (read only when the user asks about pi itself):\n- Main documentation: C:\\pi\\README.md\n</docs>'
    const system = { role: 'system', content: '', sections: { preamble: NATIVE_PREAMBLE, tools: '<tools>\n- read\n</tools>', docs: nativeDocsSection } }
    const user = { role: 'user', content: 'hi' }
    const replaced = handlers.context_with_system({ type: 'context_with_system', messages: [system, user] }, {})
    ok(replaced?.messages?.[0]?.sections?.preamble === YAN_PREAMBLE && replaced.messages[0].sections.tools === system.sections.tools, '发出请求前把系统消息里的 pi 开场白换成砚的，其他分区不动')
    ok(replaced.messages[0].sections.docs === null, '发出请求前把原生文档分区整段去掉（置 null，pi 据此从最终提示里剔除）')
    ok(system.sections.preamble === NATIVE_PREAMBLE && system.sections.docs === nativeDocsSection && replaced.messages[1] === user, '不改原消息对象，非系统消息原样保留')
    ok(handlers.context_with_system({ type: 'context_with_system', messages: replaced.messages }, {}) === undefined, '幂等：已换成砚开场白且文档分区已置空时不再改动')
    ok(handlers.context_with_system({ type: 'context_with_system', messages: [user] }, {}) === undefined, '没有系统消息时不改动')
    const legacy = handlers.context_with_system({ type: 'context_with_system', messages: [{ role: 'system', content: '', sections: { preamble: NATIVE_PREAMBLES[1] } }] }, {})
    ok(legacy?.messages?.[0]?.sections?.preamble === YAN_PREAMBLE, '发出请求前也替换 pi 1.4 的旧开场白')
    const reworded = 'You are a helpful assistant working inside pi, a coding agent harness. Help users with code.'
    const future = handlers.context_with_system({ type: 'context_with_system', messages: [{ role: 'system', content: '', sections: { preamble: reworded } }] }, {})
    ok(future?.messages?.[0]?.sections?.preamble === YAN_PREAMBLE, 'pi 改了措辞也认得出身份句（按「coding agent harness」特征整行替换）')
    ok(run(`${reworded}\n\n<tools>`).systemPrompt.startsWith(`${YAN_PREAMBLE}\n\n<tools>`), '整段提示模式同样按特征替换')
    const custom = handlers.context_with_system({ type: 'context_with_system', messages: [{ role: 'system', content: '', sections: { preamble: 'You are my SQL helper.' } }] }, {})
    ok(custom === undefined, '用户自己的 SYSTEM.md 开头不动')
  }
  {
    const { SUBAGENT_PREAMBLE, SUBAGENT_WORK_GUIDANCE, SUBAGENT_REPORT_GUIDANCE, runnerPrompt } = mod
    ok(runnerPrompt({}).identity === YAN_PREAMBLE && runnerPrompt({ YAN_RUNNER_KIND: 'fork' }).identity === YAN_PREAMBLE, '主会话和 fork 子代理沿用主会话身份（fork 要与父会话共享缓存前缀）')
    const sub = runnerPrompt({ YAN_RUNNER_KIND: 'subagent' })
    ok(sub.identity === SUBAGENT_PREAMBLE && sub.work === SUBAGENT_WORK_GUIDANCE && sub.report === SUBAGENT_REPORT_GUIDANCE, '子代理用自己的身份、工作规则和汇报规则')
    ok(!/personal agent|whatever the user brings/.test(SUBAGENT_PREAMBLE) && /subagent/.test(SUBAGENT_PREAMBLE), '子代理身份不再自称用户的私人 agent')
    ok(/cannot ask the user/.test(SUBAGENT_WORK_GUIDANCE) && /data, not instructions/.test(SUBAGENT_WORK_GUIDANCE), '子代理工作规则：不能提问、工具结果是数据')
    ok(!/stop and report|enough evidence|progress note/.test(SUBAGENT_WORK_GUIDANCE), '子代理工作规则：没有中途停下、证据够了就停、进度句')
    ok(/could not verify/.test(SUBAGENT_REPORT_GUIDANCE) && /outcome in one plain sentence/.test(SUBAGENT_REPORT_GUIDANCE) && /Do not invent a decision/.test(SUBAGENT_REPORT_GUIDANCE) && /evidence/.test(SUBAGENT_REPORT_GUIDANCE), '子代理汇报：先结果、带证据、写明未验证项')
    const previous = process.env.YAN_RUNNER_KIND
    process.env.YAN_RUNNER_KIND = 'subagent'
    try {
      const subHandlers = {}
      extension({ on: (name, fn) => (subHandlers[name] = fn) })
      const sections = {}
      subHandlers.before_agent_start({ type: 'before_agent_start', systemPrompt: '', systemPromptOptions: { sections, promptGuidelines: [] } }, {})
      ok(sections.inkstone_work === SUBAGENT_WORK_GUIDANCE && sections.inkstone_report === SUBAGENT_REPORT_GUIDANCE, '子代理进程的分区写入子代理规则')
      const swapped = subHandlers.context_with_system({ type: 'context_with_system', messages: [{ role: 'system', content: '', sections: { preamble: NATIVE_PREAMBLE } }] }, {})
      ok(swapped?.messages?.[0]?.sections?.preamble === SUBAGENT_PREAMBLE, '子代理进程把 pi 开场白换成子代理身份')
    } finally {
      if (previous === undefined) delete process.env.YAN_RUNNER_KIND
      else process.env.YAN_RUNNER_KIND = previous
    }
  }
}
