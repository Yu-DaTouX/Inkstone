import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startProfile, stopProfile } from '../lib/cpu-profile.mjs'
import { SCROLL_HOOK, scrollStats } from '../lib/scroll-probes.mjs'

export const meta = { description: '真实数据副本（配 --days 0 --include-sessions <片段>，YAN_SCROLL_SESSION 指定片段）：大会话切入、滚轮上下滚、大纲跳转、查找跳转、回到底部、过程区展开的逐帧位移/白屏/长帧，不调用模型' }

export default async function run({ cdp, waitFor, report, sleep, log, shot, out }) {
  const ev = (expr) => cdp.evaluate(expr)
  const tag = process.env.YAN_SCROLL_TAG ?? 'run'
  const fragment = process.env.YAN_SCROLL_SESSION ?? '01a186fd'
  const want = (name) => !process.env.YAN_SCROLL_PHASES || process.env.YAN_SCROLL_PHASES.split(',').includes(name)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor('s.sessions.length > 0', 60000, 20)
  await ev(SCROLL_HOOK)
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false, workspaceTiles: true })`)
  const file = await ev(`(window.__yanStore.getState().sessions.find((x) => x.path.includes(${JSON.stringify(fragment)})) || {}).path`)
  if (!file) throw new Error('找不到会话 ' + fragment)
  report.file = file
  const record = async (name, action, settle = 700) => {
    const prof = (process.env.YAN_SCROLL_PROFILE ?? '').split(',').includes(name)
    if (prof) await startProfile(cdp)
    await ev('window.__sp.start()')
    const t = Date.now()
    await action()
    await sleep(settle)
    const raw = await ev('window.__sp.stop()')
    if (prof) {
      const p = await stopProfile(cdp, out)
      writeFileSync(join(out, `${tag}-${name}-profile.json`), JSON.stringify({ top: p.top, longBusy: p.longBusy }, null, 1))
      log('profile', name, JSON.stringify(p.top.slice(0, 12)))
      log('longBusy', name, JSON.stringify(p.longBusy))
    }
    const stats = { ...scrollStats(raw), ms: Date.now() - t }
    report.timings[name] = stats
    writeFileSync(join(out, `${tag}-${name}.json`), JSON.stringify(raw))
    log(name, stats)
    return stats
  }
  const point = () => ev(`(() => { const r = document.querySelector('.v3-stream').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const wheel = async (deltaY, count, gap = 16) => {
    const p = await point()
    for (let i = 0; i < count; i++) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY })
      await sleep(gap)
    }
  }

  await record('open', async () => {
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
    await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(file)} && s.messages.length > 20`, 120000, 10)
  }, 1500)
  report.messages = await ev('window.__yanStore.getState().messages.length')
  log('messages', report.messages)
  await shot(`${tag}-open`)

  if (want('up')) {
    await record('wheel-up', () => wheel(-120, 120), 800)
    await record('wheel-up-fast', () => wheel(-400, 100, 8), 800)
  }
  if (want('down')) await record('wheel-down', () => wheel(120, 120), 800)
  if (want('jump')) {
    await record('jump-latest', async () => {
      await ev(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
    }, 2500)
  }
  if (want('nav')) {
    const n = await ev(`document.querySelectorAll('[data-testid="v3-outline-tick"]').length`)
    log('outline ticks', n)
    for (const [name, frac] of [['nav-far', .35], ['nav-mid', .6], ['nav-top', 0]]) {
      const index = Math.floor((n - 1) * frac)
      await record(name, async () => {
        await ev(`document.querySelector('[data-testid="v3-outline-tick"][data-index="${index}"]')?.click()`)
      }, 2500)
    }
  }
  if (want('find')) {
    await record('find', async () => {
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
      await sleep(300)
      await ev(`(() => { const i = document.querySelector('[data-testid="v3-session-find"]'); i && i.focus() })()`)
      await cdp.call('Input.insertText', { text: process.env.YAN_SCROLL_FIND ?? '修复' })
      await sleep(1200)
      for (let i = 0; i < 4; i++) {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await sleep(500)
      }
    }, 800)
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  }
  if (want('reload')) {
    const other = await ev(`(window.__yanStore.getState().sessions.find((x) => x.path !== ${JSON.stringify(file)} && x.messageCount > 8) || {}).path`)
    if (other) {
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(other)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(other)} && s.messages.length > 0`, 60000, 10)
      await sleep(1000)
    }
    await record('reopen', async () => {
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(file)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(file)} && s.messages.length > 20`, 120000, 10)
    }, 1500)
  }
}
