/**
 * Deep Context 的**界面路径**取证（cost 1）。
 *
 * 与 `contextdeep` 的分工：
 *   · `contextdeep` 走 `YAN_CONTEXT_POLICY`（**测试通道**），验的是「链路通不通」；
 *   · 本场景走**设置面板**（`patchSettings({ contextDeep })`，用户真正按的那条路），
 *     验的是「设置有没有真的传到扩展」。
 *
 * 为什么这两件事要分开验：扩展读的是 `desktop.json`（不是 env），中间隔着
 * 「渲染端 → 主进程 → 写盘 → 扩展读文件」四段。任何一段断了，界面上的开关
 * 都会看起来正常而实际无效 —— 这正是需要真实窗口取证的那类故障。
 *
 * ⚠️ 本场景**不会**产生注入：探针会话只有几 k token，而真实门槛是 150k
 * （`DEEP_MIN_TOKENS`），所以预期是 `stage:'deep'` 的 `skipped: below-threshold`。
 * 那一条**恰好就是证据**：它只在「扩展认为开关是开的」时才可能出现
 * （`if (p.deep.enabled)` 才进 `runDeepPass`）。注入本身由 `contextdeep` 验。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(400)
  S().closeSettings?.()
  await sleep(200)

  for (let i = 0; i < 60; i++) {
    if (S().conn === 'ready' && S().session?.model?.contextWindow) break
    await sleep(500)
  }
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`
  out.push(`  ctxdeeppref.sessionId=${S().session?.sessionId ?? ''}`)

  log('')
  log('=== 1. 从设置面板打开（用户路径，不碰 env）===')
  const before = S().settings?.contextDeep
  log(`  打开前：${JSON.stringify(before ?? null)}（应为 null —— 默认关，磁盘上不该有这个键）`)
  ok(before === undefined || before === null, '打开前设置里没有 contextDeep（默认关）')

  S().patchSettings?.({ contextDeep: { enabled: true } })
  /* 等回写落定（patchSettings 是异步 IPC，要等 settings 从主进程回来） */
  let after = null
  for (let i = 0; i < 40; i++) {
    await sleep(200)
    after = S().settings?.contextDeep
    if (after?.enabled === true) break
  }
  log(`  打开后：${JSON.stringify(after ?? null)}`)
  ok(after?.enabled === true, '设置面板打开后 store 里是 enabled:true')

  log('')
  log('=== 2. 发一个回合（扩展要走过 context 钩子才会读设置）===')
  const box = q('[data-testid="composer"]')
  if (!box) return out.join('\n')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
    box,
    '运行 `node -e "console.log(3*4)"`，然后只回复结果。'
  )
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  const btn = q('[data-testid="send"]')
  if (!btn) return out.join('\n')
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  let started = false
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (S().session?.isAgentRunning || S().session?.isStreaming) started = true
    else if (started) break
    await sleep(400)
  }
  ok(started, '回合真的跑起来了')
  await sleep(3000)

  log('')
  log('=== 3. 关掉（不能留下一个开了的设置影响别的场景）===')
  S().patchSettings?.({ contextDeep: { enabled: false } })
  await sleep(800)
  const off = S().settings?.contextDeep
  log(`  关掉后：${JSON.stringify(off ?? null)}（undefined 才对 —— 「没改过」与「明确关掉」要能区分）`)
  ok(off === undefined || off === null || off.enabled !== true, '关掉后不再是开启状态')

  return out.join('\n')
})()
