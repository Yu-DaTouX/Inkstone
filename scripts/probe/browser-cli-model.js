/**
 * 端到端：**模型 → bash → `yan browser …` → 结构化结果 → 基于结果继续下一轮**（01-S4b）。
 *
 * ── 与 `browsercli` 的分工 ──
 *   `browsercli`（cost 0）用直执行 shell 通道验 CLI ↔ 宿主这一层，确定性、不花 token；
 *   这一条只验**模型真的会不会这么用**：它得自己在 bash 里敲 `yan browser navigate`，
 *   读出回执里的结构化结果，再据此决定下一步（`yan browser observe`）。
 *
 * ── 为什么必须有 ──
 *   01-S4b 把 16 个 `browser_*` 模型工具全删了。删掉之后模型能拿到浏览器能力的
 *   **唯一**途径就是能力入口说明 + `yan --help`。如果说明没让它用起来，
 *   `browsercli` 全绿也证明不了产品还能用 —— 那正是 01-S5 移除扩展装载时最大的风险。
 *
 * 花 token（cost: 1），只在需要时单独跑：`npm run test:live -- browserclimodel`。
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

  log('=== 模型 → yan browser（端到端）===')
  if (!store) return fail('没有 window.__yanStore')

  const ta = q('[data-testid="composer"]') ?? q('textarea')
  if (!ta) return fail('找不到输入框')

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  /*
   * 提示里**故意不给命令名**：本片删掉了 16 个工具，真正的风险是
   * 「模型还能不能自己找到 `yan browser`」——那是 01-S5 的能力丢失风险。
   * 如果直接告诉它敲什么，就只验了执行链，验不到发现链。
   */
  setter.call(
    ta,
    '我需要你确认砚的内置浏览器现在能不能用。请自己找到砚提供的能力入口，' +
      '打开一个空白页（about:blank），然后确认它真的打开了，并告诉我当前页面 URL 与页面上的可交互元素数量。' +
      '不要安装任何东西，也不要改代码或读仓库文件。'
  )
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(250)

  const send = q('[data-testid="send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  const roundRunning = () => !!store.getState()?.session?.isAgentRunning
  const deadline = Date.now() + 200_000
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
  const text = answerText
  const calls = []
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      calls.push({
        name: c.name,
        /* 命令正文在 args 里；output 只是 stdout（所以不能用它认“敲了哪条命令”） */
        command: String(c.args?.command ?? m.text ?? ''),
        output: String(c.output ?? '')
      })
    }
  }
  const bashCalls = calls.filter((c) => c.name === 'bash')
  const yanCalls = bashCalls.filter((c) => /(^|[\s"'])yan[\s"']/.test(c.command))
  const navigateCalls = bashCalls.filter((c) => /yan browser navigate|yan browser open/.test(c.command))
  const observeCalls = bashCalls.filter((c) => /yan browser observe|yan browser state/.test(c.command))
  const navigateOk = navigateCalls.some((c) => /"ok":true/.test(c.output))
  const observeOk = observeCalls.some((c) => /generationId|elements/.test(c.output))
  const state = store.getState().browserState ?? {}

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
  log(`  bash 工具调用 ${bashCalls.length} 次；其中 yan ${yanCalls.length} 次、navigate ${navigateCalls.length} 次、observe/state ${observeCalls.length} 次`)
  log('  yan 命令序列：' + JSON.stringify(yanCalls.map((c) => c.command.replace(/\s+/g, ' ').slice(0, 70))))
  log(`  宿主浏览器状态：open=${state.open} url=${state.url}`)
  ok(bashCalls.length > 0, '模型真的用了 bash（不是自己编输出）')
  ok(yanCalls.length > 0, '模型**自己找到了** `yan` 能力入口（提示里没给命令名）')
  ok(navigateCalls.length > 0 && navigateOk, '模型敲了 `yan browser navigate/open` 并拿到 ok 回执')
  ok(observeCalls.length > 0 && observeOk, '模型**基于回执继续**敲了 `yan browser observe/state`')
  ok(state.open === true && state.url === 'about:blank', '宿主真的打开了 about:blank（CLI → 宿主链路生效）')
  ok(/about:blank/.test(text), '模型答出了当前页面 URL')
  ok(
    !/不是内部或外部命令|command not found|is not recognized/i.test(text),
    '没有「找不到 yan 命令」（PATH 前置 + 启动器生效）'
  )
  ok(!/宿主能力服务不可用/.test(text), '没有「宿主不可用」（YAN_CLI_* 真的注入了 pi 子进程）')
  ok(!/unknown_command/.test(text), '没有 unknown_command（命令三处登记一致）')

  log('--- 说明 ---')
  log('工具行数（DOM）: ' + qa('.trow, .trow-head').length)
  return out.join('\n')
})()
