#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
const abs = (rel) => normalize(resolve(ROOT, rel))

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), 'v3-process-strip-'))
  const outfile = join(outdir, 'process-strip.mjs')
  try {
    await build({
      entryPoints: [abs('src/renderer/src/features/session/process-strip.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: true,
      outfile,
      logLevel: 'silent'
    })
    return await import(pathToFileURL(posix(outfile)).href)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

const tool = (id, name, extra = {}) => ({ id, name, status: 'ok', args: {}, ...extra })

function seg(id, { tools = [], thinking = '', thinkingMs, thinkingParts } = {}) {
  return {
    id,
    sourceMessageId: `m-${id}`,
    runId: null,
    thinking,
    ...(thinkingMs ? { thinkingMs } : {}),
    ...(thinkingParts ? { thinkingParts } : {}),
    thinkingLive: false,
    tools,
    texts: [],
    response: null,
    commentary: []
  }
}

const shape = (parts) => parts.map((part) => `${part.kind}:${part.ms}`).join(' ')

const { processStripParts, compactStrip, STRIP_MAX_PARTS } = await loadModule()

group('时间条：按步骤种类和耗时分段')
{
  const parts = processStripParts([
    seg('s1', { thinking: '想一下', thinkingMs: 4000, tools: [tool('r1', 'read', { startedAt: 10000, endedAt: 10400 })] }),
    seg('s2', { tools: [tool('b1', 'bash', { status: 'error', startedAt: 11000, endedAt: 13000 })] })
  ])
  ok(shape(parts) === 'think:4000 tool:1000 fail:2000', '思考、工具、失败各成一段，不足一秒按一秒', shape(parts))
}

group('时间条：等用户决定的时间单独成段')
{
  const approved = tool('b1', 'bash', { startedAt: 1000, endedAt: 16000, approval: { id: 'a', toolCallId: 'b1', kind: 'danger', tool: 'bash', title: 'rm', choice: 'once', askedAt: 1000, at: 13000 } })
  const parts = processStripParts([seg('s1', { tools: [approved] })])
  ok(shape(parts) === 'wait:12000 tool:3000', '审批等待从工具耗时里拆出来', shape(parts))
  const denied = tool('b2', 'bash', { status: 'error', denied: true, startedAt: 1000, endedAt: 3000 })
  ok(shape(processStripParts([seg('s2', { tools: [denied] })])) === 'tool:2000', '被拒绝的调用不算失败', shape(processStripParts([seg('s2', { tools: [denied] })])))
}

group('时间条：子代理与没有时间戳的调用')
{
  const parts = processStripParts([
    seg('s1', { tools: [tool('g1', 'bash', { args: { command: 'yan subagent start --brief x' }, startedAt: 1000, endedAt: 39000 }), tool('e1', 'edit')] })
  ])
  ok(shape(parts) === 'sub:38000 tool:1000', '派子代理单独着色，缺时间戳的按一秒', shape(parts))
}

group('时间条：相邻同类合并，过长时按时间分箱')
{
  const same = compactStrip([{ kind: 'tool', ms: 1000 }, { kind: 'tool', ms: 2000 }, { kind: 'think', ms: 500 }])
  ok(shape(same) === 'tool:3000 think:500', '相邻同类合成一段', shape(same))
  const many = []
  for (let index = 0; index < 400; index += 1) many.push({ kind: index % 2 ? 'tool' : 'think', ms: 1000 })
  many[201] = { kind: 'fail', ms: 1000 }
  const binned = compactStrip(many)
  ok(binned.length <= STRIP_MAX_PARTS, '段数不超过上限', binned.length)
  ok(binned.some((part) => part.kind === 'fail'), '分箱后失败仍然可见', shape(binned))
  const total = binned.reduce((sum, part) => sum + part.ms, 0)
  ok(Math.abs(total - 400000) < 1, '分箱前后总时长不变', total)
}

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
if (fail > 0 || pass === 0) process.exitCode = 1
