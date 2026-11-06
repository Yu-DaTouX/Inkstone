import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sampleProcessTree } from '../lib/process-tree.mjs'
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

export default async function run({ cdp, box, check, report, sleep, log, newSession, state, waitFor, until, shot, running, runDir }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.cases = {}
  const only = (process.env.YAN_STATES_ONLY ?? 'reload-bottom,reload-scrolled,subfail,compact,missingdir,looks,compact-live,undo-delete,file-locked').split(',')
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
      await sleep(1500)
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
  if (only.includes('looks')) {
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('FAILQUOTA 额度用完看外观')`)
    await waitFor(`!!document.querySelector('[data-testid="v3-error-card"]') && !(${running})`, 60000, 100)
    for (const theme of ['light', 'dark']) {
      for (const [w, h] of [[1500, 900], [480, 800]]) {
        await ev(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN' })`)
        await cdp.call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
        await sleep(700)
        const overflow = await ev(`(() => { const c = document.querySelector('[data-testid="v3-error-card"]'); return c ? { over: c.scrollWidth - c.clientWidth, right: Math.round(c.getBoundingClientRect().right), vw: innerWidth } : null })()`)
        await shot(`error-card-${theme}-${w}`)
        check(`错误卡 ${theme} ${w} 不溢出`, overflow && overflow.over <= 0 && overflow.right <= overflow.vw, overflow)
      }
    }
    await cdp.call('Emulation.clearDeviceMetricsOverride')
  }

  if (only.includes('compact-live')) {
    const file = join(box.piDir, 'settings.json')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 300 } }))
    const marker = runDir.split('/').pop().split(String.fromCharCode(92)).pop()
    for (const proc of sampleProcessTree(marker).processes.filter((x) => x.kind === 'pi')) { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { stdio: 'ignore' }) } catch {} }
    await sleep(1500)
    await ev('window.yan.start()')
    await waitFor('s.conn === "ready"', 30000, 100)
    await newSession(box.project)
    await sleep(1500)
    for (let i = 0; i < 4; i++) {
      await ev(`window.__yanStore.getState().send('MDREAL 给压缩准备内容 ${i}')`)
      await waitFor(running, 20000, 20)
      await waitFor(`!(${running})`, 120000, 200)
    }
    await sleep(800)
    await ev(`window.__crow = []; window.__crec = setInterval(() => { const g = window.__yanStore.getState(); const el = document.querySelector('.v3-stream'); window.__crow.push({ t: Date.now(), msgs: g.messages.length, compacting: !!g.session?.isCompacting, textLen: el ? el.innerText.length : -1, scrollTop: el ? Math.round(el.scrollTop) : -1, card: document.body.innerText.includes('压缩中') }) }, 25); window.__compactResult = null; window.__yanStore.getState().compact().then((r) => { window.__compactResult = r })`)
    await waitFor('window.__compactResult !== null', 30000, 50)
    await sleep(800)
    const rows = await ev('(() => { clearInterval(window.__crec); return window.__crow })()')
    await shot('compact-live-after')
    const cr = await ev('JSON.stringify(window.__compactResult)')
    let shrink = 0
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].textLen > 200 && rows[i].textLen < rows[i - 1].textLen * 0.5) shrink++
    const sawCompacting = rows.some((r) => r.compacting || r.card)
    log('compact-live', { cr, frames: rows.length, sawCompacting, shrink, msgs: [...new Set(rows.map((r) => r.msgs))], scrollTops: [...new Set(rows.map((r) => r.scrollTop))].slice(0, 12), tail: rows.at(-1) })
    report.cases['compact-live'] = { cr, sawCompacting, shrink }
    check('压缩真实发生', JSON.parse(cr)?.ok === true, cr)
    check('压缩过程内容不被清空', shrink === 0, shrink)
    writeFileSync(file, original)
  }
  if (only.includes('undo-delete')) {
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('先留一个要删的会话')`)
    await waitFor(`!(${running}) && s.messages.length >= 2`, 60000, 100)
    const target = await state('s.session.sessionFile')
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('另一个会话不删')`)
    await waitFor(`!(${running}) && s.messages.length >= 2`, 60000, 100)
    await ev('window.__yanStore.getState().refreshSessions()')
    await sleep(800)
    const listKey = `JSON.stringify(window.__yanStore.getState().sessions.map((x) => x.path))`
    const before = JSON.parse(await ev(listKey)).length
    await ev(`window.__sideRows = []; window.__sideRec = setInterval(() => { window.__sideRows.push({ t: Date.now(), n: window.__yanStore.getState().sessions.length, ui: document.querySelectorAll('[data-testid^="v3-session-row"], .v3-session-row').length }) }, 25)`)
    const del = await ev(`window.__yanStore.getState().deleteSession(${JSON.stringify(target)}).then((r) => JSON.stringify(r))`)
    await sleep(1200)
    const afterDelete = JSON.parse(await ev(listKey)).length
    await shot('undo-delete-after-delete')
    const token = JSON.parse(del).undoToken
    const restored = await ev(`window.__yanStore.getState().restoreDeletedSession(${JSON.stringify(token)}).then((r) => JSON.stringify(r))`)
    await sleep(1200)
    const afterRestore = JSON.parse(await ev(listKey)).length
    const rows = await ev('(() => { clearInterval(window.__sideRec); return window.__sideRows })()')
    await shot('undo-delete-after-restore')
    const counts = rows.map((r) => r.n)
    let flips = 0
    for (let i = 1; i < counts.length; i++) if (counts[i] !== counts[i - 1]) flips++
    log('undo-delete', { del, restored, before, afterDelete, afterRestore, counts: [...new Set(counts)], flips })
    check('删除后列表少一条', afterDelete === before - 1, { before, afterDelete })
    check('撤销后列表恢复', afterRestore === before && JSON.parse(restored).ok === true, { afterRestore, restored })
    check('撤销删除过程列表不来回抖动', flips <= 2, flips)
  }

  if (only.includes('file-locked')) {
    await newSession(box.project)
    await sleep(1500)
    await ev(`window.__yanStore.getState().send('先写一条再锁文件')`)
    await waitFor(`!(${running}) && s.messages.length >= 2`, 60000, 100)
    const file = await state('s.session.sessionFile')
    await newSession(box.project)
    await sleep(1500)
    const lock = spawn('powershell', ['-NoProfile', '-Command', `$f = [System.IO.File]::Open(${JSON.stringify(file)}, 'Open', 'ReadWrite', 'None'); Start-Sleep -Seconds 25; $f.Close()`], { stdio: 'ignore', windowsHide: true })
    await sleep(2000)
    const result = await ev(`window.__yanStore.getState().deleteSession(${JSON.stringify(file)}).then((r) => JSON.stringify(r))`)
    await sleep(800)
    const notices = await ev('JSON.stringify(window.__yanStore.getState().notices.map((n) => n.text))')
    await shot('file-locked-delete')
    const sentLocked = await ev(`window.__yanStore.getState().send('文件被占用时再发一句')`)
    await sleep(6000)
    const live = await ev(`JSON.stringify({ running: !!(s => s.session?.isAgentRunning)(window.__yanStore.getState()), msgs: window.__yanStore.getState().messages.length, notices: window.__yanStore.getState().notices.map((n) => n.text) })`)
    await shot('file-locked-send')
    log('file-locked', { result, notices, sentLocked, live })
    lock.kill()
    check('文件被占用时删除给出可读提示', await ev("document.body.innerText.includes('被其他程序占用') && !document.body.innerText.includes('EBUSY')"), notices)
    check('文件被占用时发送不卡在运行', !JSON.parse(live).running, live)
  }
}
