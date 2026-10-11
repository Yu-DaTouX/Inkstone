import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const baseline = process.argv.includes('--baseline')
if (baseline && !process.env.YAN_SUBAGENT_STREAM_MODULE) throw new Error('--baseline 需要指定优化前的 YAN_SUBAGENT_STREAM_MODULE，不能把当前源码标作旧基线')
const scratch = await mkdtemp(join(tmpdir(), 'inkstone-subagent-stream-'))
const envKeys = ['YAN_DATA_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR']
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
for (const key of envKeys) process.env[key] = join(scratch, key)
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const sleep = ms => new Promise(done => setTimeout(done, ms))
try {
  let modulePath = process.env.YAN_SUBAGENT_STREAM_MODULE
  if (!modulePath) {
    modulePath = join(scratch, 'controller.mjs')
    await build({ entryPoints: ['src/main/subagents.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  }
  const { SubagentController } = await import(pathToFileURL(resolve(modulePath)).href)
  const make = async (name, onChange) => {
    let rpc
    const ctrl = new SubagentController({ cwd: scratch, archiveDir: join(scratch, name),
      prepare: async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }), onChange,
      createRpc: () => {
        const handlers = new Map()
        rpc = { running: false, on(event, fn) { handlers.set(event, fn); return rpc }, spawn() { rpc.running = true },
          async command(type) { return { success: true, ...(type === 'get_state' ? { data: {} } : {}) } },
          async close() { rpc.running = false }, emit(evt) { handlers.get('event')?.(evt) } }
        return rpc
      } })
    const started = await ctrl.start('Synthetic performance fixture', undefined, 'controlled-cwd')
    assert.ok(started.ok, started.error)
    return { ctrl, rpc, id: started.run.id }
  }
  const message = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
  if (!baseline) {
    const pushed = []
    const { ctrl, rpc, id } = await make('regression', run => pushed.push(JSON.parse(JSON.stringify(run))))
    try {
      rpc.emit({ type: 'message_start', message: message('') })
      const startCount = pushed.length
      for (let i = 1; i <= 40; i++) rpc.emit({ type: 'message_update', message: message(`更新${i}中文🖋️`) })
      ok(pushed.length === startCount, '突发流式更新不逐条推送')
      ok(ctrl.get(id).transcript.at(-1).text === '更新40中文🖋️', '主动读取即时获得最新权威文本')
      await sleep(55)
      ok(pushed.length === startCount + 1, '一次计时器合并整个突发')
      ok(pushed.at(-1).transcript.at(-1).text === '更新40中文🖋️', '合并快照中文和emoji完整')
      rpc.emit({ type: 'message_update', message: message('等待结束') })
      rpc.emit({ type: 'message_end', message: message('最终权威文本🖋️') })
      ok(pushed.at(-1).transcript.at(-1).text === '最终权威文本🖋️', '结束事件立即推送最终全文')
      const endCount = pushed.length
      await sleep(55)
      ok(pushed.length === endCount, '结束事件取消旧流式计时器')
      rpc.emit({ type: 'message_start', message: message('下一段') })
      rpc.emit({ type: 'message_update', message: message('下一段更新') })
      rpc.emit({ type: 'tool_execution_start', toolName: 'read' })
      ok(pushed.at(-1).toolCalls === 1 && pushed.at(-1).transcript.at(-1).text === '下一段更新', '工具开始即时推送且包含最新正文')
      rpc.emit({ type: 'message_update', message: message('停止前的最新文本') })
      await ctrl.stop(id)
      ok(pushed.at(-1).status === 'cancelled' && pushed.at(-1).transcript.at(-1).text === '停止前的最新文本', '停止即时收口并保留最后更新')
      const stopCount = pushed.length
      await sleep(55)
      ok(pushed.length === stopCount, '停止后无旧计时器重复推送')
      await ctrl.clearFinished()
      await sleep(55)
      ok(ctrl.get(id) === undefined && pushed.length === stopCount, '显式清除后不反弹')
    } finally { await ctrl.stopAll() }
  }
  const runs = []
  for (let round = 0; round < 3; round++) {
    let pushes = 0, bytes = 0, handlingMs = 0
    const { ctrl, rpc, id } = await make(`bench-${round}`, run => { pushes++; bytes += Buffer.byteLength(JSON.stringify(run)) })
    try {
      for (let i = 0; i < 100; i++) rpc.emit({ type: 'message_end', message: message(`History ${i} ` + '历史内容。'.repeat(100)) })
      rpc.emit({ type: 'message_start', message: message('') })
      pushes = 0; bytes = 0
      let finalText = ''
      for (let burst = 0; burst < 50; burst++) {
        const start = performance.now()
        for (let n = 0; n < 10; n++) {
          finalText = '中文🖋️stream '.repeat(burst * 10 + n + 1)
          rpc.emit({ type: 'message_update', message: message(finalText) })
        }
        handlingMs += performance.now() - start
        await sleep(20)
      }
      const start = performance.now()
      rpc.emit({ type: 'message_end', message: message(finalText) })
      handlingMs += performance.now() - start
      ok(ctrl.get(id).transcript.at(-1).text === finalText, '500次更新与最终全文一致')
      const count = pushes
      await sleep(55)
      ok(pushes === count, '基准收口后无重复推送')
      runs.push({ round: round + 1, updates: 500, transcriptMessages: ctrl.get(id).transcript.length, pushes, bytes, handlingMs })
    } finally { await ctrl.stopAll() }
  }
  const result = { tag: baseline ? 'before' : 'after', checks, scope: '假RPC；同一100条历史+500次更新；推送字节用JSON序列化测量，不是Electron IPC实际字节', runs }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.YAN_SUBAGENT_STREAM_OUT) {
    const path = resolve(process.env.YAN_SUBAGENT_STREAM_OUT)
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify(result, null, 2))
  }
} finally {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
  }
  await rm(scratch, { recursive: true, force: true })
}
