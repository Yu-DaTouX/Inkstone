import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverTests, selectTests, executionPlan } from './lib/test-catalog.mjs'
import { runTestProcess, runTestPool } from './lib/test-process.mjs'
import { SKIP_MARKER } from './lib/test-skip.mjs'
import { sweepStaleSandboxes } from './lib/test-env.mjs'

try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('npm run test:unit -- [前缀 ...] [--list]\n无前缀：完整单测（依赖 npm run build）；前缀如 queue、agents-doc。\n--list 只列出匹配项及独立/排除状态及是否走串行道，不执行测试。')
  } else {
    const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--list')
    if (unknown) throw new Error(`未知选项：${unknown}`)
    const prefixes = args.filter((arg) => arg !== '--list')
    const selected = selectTests(await discoverTests(), prefixes)
    if (args.includes('--list')) {
      for (const test of selected) console.log(`${test.kind.padEnd(10)} ${test.serial ? 'serial ' : '       '}${test.name}${test.reason ? ` (${test.reason})` : ''}`)
      console.log(`共 ${selected.length} 项；此命令没有执行测试。`)
    } else {
      const plan = executionPlan(selected, prefixes.length > 0)
      const swept = sweepStaleSandboxes()
      if (swept.length) console.log(`已清扫 ${swept.length} 个超过 1 天的遗留测试隔离目录`)
      await mkdir('out/test-runs', { recursive: true })
      const logDir = await mkdtemp('out/test-runs/run-')
      console.log(`运行 ${plan.parallel.length} 个并行 + ${plan.serial.length} 个串行独立脚本；日志：${logDir}`)
      const run = async (name) => {
        const result = await runTestProcess({
          script: `scripts/${name}.mjs`, logPath: join(logDir, `${name}.log`), timeoutMs: 240_000
        })
        const skipped = (await readFile(result.logPath, 'utf8').catch(() => '')).split(/\r?\n/).filter((line) => line.startsWith(SKIP_MARKER))
        console.log(`${result.ok ? '✓' : '✗'} ${name} (${result.elapsed}ms)${skipped.length ? `，有跳过：${skipped.map((line) => line.slice(SKIP_MARKER.length).trim()).join('；')}` : ''}`)
        if (!result.ok) console.error(`${result.error ?? (result.timedOut ? 'timeout' : result.signal ?? `exit ${result.code}`)}\n${result.tail}\n完整日志：${result.logPath}`)
        return result
      }
      const results = await runTestPool(plan.parallel, run)
      results.push(...await runTestPool(plan.serial, run, 1))
      const passed = results.filter((result) => result.ok).length
      console.log(`\n${passed}/${results.length} 个脚本通过（不是断言数）；日志：${logDir}`)
      if (passed !== results.length) process.exitCode = 1
    }
  }
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
}
