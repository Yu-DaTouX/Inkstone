import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

const dataDir = await mkdtemp(join(tmpdir(), 'yan-mcp-app-view-trust-'))
process.env.YAN_DATA_DIR = dataDir

let mod
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-view-approval';" +
        "export * from './src/main/mcp/app-view-trust';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(`无法加载被测模块：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { approveAppViewCall, evaluateHostTrust, mcpServerIdentityFingerprint } = mod
ok(typeof approveAppViewCall === 'function', '加载 approveAppViewCall')
ok(typeof evaluateHostTrust === 'function', '加载 evaluateHostTrust')
ok(typeof mcpServerIdentityFingerprint === 'function', '加载 mcpServerIdentityFingerprint')

const NOW = 1_700_000_000_000
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)
const SERVER = 'srv'
const baseCall = { server: SERVER, tool: 'read', visibility: ['app'], cwd: 'C:/proj' }
const safeAnnotations = { readOnlyHint: true }
const safeExplicit = { destructiveHint: false, openWorldHint: false }
const destructiveAnnotations = { destructiveHint: true }

const grant = (overrides = {}) => ({
  serverFingerprint: FP_A,
  scope: 'server',
  authorizer: 'user',
  expiresAt: NOW + 60_000,
  ...overrides
})
const ctx = (overrides = {}) => ({ serverFingerprint: FP_A, grants: [grant()], now: NOW, ...overrides })

const allowAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve({ choice: 'once' })
}
const denyAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve({ choice: 'deny' })
}
const nullAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve(null)
}
const throwingAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.reject(new Error('broker timeout'))
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker))
  ok(result.allowed && result.asked, '无 context 只读必须经询问后才放行（fail-closed）', JSON.stringify({ asked: result.asked }))
  ok(result.asked && tracker.calls === 1, '无 context 只读必须询问，不能静默执行')
  ok(result.recorded && result.audit.trustVerdict === 'no-fingerprint', '无 context 只读判定要求审计记录')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    allowAsk(tracker),
    { serverFingerprint: FP_A, now: NOW }
  )
  ok(result.allowed && result.asked && tracker.calls === 1, '有指纹无 grant 的只读仍须询问')
  ok(result.audit.trustVerdict === 'no-grant' && result.audit.persistentGrant === false, '无 grant 记录 no-grant 且不建立持久授权')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    denyAsk(tracker),
    { serverFingerprint: FP_A, now: NOW }
  )
  ok(!result.allowed && result.asked && /拒绝/.test(result.reason ?? ''), '无 grant 只读被拒不执行')
}

{
  const trackerA = { calls: 0 }
  const remembered = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, () => {
    trackerA.calls += 1
    return Promise.resolve({ choice: 'remember' })
  }, { serverFingerprint: FP_A, now: NOW })
  ok(remembered.allowed && remembered.asked, '无 grant 只读：remember 也只对本次生效')
  ok(remembered.audit.persistentGrant === false, 'remember 不写持久授权')

  const trackerB = { calls: 0 }
  const again = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, denyAsk(trackerB), {
    serverFingerprint: FP_A,
    now: NOW
  })
  ok(trackerB.calls === 1 && !again.allowed, '第二次调用仍重新询问（一次 allow 不持久化）')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), ctx())
  ok(result.allowed && !result.asked && tracker.calls === 0, '命中宿主 grant 的只读直接放行、不弹卡')
  ok(result.trust.trusted && result.trust.verdict === 'trusted' && result.trust.scope === 'server', '记录 trusted / server 范围')
  ok(result.recorded && result.audit.trustVerdict === 'trusted' && result.audit.persistentGrant === false, 'trusted 只读仍要求审计')
}

{
  const tracker = { calls: 0 }
  const explicit = await approveAppViewCall({ ...baseCall, annotations: safeExplicit }, allowAsk(tracker), ctx())
  ok(explicit.allowed && !explicit.asked && tracker.calls === 0, '显式「非破坏且非开放世界」也走 grant 直放')
}

{
  const tracker = { calls: 0 }
  const scoped = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ scope: 'tool', tool: 'read' })]
  })
  ok(scoped.allowed && !scoped.asked && scoped.trust.scope === 'tool', 'tool 范围 grant 命中同一工具可直放')

  const tracker2 = { calls: 0 }
  const other = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker2), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ scope: 'tool', tool: 'write' })]
  })
  ok(other.allowed && other.asked && tracker2.calls === 1, 'tool 范围 grant 不覆盖其它工具，仍需询问')
}

for (const [key, annotations] of [['破坏性', destructiveAnnotations], ['未知注解', undefined], ['缺注解', {}]]) {
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations }, allowAsk(tracker), ctx())
  ok(result.allowed && result.asked && tracker.calls === 1, `${key}调用即使有 grant 仍询问`)
  ok(result.audit.trustVerdict === 'bypassed', `${key}调用审计记为未用授权（bypassed）`)
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ serverFingerprint: FP_B })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'mismatch', '旧指纹 / 跨 server grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ revoked: true })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'revoked' && tracker.calls === 1, '已撤销 grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ expiresAt: NOW - 1 })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'expired', '已过期 grant 失效，仍询问')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, denyAsk(), {
    ...ctx(),
    grants: [grant({ expiresAt: undefined })]
  })
  ok(!r2.allowed && r2.audit.trustVerdict === 'expired', '缺有效期 grant 失效（fail-closed）')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations, sessionId: 'session-me' },
    allowAsk(tracker),
    { ...ctx(), sessionId: 'session-me', grants: [grant({ sessionId: 'session-other' })] }
  )
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'wrong-owner', 'owner（会话）不符 grant 失效，仍询问')

  const r2 = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    allowAsk({ calls: 0 }),
    { ...ctx(), projectId: 'p1', grants: [grant({ projectId: 'p2' })] }
  )
  ok(r2.asked && r2.audit.trustVerdict === 'wrong-owner', 'owner（项目）不符 grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ permissionMode: 'all' })]
  })
  ok(r.asked && r.audit.trustVerdict === 'no-grant', '仅 all 档有效的 grant 在 danger 档不生效')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk({ calls: 0 }), {
    ...ctx(),
    grants: [grant({ authorizer: 'iframe' })]
  })
  ok(r2.asked, '非法授权人不构成信任，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations, trust: true, trusted: true, source: 'iframe' },
    allowAsk(tracker),
    { serverFingerprint: FP_A, trusted: true, now: NOW }
  )
  ok(r.allowed && r.asked && tracker.calls === 1, '裸布尔 trusted / iframe 自报 trust 不构成授权')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk({ calls: 0 }), {
    trusted: true,
    now: NOW
  })
  ok(r2.asked && r2.audit.trustVerdict === 'no-fingerprint', '缺指纹时即使传布尔也按 fail-closed 询问')

  const r3 = evaluateHostTrust({ serverFingerprint: FP_A, tool: 'read', grants: true, now: NOW })
  ok(!r3.trusted && r3.verdict === 'no-grant', 'evaluateHostTrust 不接受布尔 grants')
}

{
  const r = await approveAppViewCall(
    { ...baseCall, visibility: ['model'], annotations: destructiveAnnotations },
    allowAsk(),
    ctx()
  )
  ok(!r.allowed && !r.asked && r.recorded && r.audit.trustVerdict === 'bypassed', 'visibility 不含 app：拒绝且要求记录')

  const r2 = await approveAppViewCall({ ...baseCall, visibility: undefined, annotations: destructiveAnnotations }, allowAsk())
  ok(!r2.allowed && /缺少 visibility/.test(r2.reason ?? '') && r2.recorded, '缺 visibility 按最严拒绝并记录')

  for (const [key, visibility] of [
    ['字符串', 'app'],
    ['混入未知值', ['app', 'junk']],
    ['原始 meta 对象', { ui: { visibility: ['app'] } }]
  ]) {
    const r3 = await approveAppViewCall({ ...baseCall, visibility, annotations: safeAnnotations }, allowAsk(), ctx())
    ok(!r3.allowed && r3.recorded, `visibility 只接受宿主归一化数组：${key}被拒`)
  }
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: destructiveAnnotations, permissionMode: 'all' },
    allowAsk(tracker),
    ctx()
  )
  ok(r.allowed && !r.asked && tracker.calls === 0, 'all 档不额外拦截')
  ok(r.recorded && r.audit.permissionMode === 'all' && r.reasons.length > 0, 'all 档仍记录风险与档位')
  ok(r.audit.trustVerdict === 'bypassed', 'all 档审计记为未进入信任判定')
}

for (const [key, ask] of [['异常', throwingAsk({ calls: 0 })], ['返回 null', nullAsk({ calls: 0 })]]) {
  const r = await approveAppViewCall({ ...baseCall, annotations: destructiveAnnotations }, ask, ctx())
  ok(!r.allowed && r.asked && /没有得到用户确认/.test(r.reason ?? ''), `ask ${key}判拒绝`)
  ok(r.recorded && r.audit.asked === true, `ask ${key}仍要求审计`)
}

{
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, nullAsk({ calls: 0 }), {
    serverFingerprint: FP_A,
    now: NOW
  })
  ok(!r.allowed && r.asked && /没有得到用户确认/.test(r.reason ?? ''), '无 grant 只读的 ask 超时/null 判拒绝')
}

{
  const r = await approveAppViewCall({ ...baseCall, annotations: destructiveAnnotations }, () => Promise.resolve(undefined), ctx())
  ok(!r.allowed, 'ask 返回非法 shape（undefined）判拒绝')
}

{
  const a = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--x'], env: { TOKEN: 'secret-token' } })
  const b = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--x'], env: { TOKEN: 'secret-token' } })
  const c = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--y'], env: { TOKEN: 'secret-token' } })
  ok(a === b && /^[0-9a-f]{64}$/.test(a), '相同配置指纹稳定且为 sha256 hex')
  ok(a !== c, '配置变化（args）指纹随之变化')
  ok(!a.includes('secret-token'), '指纹不泄露 env 里的凭证原文')
}

await rm(dataDir, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
