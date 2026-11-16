import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '实时回合屏幕外项的 content-visibility：虚拟（回合 >80）与非虚拟两种模式，按变体（off 关闭规则、240 旧补丁：实时即跳过且估算 240px、est 实时即跳过且估算 32/40px、build 当前样式、clip 当前样式但不留裁剪余量，用来对照焦点环）各跑载入后往上滚的锚点偏差、贴底追加的单帧位移、回合结束那一帧、查找栏、叙述链接焦点环；YAN_CV_VARIANTS、YAN_CV_MODES 可选；仅合成消息' }

const NOTE_CHARS = [21, 26, 31, 35, 38, 42, 45, 48, 52, 55, 59, 63, 67, 72, 77, 84, 93, 108, 140]
const VARIANT_CSS = {
  off: '.v3-stream .v3-spread > * { content-visibility: visible !important; }',
  240: '.v3-stream .v3-spread[data-live] > :is(.v3-process-notes, .v3-process):not(:nth-last-child(-n + 2)) { content-visibility: auto !important; contain-intrinsic-size: auto 240px !important; }',
  est: '.v3-stream .v3-spread[data-live] > :is(.v3-process-notes, .v3-process):not(:nth-last-child(-n + 2)) { content-visibility: auto !important; }',
  build: '',
  clip: '.v3-stream .v3-spread[data-skip] > * { overflow-clip-margin: 0px !important; }'
}

function pageBuild({ prefix, history, items, tools, tallTools, token, linkAt, noteChars }) {
  const now = Date.now()
  const zh = '检查配置文件并继续处理下一步的构建脚本与依赖关系'
  const en = ' update the build config and rerun checks '
  const narration = (i) => {
    const len = noteChars[(i * 7) % noteChars.length]
    let out = ''
    for (let k = 0; out.length < len; k++) out += k % 4 === 3 ? en : zh
    out = out.slice(0, len)
    if (i === linkAt) out = '[参考链接](https://example.invalid/cv) ' + out
    if (i === Math.floor(items / 2)) out = out.slice(0, 10) + ' ' + token + ' ' + out.slice(10)
    return out
  }
  const call = (i, k) => ({ id: `${prefix}-t${i}-${k}`, name: 'bash', args: { command: `echo step ${i}.${k}` }, status: 'ok', output: `step ${i}.${k}\nok` })
  const messages = []
  for (let h = 0; h < history; h++) {
    messages.push({ id: `${prefix}-hu${h}`, role: 'user', text: '历史问题 ' + h, timestamp: now - (history - h) * 60000 })
    messages.push({ id: `${prefix}-ha${h}`, role: 'assistant', text: '历史回答第 ' + h + ' 轮。'.repeat(6), timestamp: now - (history - h) * 60000 + 1000 })
  }
  messages.push({ id: `${prefix}-lu`, role: 'user', text: '实时回合', timestamp: now - 30000 })
  for (let i = 0; i < items; i++) {
    const count = i === items - 1 ? tallTools : tools
    messages.push({ id: `${prefix}-la${i}`, role: 'assistant', text: narration(i), toolCalls: Array.from({ length: count }, (_, k) => call(i, k)), timestamp: now - 29000 + i * 100 })
  }
  window.__cvSeq = items
  const st = window.__yanStore.getState()
  window.__yanStore.setState({ messages, runTail: null, session: { ...st.session, isStreaming: true, isAgentRunning: true }, historyLoading: false, switchLoading: false })
}

function pageAppend({ prefix, tools, newItem, noteChars }) {
  const store = window.__yanStore
  const st = store.getState()
  const messages = [...st.messages]
  const last = messages.at(-1)
  if (newItem) {
    const i = window.__cvSeq++
    const len = noteChars[(i * 7) % noteChars.length]
    messages.push({ id: `${prefix}-la${i}`, role: 'assistant', text: '追加叙述 '.repeat(Math.max(1, Math.round(len / 5))), toolCalls: Array.from({ length: tools }, (_, k) => ({ id: `${prefix}-t${i}-${k}`, name: 'bash', args: { command: `echo add ${i}.${k}` }, status: 'ok', output: 'ok' })), timestamp: Date.now() })
  } else {
    const k = last.toolCalls.length
    messages[messages.length - 1] = { ...last, toolCalls: [...last.toolCalls, { id: `${last.id}-x${k}`, name: 'bash', args: { command: `echo more ${k}` }, status: 'ok', output: 'ok' }] }
  }
  store.setState({ messages })
}

function pageRecorder() {
  const stream = () => document.querySelector('.v3-stream')
  const tracked = () => [...document.querySelectorAll('.v3-stream .v3-spread > *, .v3-stream .v3-msg[data-turn-id]')]
  const rec = window.__cvRec = { frames: [], on: false, prev: new Map(), expect: 0 }
  const tick = () => {
    if (rec.on) {
      const box = stream()
      if (box) {
        const top = box.getBoundingClientRect().top
        const vh = box.clientHeight
        const next = new Map()
        const deltas = []
        for (const el of tracked()) {
          const r = el.getBoundingClientRect()
          const y = r.top - top
          if (y < 0 || y > vh) continue
          next.set(el, y)
          const before = rec.prev.get(el)
          if (before !== undefined) deltas.push(y - before - rec.expect)
        }
        deltas.sort((a, b) => a - b)
        const shift = deltas.length ? deltas[deltas.length >> 1] : 0
        const spread = deltas.length ? deltas.at(-1) - deltas[0] : 0
        rec.frames.push({ t: performance.now(), st: box.scrollTop, sh: box.scrollHeight, shift, spread, n: deltas.length, expect: rec.expect })
        rec.prev = next
        rec.expect = 0
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function summarize(frames) {
  const abs = frames.map((f) => Math.abs(f.shift))
  return {
    frames: frames.length,
    maxShiftPx: Math.round(Math.max(0, ...abs) * 10) / 10,
    shiftFramesOver2: abs.filter((x) => x > 2).length,
    sumShiftPx: Math.round(abs.reduce((a, b) => a + b, 0)),
    maxDownPx: Math.round(Math.max(0, ...frames.map((f) => f.shift)) * 10) / 10,
    maxUpPx: Math.round(Math.max(0, ...frames.map((f) => -f.shift)) * 10) / 10,
    maxSpreadPx: Math.round(Math.max(0, ...frames.map((f) => f.spread)) * 10) / 10,
    worst: frames.map((f, i) => ({ i, t: Math.round(f.t - frames[0].t), shift: Math.round(f.shift * 10) / 10, dst: i ? Math.round(f.st - frames[i - 1].st) : 0, dsh: i ? Math.round(f.sh - frames[i - 1].sh) : 0, n: f.n, expect: f.expect })).sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 4),
    shRange: frames.length ? [Math.round(Math.min(...frames.map((f) => f.sh))), Math.round(Math.max(...frames.map((f) => f.sh)))] : null
  }
}

export default async function run({ cdp, waitFor, check, report, sleep, runDir, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const inject = (fn, arg) => ev(`(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`)
  const variants = (process.env.YAN_CV_VARIANTS || 'off,240,est,build,clip').split(',').filter((v) => v in VARIANT_CSS)
  const modes = (process.env.YAN_CV_MODES || 'virtual,plain').split(',')
  const frames = (n) => ev(`new Promise((done) => { let k = 0; const step = () => (++k >= ${n} ? done(true) : requestAnimationFrame(step)); requestAnimationFrame(step) })`)
  const results = {}
  const shotClip = async (name, rect) => {
    const res = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 2 } })
    const file = join(runDir, `${name}.png`)
    writeFileSync(file, Buffer.from(res.result.data, 'base64'))
    return file
  }

  const fresh = async (variant) => {
    await cdp.call('Page.reload')
    await sleep(600)
    await waitFor('!!window.__yanStore && !!s.session && !!document.querySelector(".v3-stream")', 30000)
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ rightPanelOpen: false, promptSuggestions: false, reduceMotion: false })`)
    await ev(`(() => { const el = document.createElement('style'); el.id = 'cv-variant'; el.textContent = ${JSON.stringify(VARIANT_CSS[variant])}; document.head.appendChild(el) })()`)
    await inject(pageRecorder)
    await sleep(300)
  }
  const build = async (mode, tag, extra = {}) => {
    const prefix = `${mode}-${tag}`
    await inject(pageBuild, { prefix, history: mode === 'virtual' ? 50 : 4, items: 40, tools: 2, tallTools: 3, token: 'CVFINDTOKEN', linkAt: 30, noteChars: NOTE_CHARS, ...extra })
    await sleep(900)
    await frames(10)
    return prefix
  }
  const bottomGap = () => ev(`(() => { const el = document.querySelector('.v3-stream'); return String(Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)) + '/' + document.querySelectorAll('.v3-stream').length })()`).then((v) => (v.endsWith('/1') ? Number(v.split('/')[0]) : v))
  const env = () => ev(`(() => ({ virtual: !document.querySelector('.v3-stream .v3-stream-inner'), skip: !!document.querySelector('.v3-stream .v3-spread[data-skip]'), items: document.querySelectorAll('.v3-stream .v3-spread[data-live] > *').length, cv: [...document.querySelectorAll('.v3-stream .v3-spread[data-live] > *')].filter((el) => getComputedStyle(el).contentVisibility === 'auto').length, cis: [...new Set([...document.querySelectorAll('.v3-stream .v3-spread[data-live] > *')].filter((el) => getComputedStyle(el).contentVisibility === 'auto').map((el) => el.className.split(' ')[0] + ' ' + getComputedStyle(el).containIntrinsicHeight))] }))()`)

  for (const mode of modes) {
    for (const variant of variants) {
      const key = `${mode}/${variant}`
      const out = results[key] = {}

      await fresh(variant)
      await build(mode, `${variant}-up`)
      out.env = await env()
      out.startGap = await bottomGap()
      if (variant === 'off') {
        out.heights = await ev(`(() => {
          const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[s.length >> 1] * 10) / 10 : null }
          const els = [...document.querySelectorAll('.v3-stream .v3-spread[data-live] > *')].slice(0, -2)
          const notes = els.filter((el) => el.matches('.v3-process-notes')).map((el) => el.getBoundingClientRect().height)
          const groups = els.filter((el) => el.matches('.v3-process')).map((el) => el.getBoundingClientRect().height)
          return { notesMedian: med(notes), notesMin: Math.min(...notes), notesMax: Math.max(...notes), notes: notes.length, groupMedian: med(groups), groupMin: Math.min(...groups), groupMax: Math.max(...groups), groups: groups.length, width: Math.round(document.querySelector('.v3-stream .v3-spread[data-live]').getBoundingClientRect().width) }
        })()`)
      }
      await ev(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })) })()`)
      await ev(`(async () => {
        const rec = window.__cvRec
        const el = document.querySelector('.v3-stream')
        const live = document.querySelector('.v3-stream .v3-spread[data-live]')
        const stopAt = Math.max(0, el.scrollTop + live.getBoundingClientRect().top - el.getBoundingClientRect().top - 40)
        rec.frames = []; rec.prev = new Map(); rec.on = true
        await new Promise((r) => requestAnimationFrame(r))
        for (let i = 0; i < 400 && el.scrollTop > stopAt; i++) {
          const before = el.scrollTop
          el.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true }))
          el.scrollTop = Math.max(0, before - 48)
          rec.expect = before - el.scrollTop
          await new Promise((r) => requestAnimationFrame(r))
        }
        for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r))
        rec.on = false
      })()`)
      out.scrollUp = summarize(await ev('window.__cvRec.frames'))
      log(key, 'scrollUp', out.env, out.scrollUp)

      await fresh(variant)
      const prefix = await build(mode, `${variant}-tail`, { tallTools: 40 })
      await ev(`document.querySelector('.v3-stream .v3-spread[data-live] > .v3-process:last-child [data-testid="v3-process-toggle"]')?.click()`)
      await sleep(700)
      out.tailOpen = await ev(`document.querySelector('.v3-stream .v3-spread[data-live] > .v3-process:last-child')?.getBoundingClientRect().height | 0`)
      await ev(`(() => { const rec = window.__cvRec; rec.frames = []; rec.prev = new Map(); rec.on = true })()`)
      for (let i = 0; i < 48; i++) {
        const newItem = i % 6 === 5
        await inject(pageAppend, { prefix, tools: 24, newItem, noteChars: NOTE_CHARS })
        if (newItem) {
          await sleep(30)
          await ev(`document.querySelector('.v3-stream .v3-spread[data-live] > .v3-process:last-child [data-testid="v3-process-toggle"]')?.click()`)
        }
        await sleep(110)
      }
      await sleep(600)
      await ev('window.__cvRec.on = false')
      out.append = { ...summarize(await ev('window.__cvRec.frames')), endGap: await bottomGap() }
      log(key, 'append', out.tailOpen, out.append)

      await ev(`(() => { const rec = window.__cvRec; rec.frames = []; rec.prev = new Map(); rec.on = true })()`)
      const traced = []
      const from = cdp.events.length
      await cdp.call('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' })
      await sleep(300)
      const endAt = await ev(`(() => { const t = performance.now(); window.__yanStore.setState((s) => ({ session: { ...s.session, isStreaming: false, isAgentRunning: false } })); return t })()`)
      await sleep(900)
      await cdp.call('Tracing.end')
      for (let i = 0; i < 100 && !cdp.events.slice(from).some((e) => e.method === 'Tracing.tracingComplete'); i++) await sleep(100)
      for (const event of cdp.events.slice(from)) if (event.method === 'Tracing.dataCollected') traced.push(...event.params.value)
      await ev('window.__cvRec.on = false')
      const endFrames = (await ev('window.__cvRec.frames')).filter((f) => f.t >= endAt)
      const mains = traced.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`)
      const busiest = mains.map((id) => [id, traced.filter((e) => `${e.pid}:${e.tid}` === id && e.name === 'RunTask').length]).sort((a, b) => b[1] - a[1])[0]?.[0]
      const main = traced.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && `${e.pid}:${e.tid}` === busiest)
      const tasks = main.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur - a.dur)
      const sum = (name) => Math.round(main.filter((e) => e.name === name).reduce((a, e) => a + e.dur, 0) / 100) / 10
      writeFileSync(join(runDir, `trace-end-${mode}-${variant}.json`), JSON.stringify({ traceEvents: traced }))
      out.turnEnd = { longestTaskMs: Math.round((tasks[0]?.dur ?? 0) / 100) / 10, tasksOver16: tasks.filter((e) => e.dur > 16000).length, layoutMs: sum('Layout'), styleMs: sum('UpdateLayoutTree'), paintMs: sum('Paint'), prePaintMs: sum('PrePaint'), frames: summarize(endFrames), liveGone: await ev(`!document.querySelector('.v3-stream .v3-spread[data-live]')`), endGap: await bottomGap() }
      log(key, 'turnEnd', out.turnEnd)

      await fresh(variant)
      await build(mode, `${variant}-find`)
      await ev(`document.activeElement?.blur?.()`)
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 })
      await sleep(250)
      await cdp.call('Input.insertText', { text: 'CVFINDTOKEN' })
      await sleep(900)
      out.find = await ev(`(() => {
        const box = document.querySelector('.v3-stream')
        const view = box.getBoundingClientRect()
        const active = CSS.highlights?.get('session-find-active')
        const ranges = active ? [...active] : []
        const rect = ranges[0]?.getBoundingClientRect()
        const all = CSS.highlights?.get('session-find')
        const holder = [...document.querySelectorAll('.v3-stream .v3-spread[data-live] > .v3-process-notes')].find((el) => el.textContent.includes('CVFINDTOKEN'))
        const hr = holder?.getBoundingClientRect()
        return { matches: all ? all.size : 0, active: ranges.length, inView: !!rect && rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom, top: rect ? Math.round(rect.top - view.top) : null, holderVisible: !!hr && hr.top < view.bottom && hr.bottom > view.top, holderCv: holder ? getComputedStyle(holder).contentVisibility : null }
      })()`)
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      log(key, 'find', out.find)

      await fresh(variant)
      await build(mode, `${variant}-focus`)
      const target = await ev(`(() => {
        const box = document.querySelector('.v3-stream')
        const link = [...document.querySelectorAll('.v3-stream .v3-spread[data-live] > .v3-process-notes a')].find((a) => a.textContent.includes('参考链接'))
        if (!link) return null
        const notes = link.closest('.v3-process-notes')
        box.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true }))
        box.scrollTop += notes.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2
        return true
      })()`)
      await sleep(500)
      if (target) {
        await ev(`(() => {
          const link = [...document.querySelectorAll('.v3-stream .v3-spread[data-live] > .v3-process-notes a')].find((a) => a.textContent.includes('参考链接'))
          const prev = link.closest('.v3-process-notes').previousElementSibling?.querySelector('[data-testid="v3-process-toggle"]')
          prev?.focus()
        })()`)
        await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
        await sleep(300)
        out.focus = await ev(`(() => {
          const a = document.activeElement
          const notes = a?.closest('.v3-process-notes')
          const r = a?.getBoundingClientRect()
          const n = notes?.getBoundingClientRect()
          return { onLink: !!a && a.tagName === 'A' && a.textContent.includes('参考链接'), focusVisible: !!a?.matches(':focus-visible'), cv: notes ? getComputedStyle(notes).contentVisibility : null, outline: a ? getComputedStyle(a).outline : null, outlineOffset: a ? getComputedStyle(a).outlineOffset : null, linkTop: r ? Math.round(r.top - n.top) : null, linkLeft: r ? Math.round(r.left - n.left) : null, dpr: devicePixelRatio, clip: n ? { x: Math.max(0, Math.round((n.left - 16) * devicePixelRatio)), y: Math.max(0, Math.round((n.top - 16) * devicePixelRatio)), width: Math.round(Math.min(300, n.width + 32) * devicePixelRatio), height: Math.round((n.height + 32) * devicePixelRatio) } : null }
        })()`)
        if (out.focus.clip) out.focus.shot = await shotClip(`focus-${mode}-${variant}`, out.focus.clip)
      } else out.focus = { onLink: false, reason: '没找到链接' }
      log(key, 'focus', out.focus)
    }
  }

  report.cv = results
  writeFileSync(join(runDir, 'cv-results.json'), JSON.stringify(results, null, 2))
  for (const [key, out] of Object.entries(results)) {
    const [mode, variant] = key.split('/')
    check(`${key} 模式判定`, out.env.virtual === (mode === 'virtual'), out.env)
    if (variant !== 'build') {
      log(`${key} 对照（不计验收）`, { startGap: out.startGap, up: out.scrollUp.maxShiftPx, find: out.find.active === 1 && out.find.inView, focus: out.focus.onLink && out.focus.focusVisible, endGap: out.turnEnd.endGap })
      continue
    }
    check(`${key} 往上滚时可见内容不跳（单帧偏差 ≤2px）`, out.scrollUp.maxShiftPx <= 2, out.scrollUp)
    check(`${key} 载入后贴底`, out.startGap <= 2, out.startGap)
    check(`${key} 查找命中并滚到可见`, out.find.active === 1 && out.find.inView, out.find)
    check(`${key} 键盘焦点落在叙述链接上`, out.focus.onLink && out.focus.focusVisible, out.focus)
    check(`${key} 回合结束后 data-live 去掉且仍贴底`, out.turnEnd.liveGone && out.turnEnd.endGap <= 2, out.turnEnd)
  }
  const table = Object.entries(results).map(([key, out]) => ({ key, virtual: out.env.virtual, upMax: out.scrollUp.maxShiftPx, upOver2: out.scrollUp.shiftFramesOver2, upSum: out.scrollUp.sumShiftPx, appendMaxDown: out.append.maxDownPx, appendMaxUp: out.append.maxUpPx, appendOver2: out.append.shiftFramesOver2, endTaskMs: out.turnEnd.longestTaskMs, endLayoutMs: out.turnEnd.layoutMs, endShift: out.turnEnd.frames.maxShiftPx, find: out.find.active === 1 && out.find.inView }))
  report.table = table
  log('table', table)
}
