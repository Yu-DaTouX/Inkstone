import assert from 'node:assert/strict'
import { build } from 'esbuild'

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const result = await build({
  entryPoints: ['src/main/net/pinned-network.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'electron-stub',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: `export const session = { fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'DIRECT' }) }`
        }))
      }
    }
  ]
})
const { attachPinnedNetworkGuard, pinnedGuardStatus, shutdownPinnedNetworkGuard } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

function fakeSession(script) {
  const state = { rules: '', calls: 0, setProxyCalls: [] }
  const ses = {
    state,
    async setProxy(config) {
      state.calls += 1
      state.setProxyCalls.push(config.mode)
      await script.beforeSetProxy?.(state.calls)
      if (config.mode === 'fixed_servers') state.rules = config.proxyRules
    },
    async resolveProxy() {
      const port = /127\.0\.0\.1:(\d+)/.exec(state.rules)?.[1]
      return port ? `PROXY 127.0.0.1:${port}` : 'DIRECT'
    },
    async closeAllConnections() {}
  }
  return ses
}

try {
  console.log('▌防护附着失败后可重试，且重试期间保持 fail-closed')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ses = fakeSession({
    beforeSetProxy: async (call) => {
      if (call === 1) throw new Error('setProxy unavailable')
      if (call === 2) await gate
    }
  })
  const first = await attachPinnedNetworkGuard(ses, 'https://example.com/')
  ok(first.status === 'failed' && /setProxy unavailable/.test(first.message), '第一次附着失败并带原因', first)
  ok(pinnedGuardStatus(ses).status === 'failed', '失败后状态是 failed（不是 ready，请求会被拦）', pinnedGuardStatus(ses))

  const retry = attachPinnedNetworkGuard(ses, 'https://example.com/')
  const duringRetry = pinnedGuardStatus(ses)
  ok(duringRetry.status === 'starting', '重试期间状态是 starting，不是 ready', duringRetry)
  const joined = attachPinnedNetworkGuard(ses, 'https://example.com/')
  ok(joined === retry, '重试进行中的并发调用共用同一次尝试')
  await new Promise((resolve) => setTimeout(resolve, 20))
  ok(pinnedGuardStatus(ses).status !== 'ready', '重试未完成时始终不是 ready')
  release()
  const second = await retry
  ok(second.status === 'attached', '第二次调用重新附着成功', second)
  ok(pinnedGuardStatus(ses).status === 'ready', '成功后状态为 ready', pinnedGuardStatus(ses))

  const third = await attachPinnedNetworkGuard(ses, 'https://example.com/')
  ok(third.status === 'attached' && ses.state.calls === 2, '成功后缓存生效，不再重复附着', ses.state.calls)

  console.log('▌路由不匹配同样可重试')
  const badSes = fakeSession({})
  badSes.resolveProxy = async () => 'DIRECT'
  const bad = await attachPinnedNetworkGuard(badSes, 'https://example.com/')
  ok(bad.status === 'failed' && /mismatch/.test(bad.message), '路由不匹配记为失败', bad)
  ok(pinnedGuardStatus(badSes).status === 'failed', '路由不匹配时状态为 failed')
  const goodAgain = fakeSession({})
  badSes.resolveProxy = goodAgain.resolveProxy.bind(badSes)
  badSes.state = goodAgain.state
  badSes.setProxy = async (config) => { if (config.mode === 'fixed_servers') badSes.state.rules = config.proxyRules }
  const recovered = await attachPinnedNetworkGuard(badSes, 'https://example.com/')
  ok(recovered.status === 'attached', '修复后下一次调用成功', recovered)
} finally {
  await shutdownPinnedNetworkGuard()
}
console.log(`pinned-network-retry: ${pass} assertions passed`)
