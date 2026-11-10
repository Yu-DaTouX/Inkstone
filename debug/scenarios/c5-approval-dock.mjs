export const meta = { description: 'C5 审批坞/右栏：打开右栏与审批/提问坞，记录消息流 scrollTop/scrollHeight/clientHeight、坞高度与可视行，宽窄与深浅各截图，不调用真实模型' }

const MEASURE = `(() => {
  const host = document.querySelector('.v3-stream-host')
  const stream = document.querySelector('.v3-stream')
  const inner = document.querySelector('.v3-stream-inner')
  const dock = document.querySelector('[data-ask-dock]')
  const composer = document.querySelector('.v3-composer')
  const root = document.querySelector('.v3-root')
  const rows = [...document.querySelectorAll('.v3-stream-row, .v3-msg')]
  const streamRect = stream ? stream.getBoundingClientRect() : null
  const dockRect = dock ? dock.getBoundingClientRect() : null
  const composerRect = composer ? composer.getBoundingClientRect() : null
  const visible = streamRect
    ? rows.filter((row) => {
        const box = row.getBoundingClientRect()
        return box.height > 0 && box.bottom > streamRect.top + 1 && box.top < streamRect.bottom - 1
      })
    : []
  const dockListRect = dock ? dock.querySelector('.ask-dock-list')?.getBoundingClientRect() ?? null : null
  const behindDock = dockListRect
    ? rows.filter((row) => {
        const box = row.getBoundingClientRect()
        return box.height > 0 && box.bottom > dockListRect.top + 1 && box.top < dockListRect.bottom - 1
      }).length
    : 0
  const list = dock?.querySelector('.ask-dock-list')
  const listRect = list ? list.getBoundingClientRect() : null
  const cards = list ? [...list.children].map((el) => { const b = el.getBoundingClientRect(); return { cls: String(el.className).slice(0, 30), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } }) : []
  const composerEl = composer ? [...composer.children] : []
  const inputBox = composerEl.map((el) => { const b = el.getBoundingClientRect(); return { cls: String(el.className).slice(0, 40), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } })
  const editor = document.querySelector('.composer-v3__editor-row')
  const editorRect = editor ? editor.getBoundingClientRect() : null
  const frame = document.querySelector('.t3-frame')
  const frameRect = frame ? frame.getBoundingClientRect() : null
  const lastRow = list?.querySelector('.v3-qoption-row:last-child, .v3-qoption:last-child, .ui-card__body > *:last-child')
  const lastRowRect = lastRow ? lastRow.getBoundingClientRect() : null
  const qhead = dock?.querySelector('.v3-qhead')
  const qtitle = qhead?.querySelector('.ui-card__title')
  const qbadge = qhead?.querySelector('.ui-card__status')
  const qmeta = qhead?.querySelector('.ui-card__meta')
  const rectOf = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), top: Math.round(b.top) } }
  const head = qhead ? { width: Math.round(qhead.getBoundingClientRect().width), wrap: getComputedStyle(qhead).flexWrap, title: rectOf(qtitle), badge: rectOf(qbadge), meta: rectOf(qmeta) } : null
  const surface = dock?.closest('[data-composer-banner-surface]') ?? dock?.parentElement
  const cs = dock ? getComputedStyle(dock) : null
  const surfaceCs = surface ? getComputedStyle(surface) : null
  return {
    viewport: { w: innerWidth, h: innerHeight },
    panel: root?.dataset.panel ?? null,
    stream: stream
      ? {
          scrollTop: Math.round(stream.scrollTop),
          scrollHeight: stream.scrollHeight,
          clientHeight: stream.clientHeight,
          height: Math.round(streamRect.height),
          top: Math.round(streamRect.top),
          bottom: Math.round(streamRect.bottom),
          paddingBottom: inner ? getComputedStyle(inner).paddingBottom : null,
          innerChildren: inner ? inner.children.length : 0
        }
      : null,
    dock: dockRect
      ? {
          height: Math.round(dockRect.height),
          top: Math.round(dockRect.top),
          bottom: Math.round(dockRect.bottom),
          bg: cs?.backgroundColor ?? null,
          surfaceBg: surfaceCs?.backgroundColor ?? null,
          surfaceBackdrop: surfaceCs ? (surfaceCs.backdropFilter || surfaceCs.webkitBackdropFilter) : null
        }
      : null,
    composer: composerRect ? { height: Math.round(composerRect.height), top: Math.round(composerRect.top), bottom: Math.round(composerRect.bottom) } : null,
    dockList: listRect ? { height: Math.round(listRect.height), top: Math.round(listRect.top), bottom: Math.round(listRect.bottom), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflowY: getComputedStyle(list).overflowY } : null,
    dockCards: cards,
    composerChildren: inputBox,
    editor: editorRect ? { top: Math.round(editorRect.top), bottom: Math.round(editorRect.bottom), h: Math.round(editorRect.height) } : null,
    frame: frameRect ? { top: Math.round(frameRect.top), bottom: Math.round(frameRect.bottom), h: Math.round(frameRect.height) } : null,
    lastRow: lastRowRect ? { top: Math.round(lastRowRect.top), bottom: Math.round(lastRowRect.bottom), h: Math.round(lastRowRect.height), clippedByList: listRect ? Math.round(lastRowRect.bottom - listRect.bottom) : null, clippedByEditor: editorRect ? Math.round(lastRowRect.bottom - editorRect.top) : null } : null,
    head,
    listOverflow: list ? list.scrollHeight - list.clientHeight : null,
    composerVar: host ? getComputedStyle(host).getPropertyValue('--composer-h').trim() : null,
    after: host ? (() => { const a = getComputedStyle(host, '::after'); return { height: a.height, background: a.backgroundImage.slice(0, 80) } })() : null,
    rows: rows.length,
    visibleRows: visible.length,
    behindDock,
    firstVisible: visible[0] ? (visible[0].textContent || '').slice(0, 40) : null,
    lastVisible: visible.length ? (visible.at(-1).textContent || '').slice(-40) : null,
    messageCount: window.__yanStore.getState().messages.length,
    dockOverlapsComposer: !!(dockRect && composerRect && dockRect.bottom > composerRect.top + 1),
    blankBelowContent: !!(stream && inner && stream.scrollHeight - stream.clientHeight - stream.scrollTop > 8)
  }
})()`

export default async function run({ cdp, waitFor, check, report, sleep, newSession, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const state = (expr) => ev(`(() => { const s = window.__yanStore.getState(); return ${expr} })()`)
  const results = []
  const setViewport = async (width, height) => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
  }
  const theme = async (value) => {
    await state(`s.patchSettings({ theme: '${value}' })`)
    await sleep(600)
  }
  const openPanel = async () => {
    await waitFor(`!!window.__yanStore.getState().session?.sessionId`, 30000, 50)
    await ev(`document.querySelector('[data-testid="v3-head-panel-toggle"]')?.click()`)
    await sleep(1600)
    const opened = await ev(`(() => ({ root: document.querySelector('.v3-root')?.dataset.panel, body: document.querySelector('.v3-body')?.dataset.panel, width: document.querySelector('.v3-chat')?.getBoundingClientRect().width }))()`)
    log('open-panel', opened)
    if (opened.root === 'closed') {
      await ev(`(() => { const id = window.__yanStore.getState().session?.sessionId; const p = window.__yanRightPanel.getState(); if (id) p.load(id); p.setOpen(true); if (id) p.open({ id: 'files', kind: 'files' }) })()`)
      await sleep(1200)
    }
  }

  const answerApproval = async () => {
    await state(`(() => { const a = s.approvals[0]; if (a) void s.answerApproval(a.id, 'session') })()`)
    await sleep(1500)
  }
  const answerQuestion = async () => {
    await state(`(() => { const q = (s.uiRequests || []).find((r) => r.method === 'question' || r.method === 'select'); if (q) void s.answerUi({ id: q.id, value: (q.options && q.options[0]) || '选项一' }) })()`)
    await sleep(1500)
  }

  const measure = async (label) => {
    const values = await ev(MEASURE)
    results.push({ label, ...values })
    log(label, values)
    return values
  }

  await setViewport(Number(process.env.C5_WIDTH ?? 1400), Number(process.env.C5_HEIGHT ?? 900))
  await theme('dark')
  await newSession()
  await sleep(1000)
  await openPanel()
  await ev(`window.__yanStore.getState().send('LONGTEXT 长文滚动到审批坞后面')`)
  await waitFor(`(() => { const s = window.__yanStore.getState(); return s.session && !s.session.isAgentRunning && !s.session.isStreaming && s.messages.length > 1 })()`, 90000, 100)
  await sleep(600)
  await ev(`window.__yanStore.getState().send('APPROVAL 审批坞与右栏')`)
  await waitFor(`!!document.querySelector('[data-ask-dock]')`, 60000, 50)
  await sleep(1200)
  const wideDark = await measure('wide-dark')
  report.wideDark = wideDark
  report.wideDarkShot = await shot('c5-wide-dark')
  await ev(`(() => { const stream = document.querySelector('.v3-stream'); if (stream) stream.scrollTop = Math.max(0, stream.scrollHeight - stream.clientHeight - 260) })()`)
  await sleep(700)
  const scrolled = await measure('wide-dark-scrolled')
  report.scrolled = scrolled
  report.scrolledShot = await shot('c5-wide-dark-scrolled')
  await answerApproval()

  await setViewport(Number(process.env.C5_NARROW_WIDTH ?? 1000), 900)
  await sleep(800)
  await ev(`window.__yanStore.getState().send('QUESTION 窄窗口右栏')`)
  await waitFor(`!!document.querySelector('[data-ask-dock]')`, 60000, 50)
  await sleep(1200)
  const narrowDark = await measure('narrow-dark')
  report.narrowDark = narrowDark
  report.narrowDarkShot = await shot('c5-narrow-dark')
  await answerQuestion()

  await setViewport(1400, 900)
  await theme('light')
  await sleep(800)
  await ev(`window.__yanStore.getState().send('QUESTION 浅色宽窗口右栏')`)
  await waitFor(`!!document.querySelector('[data-ask-dock]')`, 60000, 50)
  await sleep(1200)
  const wideLight = await measure('wide-light')
  report.wideLight = wideLight
  report.wideLightShot = await shot('c5-wide-light')
  await ev(`(() => { const list = document.querySelector('.ask-dock-list'); if (list) list.scrollTop = list.scrollHeight })()`)
  await sleep(500)
  const wideLightBottom = await measure('wide-light-scrolled')
  report.wideLightBottom = wideLightBottom
  report.wideLightBottomShot = await shot('c5-wide-light-scrolled')

  for (const item of results) {
    check(`${item.label} 有消息流`, !!item.stream && item.stream.clientHeight > 0, item.stream)
    check(`${item.label} 右栏已打开`, item.panel && item.panel !== 'closed', item.panel)
    check(`${item.label} 停靠区有高度`, !!item.dock && item.dock.height > 40, item.dock)
    check(`${item.label} 消息流不是空白（可见行 > 0）`, item.visibleRows > 0, { rows: item.rows, visibleRows: item.visibleRows, stream: item.stream })
  }
  check('右栏打开时 composer 高度至少覆盖停靠区', results.every((item) => !item.dock || (Number(item.composerVar.replace('px', '')) >= item.dock.height - 1)), results.map((item) => ({ label: item.label, dock: item.dock?.height, composerVar: item.composerVar })))
}
