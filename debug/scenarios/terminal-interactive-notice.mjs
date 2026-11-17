import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '交互式终端 write 派任务后后台等完成标记，程序不退出也发通知并唤醒空闲 agent；本机 Node fixture 与假模型，不调用真实服务商' }

export default async function run({ cdp, box, fake, newSession, turn, waitFor, check, sleep, shot, report }) {
  const ev = (code) => cdp.evaluate(code)
  await newSession(box.project)
  await ev('window.__yanRightPanel.getState().open({ id: "terminal", kind: "terminal" })')
  await waitFor('document.querySelector("[data-testid=terminal-pane]")?.getAttribute("data-phase") === "ready"', 30000)
  const terminal = (await ev('window.yan.terminal.list()')).find((item) => item.alive)
  if (!terminal) throw new Error('没有可用的隔离终端')

  const fixture = join(box.project, 'interactive-client.mjs')
  writeFileSync(fixture, [
    "import { createInterface } from 'node:readline'",
    "const input = createInterface({ input: process.stdin })",
    "console.log('INTERACTIVE_READY')",
    "input.on('line', (line) => {",
    "  console.log('working: ' + line)",
    "  setTimeout(() => process.stdout.write(String.fromCharCode(27) + '[2J' + String.fromCharCode(27) + '[HINTERACTIVE_REPLY_DONE' + String.fromCharCode(27) + '[2;1Hwaiting for next input'), 5000)",
    "})"
  ].join('\n'))
  const startCommands = join(box.project, 'start-interactive.json')
  writeFileSync(startCommands, JSON.stringify([
    `yan terminal run --id ${terminal.id} --command 'node ${JSON.stringify(fixture.replaceAll('\\', '/'))}' --until '^INTERACTIVE_READY$'`
  ]))
  await turn(`CMDFILE=${startCommands}`, { timeout: 60000 })

  const dispatchCommands = join(box.project, 'dispatch-interactive.json')
  writeFileSync(dispatchCommands, JSON.stringify([
    `yan terminal write --id ${terminal.id} --text review --enter --background --until '^INTERACTIVE_REPLY_DONE$' --wait 0 --timeout 60`
  ]))
  await turn(`CMDFILE=${dispatchCommands}`, { timeout: 60000 })
  const outputs = await ev(`(() => {
    const out = []
    for (const m of window.__yanStore.getState().messages) for (const tool of m.toolCalls || []) {
      if (!String(tool.args?.command).startsWith('yan terminal write')) continue
      try { out.push(JSON.parse(String(tool.output).split('\\n')[0])) } catch {}
    }
    return out
  })()`)
  const started = outputs.at(-1)?.summary
  check('write 先返回 background 与 jobId', started?.state === 'background' && !!started.jobId, started)
  check('回复前主会话已经空闲，无需轮询终端', await ev('!window.__yanStore.getState().session?.isAgentRunning && !window.__yanStore.getState().session?.isStreaming'))
  const requestsBefore = fake.requests.length
  await shot('waiting-interactive-reply')

  const notice = 's.messages.find((m) => m.role === "user" && String(m.text || "").startsWith("[砚宿主通知：后台终端命令]") && String(m.text).includes("INTERACTIVE_REPLY_DONE"))'
  await waitFor(`!!(${notice})`, 20000)
  await waitFor(`!s.session?.isAgentRunning && !s.session?.isStreaming`, 20000)
  await sleep(400)
  const text = await ev(`(() => { const s = window.__yanStore.getState(); return (${notice})?.text ?? '' })()`)
  check('程序回复后收到 matched 宿主通知', text.includes('matched') && text.includes('INTERACTIVE_REPLY_DONE'), text)
  check('宿主通知自动唤醒了空闲模型', fake.requests.length > requestsBefore, { requestsBefore, requestsAfter: fake.requests.length })
  check('通知在消息流中显示为宿主提示', await ev('!!document.querySelector("[data-testid=v3-host-notice]")'))
  const after = await ev('window.yan.terminal.list()')
  check('交互式程序所在终端仍存活，没有为了结束等待而关闭', after.some((item) => item.id === terminal.id && item.alive), after.map(({ id, alive }) => ({ id, alive })))
  check('原来的用户标签被复用，仍只有一个 xterm', await ev('document.querySelectorAll(".term-pane-host").length === 1'))
  report.interactive = { terminalId: terminal.id, jobId: started?.jobId, requestsBefore, requestsAfter: fake.requests.length, notice: text }
  await shot('interactive-reply-woke-agent')
}
