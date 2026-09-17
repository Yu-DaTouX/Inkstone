/**
 * `episode-fold`（任务状态记忆）的**界面关闭路径**取证（P2-7，cost 1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它在验什么：用户从设置面板关掉之后，扩展是不是真的不再生成状态
 * ══════════════════════════════════════════════════════════════════
 * 开关有两个真源（主进程 `resolveContextPolicy` / 扩展 `policy()`），而它们
 * 之间隔着「渲染端 → 主进程 → 写 `desktop.json` → 扩展每轮读文件」四段。
 * 任何一段断了，界面上的开关都会看起来正常而实际无效 —— 这正是只能靠真实窗口
 * 取证的那类故障（单测只能钉两端的纯逻辑）。
 *
 * ── 与 `contextfolddefault` 是一对反向对照 ──
 * 那条场景用**完全相同**的 env（`YAN_CONTEXT_POLICY` 只降会话级门槛到 1/1，
 * **不给 `kinds`**）证明「默认接管集下生成器真的会工作」；本场景在同一条件下
 * 只多做一件事：**从设置面板把它关掉**。于是退出后「一条 `stage:'producer'`
 * 都没有」是可解释的（对照场景在同样条件下有）。
 *
 * env 里**刻意不写 `kinds`**：给了就把被测的那个开关盖掉了（显式 `kinds` 优先）。
 * 而门槛必须降 —— 默认门槛是「≥4 回合且转录 ≥48k token」的一回合会话
 * 必然不满足，那时「关掉」与「没关」都会不生成，看不出任何区别。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
  if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

  const sessionId = S().session?.sessionId ?? ''
  log(`  会话 id = ${sessionId || '(未知)'}`)

  /* ---------------- 1. 从设置面板关掉（用户路径，不碰 env） ---------------- */
  log('')
  log('=== 1. 从设置面板关掉「任务状态记忆」===')
  const before = S().settings?.contextFold
  log(`  关闭前：${JSON.stringify(before ?? null)}（应为 null —— 默认开，磁盘上不该有这个键）`)
  ok(before === undefined || before === null || before.enabled !== false, '关闭前不是「明确关掉」状态')

  S().patchSettings?.({ contextFold: { enabled: false } })
  let after = null
  for (let i = 0; i < 40; i++) {
    await sleep(200)
    after = S().settings?.contextFold
    if (after?.enabled === false) break
  }
  log(`  关闭后：${JSON.stringify(after ?? null)}`)
  ok(after?.enabled === false, '设置面板关闭后 store 里是 enabled:false')
  /* 顺带确认另一个开关没被这一步误伤（两者共用一份桌面端设置缓存） */
  ok(S().settings?.contextDeep?.enabled !== true, 'Deep Context 没有被连带打开')
  /*
   * 扩展侧对 `desktop.json` 有 1 秒缓存（`desktopSettings`）—— 发回合前越过它，
   * 否则可能读到关闭之前的策略，本场景就变成「开着」的重复，而断言会全绿。
   */
  await sleep(1500)

  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    if (!ta) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
    const button = q('[data-testid="send"]')
    if (!button) return false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  /** 一个回合：发出 → 等到真的开始跑 → 等到停下 */
  const turn = async (text, ms) => {
    if (!(await send(text))) return { sent: false, started: false }
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const running = !!S().session?.isAgentRunning || !!S().session?.isStreaming
      if (running) started = true
      else if (started) return { sent: true, started: true }
      await sleep(400)
    }
    return { sent: true, started }
  }

  /* ---------------- 2. 真实回合：形态必须与对照场景一致 ---------------- */
  log('')
  log('=== 2. 真实回合（一次工具调用 —— 与 contextfolddefault 同样的形态）===')
  const PROMPT =
    '你必须先调用 bash 工具执行这条命令：node -e "console.log(\'fold-off-probe\')" 。' +
    '执行完成后，只回复这一行输出。不要省略工具调用。'
  let t1 = await turn(PROMPT, 180_000)
  const toolOutputs = () =>
    (S().messages ?? []).flatMap((m) => m.toolCalls ?? []).map((t) => ({ name: t.name, len: (t.output ?? '').length }))
  let outputs = toolOutputs()
  if (!outputs.length) {
    log('  第一次没看到工具调用，重试一次（否则「不生成」可能只是因为回合没产生原料）')
    t1 = await turn(PROMPT, 180_000)
    outputs = toolOutputs()
  }
  log(`  回合已发出=${t1.sent}｜真的跑起来=${t1.started}｜消息数=${(S().messages ?? []).length}`)
  log('  工具调用: ' + JSON.stringify(outputs))
  ok(!!outputs.length, '模型真的调用了工具（对照场景靠它产生 evidence；有原料却不生成才是开关的功劳）', outputs.length ? outputs[0].name : '')

  /*
   * 等得比对照场景**短**是有意的：关闭时代码在 `onAgentSettled` 第一行就 return，
   * 连诊断都不写，所以这里等的是「万一它其实在跑」的宽限，不是生成耗时。
   */
  log('')
  log('=== 3. 留出生成窗口（关闭时本不该有任何动作）===')
  await sleep(15_000)
  ok(!S().session?.isAgentRunning, '等待期间没有卡在「运行中」')

  out.push(`  ctxfoldpref.sessionId=${sessionId}`)
  out.push(`  ctxfoldpref.toolCalls=${outputs.length}`)
  return out.join('\n')
})()
