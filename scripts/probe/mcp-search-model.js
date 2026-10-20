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

  const ta = q('[data-testid="composer-input"]')
  if (!ta) return fail('找不到输入框')

  const PROMPT =
    '请帮我算出一个精确值：987654321 × 123456789。\n' +
    '\n' +
    '要求：\n' +
    '1. 不要自己心算，也不要自己写脚本算 —— 必须通过本机已装好的宿主能力（命令行入口是 `yan`）' +
    '调用一个**已经登记好的计算工具**来完成。\n' +
    `2. 最后把结果原样写进回复里，格式：${MARK}\n` +
    '3. 不要修改仓库里的代码或配置文件，也不要安装任何东西。'

  window.__yanComposer.set(PROMPT, ta)
  await sleep(250)

  const send = q('[data-testid="composer-send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  const roundRunning = () => !!store.getState()?.session?.isAgentRunning
  const deadline = Date.now() + 300_000
  let started = false
  let broke = false
  while (Date.now() < deadline) {
    await sleep(500)
    if (roundRunning()) started = true
    if (started && !roundRunning() && !qa('.v3-step[data-state="running"]').length) {
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
  log('工具行数（DOM）: ' + qa('.v3-step').length)
  return out.join('\n')
})()
