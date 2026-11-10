import assert from 'node:assert/strict'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const policy = await build({
  entryPoints: ['src/main/mcp/app-network-policy.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})
const { isMcpAppPrivateAddress, isMcpAppPrivateHost } = await import(`data:text/javascript;base64,${Buffer.from(policy.outputFiles[0].text).toString('base64')}`)

for (const address of ['168.63.129.16', '169.254.169.254', '169.254.170.2', '100.100.100.200']) {
  ok(isMcpAppPrivateAddress(address, 4) === true, `元数据 IPv4 永禁：${address}`)
}
for (const address of ['::ffff:168.63.129.16', '::ffff:a9fe:a9fe', '::ffff:100.100.100.200', '64:ff9b::a83f:8110', '2002:a83f:8110::', 'fd00:ec2::254']) {
  ok(isMcpAppPrivateAddress(address, 6) === true, `元数据映射/IPv6 变体永禁：${address}`)
}
for (const [address, family] of [['8.8.8.8', 4], ['1.1.1.1', 4], ['2606:4700:4700::1111', 6], ['2001:4860::8888', 6]]) {
  ok(isMcpAppPrivateAddress(address, family) === false, `公网地址仍放行：${address}`)
}
for (const [address, family] of [
  ['127.0.0.1', 4], ['10.0.0.1', 4], ['100.64.0.1', 4], ['169.254.1.1', 4], ['172.16.0.1', 4],
  ['192.168.0.1', 4], ['192.0.2.1', 4], ['198.51.100.7', 4], ['203.0.113.9', 4], ['224.0.0.1', 4], ['0.0.0.0', 4],
  ['::1', 6], ['::ffff:127.0.0.1', 6], ['fe80::1', 6], ['fd00::1', 6], ['2001:db8::1', 6], ['2002:7f00:1::', 6]
]) {
  ok(isMcpAppPrivateAddress(address, family) === true, `保留既有拦截规则：${address}`)
}
ok(isMcpAppPrivateAddress('168.63.129.16', 6) === true, 'family 与地址族不一致时仍按元数据地址拒绝')

{
  const unresolvable = await isMcpAppPrivateHost('metadata-fixture.invalid')
  ok(unresolvable === true, 'DNS 解析失败仍按私有/拒绝处理')
  ok((await isMcpAppPrivateHost('localhost')) === true, 'localhost 解析到回环地址时拒绝')
}

const protocolBuilt = await build({
  stdin: {
    contents: "export { deriveMcpAppCsp } from './src/main/mcp/app-protocol.ts';",
    resolveDir: process.cwd(),
    sourcefile: 'mcp-app-protocol-fixture.ts'
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  plugins: [
    {
      name: 'mcp-app-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mcp-app-stub' }))
        b.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'mcp-app-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'mcp-app-stub' }, (args) => ({
          contents: args.path === 'electron'
            ? "export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }"
            : "export async function lookup() { return globalThis.__mcpDnsAnswers ?? [{ address: '93.184.216.34', family: 4 }] }",
          loader: 'js'
        }))
      }
    }
  ]
})
const { deriveMcpAppCsp } = await import(`data:text/javascript;base64,${Buffer.from(protocolBuilt.outputFiles[0].text).toString('base64')}`)

{
  globalThis.__mcpDnsAnswers = [{ address: '93.184.216.34', family: 4 }]
  const csp = await deriveMcpAppCsp({ resourceDomains: ['https://public-site.com'], connectDomains: ['https://api-site.com'] })
  ok(csp.includes('https://public-site.com') && csp.includes('https://api-site.com'), '解析到公网的域名仍进入 CSP', csp)
}

for (const answers of [
  [{ address: '168.63.129.16', family: 4 }],
  [{ address: '::ffff:168.63.129.16', family: 6 }],
  [{ address: 'fd00:ec2::254', family: 6 }]
]) {
  globalThis.__mcpDnsAnswers = answers
  const csp = await deriveMcpAppCsp({ resourceDomains: ['https://azure-target.com'], connectDomains: ['https://azure-target.com'] })
  ok(!csp.includes('azure-target.com'), `解析到元数据地址的域名不进入 CSP：${answers[0].address}`, csp)
}
delete globalThis.__mcpDnsAnswers

console.log(`mcp-app-address-policy: ${checks} assertions passed (fake DNS for CSP path, no network)`)
