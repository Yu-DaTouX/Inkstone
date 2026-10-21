#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
  const outdir = await mkdtemp(join(tmpdir(), 'v3-turn-process-'))
  const outfile = join(outdir, 'turn-process.mjs')
  try {
    await build({
      entryPoints: [abs('src/renderer/src/features/session/turn-process.ts')],
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

const text = (id, body, hasTools = true) => ({ id, text: body, hasTools })
const tool = (id, name, status = 'ok', extra = {}) => ({ id, name, status, args: {}, ...extra })

function seg(id, { commentary = [], tools = [], response = null, thinking = '', thinkingMs, thinkingLive = false } = {}) {
  return {
    id,
    sourceMessageId: `m-${id}`,
    runId: null,
    thinking,
    ...(thinkingMs ? { thinkingMs } : {}),
    thinkingLive,
    tools,
    texts: [...commentary, ...(response ? [response] : [])],
    response,
    commentary
  }
}

const mod = await loadModule()
const { splitTurnProcess, mergeQuietSegments, pickLiveSegments, segmentSteps } = mod

group('只有回复：没有过程行，行为与原来一致')
{
  const R = text('r1', '结论', false)
  const out = splitTurnProcess([seg('s0', { response: R })])
  ok(out.process.length === 0, '过程行为空', out.process.length)
  ok(out.reply?.response?.id === 'r1', '回复保留', out.reply?.response?.id)
  ok(out.tail.length === 0, '没有尾部段', out.tail.length)
}

group('旁白 + 工具 + 回复：旁白与工具进过程行，回复在最后')
{
  const out = splitTurnProcess([
    seg('s0', { commentary: [text('c0', '我先看看目录')], tools: [tool('t1', 'bash')] }),
    seg('s1', { commentary: [text('c1', '顶层结构已看到一半')], tools: [tool('t2', 'read')] }),
    seg('s2', { response: text('r1', '完成') })
  ])
  ok(out.process.length === 2, '过程行两段（两组工具各一段）', out.process.length)
  ok(out.process.map((s) => s.id).join() === 's0,s1', '过程段保持原顺序', out.process.map((s) => s.id))
  ok(out.reply?.response?.text === '完成', '回复为最后的正式回复', out.reply?.response?.text)
  ok(out.reply.tools.length === 0 && out.reply.commentary.length === 0, '回复段只留正文', out.reply)
  ok(out.tail.length === 0, '没有尾部段', out.tail.length)
}

group('只有工具（运行中）：全部进过程行，没有回复')
{
  const out = splitTurnProcess([
    seg('s0', { tools: [tool('t1', 'bash', 'running')] }),
    seg('s1', { tools: [tool('t2', 'grep', 'ok'), tool('t3', 'read', 'pending')] })
  ])
  ok(out.reply === null, '没有回复', out.reply)
  ok(out.process.length === 2, '工具段全部进过程行', out.process.length)
  ok(out.process[1].tools.map((call) => call.id).join() === 't2,t3', '过程段保留工具顺序', out.process[1].tools.map((call) => call.id))
}

group('回复段自身带的解说与工具：归入过程行，回复段只留正文')
{
  const out = splitTurnProcess([
    seg('s0', { commentary: [text('c0', '先读文件')], tools: [tool('t1', 'read')], response: text('r1', '读完了') })
  ])
  ok(out.process.length === 1 && out.process[0].response === null, '过程段去掉回复', out.process)
  ok(out.process[0].commentary[0]?.id === 'c0' && out.process[0].tools[0]?.id === 't1', '过程段保留解说与工具', out.process[0])
  ok(out.reply?.response?.id === 'r1' && out.reply.tools.length === 0, '回复段只留正文', out.reply)
}

group('回复之后仍有的段：原样留在 tail，不进过程行')
{
  const out = splitTurnProcess([
    seg('s0', { commentary: [text('c0', '先看')], tools: [tool('t1', 'bash')] }),
    seg('s1', { response: text('r1', '这是回复') }),
    seg('s2', { tools: [tool('t2', 'bash')] })
  ])
  ok(out.reply?.response?.id === 'r1', '回复仍是最后一个正式回复', out.reply?.response?.id)
  ok(out.process.map((s) => s.id).join() === 's0', '过程只含回复之前的段', out.process.map((s) => s.id))
  ok(out.tail.length === 1 && out.tail[0].id === 's2', '回复之后的工具留在 tail', out.tail.map((s) => s.id))
}

group('正文断组与空过程（汇总文案移到 tool-run-model，见 test-tool-run-model）')
{
  const merged = mergeQuietSegments([
    seg('q0', { commentary: [text('k0', '先看')], tools: [tool('a', 'read')] }),
    seg('q1', { tools: [tool('b', 'bash')] }),
    seg('q2', { commentary: [text('k2', '再改')], tools: [tool('c', 'edit')] }),
    seg('q3', { tools: [tool('d', 'bash')] })
  ])
  ok(merged.map((s) => s.id).join() === 'q0,q2', '没有正文隔开的相邻工具段合并', merged.map((s) => s.id))
  ok(merged[0].tools.map((c) => c.id).join() === 'a,b' && merged[1].tools.map((c) => c.id).join() === 'c,d', '正文把工具分成两段', merged.map((s) => s.tools.map((c) => c.id)))
  const empty = splitTurnProcess([])
  ok(empty.process.length === 0 && empty.reply === null && empty.tail.length === 0, '空回合不出过程也没有回复', empty)
}

group('推理按段留在过程里：排在同段工具之前，回复段的推理排在最后')
{
  const out = splitTurnProcess([
    seg('s0', { thinking: '先看目录', thinkingMs: 800, tools: [tool('t1', 'bash')] }),
    seg('s1', { thinking: '再问用户', thinkingMs: 1200, tools: [tool('t2', 'question')] }),
    seg('s2', { thinking: '收尾', response: text('r1', '完成') })
  ])
  ok(out.process.map((s) => s.id).join() === 's0,s1,s2', '回复段只有推理时也进过程行尾部', out.process.map((s) => s.id))
  ok(out.process[2].response === null && out.process[2].thinking === '收尾', '过程里的回复段只留推理', out.process[2])
  ok(out.reply?.thinking === '' && out.reply?.response?.id === 'r1', '回复不再带推理', out.reply)
  const merged = mergeQuietSegments(out.process)
  ok(merged.map((s) => s.id).join() === 's0,s2', '相邻工具段仍合并，推理单独成段不并入', merged.map((s) => s.id))
  ok(merged[0].thinking === '先看目录\n\n再问用户' && merged[0].thinkingMs === 2000, '合并段的推理按原顺序拼接、用时相加', merged[0])
  const live = splitTurnProcess([
    seg('l0', { thinking: '想', tools: [tool('t1', 'bash')] }),
    seg('l1', { thinking: '还在想', thinkingLive: true })
  ])
  ok(live.process.map((s) => s.id).join() === 'l0,l1', '运行中只有推理的最新段排在最后', live.process.map((s) => s.id))
  const steps = segmentSteps(merged[0])
  ok(steps.lead.map((p) => p.text).join() === '先看目录', '首段推理排在全部工具之前', steps.lead)
  ok(steps.steps.map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 't1 > think:再问用户 > t2', '合并后第二段推理排在它自己的工具之前、前一段工具之后', steps.steps)
  const inner = segmentSteps({
    ...seg('i0', { tools: [tool('a', 'bash'), tool('b', 'read'), tool('c', 'read')] }),
    thinking: '一\n\n二\n\n三',
    thinkingLive: true,
    thinkingParts: [{ text: '一', at: 0 }, { text: '二', at: 1, ms: 300 }, { text: '三', at: 3, ms: 200 }]
  })
  ok(inner.steps.map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 'a > think:二 > b+c > think:三', '同一段内多次推理按工具位置穿插', inner.steps)
  ok(inner.steps.at(-1).thinking.live === true && inner.steps[1].thinking.live === false && inner.lead[0].live === false, '只有最后一段推理标为进行中', inner.steps)
  const plain = splitTurnProcess([seg('p0', { thinking: '只是想想', response: text('r1', '回答') })])
  ok(plain.process.length === 0, '没有工具与旁白时不因推理生成过程行', plain.process)
}

group('运行中默认展开：只留最近几段，其余收进「另外 N 项」')
{
  const many = Array.from({ length: 6 }, (_, i) => seg('s' + i, { commentary: [text('c' + i, '步骤' + i)], tools: [tool('a' + i, 'bash'), tool('b' + i, 'read')] }))
  const picked = pickLiveSegments(many)
  ok(picked.shown.map((x) => x.id).join() === 's3,s4,s5', '默认只留最近 3 段', picked.shown.map((x) => x.id))
  ok(picked.hidden === 6, '隐藏数按被收起的工具数计', picked.hidden)
  const short = pickLiveSegments(many.slice(0, 3))
  ok(short.shown.length === 3 && short.hidden === 0, '不超过上限时不隐藏', short)
  const pinned = pickLiveSegments([
    seg('p0', { tools: [tool('x', 'bash', 'error')] }),
    seg('p1', { tools: [tool('y', 'bash', 'error', { cancelled: true })] }),
    seg('p2', { tools: [tool('z', 'bash', 'running')] }),
    ...many.slice(0, 3)
  ])
  ok(pinned.shown.map((x) => x.id).join() === 'p0,p2,s0,s1,s2', '失败与进行中的段即使较早也保留，已取消的不算', pinned.shown.map((x) => x.id))
  ok(pinned.hidden === 1, '被收起的只剩已取消的那段', pinned.hidden)
  const quiet = pickLiveSegments(Array.from({ length: 5 }, (_, i) => seg('n' + i, { commentary: [text('k' + i, '想法')] })))
  ok(quiet.shown.length === 3 && quiet.hidden === 2, '只有旁白的段按段数计', quiet)
}

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
if (fail > 0) process.exitCode = 1
