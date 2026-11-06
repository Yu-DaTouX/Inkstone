import { MOD } from '../lib/review-kit.mjs'

export const meta = { description: '可访问性审计：AX 树角色/名称/状态、live region、Tab 焦点序列与焦点陷阱、分屏/审批/提问/右栏/设置/命令面板/Ctrl+Tab 的焦点去向，含减少动效复走；不调用真实模型' }

const HELPERS = `(() => {
  if (window.__a11y) return
  const sigOf = (el) => { const parts = []; let n = el; for (let i = 0; i < 6 && n && n !== document.body; i++, n = n.parentElement) { const c = getComputedStyle(n); const a = getComputedStyle(n, '::after'); const b = getComputedStyle(n, '::before'); parts.push([c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.backgroundColor, c.borderTopColor, c.borderBottomColor, c.color, c.textDecorationLine, c.opacity, a.backgroundColor, a.opacity, a.boxShadow, b.backgroundColor, b.opacity, b.boxShadow].join('/')) } return parts.join('|') }
  const staticRing = (el) => { let n = el; for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) { for (const pseudo of [null, '::before', '::after']) { const c = getComputedStyle(n, pseudo); if (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) return true; if (c.boxShadow && c.boxShadow !== 'none' && /[1-9]/.test(c.boxShadow.replace(/(rgba?|color)[(][^)]*[)]/g, ''))) return true } } return false }
  const label = (el) => el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || el.value || '').trim().slice(0, 40)
  const describe = (el) => {
    if (!el || el === document.body) return { tag: 'body' }
    const r = el.getBoundingClientRect()
    if (!window.__a11y.sigs.has(el)) window.__a11y.sigs.set(el, sigOf(el))
    window.__a11y.static.set(el, staticRing(el))
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      id: el.getAttribute('data-testid') || el.id || (typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 2).join('.') : ''),
      label: label(el),
      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
    }
  }
  const unringed = async () => {
    const textual = (el) => el.isContentEditable || el.getAttribute('role') === 'textbox' || (el.tagName === 'INPUT' && /text|search|^$/.test(el.type)) || el.tagName === 'TEXTAREA'
    const entries = [...window.__a11y.sigs].filter(([el]) => el.isConnected && !textual(el))
    const ringedWhileFocused = new Map(entries.map(([el]) => [el, window.__a11y.static.get(el)]))
    document.activeElement?.blur?.()
    const out = []
    for (const [el, sig] of entries) {
      if (sigOf(el) === sig && !ringedWhileFocused.get(el)) out.push(el.tagName.toLowerCase() + '|' + (el.getAttribute('data-testid') || el.id || '') + '|' + label(el))
    }
    window.__a11y.sigs = new Map()
    window.__a11y.static = new Map()
    return out
  }
  const lives = []
  const liveOf = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return el?.closest('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]') }
  const observer = new MutationObserver((list) => {
    for (const m of list) {
      const host = liveOf(m.target) || (m.type === 'childList' ? [...m.addedNodes].map(liveOf).find(Boolean) : null)
      if (!host) continue
      const added = m.type === 'childList' ? [...m.addedNodes].map((n) => (n.textContent || '').trim()).join(' ') : (m.target.textContent || '').trim()
      if (!added) continue
      lives.push({ t: Math.round(performance.now()), role: host.getAttribute('role') || ('live:' + host.getAttribute('aria-live')), id: host.getAttribute('data-testid') || (typeof host.className === 'string' ? host.className.slice(0, 40) : ''), text: added.slice(0, 80) })
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  window.__a11y = { sigs: new Map(), static: new Map(), describe, unringed, lives }
})()`

export default async function run(ctx) {
  const { cdp, box, waitFor, check, report, sleep, shot, log, newSession, state, running, autoApprove } = ctx
  const ev = (expr) => cdp.evaluate(expr)
  const findings = []
  report.findings = findings
  report.sections = {}
  const note = (area, problem, detail) => { findings.push({ area, problem, detail }); log('FINDING', area, problem, detail === undefined ? '' : detail) }
  const phase = async (name, fn) => {
    try { await fn() } catch (error) { note(name, '阶段异常', String(error).slice(0, 300)) }
    await ev(`document.activeElement?.blur?.()`).catch(() => {})
  }
  const cc = async (method, params) => (await cdp.call(method, params ?? {})).result
  await cc('Accessibility.enable')
  await cc('DOM.enable')
  await cc('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(HELPERS)

  const active = () => ev(`window.__a11y.describe(document.activeElement)`)
  const activeInside = (selector) => ev(`!!document.activeElement?.closest(${JSON.stringify(selector)})`)
  const keyDef = (key) => {
    const table = { Tab: [9, 'Tab'], Escape: [27, 'Escape'], Enter: [13, 'Enter'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], PageDown: [34, 'PageDown'], End: [35, 'End'], Space: [32, 'Space'], ',': [188, 'Comma'], '\\': [220, 'Backslash'], ']': [221, 'BracketRight'], '[': [219, 'BracketLeft'], '`': [192, 'Backquote'] }
    if (table[key]) return table[key]
    if (/^[0-9]$/.test(key)) return [48 + Number(key), `Digit${key}`]
    return [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`]
  }
  const press = async (key, mods = 0, wait = 150) => {
    const [vk, code] = keyDef(key)
    const base = { key: key === 'Space' ? ' ' : key, code, windowsVirtualKeyCode: vk, modifiers: mods }
    const text = !mods && key.length === 1 ? key : key === 'Enter' && !mods ? '\r' : key === 'Space' && !mods ? ' ' : undefined
    await cc('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
    await cc('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(wait)
  }
  const clickEl = async (selector) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    if (!r) throw new Error('找不到 ' + selector)
    await cc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
    await cc('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await cc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await sleep(300)
  }
  const axTree = async () => {
    const { nodes } = await cc('Accessibility.getFullAXTree')
    return nodes.filter((n) => !n.ignored).map((n) => ({
      role: n.role?.value, name: n.name?.value ?? '',
      props: Object.fromEntries((n.properties ?? []).map((p) => [p.name, p.value?.value])),
      backendDOMNodeId: n.backendDOMNodeId
    }))
  }
  const outerOf = async (backendNodeId) => {
    try {
      const { object } = await cc('DOM.resolveNode', { backendNodeId })
      const r = await cc('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ return this.outerHTML.slice(0, 200) }', returnByValue: true })
      return r.result.value
    } catch { return null }
  }
  const NEED_NAME = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'searchbox', 'option', 'spinbutton', 'menuitemradio', 'menuitemcheckbox', 'separator', 'dialog', 'tablist', 'tree', 'treeitem', 'listbox', 'region'])
  const axAudit = async (scope) => {
    const nodes = await axTree()
    const bad = nodes.filter((n) => NEED_NAME.has(n.role) && !String(n.name).trim() && !(n.role === 'separator' && !n.props.focusable))
    const out = []
    for (const n of bad.slice(0, 30)) out.push({ role: n.role, html: n.backendDOMNodeId ? await outerOf(n.backendDOMNodeId) : null })
    log(scope, 'AX 节点', nodes.length, '无名称', bad.length)
    if (bad.length) note(scope, `AX 树中有 ${bad.length} 个无名称的可交互/容器节点`, out)
    const roles = {}
    for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1
    report.sections[scope + ':roles'] = roles
    return nodes
  }
  const tabWalk = async (scope, steps, { shift = false, scopeSel = null } = {}) => {
    await ev(`(() => { window.__a11y.sigs = new Map(); if (!document.getElementById('__a11y-notrans')) { const st = document.createElement('style'); st.id = '__a11y-notrans'; st.textContent = '*,*::before,*::after{transition:none!important;animation-duration:0s!important}'; document.head.appendChild(st) } })()`)
    const seq = []
    for (let i = 0; i < steps; i++) {
      await press('Tab', shift ? MOD.shift : 0, 110)
      seq.push(await active())
    }
    const keys = seq.map((d) => `${d.tag}|${d.id}|${d.label}|${(d.rect ?? []).join(',')}`)
    const inside = scopeSel ? await ev(`!!document.activeElement?.closest(${JSON.stringify(scopeSel)})`) : null
    const hidden = seq.filter((d) => d.tag !== 'body' && !d.visible)
    const noRing = await ev(`window.__a11y.unringed()`)
    const lost = seq.filter((d) => d.tag === 'body').length
    const unique = new Set(keys).size
    log(scope, `Tab ${steps} 次：不同元素 ${unique}，落到 body ${lost}，不可见 ${hidden.length}，无焦点样式变化 ${noRing.length}`)
    if (hidden.length) note(scope, '焦点落在屏幕外/零尺寸元素', hidden.slice(0, 6))
    if (noRing.length) note(scope, 'Tab 聚焦时样式无任何变化（疑无焦点环）', noRing.slice(0, 10))
    const counts = {}
    for (const k of keys) counts[k] = (counts[k] || 0) + 1
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    if (top && steps > 0 && unique > 1 && top[1] >= 4 && steps < unique * 3) note(scope, '疑似焦点陷阱', top)
    report.sections[scope + ':tab'] = keys
    await ev(`document.getElementById('__a11y-notrans')?.remove()`)
    return { seq, keys, unique, inside }
  }
  const liveSince = async (since) => ev(`window.__a11y.lives.filter((l) => l.t >= ${since})`)
  const nowT = () => ev(`Math.round(performance.now())`)
  const send = async (text) => ev(`window.__yanStore.getState().send(${JSON.stringify(text)})`)

  const mainChecks = async (suffix) => {
    await phase('主窗口' + suffix, async () => {
      await newSession(box.projects[0] ?? box.project)
      await send('你好')
      await waitFor(`!(${running}) && s.messages.length >= 2`, 30000, 50)
      await sleep(800)
      await ev(`document.activeElement?.blur?.()`)
      await tabWalk('主窗口' + suffix, 70)
      await tabWalk('主窗口' + suffix + ':反向', 15, { shift: true })
      await axAudit('主窗口' + suffix)
      const lm = (await axTree()).filter((n) => ['main', 'navigation', 'complementary', 'banner', 'region', 'search', 'log', 'status', 'alert', 'list', 'article', 'feed'].includes(n.role)).map((n) => `${n.role}:${n.name}`)
      report.sections['主窗口' + suffix + ':landmarks'] = lm
      const infinite = await ev(`document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).map((a) => (a.effect.target?.className || a.effect.target?.tagName || '').toString().slice(0, 40))`)
      report.sections['主窗口' + suffix + ':infiniteAnimations'] = infinite
      if (suffix && infinite.length) note('主窗口' + suffix, '减少动效下仍有无限循环动画', infinite)
    })
  }

  await mainChecks('')

  await phase('运行播报', async () => {
    await newSession(box.projects[0] ?? box.project)
    const t0 = await nowT()
    await send('FLOW 看看')
    await waitFor(running, 15000, 30)
    await sleep(2500)
    const during = await liveSince(t0)
    await waitFor(`!(${running})`, 90000, 100)
    await sleep(600)
    const all = await liveSince(t0)
    report.sections['运行播报'] = { duringCount: during.length, sample: all.slice(0, 20), total: all.length }
    log('运行期间 live 播报', during.length, '共', all.length, all.slice(0, 8))
    const runAnnounce = all.filter((l) => /运行|思考|完成|停止|running|working|done/i.test(l.text))
    if (!runAnnounce.length) note('运行播报', '运行开始/结束没有任何 live region 播报状态', all.slice(0, 5))
    const aria = await ev(`[...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')].map((e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), id: e.getAttribute('data-testid') || (typeof e.className === 'string' ? e.className.slice(0, 40) : ''), text: (e.textContent || '').slice(0, 40) }))`)
    report.sections['运行播报:regions'] = aria
    const feed = (await axTree()).filter((n) => n.role === 'log' || n.role === 'feed')
    log('消息流 log/feed 节点', feed.length)
  })

  await phase('审批卡', async () => {
    await newSession(box.projects[0] ?? box.project)
    const t0 = await nowT()
    await ev('document.activeElement?.blur?.()')
    await send('APPROVAL 删除')
    const got = await ctx.until(`(Array.isArray(s.approvals) ? s.approvals.length : Object.keys(s.approvals ?? {}).length) > 0`, 20000, 50)
    if (!got) { note('审批卡', '假模型 APPROVAL 没有产生待审批（可能被自动批准），跳过', await state('JSON.stringify(Object.keys(s.approvals ?? {}))')); return }
    await sleep(900)
    const card = await ev(`(() => { const c = document.querySelector('[data-testid="v3-approval"], .v3-approval, [data-approval]'); return c ? { html: c.outerHTML.slice(0, 600), role: c.getAttribute('role'), label: c.getAttribute('aria-label') } : null })()`)
    report.sections['审批卡:card'] = card
    const focus1 = await active()
    log('审批到达后焦点', focus1)
    report.sections['审批卡:focusOnArrival'] = focus1
    const live = await liveSince(t0)
    log('审批到达 live 播报', live)
    const announced = live.some((l) => /审批|批准|确认|approve|approval|权限/i.test(l.text))
    if (!announced) note('审批卡', '审批请求到达时没有 live region 播报', live.slice(0, 5))
    const reach = await tabWalk('审批卡:可达性', 70, { scopeSel: '[data-ask-dock]' })
    const reached = reach.seq.some((d) => /v3-approval/.test(d.id) || /批准|允许|拒绝|Approve|Deny|Allow/i.test(d.label))
    log('审批卡能否被 Tab 到', reached)
    if (!reached) note('审批卡', 'Tab 70 次内没有走到审批卡的按钮（设计上不抢焦点，但必须能用键盘到达）', reach.keys.slice(-8))
    const nodes = await axTree()
    report.sections['审批卡:ax'] = nodes.filter((n) => /批准|拒绝|允许|审批|approve|deny/i.test(n.name)).map((n) => `${n.role}:${n.name}`)
    await shot('a11y-approval')
    await tabWalk('审批卡', 12)
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    await autoApprove()
    await ev(`(() => { const st = window.__yanStore.getState(); const list = Array.isArray(st.approvals) ? st.approvals : Object.values(st.approvals ?? {}); for (const a of list) void st.answerApproval(a.id, 'session') })()`)
    await waitFor(`!(${running})`, 60000, 100)
    await sleep(800)
    const receipt = await ev(`(() => { const r = document.querySelector('[data-testid*="receipt"], .v3-approval-receipt'); return r ? { role: r.getAttribute('role'), text: r.textContent.slice(0, 80) } : null })()`)
    report.sections['审批卡:receipt'] = receipt
    const after = await active()
    log('审批回执后焦点', after, '回执', receipt)
    if (after.tag === 'body') note('审批卡', '审批处理后焦点丢到 body', after)
    const live2 = await liveSince(t0)
    if (!live2.some((l) => /已批准|已拒绝|已处理|批准|approved|denied|handled/i.test(l.text))) note('审批卡', '审批处理结果没有 live region 播报', null)
  })

  await phase('提问停靠区', async () => {
    await newSession(box.projects[0] ?? box.project)
    const t0 = await nowT()
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    await send('QUESTION 选一个')
    await waitFor(`!!document.querySelector('[data-ask-dock]')`, 30000, 50)
    await sleep(700)
    const f = await active()
    report.sections['提问:focusOnArrival'] = f
    log('AskDock 出现后焦点', f)
    if (!(await activeInside('[data-ask-dock]'))) note('提问停靠区', '提问出现后焦点不在停靠区内', f)
    const live = await liveSince(t0)
    if (!live.some((l) => /提问|问题|选|question|ask/i.test(l.text))) note('提问停靠区', '提问到达时没有 live region 播报', live.slice(0, 5))
    const nodes = await axTree()
    const dockNodes = []
    for (const n of nodes) if (['radio', 'checkbox', 'option', 'radiogroup', 'listbox', 'group', 'form', 'dialog', 'region', 'button'].includes(n.role) && n.backendDOMNodeId) {
      const html = await outerOf(n.backendDOMNodeId)
      if (html && /ask-dock|qoption|v3-question/.test(html)) dockNodes.push(`${n.role}:${n.name}`)
    }
    report.sections['提问:ax'] = dockNodes
    log('提问 AX', dockNodes)
    await shot('a11y-askdock')
    await tabWalk('提问停靠区', 10)
    await ev(`document.querySelector('[data-ask-dock] [tabindex], [data-ask-dock] button, [data-ask-dock] input')?.focus()`)
    await press('ArrowDown')
    const afterArrow = await active()
    log('提问内 ArrowDown 后焦点', afterArrow)
    await press('Escape', 0, 500)
    const stillThere = await ev(`!!document.querySelector('[data-ask-dock]')`)
    const f2 = await active()
    log('Esc 后：停靠区仍在', stillThere, '焦点', f2)
    report.sections['提问:esc'] = { stillThere, focus: f2 }
    if (stillThere) {
      await clickEl('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption')
      await sleep(1200)
    }
    const f3 = await active()
    log('作答后焦点', f3)
    if (f3.tag === 'body') note('提问停靠区', '作答后焦点丢到 body（动画收起期间或之后）', f3)
    const live2 = await liveSince(t0)
    report.sections['提问:live'] = live2.slice(0, 10)
    await waitFor(`!(${running})`, 60000, 100).catch(() => {})
  })

  await phase('命令面板/设置/快捷键面板', async () => {
    await newSession(box.projects[0] ?? box.project)
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    for (const [name, key, mods, close] of [['命令面板', 'k', MOD.ctrl, 'Escape'], ['设置', ',', MOD.ctrl, 'Escape'], ['快捷键面板', '/', MOD.ctrl, 'Escape']]) {
      const before = await active()
      await press(key, mods, 600)
      const opened = await ev(`(() => { const d = document.querySelector('[role=dialog],[role=alertdialog],[data-command-surface],[cmdk-root]'); return d ? { role: d.getAttribute('role'), label: d.getAttribute('aria-label') || d.getAttribute('aria-labelledby'), modal: d.getAttribute('aria-modal') } : null })()`)
      const f = await active()
      log(name, '打开', opened, '焦点', f)
      report.sections[name] = { opened, focus: f }
      if (!opened) note(name, '打开后找不到 dialog 角色容器', f)
      if (opened && !(await activeInside('[role=dialog],[role=alertdialog],[data-command-surface],[cmdk-root]'))) note(name, '打开后焦点不在对话框内', f)
      const walked = await tabWalk(name, 24, { scopeSel: '[role=dialog],[role=alertdialog],[data-command-surface],[cmdk-root]' })
      if (opened && walked.inside === false) note(name, 'Tab 24 次后焦点已跑出对话框（无焦点陷阱）', walked.seq.at(-1))
      const dlg = (await axTree()).filter((n) => n.role === 'dialog').map((n) => n.name)
      report.sections[name + ':dialogNames'] = dlg
      if (dlg.some((n) => !n || /^react-aria/.test(n))) note(name, 'dialog 的 AX 名称为空或是自动 id', dlg)
      await axAudit(name)
      await press(close, 0, 700)
      const gone = await ev(`!document.querySelector('[role=dialog],[role=alertdialog],[data-command-surface],[cmdk-root]')`)
      const f2 = await active()
      log(name, 'Esc 后对话框已关', gone, '焦点', f2, '打开前', before)
      if (!gone) note(name, 'Esc 关不掉', f2)
      if (gone && f2.tag === 'body') note(name, '关闭后焦点丢到 body，未回到触发处', { before, after: f2 })
      else if (gone && before.tag !== 'body' && `${f2.id}|${f2.label}` !== `${before.id}|${before.label}`) note(name, '关闭后焦点没回到打开前的元素', { before, after: f2 })
    }
  })

  await phase('设置页导航', async () => {
    await press(',', MOD.ctrl, 700)
    const pages = await ev(`[...document.querySelectorAll('[role=dialog] [role=tab],[role=dialog] [role=tablist] button,[role=dialog] nav button,[role=dialog] nav a')].map((e) => ({ role: e.getAttribute('role'), sel: e.getAttribute('aria-selected') ?? e.getAttribute('aria-current'), label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 20) }))`)
    report.sections['设置:nav'] = pages
    log('设置导航项', pages.length, pages.slice(0, 4))
    if (!pages.length) note('设置', '找不到设置导航项（tab/nav 按钮）', null)
    else if (!pages.some((p) => p.sel === 'true' || p.sel === 'page')) note('设置', '设置导航没有 aria-selected/aria-current 标出当前页', pages.slice(0, 3))
    await axAudit('设置')
    await press('Escape', 0, 600)
  })

  await phase('右栏面板与标签', async () => {
    await newSession(box.projects[0] ?? box.project)
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    const panelOpen = async () => ev(`!!document.querySelector('[role=tab]')`)
    await press('b', MOD.ctrl | MOD.alt, 1800)
    await press('1', MOD.alt, 900)
    if (!(await panelOpen())) { await clickEl('[data-testid="v3-head-panel-toggle"]'); await sleep(1800) }
    if (!(await panelOpen())) note('右栏', '快捷键与 setRightPanelOpen 都没能打开右栏（场景无法继续检查标签）', null)
    const tabs = async () => ev(`[...document.querySelectorAll('[role=tab]')].map((e) => ({ label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24), sel: e.getAttribute('aria-selected'), tab: e.tabIndex, panel: e.getAttribute('aria-controls'), has: !!(e.getAttribute('aria-controls') && document.getElementById(e.getAttribute('aria-controls'))) }))`)
    const t1 = await tabs()
    report.sections['右栏:tabs'] = t1
    log('右栏 tab', t1)
    await shot('a11y-workspace')
    if (!t1.length) note('右栏', '打开右栏后没有 role=tab 元素', await ev(`document.querySelector('[class*=workspace],[data-testid*=workspace]')?.outerHTML.slice(0, 300)`))
    else {
      if (t1.filter((t) => t.tab === 0).length > 1) note('右栏', '多个 tab 的 tabIndex 都为 0（应只有选中项在 Tab 序列，其余用方向键）', t1)
      if (t1.some((t) => t.sel === null)) note('右栏', 'tab 缺 aria-selected', t1)
      if (t1.some((t) => !t.has)) note('右栏', 'tab 的 aria-controls 没指向存在的 tabpanel', t1.filter((t) => !t.has))
    }
    for (const [k, label] of [['2', 'Alt+2'], ['1', 'Alt+1']]) {
      await press(k, MOD.alt, 700)
      const f = await active()
      log(label, '后焦点', f, 'selected', (await tabs()).filter((t) => t.sel === 'true').map((t) => t.label))
    }
    await ev(`document.querySelector('[role=tab][aria-selected=true]')?.focus()`)
    const f0 = await active()
    await press('ArrowRight', 0, 400)
    const f1 = await active()
    log('tab 上 ArrowRight', f0.label, '->', f1.label)
    if (f0.id === f1.id && f0.label === f1.label) note('右栏', 'tab 上方向键不切换（无 roving tabindex 方向键支持）', f0)
    await tabWalk('右栏', 25)
    await axAudit('右栏')
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    const before = await active()
    await press('\\', MOD.ctrl, 700)
    const afterClose = await active()
    log('Ctrl+\\ 关闭面板后焦点', afterClose, '此前', before)
    if (afterClose.tag === 'body') note('右栏', '关闭面板后焦点丢到 body', { before, afterClose })
    await press('b', MOD.ctrl | MOD.alt, 700)
  })

  await phase('Ctrl+Tab 会话切换', async () => {
    const mk = async (text) => {
      await newSession(box.projects[0] ?? box.project)
      await send(text)
      await waitFor(`!(${running}) && s.messages.length >= 2`, 30000, 50)
    }
    await mk('第一个')
    await mk('第二个')
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    const t0 = await nowT()
    const s0 = await state('s.session?.sessionFile')
    await cc('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: MOD.ctrl })
    await press('Tab', MOD.ctrl, 500)
    report.sections['Ctrl+Tab:switcher'] = await ev(`(() => { const l = document.querySelector('[data-testid=session-switcher] [role=listbox]'); const a = document.activeElement; return l ? { label: l.getAttribute('aria-label'), activedescendant: l.getAttribute('aria-activedescendant') || a?.getAttribute('aria-activedescendant'), selected: [...l.querySelectorAll('[role=option]')].map((o) => o.getAttribute('aria-selected') + ':' + o.textContent.slice(0, 20)), focusIn: !!a?.closest('[data-testid=session-switcher]'), live: !!l.closest('[aria-live],[role=status]') } : null })()`)
    log('会话切换面板', report.sections['Ctrl+Tab:switcher'])
    const sw = report.sections['Ctrl+Tab:switcher']
    if (!sw) note('Ctrl+Tab', '按住 Ctrl 再按 Tab 没有弹出会话切换面板', null)
    else if (!sw.activedescendant && !sw.focusIn && !sw.live && !(await liveSince(t0)).some((l) => /[0-9]+[/][0-9]+/.test(l.text))) note('Ctrl+Tab', '会话切换面板的当前选中项读屏不可知（焦点不在面板内、无 aria-activedescendant、非 live）', sw)
    await cc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
    await sleep(700)
    const s1 = await state('s.session?.sessionFile')
    const f = await active()
    log('Ctrl+Tab 切会话', s0 !== s1, '焦点', f)
    if (s0 === s1) note('Ctrl+Tab', '切换没有发生', null)
    if (f.tag === 'body') note('Ctrl+Tab', '切换后焦点丢到 body', f)
    const live = await liveSince(t0)
    if (!live.some((l) => l.text.includes('已切换') || /[0-9]+[/][0-9]+/.test(l.text))) note('Ctrl+Tab', '切换会话后没有 live region 播报新会话', live)
    report.sections['Ctrl+Tab'] = { switched: s0 !== s1, focus: f, live }
  })

  await phase('消息流与查找', async () => {
    await newSession(box.projects[0] ?? box.project)
    await send('STORM-a11y STEPS24')
    await waitFor(running, 15000, 30)
    await waitFor(`!(${running})`, 180000, 200)
    await sleep(1200)
    const SC = `(() => { for (let n = document.querySelector('article'); n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n; return null })()`
    await ev(`(() => { const sc = ${SC}; sc && (sc.scrollTop = 0) })()`)
    await sleep(900)
    const target = await ev(`(() => { const sc = ${SC}; const b = sc?.querySelector('article button, article a[href], article [tabindex="0"]'); if (!b) return null; b.focus({ preventScroll: true }); return { tag: b.tagName, label: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20) } })()`)
    const focusBefore = await active()
    await ev(`(() => { const sc = ${SC}; sc && (sc.scrollTop = sc.scrollHeight) })()`)
    await sleep(1200)
    const focusAfter = await active()
    report.sections['消息流:滚动焦点'] = { target, focusBefore, focusAfter }
    if (!target) note('消息流', '找不到消息行内的可聚焦控件，无法测滚动后焦点', null)
    else if (focusBefore.tag === 'body') note('消息流', '消息行内控件 focus() 失败', target)
    log('滚动后焦点', focusAfter, '滚动前', focusBefore)
    if (focusAfter.tag === 'body' && focusBefore.tag !== 'body') note('消息流', '滚动到远处后（行被卸载）焦点丢到 body', { focusBefore, focusAfter })
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    const t0 = await nowT()
    await press('f', MOD.ctrl, 700)
    const find = await ev(`(() => { const f = document.querySelector('[data-testid="v3-session-find"], .v3-session-find, [role=search]'); const a = document.activeElement; return { bar: !!f, role: f?.getAttribute('role'), label: f?.getAttribute('aria-label'), inBar: !!a?.closest('[data-testid="v3-session-find"], .v3-session-find, [role=search]'), tag: a?.tagName } })()`)
    log('Ctrl+F 查找栏', find)
    report.sections['查找:open'] = find
    if (!find.bar) note('查找', 'Ctrl+F 没有打开查找栏', find)
    else {
      if (!find.inBar) note('查找', '打开查找栏后焦点不在栏内', find)
      if (!find.label) note('查找', '查找栏没有 role=search/aria-label', find)
      await ev(`window.__yanTyping = true`)
      await cc('Input.insertText', { text: '第' })
      await sleep(700)
      const count = await ev(`(() => { const e = [...document.querySelectorAll('[role=search] *, .v3-session-find *')].find((x) => /\\d+\\s*\\/\\s*\\d+|无结果|0/.test(x.textContent) && x.children.length === 0); return e ? { text: e.textContent, live: e.getAttribute('aria-live') || e.closest('[aria-live],[role=status]')?.getAttribute('aria-live') || e.closest('[role=status]')?.getAttribute('role') } : null })()`)
      log('查找计数', count)
      report.sections['查找:count'] = count
      if (!count || !count.live) note('查找', '查找结果计数不是 live region，读屏不播报命中数', count)
      await press('Enter', 0, 500)
      await press('Escape', 0, 600)
      const f = await active()
      log('Esc 关闭查找后焦点', f)
      if (f.tag === 'body') note('查找', '关闭查找栏后焦点丢到 body', f)
    }
    const live = await liveSince(t0)
    report.sections['查找:live'] = live.slice(0, 6)
  })

  await phase('分屏', async () => {
    const start = async (text) => {
      await newSession(box.projects[0] ?? box.project)
      await send(text)
      await sleep(600); await waitFor(`!!s.session?.sessionFile && !!s.session?.sessionId && !${running} && s.messages.length >= 2`, 90000, 100)
      return { sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') }
    }
    const tiles = []
    for (let i = 0; i < 3; i++) tiles.push(await start(i === 0 ? 'MDREAL 总结一下' : `分屏会话 ${i + 1}`))
    await cc('Emulation.setDeviceMetricsOverride', { width: 1400, height: 260, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(tiles)}, live: 0 })`)
    await sleep(1500)
    await shot('a11y-split')
    const panes = await ev(`[...document.querySelectorAll('[data-pane]')].map((p) => ({ role: p.getAttribute('role'), label: p.getAttribute('aria-label') || p.getAttribute('aria-labelledby'), tabindex: p.getAttribute('tabindex'), current: p.getAttribute('aria-current'), live: p.getAttribute('data-live'), cls: p.className.toString().slice(0, 40) }))`)
    report.sections['分屏:panes'] = panes
    log('分屏格', panes)
    if (panes.some((p) => !p.label)) note('分屏', '分屏格没有 aria-label，读屏无法区分是哪个会话', panes)
    await axAudit('分屏')
    await ev(`document.activeElement?.blur?.()`)
    const ro = await ev(`(() => { const panes = [...document.querySelectorAll('[data-pane]')]; const pane = panes.find((p) => !p.querySelector('[data-testid="composer-input"]')); if (!pane) return null; const sc = [...pane.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (!sc) return { pane: true, scroller: false }; const f = sc.querySelector('button,a[href],[tabindex]:not([tabindex="-1"])'); f?.focus(); sc.scrollTop = 0; return { pane: true, scroller: true, focusable: !!f, tabindex: sc.tabIndex, focused: document.activeElement === f } })()`)
    if (ro?.scroller) {
      await press('PageDown', 0, 500)
      const top = await ev(`(() => { const pane = [...document.querySelectorAll('[data-pane]')].find((p) => !p.querySelector('[data-testid="composer-input"]')); const sc = [...pane.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY)); return sc.scrollTop })()`)
      log('只读格 PageDown 后 scrollTop', top, ro)
      report.sections['分屏:只读格滚动'] = { ro, top }
      if (!(top > 0)) note('分屏', '只读格里聚焦其中控件后 PageDown 无法用键盘滚动该格消息', ro)
    } else log('只读格无可滚动内容或不存在', ro, await ev(`(() => { const pane = [...document.querySelectorAll('[data-pane]')].find((p) => !p.querySelector('[data-testid="composer-input"]')); return pane ? [...pane.querySelectorAll('*')].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => (e.className.toString().slice(0, 40)) + ':' + e.scrollHeight + '/' + e.clientHeight + ':tab' + e.tabIndex) : null })()`))
    await ev(`document.activeElement?.blur?.()`)
    await tabWalk('分屏', 90)
    const readonlyReach = await ev(`[...document.querySelectorAll('[data-pane]')].map((p) => ({ focusables: p.querySelectorAll('a[href],button:not([disabled]),input,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=true]').length, scroller: [...p.querySelectorAll('*')].some((e) => (e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) && (e.tabIndex >= 0)) }))`)
    report.sections['分屏:reach'] = readonlyReach
    log('每格可聚焦数/可聚焦滚动区', readonlyReach)
    const readonly = await ev(`[...document.querySelectorAll('[data-pane]')].map((p, i) => [i, p.querySelector('[data-testid="composer-input"]') ? 'composer' : 'readonly', !!p.querySelector('[data-pane-readonly],[data-readonly]')])`)
    log('分屏格类型', readonly)
    for (const [k, mods, label] of [[']', MOD.ctrl | MOD.alt, 'Ctrl+Alt+]'], ['[', MOD.ctrl | MOD.alt, 'Ctrl+Alt+['], ['ArrowLeft', MOD.ctrl | MOD.alt, 'Ctrl+Alt+←']]) {
      const before = await ev(`(document.querySelector('[data-pane][data-live="true"]') ?? document.activeElement?.closest('[data-pane]'))?.getAttribute('data-pane')`)
      const t0 = await nowT()
      await press(k, mods, 700)
      const f = await active()
      const inPane = await ev(`document.activeElement?.closest('[data-pane]')?.getAttribute('data-pane')`)
      const live = await liveSince(t0)
      log(label, '焦点', f, '所在格', inPane, '此前', before, 'live', live.length)
      if (f.tag === 'body') note('分屏', `${label} 后焦点丢到 body`, f)
      if (!live.length) note('分屏', `${label} 切换活动格后没有 live region 播报`, null)
    }
    await cc('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(1200)
    await shot('a11y-split-narrow')
    const pager = await ev(`(() => { const e = [...document.querySelectorAll('button,[role=button]')].filter((b) => /‹|›|‹|›|‹|›/.test(b.textContent) || /上一|下一|prev|next/i.test(b.getAttribute('aria-label') || '')); return e.map((b) => ({ text: b.textContent.trim().slice(0, 12), label: b.getAttribute('aria-label'), tab: b.tabIndex })) })()`)
    const pageText = await ev(`[...document.querySelectorAll('[data-testid*="pager"],[class*="pager"],[class*="tile-switch"]')].map((e) => ({ cls: e.className.toString().slice(0, 40), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: e.textContent.trim().slice(0, 30), live: e.getAttribute('aria-live') }))`)
    report.sections['分屏:窄屏'] = { pager, pageText }
    log('窄屏分页', pager, pageText)
    if (!pager.length) note('分屏窄屏', '窄屏下找不到 ‹ n/m › 翻页按钮', pageText)
    else if (pager.some((p) => !p.label)) note('分屏窄屏', '翻页按钮没有 aria-label（读屏只读到符号）', pager)
    await tabWalk('分屏窄屏', 40)
    await axAudit('分屏窄屏')
    if (pager.length) {
      const t0 = await nowT()
      await ev(`(() => { document.querySelector('button[aria-label="下一个会话"]')?.focus() })()`)
      const p0 = await ev(`document.querySelector('[data-pane]')?.getAttribute('data-pane')`)
      await press('Enter', 0, 800)
      const f = await active()
      const p1 = await ev(`document.querySelector('[data-pane]')?.getAttribute('data-pane')`)
      const live = await liveSince(t0)
      log('翻页后', { switched: p0 !== p1, focus: f, live })
      if (f.tag === 'body') note('分屏窄屏', '翻页后焦点丢到 body', f)
      if (!live.length) note('分屏窄屏', '翻页后当前页码/会话没有 live region 播报', null)
    }
    await cc('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanSplit.getState().apply({ tiles: [], live: 0 })`).catch(() => {})
    await sleep(600)
  })

  await cc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(300)
  report.reducedMotion = await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  await mainChecks(' [减少动效]')
  await phase('提问停靠区 [减少动效]', async () => {
    await newSession(box.projects[0] ?? box.project)
    await ev(`document.querySelector('[data-testid="composer-input"]')?.focus()`)
    await send('QUESTION 选一个')
    await waitFor(`!!document.querySelector('[data-ask-dock]')`, 30000, 50)
    await sleep(500)
    const f = await active()
    if (!(await activeInside('[data-ask-dock]'))) note('提问停靠区 [减少动效]', '提问出现后焦点不在停靠区内', f)
    await clickEl('[data-testid="v3-question"] .v3-qoption-row, [data-testid="v3-question"] .v3-qoption')
    await sleep(500)
    const f3 = await active()
    log('减少动效：作答后焦点', f3)
    if (f3.tag === 'body') note('提问停靠区 [减少动效]', '作答后焦点丢到 body', f3)
    const anims = await ev(`document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a.effect?.target?.className || '').toString().slice(0, 40) + ':' + (a.animationName || a.transitionProperty || ''))`)
    report.sections['减少动效:运行中动画'] = anims
    if (anims.length > 6) note('减少动效', '减少动效下仍有较多运行中动画', anims.slice(0, 12))
    await waitFor(`!(${running})`, 60000, 100).catch(() => {})
  })
  await cc('Emulation.setEmulatedMedia', { features: [] })

  check('可访问性审计无发现项', findings.length === 0, findings.map((f) => f.area + '：' + f.problem))
  log('发现项合计', findings.length)
  for (const f of findings) log(' -', f.area, '|', f.problem)
}
