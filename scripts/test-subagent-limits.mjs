import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const scratch = await mkdtemp(join(tmpdir(), 'inkstone-subagent-limits-'))
const envKeys = ['YAN_DATA_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR']
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
for (const key of envKeys) process.env[key] = join(scratch, key)
let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}
try {
  const compile = async (entry, name) => {
    const outfile = join(scratch, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const controller = await compile('src/main/subagents.ts', 'controller')
  const brief = await compile('src/shared/subagent-brief.ts', 'brief')
  const outcome = await compile('src/shared/subagent-outcome.ts', 'outcome')
  const notice = await compile('src/shared/subagent-notice.ts', 'notice')
  const { runSubagentControllerTests } = await import('./test-subagents.mjs')
  const { runSubagentBriefTests } = await import('./test-subagent-brief.mjs')
  const { runSubagentOutcomeTests } = await import('./test-subagent-outcome.mjs')
  const repeatGuard = await import('../resources/pi-extensions/repeat-guard.js')
  runSubagentBriefTests(ok, brief)
  runSubagentOutcomeTests(ok, { brief, outcome, notice, repeatGuard })
  await runSubagentControllerTests(ok, controller.SubagentController)
  console.log(`子代理定向检查通过：${checks}项（独立数据目录、假RPC、临时Git）`)
} finally {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(scratch, { recursive: true, force: true })
}
