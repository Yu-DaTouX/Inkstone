;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const st = () => window.__yanStore.getState()

  const describe = (el) => {
    if (!el) return 'null'
    const id = el.dataset?.testid ?? ''
    const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.')
    return `<${el.tagName.toLowerCase()}${id ? ' ' + id : ''}${cls ? ' .' + cls : ''}>`
  }
  const center = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  const realClickAt = (x, y) => {
    const hit = document.elementFromPoint(x, y)
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
    hit?.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit?.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    hit?.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit?.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    hit?.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
    return hit
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else break
  }
  for (let i = 0; i < 40; i++) {
    if (st().conn === 'ready' && st().settings) break
    await sleep(500)
  }
  store.getState().setRailPinned(true)
  await sleep(500)

  const now = Date.now()
  const proj = 'C:/probe/menuclick-project'
  const seed = () => {
    store.setState({
      sessions: [
        { id: 'mc1', path: 'C:/probe/mc1.jsonl', cwd: proj, title: '点击甲', createdAt: now - 5000, updatedAt: now, messageCount: 3 },
        { id: 'mc2', path: 'C:/probe/mc2.jsonl', cwd: proj, title: '点击乙', createdAt: now - 9000, updatedAt: now - 1000, messageCount: 2 }
      ],
      session: { ...(store.getState().session ?? {}), sessionId: 'mc1', sessionFile: 'C:/probe/mc1.jsonl', cwd: proj }
    })
  }
  const rowOf = (path) => q(`.srow-wrap[data-session-path="${path}"]`)

  const renameTrace = async (via) => {
    seed()
    await sleep(500)
    const stale = q('[data-testid="rail-rename-input"]')
    if (stale) {
      stale.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(250)
    }

    const row = rowOf('C:/probe/mc1.jsonl')
    if (!row) {
      ok(false, `${via}：拿到会话行`)
      return
    }
    const rr = row.getBoundingClientRect()
    ok(rr.width > 0 && rr.height > 0, `${via}：会话行可见（不是收起/隐藏态）`)

    if (via === '右键') {
      const body = row.querySelector('.srow-row') ?? row
      body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 200 }))
    } else {
      click(row.querySelector('.srow-acts button'))
    }
    await sleep(250)

    ok(!!q('[data-testid="rail-session-menu"]'), `${via}：打开会话菜单`)
    const btn = q('[data-testid="rail-rename"]')
    ok(!!btn, `${via}：菜单里有「重命名」`)
    if (!btn) return
    const { x, y } = center(btn)
    const hit = document.elementFromPoint(x, y)
    ok(hit === btn || btn.contains(hit), `${via}：菜单项中心无遮挡（elementFromPoint → ${describe(hit)}）`)
    realClickAt(x, y)
    await sleep(400)
    const input = q('[data-testid="rail-rename-input"]')
    ok(!!input, `${via}：真实指针序列后输入框挂载`)
    if (input) ok(document.activeElement === input, `${via}：输入框持有焦点（实际 ${describe(document.activeElement)}）`)
  }

  out.push('=== 1. 重命名（真实指针序列）===')
  await renameTrace('⋯')
  out.push('')
  await renameTrace('右键')

  out.push('')
  out.push('=== 2. 删除（真实指针序列）===')
  {
    seed()
    await sleep(500)
    const row = rowOf('C:/probe/mc2.jsonl')
    ok(!!row, '拿到非当前会话的行')
    if (row) {
      click(row.querySelector('.srow-acts button'))
      await sleep(250)
      const btn = qa('[data-testid="rail-session-menu"] [role="menuitem"]').find((b) => /删除|delete/i.test(b.textContent || ''))
      ok(!!btn && !btn.disabled, '菜单里的「删除」可用（不是当前会话）')
      if (btn) {
        const { x, y } = center(btn)
        const hit = document.elementFromPoint(x, y)
        ok(hit === btn || btn.contains(hit), `菜单项中心无遮挡（elementFromPoint → ${describe(hit)}）`)
        realClickAt(x, y)
        await sleep(400)
        const dialog = q('.rail-delete-dialog')
        ok(!!dialog, '真实指针序列后删除确认框出现')
        if (dialog) {
          ok(document.activeElement === dialog.querySelector('.modal-input'), '确认框输入框持有焦点（可以直接打标题）')
        }
      }
    }
  }

  return out.join('\n')
})()
