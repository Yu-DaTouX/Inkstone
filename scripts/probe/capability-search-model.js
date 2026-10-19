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

  const MARK = 'YAN-CAPABILITY-PROBE-OK 7f3a91'

  log('=== 模型 → 能力发现 → 技能正文（端到端）===')
  if (!store) return fail('没有 window.__yanStore')

  const ta = q('[data-testid="composer-input"]') ?? q('textarea')
  if (!ta) return fail('找不到输入框')

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(
    ta,
    '请帮我验证砚的「能力发现」现在是否可用：先看看你这会儿有哪些能力可用，' +
      '如果其中有一个和能力探测 / 回执有关的技能，就按它正文里写的步骤把它要求的事做掉。' +
      '不要修改仓库里的代码或配置文件，也不要安装任何东西。'
  )
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(250)

  const send = q('[data-testid="composer-send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  const roundRunning = () => !!store.getState()?.session?.isAgentRunning
  const deadline = Date.now() + 240_000
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
  const yanCalls = bashCalls.filter((c) => /(^|[\s"'])yan[\s"']/.test(c.command))
  const searchCalls = bashCalls.filter((c) => /yan capabilities search/.test(c.command))
  const skillReadCalls = bashCalls.filter((c) => /yan skill read/.test(c.command))
  const writeCalls = bashCalls.filter((c) => /capability-probe\.txt/.test(c.command))
  const readToolCalls = calls.filter(
    (c) => c.name === 'read' && /yan-capability-probe[\\/]SKILL\.md/i.test(String(c.args?.path ?? ''))
  )
  const searchOk = searchCalls.some((c) => /"ok"\s*:\s*true/.test(c.output))
  const produced = writeCalls.some((c) => c.output.includes(MARK)) || answerText.includes(MARK)
  const readPath =
    readToolCalls.length > 0
      ? 'pi read 工具（官方路径）'
      : skillReadCalls.length > 0
        ? 'yan skill read'
        : '无'

  log(`  轮次：started=${started} 正常收尾=${broke} conn=${store.getState().conn} 消息数=${messages.length}`)
  log(
    '  消息明细：' +
      JSON.stringify(
        messages.map((m) => ({
          role: m.role,
          len: String(m.text ?? '').length,
          tools: (m.toolCalls ?? []).length,
          err: m.error ?? null
        }))
      )
  )
  log(`  助手回复（前 300 字）：${answerText.slice(0, 300).replace(/\s+/g, ' ')}`)
  log(`  bash ${bashCalls.length} 次；yan ${yanCalls.length} 次；capabilities search ${searchCalls.length} 次；skill read ${skillReadCalls.length} 次；读正文路径 = ${readPath}`)
  log('  yan 命令序列：' + JSON.stringify(yanCalls.map((c) => c.command.replace(/\s+/g, ' ').slice(0, 70))))

  ok(bashCalls.length > 0, '模型真的用了 bash')
  ok(yanCalls.length > 0, '模型**自己找到了** `yan` 能力入口（提示里没给命令名）')
  ok(searchCalls.length > 0 && searchOk, '模型敲了 `yan capabilities search` 并拿到 ok 回执')
  ok(readToolCalls.length > 0 || skillReadCalls.length > 0, '模型读到了技能正文（两条官方路径任一）', readPath)
  ok(produced, '按技能正文产出回执（标记只存在于技能文件里 → 证明确实读了正文）')
  ok(!/不是内部或外部命令|command not found|is not recognized/i.test(answerText), '没有「找不到 yan 命令」')
  ok(!/宿主能力服务不可用/.test(answerText), '没有「宿主不可用」（YAN_CLI_* 真的注入了 pi 子进程）')
  ok(!/unknown_command/.test(answerText), '没有 unknown_command（命令三处登记一致）')

  log('--- 说明 ---')
  log('工具行数（DOM）: ' + qa('.v3-step').length)
  return out.join('\n')
})()
