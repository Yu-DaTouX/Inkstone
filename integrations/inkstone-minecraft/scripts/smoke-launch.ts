import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LaunchStatus } from '../src/shared/api.ts'
import { CraftService } from '../src/core/service.ts'

const [folder, versionId, scratch] = process.argv.slice(2)
if (!folder || !versionId || !scratch) {
  console.error('用法：node scripts/smoke-launch.ts <游戏目录> <版本> <临时目录>')
  process.exit(2)
}
const root = resolve(scratch)
const gameDir = join(root, 'game')
mkdirSync(gameDir, { recursive: true })
const service = new CraftService({ dataDir: join(root, 'data') })
const timeoutMs = 180_000
let ready = false

const done = new Promise<LaunchStatus>((finish) => {
  const timer = setTimeout(() => {
    console.log('[smoke] 超时，停止游戏')
    void service.stop()
  }, timeoutMs)
  service.on('log', (line) => {
    if (line.stream === 'launcher') console.log(`[launcher] ${line.text}`)
    if (!ready && /游戏窗口已出现|Sound engine started|Created: \d+x\d+/.test(line.text)) {
      ready = true
      console.log(`[smoke] 就绪信号：${line.text}`)
      setTimeout(() => void service.stop(), 3000)
    }
  })
  service.on('status', (status: LaunchStatus) => {
    if (status.state === 'exited' || status.state === 'failed') {
      clearTimeout(timer)
      finish(status)
    }
  })
})

const started = await service.launch({ folder, versionId, gameDir, username: 'InkstoneTest', maxMemoryMb: 2048 })
console.log(`[smoke] 启动结果：${started.state} pid=${started.pid ?? '-'}`)
if (started.state === 'failed') process.exit(1)
const final = await done
const tail = service.logs().filter((line) => line.stream !== 'launcher').slice(-8)
for (const line of tail) console.log(`  ${line.text.slice(0, 200)}`)
console.log(`[smoke] 结束：${final.state} code=${final.exitCode} ready=${ready}`)
process.exit(ready ? 0 : 1)
