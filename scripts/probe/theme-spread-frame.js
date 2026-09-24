/**
 * F7 主题切换「扩散」方向的**真实窗口动画中帧**。
 *
 * 为什么单做一个探针：视觉矩阵用的是隐藏窗口，`View Transition` 的中帧在
 * 被遮挡 / 离屏时不稳定（HANDOFF 已记录），只有真实可见窗口才能稳定采到。
 * 这里只负责**在对齐好的时刻触发扩散**，截图由主进程的 `YAN_PROBE_SHOT`
 * 连续抓帧通道完成（`YAN_PROBE_SHOT_DELAY` / `YAN_PROBE_SHOT_INTERVAL`）。
 *
 * 时序约定：就绪后固定等 `TRIGGER_AT_MS` 再点主题按钮；调用方把连拍起点设在
 * 其之前（见 `.yan-tmp` 里的运行命令）。
 */
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
  /* 关掉引导卡，保证画面里是主界面 */
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
  /*
   * 先落到浅色：只有「浅色 → 深色」才是**扩散**方向（圆心由小变大）。
   * 这一步必须在对齐之前做完，否则它会推迟真正的触发时刻。
   */
  if (document.documentElement.dataset.theme !== 'light') {
    const light = document.querySelector('[data-testid="theme-light"]')
    if (light) {
      light.click()
      await sleep(1500)
    }
  }

  /* 对齐：连拍从这里往前一点开始，扩散帧落在连拍窗口内 */
  await sleep(Math.max(0, TRIGGER_AT_MS - (Date.now() - startedAt)))

  /* 当前是浅色 → 点深色：这才是**扩散**方向（圆心从小变大） */
  const target = document.querySelector('[data-testid="theme-dark"]')
  if (!target) return '  ✗ 找不到 theme-dark 按钮'
  const before = document.documentElement.dataset.theme
  target.click()
  const dir = document.documentElement.dataset.themeDir ?? '∅'
  out.push(`  主题 ${before} → ${document.documentElement.dataset.theme}｜direction=${dir}`)
  out.push(`  transition=${document.documentElement.dataset.themeTransition ?? '∅'}`)
  /* 扩散动画期间保持画面不动，让连拍采到中帧 */
  await sleep(1500)
  return out.join('\n')
})()
