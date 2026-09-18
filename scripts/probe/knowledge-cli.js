/*
 * `yan knowledge …` 的真实闭环（实施-03 S4，cost 1）。
 *
 * 命题：模型自己发现并调用随包 CLI —— 检索本项目已确认的知识（`search`）、
 * 并**提议**一条新知识（`propose`）。两个动作都必须真的经过宿主：
 * 身份由宿主绑定（模型给不出 projectId），新条目落 `candidate`（模型不能自证确认）。
 *
 * 断言分工：
 *   · 探针里：工具调用真的出现了，且两条命令各自的回执不是报错；
 *   · afterExit（Node 侧，沙箱退出后）：磁盘上真的多了一条 `candidate` 条目 ——
 *     「工具执行了」不等于「写进去了」（实施-03 §6），所以两边都要看。
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

    const prompt = [
      '请用 bash 依次执行下面三条命令，然后简要报告每条命令的摘要（不要自己编造结果）：',
      '1) yan knowledge search --query-text "发布流程怎么走"',
      '2) yan knowledge propose --kind fact --text "砚的构建产物在 out/ 目录"',
      '3) yan knowledge search --query-text "发布流程" --projectId proj-other',
      '第 3 条按预期应该被拒（身份只认宿主绑定的项目）——把它的错误原文贴出来。'
    ].join(' ')

    const ta = q('[data-testid="composer"]')
    if (!ta) return '✗ 找不到输入框'
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, prompt)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) return '✗ 发送键不可用'
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    /* 等回合真的跑起来再等它结束 */
    let started = false
    const t0 = Date.now()
    while (Date.now() - t0 < 180000) {
      const running = S().session?.isAgentRunning === true
      if (running) started = true
      if (started && !running) break
      await sleep(300)
    }
    ok(started, '真实回合跑起来了')
    await sleep(1500)

    /* 回读会话里的工具调用：两条命令必须都出现过 */
    const texts = []
    for (const message of S().messages ?? []) {
      for (const call of message.toolCalls ?? []) {
        const raw = JSON.stringify(call.args ?? call.input ?? {})
        if (raw) texts.push(raw)
      }
      if (typeof message.text === 'string') texts.push(message.text)
    }
    const blob = texts.join('\n')
    ok(/yan knowledge search/.test(blob), '模型真的执行了 yan knowledge search')
    ok(/yan knowledge propose/.test(blob), '模型真的执行了 yan knowledge propose')
    ok(
      !/unknown_command|not_implemented|宿主能力服务不可用|is not recognized|不是内部或外部命令/i.test(blob),
      '命令没有报「未登记 / 未实现 / CLI 不可用」'
    )
    const idHits = blob.match(/k-[0-9a-f]+|kn-[a-z0-9-]+/g) ?? []
    log(`  回执里出现的条目 id：${idHits.slice(0, 4).join(', ') || '(无)'}`)
    ok(
      /knowledge_project_mismatch|不接受请求里的 projectId/.test(blob),
      '带项目 id 的越权请求被拒（错误可读）',
      blob.includes('projectId') ? '' : '回执里没提到 projectId'
    )
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
