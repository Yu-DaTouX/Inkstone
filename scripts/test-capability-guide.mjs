import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile('resources/pi-extensions/capability-guide.js')
  const guide = mod.CAPABILITY_GUIDE

  ok(!/data, not instructions/.test(guide) && !/When the user asks for something to be done/.test(guide), '能力说明不再重复工作方式与「工具结果是数据」（已移到 preamble 的 inkstone_work）')
  ok(!mod.capabilityGuide(true, { codemode: false }).includes('codemode') && mod.capabilityGuide(true).includes('codemode'), '能力说明：codemode 关闭时不提 codemode')
  ok(!/short plain prose|no headings or long lists/.test(mod.VISUAL_ANSWER_GUIDE), '可视化说明不再要求只写散文、不用列表')
  {
    const day = new Date(2026, 9, 19, 23, 30)
    const win = mod.environmentGuide(day, 'win32', undefined)
    ok(/Today: 2026-10-19/.test(win) && /Git Bash/.test(win) && /do not prefix commands with a cd/.test(win), '环境说明：本地日期、Windows 走 Git Bash、命令已在工作目录启动')
    ok(/PowerShell/.test(mod.environmentGuide(day, 'win32', 'powershell')) && !/Git Bash/.test(mod.environmentGuide(day, 'win32', 'powershell')), '环境说明：没有 Git Bash 时写 PowerShell')
    ok(/OS: macOS\./.test(mod.environmentGuide(day, 'darwin')), '环境说明：其他系统只写系统名')
  }
  {
    const hooks = {}
    mod.default({ on: (name, fn) => { (hooks[name] ??= []).push(fn) } })
    ok(!hooks.before_provider_request && !hooks.message_end && !hooks.tool_result, '能力扩展只写系统提示分区，不在请求末尾追加待办或收尾提醒')
  }
  const visual = mod.VISUAL_ANSWER_GUIDE
  const grammarModel = { model: { compat: { supportsOpenAIGrammarTools: true } } }
  {
    const probeHandlers = {}
    mod.default({ on: (name, fn) => { probeHandlers[name] = fn } })
    const options = { sections: { preamble: 'x' } }
    const result = probeHandlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: options }, grammarModel)
    ok(options.sections.inkstone_visual_answer === visual && options.sections.inkstone_capabilities === mod.CAPABILITY_GUIDE && result === undefined,
      '能力说明：有具名分区时只写分区、不返回整段提示（否则 pi 会固定整段提示，其他扩展的分区失效）')
    const plain = { sections: {} }
    probeHandlers.before_agent_start({ systemPrompt: 'base', systemPromptOptions: plain }, { model: { compat: {} } })
    ok(plain.sections.inkstone_capabilities === mod.capabilityGuide(false, { codemode: false }), '能力说明：自动模式下不支持语法工具的模型不提 codemode')
  }

  const handlers = {}
  mod.default({
    on: (name, fn) => {
      handlers[name] = fn
    }
  })
  ok(typeof handlers.before_agent_start === 'function', '能力说明：注册在 before_agent_start')

  const first = handlers.before_agent_start({ systemPrompt: 'base' }, grammarModel)
  ok(
    !!first && first.systemPrompt.startsWith('base') && first.systemPrompt.includes(mod.CAPABILITY_GUIDE),
    '能力说明：追加在系统提示末尾（不篡改原有内容）'
  )
  const second = handlers.before_agent_start({ systemPrompt: first.systemPrompt }, grammarModel)
  ok(second === undefined, '能力说明：幂等，已注入后不再重复追加')
}, { isolate: true })
