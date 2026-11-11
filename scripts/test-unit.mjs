import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverTests, selectTests, executionPlan } from './lib/test-catalog.mjs'
import { runTestProcess, runTestPool } from './lib/test-process.mjs'

try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('npm run test:unit -- [前缀 ...] [--list]\n无前缀：完整单测（依赖 npm run build）；前缀如 queue、agents-doc。\n--list 只列出匹配项及独立/兼容/排除状态，不执行测试。')
  } else {
    const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--list')
    if (unknown) throw new Error(`未知选项：${unknown}`)
    const prefixes = args.filter((arg) => arg !== '--list')
    const selected = selectTests(await discoverTests(), prefixes)
    if (args.includes('--list')) {
      for (const test of selected) console.log(`${test.kind.padEnd(10)} ${test.name}${test.reason ? ` (${test.reason})` : ''}`)
      console.log(`共 ${selected.length} 项；此命令没有执行测试。`)
    } else {
      const plan = executionPlan(selected, prefixes.length > 0)
      await mkdir('out/test-runs', { recursive: true })
      const logDir = await mkdtemp('out/test-runs/run-')
      console.log(`运行 ${plan.parallel.length} 个独立脚本${plan.legacy ? ' + 1 个串行兼容套件' : ''}；日志：${logDir}`)
      const run = async (name) => {
        const result = await runTestProcess({
          script: `scripts/${name}.mjs`, logPath: join(logDir, `${name}.log`),
          timeoutMs: name === 'test-unit-legacy' ? 900_000 : name === 'test-collab' ? 300_000 : 120_000
        })
        console.log(`${result.ok ? '✓' : '✗'} ${name} (${result.elapsed}ms)`)
        if (!result.ok) console.error(`${result.error ?? (result.timedOut ? 'timeout' : result.signal ?? `exit ${result.code}`)}\n${result.tail}\n完整日志：${result.logPath}`)
        return result
      }
      const results = await runTestPool(plan.parallel, run)
      if (plan.legacy) results.push(await run('test-unit-legacy'))
      const passed = results.filter((result) => result.ok).length
      console.log(`\n${passed}/${results.length} 个脚本通过（不是断言数）；日志：${logDir}`)
      if (passed !== results.length) process.exitCode = 1
    }
  }
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
}
