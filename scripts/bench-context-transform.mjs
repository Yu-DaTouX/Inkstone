/**
 * C-3 出口 4 的最后一块：**600K / 700K 长请求的 CPU 与字符串分配成本单列**。
 *
 * S4 的设计前提是估算 O(体积)、没有增量缓存 —— 所以「token 装不装得下」
 * 之外，还要回答「一次 60–70 万 token 的上下文变换要花多少 CPU / 分配多少字符串」。
 *
 * 这条基准 **cost 0**：不碰模型、不碰 Electron，直接 import 随包扩展的变换层，
 * 用合成的大工具结果逼近目标体积，量 `estimateTokens`（逐条估算）→
 * `adaptMessages`（身份适配）→ `planToolSweep` / `applyToolSweep`（整理）四步。
 *
 * 它不是性能承诺，只是一条可复跑的对照：低于下面的上限即视为「单线程里可接受」。
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
  adaptMessages,
  applyToolSweep,
  estimateTokens,
  planToolSweep,
  watermarkOfEntries
} from '../resources/pi-extensions/context-transform.js'

const require = createRequire(import.meta.url)
void require

/** 单轮上限：超过它就不是「偶尔慢一下」，而是主线程会被卡住。 */
const LIMIT_MS = { estimate: 400, adapt: 400, plan: 400, apply: 400 }

function buildMessages(targetTokens) {
  const messages = []
  let tokens = 0
  let i = 0
  while (tokens < targetTokens) {
    i += 1
    /* 单条工具结果约 10k 字符 —— 与真实 bash / read 的长输出同量级 */
    const body = `line ${i}\n`.repeat(2000)
    messages.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id: `t${i}`, name: 'bash', arguments: { command: `seq 1 2000` } }]
    })
    messages.push({ role: 'toolResult', toolCallId: `t${i}`, content: [{ type: 'text', text: body }] })
    tokens += estimateTokens(body) + 40
  }
  return messages
}

const results = []
let ok = true
const okLine = (good, text) => {
  results.push((good ? '  ✓ ' : '  ✗ ') + text)
  if (!good) ok = false
}

for (const size of [600_000, 700_000]) {
  const messages = buildMessages(size)
  const actual = messages.reduce((n, m) => n + estimateTokens(m.content?.[0]?.text ?? ''), 0)
  const entryIds = messages.map((_, idx) => `e${idx}`)
  const branch = messages.map((m, idx) => ({
    type: 'message',
    id: `e${idx}`,
    message: m
  }))

  const t0 = performance.now()
  const est = messages.map((m) => estimateTokens(m.content?.[0]?.text ?? ''))
  const t1 = performance.now()
  const adapted = adaptMessages(messages, entryIds, { recentTail: { target: 64_000, max: 96_000 } })
  const t2 = performance.now()
  const planned = planToolSweep({
    messages,
    entryIds,
    watermark: watermarkOfEntries(branch),
    /* recentTail 压到 0，让这次基准真的走到 applyToolSweep（否则全被尾部保护挡住） */
    recentTail: { target: 0, max: 0 },
    sweep: { minReclaimTokens: 1, minReclaimRatio: 0 },
    opts: { activePaths: [] }
  })
  const t3 = performance.now()
  const applied = planned.ok ? applyToolSweep(messages, planned.plan) : { changed: 0, messages }
  const t4 = performance.now()

  const row = {
    目标: size,
    实际估算: actual,
    条数: messages.length,
    估算ms: +(t1 - t0).toFixed(1),
    适配ms: +(t2 - t1).toFixed(1),
    规划ms: +(t3 - t2).toFixed(1),
    应用ms: +(t4 - t3).toFixed(1),
    合计ms: +(t4 - t0).toFixed(1)
  }
  console.log(`\n=== 约 ${size / 1000}K token（实测 ${actual}）===`)
  console.log(`  消息 ${row.条数} 条｜估算 ${row.估算ms}ms｜适配 ${row.适配ms}ms｜规划 ${row.规划ms}ms｜应用 ${row.应用ms}ms｜合计 ${row.合计ms}ms`)
  console.log(`  适配条目 ${Array.isArray(adapted) ? adapted.length : '?'} 条｜清扫改动 ${applied.changed} 条`)
  okLine(row.估算ms < LIMIT_MS.estimate, `逐条估算 ${row.估算ms}ms < ${LIMIT_MS.estimate}ms`)
  okLine(row.适配ms < LIMIT_MS.adapt, `身份适配 ${row.适配ms}ms < ${LIMIT_MS.adapt}ms`)
  okLine(row.规划ms < LIMIT_MS.plan, `清扫规划 ${row.规划ms}ms < ${LIMIT_MS.plan}ms`)
  okLine(row.应用ms < LIMIT_MS.apply, `清扫应用 ${row.应用ms}ms < ${LIMIT_MS.apply}ms`)
  okLine(Number.isFinite(est[0]), '估算用整数 token 数（无 NaN）')
}

console.log('\n' + results.join('\n'))
console.log(ok ? '\nC-3 出口 4 基准通过' : '\nC-3 出口 4 基准未通过')
process.exit(ok ? 0 : 1)
