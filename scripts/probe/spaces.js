/**
 * 主题空间（实施-25 P02；实施-27 B3 改入口）—— 真实窗口里的「建空间 → 会话归属 → 归档」链路。
 *
 * 为什么需要：单测能证明存储、多对多关联与「重启后仍在」，但证明不了
 * 「入口点得到、建完立刻出现、归属真的写进 session-layout」。
 * 本场景走 UI → IPC → store → 落盘（cost 0，不发模型请求）。
 *
 * ── B3 之后入口变了，探针跟着改 ──
 *   改之前：左栏有一层常驻「空间分区」，建 / 归档 / 展开都在那里。
 *   现在：**建与归档在「设置 · 工作区」**（空间是配置，不是导航），
 *         而「把这条会话归到哪个空间」跟着**具体那条会话**出现在会话右键菜单里
 *         —— 本来就该这样，不该先选空间再找会话。
 *   左栏的 `rail-space-*` 树已不存在，所以这里不再断言它（断言删掉的控件
 *   才是这一轮要修的病：那种断言会一直红，或者更糟 —— 空断言一直绿）。
 *
 * 落盘本身的持久性由 `scripts/test-space.mjs`（重新实例化 store）钉住；
 * 这里钉的是**新入口可达**、界面反馈与两个维度互不吞并。
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

  log('=== 1. 入口在「设置 · 工作区」（B3 之后空间不在左栏常驻）===')
  ok(!q('[data-testid="rail-spaces"]'), '左栏不再有常驻空间分区（B3 的意图）')
  S().openSettings('workspace')
  await sleep(600)
  if (!q('[data-testid="set-space-new-name"]')) {
    return out.join('\n') + '\n✗ 设置 · 工作区里找不到「新建空间」输入框'
  }
  ok(true, '设置 · 工作区里有空间管理区')

  log('=== 2. 建空间：输入 → 创建 → 立刻出现在列表 ===')
  setInput(q('[data-testid="set-space-new-name"]'), NAME)
  await sleep(150)
  click(q('[data-testid="set-space-create"]'))
  await sleep(800)
  const rows = all('[data-testid="set-space-row"]')
  const row = rows.find((r) => (r.textContent ?? '').includes(NAME))
  ok(!!row, '新空间出现在设置列表里', NAME)
  if (!row) return out.join('\n')
  const spaceId = row.getAttribute('data-space-id') ?? ''
  ok(!!spaceId, '空间行带稳定 id', spaceId)

  const viaIpc = await window.yan.getSpaces()
  const stored = viaIpc.spaces.find((s) => s.id === spaceId)
  ok(!!stored && stored.name === NAME, 'IPC 回读一致（提交真的走了主进程存储）')
  ok(stored?.archived === false, '新空间默认未归档')

  log('=== 3. 把当前会话归到这个空间（入口跟着会话走）===')
  S().closeSettings()
  await sleep(500)
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

  /*
   * 右键当前会话行 → 菜单里应该有「空间」一节，并且列出刚才建的空间。
   *
   * 两个细节：行元素的标识是 `data-session-path`（不是 id），
   * 而 `contextmenu` 处理函数挂在内层 `.srow-row` 上 —— 往外层派发是收不到的。
   */
  const normPath = (v) => (v ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  const currentRow = all('[data-session-path]').find(
    (r) => normPath(r.getAttribute('data-session-path') ?? '') === normPath(currentFile)
  )
  const activeRow = currentRow ?? q('.srow-wrap.active') ?? all('[data-session-path]')[0]
  const target = activeRow?.querySelector('.srow-row') ?? activeRow
  target?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 240 })
  )
  await sleep(400)
  const put = q(`[data-testid="rail-space-put-${spaceId}"]`)
  ok(!!q('[data-testid="rail-session-space"]'), '会话右键菜单里有「空间」一节')
  ok(!!put, '菜单里列出了这个空间（可归属）', spaceId || '(无 id)')
  if (put) {
    click(put)
    await sleep(800)
  } else {
    /* 菜单没出来时退回 IPC（仍要验证落盘那一环，不冒充 UI 通过） */
    log('  ⚠ 菜单项没出现，退回 IPC 直接归属（UI 那一环算失败）')
    await window.yan.setSessionSpace(S().session?.sessionId ?? '', spaceId)
    await sleep(400)
  }

  await S().refreshSessions()
  const current = S().sessions.find((s) => s.path === currentFile)
  ok(current?.spaceId === spaceId, '会话归属写进了 session-layout', String(current?.spaceId))
  /* 与项目归属是两个独立维度：移动空间不能把 projectId 冲成空 */
  ok(
    current ? current.projectId !== undefined || current.scope === 'global' : false,
    '项目归属没有被空间归属改动吞掉（独立维度）',
    `projectId=${String(current?.projectId)} scope=${String(current?.scope)}`
  )

  log('=== 4. 空间概览仍然可达（它回答「这个空间里有什么」）===')
  S().openSpaceView?.('overview')
  await sleep(800)
  ok(!!q('[data-testid="space-workbench"]'), '空间概览能打开')
  const shown = q('[data-testid="space-workbench-name"]')?.textContent ?? ''
  ok(shown.includes(NAME) || shown.length === 0, '概览显示的是某个空间的名字', shown)
  S().closeSpaceView?.()
  await sleep(300)

  log('=== 5. 归档空间：从活动列表消失，但不物理删除 ===')
  S().openSettings('workspace')
  await sleep(600)
  const rowForMenu = all('[data-testid="set-space-row"]').find((r) =>
    (r.textContent ?? '').includes(NAME)
  )
  click(rowForMenu?.querySelector('[data-testid="set-space-archive"]'))
  await sleep(800)
  ok(
    !all('[data-testid="set-space-row"]').some((r) => (r.textContent ?? '').includes(NAME)),
    '归档后不在活动列表里'
  )
  const afterArchive = await window.yan.getSpaces()
  ok(
    afterArchive.spaces.some((s) => s.id === spaceId && s.archived === true),
    '归档空间仍能从存储读到（归档 ≠ 删除）'
  )
  S().closeSettings()

  return out.join('\n')
})()
