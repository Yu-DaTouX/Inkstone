import './lib/test-isolate.mjs'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

export async function runNativeSessionReadyTests(ok) {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/main/native-session-runtime.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  )

  const transport = { command: async () => ({ success: true, data: {} }) }
  const hello = (capabilities = []) =>
    runtime.RECEIPT_PREFIX +
    JSON.stringify({ v: 1, id: 'hello', op: 'hello', ok: true, result: { capabilities } })

  const settle = (promise) =>
    promise.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error?.code, message: String(error?.message ?? error) })
    )

  {
    const bridge = new runtime.NativeSessionRuntime(transport, 5_000)
    const waiting = settle(bridge.whenReady(5_000))
    bridge.handleNotify(hello(['trust_read']))
    const result = await waiting
    ok(result.ok === true, '报到后 whenReady 通过', JSON.stringify(result))
    ok(bridge.isReady === true && bridge.bridgeCapabilities.includes('trust_read'), '报到更新就绪状态与能力')
  }

  {
    const bridge = new runtime.NativeSessionRuntime(transport, 5_000)
    const waiting = settle(bridge.whenReady(5_000))
    bridge.dispose('pi 进程已退出')
    const result = await waiting
    ok(result.ok === false && result.code === 'rpc_failed', 'dispose 让 whenReady 以 rpc_failed 失败（不是「成功」）', JSON.stringify(result))
    ok(result.message.includes('pi 进程已退出'), 'dispose 的原因进到错误信息里', result.message)
    bridge.handleNotify(hello(['trust_read']))
    ok(!bridge.isReady && bridge.bridgeCapabilities.length === 0, 'dispose 后的迟到报到不能让旧桥重新就绪')
    const next = await settle(bridge.whenReady(20))
    ok(next.code === 'rpc_failed' && next.message.includes('pi 进程已退出'), 'dispose 后新等待直接拿到原有退出原因', JSON.stringify(next))
  }

  {
    const bridge = new runtime.NativeSessionRuntime(transport, 5_000)
    const result = await settle(bridge.whenReady(20))
    ok(result.ok === false && result.code === 'bridge_unavailable', '未报到且超时仍是 bridge_unavailable', JSON.stringify(result))
  }

  {
    const bridge = new runtime.NativeSessionRuntime(transport, 5_000)
    bridge.handleNotify(hello())
    const result = await settle(bridge.whenReady(5_000))
    ok(result.ok === true, '已就绪时 whenReady 立即通过', JSON.stringify(result))
  }

  {
    const bridge = new runtime.NativeSessionRuntime(transport, 5_000)
    bridge.handleNotify(runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: 'hello', op: 'hello', ok: false }))
    ok(!bridge.isReady, '错误报到不能开放原生命令')
  }

  for (const earlyReceipt of [false, true]) {
    let envelope
    let acknowledge
    const bridge = new runtime.NativeSessionRuntime({
      command: async (_type, { message }) => {
        envelope = JSON.parse(Buffer.from(message.split(' ')[1], 'base64url').toString())
        return new Promise((resolve) => { acknowledge = resolve })
      }
    }, 5_000)
    bridge.handleNotify(hello())
    const pending = settle(bridge.getScopedModels())
    if (earlyReceipt) bridge.handleNotify(runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op: envelope.op, ok: true }))
    bridge.dispose('process retired')
    const disposed = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 50))])
    acknowledge({ success: true, data: { disposition: 'handled' } })
    ok(disposed?.code === 'rpc_failed' && disposed.message === 'process retired', `${earlyReceipt ? '先收到回执' : '尚未收到回执'}：若 RPC 未确认，关闭仍会立即拒绝原生命令`)
  }

  {
    let envelope
    const bridge = new runtime.NativeSessionRuntime({
      command: async (_type, { message }) => {
        envelope = JSON.parse(Buffer.from(message.split(' ')[1], 'base64url').toString())
        return { success: true, data: { disposition: 'handled' } }
      }
    }, 5_000)
    bridge.handleNotify(hello())
    const pending = bridge.getScopedModels()
    const receipt = (op, enabledModels) => runtime.RECEIPT_PREFIX + JSON.stringify({ v: 1, id: envelope.id, op, ok: true, result: { enabledModels } })
    bridge.handleNotify(receipt('scoped_models_set', ['wrong']))
    bridge.handleNotify(receipt('scoped_models_read', ['right']))
    const result = await pending
    ok(result.enabledModels.join() === 'right', '相同请求 ID 的其他操作回执不会把请求提前完成', JSON.stringify(result))
  }
}

export default runNativeSessionReadyTests

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runNativeSessionReadyTests((cond, name, extra) => {
    if (cond) passed++
    else {
      failed++
      console.error(`✗ ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
    }
  })
  console.log(failed ? `✗ 原生会话桥就绪：${failed} 失败，${passed} 通过` : `✓ 原生会话桥就绪：${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
