;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')
  await sleep(1500)

  const rootVar = () => getComputedStyle(document.documentElement).getPropertyValue('--w-stream').trim()
  const contentMax = () => {
    const el = q('.stream-inner') || q('.stream-row')
    return el ? getComputedStyle(el).maxWidth : null
  }

  out.push('=== 1. 改宽度 → CSS 变量 + 内容列同步 ===')
  store.getState().patchSettings({ streamWidth: 720 })
  await sleep(500)
  ok(rootVar() === '720px', `--w-stream = ${rootVar()}（应为 720px）`)
  ok(contentMax() === '720px', `内容列 max-width = ${contentMax()}`)

  out.push('')
  out.push('=== 2. 改宽 → 导航轨重新测量 ===')
  const fake = []
  for (let i = 1; i <= 4; i++) {
    fake.push({ id: 'sw-u' + i, role: 'user', text: '第 ' + i + ' 个问题' })
    fake.push({ id: 'sw-a' + i, role: 'assistant', text: '第 ' + i + ' 个回答' + 'x'.repeat(60) })
  }
  store.getState().applyPush({ ch: 'sync', payload: fake })
  await sleep(900)
  const outline = q('.outline')
  const inner = q('.stream-inner')
  ok(!!outline, '导航轨已渲染')
  if (outline && inner) {
    const bar = q('.outline-hit .outline-bar')
    const gapAt720 = bar
      ? +(inner.getBoundingClientRect().left + 24 - bar.getBoundingClientRect().right).toFixed(1)
      : NaN
    out.push(`  宽度 720 时刻度右缘距正文 ${gapAt720}px`)

    store.getState().patchSettings({ streamWidth: 1100 })
    await sleep(700)
    const bar2 = q('.outline-hit .outline-bar')
    const inner2 = q('.stream-inner')
    const gapAt1100 =
      bar2 && inner2
        ? +(inner2.getBoundingClientRect().left + 24 - bar2.getBoundingClientRect().right).toFixed(1)
        : NaN
    out.push(`  宽度 1100 时刻度右缘距正文 ${gapAt1100}px`)
    ok(
      Number.isFinite(gapAt720) && Number.isFinite(gapAt1100) && gapAt720 >= -1 && gapAt1100 >= -1,
      '任意宽度下刻度都不压到正文（导轨固定贴会话区左缘，正文按 --outline-avoid 让位）'
    )
  }

  out.push('')
  out.push('=== 3. 恢复默认 ===')
  store.getState().patchSettings({ streamWidth: 0 })
  await sleep(500)
  ok(
    document.documentElement.style.getPropertyValue('--w-stream') === '',
    '内联 --w-stream 已被移除（回落到设计默认值）'
  )
  const rootStyle = getComputedStyle(document.documentElement)
  const defaults = Math.max(
    (parseFloat(rootStyle.getPropertyValue('--w-body')) || 720) + 2 * (parseFloat(rootStyle.getPropertyValue('--sp-5')) || 24),
    Math.min(window.innerWidth - 680, 920)
  )
  ok(contentMax() === defaults + 'px', `内容列回到设计默认（clamp 解 ${defaults}px，实际 ${contentMax()}）`)

  out.push('')
  out.push('=== 4. 设置里的滑块 ===')
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  click(q('[data-testid="rail-settings"]'))
  await sleep(400)
  click([...document.querySelectorAll('.settings-tab')].find((x) => /外观|Appearance/.test(x.textContent)))
  await sleep(400)
  const slider = q('[data-testid="set-stream-width"] input[type="range"]')
  ok(!!slider, '外观页有对话宽度滑块')
  if (slider) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(slider, '640')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await sleep(700)
    ok(rootVar() === '640px', `滑块改动写入 --w-stream（实际 ${rootVar()}）`)
    ok((store.getState().settings?.streamWidth ?? 0) === 640, '滑块改动落盘到设置')
    ok(
      (q('[data-testid="set-stream-width-now"]')?.textContent ?? '').includes('640'),
      '滑块旁边的数值同步显示'
    )
    click(q('[data-testid="set-stream-width-reset"]'))
    await sleep(600)
    ok((store.getState().settings?.streamWidth ?? -1) === 0, '「恢复默认」把宽度设回 0')
  }

  return out.join('\n')
})()
