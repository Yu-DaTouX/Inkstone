/*
 * 「项目知识」设置页的真实闭环（实施-03 S5，cost 0 —— 不调模型）。
 *
 * 这一态验的是**界面接线**，不是模型：设置页真的从主进程读到 fixture（一个已确认
 * + 一个候选），三个筛选的计数对得上，然后**点下去**走完整条写路径：
 *   确认（候选 → 已确认）→ 编辑（改正文）→ 逻辑删除。
 *
 * 为什么两边都要看：界面上的状态可能只是刷新出来的乐观值。真实落盘由
 * afterExit（Node 侧读 manifest）检查 —— 三次操作后条目应该是 `deleted`，
 * revision 至少加了 3，而另一条 fixture 不受影响。
 */
;(async () => {
  const out = []
  const ok = (condition, text, extra = '') => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text + (extra ? `  ${extra}` : ''))
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const S = () => store.getState()
  /** 条件轮询：几何/数据稳定后再下结论（固定 sleep 在慢机器上会假红） */
  const until = async (fn, ms = 12000) => {
    const t0 = Date.now()
    for (;;) {
      const value = fn()
      if (value) return value
      if (Date.now() - t0 > ms) return null
      await sleep(150)
    }
  }
  const setText = (el, text) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  /*
   * 点之前确认按钮**不是 disabled**：保存 / 刷新时按钮会短暂禁用，
   * 此刻派发 click 会被浏览器直接忽略（看着像“点了没反应”，实际是打到了禁用态）。
   */
  const click = async (selector, ms = 12000) => {
    const el = await until(() => {
      const node = q(selector)
      return node && !node.disabled ? node : null
    }, ms)
    if (!el) return null
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return el
  }
  const itemText = (id) => q(`[data-testid="kn-item-${id}"]`)?.textContent ?? ''
  const CANDIDATE = 'k-candidate01'
  const ACTIVE = 'kn-deploy'

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const button = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (button) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(200)
      } else await sleep(120)
    }
    await sleep(400)
    S().closeSettings?.()
    await sleep(200)
    for (let i = 0; i < 60; i++) {
      if (S().conn === 'ready') break
      await sleep(500)
    }

    S().openSettings('knowledge')
    const first = await until(() => q(`[data-testid="kn-item-${ACTIVE}"]`))
    ok(!!first, '设置页真的读到了项目知识（已确认那条在列表里）')
    if (!first) return out.join('\n')

    /* 开关与计数：计数来自主进程，不是界面自己数 items */
    ok(!!q('[data-testid="kn-toggle"]'), '有启用开关')
    const filterText = (id) => q(`[data-testid="kn-filter-${id}"]`)?.textContent ?? ''
    ok(/1/.test(filterText('candidate')), '「待确认」计数 = 1', filterText('candidate').trim())
    ok(/1/.test(filterText('active')), '「已确认」计数 = 1', filterText('active').trim())

    /* ── 确认：候选 → 已确认（这是用户动作，也是 active 的唯一入口）── */
    await click('[data-testid="kn-filter-candidate"]')
    ok(!!(await until(() => q(`[data-testid="kn-item-${CANDIDATE}"]`))), '「待确认」筛选里有那条候选')
    await click(`[data-testid="kn-confirm-${CANDIDATE}"]`)
    const confirmed = await until(() => {
      const inCandidate = q(`[data-testid="kn-item-${CANDIDATE}"]`)
      /* 确认后它不该再留在待确认列表里（换个筛选才看得到） */
      return !inCandidate ? 'left' : null
    })
    ok(confirmed === 'left', '确认后从「待确认」列表消失')
    await click('[data-testid="kn-filter-active"]')
    const confirmedRow = await until(() => q(`[data-testid="kn-item-${CANDIDATE}"]`))
    ok(!!confirmedRow, '确认后出现在「已确认」里')
    ok(/已确认/.test(itemText(CANDIDATE)), '卡片上的状态徽章是「已确认」')

    /* ── 编辑：改正文并保存 ── */
    const edited = 'out/ 是构建产物目录，跑单测前先 build（设置页编辑过）'
    await click(`[data-testid="kn-edit-${CANDIDATE}"]`)
    const editor = await until(() => q(`[data-testid="kn-editor-${CANDIDATE}"]`))
    ok(!!editor, '点「编辑」出现就地编辑框')
    if (editor) {
      setText(editor, edited)
      await sleep(150)
      await click(`[data-testid="kn-save-${CANDIDATE}"]`)
      const saved = await until(() => itemText(CANDIDATE).includes('设置页编辑过'))
      ok(!!saved, '保存后卡片显示新正文')
    }

    /* ── 删除（逻辑）：先问再删 ── */
    await click(`[data-testid="kn-delete-${CANDIDATE}"]`)
    ok(!!(await until(() => q(`[data-testid="kn-delete-logical-${CANDIDATE}"]`))), '点「删除」先问一句（没有直接删）')
    await click(`[data-testid="kn-delete-logical-${CANDIDATE}"]`)
    const gone = await until(() => !q(`[data-testid="kn-item-${CANDIDATE}"]`))
    ok(!!gone, '逻辑删除后条目从列表消失（不再进检索）')
    ok(!!q(`[data-testid="kn-item-${ACTIVE}"]`), '另一条 fixture 还在（删除只影响这一条）')

    /* ── 导出：只验按钮接线（保存会弹对话框，交给人工）── */
    await click('[data-testid="kn-export-copy"]')
    const notice = await until(() => q('[data-testid="kn-notice"]'))
    ok(!!notice, '点「复制」有回执（成功或剪贴板不可用都会说一句）')

    /*
     * ── 来源跳转：真点一下（放最后，它会把会话切走）──
     * 断言两件：设置面板真的关了，并且当前会话**换成了那条来源**。
     * 只看到「按钮能点」不算 —— 跳转的语义就是把用户带到出处。
     */
    const before = S().peekedPath ?? S().session?.sessionFile ?? ''
    const jump = q(`[data-testid="kn-jump-${ACTIVE}"]`)
    ok(!!jump && !jump.disabled, '来源会话真实存在时可以点（不是「不可回读」）')
    if (jump && !jump.disabled) {
      await click(`[data-testid="kn-jump-${ACTIVE}"]`)
      ok(!!(await until(() => (S().settingsOpen === false ? true : null), 15000)), '点来源后设置面板关闭')
      const after = S().peekedPath ?? S().session?.sessionFile ?? ''
      ok(!!after && after !== before, '真的切到了那条来源会话', after ? after.split(/[\\/]/).pop() : '(空)')
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
