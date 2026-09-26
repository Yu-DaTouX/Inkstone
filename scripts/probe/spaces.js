/**
 * 主题空间（实施-25 P02）—— 真实窗口里的「建空间 → 会话归属 → 归档」链路。
 *
 * 为什么需要：单测能证明存储、多对多关联与「重启后仍在」，但证明不了
 * 「左栏点得到、建完立刻出现、归属真的写进 session-layout」。
 * 本场景走 UI → IPC → store → 落盘（cost 0，不发模型请求）。
 *
 * 落盘本身的持久性由 `scripts/test-space.mjs`（重新实例化 store）钉住；
 * 这里钉的是入口、界面反馈与两个维度互不吞并。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  const click = (el) =>
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const S = () => store.getState()

  /** React 受控输入：必须走原生 setter + input 事件，直接改 value 不会触发 onChange */
  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pressEnter = (el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  }
  /** 按可见文本点菜单项（ContextMenu 的项是按钮，没有逐项 testid） */
  const clickMenuItem = (text) => {
    const item = all('[role="menuitem"]').find((x) => (x.textContent ?? '').includes(text))
    click(item)
    return !!item
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(500)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 24; i++) {
    if (S().conn === 'ready') break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const NAME = `探针空间-${Date.now().toString(36).slice(-4)}`

  log('=== 1. 左栏空间区入口 ===')
  ok(!!q('[data-testid="rail-spaces"]'), '空间区在左栏')
  if (!q('[data-testid="rail-add-space"]')) return '✗ 找不到「新建空间」按钮'

  log('=== 2. 建空间：输入 → Enter → 立刻出现在列表 ===')
  click(q('[data-testid="rail-add-space"]'))
  await sleep(250)
  const input = q('[data-testid="rail-new-space-input"]')
  if (!input) return '✗ 点 + 之后没有出现名字输入框'
  setInput(input, NAME)
  await sleep(120)
  pressEnter(input)
  await sleep(600)
  const rows = all('[data-testid="rail-space-row"]')
  const row = rows.find((r) => (r.textContent ?? '').includes(NAME))
  ok(!!row, '新空间出现在左栏', NAME)
  if (!row) return out.join('\n')
  const spaceId = row.getAttribute('data-space-id') ?? ''
  ok(!!spaceId, '空间行带稳定 id', spaceId)

  const viaIpc = await window.yan.getSpaces()
  const stored = viaIpc.spaces.find((s) => s.id === spaceId)
  ok(!!stored && stored.name === NAME, 'IPC 回读一致（提交真的走了主进程存储）')
  ok(stored?.archived === false, '新空间默认未归档')

  log('=== 3. 把当前会话放进空间（右键菜单）===')
  /* 先刷新一次：探针环境起来时列表可能还是旧的（新会话刚建、还没被收录） */
  await S().refreshSessions()
  const norm = (v) => (v ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  let currentFile = S().session?.sessionFile
  const inList = () => S().sessions.some((s) => norm(s.path) === norm(currentFile))
  if (!currentFile || !inList()) {
    log(`  当前会话不在列表里（${currentFile ?? '(无)'}）→ 切到列表第一条`)
    const first = S().sessions[0]
    if (first) {
      await S().switchSession(first.path)
      await sleep(900)
      currentFile = S().session?.sessionFile ?? first.path
    }
  }
  log(`  当前会话：${currentFile ?? '(无)'} / 列表 ${S().sessions.length} 条`)
  if (!currentFile) return out.join('\n') + '\n✗ 没有可归属的会话'
  click(q('[data-testid="rail-spaces-head"]'))
  await sleep(400)
  click(q('[data-testid="rail-spaces-head"]'))
  await sleep(300)
  const target = all('[data-testid="rail-space-row"]').find((r) =>
    (r.textContent ?? '').includes(NAME)
  )
  target?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 240 })
  )
  await sleep(300)
  ok(!!q('[data-testid="rail-space-menu"]'), '空间右键菜单能打开')
  const adoptItem = all('[role="menuitem"]').find((x) =>
    (x.textContent ?? '').includes('把当前会话放进来')
  )
  ok(
    !!adoptItem && !adoptItem.disabled && adoptItem.getAttribute('aria-disabled') !== 'true',
    '「把当前会话放进来」可用（当前会话在列表里认得出）'
  )
  click(adoptItem)
  await sleep(700)

  await S().refreshSessions()
  const current = S().sessions.find((s) => s.path === currentFile)
  ok(current?.spaceId === spaceId, '会话归属写进了 session-layout', String(current?.spaceId))
  /* 与项目归属是两个独立维度：移动空间不能把 projectId 冲成空 */
  ok(
    current ? current.projectId !== undefined || current.scope === 'global' : false,
    '项目归属没有被空间归属改动吞掉（独立维度）',
    `projectId=${String(current?.projectId)} scope=${String(current?.scope)}`
  )

  log('=== 4. 展开空间树：会话在空间下 ===')
  const rowAfter = all('[data-testid="rail-space-row"]').find((r) =>
    (r.textContent ?? '').includes(NAME)
  )
  click(rowAfter?.querySelector('[data-testid="rail-space-fold"]'))
  await sleep(400)
  const tree = q('[data-testid="rail-space-tree"]')
  ok(!!tree, '空间树能展开')
  ok(
    !!tree && tree.querySelectorAll('.srow-wrap').length > 0,
    '树里能看到会话行'
  )
  const countText = q('[data-testid="rail-space-count"]')?.textContent?.trim() ?? ''
  ok(countText === '1', '空间行显示会话数 1', countText)

  log('=== 5. 归档空间：从列表消失，但不物理删除 ===')
  const rowForMenu = all('[data-testid="rail-space-row"]').find((r) =>
    (r.textContent ?? '').includes(NAME)
  )
  click(rowForMenu?.querySelector('[data-testid="rail-space-menu-btn"]'))
  await sleep(300)
  ok(clickMenuItem('归档空间'), '菜单里有「归档空间」')
  await sleep(700)
  ok(
    !all('[data-testid="rail-space-row"]').some((r) => (r.textContent ?? '').includes(NAME)),
    '归档后不在活动列表里'
  )
  const afterArchive = await window.yan.getSpaces()
  ok(
    afterArchive.spaces.some((s) => s.id === spaceId && s.archived === true),
    '归档空间仍能从存储读到（归档 ≠ 删除）'
  )

  return out.join('\n')
})()
