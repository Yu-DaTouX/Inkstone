import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMPACTIONS = 18
const TOOL_OUTPUT_CHARS = 50_000
const TOOL_ARGS_CHARS = 1_200

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)}MB`
const kb = (bytes) => `${(bytes / 1024).toFixed(0)}KB`

function history(turns) {
  const raw = []
  for (let turn = 0; turn < turns; turn += 1) {
    raw.push({ role: 'user', content: `第 ${turn} 轮：读三个大文件并汇总。`.repeat(40), timestamp: turn * 10_000 })
    const calls = [0, 1].map((slot) => ({
      type: 'toolCall',
      id: `call-${turn}-${slot}`,
      name: 'read',
      arguments: { path: `big/a${turn}${slot}.txt`, limit: TOOL_OUTPUT_CHARS }
    }))
    raw.push({
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${turn} 轮：先读文件。`.repeat(30) }, ...calls],
      timestamp: turn * 10_000 + 1
    })
    for (const [slot, call] of calls.entries()) {
      raw.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: 'read',
        content: [{ type: 'text', text: `${'x'.repeat(TOOL_ARGS_CHARS)}${'a'.repeat(TOOL_OUTPUT_CHARS)}` }],
        timestamp: turn * 10_000 + 2 + slot
      })
    }
  }
  return raw
}

const dir = await mkdtemp(join(tmpdir(), 'yan-sync-bench-'))
try {
  const outfile = join(dir, 'projector.mjs')
  await build({
    entryPoints: [join(ROOT, 'src/main/session-items/projector.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { projectHistory } = await import(pathToFileURL(outfile).href)
  const planFile = join(dir, 'plan.mjs')
  await build({
    entryPoints: [join(ROOT, 'src/main/session-sync-plan.ts')],
    outfile: planFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { planSessionSync } = await import(pathToFileURL(planFile).href)

  const messages = projectHistory(history(60))
  const sizes = messages.map((message) => JSON.stringify(message).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  console.log(`会话形态：${messages.length} 条消息，整份 ${mb(total)}（T2 实测 p1b：234 条 / 10.83MB）`)

  const prefixes = []
  let running = 0
  for (const size of sizes) {
    running += size
    prefixes.push(running)
  }
  const targetOf = (index) => {
    const from = 1_268_430
    const to = 5_620_716
    return from + ((to - from) * index) / (COMPACTIONS - 1)
  }

  const rows = []
  let beforeTotal = 0
  let afterTotal = 0
  for (let index = 0; index < COMPACTIONS; index += 1) {
    const target = Math.min(targetOf(index), total)
    let length = prefixes.findIndex((bytes) => bytes >= target)
    if (length < 0) length = messages.length
    length = Math.max(2, length + 1)
    const synced = messages.slice(0, length)

    const replayed = synced.map((message) => ({ ...message }))
    const lastAssistant = replayed.findLastIndex((message) => message.role === 'assistant')
    if (lastAssistant >= 0) {
      replayed[lastAssistant] = {
        ...replayed[lastAssistant],
        turnTiming: { logicalTurnId: `turn-${index}`, startedAt: index, endedAt: index + 1 }
      }
    }

    const beforeBytes = JSON.stringify(synced).length
    const plan = planSessionSync(synced, replayed)
    const afterBytes =
      plan.kind === 'full'
        ? JSON.stringify(replayed).length
        : plan.kind === 'none'
          ? 0
          : JSON.stringify({ ch: 'sync-delta', payload: plan }).length
    beforeTotal += beforeBytes
    afterTotal += afterBytes
    rows.push({ index: index + 1, messages: length, beforeBytes, afterBytes, kind: plan.kind })
  }

  console.log('\n压缩次数 | 消息数 | 改前（整份 sync） | 改后（sync-delta） | 计划')
  for (const row of rows) {
    console.log(
      `${String(row.index).padStart(8)} | ${String(row.messages).padStart(6)} | ${mb(row.beforeBytes).padStart(17)} | ${kb(row.afterBytes).padStart(18)} | ${row.kind}`
    )
  }
  console.log(
    `\n合计：改前 ${mb(beforeTotal)}（T2 实测 57.69MB）→ 改后 ${kb(afterTotal)}，节省 ${(100 - (afterTotal / beforeTotal) * 100).toFixed(1)}%`
  )

  const identicalPlan = planSessionSync(messages, messages.map((message) => ({ ...message })))
  console.log(`\n压缩后重放完全一致（无内容差异）：计划 ${identicalPlan.kind}，发送 0 字节`)

  const appendBaseline = messages.slice(0, messages.length - 6)
  const appendPlan = planSessionSync(appendBaseline, messages)
  console.log(
    `非压缩场景（中途追加 6 条消息）：改前 ${mb(JSON.stringify(messages).length)} → 改后 ${
      appendPlan.kind === 'delta' ? kb(JSON.stringify(appendPlan).length) : appendPlan.kind
    }（计划 ${appendPlan.kind}）`
  )

  const rewound = messages.slice(0, messages.length - 20)
  const rewindPlan = planSessionSync(messages, rewound)
  console.log(
    `回退场景（分支回退 20 条）：改前 ${mb(JSON.stringify(rewound).length)} → 改后 ${
      rewindPlan.kind === 'delta' ? kb(JSON.stringify(rewindPlan).length) : rewindPlan.kind
    }（计划 ${rewindPlan.kind}，空增量表示截断）`
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
