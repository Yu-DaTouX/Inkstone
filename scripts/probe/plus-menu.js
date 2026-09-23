/**
 * `+` 菜单（2026-09-22）：文件和文件夹 / 图片 / 能力。
 *
 * ── 为什么还要断言几何 ──
 * 菜单是 `fixed` 定位的浮层，而 `.composer` 有 `overflow: hidden`
 * （圆角与自主光带需要它）。定位写错时菜单会被整块裁掉 ——
 * 那一刻「元素在 DOM 里」仍然为真，只有 rect 能看出问题。
 *
 * ── 为什么不点前两项 ──
 * 「文件和文件夹」与「图片」都会开**系统对话框**，探针一点就卡在原生弹窗上；
 * 所以只验它们存在、文案正确、几何正常。真实点击留给人工视觉验收。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const waitFor = async (fn, ms = 10000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (fn()) return true
      await sleep(200)
    }
    return fn()
  }

  /* 输入区要等连接就绪后才渲染 */
  await waitFor(() => q('[data-testid="composer-attach"]'), 25000)
  ok(!!q('[data-testid="composer-attach"]'), '输入区的 `+` 按钮在')
  ok(!q('[data-testid="plus-menu"]'), '菜单默认不展开')

  q('[data-testid="composer-attach"]')?.click()
  await waitFor(() => q('[data-testid="plus-menu"]'), 5000)
  const menu = q('[data-testid="plus-menu"]')
  ok(!!menu, '点 `+` 打开菜单')

  ok(!!q('[data-testid="plus-files"]'), '有「文件和文件夹」')
  ok(!!q('[data-testid="plus-images"]'), '有「图片」')
  ok(!!q('[data-testid="plus-capabilities"]'), '有「能力」分组')
  ok(
    (q('[data-testid="plus-capabilities"] .plus-group-label')?.textContent ?? '').includes('能力'),
    `能力分组带标题（实际 ${JSON.stringify(q('[data-testid="plus-capabilities"] .plus-group-label')?.textContent)}）`
  )

  /* 文案必须是真文案：i18n 漏键时界面会把键名原样显示出来 */
  const filesText = q('[data-testid="plus-files"]')?.textContent ?? ''
  ok(
    filesText.includes('文件') && !filesText.includes('plus.'),
    `「文件和文件夹」是中文文案（实际 ${JSON.stringify(filesText)}）`
  )
  ok(
    (q('[data-testid="plus-files"] .mode-item-desc')?.textContent ?? '').length > 4,
    '「文件和文件夹」带一行说明'
  )

  /* 几何：菜单必须整体落在视口里（overflow:hidden 的坑） */
  const r = menu.getBoundingClientRect()
  ok(
    r.width > 120 && r.left >= 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1,
    `菜单在视口内（w=${Math.round(r.width)} left=${Math.round(r.left)} bottom=${Math.round(r.bottom)} viewport=${window.innerHeight}）`
  )

  /* 能力分组：空态与已装项都算通过，但必须有**可读内容** */
  const empty = q('[data-testid="plus-cap-empty"]')
  const loaded = [...document.querySelectorAll('[data-testid^="plus-cap-"]')].filter(
    (el) => el.getAttribute('data-testid') !== 'plus-cap-empty'
  )
  ok(!!empty || loaded.length > 0, `能力分组给出空态或已装项（空态=${!!empty} 已装=${loaded.length}）`)
  if (empty) {
    const text = empty.textContent ?? ''
    ok(
      text.includes('没有') || text.includes('设置'),
      `空态说清下一步（实际 ${JSON.stringify(text)}）`
    )
    /* 空态可点：用户的下一步就是去设置里加 */
    ok(empty.tagName === 'BUTTON', '空态本身是可点入口')
  } else {
    ok(!!loaded[0]?.querySelector('.mode-item-desc'), '已装能力带一行说明')
  }

  /*
   * ------------------------------------- 目标（持续目标入口，2026-09-22）
   *
   * 这一节会**真的**建一个目标（写进隔离的 goals.json）—— 这正是要验的：
   * 表单 → IPC → 目标存储整条链路。不会产生模型调用：续行只在
   * `message_end` 被消费，而本场景没有任何模型回合。
   */
  ok(!!q('[data-testid="plus-goal"]'), '有「目标」项')
  ok(
    (q('[data-testid="plus-goal"] .mode-item-desc')?.textContent ?? '').includes('可衡量'),
    '「目标」项写明要定义可衡量的成果'
  )
  q('[data-testid="plus-goal"]')?.click()
  await waitFor(() => q('[data-testid="plus-goal-compose"]'), 4000)
  ok(!!q('[data-testid="plus-goal-compose"]'), '点「目标」进入表单')
  ok(!!q('[data-testid="plus-goal-start"]'), '表单有「开始」按钮')
  ok(q('[data-testid="plus-goal-start"]')?.disabled === true, '两栏空着时「开始」不可点（不制造无声失败）')

  /* React 受控 textarea：必须走原生 setter + input 事件，直接改 value 不会触发 onChange */
  const fill = (sel, text) => {
    const el = q(sel)
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  fill('[data-testid="plus-goal-text"]', '把加号菜单做成 codex 式')
  await sleep(150)
  ok(q('[data-testid="plus-goal-start"]')?.disabled === true, '只写目标还不可点（可衡量的成果必填）')
  fill('[data-testid="plus-outcome-text"]', '菜单三项可点且两张截图齐备')
  await sleep(150)
  ok(q('[data-testid="plus-goal-start"]')?.disabled === false, '两栏都填了才能开始')

  q('[data-testid="plus-goal-start"]')?.click()
  await waitFor(() => !q('[data-testid="plus-menu"]'), 5000)
  ok(!q('[data-testid="plus-menu"]'), '开始后菜单收起')
  const seeded = q('[data-testid="composer"]')?.value ?? ''
  ok(
    seeded.includes('[持续目标]') && seeded.includes('达成判据'),
    `输入框里写下目标模板（实际 ${JSON.stringify(seeded.slice(0, 40))}）`
  )

  /* 宿主侧真的建立了目标 —— 界面填空不能只改一个本地 state */
  const goalRes = await window.yan.getGoal()
  ok(goalRes.goal.pursue === true, 'getGoal 里 pursue=true（与档位正交的落地证据）')
  ok(
    goalRes.goal.brief?.outcome === '菜单三项可点且两张截图齐备',
    `达成判据原样存进目标（实际 ${JSON.stringify(goalRes.goal.brief?.outcome)}）`
  )
  /* U-3a：目标改成标题栏入口 + 浮层（不再在工具页常驻）。 */
  document.querySelector('[data-testid="goal-entry"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor(() => q('[data-testid="goal-panel"]'), 5000)
  ok(!!q('[data-testid="goal-panel"]'), '目标浮层里出现目标面板')

  /* 点外部收起 */
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await sleep(250)
  ok(!q('[data-testid="plus-menu"]'), '点外部收起菜单')

  /* Esc 收起 */
  q('[data-testid="composer-attach"]')?.click()
  await waitFor(() => q('[data-testid="plus-menu"]'), 4000)
  q('[data-testid="composer-attach"]')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
  await sleep(250)
  ok(!q('[data-testid="plus-menu"]'), 'Esc 收起菜单')

  /* 再点一次 `+` 应该能重新打开（收起路径没把状态卡死） */
  q('[data-testid="composer-attach"]')?.click()
  const reopened = await waitFor(() => q('[data-testid="plus-menu"]'), 4000)
  ok(reopened, '收起后还能重新打开')
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  return out
})()
