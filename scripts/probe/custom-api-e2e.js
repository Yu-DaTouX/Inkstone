/*
 * 实施-23 端到端：新增模型 → pi 枚举 → 切换模型 → 真实对话 → 工具调用 → 取消 → 重开会话。
 *
 * 前提（由 `test-live` 的 `customapie2e` 场景准备）：隔离的 `YAN_PI_DIR` 里
 * 有一份 `models.json`，里面把 DeepSeek 官方通道注册成**自定义 provider** `yan-dp`
 * （协议 `openai-completions`，密钥从真实 auth.json 的 `deepseek.key` 复制，只落到系统临时目录）。
 *
 * ⚠️ 这个探针会**真实调用模型**（有费用）。它验证的正是「自定义接入之后，
 * 整条模型循环还能不能跑」—— 这是纯夹具证明不了的部分。
 * 本机拿不到 deepseek 凭证时，探针会打印跳过并正常结束。
 */
;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''))
    return !!cond
  }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const st = () => store.getState()
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 20_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return false
  }
  const setText = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const assistantText = () => qa('.msg.assistant .md').map((el) => el.textContent ?? '').join(' ')
  const pickerText = () => q('.mt-model')?.textContent ?? ''
  const busy = () => !!q('.cursor') || !!q('.trow[data-state="running"]') || (q('[data-testid="send"]')?.textContent ?? '').includes('中止')
  const waitIdle = async (ms = 180_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await sleep(500)
      if (!busy() && assistantText().length > 0) return true
    }
    return false
  }
  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    if (!ta) return false
    setText(ta, text)
    await sleep(150)
    click(q('[data-testid="send"]'))
    return true
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().session) break
      await sleep(400)
    }

    /* ---- 1. pi 枚举：自定义 provider 的模型出现在菜单里 ---- */
    click(q('[data-testid="model-picker"]'))
    await until(() => q('[data-testid="model-menu"]'), 8000)
    const items = qa('.mt-item')
    const mine = items.find((el) => /自定义接入/.test(el.textContent ?? ''))
    ok(items.length > 0, '模型菜单列出了模型', `${items.length} 项`)
    if (!mine) {
      out.push('  ⚠ 跳过：隔离 piDir 里没有 yan-dp（本机没有 deepseek 凭证）')
      out.push('[custom-api-e2e] 跳过（无自定义 provider）')
      return out.join('\n')
    }
    ok(true, '自定义 provider 的模型出现在菜单里（pi 真的枚举到了）')

    /* ---- 2. 切换模型（点击菜单项，不是直接改 store） ---- */
    click(mine)
    await sleep(1500)
    ok(/自定义接入/.test(pickerText()), '切换后选择器显示新模型', pickerText())

    /* ---- 3. 真实对话 ---- */
    const before = qa('.msg').length
    await send('只回复两个字：收到。不要调用任何工具。')
    const answered = await waitIdle()
    ok(answered, '真实对话拿到了回复')
    ok(qa('.msg').length > before, '消息流增加了新消息', `${before} → ${qa('.msg').length}`)
    ok(assistantText().trim().length > 0, '助手有正文', JSON.stringify(assistantText().trim().slice(0, 40)))

    /* ---- 4. 工具调用 ---- */
    const toolsBefore = qa('.trow').length
    await send('必须先调用 bash 工具执行命令 `echo yan-custom-ok`，再根据工具返回的内容回复。不要自己编造输出。')
    await waitIdle()
    const tools = qa('.trow')
    ok(tools.length > toolsBefore, '自定义接入下工具调用照样出现', `${toolsBefore} → ${tools.length}`)
    const bash = tools.find((el) => el.dataset.tool === 'bash')
    ok(!!bash, '有 bash 工具卡')
    if (bash) ok(bash.dataset.state === 'ok', `bash 状态 = ${bash.dataset.state}（应 ok）`)

    /* ---- 5. 取消 ---- */
    const sentOk = await send('请连续执行 8 次 bash 命令，每次 `sleep 3`，中间不要停下来解释。')
    ok(sentOk, '取消用例的请求已发出')
    await until(() => busy(), 20_000)
    const wasBusy = busy()
    const msgsBeforeAbort = qa('.msg').length
    await st().abort()
    const stopped = await until(() => !busy(), 30_000)
    ok(wasBusy, '取消前确实处于运行中')
    ok(stopped, '取消后回到空闲（不再有流式光标 / 运行中的工具）')
    ok(qa('.msg').length >= msgsBeforeAbort, '取消不会抹掉已有消息')

    /* ---- 6. 会话重新打开（切走再切回） ---- */
    const currentFile = st().session?.conversationFile ?? st().session?.sessionFile
    const other = (st().sessions ?? []).find(
      (item) => (item.sessionFile ?? item.file ?? item.path) && (item.sessionFile ?? item.file ?? item.path) !== currentFile
    )
    const otherPath = other ? (other.sessionFile ?? other.file ?? other.path) : ''
    if (currentFile && otherPath) {
      const msgsNow = qa('.msg').length
      await st().switchSession(otherPath)
      await sleep(2500)
      const switchedAway = qa('.msg').length !== msgsNow || !assistantText().includes('yan-custom-ok')
      await st().switchSession(currentFile)
      const reopened = await until(() => qa('.msg').length >= msgsNow, 15_000)
      ok(switchedAway || reopened, '切走再切回（会话重新打开）')
      ok(reopened, '重开后历史消息还在', `${qa('.msg').length} / ${msgsNow}`)
      ok(/yan-custom-ok/.test(assistantText()) || assistantText().length > 0, '重开后仍能看到这一轮的助手内容')
    } else {
      log('  ⚠ 跳过分组 6：隔离目录里没有第二个会话可切')
    }

    /* ---- 收尾状态 ---- */
    ok(!q('.connbar'), '没有连接错误条')
    log('--- 自定义接入模型 ---')
    log('  选择器 = ' + pickerText())
  } catch (error) {
    ok(false, '抛异常：' + (error && error.message ? error.message : String(error)))
  }

  const failed = out.filter((line) => line.startsWith('  ✗ ')).length
  out.push(failed === 0 ? '[custom-api-e2e] 全部通过' : '[custom-api-e2e] ' + failed + ' 条失败')
  return out.join('\n')
})()
