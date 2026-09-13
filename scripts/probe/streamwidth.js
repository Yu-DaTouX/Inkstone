/**
 * 对话宽度自定义（用户要求：「对话宽度自定义（注意消息指引柄的位置）」）。
 *
 * 断言三件事：
 *   ① 设置里的 streamWidth 会写进 CSS 变量 --w-stream，并被内容列采用
 *   ② 0 = 恢复设计默认（变量被移除，回到 tokens.css 的 900px）
 *   ③ 导航轨（消息指引柄）在宽度变化后重新测量、仍贴在正文左侧
 *      （这正是用户特意提醒的「注意消息指引柄的位置」）
 */
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
  // 注入 4 轮消息，让导航轨出现（<3 轮不渲染）
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

    // 加宽到 1100 → 内容列变宽（左缘左移），导轨必须跟着左移；刻度到正文的距离不变
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
      Number.isFinite(gapAt720) && Number.isFinite(gapAt1100) && Math.abs(gapAt720 - gapAt1100) <= 12,
      '变宽后刻度与正文的相对位置保持稳定（导轨跟着内容列走）'
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
  ok(contentMax() === '900px', `内容列回到设计默认 900px（实际 ${contentMax()}）`)

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
    // React 受控 range：必须走原生 value setter，否则 React 的 value tracker 不认
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
    // 恢复默认
    click(q('[data-testid="set-stream-width-reset"]'))
    await sleep(600)
    ok((store.getState().settings?.streamWidth ?? -1) === 0, '「恢复默认」把宽度设回 0')
  }

  return out.join('\n')
})()
