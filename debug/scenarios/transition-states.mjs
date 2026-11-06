import { sample, timeline } from '../lib/state-probe.mjs'

export const meta = { description: '过渡类状态：运行中重载渲染端（贴底与上滚两种）逐帧看空白与滚动位置、子代理断网失败、压缩中，采样内容被清空又回来与状态卡死' }

const streamProbe = `(() => {
  const s = window.__yanStore?.getState?.()
  const el = document.querySelector('.v3-stream')
  return {
    t: Date.now(),
    msgs: s?.messages?.length ?? -1,
    running: !!(s?.session?.isStreaming || s?.session?.isAgentRunning),
    stream: !!el,
    textLen: el ? el.innerText.length : -1,
    scrollTop: el ? Math.round(el.scrollTop) : -1,
    scrollHeight: el ? Math.round(el.scrollHeight) : -1,
    clientHeight: el ? Math.round(el.clientHeight) : -1,
    card: null
  }
})()`

const RECORDER = `window.__rec = []; (() => { const t0 = performance.now(); const tick = () => { const el = document.querySelector(".v3-stream"); const g = window.__yanStore?.getState?.(); window.__rec.push({ t: Math.round(performance.now() - t0), msgs: g?.messages?.length ?? -1, running: !!(g?.session?.isStreaming || g?.session?.isAgentRunning), stream: !!el, textLen: el ? el.innerText.length : -1, scrollTop: el ? Math.round(el.scrollTop) : -1, scrollHeight: el ? Math.round(el.scrollHeight) : -1, clientHeight: el ? Math.round(el.clientHeight) : -1 }); if (performance.now() - t0 < 12000) setTimeout(tick, 40) }; tick() })()`

async function frames(cdp, sleep, ms, every = 60) {
  const rows = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { rows.push(await Promise.race([cdp.evaluate(streamProbe), new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 1500))])) } catch (error) { rows.push({ t: Date.now(), error: String(error).slice(0, 80) }) }
    await sleep(every)
  }
  return rows
}

function describe(rows, base = 0) {
  const ok = rows.filter((r) => !r.error)
  const firstBack = ok.findIndex((r) => r.textLen >= base * 0.9 && base > 0)
  let blankAfterBack = 0
  let shrink = 0
  if (firstBack >= 0) for (const r of ok.slice(firstBack)) if (r.textLen < base * 0.5) blankAfterBack++
  for (let i = 1; i < ok.length; i++) if (ok[i].textLen >= 0 && ok[i - 1].textLen > 200 && ok[i].textLen < ok[i - 1].textLen * 0.5) shrink++
  return { frames: rows.length, shrink, blankAfterBack, firstBackAt: firstBack >= 0 ? ok[firstBack].t : null, first: ok[0], last: ok.at(-1) }
}

export default async function run({ cdp, box, check, report, sleep, log, newSession, state, waitFor, until, shot, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.cases = {}
  const only = (process.env.YAN_STATES_ONLY ?? 'reload-bottom,reload-scrolled,subfail,compact,missingdir').split(',')
  const reload = async () => {
    await cdp.call('Page.reload')
    await sleep(100)
  }
  const back = () => waitFor('!!window.__yanStore && !!document.querySelector(".ProseMirror")', 60000, 50)

  let prepared = false
  for (const mode of ['reload-bottom', 'reload-scrolled']) {
    if (!only.includes(mode)) continue
    if (!prepared) {
      await newSession(box.project)
      await sleep(1500)
      await ev(`window.__yanStore.getState().send('MANYTOOLS 重载前先跑出足够内容')`)
      await waitFor(running, 20000, 20)
      await waitFor('s.messages.length >= 30', 90000, 200)
      await waitFor(`!(${running})`, 120000, 200)
      for (let i = 0; i < 4; i++) {
        await ev(`window.__yanStore.getState().send('MDREAL 填充内容 ${i}')`)
        await waitFor(running, 20000, 20)
        await waitFor(`!(${running})`, 120000, 200)
      }
      await sleep(11000)
      await ev(`window.__yanStore.getState().send('FLOW 重载时仍在运行')`)
      await waitFor(running, 20000, 20)
      await sleep(3000)
      prepared = true
    }
    if (mode === 'reload-scrolled') {
      await waitFor('!(' + running + ')', 180000, 300)
      await sleep(1500)
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 400, deltaX: 0, deltaY: -2200 })
      await sleep(800)
    }
    const before = await ev(streamProbe)
    await shot(mode + '-before')
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER })
    await reload()
    await back()
    await sleep(9000)
    const rows = await ev('window.__rec')
    const result = describe(rows, before.textLen)
    const back90 = rows.find((r) => r.textLen >= before.textLen * 0.9)
    report.cases[mode] = { before, ...result, backAtMs: back90?.t ?? null }
    log(mode, { before, ...result, backAtMs: back90?.t ?? null })
    await shot(mode + '-after')
    check(mode + ' 重载后会话回来', result.last?.msgs >= 2, result.last)
    check(mode + ' 重载后无空白帧夹在内容之间', result.blankAfterBack === 0, result)
    if (mode === 'reload-scrolled') check(mode + ' 重载后滚动位置没丢到顶或底', before.scrollTop > 0 && result.last?.scrollTop > 0 && result.last.scrollTop < result.last.scrollHeight - result.last.clientHeight - 40, { before, last: result.last })
    else check(mode + ' 重载后仍贴底', result.last?.scrollHeight - result.last?.clientHeight - result.last?.scrollTop < 60, result.last)
  }

  if (only.includes('subfail')) {
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('SUBAGENTS2 SUBBAD STEPS2 派子代理但它们失败')`)
    await waitFor(running, 20000, 20)
    const rows = await sample(cdp, sleep, 60000, 500)
    const subs = await ev(`JSON.stringify(window.__yanStore.getState().subagents.map((x) => ({ id: x.id.slice(-4), status: x.status, error: (x.error ?? '').slice(0, 120) })))`)
    log('subagents', subs)
    await shot('subfail-end')
    const text = await ev(`document.querySelector('.v3-stream')?.innerText ?? ''`)
    report.cases.subfail = { subs, text: text.slice(-600), last: rows.at(-1) }
    check('子代理失败后状态不卡在运行', !JSON.parse(subs).some((x) => x.status === 'running'), subs)
    check('子代理失败文案无堆栈与原始英文', !/\bat \w+.*:\d+:\d+|ECONNRESET|socket hang up|fetch failed/i.test(text + subs), subs)
  }

  if (only.includes('compact')) {
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('先聊一句，给压缩准备内容')`)
    await waitFor(`!(${running}) && s.messages.length >= 2`, 60000, 100)
    await sleep(800)
    await ev(`window.__compactResult = null; window.__yanStore.getState().compact().then((r) => { window.__compactResult = r })`)
    const rows = await frames(cdp, sleep, 12000, 80)
    const cr = await ev('JSON.stringify(window.__compactResult)')
    log('compact', cr, describe(rows))
    await shot('compact-end')
    report.cases.compact = { result: cr, ...describe(rows) }
    check('压缩结束后不在压缩中', await ev('!window.__yanStore.getState().session?.isCompacting'))
    check('压缩过程内容不被清空', describe(rows).shrink === 0, describe(rows))
  }
  if (only.includes('missingdir')) {
    const gone = box.project + '-gone'
    await ev(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(gone)} })`)
    await sleep(1500)
    await sleep(500)
    const sent = await ev(`window.__yanStore.getState().send('目录没了再发一句')`)
    const rows = await sample(cdp, sleep, 8000, 150)
    const notices = await ev('JSON.stringify(window.__yanStore.getState().notices.map((n) => n.text))')
    await shot('missingdir-after-send')
    const last = rows.at(-1)
    log('missingdir', { sent, notices, last })
    report.cases.missingdir = { sent, notices, last, text: (await ev("document.body.innerText")).slice(0, 1500) }
    check('项目目录不存在时发送不卡在运行', !last?.running, last)
    check('项目目录不存在时提示不含堆栈', !/ENOENT|at w+.*:d+:d+/.test(notices + (last?.card ?? '')), notices)
  }
}
