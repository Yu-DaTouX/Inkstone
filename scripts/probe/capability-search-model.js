/**
 * 端到端：**模型 → 自己发现能力 → 读技能正文 → 按技能产出回执**（实施-04 S2）。
 *
 * ── 这条为什么非有不可 ──
 *   04-S2 出货的是「能力目录 + 按需读技能正文」。单测能证明目录的过滤 / 打分 /
 *   去重是对的，但证明不了**模型真的会走这条路**：它得自己从能力说明找到
 *   `yan capabilities search`，从候选里挑出那个技能，再 `yan skill read` 读正文。
 *   这里提示词**不给命令名，也不给技能名** —— 给了就只验执行链，验不到发现链。
 *
 * ── 为什么标记能当产物证据 ──
 *   技能正文里那行 `YAN-CAPABILITY-PROBE-OK 7f3a91` **只存在于技能文件里**；
 *   提示词、夹具、别处都没有。模型只有真的读到技能正文，才可能写出它 ——
 *   所以「回复里出现这行」与「文件里出现这行」共同构成因果证据，而不是巧合。
 *
 * 花 token（cost: 1），只单独跑：`npm run test:live -- capsearch`。
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

  const MARK = 'YAN-CAPABILITY-PROBE-OK 7f3a91'

  log('=== 模型 → 能力发现 → 技能正文（端到端）===')
  if (!store) return fail('没有 window.__yanStore')

  const ta = q('[data-testid="composer"]') ?? q('textarea')
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

  const send = q('[data-testid="send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  const roundRunning = () => !!store.getState()?.session?.isAgentRunning
  const deadline = Date.now() + 240_000
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
        /* 命令正文在 args 里；output 只是 stdout，不能拿它认“敲了哪条命令”。 */
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
  /*
   * 读技能正文有**两条官方路径**（[证据-04-S1] §4.3）：
   *   ① 模型用 pi 的 `read` 工具直接读 SKILL.md（system prompt 里就给了 location）；
   *   ② 宿主侧 `yan skill read`（确定性入口，额外给 contentHash 与来源追踪）。
   * 实测模型默认走 ① —— 这不是缺陷，是本片就该接受的现实；
   * 所以这里**只断言「正文读到了」**，至于 ② 的链路是否可用，由 cost 0 的
   * `capcli` 场景直接对宿主验（分工与 browsercli / browserclimodel 一致）。
   */
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
  log('工具行数（DOM）: ' + qa('.trow, .trow-head').length)
  return out.join('\n')
})()
