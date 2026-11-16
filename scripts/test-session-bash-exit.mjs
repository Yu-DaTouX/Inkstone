import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentTestBuildOptions } from './lib/agent-test-bundle.mjs'
import { runSuite } from './lib/test-suite.mjs'

const FAKE_PI = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (part) => {
  buffer += part
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.type === 'bash') {
      process.stdout.write(JSON.stringify({ type: 'tool_execution_update', toolCallId: 'none' }) + '\\n')
      setTimeout(() => process.exit(3), 80)
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`

await runSuite(import.meta.url, async (ok, compile) => {
  const { AgentController } = await compile('src/main/agent.ts', agentTestBuildOptions)
  const dir = await mkdtemp(join(tmpdir(), 'yan-bash-exit-'))
  const piBin = join(dir, 'fake-pi.mjs')
  await writeFile(piBin, FAKE_PI, 'utf8')
  const pushes = []
  const ctl = new AgentController({ cwd: dir, piBin, push: (m) => pushes.push(m) })
  ctl.maybeGenerateTitle = async () => null
  try {
    const started = await ctl.start()
    ok(started.ok, '假 pi 启动成功', started.error)
    const result = await ctl.runBash('echo hi')
    ok(!result.ok, 'pi 在命令执行中退出时 runBash 返回失败', JSON.stringify(result))
    const added = pushes.find((m) => m.ch === 'msg-add' && m.payload.role === 'bash')
    ok(!!added, '命令开始时推送了 bash 消息')
    const update = pushes.filter((m) => m.ch === 'msg-update' && m.payload.id === added?.payload.id).at(-1)
    ok(update?.payload.patch.bash?.cancelled === true && update.payload.patch.toolCalls?.[0]?.status === 'error', 'pi 退出时把运行中的 bash 消息结束态推送到渲染端', JSON.stringify(update?.payload))
    const stored = ctl.items.uiMessages().find((m) => m.id === added?.payload.id)
    ok(stored && !stored.toolCalls.some((call) => call.status === 'running'), '宿主记录里的 bash 消息也不再停在 running', JSON.stringify(stored?.toolCalls))
    ok(!ctl.hasRunningBash(), '宿主不再认为有命令在跑')
  } finally {
    await ctl.stop().catch(() => undefined)
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
