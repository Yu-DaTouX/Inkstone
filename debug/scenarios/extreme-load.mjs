import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PROBES, RENDER_HOOK, RENDER_START, RENDER_TAKE, SUMMARY, useRealWindow } from '../lib/perf-probes.mjs'
import { cpuByKind, memoryByKind, sampleProcessTree } from '../lib/process-tree.mjs'

export const meta = { description: '极端负载：三个项目各一个会话同时跑 STORM（其中一个先派 4 个假模型子代理），首条消息各带一小一大两张图，三分屏同时显示；分阶段测静看、滚轮滚动、切换活动分屏、运行中输入与收尾的帧、长任务、主进程 IPC 往返、store 更新次数与各进程 CPU/内存，不调用真实模型' }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function screenshotPng(width, height, photo) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  let seed = 7
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    const textRow = (y % 24) > 6 && (y % 24) < 18
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const i = y * stride + 1 + x * 3
      if (x >= width - photo.w && y < photo.h) {
        const noise = (seed >> 8) & 31
        raw[i] = ((x * 255) / width + noise) & 255
        raw[i + 1] = ((y * 255) / height + noise) & 255
        raw[i + 2] = ((x + y) / 4 + noise) & 255
        continue
      }
      let v = [24, 32, 40, 236][((x >> 7) + (y >> 6)) & 3]
      if (textRow && ((x >> 3) % 9) < 7 && ((seed >> 8) & 1) === 0) v = 255 - v
      raw[i] = v
      raw[i + 1] = v
      raw[i + 2] = (v + (x >> 5)) & 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

function diskCounts(path) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return null }
  const lines = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const messages = lines.filter((line) => line.type === 'message').map((line) => line.message)
  const lastAssistant = messages.filter((m) => m?.role === 'assistant').at(-1)
  const lastText = (lastAssistant?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
  const answered = messages.some((m) => m?.role === 'assistant' && (m.content ?? []).some((part) => part.type === 'text' && part.text.includes('结束。')))
  return { bytes: text.length, toolResults: messages.filter((m) => m?.role === 'toolResult').length, finalOk: answered, lastText: lastText.slice(0, 20) }
}

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  const splitOn = process.env.YAN_EXTREME_SPLIT !== '0'
  const sessionCount = Math.max(1, Math.min(3, Number(process.env.YAN_EXTREME_SESSIONS ?? 3)))
  const subagentsOn = process.env.YAN_EXTREME_SUBAGENTS !== '0' && sessionCount >= 3
  const profileOn = process.env.YAN_EXTREME_PROFILE === '1'
  report.variant = { splitOn, sessionCount, subagentsOn, profileOn }
  const marker = box.userData
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_HOOK })
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await cdp.call('Page.reload')
  await sleep(300)
  await waitFor('!!window.__yanStore && !!window.yan && !!document.querySelector(".ProseMirror")', 60000, 20)
  await ev(PROBES)
  await autoApprove()
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  const heap = async () => {
    const m = await metrics()
    return { jsHeapMB: Math.round(m.JSHeapUsedSize / 1048576), domNodes: m.Nodes, listeners: m.JSEventListeners }
  }

  const small = screenshotPng(1280, 800, { w: 320, h: 240 })
  const large = screenshotPng(3840, 2160, { w: 1100, h: 900 })
  report.images = { smallKB: Math.round(small.length / 1024), largeKB: Math.round(large.length / 1024) }
  log('images', report.images)
  await ev(`window.__stressImages = ${JSON.stringify([{ data: small.toString('base64'), mimeType: 'image/png' }, { data: large.toString('base64'), mimeType: 'image/png' }])}; true`)

  const projects = [0, 1, 2].map((i) => box.projects[i] ?? box.projects[0] ?? box.project)
  const specs = [
    { project: projects[0], text: 'STORM-A 请看这两张截图，逐步核对项目里的文件' },
    { project: projects[1], text: 'STORM-B 请看这两张截图，逐步核对项目里的文件' },
    { project: projects[2], text: subagentsOn ? 'SUBAGENTS-C 先派子代理，再看这两张截图逐步核对' : 'STORM-C 请看这两张截图，逐步核对项目里的文件' }
  ].slice(0, sessionCount)
  const sessions = []
  const startAll = Date.now()
  for (const spec of specs) {
    await newSession(spec.project)
    const sent = await ev(`window.__yanStore.getState().send(${JSON.stringify(spec.text)}, window.__stressImages)`)
    if (sent === false) throw new Error('发送失败：' + spec.text)
    await waitFor(`${running} && !!s.session?.sessionFile && !!s.session?.sessionId`, 30000, 20)
    sessions.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile'), project: spec.project })
  }
  report.timings.startAllMs = Date.now() - startAll
  log('sessions', sessions)

  if (splitOn && sessions.length > 1) await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(sessions.map(({ sessionId, path }) => ({ sessionId, path })))}, live: ${sessions.length - 1} })`)
  await sleep(1500)
  const layout = await ev(`({ tiles: window.__yanSplit.getState().split?.tiles.length ?? 0, streams: document.querySelectorAll('.v3-stream').length, composers: document.querySelectorAll('.ProseMirror').length })`)
  report.layout = layout
  log('layout', layout)
  if (splitOn && sessions.length > 1) check('分屏已打开', layout.tiles === sessions.length, layout)

  const phase = async (name, action, settle = 500) => {
    const procBefore = sampleProcessTree(marker)
    const before = await metrics()
    await ev(`window.__pa.phase = ${JSON.stringify(name)}`)
    await ev(RENDER_START)
    const t = Date.now()
    const out = (await action()) ?? {}
    const ms = Date.now() - t
    await sleep(settle)
    const after = await metrics()
    const { renders, regions, causes } = await ev(RENDER_TAKE)
    await ev(`window.__pa.phase = 'between'`)
    const procAfter = sampleProcessTree(marker)
    const cpu = {}
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']) cpu[key] = Math.round((after[key] - before[key]) * 1000)
    const result = { ms, ...out, ...(await ev(SUMMARY(name))), rendererCpu: cpu, processCpuPercent: cpuByKind(procBefore, procAfter), memory: memoryByKind(procAfter), renders, regions, causes, heap: await heap() }
    report.timings[name] = result
    log(name, result)
    return result
  }

  const busy = `(${running}) || s.runners.some((r) => r.running || r.waiting) || s.subagents.some((a) => a.status === 'starting' || a.status === 'running')`

  await phase('storm-watch', async () => {
    if (profileOn) {
      await cdp.call('Profiler.enable')
      await cdp.call('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.call('Profiler.start')
    }
    await sleep(8000)
    if (profileOn) {
      const { profile } = (await cdp.call('Profiler.stop')).result
      writeFileSync(join(runDir, 'storm-watch.cpuprofile'), JSON.stringify(profile))
    }
  })
  await shot('storm-mid')

  await phase('storm-scroll', async () => {
    const streams = await ev(`[...document.querySelectorAll('.v3-stream')].map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) } }).filter((r) => r.w > 0)`)
    for (const target of streams) {
      for (const deltaY of [...Array(15).fill(-400), ...Array(15).fill(400)]) {
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0, deltaY })
        await sleep(40)
      }
    }
    return { streams: streams.length }
  })

  await phase('storm-live-switch', async () => {
    const times = []
    for (const target of [0, 1, 2, 0, 2, 1].map((i) => sessions[i % sessions.length])) {
      const t = Date.now()
      await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target.path)})`)
      await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(target.path)}`, 30000, 10)
      times.push(Date.now() - t)
      await sleep(400)
    }
    return { switchMs: times, tilesAfter: await ev('window.__yanSplit.getState().split?.tiles.length ?? 0') }
  })

  await phase('storm-typing', async () => {
    await ev(`document.querySelector('.ProseMirror').focus()`)
    for (let i = 0; i < 40; i++) {
      await cdp.call('Input.insertText', { text: '压测输入' })
      await sleep(20)
    }
    const kept = await ev(`[...document.querySelectorAll('.ProseMirror')].some((el) => el.textContent.includes('压测输入'.repeat(40)))`)
    await ev(`window.__yanStore.setState({ editorInject: { text: '', mode: 'replace' } })`)
    return { kept }
  })

  const tail = await phase('storm-tail', async () => {
    const t = Date.now()
    let peakHeap = 0
    while (Date.now() - t < 420000) {
      if (!(await state(busy))) break
      peakHeap = Math.max(peakHeap, (await heap()).jsHeapMB)
      await sleep(1000)
    }
    return { finished: !(await state(busy)), peakHeapMB: peakHeap, subagents: await state(`s.subagents.map((a) => a.status)`) }
  }, 2500)
  report.timings.totalMs = Date.now() - startAll
  check('全部会话与子代理在 7 分钟内跑完', tail.finished, tail.subagents)
  await shot('storm-end')

  const disk = sessions.map((item) => ({ path: item.path, ...diskCounts(item.path) }))
  report.disk = disk
  log('disk', disk)
  const expected = sessions.map((_, i) => (i === 2 && subagentsOn ? 61 : 60))
  check('每个会话的工具结果数正确', disk.every((d, i) => d.toolResults === expected[i]), { got: disk.map((d) => d.toolResults), expected })
  check('三个会话最终答案都落盘', disk.every((d) => d.finalOk))
  const subagents = await state(`s.subagents.map((a) => ({ status: a.status, title: a.title }))`)
  if (subagentsOn) check('4 个子代理都完成', subagents.filter((a) => a.status === 'done').length >= 4, subagents)
  if (splitOn && sessions.length > 1) {
    const tiles = await ev(`[...document.querySelectorAll('.v3-stream')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.innerText.includes('结束。') || el.innerText.includes('好的，收到。'))`)
    check('每个分屏都显示到最终回复', tiles.length >= sessions.length && tiles.every(Boolean), tiles)
  }
  const changes = projects.slice(0, sessions.length).map((project) => {
    const out = spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8', windowsHide: true })
    return (out.stdout ?? '').split('\n').filter(Boolean).length
  })
  report.gitChanges = changes
  check('每个项目都有 storm 改动', changes.every((n) => n > 0), changes)
  report.timings.end = { heap: await heap(), memory: memoryByKind(sampleProcessTree(marker)) }
  log('end', report.timings.end)
  await ev('window.__pa.stop = true')
}
