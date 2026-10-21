import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-coalesce-'))

try {
  const outfile = join(root, 'remote-push-coalesce.mjs')
  await build({
    entryPoints: ['src/main/remote-push-coalesce.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { RemotePushCoalescer, REMOTE_COALESCE_CHANNELS, REMOTE_COALESCE_INTERVAL_MS } = await import(pathToFileURL(outfile).href)

  const sent = []
  const timers = []
  const schedule = (run, ms) => {
    const entry = { run, ms, cancelled: false }
    timers.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  const tick = () => {
    const due = timers.filter((timer) => !timer.cancelled)
    timers.length = 0
    for (const timer of due) timer.run()
  }

  assert.deepEqual([...REMOTE_COALESCE_CHANNELS].sort(), ['queue', 'runners', 'stats'], '只合并快照类频道')
  assert.equal(REMOTE_COALESCE_INTERVAL_MS, 250, '合并窗口为 250ms')

  const coalescer = new RemotePushCoalescer((message) => sent.push(message), 250, schedule)
  coalescer.push({ ch: 'queue', payload: { steering: [{ id: 'a' }], followUp: [] } })
  coalescer.push({ ch: 'queue', payload: { steering: [{ id: 'a' }, { id: 'b' }], followUp: [] } })
  coalescer.push({ ch: 'runners', payload: [{ id: 'r1' }] })
  assert.equal(sent.length, 0, '合并窗口内不立即发送')
  assert.equal(timers.filter((timer) => !timer.cancelled).length, 1, '多个合并事件只用一个定时器')
  tick()
  assert.deepEqual(
    sent.map((message) => message.ch),
    ['queue', 'runners'],
    '同一频道只发最新快照，并按首次出现顺序排列'
  )
  assert.equal(sent[0].payload.steering.length, 2, '发出的是最后一次快照')

  sent.length = 0
  coalescer.push({ ch: 'state', payload: { sessionId: 's1', isStreaming: false } })
  assert.equal(sent.length, 1, '状态事件立即发送')
  assert.equal(sent[0].ch, 'state')

  sent.length = 0
  coalescer.push({ ch: 'queue', payload: { steering: [], followUp: [] } })
  coalescer.push({ ch: 'msg-add', payload: { id: 'm1' } })
  assert.deepEqual(sent.map((message) => message.ch), ['queue', 'msg-add'], '未合并事件把待发的合并快照先冲出去，保证顺序')
  assert.equal(timers.filter((timer) => !timer.cancelled).length, 0, '冲出后不再留定时器')

  sent.length = 0
  coalescer.push({ ch: 'stats', payload: { turns: 1 } })
  coalescer.dispose()
  tick()
  assert.equal(sent.length, 0, 'dispose 后丢弃未发出的快照')

  const immediate = new RemotePushCoalescer((message) => sent.push(message), 250, schedule)
  sent.length = 0
  immediate.push({ ch: 'queue', payload: { steering: [], followUp: [] } })
  immediate.flush()
  immediate.flush()
  assert.equal(sent.length, 1, 'flush 幂等，不重复发送')
  immediate.dispose()

  console.log(JSON.stringify({ passed: 11, failed: 0 }))
} finally {
  await rm(root, { recursive: true, force: true })
}
