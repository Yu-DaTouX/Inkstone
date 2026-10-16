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

  for (let i = 0; i < 60; i++) {
    if (store?.getState().settings) break
    await sleep(250)
  }
  await sleep(1200)

  store.setState({ session: null, models: [] })
  await sleep(400)

  const trigger = q('[data-testid="model-picker"]')
  ok(!!trigger, 'session 为 null 时选择器仍然渲染（不再整个消失）')
  if (!trigger) return out.join('\n')

  log(`  触发器文字 = ${JSON.stringify(trigger.textContent)}`)
  log(`  data-state = ${JSON.stringify(trigger.dataset.state)}`)
  ok(trigger.dataset.state === 'unknown', '标记为 unknown 状态')
  ok(
    /模型未就绪|未选模型|Model not ready|No model/i.test(trigger.textContent ?? ''),
    '触发器给出明确的「未就绪」文案，而不是空白'
  )
  ok(trigger.classList.contains('unknown'), '带 unknown 类（用于弱化样式）')

  click(trigger)
  await sleep(400)
  const menu = q('[data-testid="model-menu"]')
  ok(!!menu, '未就绪时菜单仍可打开')
  if (menu) {
    const empty = q('[data-testid="models-empty"]')
    log(`  空态文字 = ${JSON.stringify(empty?.textContent ?? '(没有空态)')}`)
    ok(
      !!empty && /还没有可用模型|No models available/.test(empty.textContent ?? ''),
      '列表为空时给出「还没有可用模型」而不是误导性的「没有匹配的模型」'
    )
  }
  click(trigger)
  await sleep(300)

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

  const badgeColorAt = async (level) => {
    store.setState({ session: { ...fake, thinkingLevel: level } })
    await sleep(260)
    const el = q('[data-testid="thinking-badge"]')
    return el ? getComputedStyle(el).color : '(没有角标)'
  }
  const highColor = await badgeColorAt('high')
  const lowColor = await badgeColorAt('low')
  log(`  角标颜色: high=${highColor} · low=${lowColor}`)
  ok(highColor === lowColor && highColor !== '(没有角标)', '角标文字各档统一（档位色不进文字）')
  store.setState({ session: fake })
  await sleep(120)

  return out.join('\n')
})()
