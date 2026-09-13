/**
 * 终端窗口（用户要求：「更好的终端实现以及调整窗口大小」）。
 *
 * 断言：
 *   ① 运行中的工具调用自动展开成终端窗口，有标题栏 / prompt 行 / 状态胶囊
 *   ② 三个拖拽把手（下 / 右 / 右下角）都在
 *   ③ 拖动下把手能真的改变窗口高度
 *   ④ 展开按钮能把窗口放大，「恢复」能收回
 *   ⑤ 双击下把手复位
 *
 * 不烧 token：直接注入一条带运行中 bash 工具调用的助手回合。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  localStorage.setItem('yan.onboarded', '1')

  const now = Date.now()
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'term-u', role: 'user', text: '跑个命令' },
      {
        id: 'term-a',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'term-c1',
            name: 'bash',
            args: { command: 'npm run build' },
            status: 'running',
            output: 'building...\nstep 1\ndone\n',
            startedAt: now
          }
        ]
      }
    ]
  })
  // 让回合处于「进行中」，运行中的工具行才会自动展开
  store.setState({
    session: { ...(store.getState().session ?? {}), isStreaming: true, isAgentRunning: true }
  })

  ok(await until(() => !!q('.term')), '终端窗口已渲染')
  const term = q('.term')
  if (!term) return out.join('\n')

  out.push('')
  out.push('=== 1. 结构 ===')
  ok(!!q('.term-bar'), '有标题栏')
  ok(!!q('.term-lights .term-dot'), '标题栏有窗口灯')
  ok(!!q('.term-pill'), '有状态胶囊（运行中 / 完成 / 失败）')
  ok(!!q('.term-prompt'), '正文有 prompt 行（终端里的 $ 命令）')
  ok((q('.term-prompt')?.textContent ?? '').includes('npm run build'), 'prompt 行显示命令原文')
  ok(!!q('[data-testid="term-copy"]'), '有复制按钮')
  ok(!!q('[data-testid="term-max"]'), '有展开/恢复按钮')

  out.push('')
  out.push('=== 2. 调整窗口大小 ===')
  ok(!!q('.term-grip-s'), '有下边拖拽把手')
  ok(!!q('.term-grip-e'), '有右边拖拽把手')
  ok(!!q('.term-grip-se'), '有右下角拖拽把手')

  const grip = q('.term-grip-s')
  const h0 = term.getBoundingClientRect().height

  const down = (el, x, y) =>
    el.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 })
    )
  const move = (x, y) =>
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1 })
    )
  const up = (x, y) =>
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))

  const r = grip.getBoundingClientRect()
  down(grip, r.left + r.width / 2, r.top + 2)
  move(r.left + r.width / 2, r.top + 2 + 90)
  up(r.left + r.width / 2, r.top + 2 + 90)
  await sleep(200)
  const h1 = term.getBoundingClientRect().height
  ok(h1 > h0 + 40, `拖下把手后高度变大（${Math.round(h0)} → ${Math.round(h1)}）`)

  // 键盘也能调（把手是可聚焦的 separator）
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await sleep(150)
  const h2 = term.getBoundingClientRect().height
  ok(h2 > h1, `键盘 ↓ 也能加高（${Math.round(h1)} → ${Math.round(h2)}）`)

  out.push('')
  out.push('=== 3. 展开 / 恢复 ===')
  const maxBtn = q('[data-testid="term-max"]')
  const hBefore = term.getBoundingClientRect().height
  maxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(250)
  const hMax = term.getBoundingClientRect().height
  ok(hMax > hBefore, `点「展开」后更高（${Math.round(hBefore)} → ${Math.round(hMax)}）`)
  ok(term.classList.contains('max'), '展开态带 .max 标记')
  maxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(250)
  ok(!q('.term')?.classList.contains('max'), '再点一次「恢复」收起展开态')

  out.push('')
  out.push('=== 4. 双击复位 ===')
  const h3 = q('.term').getBoundingClientRect().height
  q('.term-grip-s').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  await sleep(250)
  const h4 = q('.term').getBoundingClientRect().height
  ok(h4 !== h3, `双击下把手复位高度（${Math.round(h3)} → ${Math.round(h4)}）`)

  return out.join('\n')
})()
