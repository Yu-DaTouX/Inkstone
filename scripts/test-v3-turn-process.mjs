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

function seg(id, { commentary = [], tools = [], response = null } = {}) {
  return {
    id,
    sourceMessageId: `m-${id}`,
    runId: null,
    thinking: '',
    thinkingLive: false,
    tools,
    texts: [...commentary, ...(response ? [response] : [])],
    response,
    commentary
  }
}

const mod = await loadModule()
const { splitTurnProcess, processTools, processNotes, processSummaryLabel, runningTool, narrationLine, failedCount } = mod

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
  ok(processTools(out.process).length === 3, '过程里共 3 个工具', processTools(out.process).length)
  ok(runningTool(processTools(out.process))?.id === 't3', '当前运行工具取最后一个未完成的', runningTool(processTools(out.process))?.id)
}

group('多段旁白：按原顺序保留，最新一句用于运行中标签')
{
  const out = splitTurnProcess([
    seg('s0', { commentary: [text('c0', '第一句')], tools: [tool('t1', 'bash')] }),
    seg('s1', { commentary: [text('c1', '第二句')], tools: [tool('t2', 'bash')] }),
    seg('s2', { commentary: [text('c2', '第三句')] }),
    seg('s3', { response: text('r1', '收尾') })
  ])
  ok(processNotes(out.process).join('|') === '第一句|第二句|第三句', '旁白顺序保留', processNotes(out.process))
  ok(narrationLine('## 标题行\n\n第二行') === '标题行', '旁白取第一行非空并去掉标题标记', narrationLine('## 标题行\n\n第二行'))
  ok(narrationLine('  - **加粗** `代码`  ') === '加粗 代码', '旁白去掉列表与强调符号', narrationLine('  - **加粗** `代码`  '))
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

group('标签：工具汇总、失败数与空过程')
{
  const tools = [tool('a', 'bash'), tool('b', 'bash', 'error'), tool('c', 'read', 'error', { cancelled: true }), tool('d', 'read')]
  ok(failedCount(tools) === 1, '失败数不计已取消的', failedCount(tools))
  const zh = processSummaryLabel(tools, true, '过程')
  ok(zh.startsWith('已运行 2 个命令') && zh.includes('已读取 2 个文件') && zh.endsWith('（1 个失败）'), '中文汇总含类别与失败数', zh)
  ok(processSummaryLabel([], true, '过程') === '过程', '没有工具时回退到「过程」', processSummaryLabel([], true, '过程'))
  ok(processSummaryLabel([tool('a', 'bash')], false, 'Process') === 'Ran 1 command', '英文汇总单数', processSummaryLabel([tool('a', 'bash')], false, 'Process'))
  const empty = splitTurnProcess([])
  ok(empty.process.length === 0 && empty.reply === null && empty.tail.length === 0, '空回合不出过程也没有回复', empty)
}

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
if (fail > 0) process.exitCode = 1
