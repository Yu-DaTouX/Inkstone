import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function runSubagentDismissTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (condition, label) => { if (!condition) throw new Error(`✗ ${label}`) }

  await mkdir(resolve('.tmp/subagent-dismiss-ui'), { recursive: true })
  const buildDir = await mkdtemp(resolve('.tmp/subagent-dismiss-ui/run-'))
  try {
    const outfile = join(buildDir, 'subagent-outcome.mjs')
    await build({
      entryPoints: ['src/shared/subagent-outcome.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent'
    })
    const { subagentOutcome } = await import(pathToFileURL(outfile).href)

    const baseRun = (extra = {}) => ({
      id: 'fail1',
      task: 'Do a thing',
      cwd: '/tmp/fixture',
      isolation: 'worktree',
      status: 'error',
      startedAt: 1,
      endedAt: 2,
      transcript: [],
      review: 'none',
      error: 'boom failed',
      ...extra
    })

    const dismissedInput = baseRun({ dismissedAt: 123 })
    const projected = subagentOutcome(dismissedInput)
    check(projected.key === 'dismissed', '投影：已处理的 key 是 dismissed')
    check(projected.tone === 'mute', '投影：已处理语气为 mute')
    check(projected.live === false && projected.attention === false, '投影：已处理不再运行、不再需处理')
    check(projected.rank === 2 && projected.partial === false, '投影：已处理排进完成区，不是部分结论')
    check(dismissedInput.status === 'error' && dismissedInput.error === 'boom failed', '投影不改写原 status / error')
    check(subagentOutcome(baseRun()).key === 'failed', '投影：未标记的 error 仍是 failed')
    check(subagentOutcome(baseRun({ dismissedAt: Number.NaN })).key === 'failed', '投影：无效 dismissedAt 不算已处理')
    check(subagentOutcome(baseRun({ endReason: 'timeout', dismissedAt: 1 })).key === 'dismissed', '投影：超时失败被标记后同样退出')
  } finally {
    await rm(buildDir, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let passed = 0
  let failed = 0
  try {
    await runSubagentDismissTests((condition, label) => {
      if (condition) {
        passed++
        console.log(`  ok  ${label}`)
      } else {
        failed++
        console.log(`  ✗ ${label}`)
      }
    })
    console.log(failed ? `\n✗ 失败子代理不再处理：失败 ${failed} 项` : `\n✓ 失败子代理不再处理：${passed} 项通过`)
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
