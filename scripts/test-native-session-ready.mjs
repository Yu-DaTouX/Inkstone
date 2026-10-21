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
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(bridge.isReady === false, 'dispose 后桥未就绪')
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
