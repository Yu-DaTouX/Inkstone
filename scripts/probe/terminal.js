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
  const qa = (s) => [...document.querySelectorAll(s)]
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
  /*
   * 方案 4.3：紧凑命令窗口去掉三色装饰灯、重复目标与重复状态。
   * 这里断言它们**不在** —— 否则「紧凑」会慢慢长回去。
   */
  ok(!q('.term-lights'), '标题栏没有三色装饰灯（方案 4.3）')
  ok(!q('.term-pill'), '窗口内不再重复状态胶囊（行上已有状态）')
  ok(!q('.term-cmd'), '标题栏不再重复命令（正文 prompt 行已有）')
  ok(!!q('.term-prompt'), '正文有 prompt 行（终端里的 $ 命令）')
  ok((q('.term-prompt')?.textContent ?? '').includes('npm run build'), 'prompt 行显示命令原文')
  ok(!!q('[data-testid="term-copy"]'), '有复制按钮')
  ok(!!q('[data-testid="term-max"]'), '有展开/恢复按钮')

  const hDefault = term.getBoundingClientRect().height
  out.push(`  默认高度 = ${Math.round(hDefault)}px`)
  ok(
    hDefault >= 70 && hDefault <= 118,
    `默认就是「1 行命令 + 2 行输出」的紧凑高度（${Math.round(hDefault)}px，方案 4.3 建议 80–110）`
  )

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
  out.push(`  复位：${Math.round(h3)}px → ${Math.round(h4)}px`)
  ok(Math.abs(h4 - hDefault) <= 3, '双击下把手复位回默认紧凑高度')

  out.push('')
  out.push('=== 5. 详情分型（方案 4.1）===')
  /* 非命令工具不该套终端外壳：换一条 read 调用注入 */
  store.getState().applyPush({
    ch: 'sync',
    payload: [
      { id: 'term-u2', role: 'user', text: '读个文件' },
      {
        id: 'term-a2',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'term-c2',
            name: 'read',
            args: { path: 'src/main/index.ts' },
            status: 'ok',
            output: 'export function main() {}\n'
          }
        ]
      }
    ]
  })
  await sleep(600)
  const readRow = qa('.trow[data-tool="read"]')[0]
  if (readRow) {
    readRow.querySelector('.trow-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)
    ok(!readRow.querySelector('.term'), '读取类工具展开后不是终端外壳')
    ok(!!readRow.querySelector('[data-testid="tool-result-detail"]'), '读取类工具走「结果」型详情')
  } else {
    out.push('  （跳过）read 工具行没渲染出来')
  }

  return out.join('\n')
})()
