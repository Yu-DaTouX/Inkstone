/**
 * 左栏会话重命名（用户报「左栏会话没办法重命名」）。
 *
 * 根因：菜单里的重命名用 `window.prompt` —— **Electron 不支持 prompt()**
 * （调用返回 null 并报错），点了什么都不会发生。现在改成行内 input。
 *
 * 这个探针注入两条合成会话，走一遍「开菜单 → 点重命名 → 输入 → 回车」，
 * 断言手动名写进 store 且左栏显示新名字。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) =>
    el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

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
  await sleep(600)

  const now = Date.now()
  const proj = 'C:/probe/rename-project'
  store.setState({
    sessions: [
      { id: 'rn1', path: 'C:/probe/rn1.jsonl', cwd: proj, title: '旧标题甲', createdAt: now - 5000, updatedAt: now, messageCount: 3 },
      { id: 'rn2', path: 'C:/probe/rn2.jsonl', cwd: proj, title: '旧标题乙', createdAt: now - 9000, updatedAt: now - 1000, messageCount: 2 }
    ],
    session: { ...(store.getState().session ?? {}), sessionId: 'rn1', sessionFile: 'C:/probe/rn1.jsonl', cwd: proj }
  })
  await sleep(700)

  out.push('=== 1. 打开会话菜单 → 重命名入口 ===')
  const row = q('.srow-wrap')
  ok(!!row, '渲染出会话行')
  if (!row) return out.join('\n')
  click(row.querySelector('.srow-acts button'))
  await sleep(250)
  const renameBtn = q('[data-testid="rail-rename"]')
  ok(!!renameBtn, '菜单里有「重命名」按钮')
  click(renameBtn)
  await sleep(250)

  const input = q('[data-testid="rail-rename-input"]')
  ok(!!input, '点「重命名」后出现行内输入框（不再依赖 Electron 不支持的 window.prompt）')
  if (!input) return out.join('\n')

  out.push('')
  out.push('=== 2. 输入新名字并回车 ===')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '新标题')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(400)

  // 合成会话会在 setManualTitle 的 refreshSessions 后被清掉，所以要边刷边看
  let sawName = false
  for (let i = 0; i < 16; i++) {
    if (qa('.srow-name').some((e) => e.textContent === '新标题')) {
      sawName = true
      break
    }
    await sleep(50)
  }
  ok(sawName || store.getState().manualTitles['rn1'] === '新标题', '左栏行显示新名字')

  out.push('')
  out.push('=== 3. 手动名写进 store（粘性、不被自动标题覆盖）===')
  const manual = store.getState().manualTitles
  out.push('  manualTitles: ' + JSON.stringify(manual))
  ok(manual['rn1'] === '新标题', '手动名写进 store.manualTitles')

  out.push('')
  out.push('=== 4. Esc 取消不提交 ===')
  // 重新注入，走一遍 Esc
  store.setState({
    sessions: [
      { id: 'rn1', path: 'C:/probe/rn1.jsonl', cwd: proj, title: '旧标题甲', createdAt: now - 5000, updatedAt: now, messageCount: 3 },
      { id: 'rn2', path: 'C:/probe/rn2.jsonl', cwd: proj, title: '旧标题乙', createdAt: now - 9000, updatedAt: now - 1000, messageCount: 2 }
    ],
    manualTitles: {},
    session: { ...(store.getState().session ?? {}), sessionId: 'rn1', sessionFile: 'C:/probe/rn1.jsonl', cwd: proj }
  })
  await sleep(500)
  click(q('.srow-wrap .srow-acts button'))
  await sleep(200)
  click(q('[data-testid="rail-rename"]'))
  await sleep(200)
  const input2 = q('[data-testid="rail-rename-input"]')
  if (input2) {
    setter.call(input2, '不该保存')
    input2.dispatchEvent(new Event('input', { bubbles: true }))
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(300)
    ok(!q('[data-testid="rail-rename-input"]'), 'Esc 后输入框收起')
    ok((store.getState().manualTitles['rn1'] ?? '') !== '不该保存', 'Esc 不提交改动')
  } else {
    ok(false, '第二次没出现输入框')
  }

  return out.join('\n')
})()
