;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  log('=== 用量条（输入 / 输出 / 缓存命中 / 输出速度）===')

  // 等 pi 连上
  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') return '✗ pi 未连上'

  store.getState().closeSettings()
  await sleep(300)

  const ta = q('[data-testid="composer"]')

  /* ---- 1. 还没跑过对话时不占位 ---- */
  log('\n--- 1. 空会话不占位 ---')
  const beforeHas = !!q('[data-testid="usagebar"]')
  log('  跑对话前 tokbar 存在: ' + beforeHas)

  /* ---- 2. 发一条真消息 ---- */
  log('\n--- 2. 真发一条，观察数字 ---')
  setVal(ta, '用一句话说明什么是 RAII。不要用工具。')
  await sleep(250)
  q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  // 流式期间采样一次
  let liveSample = null
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    const bar = q('[data-testid="usagebar"]')
    if (bar && store.getState().session?.isStreaming) {
      liveSample = bar.textContent.replace(/\s+/g, ' ').trim()
      break
    }
    if (!store.getState().session?.isStreaming && i > 5) break
  }
  log('  流式期间: ' + JSON.stringify(liveSample))

  // 等结束
  for (let i = 0; i < 200; i++) {
    await sleep(500)
    const busy = store.getState().session?.isStreaming || !!q('.cursor')
    const lastMsg = [...store.getState().messages].reverse().find((m) => m.role === 'assistant' && m.usage)
    if (!busy && lastMsg) break
  }
  await sleep(1200)

  /* ---- 3. 断言：DOM 里有条，字段齐全 ---- */
  const bar = q('[data-testid="usagebar"]')
  ok(!!bar, 'tokbar 出现了')
  if (!bar) return out.join('\n')

  log('  内容: ' + JSON.stringify(bar.textContent.replace(/\s+/g, ' ').trim()))

  const toks = qa('.usagebar .ub-item')
  log('  字段数: ' + toks.length)
  const labels = toks.map((x) => x.querySelector('.ub-label')?.textContent)
  log('  标签: ' + JSON.stringify(labels))
  for (const need of ['输入', '输出', '缓存', '速度']) {
    ok(labels.includes(need), `有「${need}」`)
  }

  /* ---- 4. 数字真实性：与 store 里的 usage 对齐 ---- */
  const last = [...store.getState().messages].reverse().find((m) => m.role === 'assistant' && m.usage)
  log('\n--- 4. 与真实 usage 对比 ---')
  log('  usage: ' + JSON.stringify(last?.usage))
  log('  speed: ' + (last?.speed ? last.speed.toFixed(2) + ' tok/s' : '（无）'))
  log('  elapsedMs: ' + last?.elapsedMs)

  ok(last?.usage?.output > 0, `output = ${last?.usage?.output}（应 > 0）`)
  ok(last?.usage?.input > 0 || last?.usage?.cacheRead > 0, '有输入侧用量')
  ok(last?.speed > 0, `速度有值：${last?.speed?.toFixed(1)} tok/s`)
  ok(
    last?.speed > 5 && last?.speed < 3000,
    `速度在合理范围（${last?.speed?.toFixed(1)}，5~3000 tok/s）`
  )

  // 输出字段应该显示的就是 output
  const outTok = toks.find((x) => x.querySelector('.ub-label')?.textContent === '输出')
  const outShown = outTok?.querySelector('.ub-value')?.textContent ?? ''
  log('  输出显示: ' + JSON.stringify(outShown))
  ok(outShown.length > 0 && outShown !== '—', '输出有数字而不是 —')

  // 缓存命中率
  const cacheTok = toks.find((x) => x.querySelector('.ub-label')?.textContent === '缓存')
  const hitShown = cacheTok?.querySelector('.ub-extra')?.textContent ?? ''
  log('  命中率显示: ' + JSON.stringify(hitShown))
  const u = last.usage
  const expect =
    u.cacheRead + u.input > 0
      ? (() => {
          const pct = (u.cacheRead / (u.cacheRead + u.input)) * 100
          // 与 UsageBar 的 formatHitRate 同一规则：≥99.5% 显示“≈100%”，否则一位小数
          return pct >= 99.5 ? '≈100%' : pct.toFixed(1) + '%'
        })()
      : null
  if (expect) {
    ok(hitShown === expect, `命中率 = ${hitShown}（应 ${expect}）`)
  } else {
    ok(true, '（本轮无提示词用量，跳过命中率断言）')
  }

  // tooltip 信息
  ok(!!cacheTok?.getAttribute('title'), '缓存项有 tooltip 说明算法')

  /* ---- 5. 大数缩写 ---- */
  log('\n--- 5. 格式化 ---')
  log('  输入显示: ' + JSON.stringify(toks.find((x) => x.querySelector('.ub-label')?.textContent === '输入')?.querySelector('.ub-value')?.textContent))
  ok(!/\d{6,}/.test(bar.textContent), '没有裸露的六位以上数字（应该缩写）')

  /* ---- 6. 新会话：条在，但没有用量数字 ---- */
  log('\n--- 6. 新会话：条在但没有用量数字 ---')
  await store.getState().newSession()
  await sleep(3000)
  ok(!!q('[data-testid="usagebar"]'), '新会话仍显示用量条（模型已连上）')
  {
    const outItem = qa('.usagebar .ub-item').find((x) => x.querySelector('.ub-label')?.textContent === '输出')
    const v = outItem?.querySelector('.ub-value')?.textContent ?? ''
    ok(v.startsWith('—') || v === '', `新会话「输出」没有数字（实际 ${JSON.stringify(v)}）`)
  }

  /* ---- 7. 溢出 ---- */
  const over = bar.scrollWidth - bar.clientWidth
  ok(over <= 0, `用量条无横向溢出（差 ${over}）`)

  return out.join('\n')
})()
