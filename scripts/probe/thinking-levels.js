/**
 * D11 回归：支持推理的模型必须显示真实思考档位。
 *
 * 用**真实 pi 与真实模型列表**（不调模型、不花 token，只 set_model 后读档位）：
 *   1. 切到 DeepSeek V4.1 Flash（reasoning=true 的真实模型）
 *   2. 断言档位按钮出现，且不是“上游未提供思考档位信息”
 *   3. 再等几秒复查 —— 这是 bug 的核心：pi 的 get_state 不含档位，
 *      早期实现里**每一条 state 推送**都会把它清空成 unknown，
 *      所以必须在有后续推送之后再断言一次。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }

  /* 等真实 pi 握手完成（有模型即认为就绪） */
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (store.getState().session?.model) {
      ready = true
      break
    }
    await sleep(300)
  }
  ok(ready, '真实 pi 已就绪并报告当前模型')
  if (!ready) return out.join('\n')

  /* 等模型列表加载（诊断用，不阻塞主断言） */
  const hasModels = await (async () => {
    for (let i = 0; i < 20; i++) {
      if ((store.getState().models?.length ?? 0) > 0) return true
      await sleep(300)
    }
    return false
  })()
  out.push('  模型列表长度 = ' + (store.getState().models?.length ?? 0) + (hasModels ? '' : '（未加载，不影响主断言）'))

  /* 直接用真实 IPC 切模型：等价于用户在菜单里点选，但不依赖列表先加载 */
  const target = { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash' }
  const before = store.getState().session?.model?.id ?? ''
  const res = await window.yan.setModel(target.provider, target.id)
  out.push('  setModel = ' + JSON.stringify(res))
  ok(res?.ok !== false, 'setModel 成功')

  /* 开菜单看真实 UI（档位按钮就在菜单里） */
  const picker = q('[data-testid="model-picker"]')
  ok(!!picker, '模型触发器存在')
  if (picker) {
    click(picker)
    for (let i = 0; i < 30; i++) {
      if (q('[data-testid="model-menu"]')) break
      await sleep(150)
    }
  }
  ok(!!q('[data-testid="model-menu"]'), '模型菜单已打开')

  const after = store.getState().session?.model?.id ?? ''
  out.push(`  模型 ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  ok(after !== '' && after !== before, '模型已切换')

  /* 关键断言 1：档位按钮出现 */
  const stops = () => q('[data-testid="thinking-stops"]')
  const hasStops = await (async () => {
    for (let i = 0; i < 30; i++) {
      if (stops()) return true
      await sleep(200)
    }
    return false
  })()
  const labels = stops() ? qa('[data-testid^="thinking-dot-"]').map((b) => b.textContent.trim()) : []
  out.push('  档位 = ' + JSON.stringify(labels))
  ok(hasStops, '显示档位按钮（而不是“上游未提供思考档位信息”）')
  ok(labels.length > 1, '档位数量 > 1')

  /* 关键断言 2：后续 state 推送不得把档位清空 */
  const statePushes = () => store.getState().session?.thinkingLevelsStatus
  const statusNow = statePushes()
  await sleep(3500)
  const statusLater = statePushes()
  const labelsLater = stops() ? qa('[data-testid^="thinking-dot-"]').map((b) => b.textContent.trim()) : []
  out.push(`  thinkingLevelsStatus: ${JSON.stringify(statusNow)} → ${JSON.stringify(statusLater)}`)
  ok(statusLater === 'known', '多次 state 推送后档位状态仍是 known（D11 的核心回归）')
  ok(labelsLater.length === labels.length, '档位按钮没有被后续推送清掉')

  const menuText = q('[data-testid="model-menu"]')?.textContent ?? ''
  ok(!/上游未提供思考档位信息/.test(menuText), '菜单里不再出现“上游未提供思考档位信息”')

  /* 收尾：关掉菜单，不给后面的场景留浮层 */
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(200)

  return out.join('\n')
})()
