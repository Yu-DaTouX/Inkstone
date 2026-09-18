/*
 * 项目知识的**注入链**真实回合场景（实施-03 S3，cost 1）。
 *
 * 命题：宿主在用户消息交给 pi 之前检索项目知识并写注入文件，薄层扩展在
 * `before_provider_request` 把它放进上下文；**从设置里关掉后下一轮立刻不注入**。
 *
 * ── 判据为什么在 `afterExit`（Node 侧）──
 * 「这一轮到底注入了什么」只有扩展的诊断日志（`YAN_KNOWLEDGE_EXT_LOG`）与
 * 注入文件知道，而探针按设计读不到 `YAN_DATA_DIR`。所以探针只负责：
 *   ① 真实回合 1（匹配查询）；
 *   ② 从设置里把开关关掉；
 *   ③ 真实回合 2（同样的查询）；
 * 断言交给 `afterExit` 的 `checkKnowledgeInject`（见 test-live.mjs）。
 *
 * 项目知识与条目由 fixture 预置（`knowledgeSeed`），**不调任何写入 IPC** ——
 * 写入通道是 S4 的 CLI，本片不假装它已经存在。
 */
;(async () => {
  const out = []
  const ok = (condition, text, extra = '') => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text + (extra ? `  ${extra}` : ''))
    return !!condition
  }
  const log = (text) => out.push(text)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const S = () => store.getState()

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
    if (S().conn !== 'ready') return `  ⤺ 跳过：pi 未就绪（conn=${S().conn}）`

    const sessionId = S().session?.sessionId ?? ''
    log(`  会话 id = ${sessionId || '(未知)'}`)
    log(`  开关（fixture 预置）= ${JSON.stringify(S().settings?.projectKnowledge ?? null)}`)
    ok(S().settings?.projectKnowledge?.enabled === true, '前置：项目知识开关已被 fixture 打开')

    /*
     * 走 store 的 `send` 而不是点按钮：按钮在「生成中 / 压缩中」会 disabled，
     * 而 disabled 的按钮**不派发 click**（事件被浏览器吞掉，本项目已经踩过三次）。
     * 这条场景要的是「真的走一遍宿主 → pi」，不是验输入框的可用性。
     */
    const send = async (text) => {
      try {
        const ok = await S().send(text)
        if (!ok) {
          const last = (S().notices ?? []).slice(-2).map((n) => n.text ?? n.message ?? '').join(' | ')
          log(`  send 返回失败：${last || '(无通知)'}`)
        }
        return ok
      } catch (error) {
        log('  send 抱错：' + (error?.message ?? String(error)))
        return false
      }
    }

    /** 一个回合：发出 → 真的开始跑 → 真的停下且多了至少一条消息 */
    const turn = async (text, ms) => {
      const before = S().messages.length
      if (!(await send(text))) return { sent: false, started: false, grew: false }
      let started = false
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const running = S().session?.isAgentRunning === true
        if (running) started = true
        if (started && !running) return { sent: true, started: true, grew: S().messages.length > before }
        await sleep(300)
      }
      return { sent: true, started, grew: S().messages.length > before }
    }

    /** 等界面静默下来（上一个回合真结束）——不然下一条消息会被当成插话 */
    const waitIdle = async (ms = 60000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const busy = S().session?.isAgentRunning === true || S().session?.isStreaming === true
        if (!busy) {
          /* 连续两次确认，避免刚好撞在两次流式之间 */
          await sleep(700)
          const still = S().session?.isAgentRunning === true || S().session?.isStreaming === true
          if (!still) return true
        }
        await sleep(300)
      }
      return false
    }

    log('\n=== 1. 开启状态下：真实回合（本轮的注入由 afterExit 断言）===')
    ok(await waitIdle(), '前置：界面已静默（可以发一个干净的新回合）')
    const first = await turn('这次发布流程要怎么走？', 120000)
    ok(first.sent && first.started, '回合 1 真的跑起来了')
    log(`  回合 1：sent=${first.sent} started=${first.started} grew=${first.grew}`)
    await waitIdle()

    log('\n=== 2. 从设置里关掉：下一轮立即不注入 ===')
    await S().patchSettings({ projectKnowledge: { enabled: false } })
    await sleep(500)
    ok(S().settings?.projectKnowledge?.enabled === false, '设置里开关已关（落盘由 afterExit 复查）')

    const second = await turn('这次发布流程要怎么走？', 120000)
    ok(second.sent && second.started, '回合 2 真的跑起来了')
    log(`  回合 2：sent=${second.sent} started=${second.started} grew=${second.grew}`)
    await waitIdle()

    log('\n=== 3. 重新开启 + 无关查询：应当零注入 ===')
    await S().patchSettings({ projectKnowledge: { enabled: true } })
    await sleep(500)
    ok(S().settings?.projectKnowledge?.enabled === true, '开关重新打开')
    const third = await turn('数据库连接池的默认上限是多少？', 120000)
    ok(third.sent && third.started, '回合 3 真的跑起来了')
    log(`  回合 3：sent=${third.sent} started=${third.started} grew=${third.grew}`)
    await waitIdle()

    log('\n=== 4. 收尾 ===')
    log(`  注入文件的断言在 afterExit（会话 ${sessionId || '(未知)'}）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
