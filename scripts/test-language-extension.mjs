export async function runLanguageExtensionTests(ok, mod) {
  const { LANGUAGE_RULE, default: extension } = mod

  ok(/language of the user's latest message/.test(LANGUAGE_RULE), '回复语言跟随用户最新一条消息', LANGUAGE_RULE)
  ok(/reasoning/.test(LANGUAGE_RULE) && /progress lines/.test(LANGUAGE_RULE), '推理和进度句也跟随', LANGUAGE_RULE)
  ok(/AGENTS\.md/.test(LANGUAGE_RULE) && /follow the project instructions/.test(LANGUAGE_RULE), '项目指令规定沟通语言时按项目来', LANGUAGE_RULE)

  const handlers = {}
  extension({ on: (name, fn) => (handlers[name] = fn) })
  ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')

  const run = (base) => handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: base }, {})
  ok(run('BASE')?.systemPrompt === `BASE\n\n${LANGUAGE_RULE}`, '追加在已有系统提示之后（不覆盖原提示）')
  ok(run('')?.systemPrompt === LANGUAGE_RULE, '没有原提示时也能注入')

  const sections = {}
  const sectioned = handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE', systemPromptOptions: { sections } }, {})
  ok(sectioned === undefined && sections.inkstone_language === LANGUAGE_RULE, '有具名分区时只写分区、不返回整段提示')

  ok(handlers.before_provider_request === undefined && handlers.message_end === undefined, '语言只写系统提示，不跟踪思考、不追加漂移提醒')
}
