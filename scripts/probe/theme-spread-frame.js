;(async () => {
  const TRIGGER_AT_MS = 2000
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const startedAt = Date.now()
  const out = []
  const store = window.__yanStore
  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready' && store.getState().settings) break
    await sleep(250)
  }
  for (let i = 0; i < 25; i++) {
    const card = document.querySelector('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }
  store.getState().closeSettings?.()

  store.getState().openSettings('appearance')
  await sleep(400)
  if (document.documentElement.dataset.theme !== 'light') {
    const light = document.querySelector('[data-testid="theme-light"]')
    if (light) {
      light.click()
      await sleep(1500)
    }
  }

  await sleep(Math.max(0, TRIGGER_AT_MS - (Date.now() - startedAt)))

  const target = document.querySelector('[data-testid="theme-dark"]')
  if (!target) return '  ✗ 找不到 theme-dark 按钮'
  const before = document.documentElement.dataset.theme
  target.click()
  const dir = document.documentElement.dataset.themeDir ?? '∅'
  out.push(`  主题 ${before} → ${document.documentElement.dataset.theme}｜direction=${dir}`)
  out.push(`  transition=${document.documentElement.dataset.themeTransition ?? '∅'}`)
  await sleep(1500)
  return out.join('\n')
})()
