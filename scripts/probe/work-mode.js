/**
 * 工作模式（实施-05 S2）：会话级模式 + 旧配置迁移 + 菜单键盘 + A/B 隔离。
 *
 * ── 为什么第 4 节必须用**真实按键** ──
 * `Tab` 快切是在**渲染端**的 textarea keydown 里拦的（主进程不参与）。
 * 合成 KeyboardEvent 也能走到 React 的处理器，但它验不到两件真实行为：
 *   ① 焦点真的还在输入框里（preventDefault 生不生效）；
 *   ② 输入法 / 长文模式 / 补全菜单这些前置分支真的会让路。
 * 所以这一节用 `YAN_PROBE_KEYS`（主进程 sendInputEvent）发真键，并且把
 * 第一枚按键往后推（`keysDelay`）—— 探针得先把首次引导关掉、把焦点放好。
 *
 * ── 第 5 节为什么必须有两个会话 ──
 * 旧实现是一个**全局布尔**：A 会话切自主会改变 B 的提问行为。所以「按会话
 * 保存」这条只能靠两个真会话互相切换来证明（同一个 run 实例被复用、会话
 * 身份变了 —— 这正是当初容易写错的地方）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const key = (el, k, opts = {}) =>
    el && el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  const store = window.__yanStore
  /*
   * 切会话是异步的（要等 pi 真的 swap、再由主进程推 sync）。
   * 固定 sleep 会变成“时快时慢”的 flaky 用例 —— 用条件轮询。
   */
  const waitFor = async (fn, ms = 15000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (fn()) return true
      await sleep(250)
    }
    return fn()
  }
  /**
   * 主进程认为「当前 active 实例」打开的是哪个会话文件。
   *
   * ⚠️ 判据用**文件**，不用 `state.sessionId`：实测切走再切回同一份文件时
   * pi 会报一个新的 sessionId（文件还是那个文件）。这不是缺陷，但拿它做断言
   * 就会得到一个永远红的假失败 —— 模式的存储键也因此改用文件路径。
   */
  const normFile = (p) => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const activeSessionFile = async () => {
    const list = await window.yan.runnerStatuses()
    return list.find((r) => r.isActive)?.sessionFile ?? ''
  }
  const waitActiveFile = async (file, ms = 15000) => {
    const deadline = Date.now() + ms
    let seen = ''
    while (Date.now() < deadline) {
      seen = await activeSessionFile()
      if (seen && normFile(seen) === normFile(file)) return { ok: true, seen }
      await sleep(250)
    }
    return { ok: false, seen }
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成|跳过/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(600)

  /* 等 pi 连上：runners 就绪后 `getWorkMode` 才拿得到会话身份（否则只是默认值） */
  for (let i = 0; i < 40 && store.getState().conn !== 'ready'; i++) await sleep(250)
  out.push(`  连接状态: ${store.getState().conn}`)

  /* ---------------------------------------------------------- 1. 迁移 */
  out.push('=== 1. 旧配置迁移 + 新会话默认值 ===')
  const settings = await window.yan.getSettings()
  ok(settings.autonomous === true, '旧 autonomous 字段保留（迁移输入，不抹掉用户写下的值）')
  ok(settings.defaultWorkMode === 'autonomous', '迁移：旧 autonomous=true → defaultWorkMode=autonomous')
  const initial = await window.yan.getWorkMode()
  ok(initial.mode === 'autonomous', `新会话按默认模式启动（实际 ${initial.mode}）`)
  const btn = q('[data-testid="work-mode-button"]')
  ok(!!btn, '输入区有工作模式按钮')
  ok(!!btn?.closest('.composer-bar') && !!btn?.closest('.composer'), '按钮在输入框工具行里')
  ok(btn?.getAttribute('data-mode') === 'autonomous', '按钮显示当前会话模式')
  const label = (q('[data-testid="work-mode-label"]')?.textContent ?? '').trim()
  ok(/自主|Autonomous/.test(label), `按钮写的是档位名（实际 ${JSON.stringify(label)}）`)
  ok(q('.composer-wrap')?.getAttribute('data-autonomous') === '1', '自主模式才有运行光带状态')
  /*
   * 自主态现在采用静态靛蓝边界：宽扁输入框不再生成两条动态光带，
   * 避免光斑成为第二个视觉重心。这里保留反向断言，防止旧动画样式又被带回。
   */
  const composerEl = q('.composer-wrap .composer')
  const bandA = composerEl ? getComputedStyle(composerEl, '::before') : null
  const bandB = composerEl ? getComputedStyle(composerEl, '::after') : null
  ok(bandA?.display === 'none' && bandB?.display === 'none', '自主模式采用静态边界，不生成动画光带')
  const legacyBands = composerEl?.getAnimations({ subtree: true }).filter((a) => a.animationName === 'yan-autonomous-border') ?? []
  ok(legacyBands.length === 0, `旧版自主光带动画已移除（实得 ${legacyBands.length}）`)

  /* ---------------------------------------------------------- 2. 菜单 */
  out.push('')
  out.push('=== 2. 菜单：三档 + 一句说明 + 键盘 ===')
  click(btn)
  await sleep(140)
  const menu = q('[data-testid="work-mode-menu"]')
  ok(!!menu, '点击后菜单出现')
  const items = menu ? [...menu.querySelectorAll('.mode-item')] : []
  ok(items.length === 3, `菜单三档（实际 ${items.length}）`)
  ok(
    items.every((it) => ((it.querySelector('.mode-item-desc')?.textContent ?? '').trim().length > 0)),
    '每档都带一句说明'
  )
  ok(items.some((it) => it.classList.contains('current')), '当前档有标记')
  const modeOf = (el) => el?.getAttribute('data-mode') ?? ''
  const activeBefore = modeOf(q('[data-testid="work-mode-menu"] .mode-item.active'))
  key(q('[data-testid="work-mode-menu"]'), 'ArrowDown')
  await sleep(100)
  const activeAfter = modeOf(q('[data-testid="work-mode-menu"] .mode-item.active'))
  ok(activeBefore !== activeAfter, `方向键移动高亮（${activeBefore} → ${activeAfter}）`)
  key(q('[data-testid="work-mode-menu"]'), 'Escape')
  await sleep(100)
  ok(!q('[data-testid="work-mode-menu"]'), 'Esc 关闭菜单')
  ok(document.activeElement === btn, 'Esc 后焦点回到模式按钮')

  /* ---------------------------------------------------------- 3. 提交 */
  out.push('')
  out.push('=== 3. 从菜单切档（真提交）===')
  click(btn)
  await sleep(120)
  click(q('[data-testid="work-mode-option-standard"]'))
  await sleep(500)
  const afterPick = await window.yan.getWorkMode()
  ok(afterPick.mode === 'standard' && afterPick.revision >= 1, `切到标准并提交（revision=${afterPick.revision}）`)
  ok(q('[data-testid="work-mode-button"]')?.getAttribute('data-mode') === 'standard', '按钮跟着变')
  ok(q('.composer-wrap')?.getAttribute('data-autonomous') === '0', '离开自主后光带消失')
  ok(!q('[data-testid="work-mode-menu"]'), '选完菜单关闭')

  /* ------------------------------------------------- 4. Tab 快切（真按键） */
  out.push('')
  out.push('=== 4. Tab 快切（主进程发的真按键）===')
  const ta = q('[data-testid="composer"]')
  ta?.focus()
  ok(document.activeElement === ta, '焦点先放进输入框')
  /* 两次 Tab：standard → clarify → autonomous（间隔 1.6s，第一枚在 keysDelay 后） */
  await sleep(15000)
  const tabbed = await window.yan.getWorkMode()
  ok(tabbed.mode === 'autonomous', `两次 Tab 循环到自主（实际 ${tabbed.mode}）`)
  ok(tabbed.revision >= 3, `两次 Tab 各提交一次（revision=${tabbed.revision}，至少 3）`)
  ok(document.activeElement === ta, 'Tab 没有把焦点移走（preventDefault 生效）')
  ok(q('[data-testid="work-mode-button"]')?.getAttribute('data-mode') === 'autonomous', '按钮跟上按键结果')
  ok(q('.composer-wrap')?.getAttribute('data-autonomous') === '1', '自主光带随按键状态出现')

  /* ---------------------------------------------------- 5. A/B 会话隔离 */
  out.push('')
  out.push('=== 5. A/B 会话隔离（复用同一实例也不串）===')
  const cwd = store.getState().settings?.cwd ?? ''
  const aFile = store.getState().session?.sessionFile ?? ''
  const aId = store.getState().session?.sessionId ?? ''
  ok(!!aFile && !!aId, '拿到 A 会话身份')
  /* 诊断：实例身份在切换前后到底怎么变（会话级模式的键就取这里的 sessionId） */
  const dump = async (tag) => {
    const list = await window.yan.runnerStatuses()
    out.push(
      `  [${tag}] ` +
        list
          .map((r) => `${r.isActive ? '*' : ''}${r.runId} sid=${r.sessionId ?? '-'} file=${(r.sessionFile ?? '-').split(/[\\/]/).pop()}`)
          .join(' | ')
    )
  }
  await dump('A 初始')
  out.push(`  A: sid=${aId} file=${aFile.split(/[\\/]/).pop()}`)
  await store.getState().newSession({ scope: 'global' })
  await waitFor(() => {
    const f = store.getState().session?.sessionFile ?? ''
    return !!f && f !== aFile
  })
  const bFile = store.getState().session?.sessionFile ?? ''
  const bId = store.getState().session?.sessionId ?? ''
  ok(!!bFile && bFile !== aFile, '新建出 B 会话（身份与 A 不同）')
  const bStart = await window.yan.getWorkMode()
  ok(bStart.mode === 'autonomous', `新会话按默认值开始（实际 ${bStart.mode}）`)
  await dump('B 新建')
  out.push(`  B: sid=${bId} file=${bFile.split(/[\\/]/).pop()}`)
  await store.getState().setWorkMode('clarify')
  await sleep(500)
  ok((await window.yan.getWorkMode()).mode === 'clarify', 'B 会话切到澄清')

  await store.getState().switchSession(aFile)
  const backA = await waitActiveFile(aFile)
  await dump('切回 A 后')
  ok(backA.ok, `active 实例打开的是 A 的会话文件（实际 ${backA.seen.split(/[\\/]/).pop() || '-'}）`)
  const aBack = await window.yan.getWorkMode()
  ok(
    aBack.mode === 'autonomous' && aBack.revision >= 1,
    `切回 A：仍是自主（mode=${aBack.mode} rev=${aBack.revision}）`
  )
  ok(
    q('[data-testid="work-mode-button"]')?.getAttribute('data-mode') === 'autonomous',
    'A 的按钮显示自主'
  )

  await store.getState().switchSession(bFile)
  const backB = await waitActiveFile(bFile)
  await dump('切回 B 后')
  ok(backB.ok, `active 实例打开的是 B 的会话文件（实际 ${backB.seen.split(/[\\/]/).pop() || '-'}）`)
  const bBack = await window.yan.getWorkMode()
  ok(
    bBack.mode === 'clarify' && bBack.revision >= 1,
    `再切到 B：仍是澄清（mode=${bBack.mode} rev=${bBack.revision}）`
  )
  ok(
    q('[data-testid="work-mode-button"]')?.getAttribute('data-mode') === 'clarify',
    'B 的按钮显示澄清'
  )

  /* ------------------------------------------- 6. Tab 快切开关（设置） */
  out.push('')
  out.push('=== 6. 设置里关掉 Tab 快切 ===')
  await store.getState().patchSettings({ workModeTab: false })
  await sleep(400)
  ok((await window.yan.getSettings()).workModeTab === false, '关掉 Tab 快切并落盘')
  const beforeOff = (await window.yan.getWorkMode()).mode
  const taOff = q('[data-testid="composer"]')
  taOff?.focus()
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  taOff?.dispatchEvent(ev)
  await sleep(400)
  ok((await window.yan.getWorkMode()).mode === beforeOff, '关掉后 Tab 不再切模式')
  ok(!ev.defaultPrevented, '关掉后 Tab 不被拦（焦点照常移动）')
  /* 再打开：应当**删掉**磁盘上的键（默认态不落盘）——
     注意读的是 IPC 返回的对象，未落盘的键在内存里是 `undefined` */
  await store.getState().patchSettings({ workModeTab: true })
  await sleep(400)
  ok((await window.yan.getSettings()).workModeTab === undefined, '恢复开 = 不再有这个键（默认态不落盘）')

  return out.join('\n')
})()
