/**
 * 端到端：**模型 → 自己发现 MCP 能力 → describe → call → 拿到结果**（实施-04 S4）。
 *
 * ── 这条为什么非有不可 ──
 *   S4 的出口是「工具**不直接出现在初始 prompt 也能用**」。MCP 工具对 pi 完全不可见
 *   （[证据-04-S1] §2：pi 的 RPC 33 命令里没有工具面 / MCP 面 / 技能正文面），
 *   所以整条链唯一可能走通的方式是：能力目录里出现 MCP 工具 → 模型搜到它 →
 *   `yan mcp describe` 拿 schema → `yan mcp call` 调用。
 *
 *   提示词**不给服务名，也不给工具名，更不提 MCP** —— 给了就只验执行链，验不到发现链。
 *   `mcpcli`（cost 0）已经验过宿主侧「知道工具名时能不能调对」，这里验的是
 *   **模型能不能自己找到那个工具名**。两者不能互相替代。
 *
 * ── 为什么结果必须由工具算 ──
 *   `987654321 × 123456789 = 121932631112635269` 超出 2^53，**心算不可靠**；
 *   再要求「不许自己写脚本算」，模型就只能走工具。真正的因果证据有两条：
 *     · 回复里出现正确结果（说明它拿到了值）；
 *     · **服务端 MARKER 文件**里出现 `compute:mul:…`（说明调用真的到了服务端，
 *       而不是模型自己编了个像样的数字）。
 *   两条必须同时成立。
 *
 * 花 token（cost: 1），只单独跑：`npm run test:live -- capmcp`。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${s}${extra ? '  ' + extra : ''}`)
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  /** 与 capsearch 一致的目标值：只能由 fixture 的 compute 工具算准。 */
  const EXPECTED = '121932631112635269'
  const MARK = `YAN-MCP-PROBE-OK ${EXPECTED}`

  const runBash = async (command, waitMs = 30_000) => {
    const raced = await Promise.race([
      window.yan
        .runBash(command)
        .then((v) => ({ done: 'ok', v }))
        .catch((e) => ({ done: 'err', v: String((e && e.message) || e) })),
      sleep(waitMs).then(() => ({ done: 'timeout' }))
    ])
    if (raced.done !== 'ok') return { ok: false, output: '', error: `命令未在 ${waitMs}ms 内结束（${raced.done}）` }
    /*
     * `runBash` 的**返回值里没有输出**（它只是个句柄）：输出要从 store 里那条
     * bash 工具行上取，并且要等它不再 running —— 与 capability-cli.js 同一套做法。
     */
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(120)
      const msgs = store.getState().messages.filter((m) => m.role === 'bash')
      const last = msgs[msgs.length - 1]
      const call = last?.toolCalls?.[0]
      if (call && call.status !== 'running' && call.status !== 'pending') return { ok: true, output: call.output ?? '' }
    }
    return { ok: false, output: '', error: '等工具行完成超时' }
  }

  log('=== 模型 → MCP 能力发现 → describe → call（端到端）===')
  if (!store) return fail('没有 window.__yanStore')

  const ta = q('[data-testid="composer"]') ?? q('textarea')
  if (!ta) return fail('找不到输入框')

  /*
   * 提示词刻意只给**目标**与**约束**：
   *   · 不提 MCP、不提服务 id、不提工具名 —— 发现必须由模型自己做；
   *   · 不许心算 / 不许自己写脚本 —— 否则模型可以绕过工具直接给答案。
   */
  const PROMPT =
    '请帮我算出一个精确值：987654321 × 123456789。\n' +
    '\n' +
    '要求：\n' +
    '1. 不要自己心算，也不要自己写脚本算 —— 必须通过本机已装好的宿主能力（命令行入口是 `yan`）' +
    '调用一个**已经登记好的计算工具**来完成。\n' +
    `2. 最后把结果原样写进回复里，格式：${MARK}\n` +
    '3. 不要修改仓库里的代码或配置文件，也不要安装任何东西。'

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, PROMPT)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(250)

  const send = q('[data-testid="send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  const roundRunning = () => !!store.getState()?.session?.isAgentRunning
  const deadline = Date.now() + 300_000
  let started = false
  let broke = false
  while (Date.now() < deadline) {
    await sleep(500)
    if (roundRunning()) started = true
    if (started && !roundRunning() && !qa('.trow[data-state="running"]').length) {
      await sleep(1000)
      broke = true
      break
    }
  }

  const messages = store.getState().messages ?? []
  const assistant = messages.filter((m) => m.role === 'assistant')
  const answerText = assistant.map((m) => String(m.text ?? '')).join('\n')

  const calls = []
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      calls.push({
        name: c.name,
        args: c.args ?? {},
        command: String(c.args?.command ?? m.text ?? ''),
        output: String(c.output ?? '')
      })
    }
  }
  const bashCalls = calls.filter((c) => c.name === 'bash')
  const searchCalls = bashCalls.filter((c) => /yan capabilities search/.test(c.command))
  const describeCalls = bashCalls.filter((c) => /yan mcp describe/.test(c.command))
  const callCalls = bashCalls.filter((c) => /yan mcp call/.test(c.command))

  /*
   * 服务端物证：fixture 在 `compute` 被调用时往 MARKER 文件 append 一行。
   * 路径由场景通过 `YAN_MCP_FIXTURE_MARKER` 注入，bash 通道继承得到。
   */
  const markerRead = await runBash(
    'node -e "try{process.stdout.write(require(\'fs\').readFileSync(process.env.YAN_MCP_FIXTURE_MARKER,\'utf8\'))}catch(e){process.stdout.write(\'\')}"'
  )
  const markerText = markerRead.output

  const servedResult = new RegExp(`compute:mul:${EXPECTED}`).test(markerText)
  const answeredRight = new RegExp(MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(answerText)

  log(`  轮次：started=${started} 正常收尾=${broke} conn=${store.getState().conn} 消息数=${messages.length}`)
  log(`  助手回复（前 400 字）：${answerText.slice(0, 400).replace(/\s+/g, ' ')}`)
  log(
    `  bash ${bashCalls.length} 次；capabilities search ${searchCalls.length} 次；` +
      `mcp describe ${describeCalls.length} 次；mcp call ${callCalls.length} 次`
  )
  log('  yan 命令序列：' + JSON.stringify(bashCalls.map((c) => c.command.replace(/\s+/g, ' ').slice(0, 90))))
  log('  服务端 MARKER：' + JSON.stringify(markerText.trim().slice(0, 200)))

  /*
   * 自证因果：提示词里不该出现服务名 / 工具名 / MCP 字样。
   * 标记本身叫 `YAN-MCP-PROBE-OK`（含 MCP），所以比之前先把它摘掉。
   */
  ok(
    !/fixture|compute|mcp/i.test(PROMPT.split(MARK).join('')),
    '提示词不含服务名 / 工具名 / MCP 字样（标记除外；发现只能由模型自己做）'
  )
  ok(bashCalls.length > 0, '模型真的用了 bash')
  ok(searchCalls.length > 0, '模型先搜索能力目录（发现链）')
  ok(describeCalls.length > 0, '模型 describe 拿到参数 schema（用对了工具名）')
  ok(callCalls.length > 0, '模型真的调用了 MCP 工具（执行链）')
  ok(servedResult, '服务端留下物证：compute 真的被调用过（不是模型自己编的答案）', markerText.trim().split('\n')[0] ?? '')
  ok(answeredRight, '回复里给出正确结果（工具结果真的回到了模型）')
  ok(!/不是内部或外部命令|command not found|is not recognized/i.test(answerText), '没有「找不到 yan 命令」')
  ok(!/宿主能力服务不可用/.test(answerText), '没有「宿主不可用」')

  log('--- 说明 ---')
  log('工具行数（DOM）: ' + qa('.trow, .trow-head').length)
  return out.join('\n')
})()
