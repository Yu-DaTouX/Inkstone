/*
 * 模型选择器在「模型未知」时必须仍然可见（用户报的「看不到模型选择了」）。
 *
 * 原来的 `if (!cur) return null` 让选择器在 `session` 为 null 时**整个消失**：
 * pi 未就绪、启动超时或凭证失效时 `session` 就是 null，于是用户既看不到
 * 当前模型，也失去了唯一的换模型入口 —— 而那正是最需要一个入口去排查的时刻。
 *
 * 为什么直接 setState 改 session 而不是等 pi 真的失败：
 *   隔离测试环境本来就没有凭证（pi 起不来），但那是个**不稳定**的前提 ——
 *   哪天隔离环境能起来了，断言就会假失败。这里主动构造 null，
 *   再主动注入正常 session，两个方向都能测。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(String(s))
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  log('=== 模型选择器：模型未知时仍然可见 ===')

  /* 等到渲染端拿到 settings（composer 里才有 picker） */
  for (let i = 0; i < 60; i++) {
    if (store?.getState().settings) break
    await sleep(250)
  }
  await sleep(1200)

  /* ---- 1. session = null 且 没有可用模型（pi 未就绪 / 启动失败）→ 选择器必须还在 ----
         ⚠️ 必须**显式清空 models**：不能依赖「隔离环境刚好没有模型」——
         凭证/模型目录接好之后 pi 能起来，models 会变成 81 条，断言就会假失败。 */
  store.setState({ session: null, models: [] })
  await sleep(400)

  const trigger = q('[data-testid="model-picker"]')
  ok(!!trigger, 'session 为 null 时选择器仍然渲染（不再整个消失）')
  if (!trigger) return out.join('\n')

  log(`  触发器文字 = ${JSON.stringify(trigger.textContent)}`)
  log(`  data-state = ${JSON.stringify(trigger.dataset.state)}`)
  ok(trigger.dataset.state === 'unknown', '标记为 unknown 状态')
  ok(
    /模型未就绪|Model not ready/.test(trigger.textContent ?? ''),
    '触发器给出明确的「未就绪」文案，而不是空白'
  )
  ok(trigger.classList.contains('unknown'), '带 unknown 类（用于弱化样式）')

  /* 菜单要能打开，并给出明确空态 */
  click(trigger)
  await sleep(400)
  const menu = q('[data-testid="model-menu"]')
  ok(!!menu, '未就绪时菜单仍可打开')
  if (menu) {
    const empty = q('.mt-empty')
    log(`  空态文字 = ${JSON.stringify(empty?.textContent ?? '(没有空态)')}`)
    ok(
      !!empty && /还没有可用模型|No models available/.test(empty.textContent ?? ''),
      '列表为空时给出「还没有可用模型」而不是误导性的「没有匹配的模型」'
    )
  }
  click(trigger)
  await sleep(300)

  /* ---- 2. 注入正常 session → 恢复成常规选择器 ---- */
  const fake = {
    sessionId: 'probe-session',
    thinkingLevel: 'medium',
    availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    thinkingLevelsStatus: 'known',
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
    cwd: 'C:/probe',
    model: { id: 'probe/model-x', name: 'Probe Model X', provider: 'probe', reasoning: true }
  }
  store.setState({ session: fake, thinkingLevels: ['off', 'low', 'medium', 'high'] })
  await sleep(400)

  const t2 = q('[data-testid="model-picker"]')
  ok(!!t2, '有了模型之后选择器仍在')
  ok(t2?.dataset.state === 'ready', '状态回到 ready')
  ok(!t2?.classList.contains('unknown'), 'unknown 类被移除')
  log(`  触发器文字 = ${JSON.stringify(t2?.textContent)}`)
  ok(
    (t2?.textContent ?? '').includes('Probe Model X'),
    '正常状态下显示当前模型名（没有被降级文案顶掉）'
  )
  ok(!!q('[data-testid="thinking-badge"]'), '思考档位角标照常显示')

  return out.join('\n')
})()
