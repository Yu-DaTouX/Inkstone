/*
 * 回合计时的**落盘与读回**（实施-11 H-6，cost 1）。
 *
 * `turnfooter`（cost 0）验呈现、`turnfooterlive` 验主进程怎么算；这条补的是
 * H-6 的原始问题：**pi 的会话 JSONL 不存 `elapsedMs`**，所以切会话 / 重载后
 * 整轮用时丢失。这里跑一个真实回合，然后：
 *
 *   1. 界面上有「用时」；
 *   2. `peekSession()` —— 走的是**读文件**那条路（切会话时先用它铺内容）——
 *      回来的消息带 `turnTiming`，且用时与界面一致；
 *   3. 退出后由 `afterExit` 核对元数据日志真的落在 `YAN_DATA_DIR/turn-timing/`。
 *
 * 三条一起才说明「用时不是只活在内存里的推送字段」。
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
  const until = async (fn, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const ta = q('[data-testid="composer"]')
    ok(!!ta, '输入框可用')
    if (!ta) return out.join('\n')

    setVal(ta, 'In one short sentence: what does this fixture repository contain?')
    await sleep(300)
    const send = q('[data-testid="send"]')
    ok(!!send && !send.disabled, '发送键可用')
    const t0 = Date.now()
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ok(await until(() => !!store.getState().session?.isAgentRunning, 30000), '模型开始处理')
    const done = await until(() => !store.getState().session?.isAgentRunning, 180000)
    const wall = Date.now() - t0
    ok(done, `回合结束（墙钟 ${(wall / 1000).toFixed(1)}s）`)
    await sleep(1800)

    const all = store.getState().messages
    let lastUser = -1
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].role === 'user') {
        lastUser = i
        break
      }
    }
    const turnMsgs = all.slice(lastUser + 1).filter((m) => m.role === 'assistant')
    const asst = [...turnMsgs].reverse().find((m) => m.elapsedMs)
    ok(!!asst?.elapsedMs, `助手消息带 elapsedMs（${asst?.elapsedMs ?? '-'}ms）`)
    if (!asst?.elapsedMs) return out.join('\n')
    out.push(`  turn-timing.liveElapsedMs=${asst.elapsedMs}`)
    out.push(`  turn-timing.error=${JSON.stringify(asst.error ?? null)} text=${JSON.stringify((asst.text ?? '').slice(0, 40))}`)

    const footers = [...document.querySelectorAll('[data-testid="turn-footer"]')]
    const footer = footers[footers.length - 1]
    ok(!!footer, '最后一个回合有页脚')
    ok(/用时/.test(footer?.textContent ?? ''), `页脚显示用时：「${(footer?.textContent ?? '').replace(/\s+/g, ' ').trim()}」`)

    /* ---- 读回：peekSession 走的是文件路径，不是内存里的推送字段 ---- */
    const session = store.getState().session
    const sessionFile = session?.sessionFile
    out.push(`  turn-timing.sessionFile=${sessionFile ?? ''}`)
    ok(!!sessionFile, '拿到会话文件路径（否则无法验读回）')
    if (!sessionFile) return out.join('\n')

    const peek = await window.yan.peekSession(sessionFile)
    ok(!!peek, 'peekSession 返回了历史')
    const messages = peek?.messages ?? []
    const timingMsgs = messages.filter((m) => m.turnTiming)
    ok(
      timingMsgs.length >= 1,
      `读回的历史里有 ${timingMsgs.length} 条消息带宿主计时记录（磁盘→界面这条路通了）`
    )
    const record = timingMsgs[timingMsgs.length - 1]?.turnTiming
    ok(!!record, '记录形状可用')
    if (record) {
      out.push(
        `  turn-timing.record=${JSON.stringify({ ms: record.elapsedMs, reason: record.terminalReason, ids: record.logicalTurnId ? 'yes' : 'no' })}`
      )
      ok(record.elapsedMs > 0, `读回的用时是正数（${record.elapsedMs}ms）`)
      ok(
        Math.abs(record.elapsedMs - asst.elapsedMs) <= Math.max(1500, asst.elapsedMs * 0.2),
        `读回用时与界面用时同一量级（${record.elapsedMs} ≈ ${asst.elapsedMs}）`
      )
      ok(
        record.terminalReason === (asst.error ? 'failed' : 'completed'),
        `终止原因与消息状态一致（${record.terminalReason}；消息 error=${asst.error ?? 'none'}）`
      )
      out.push(`  turn-timing.expectedReason=${asst.error ? 'failed' : 'completed'}`)
      ok(
        messages.filter((m) => m.turnTiming?.logicalTurnId === record.logicalTurnId).length === 1,
        '同一逻辑回合只挂一条（不会重复计）'
      )
    }
    /* 旧的 JSONL 里没有 elapsedMs —— 用时只能是宿主日志来的 */
    ok(
      messages.filter((m) => m.role === 'assistant').every((m) => m.elapsedMs === undefined),
      'pi 的 JSONL 确实不存 elapsedMs（所以恢复只能靠宿主元数据）'
    )
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
