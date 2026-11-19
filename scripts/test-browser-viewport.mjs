import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { BROWSER_VIEWPORT_PRESETS, isBrowserViewport, viewportRect } = await compile('src/shared/browser-viewport.ts')
  const pane = { x: 20, y: 40, width: 500, height: 466 }
  const mobile = viewportRect(pane, 'mobile-wide')
  ok(mobile.scale === 0.5 && mobile.width === 215 && mobile.height === 466 && mobile.x === 163 && mobile.y === 40, '高屏设备按面板高度缩放并居中')
  for (const [name, preset] of Object.entries(BROWSER_VIEWPORT_PRESETS)) {
    const fit = viewportRect(pane, name)
    ok(isBrowserViewport(name) && fit.emulated.width === preset.width && fit.emulated.height === preset.height && fit.width <= pane.width && fit.height <= pane.height, `${name} 保留预设尺寸并适配面板`)
  }
  const responsive = viewportRect(pane, 'responsive')
  ok(responsive.emulated === null && responsive.x === pane.x && responsive.y === pane.y && responsive.width === pane.width && responsive.height === pane.height, '自适应不缩放')
  ok(!['__proto__', 'constructor', 'unknown', null].some(isBrowserViewport), '拒绝未知预设')
})
