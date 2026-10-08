/** 工作时保持唤醒的判定（src/shared/keep-awake.ts）。纯函数。 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runKeepAwakeTests(ok) {
  await build({ entryPoints: ['src/shared/keep-awake.ts'], outfile: 'out/test/keep-awake.mjs', bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' })
  const { shouldKeepAwake, KEEP_AWAKE_RELEASE_MS } = await import(pathToFileURL('out/test/keep-awake.mjs').href)
  ok(shouldKeepAwake({ working: true, onBattery: false }) === true, '保持唤醒：在跑、插电、设置缺省 → 保持')
  ok(shouldKeepAwake({ working: false, onBattery: false }) === false, '保持唤醒：没在跑 → 不保持')
  ok(shouldKeepAwake({ working: true, onBattery: false, whileWorking: false }) === false, '保持唤醒：总开关关闭 → 不保持')
  ok(shouldKeepAwake({ working: true, onBattery: true }) === true, '保持唤醒：用电池且设置缺省 → 保持')
  ok(shouldKeepAwake({ working: true, onBattery: true, onBatteryAllowed: false }) === false, '保持唤醒：用电池且禁止 → 不保持')
  ok(shouldKeepAwake({ working: true, onBattery: false, onBatteryAllowed: false }) === true, '保持唤醒：禁止电池模式不影响插电')
  ok(KEEP_AWAKE_RELEASE_MS === 30_000, '保持唤醒：停下后 30 秒再放锁')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  await runKeepAwakeTests((cond, msg) => { if (!cond) { failed++; console.error('FAIL', msg) } else console.log('ok  ', msg) })
  process.exit(failed ? 1 : 0)
}
