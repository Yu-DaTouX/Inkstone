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
  const summary = controller.dangerConfirmSummary
  ok(summary(true).allowed === true && summary(true).decision === 'allow', '\u65e7\u5e03\u5c14\u5141\u8bb8\u4ecd\u653e\u884c')
  ok(summary(undefined).decision === 'no-answer' && summary(undefined).allowed === false, '\u6ca1\u6709\u5ba1\u6279\u901a\u9053\u65f6\u7b97\u672a\u7b54\u590d')
  const denied = summary({ decision: 'deny', feedback: '\u6539\u7528\u9879\u76ee\u5185\u8def\u5f84' })
  ok(denied.allowed === false && denied.decision === 'deny' && denied.feedback === '\u6539\u7528\u9879\u76ee\u5185\u8def\u5f84', '\u5b50\u4ee3\u7406\u62d2\u7edd\u7406\u7531\u4f20\u56de danger-guard', JSON.stringify(denied))
  ok(summary({ decision: 'no-answer' }).decision === 'no-answer', '\u672a\u7b54\u590d\u4e0d\u518d\u5f53\u4f5c\u62d2\u7edd')
  console.log(`子代理定向检查通过：${checks}项（独立数据目录、假RPC、临时Git）`)
} finally {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(scratch, { recursive: true, force: true })
}
