import { buildTest } from './lib/test-suite.mjs'
import { applyTestEnv, isIsolatedTestEnv } from './lib/test-env.mjs'

if (!isIsolatedTestEnv()) applyTestEnv()

const inProcessFailures = []
async function guarded(label, run) {
  try {
    await run()
  } catch (error) {
    console.log(`✗ ${label}：${error?.message ?? error}`)
    inProcessFailures.push({ label, detail: error?.stack ?? String(error) })
  }
}

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++
    console.log(`✓ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`✗ ${label}${extra ? '  ' + extra : ''}`)
  }
}

const customProvider = await buildTest('src/shared/custom-provider.ts', 'out/test/custom-provider.mjs', { platform: 'neutral' }).then(() => import('../out/test/custom-provider.mjs'))
const { runCustomProviderTests } = await import('./test-custom-provider.mjs')
await guarded("runCustomProviderTests(ok, customProvider)", () => runCustomProviderTests(ok, customProvider))

{
  await buildTest('resources/pi-extensions/danger-guard.js', 'out/test/danger-guard.mjs')
  const dangerGuard = await import('../out/test/danger-guard.mjs')
  const { runDangerGuardTests, runApprovalBindingTests } = await import('./test-danger-guard.mjs')
  runDangerGuardTests(ok, dangerGuard)
  await runApprovalBindingTests(ok, dangerGuard)
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (inProcessFailures.length) {
  console.log(`\n${inProcessFailures.length} 个进程内测试失败：${inProcessFailures.map((item) => item.label).join(', ')}`)
  for (const item of inProcessFailures) console.log(`\n--- ✗ ${item.label} ---\n${item.detail}`)
}
process.exit(fail || inProcessFailures.length ? 1 : 0)
