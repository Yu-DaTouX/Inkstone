import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { PiRpc } = await compile('src/main/protocol.ts', { external: ['electron'] })
  const rpc = new PiRpc({ cwd: process.cwd(), piBin: process.execPath })
  const child = new EventEmitter()
  const writes = []
  const frames = []
  const diagnostics = []
  child.stdin = {
    write(line, _encoding, done) {
      writes.push({ frame: JSON.parse(line), done })
    }
  }
  rpc.child = child
  rpc.on('stderr', (line) => diagnostics.push(line))
  rpc.on('event', (frame) => frames.push(frame))
  rpc.feed('null\n42\ntrue\n[1,2]\n{"type":"revision","revision":1}\r\n')
  ok(diagnostics.length === 4 && frames.length === 1 && frames[0].type === 'revision', '只丢弃非对象 JSON；同段后续合法帧仍被处理')
  const large = 'x'.repeat(64 * 1024 * 1024)
  rpc.feed(large)
  rpc.feed('x')
  rpc.feed('{"type":"discard-overlong-tail"}\n{"type":"after-split"}\n')
  ok(frames.map((frame) => frame.type).join() === 'revision,after-split', '跨块超长行的尾巴不会被误当成独立 RPC 帧')
  const beforeOverlong = diagnostics.length
  rpc.feed(`${large}x\n{"type":"after-single"}\n`)
  ok(frames.at(-1).type === 'after-single' && diagnostics.length === beforeOverlong + 1 && !diagnostics.at(-1).includes('xxxxx'), '同块超长行跳过，不把内容写进诊断，也不影响后续帧')

  const first = rpc.command('get_state', { id: 'not-the-id', type: 'not-the-command', value: 3 }, { id: 'same' })
  assert.deepEqual(writes[0].frame, { id: 'same', type: 'get_state', value: 3 })
  ok(true, '宿主管理的请求 ID 和命令名不能被 payload 覆盖')
  await assert.rejects(rpc.command('other', {}, { id: 'same' }), /same/)
  ok(writes.length === 1, '重复请求 ID 不会再发送或覆盖首个请求')
  rpc.feed('{"type":"response","id":"same","success":true}\n')
  ok((await first).success === true, '首个请求仍收到自己的回执')

  const next = rpc.command('get_state', {}, { id: 'same' })
  writes[0].done(new Error('late stdin write callback'))
  rpc.feed('{"type":"response","id":"same","success":true}\n')
  ok((await next).success === true, '上一条请求的迟到写入失败不会清理新请求')

  const circular = {}
  circular.circular = circular
  await assert.rejects(rpc.command('get_state', circular, { id: 'serialize' }))
  ok(!rpc.pending.has('serialize'), '序列化失败不留下 pending 项或计时器')

  child.stdin.write = () => { throw new Error('stdin closed') }
  await assert.rejects(rpc.command('get_state', {}, { id: 'closed' }), /stdin closed/)
  ok(!rpc.pending.has('closed'), 'stdin 同步写入失败也不会留下 pending')
})
