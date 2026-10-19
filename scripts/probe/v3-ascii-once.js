;(async () => {
  const out = []
  const check = (condition, label) => out.push(`  ${condition ? '✓' : '✗'} ${label}`)
  const note = (label) => out.push(`  • ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (predicate()) return true
      await wait(50)
    }
    return false
  }
  const untilAsync = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (await predicate()) return true
      } catch {
      }
      await wait(100)
    }
    return false
  }
  const query = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore
  let spaceListener
  try {
    out.push('=== v3 ASCII 单目标隔离专项（label.click / input.click / 真实 Space）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && query('v3-sidebar')), 'v3 外壳已挂载')
    if (!store || !query('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    check(await until(() => !!query('v3-empty')), '新会话空态已挂载')
    check(
      await until(() => {
        const el = query('v3-ascii-field')
        return !!el && el.getAttribute('data-closing') === '0'
      }),
      '空态挂载动态 ASCII 背景（未淡出）'
    )

    const label = () => query('v3-ascii-background-toggle')
    const input = () => label()?.querySelector('input')
    const readState = async () => {
      const ipc = await window.yan.getSettings().catch(() => null)
      return {
        labelSelected: label()?.getAttribute('data-selected') ?? null,
        inputChecked: input() ? input().checked : null,
        inputAria: input()?.getAttribute('aria-checked') ?? null,
        storeAscii: store.getState().settings?.asciiBackground,
        ipcAscii: ipc?.asciiBackground,
        field: !!query('v3-ascii-field')
      }
    }
    const moreOpen = () => label()?.closest('.settings-more')?.getAttribute('data-open') === '1'
    const openAppearance = async () => {
      if (!query('settings-root')) {
        query('v3-header-settings')?.click()
        await until(() => !!query('settings-root'), 6000)
      }
      if (!label()) {
        query('v3-settings-nav-appearance')?.click()
        await until(() => !!label(), 6000)
      }
      if (label() && !moreOpen()) {
        label().closest('.settings-more')?.querySelector('[data-testid="settings-more-toggle"]')?.click()
        await until(moreOpen, 3000)
      }
      return !!label() && moreOpen()
    }
    const backToSession = async () => {
      query('settings-close')?.click()
      return until(() => !query('settings-root') && !!query('composer-input'), 6000)
    }

    check(await openAppearance(), '外观分区打开并可看到动态背景开关')
    if (!label()) throw new Error('外观分区没有动态背景开关')
    const s0 = await readState()
    check(s0.ipcAscii === undefined, '前置：主进程未写 asciiBackground 键（缺省视为开）')
    check(s0.storeAscii !== false, `前置：store 未置 false（实际 ${String(s0.storeAscii)}）`)
    check(s0.labelSelected === 'true', `前置：开关 data-selected=true（实际 ${String(s0.labelSelected)}）`)
    check(s0.inputChecked === true, `前置：内部 input.checked=true（实际 ${String(s0.inputChecked)}）`)

    let labelClicks = 0
    const clickListener = () => {
      labelClicks += 1
    }
    label().addEventListener('click', clickListener, true)
    label().click()
    await wait(1200)
    label().removeEventListener('click', clickListener, true)
    const sA = await readState()
    note(
      `阶段A label.click：捕获 click ${labelClicks} 次；` +
        `data-selected=${String(sA.labelSelected)} input.checked=${String(sA.inputChecked)} ` +
        `store=${String(sA.storeAscii)} ipc=${String(sA.ipcAscii)}`
    )
    if (sA.ipcAscii === false) {
      note('阶段A：label.click 竟改变了状态（H1 假说在本构建不成立）；先恢复缺省再继续')
      input()?.click()
      check(
        await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === undefined, 5000),
        '阶段A 后已用内部 input.click 恢复缺省（删键）'
      )
    } else {
      note('阶段A：label.click 未改变状态（与既有失败一致；这是复现记录，不作为本次运行失败）')
    }

    check(await openAppearance(), '阶段B 前外观分区仍在')
    const b0 = await readState()
    check(b0.ipcAscii === undefined, '阶段B 前置：仍为缺省开（未写键）')
    check(b0.labelSelected === 'true' && b0.inputChecked === true, '阶段B 前置：投影为已选（data-selected=true / checked=true）')

    input()?.click()
    const closedB = await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === false, 5000)
    check(closedB, '内部 input.click 后主进程持久化 false（关闭真的落盘）')
    const sB1 = await readState()
    check(
      sB1.labelSelected !== 'true' && sB1.inputChecked === false,
      `关闭后开关投影为未选（data-selected=${String(sB1.labelSelected)} / checked=${String(sB1.inputChecked)}）`
    )
    check(await backToSession(), '关闭后可返回会话')
    check(await until(() => !query('v3-ascii-field'), 3000), '关闭后空态不再挂载 ASCII 背景（DOM 卸载）')

    check(await openAppearance(), '恢复前可再次打开外观分区')
    const r0 = await readState()
    check(r0.ipcAscii === false && r0.inputChecked === false, '恢复前置：当前确为关闭（ipc=false / checked=false）')
    input()?.click()
    const restoredB = await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === undefined, 5000)
    check(restoredB, '内部 input.click 开回来只回落缺省（删除键，不写 true）')
    const sB2 = await readState()
    check(
      sB2.labelSelected === 'true' && sB2.inputChecked === true,
      `恢复后开关投影为已选（data-selected=${String(sB2.labelSelected)} / checked=${String(sB2.inputChecked)}）`
    )
    check(await backToSession(), '恢复后可返回会话')
    check(
      await until(() => {
        const el = query('v3-ascii-field')
        return !!el && el.getAttribute('data-closing') === '0'
      }, 4000),
      '恢复缺省后空态重新挂载 ASCII 背景'
    )

    check(await openAppearance(), '阶段C 前外观分区打开')
    const c0 = await readState()
    note(`阶段C 前置：ipc=${String(c0.ipcAscii)} data-selected=${String(c0.labelSelected)} checked=${String(c0.inputChecked)}`)
    let spaceKeyups = 0
    spaceListener = (event) => {
      if (event.key === ' ' || event.code === 'Space' || event.key === 'Spacebar') spaceKeyups += 1
    }
    window.addEventListener('keyup', spaceListener, true)
    input()?.focus()
    note(`阶段C：内部 input 已聚焦=${document.activeElement === input()}`)
    const gotSpace = await until(() => spaceKeyups > 0, 30000)
    note(`阶段C：收到真实 Chromium Space keyup ${spaceKeyups} 次=${gotSpace}（观察项，不作失败判据）`)
    if (gotSpace) {
      await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === false, 3000)
      const sC = await readState()
      note(`阶段C Space 后：ipc=${String(sC.ipcAscii)} data-selected=${String(sC.labelSelected)} checked=${String(sC.inputChecked)}`)
      if (sC.ipcAscii === false) {
        note('阶段C：真实 Space 成功关闭开关（与内部 input.click 结论一致）')
        check(await backToSession(), '阶段C 关闭后可返回会话')
        check(await until(() => !query('v3-ascii-field'), 3000), '阶段C 真实 Space 关闭后背景卸载')
        check(await openAppearance(), '阶段C 恢复前重新打开外观分区')
        input()?.click()
        check(
          await untilAsync(async () => (await window.yan.getSettings()).asciiBackground === undefined, 5000),
          '阶段C 已用内部 input.click 恢复缺省（删键）'
        )
        check(await backToSession(), '阶段C 恢复后返回会话')
        check(await until(() => !!query('v3-ascii-field'), 4000), '阶段C 恢复后背景重新挂载')
      } else {
        note('阶段C：真实 Space 未改变开关状态（记录为观察项，不作为本次失败判据）')
      }
    }
    out.push('证据范围：仅隔离空态的 ASCII 开关关闭/恢复链路与真实按键观察；不代表完整 v3 验收或真实模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  } finally {
    if (spaceListener) window.removeEventListener('keyup', spaceListener, true)
  }
  return out.join('\n')
})()
