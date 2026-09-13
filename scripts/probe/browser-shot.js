/*
 * 内置浏览器位置/缩放诊断探针（手动跑，未注册为 test:live 场景）。
 *
 * 为什么需要它：原生 WebContentsView 永远在渲染层之上，截图（capturePage /
 * desktopCapturer）都不保证包含它，排查“位置不对”时不能只看截图。
 * 这里一次性吐出四组可以互相校验的数：
 *   viewport   —— DOM 里可见区域的 getBoundingClientRect()（CSS 像素）
 *   innerWidth / devicePixelRatio —— 主窗口渲染进程的实际缩放
 *   zoom       —— 生效倍率（与 dpr 对照可判断到底有没有应用上）
 *   nativeBounds —— 主进程实际设给 WebContentsView 的 DIP
 * 期望：nativeBounds ≈ viewport × zoom。
 *
 * 用法（隔离目录，避免碰真实用户数据）：
 *   YAN_USER_DATA=/tmp/u YAN_PROBE=scripts/probe/browser-shot.js YAN_PROBE_DELAY=9000 npx electron .
 */
(async () => {
  const toggle = document.querySelector('[data-testid="browser-view-toggle"]')
  if (!toggle) throw new Error('browser toggle not found')
  toggle.click()
  await new Promise((resolve) => setTimeout(resolve, 2200))
  return JSON.stringify({
    viewport: document.querySelector('.browser-viewport')?.getBoundingClientRect().toJSON(),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    zoom: await window.yan.getZoom(),
    browser: await window.yan.browser.getState()
  })
})()
