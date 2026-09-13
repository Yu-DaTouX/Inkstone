/**
 * 自主模式开关（用户要求：放在输入框下方，打开后模型不再提疑问）。
 *
 * 这个探针只验**界面与设置接线**：
 *   · 开关在输入框下方（.composer 之下、.usagebar 附近）
 *   · 点击切换 settings.autonomous 并落盘（主进程）
 *   · 视觉状态（data-on / aria-pressed / .on）
 * 「模型不再提问」的逻辑由 test:unit 的 question 扩展测试覆盖
 * （读 desktop.json → 系统提示切换 / execute 不弹窗）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
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
  await sleep(600)

  out.push('=== 1. 位置：输入栏里（composer-bar）===')
  const toggle = q('[data-testid="autonomous-toggle"]')
  ok(!!toggle, '存在自主模式开关')
  if (!toggle) return out.join('\n')
  ok(!!toggle.closest('.composer-bar'), '在输入栏工具行里（composer-bar）')
  ok(!!toggle.closest('.composer'), '在输入框（composer）内')
  // 不应再有输入框下方单独的一行开关
  ok(!q('[data-testid="modebar"]'), '不再有输入框下方的独立开关栏')
  // 用户要求：去掉「未开启 / 已开启」字样
  const label = (toggle.textContent || '').trim()
  ok(!/未开启|已开启|\boff\b|\bon\b/i.test(label), `开关上没有开/关文字（实际 ${JSON.stringify(label)}）`)

  out.push('')
  out.push('=== 2. 默认关闭 → 点击打开 ===')
  // 先确保是关的
  if (store.getState().settings?.autonomous) {
    await store.getState().patchSettings({ autonomous: false })
    await sleep(400)
  }
  ok(toggle.getAttribute('data-on') === '0', '默认关闭')
  click(toggle)
  await sleep(600)
  ok(store.getState().settings?.autonomous === true, '点击后 settings.autonomous = true')
  const t2 = q('[data-testid="autonomous-toggle"]')
  ok(t2?.getAttribute('data-on') === '1' && t2?.classList.contains('on'), '开关视觉变为开启态')
  ok(t2?.getAttribute('aria-checked') === 'true', 'aria-checked 同步')

  out.push('')
  out.push('=== 3. 再点关闭（落盘）===')
  click(q('[data-testid="autonomous-toggle"]'))
  await sleep(600)
  ok(store.getState().settings?.autonomous === false, '再点回到关闭')
  // 重新拉一次设置，确认真的落盘（不是只在内存里）
  const persisted = await window.yan.getSettings()
  ok(persisted.autonomous === false, '设置已落盘（getSettings 确认）')

  return out.join('\n')
})()
