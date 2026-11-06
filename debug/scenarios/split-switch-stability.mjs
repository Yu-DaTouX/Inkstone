import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '分屏切换焦点的稳定性：两个会话各三轮（FLOW/MANYTOOLS），每格滚到中段并展开一个过程，焦点格输入三行草稿；点击另一格标题切换并切回，逐帧记录空白帧、消息流元素替换、阅读锚点位移、过程展开状态与非焦点输入框截断，不调用真实模型' }

const SAMPLER = (keys, anchors) => `(() => {
  const keys = ${JSON.stringify(keys)};
  const anchors = ${JSON.stringify(anchors)};
  window.__sw = { frames: [], stop: false, start: performance.now() };
  window.__swSid = window.__swSid || 1;
  const tileOf = (key) => [...document.querySelectorAll('[data-tile-key]')].find((el) => el.dataset.tileKey === key);
  const sample = () => {
    const t = Math.round(performance.now() - window.__sw.start);
    for (const key of keys) {
      const tile = tileOf(key);
      const stream = tile ? [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0) : null;
      if (stream && !stream.__swSid) stream.__swSid = window.__swSid++;
      const anchor = stream && anchors[key] ? stream.querySelector('.v3-msg[data-turn-id="' + CSS.escape(anchors[key]) + '"]') : null;
      const process = anchor ? anchor.querySelector('[data-testid="v3-process"]') : null;
      window.__sw.frames.push({
        t, key,
        live: tile?.dataset.live ?? null,
        top: stream ? Math.round(stream.scrollTop) : null,
        sh: stream ? stream.scrollHeight : null,
        rows: stream ? stream.querySelectorAll('.v3-msg[data-turn-id]').length : 0,
        sid: stream?.__swSid ?? 0,
        offset: anchor && stream ? Math.round(anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top) : null,
        open: process ? process.hasAttribute('data-open') : null
      });
    }
    if (!window.__sw.stop) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`

function analyze(frames, key, before) {
  const own = frames.filter((frame) => frame.key === key)
  const blank = own.filter((frame) => frame.rows === 0).length
  const sids = new Set(own.map((frame) => frame.sid).filter(Boolean))
  const missing = own.filter((frame) => frame.offset === null).length
  const offsets = own.map((frame) => frame.offset).filter((value) => value !== null)
  const last = own.at(-1)
  const firstShift = own.find((frame) => frame.offset !== null && Math.abs(frame.offset - before.offset) > 1)
  return {
    firstShift: firstShift ? { t: firstShift.t, offset: firstShift.offset, top: firstShift.top, sh: firstShift.sh, live: firstShift.live } : null,
    startFrame: own[0] ? { top: own[0].top, sh: own[0].sh, offset: own[0].offset } : null,
    endFrame: last ? { top: last.top, sh: last.sh } : null,
    frames: own.length,
    blankFrames: blank,
    streamElements: sids.size,
    anchorMissingFrames: missing,
    offsetBefore: before.offset,
    offsetAfter: last?.offset ?? null,
    maxJump: offsets.length ? Math.max(...offsets.map((value) => Math.abs(value - before.offset))) : null,
    openBefore: before.open,
    openAfter: last?.open ?? null,
    liveAfter: last?.live ?? null
  }
}

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, shot, log, autoApprove, newSession, state, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()

  const sessions = []
  for (const [index, project] of [box.projects[0] ?? box.project, box.projects[1] ?? box.project].entries()) {
    await newSession(project)
    const tag = index ? 'B' : 'A'
    await turn(`FLOW SHORT ${tag}1 \u5148\u770b\u770b\u9879\u76ee`)
    await turn(`MANYTOOLS ${tag}2 \u8dd1\u56db\u5341\u6b65`, { timeout: 180000 })
    await turn(`FLOW ${tag}3 \u4fee\u590d\u91d1\u989d`)
    await turn(`LONGTEXT ${tag}4 \u957f\u6587`)
    sessions.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  log('sessions', sessions)
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(sessions)}, live: 1 })`)
  await sleep(2000)
  const keys = await ev(`[...document.querySelectorAll('[data-tile-key]')].map((el) => ({ key: el.dataset.tileKey, live: el.dataset.live, pane: el.dataset.pane }))`)
  log('tiles', keys)
  check('\u4e24\u683c\u5206\u5c4f\u5df2\u6253\u5f00', keys.length === 2, keys)
  if (keys.length !== 2) return
  const keyOf = (live) => keys.find((item) => item.live === live).key

  const prepare = (key) => ev(`(async () => {
    const tile = [...document.querySelectorAll('[data-tile-key]')].find((el) => el.dataset.tileKey === ${JSON.stringify(key)});
    const stream = [...tile.querySelectorAll('.v3-stream')].find((el) => el.clientHeight > 0);
    stream.scrollTop = Math.round((stream.scrollHeight - stream.clientHeight) * 0.35);
    await new Promise((r) => setTimeout(r, 600));
    const top = stream.getBoundingClientRect().top;
    const candidates = [...stream.querySelectorAll('.v3-msg.assistant[data-turn-id]')].filter((el) => el.querySelector('[data-testid="v3-process"]:not([data-headless])'));
    const visible = candidates.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > top + 40 && r.top < top + stream.clientHeight - 80 });
    const article = visible[0] ?? candidates[0];
    if (!article) return null;
    const process = article.querySelector('[data-testid="v3-process"]');
    if (!process.hasAttribute('data-open')) {
      const trigger = process.querySelector('button, [role="button"], [slot="trigger"]');
      trigger?.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = article.getBoundingClientRect();
    if (r.top < top || r.top > top + stream.clientHeight - 120) { stream.scrollTop += r.top - top - 60; await new Promise((res) => setTimeout(res, 400)) }
    return { turnId: article.dataset.turnId, offset: Math.round(article.getBoundingClientRect().top - stream.getBoundingClientRect().top), open: process.hasAttribute('data-open') };
  })()`)

  const liveKey = keyOf('1')
  const peerKey = keyOf('0')
  const before1 = { [liveKey]: await prepare(liveKey), [peerKey]: await prepare(peerKey) }
  log('prepared', before1)
  check('\u4e24\u683c\u90fd\u627e\u5230\u53ef\u5c55\u5f00\u7684\u8fc7\u7a0b\u5e76\u5df2\u5c55\u5f00', !!before1[liveKey]?.open && !!before1[peerKey]?.open, before1)

  await ev(`document.querySelector('[data-tile-key="${liveKey}"] .ProseMirror, .ProseMirror')?.focus()`)
  for (const [index, line] of ['\u7b2c\u4e00\u884c\u8349\u7a3f\uff1a\u5207\u6362\u5206\u5c4f\u540e\u5e94\u5b8c\u6574\u53ef\u89c1', '\u7b2c\u4e8c\u884c\uff1a\u4e0d\u5e94\u88ab\u538b\u6210\u4e00\u884c', '\u7b2c\u4e09\u884c\u7ed3\u675f'].entries()) {
    if (index) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
    }
    await cdp.call('Input.insertText', { text: line })
    await sleep(60)
  }
  await sleep(400)
  await shot('before-switch')

  const clickTitle = async (key) => {
    const point = await ev(`(() => { const el = document.querySelector('[data-tile-key="${key}"] .v3-split-title'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }

  const screencast = async (name, durationMs, action) => {
    let seen = cdp.events.length
    const frames = []
    let running = true
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1100, maxHeight: 600, everyNthFrame: 1 })
    const pump = (async () => {
      while (running) {
        while (seen < cdp.events.length) {
          const event = cdp.events[seen++]
          if (event.method !== 'Page.screencastFrame') continue
          frames.push({ t: event.params.metadata.timestamp, data: event.params.data })
          cdp.call('Page.screencastFrameAck', { sessionId: event.params.sessionId }).catch(() => {})
        }
        await sleep(5)
      }
    })()
    await sleep(150)
    const clickedAt = Date.now() / 1000
    await action()
    await sleep(durationMs)
    running = false
    await pump
    await cdp.call('Page.stopScreencast').catch(() => {})
    const dir = join(runDir, 'screencast-' + name)
    mkdirSync(dir, { recursive: true })
    frames.forEach((frame, index) => writeFileSync(join(dir, String(index).padStart(3, '0') + '_' + Math.round((frame.t - clickedAt) * 1000) + 'ms.jpg'), Buffer.from(frame.data, 'base64')))
    return { frames: frames.length, dir }
  }

  const measureSwitch = async (name, toKey, before, record = false) => {
    const anchors = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value?.turnId]))
    await ev(SAMPLER(Object.keys(before), anchors))
    await sleep(100)
    const t = Date.now()
    const film = record ? screencast(name, 1200, () => clickTitle(toKey)) : clickTitle(toKey)
    if (!record) await film
    await waitFor(`[...document.querySelectorAll('[data-tile-key]')].find((el) => el.dataset.tileKey === ${JSON.stringify(toKey)})?.dataset.live === '1' && !s.switchLoading`, 15000, 10)
    const switchMs = Date.now() - t
    const filmed = record ? await film : null
    await sleep(record ? 800 : 2000)
    const frames = await ev(`(() => { window.__sw.stop = true; return window.__sw.frames })()`)
    const result = { switchMs, ...(filmed ? { screencast: filmed } : {}), tiles: Object.fromEntries(Object.keys(before).map((key) => [key, analyze(frames, key, before[key])])) }
    report.timings[name] = result
    log(name, result)
    return result
  }

  const first = await measureSwitch('switch-to-left', peerKey, before1, true)
  await shot('after-switch')
  const peerInput = await ev(`(() => {
    const el = document.querySelector('[data-tile-key="${liveKey}"] .v3-split-peer-input');
    if (!el) return null;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    return { value: el.value, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, lineHeight, visibleLines: +(el.clientHeight / lineHeight).toFixed(2), lines: el.value.split('\\n').length };
  })()`)
  report.peerInput = peerInput
  log('peer-input', peerInput)
  check('\u975e\u7126\u70b9\u8f93\u5165\u6846\u4fdd\u7559\u5168\u90e8\u8349\u7a3f\u6587\u5b57', !!peerInput && peerInput.value.includes('\u7b2c\u4e09\u884c\u7ed3\u675f'), peerInput)
  check('\u975e\u7126\u70b9\u8f93\u5165\u6846\u6ca1\u6709\u628a\u591a\u884c\u8349\u7a3f\u88c1\u6210\u534a\u884c', !!peerInput && (peerInput.scrollHeight <= peerInput.clientHeight + 1 || Number.isInteger(Math.round(peerInput.visibleLines * 100) / 100)), peerInput)

  const after1 = { [liveKey]: await prepare(liveKey), [peerKey]: await prepare(peerKey) }
  const second = await measureSwitch('switch-back', liveKey, after1)
  await shot('after-switch-back')
  const draftBack = await ev(`document.querySelector('.ProseMirror')?.innerText ?? ''`)
  report.draftBack = draftBack

  for (const [name, result] of [['\u5207\u5230\u5de6\u683c', first], ['\u5207\u56de\u53f3\u683c', second]]) {
    for (const [key, tile] of Object.entries(result.tiles)) {
      const label = `${name} \u00b7 ${key === liveKey ? '\u53f3\u683c' : '\u5de6\u683c'}`
      check(`${label} \u65e0\u7a7a\u767d\u5e27`, tile.blankFrames === 0, tile)
      check(`${label} \u6d88\u606f\u6d41\u5143\u7d20\u4e0d\u66ff\u6362`, tile.streamElements <= 1, tile)
      check(`${label} \u9605\u8bfb\u951a\u70b9\u4f4d\u79fb\u4e0d\u8d85\u8fc7 24px`, tile.offsetAfter !== null && Math.abs(tile.offsetAfter - tile.offsetBefore) <= 24, tile)
      check(`${label} \u5c55\u5f00\u7684\u8fc7\u7a0b\u4fdd\u6301\u5c55\u5f00`, tile.openBefore === true && tile.openAfter === true, tile)
    }
  }
  check('\u5207\u56de\u540e\u8349\u7a3f\u4e09\u884c\u90fd\u5728', draftBack.includes('\u7b2c\u4e00\u884c') && draftBack.includes('\u7b2c\u4e09\u884c\u7ed3\u675f'), draftBack)
}

