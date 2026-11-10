import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const { pinnedGuardStatus, pinnedRoutingStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

console.log('▌默认会话防护状态')
{
  const status = pinnedGuardStatus({})
  ok(status.status === 'idle' && status.reason === '', '未挂载时是 idle 且无原因', status)
  const routing = pinnedRoutingStatus()
  ok(routing.direct === 0 && routing.upstream === 0 && routing.unsupported === 0 && routing.lastUpstream === '', '未挂载时计数为零', routing)
}

console.log('▌设置页诊断文案')
{
  const zh = JSON.parse(readFileSync('src/renderer/src/i18n/zh-CN.json', 'utf8'))
  const en = JSON.parse(readFileSync('src/renderer/src/i18n/en-US.json', 'utf8'))
  for (const key of ['security.networkGroup', 'security.networkGuard', 'security.networkReady', 'security.networkStarting', 'security.networkIdle', 'security.networkOff', 'security.networkUnavailable']) {
    ok(typeof zh[key] === 'string' && typeof en[key] === 'string', `双语键 ${key}`)
  }
  ok(zh['security.networkOff'].includes('{reason}') && en['security.networkOff'].includes('{reason}'), '失败原因占位')
  ok(zh['security.networkUpstreamDesc'].includes('{count}') && zh['security.networkUpstreamDesc'].includes('{host}'), '代理行含次数与最近主机')
  ok(en['security.networkUpstreamDesc'].includes('{count}') && en['security.networkUpstreamDesc'].includes('{host}'), '英文代理行占位一致')
  ok(zh['security.networkSocksDesc'].includes('{count}'), 'SOCKS 拒绝次数占位')
  ok(/[一-鿿]/.test(zh['security.networkGroup']) && !/[一-鿿]/.test(en['security.networkGroup']), '分组标题中英对应')
}

console.log(`DNS 防护状态接口：${pass} 项通过`)
