import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resizeWindow, setTheme, textAudit } from '../lib/review-kit.mjs'

export const meta = { description: '用户视角走查：新建、流式、审批、提问、完成卡、切会话、分屏、右栏、设置、用量；WT_WIDTH（默认 1778）、WT_TAG、WT_PART' }

const WIDTH = Number(process.env.WT_WIDTH || 1778)
const TAG = process.env.WT_TAG || 'a'
const PART = process.env.WT_PART || 'all'
const HEIGHT = 1000
const RUNNING = '!!(s.session?.isStreaming || s.session?.isAgentRunning)'

export default async function run({ cdp, check, waitFor, sleep, out, newSession, turn, state, autoApprove, log, box }) {
  const dir = join(out, `${TAG}-${WIDTH}`)
  mkdirSync(dir, { recursive: true })
  await resizeWindow(cdp, WIDTH, HEIGHT)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: WIDTH > 1000 ? 0.8 : 1, mobile: false })
  await sleep(500)
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN', rightPanelOpen: false })`)
  const ev = (expr) => cdp.evaluate(expr)
  const snap = async (name, d = dir) => {
    const res = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
    writeFileSync(join(d, name + '.jpg'), Buffer.from(res.result.data, 'base64'))
  }
  const audits = {}
  const both = async (name) => {
    for (const theme of ['dark', 'light']) {
      await setTheme(cdp, theme)
      await sleep(250)
      await snap(`${name}-${theme}`, dir)
      const a = await textAudit(cdp, 'body')
      audits[`${name}-${theme}`] = { low: a.lowContrastCount, lowItems: (a.lowContrast ?? []).slice(0, 6), truncated: a.truncatedCount, truncItems: (a.truncated ?? []).slice(0, 6), tiny: (a.tinyFont ?? []).slice(0, 4) }
    }
    await setTheme(cdp, 'dark')
  }
  process.on('exit', () => { try { writeFileSync(join(dir, `audits-${PART}.json`), JSON.stringify(audits, null, 1)) } catch {} })
  const frames = async (name, ms, gap = 260) => {
    const end = Date.now() + ms
    let i = 0
    while (Date.now() < end) {
      await snap(`${name}-${String(i++).padStart(2, '0')}`, dir)
      await sleep(gap)
    }
  }
  const screencast = async (name, action, ms = 700) => {
    cdp.events.length = 0
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 })
    const got = []
    const drain = () => {
      for (const event of cdp.events.splice(0)) {
        if (event.method === 'Page.screencastFrame') {
          got.push({ t: event.params.metadata.timestamp, data: event.params.data })
          void cdp.call('Page.screencastFrameAck', { sessionId: event.params.sessionId })
        }
      }
    }
    const pump = setInterval(drain, 10)
    await sleep(150)
    await action()
    await sleep(ms)
    clearInterval(pump)
    await cdp.call('Page.stopScreencast')
    drain()
    const t0 = got[0]?.t ?? 0
    got.forEach((frame, i) => writeFileSync(join(dir, `${name}-f${String(i).padStart(2, '0')}-${Math.round((frame.t - t0) * 1000)}ms.jpg`), Buffer.from(frame.data, 'base64')))
    log(name, `${got.length} 帧`)
    return got.length
  }
  const chord = (key, code) => async () => {
    const base = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: code, modifiers: 3 }
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  const NEW_RIGHT = chord(String.fromCharCode(92), 220)
  const CLOSE = chord('W', 87)
  const NEXT = chord(']', 221)
  const sendDuring = async (text, name, ms) => {
    const done = turn(text, { settleMs: 800 })
    await sleep(500)
    await frames(name, ms)
    await done
  }

  if (PART === 'probe') {
    await autoApprove()
    const refs = []
    for (const name of ['ALPHA', 'BRAVO']) {
      await newSession(box.project)
      await turn(`${name} SHORT MDSHOW`, { settleMs: 600 })
      refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
    }
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(refs[0].path)})`)
    await sleep(1500)
    await ev(`(() => { window.__p = { rows: [], stop: false, t0: performance.now() }; const tick = () => { const t = Math.round(performance.now() - window.__p.t0); const streams = [...document.querySelectorAll('.v3-stream')].filter((el) => el.clientHeight > 0); window.__p.rows.push({ t, s: streams.map((el) => [Math.round(el.scrollTop), el.scrollHeight, el.clientHeight, Math.round(el.getBoundingClientRect().left)]) }); if (!window.__p.stop) requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
    await sleep(300)
    await NEW_RIGHT()
    await sleep(1500)
    const rows = await ev('window.__p.stop = true; window.__p.rows')
    let prev = ''
    const lines = []
    for (const row of rows) { const key = JSON.stringify(row.s); if (key !== prev) { lines.push(row.t + ' ' + key); prev = key } }
    writeFileSync(join(dir, 'probe-split-add.txt'), lines.join(String.fromCharCode(10)))
    log('probe', lines.length + ' 变化')
  }

  if (PART === 'all' || PART === 'chat') {
    await autoApprove()
    await newSession(box.project)
    await sleep(600)
    await both('01-new')
    await sendDuring('FLOW 走查 SHORT', '02-flow-dark', 5000)
    await both('03-flow-done')
    await setTheme(cdp, 'light')
    await sendDuring('FLOW 走查二 SHORT', '02-flow-light', 5000)
    await setTheme(cdp, 'dark')
    await sendDuring('MDSHOW CHUNK14 GAP40', '04-md-dark', 6000)
    await both('05-md-done')
    await ev(`(() => { const s = document.querySelector('.v3-stream'); if (s) s.scrollTop = 0 })()`)
    await sleep(500)
    await both('05b-md-top')
  }

  if (PART === 'all' || PART === 'ask') {
    await newSession(box.project)
    await ev(`window.__yanStore.getState().send('APPROVAL 走查')`)
    await waitFor(`s.approvals.length > 0`, 30000)
    await sleep(900)
    await both('06-approval')
    const id = await state('s.approvals[0].id')
    await ev(`window.__yanStore.getState().answerApproval(${JSON.stringify(id)}, 'deny')`)
    await waitFor(`!(${RUNNING})`, 60000)
    await ev(`window.__yanStore.getState().send('QUESTION 走查')`)
    await waitFor(`!!document.querySelector('.v3-qrow, [data-testid^="v3-question"]')`, 40000)
    await sleep(900)
    await both('07-question')
  }

  if (PART === 'all' || PART === 'done') {
    await autoApprove()
    await newSession(box.project)
    await turn('WRITES 走查', { settleMs: 1500 })
    await both('08-done-card')
  }

  if (PART === 'all' || PART === 'split') {
    await autoApprove()
    const refs = []
    for (const name of ['ALPHA', 'BRAVO', 'CHARLIE']) {
      await newSession(box.project)
      await turn(`${name} SHORT MDSHOW`, { settleMs: 600 })
      refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
    }
    await both('09-before-split')
    await screencast('10-switch-session', () => ev(`window.__yanStore.getState().switchSession(${JSON.stringify(refs[0].path)})`), 900)
    await sleep(600)
    await screencast('11-split-add2', NEW_RIGHT, 900)
    await sleep(800)
    await both('12-split2')
    await screencast('13-split-add3', NEW_RIGHT, 900)
    await sleep(800)
    await both('14-split3')
    const clickTitle = async (key) => {
      const p = await ev(`(() => { const el = document.querySelector('[data-tile-key="${key}"] .v3-split-title'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
      if (!p) return false
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      return true
    }
    await screencast('15-split-focus', NEXT, 900)
    await sleep(500)
    await snap('16-split-focused', dir)
    await screencast('17-split-remove', CLOSE, 900)
    await sleep(500)
    await screencast('18-split-close', CLOSE, 900)
    await sleep(500)
    await snap('19-after-split', dir)
  }

  if (PART === 'all' || PART === 'panel') {
    await newSession(box.project)
    await ev(`window.__yanStore.getState().patchSettings({ rightPanelOpen: true })`)
    for (const kind of ['changes', 'terminal', 'files', 'browser', 'context', 'branch', 'logs', 'quota', 'device', 'pullRequests']) {
      await ev(`window.__yanRightPanel.getState().setOpen(true); window.__yanRightPanel.getState().open({ id: '${kind}', kind: '${kind}' })`)
      await sleep(900)
      await both(`20-panel-${kind}`)
    }
    await ev(`window.__yanRightPanel.getState().split('files')`)
    await sleep(800)
    await both('21-panel-split-columns')
    await screencast('22-panel-hide', () => ev(`window.__yanRightPanel.getState().setOpen(false)`), 800)
    await screencast('23-panel-show', () => ev(`window.__yanRightPanel.getState().setOpen(true)`), 800)
    await ev(`window.__yanRightPanel.getState().setOpen(false)`)
  }

  if (PART === 'all' || PART === 'settings') {
    await ev(`window.__yanStore.getState().openSettings()`)
    await sleep(1000)
    const ids = await ev(`Array.from(document.querySelectorAll('.ui-settings [data-testid^="v3-settings-nav-"]')).map((n) => n.getAttribute('data-testid'))`)
    let n = 0
    for (const id of ids) {
      await ev(`document.querySelector('[data-testid="${id}"]')?.click()`)
      await sleep(700)
      await both(`30-settings-${String(++n).padStart(2, '0')}-${id.replace('v3-settings-nav-', '')}`)
    }
    await ev(`window.__yanStore.getState().closeSettings?.(); document.querySelector('.ui-settings')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
    await ev(`window.location.hash = '#/usage'`)
    await sleep(1500)
    await both('40-usage')
    await ev(`window.location.hash = '#/'`)
    await sleep(600)
  }

  if (PART === 'all' || PART === 'keys') {
    await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
    await sleep(300)
    const refs = []
    for (const name of ['KEYA', 'KEYB']) {
      await newSession(box.project)
      await turn(`${name} SHORT`, { settleMs: 500 })
      refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
    }
    await screencast('50-reduce-split-add', () => ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 1 })`), 600)
    await screencast('51-reduce-split-close', () => ev(`window.__yanSplit.getState().close()`), 600)
    await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
    await ev(`document.activeElement?.blur()`)
    const trail = []
    for (let i = 0; i < 14; i++) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await sleep(180)
      trail.push(await ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return null; const r = a.getBoundingClientRect(); const cs = getComputedStyle(a); return { tag: a.tagName, label: (a.getAttribute('aria-label') || a.getAttribute('data-testid') || a.textContent || '').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow.slice(0, 40) } })()`))
      if (i % 3 === 0) await snap(`60-tab-${String(i).padStart(2, '0')}`, dir)
    }
    writeFileSync(join(dir, 'tab-trail.json'), JSON.stringify(trail, null, 2))
    check('Tab 序列每步都有焦点元素', trail.filter(Boolean).length >= 10, trail.filter((t) => !t).length)
  }
}
