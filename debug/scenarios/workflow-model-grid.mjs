import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const meta = { description: '工作流 model() 点阵格：向界面注入 1000 与 5000 次调用的运行视图（每 150ms 推送一次模拟进度），卡片 364/869 宽 × 深浅主题截图，查画布取色非黑、四态颜色与对比度、悬停与失败原文、失败列表可聚焦、≤10fps、减少动效停呼吸，卡片常开 30 秒测渲染进程 CPU（MG_SHOT_DIR、MG_TAG、MG_CPU_MS、MG_WIDTHS=364,869）' }

const SIM = `(() => {
  const sim = window.__mgSim ?? (window.__mgSim = { timer: 0 })
  const lines = ['When power is lost, the store must keep write order → 断电时，存储必须保持写入顺序', 'Each page is checksummed before commit → 每页在提交前先算校验和', 'The journal is replayed on startup → 启动时重放日志', 'Offline writes queue until the link returns → 离线写入排队，等连接恢复']
  const label = (i) => 'segments/' + String(i + 1).padStart(4, '0') + '.txt'
  sim.stop = () => { clearInterval(sim.timer); sim.timer = 0 }
  sim.start = (cfg) => {
    sim.stop()
    const { id, total, concurrency, sessionId, parentMessageId, progress, failRate, live, rate } = cfg
    let seed = 12345
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const st = new Uint8Array(total)
    const end = new Float64Array(total)
    const running = []
    const failures = []
    let next = 0, done = 0, failed = 0, cost = 0, latest = null
    const settle = (i, now) => {
      if (rand() < failRate) {
        st[i] = 3
        failed++
        if (failures.length < 50) failures.push({ index: i, label: label(i), error: '429 Too Many Requests: rate limit exceeded for fake/fast-model, retry after 20s\\nrequest id req_' + (100000 + i) + '\\n（模拟的限流错误原文）' })
      } else {
        st[i] = 2
        done++
        cost += 0.0013
        latest = { index: i, label: label(i), text: lines[i % lines.length].slice(0, 120), at: now }
      }
    }
    const now0 = Date.now()
    const ahead = Math.floor(total * progress)
    for (let i = 0; i < ahead; i++) settle(i, now0)
    next = ahead
    const since = now0 - (done / rate) * 60000
    const fill = (now) => { while (live && next < total && running.length < concurrency) { st[next] = 1; end[next] = now + 900 + rand() * 3200; running.push(next); next++ } }
    const codes = 'qrdf'
    const view = () => {
      let cells = ''
      for (let i = 0; i < total; i++) cells += codes[st[i]]
      const queued = total - next
      return { id, sessionId, parentMessageId, cwd: 'C:/demo', name: '逐段翻译', description: '逐段翻译 segments/*.txt', declaredPhases: ['翻译'], status: live ? 'running' : 'done', startedAt: since - 2000, ...(live ? {} : { endedAt: now0 }), attempt: 1, concurrency: 8, modelConcurrency: concurrency, agents: [], logs: [], dir: 'C:/demo',
        models: { total, done, cached: 0, failed, stopped: 0, running: running.length, queued, cells, cost, since, ...(latest ? { latest } : {}), ...(failures.length ? { failures: failures.slice() } : {}), phases: [{ title: '翻译', total, done, failed, stopped: 0, running: running.length, queued }] } }
    }
    const push = () => window.__yanWorkflows.getState().upsert(view())
    sim.step = () => {
      const now = Date.now()
      for (let k = running.length - 1; k >= 0; k--) { const i = running[k]; if (end[i] <= now) { running.splice(k, 1); settle(i, now) } }
      fill(now)
      push()
    }
    fill(now0)
    push()
    sim.resume = () => { if (!sim.timer && live) sim.timer = setInterval(sim.step, 150) }
    sim.resume()
    return { total, done, failed, running: running.length }
  }
})()`

const PALETTE = `(() => {
  const el = document.createElement('span')
  document.body.appendChild(el)
  const out = {}
  for (const name of ['--fg3', '--run', '--ok', '--fail']) { el.style.color = 'var(' + name + ')'; out[name] = getComputedStyle(el).color }
  el.remove()
  const card = document.querySelector('[data-testid="v3-workflow-model-grid"]')
  let bg = null
  for (let e = card; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) { bg = c; break } }
  return { tokens: out, bg }
})()`

const PIXELS = `(() => {
  const cv = document.querySelector('[data-testid="v3-workflow-model-canvas"]')
  if (!cv) return null
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
  let opaque = 0, black = 0
  const buckets = {}
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 150) continue
    opaque++
    if (d[i] < 24 && d[i + 1] < 24 && d[i + 2] < 24) black++
    const key = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)
    buckets[key] = (buckets[key] || 0) + 1
  }
  const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 6)
  return { w: cv.width, h: cv.height, opaque, black, top }
})()`

function parseRgb(text) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(text ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
}

function sampleProcs(marker) {
  const query = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress"
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-Command', query], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 20000 })
    const list = [].concat(JSON.parse(raw)).filter((p) => (p.CommandLine ?? '').toLowerCase().includes(marker.toLowerCase()))
    return { at: Date.now(), procs: list.map((p) => ({ pid: p.ProcessId, type: /--type=([a-z-]+)/.exec(p.CommandLine ?? '')?.[1] ?? 'main', cpuMs: (Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0)) / 10000, wsMB: Math.round(Number(p.WorkingSetSize ?? 0) / 1048576) })) }
  } catch (error) {
    return { at: Date.now(), procs: [], error: String(error).slice(0, 200) }
  }
}

function cpuDelta(a, b) {
  const wall = Math.max(1, b.at - a.at)
  const start = new Map(a.procs.map((p) => [p.pid, p.cpuMs]))
  const rows = b.procs.map((p) => ({ type: p.type, pct: ((p.cpuMs - (start.get(p.pid) ?? p.cpuMs)) / wall) * 100 }))
  const sum = (type) => Math.round(rows.filter((r) => r.type === type).reduce((s, r) => s + r.pct, 0) * 10) / 10
  return { wallMs: wall, renderer: sum('renderer'), gpu: sum('gpu-process'), main: sum('main') }
}

export default async function run({ cdp, newSession, turn, check, sleep, report, runDir, autoApprove, log, state }) {
  const dir = process.env.MG_SHOT_DIR || join(runDir, 'model-grid')
  const tag = process.env.MG_TAG || 'mg'
  const cpuMs = Number(process.env.MG_CPU_MS || 30000)
  const widths = (process.env.MG_WIDTHS || '364,869').split(',').map(Number)
  mkdirSync(dir, { recursive: true })
  const ev = (expression) => cdp.evaluate(expression)
  const marker = basename(runDir)
  const result = { tag, shots: [], widths: {}, colors: {}, pixels: {}, cpu: {}, paints: {} }

  await autoApprove()
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false })`)
  await newSession()
  await turn('点阵格演示，随便回一句')
  await sleep(800)
  const ids = await state(`({ sessionId: s.session?.sessionId ?? s.session?.conversationId ?? null, messageId: [...s.messages].reverse().find((m) => m.role === 'assistant')?.id ?? null })`)
  log('ids', JSON.stringify(ids))
  check('拿到会话与助手消息 id', !!ids?.sessionId && !!ids?.messageId, ids)
  await ev(SIM)

  const runCfg = (total, extra = {}) => ({ id: total === 5000 ? 'wf-5000aaaa' : 'wf-1000aaaa', total, concurrency: 16, sessionId: ids.sessionId, parentMessageId: ids.messageId, progress: total === 5000 ? 0.3 : 0.42, failRate: 0.03, live: true, rate: total === 5000 ? 620 : 240, ...extra })
  const card = (id) => `document.querySelector('[data-testid="v3-workflow"][data-run-id="${id}"]')`
  const show = async (cfg) => {
    await ev(`(() => { const runs = window.__yanWorkflows.getState().runs; const keep = {}; for (const k of Object.keys(runs)) if (!k.startsWith('wf-') || !k.endsWith('aaaa')) keep[k] = runs[k]; window.__yanWorkflows.setState({ runs: keep }) })()`)
    const started = await ev(`window.__mgSim.start(${JSON.stringify(cfg)})`)
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!${card(cfg.id)}?.querySelector('[data-testid="v3-workflow-model-canvas"]')`)) break
      await sleep(150)
    }
    await ev(`(() => { const el = ${card(cfg.id)}; if (!el) return; el.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); el.scrollIntoView({ block: 'center' }) })()`)
    await sleep(500)
    return started
  }
  const cardWidth = (id) => ev(`Math.round(${card(id)}?.getBoundingClientRect().width ?? 0)`)
  const naturalStream = await ev('window.__yanStore.getState().settings?.streamWidth ?? null')
  const settle = async (id) => {
    await sleep(500)
    await ev(`${card(id)}?.scrollIntoView({ block: 'center' })`)
    await sleep(200)
    return cardWidth(id)
  }
  const fitWidth = async (id, target) => {
    const wide = target > 700
    let viewport = wide ? 1900 : 900
    let stream = wide ? target + 40 : 768
    await ev('window.__yanRightPanel?.getState().setOpen(false)')
    await ev(`window.__yanStore.getState().patchSettings({ streamWidth: ${stream} })`)
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: viewport, height: 1000, deviceScaleFactor: 1, mobile: false })
    let width = await settle(id)
    for (let i = 0; i < 12 && Math.abs(width - target) > 2; i++) {
      if (wide) {
        stream = Math.max(480, stream + (target - width))
        await ev(`window.__yanStore.getState().patchSettings({ streamWidth: ${stream} })`)
      } else {
        viewport = Math.max(400, viewport + Math.round((target - width) * (i < 6 ? 1 : 0.5)))
        await cdp.call('Emulation.setDeviceMetricsOverride', { width: viewport, height: 1000, deviceScaleFactor: 1, mobile: false })
      }
      width = await settle(id)
    }
    return { viewport, stream, width }
  }
  const restoreLayout = async () => {
    await cdp.call('Emulation.clearDeviceMetricsOverride')
    await ev(`window.__yanStore.getState().patchSettings({ streamWidth: ${naturalStream === null ? 768 : naturalStream} })`)
    await ev('window.__yanRightPanel?.getState().setOpen(false)')
    await sleep(400)
  }
  const shotCard = async (id, name) => {
    const rect = await ev(`(() => { const r = ${card(id)}.getBoundingClientRect(); const z = devicePixelRatio; const top = Math.max(0, r.top - 8); return { x: Math.max(0, r.left - 8) * z, y: top * z, width: (r.width + 16) * z, height: Math.min(r.height + 16, innerHeight - top) * z } })()`)
    const res = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
    const file = `${tag}-${name}.png`
    writeFileSync(join(dir, file), Buffer.from(res.result.data, 'base64'))
    result.shots.push(file)
  }
  const countPaints = async (ms) => {
    await ev(`(() => { window.__mgPaints = 0; const cv = document.querySelector('[data-testid="v3-workflow-model-canvas"]'); if (!cv) return; if (!cv.__mgWrapped) { const orig = cv.getContext.bind(cv); cv.getContext = (...a) => { window.__mgPaints = (window.__mgPaints || 0) + 1; return orig(...a) }; cv.__mgWrapped = 1 } window.__mgPaints = 0 })()`)
    await sleep(ms)
    return ev('window.__mgPaints || 0')
  }

  for (const theme of ['dark', 'light']) {
    await ev(`window.__yanStore.getState().patchSettings({ theme: '${theme}' })`)
    await sleep(500)
    for (const total of [1000, 5000]) {
      const cfg = runCfg(total)
      await show(cfg)
      for (const target of widths) {
        const fit = await fitWidth(cfg.id, target)
        result.widths[`${theme}-${total}-${target}`] = fit
        await sleep(700)
        const px = await ev(PIXELS)
        result.pixels[`${theme}-${total}-${target}`] = px
        check(`${theme} ${total} 次 ${target} 宽：画布非黑且有多种颜色`, px && px.opaque > 500 && px.black === 0 && px.top.length >= 3, px && { opaque: px.opaque, black: px.black, colors: px.top.length })
        const overflow = await ev(`(() => { const c = ${card(cfg.id)}; const box = c.getBoundingClientRect(); const cv = c.querySelector('[data-testid="v3-workflow-model-canvas"]').getBoundingClientRect(); const clipped = (el) => { for (let e = el.parentElement; e && e !== c; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o === 'hidden' || o === 'clip' || o === 'auto') return true } return false }; const wideEls = [...c.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 1 && !clipped(el)); return { card: Math.round(box.width), canvasW: Math.round(cv.width), canvasH: Math.round(cv.height), wide: wideEls.length, wideWhat: wideEls.slice(0, 3).map((el) => (el.className?.baseVal ?? el.className ?? el.tagName) + ':' + Math.round(el.getBoundingClientRect().right - box.right)) } })()`)
        result.widths[`${theme}-${total}-${target}`].layout = overflow
        check(`${theme} ${total} 次 ${target} 宽：不横向溢出、画布不过高`, overflow.wide === 0 && overflow.canvasH <= 260, overflow)
        await shotCard(cfg.id, `${theme}-${total}-w${target}`)
      }
      await restoreLayout()
    }
    const pal = await ev(PALETTE)
    const bg = parseRgb(pal.bg)
    result.colors[theme] = { ...pal, contrast: bg ? Object.fromEntries(Object.entries(pal.tokens).map(([k, v]) => [k, contrast(parseRgb(v), bg)])) : null }
    log('colors', JSON.stringify(result.colors[theme]))
    check(`${theme}：四种状态色与背景可区分（≥2:1）`, !!result.colors[theme].contrast && Object.values(result.colors[theme].contrast).every((v) => v >= 2), result.colors[theme].contrast)
  }

  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  const cfg = runCfg(1000)
  await show(cfg)
  const fit = await fitWidth(cfg.id, widths.at(-1))
  log('fit', JSON.stringify(fit))
  await ev('window.__mgSim.stop()')
  await sleep(300)
  const darkPx = await ev(PIXELS)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(500)
  const lightPx = await ev(PIXELS)
  result.themeSwitch = { dark: darkPx?.top.slice(0, 3), light: lightPx?.top.slice(0, 3) }
  check('切换主题后画布重新取色（同一张卡片）', !!darkPx && !!lightPx && lightPx.black === 0 && JSON.stringify(darkPx.top.slice(0, 3)) !== JSON.stringify(lightPx.top.slice(0, 3)), result.themeSwitch)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(500)
  const target = await ev(`(() => { const cv = ${card(cfg.id)}.querySelector('[data-testid="v3-workflow-model-canvas"]'); const view = window.__yanWorkflows.getState().runs['${cfg.id}']; const cells = view.models.cells; const i = cells.indexOf('f'); const cols = Number(cv.dataset.cols); const step = Number(cv.dataset.step); const r = cv.getBoundingClientRect(); return { index: i, x: Math.round(r.left + (i % cols) * step + 2), y: Math.round(r.top + Math.floor(i / cols) * step + 2), runAt: cells.indexOf('r') } })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await sleep(400)
  const hoverText = await ev(`${card(cfg.id)}.querySelector('[data-testid="v3-workflow-model-probe"]')?.innerText ?? ''`)
  result.hover = hoverText
  check('悬停失败格显示 label 与失败提示', hoverText.includes(`segments/${String(target.index + 1).padStart(4, '0')}.txt`) && hoverText.includes('失败'), hoverText)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await sleep(400)
  const errorText = await ev(`${card(cfg.id)}.querySelector('[data-testid="v3-workflow-model-error"]')?.innerText ?? ''`)
  result.errorPanel = errorText
  check('点失败格展开错误原文', errorText.includes('429 Too Many Requests') && errorText.includes('request id'), errorText.slice(0, 160))
  await shotCard(cfg.id, 'dark-1000-error')
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(200)
  const latest = await ev(`${card(cfg.id)}.querySelector('[data-testid="v3-workflow-model-probe"]')?.innerText ?? ''`)
  result.latest = latest
  check('不悬停时显示最近一次完成的抽查（≤120 字）', /segments\/\d{4}\.txt/.test(latest) && latest.length <= 160, latest)
  await ev(`${card(cfg.id)}.querySelector('[data-testid="v3-workflow-head"]')?.click()`)
  await sleep(500)
  const list = await ev(`(() => { const el = ${card(cfg.id)}.querySelector('[data-testid="v3-workflow-model-failures"]'); if (!el) return null; el.focus(); return { focused: document.activeElement === el, items: el.querySelectorAll('li').length, text: el.innerText.slice(0, 160) } })()`)
  result.failureList = list
  check('展开后失败列表可聚焦并列出 label 与原文', !!list && list.focused && list.items > 0 && /segments\/\d{4}\.txt/.test(list.text) && list.text.includes('429'), list)
  await shotCard(cfg.id, 'dark-1000-expanded')
  await ev(`document.activeElement?.blur?.()`)
  await ev(`${card(cfg.id)}.querySelector('[data-testid="v3-workflow-head"]')?.click()`)
  await sleep(300)

  result.paints.breathing = await countPaints(3000)
  check('只有呼吸时刷新 ≤10fps', result.paints.breathing > 0 && result.paints.breathing <= 31, String(result.paints.breathing))
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
  await sleep(300)
  result.paints.reduced = await countPaints(3000)
  check('减少动效时停呼吸（无推送时不重画）', result.paints.reduced <= 1, String(result.paints.reduced))
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
  await ev('window.__mgSim.resume()')
  result.paints.pushing = await countPaints(3000)
  check('推送加呼吸时刷新仍 ≤10fps', result.paints.pushing <= 31, String(result.paints.pushing))
  await ev(`(() => { const el = ${card(cfg.id)}; el.closest('.v3-stream')?.scrollBy(0, -5000) })()`)
  await sleep(400)
  const offscreen = await ev(`(() => { const r = ${card(cfg.id)}.getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight })()`)
  if (offscreen) {
    await ev('window.__mgSim.stop()')
    result.paints.offscreen = await countPaints(2000)
    check('卡片在视口外时不呼吸', result.paints.offscreen <= 1, String(result.paints.offscreen))
  }

  const measure = async (name, prepare) => {
    await prepare()
    await ev(`(() => { const cv = document.querySelector('[data-testid="v3-workflow-model-canvas"]'); if (!cv) return; cv.dispatchEvent(new CustomEvent('yan-scroll-intent', { bubbles: true })); cv.scrollIntoView({ block: 'center' }) })()`)
    await sleep(1500)
    const inView = () => ev(`(() => { const cv = document.querySelector('[data-testid="v3-workflow-model-canvas"]'); if (!cv) return null; const r = cv.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })()`)
    const viewStart = await inView()
    const a = sampleProcs(marker)
    const paints0 = await countPaints(0)
    await sleep(cpuMs)
    const paints = await ev('window.__mgPaints || 0')
    const b = sampleProcs(marker)
    const row = { ...cpuDelta(a, b), paintsPerSec: Math.round((paints / (cpuMs / 1000)) * 10) / 10, paints0, canvasInView: [viewStart, await inView()] }
    result.cpu[name] = row
    log(`cpu ${name}`, JSON.stringify(row))
    return row
  }
  await restoreLayout()
  await measure('idle-no-workflow', async () => {
    await ev('window.__mgSim.stop()')
    await ev(`window.__yanWorkflows.setState({ runs: {} })`)
  })
  await measure('live-5000-open', async () => {
    await show(runCfg(5000, { progress: 0.1 }))
    await ev(`${card('wf-5000aaaa')}.querySelector('[data-testid="v3-workflow-head"]')?.click()`)
  })
  await measure('live-5000-reduced', async () => {
    await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
  })
  await ev(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
  await measure('live-1000-open', async () => {
    await show(runCfg(1000, { progress: 0.1 }))
    await ev(`${card('wf-1000aaaa')}.querySelector('[data-testid="v3-workflow-head"]')?.click()`)
  })
  await ev('window.__mgSim.stop()')
  check('采到渲染进程 CPU', Object.values(result.cpu).every((row) => row.wallMs > 0) && result.cpu['live-5000-open'].renderer >= 0)
  check('常开时画布在视口内且刷新 0<fps≤10', ['live-5000-open', 'live-1000-open'].every((k) => result.cpu[k].canvasInView.every(Boolean) && result.cpu[k].paintsPerSec > 0 && result.cpu[k].paintsPerSec <= 10.5), JSON.stringify(Object.fromEntries(Object.entries(result.cpu).map(([k, v]) => [k, v.paintsPerSec]))))
  report.modelGrid = result
  writeFileSync(join(dir, `${tag}-results.json`), JSON.stringify(result, null, 1))
}
