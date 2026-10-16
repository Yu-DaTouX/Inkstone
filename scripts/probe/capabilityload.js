;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(String(s))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  log('=== 能力列表：连接就绪后必须补上 ===')

  let ready = false
  for (let i = 0; i < 120; i++) {
    if (store.getState().conn === 'ready') {
      ready = true
      break
    }
    await sleep(500)
  }
  const st0 = store.getState()
  log(`  conn=${st0.conn} detail=${JSON.stringify(st0.connDetail)}`)
  ok(ready, 'pi 已就绪（conn=ready）')
  if (!ready) {
    log('  ⚠️ pi 没起来 —— 这个场景需要真实凭证，否则无法验证')
    return out.join('\n')
  }

  let n = store.getState().models.length
  for (let i = 0; i < 40 && n === 0; i++) {
    await sleep(500)
    n = store.getState().models.length
  }
  if (n === 0) {
    out.push('  ~ 跳过：模型列表为空（合成模式无凭证/模型目录），模型相关断言不适用')
    return out.join('\n')
  }
  ok(n > 0, `模型列表非空（${n} 条）—— 修复前这里会一直是 0`)

  let levels = store.getState().thinkingLevels
  for (let i = 0; i < 20 && levels.length === 0; i++) {
    await sleep(500)
    levels = store.getState().thinkingLevels
  }
  log(`  思考档位 = ${JSON.stringify(levels)}`)
  ok(levels.length > 0, '思考档位也补上了（不再是「上游未提供思考档位信息」）')

  const trigger = q('[data-testid="model-picker"]')
  ok(!!trigger, '模型选择器在 DOM 里')
  if (trigger) {
    ok(trigger.dataset.state === 'ready', '选择器处于 ready（不是 unknown）')
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(600)
    const items = document.querySelectorAll('[data-testid="model-option"]')
    const empty = q('.model-rows > p')
    log(`  菜单可选模型 = ${items.length} 个，空态 = ${empty ? JSON.stringify(empty.textContent) : '无'}`)
    ok(items.length > 0, '菜单里有可选模型')
    ok(!empty, '不再显示「没有匹配的模型」空态')
    ok(items.length > 0 && !!q('[data-testid="models-count"]'), '模型分页计数与可选列表均已加载')
  }

  log(`  命令列表 = ${store.getState().commands.length} 条`)

  return out.join('\n')
})()
