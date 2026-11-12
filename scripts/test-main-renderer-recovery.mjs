import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createRendererRecovery } = await compile('src/main/windows/renderer-recovery.ts')
  let now = 0
  const mayReload = createRendererRecovery({ limit: 3, windowMs: 60_000, now: () => now })
  ok(!mayReload('clean-exit'), '正常退出不重载')
  ok(!mayReload('launch-failed') && !mayReload('integrity-failure'), '启动失败与完整性失败不重载')
  ok(mayReload('crashed') && mayReload('oom') && mayReload('abnormal-exit'), '崩溃、内存不足、异常退出会重载')
  ok(!mayReload('crashed'), '时间窗内超过 3 次不再重载，避免崩溃循环')
  now = 61_000
  ok(mayReload('crashed'), '时间窗过后恢复重载')
})
