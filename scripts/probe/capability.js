/*
 * 宿主能力服务端到端：**模型 → bash → `yan` CLI → 宿主端点**。
 *
 * 为什么必须有这一条（单测不够）：
 *   capability-server 的单测证明的是「端点本身对不对」；
 *   真正会出错的地方在**接线**上 —— 启动器有没有写对位置、
 *   PATH 有没有前置进 pi 子进程、环境变量有没有被 bash 工具继承、
 *   身份校验在真实调用链里过不过。这些只有让模型真的敲一次 `yan` 才知道。
 *
 * 花 token（cost: 1），所以不在默认门槛里跑。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s)
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

  log('=== 宿主能力服务：模型 → yan CLI → 宿主 ===')

  const ta = q('[data-testid="composer"]')
  if (!ta) return fail('找不到输入框')

  /* 受控组件必须走原生 setter，否则 React 收不到这次输入 */
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(
    ta,
    '必须先调用 bash 工具执行命令 `yan operations status`，' +
      '然后把命令输出里的 operationId（或错误信息）原样贴出来。不要自己编造输出。'
  )
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  const send = q('[data-testid="send"]')
  if (!send || send.disabled) return fail('发送键不可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  /* 等到出现工具行、且流式结束 */
  let sawTool = false
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    await sleep(400)
    if (qa('.trow').length > 0) sawTool = true
    const busy = q('.cursor') || q('.trow[data-state="running"]')
    if (sawTool && !busy) break
  }

  ok(sawTool, '模型发起了工具调用（说明能力入口被用上了）')

  const text = document.body.innerText || ''

  /*
   * 这两条才是真正的接线证据：
   *   · 出现摘要字段 → 端点通了、身份过了、结果管道回得来；
   *   · 没有「找不到命令」→ 启动器与 PATH 注入生效。
   */
  ok(
    /operationId|resultFile|"ok"/.test(text),
    '命令输出里出现了宿主回的结构化摘要',
    text.slice(0, 240)
  )
  ok(
    !/不是内部或外部命令|command not found|is not recognized|No such file/i.test(text),
    'yan 没有报「找不到命令」（启动器 + PATH 注入生效）'
  )
  ok(
    !/宿主能力服务不可用|YAN_CLI_URL/.test(text),
    '没有出现「宿主不可用」（环境变量确实注入了 pi 子进程）'
  )

  log('--- 说明 ---')
  log('工具行数: ' + qa('.trow').length)

  return out.join('\n')
})()
