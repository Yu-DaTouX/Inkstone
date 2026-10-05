/**
 * 会话切换器（Ctrl+K）：能打开、能输入、能用键盘选、Esc 关闭；
 * 结果里的会话与左栏同源（store.sessions）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore（探针没被注入）'
  const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  ok(!q('[data-testid="session-switcher"]'), '默认没有切换器')
  key('k', { ctrlKey: true })
  await sleep(300)
  const box = q('[data-testid="session-switcher"]')
  ok(!!box, 'Ctrl+K 打开切换器')
  const input = q('[data-testid="switcher-input"]')
  ok(!!input && document.activeElement === input, '输入框自动聚焦')
  const sessions = store.getState().sessions
  const rows = () => [...document.querySelectorAll('[data-testid="switcher-row"]')]
  if (sessions.length > 1) ok(rows().length > 0 && rows().length <= 12, '没输入时列出最近的会话', `rows=${rows().length}`)

  const first = sessions[0]
  if (first) {
    const word = (first.title || '').split(/\s+/).find((w) => w.length >= 2) || ''
    if (word) {
      setVal(input, word)
      await sleep(700)
      ok(rows().some((r) => r.textContent.includes(word)), '按标题里的词能搜到那个会话', `word=${word}`)
    }
  }
  setVal(input, '__一定不存在的词__zzzq')
  await sleep(700)
  ok(rows().length === 0 && !!q('.switcher-empty'), '搜不到时给出空状态')

  key('Escape')
  await sleep(250)
  ok(!q('[data-testid="session-switcher"]'), 'Esc 关闭')
  key('k', { ctrlKey: true })
  await sleep(250)
  ok(!!q('[data-testid="session-switcher"]'), '可以再次打开')
  key('k', { ctrlKey: true })
  await sleep(250)
  ok(!q('[data-testid="session-switcher"]'), '再按 Ctrl+K 关闭')
  return out.join('\n')
})()
