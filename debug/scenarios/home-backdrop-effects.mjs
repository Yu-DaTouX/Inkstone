import { click, setTheme } from '../lib/review-kit.mjs'

export const meta = { description: '新标签页背景：动态网点（Paper Shaders 抖动）、图片的抖动与网点效果、设置项、会话里静止变淡、减弱动效时静止' }

const MAKE_IMAGE = `(() => {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
  const g = c.getContext('2d');
  g.fillStyle = '#120a2a'; g.fillRect(0, 0, 1600, 1000);
  const blob = (x, y, r, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 1600, 1000) };
  blob(1200, 750, 650, 'rgba(120,60,255,0.95)'); blob(350, 250, 500, 'rgba(0,220,230,0.8)'); blob(900, 300, 350, 'rgba(255,120,200,0.7)');
  return c.toDataURL('image/webp', 0.9);
})()`

const setBg = (patch) => `(() => { const k = 'yan:home-background'; const cur = JSON.parse(localStorage.getItem(k) || '{}'); localStorage.setItem(k, JSON.stringify({ ...cur, ...${patch} })); window.dispatchEvent(new StorageEvent('storage', { key: k })); })()`


export default async function run({ cdp, box, check, waitFor, sleep, shot, newSession, report }) {
  const ev = (expr) => cdp.evaluate(expr)
  const frame = async (sel) => {
    const r = await ev(`(() => { const el = document.querySelector('${sel}'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2 - 120, y: b.top + b.height / 2 - 120, width: 240, height: 240, scale: 1 } })()`)
    if (!r) return null
    return (await cdp.call('Page.captureScreenshot', { format: 'png', clip: r })).result?.data ?? null
  }
  await newSession(box.project)
  await ev(`window.__yanStore.getState().patchSettings({ asciiBackground: false })`)

  await ev(setBg(`{ mode: 'dither' }`))
  await waitFor(`!!document.querySelector('[data-testid="v3-home-dither"] canvas')`, 10000)
  await sleep(1200)
  const a = await frame('[data-testid="v3-home-dither"]')
  await sleep(800)
  const b = await frame('[data-testid="v3-home-dither"]')
  check('新标签页的动态网点在动', a !== null && b !== null && a !== b, `${a?.length} ${b?.length}`)
  report.ditherCanvas = await ev(`(() => { const c = document.querySelector('[data-testid="v3-home-dither"] canvas'); return { width: c.width, css: c.getBoundingClientRect().width, dpr: devicePixelRatio } })()`)
  check('网点画布按屏幕实际倍率渲染', report.ditherCanvas.width <= Math.ceil(report.ditherCanvas.css * report.ditherCanvas.dpr) + 2, JSON.stringify(report.ditherCanvas))
  await shot('dither-dark')
  await setTheme(cdp, 'light')
  await sleep(800)
  await shot('dither-light')
  await setTheme(cdp, 'dark')

  await ev(`document.documentElement.dataset.reduceMotion = 'true'; window.dispatchEvent(new Event('yan:reduced-motion'))`)
  await sleep(600)
  const c1 = await frame('[data-testid="v3-home-dither"]')
  await sleep(800)
  const c2 = await frame('[data-testid="v3-home-dither"]')
  check('减弱动效时网点静止', c1 !== null && c1 === c2, `${c1?.length} ${c2?.length}`)
  await ev(`delete document.documentElement.dataset.reduceMotion; window.dispatchEvent(new Event('yan:reduced-motion'))`)

  const image = await ev(MAKE_IMAGE)
  for (const effect of ['none', 'dither', 'halftone']) {
    await ev(setBg(`{ mode: 'image', image: ${JSON.stringify(image)}, effect: '${effect}' }`))
    await sleep(1500)
    const state = await ev(`(() => { const el = document.querySelector('[data-testid="v3-home-image"]'); return el ? { effect: el.dataset.effect ?? null, canvas: !!el.querySelector('canvas') } : null })()`)
    check(`图片效果「${effect}」生效`, !!state && (effect === 'none' ? !state.canvas && state.effect === null : state.canvas && state.effect === effect), JSON.stringify(state))
    await shot(`image-${effect}`)
  }

  await ev(`window.__yanStore.getState().openSettings()`)
  await sleep(1200)
  check('背景设置不在高级折叠里', await ev(`!document.querySelector('[data-testid="v3-appearance-advanced"]')?.closest('.settings-advanced')?.querySelector('[data-testid="v3-home-bg-dither"]')`))
  check('窗口玻璃选项在外观里', await ev(`!!document.querySelector('[data-testid="v3-window-glass-full"]') && !document.querySelector('.settings-advanced [data-testid="v3-window-glass-full"]')`))
  await ev(`document.querySelector('[data-setting-id="appearance-ascii-background"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  check('设置里有动态网点选项', await ev(`!!document.querySelector('[data-testid="v3-home-bg-dither"]')`))
  check('图片模式下有效果选项', await ev(`!!document.querySelector('[data-testid="v3-home-bg-effect-halftone"]')`))
  check('有效果时隐藏虚化', await ev(`!document.querySelector('[data-testid="v3-home-bg-blur"]')`))
  await shot('settings-image-effect')
  await ev(`document.querySelector('[data-testid="v3-home-bg-painting"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await click(cdp, '[data-testid="v3-home-bg-painting"]', { waitMs: 800 })
  const painted = await ev(`JSON.parse(localStorage.getItem('yan:home-background') || '{}')`)
  check('用内置画作后是抖动效果的画', painted.image === 'builtin:twilight' && painted.effect === 'dither' && painted.mode === 'image', JSON.stringify({ image: String(painted.image).slice(0, 20), effect: painted.effect }))
  await shot('settings-painting')
  await ev(`document.querySelector('[data-testid="v3-home-bg-dither"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  await click(cdp, '[data-testid="v3-home-bg-dither"]', { waitMs: 600 })
  check('点动态网点切换模式', await ev(`JSON.parse(localStorage.getItem('yan:home-background') || '{}').mode === 'dither'`))
  await ev(`document.querySelector('.ui-settings-dialog [aria-label="关闭"], [data-testid="v3-settings-close"]')?.click()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)

  await ev(setBg(`{ mode: 'image', image: 'builtin:twilight', effect: 'dither', fade: 0.2 }`))
  await waitFor(`!!document.querySelector('[data-testid="v3-home-image"] canvas')`, 10000)
  await sleep(1500)
  await shot('painting-dither-dark')
  await setTheme(cdp, 'light')
  await sleep(800)
  await shot('painting-dither-light')
  await setTheme(cdp, 'dark')
  await ev(setBg(`{ mode: 'dither' }`))
  await sleep(800)

  await ev(`window.__yanStore.getState().send('你好')`)
  await waitFor(`!window.__yanStore.getState().session?.isStreaming && window.__yanStore.getState().messages.length >= 2`, 30000, 100)
  await sleep(1200)
  const s1 = await frame('[data-testid="v3-home-dither"]')
  await sleep(800)
  const s2 = await frame('[data-testid="v3-home-dither"]')
  check('会话里网点静止', s1 !== null && s1 === s2, `${s1?.length} ${s2?.length}`)
  check('会话里网点更淡', await ev(`getComputedStyle(document.querySelector('[data-testid="v3-home-dither"]'), '::after').opacity === '0.5'`))
  await shot('dither-in-session')
}

