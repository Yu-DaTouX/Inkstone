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
const { splitTurnProcess, processPreview, mergeQuietSegments, pickLiveSegments, segmentSteps, processSummary, processFailuresAlert, lineDelta, estimateCallLines } = mod

group('只有回复：没有过程行，行为与原来一致')
{
  const R = text('r1', '结论', false)
  const out = splitTurnProcess([seg('s0', { response: R })])
  ok(out.process.length === 0, '过程行为空', out.process.length)
  ok(out.reply?.response?.id === 'r1', '回复保留', out.reply?.response?.id)
  ok(out.tail.length === 0, '没有尾部段', out.tail.length)
}

group('收尾卡片前后的多条正文都可读')
{
  const out = splitTurnProcess([
    seg('before-wrap', { response: text('long-reply', '完整交付与文件地址') }),
    seg('after-wrap', { response: text('short-reply', '请决定下一步') })
  ])
  ok(out.leadReplies.map((segment) => segment.response.text).join() === '完整交付与文件地址' && out.earlierReplies.length === 0, '保留卡片前的正文（没有工具，排在过程之前）', out)
  ok(out.reply.response.text === '请决定下一步' && out.process.length === 0, '末条回复保留且前文不藏入过程区', out)
}

group('搜索卡片不进入运行中的旧步骤折叠区')
{
  const out = pickLiveSegments([
    seg('web-old', { tools: [{ ...tool('web-call', 'web_search'), args: { query: 'fixture' } }] }),
    ...Array.from({ length: 5 }, (_, i) => seg(`normal-${i}`, { tools: [tool(`read-${i}`, 'read')] }))
  ])
  ok(out.shown.some((segment) => segment.id === 'web-old'), '较早的搜索步骤仍在正文过程区可见', out.shown.map((segment) => segment.id))
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
  ok(steps[0].kind === 'thinking' && steps[0].thinking.text === '先看目录', '首段推理排在全部工具之前', steps)
  ok(steps.slice(1).map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : s.kind === 'notes' ? 'note:' + s.notes.map((n) => n.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 't1 > think:再问用户 > t2', '合并后第二段推理排在它自己的工具之前、前一段工具之后', steps)
  const inner = segmentSteps({
    ...seg('i0', { tools: [tool('a', 'bash'), tool('b', 'read'), tool('c', 'read')] }),
    thinking: '一\n\n二\n\n三',
    thinkingLive: true,
    thinkingParts: [{ text: '一', at: 0 }, { text: '二', at: 1, ms: 300 }, { text: '三', at: 3, ms: 200 }]
  })
  ok(inner.map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : s.kind === 'notes' ? 'note:' + s.notes.map((n) => n.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 'think:一 > a > think:二 > b+c > think:三', '同一段内多次推理按工具位置穿插', inner)
  ok(inner.at(-1).thinking.live === true && inner[2].thinking.live === false && inner[0].thinking.live === false, '只有最后一段推理标为进行中', inner)
  const narrated = segmentSteps({
    ...seg('n0', { commentary: [{ ...text('k1', '开始修复'), at: 1 }], tools: [tool('a', 'bash'), tool('b', 'bash')] }),
    thinking: '先读\n\n再改',
    thinkingParts: [{ text: '先读', at: 0 }, { text: '再改', at: 1 }]
  })
  ok(narrated.map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : s.kind === 'notes' ? 'note:' + s.notes.map((n) => n.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 'think:先读 > a > think:再改 > note:k1 > b', '后一条消息的说明排在它自己的工具之前、更早的工具之后，同位置推理在说明之前', narrated)
  const legacy = segmentSteps(seg('n1', { commentary: [text('k2', '旧记录')], tools: [tool('a', 'bash')] }))
  ok(legacy.map((s) => s.kind === 'tools' ? s.tools.map((c) => c.id).join('+') : s.kind === 'notes' ? 'note:' + s.notes.map((n) => n.id).join('+') : 'think:' + s.thinking.text).join(' > ') === 'note:k2 > a', '没有位置的说明按旧行为排在最前', legacy)
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

group('每轮过程入口：摘要只数已有思考段与操作')
{
  const keep = splitTurnProcess([seg('k0', { thinking: '先想', response: text('r1', '回答', false) })], { keepThinking: true })
  ok(keep.process.length === 1 && keep.process[0].response === null && keep.reply?.response?.id === 'r1', '保留思考时，只有推理的回合也有过程入口，回复不进入口', keep.process)
  const plain = splitTurnProcess([seg('k1', { thinking: '先想', response: text('r1', '回答', false) })])
  ok(plain.process.length === 0, '默认仍不因推理单独生成过程行', plain.process)
  const turn = [
    seg('t0', { thinking: '读文件前', tools: [tool('a', 'read'), tool('b', 'bash', 'error')] }),
    { ...seg('t1', { commentary: [text('c1', '再看看')], tools: [tool('c', 'todo_write'), tool('d', 'read', 'ok', { parentToolCallId: 'a' })] }), thinkingParts: [{ text: '一', at: 0 }, { text: '二', at: 1 }] },
    seg('t2', { tools: [tool('e', 'grep')] })
  ]
  const summary = processSummary(turn)
  ok(summary.thinking === 3, '思考按段计数，同一段多次推理分开计', summary)
  ok(summary.actions === 3, '操作数不含待办调用与子调用', summary)
  ok(summary.failed === 1, '失败数来自已有工具状态', summary)
  const none = processSummary([seg('n0', { commentary: [text('c', '只有旁白')] })])
  ok(none.thinking === 0 && none.actions === 0 && none.failed === 0, '只有旁白时摘要为空，入口退回无标题的铺开', none)
}

group('过程行失败计数：只按回合最终状态决定是否标红')
{
  ok(processFailuresAlert({ terminalReason: 'completed' }, false) === false, '正常收尾：失败计数不标红')
  ok(processFailuresAlert({}, false) === false, '没有终止记录且没有错误：按正常收尾处理')
  ok(processFailuresAlert({ terminalReason: 'completed', error: '临时错误', errorRecovered: true }, false) === false, '中途报错后恢复并正常收尾：不标红')
  ok(processFailuresAlert({ terminalReason: 'failed' }, false) === true, '以失败结束：标红')
  ok(processFailuresAlert({ terminalReason: 'stopped' }, false) === true, '被中止：标红')
  ok(processFailuresAlert({ terminalReason: 'interrupted' }, false) === true, '被中断：标红')
  ok(processFailuresAlert({ error: '模型报错' }, false) === true, '以错误结束：标红')
  ok(processFailuresAlert({ terminalReason: 'completed' }, true) === true, '运行中保持现状：失败计数仍标红')
}

group('回合结束后进度叙述收进过程：最终答复始终露出')
{
  const segs = [
    seg('f0', { response: text('lead', '我先确认仓库地址。', false) }),
    seg('f1', { tools: [tool('t1', 'bash')], response: text('n1', '备份已保存。正在核对提交。', false) }),
    seg('f2', { tools: [tool('t2', 'bash')], response: text('n2', '远端已更新。还有一处残留。', false) }),
    seg('f3', { tools: [tool('t3', 'read')], response: text('final', '已从远端撤下。', false) })
  ]
  const live = splitTurnProcess(segs)
  ok(live.earlierReplies.map((s) => s.id).join() === 'f1,f2', '运行中（不折叠）：工具之后的叙述照常露出', live.earlierReplies.map((s) => s.id))
  const folded = splitTurnProcess(segs, { foldReplies: true })
  ok(folded.earlierReplies.length === 0, '结束后：工具之后的叙述不再露出', folded.earlierReplies)
  ok(folded.leadReplies.map((s) => s.id).join() === 'f0', '第一次工具调用之前的叙述仍露出', folded.leadReplies.map((s) => s.id))
  ok(folded.reply?.response?.id === 'final', '最终答复始终露出', folded.reply?.response?.id)
  ok(folded.process.map((s) => s.id).join() === 'f1,f1:narration,f2,f2:narration,f3', '叙述与工具按时间交错排在过程里', folded.process.map((s) => s.id))
  ok(folded.process[1].commentary[0]?.id === 'n1' && folded.process[0].response === null, '叙述作为过程旁白，原段去掉回复', folded.process.slice(0, 2))
  ok(processPreview(folded.process) === '还有一处残留。', '摘要预览取最后一句进度叙述', processPreview(folded.process))
  ok(processSummary(folded.process).actions === 3, '折叠不改变操作计数', processSummary(folded.process))
  const long = processPreview([seg('l0', { commentary: [text('l', '第二套扫描器 Gitleaks 的 8 条命中也已逐项核对，均为扩展公钥、界面存储键名或测试数据，尚未发现真正需要撤下的凭据或个人资料文件内容')] })])
  ok(long === '第二套扫描器 Gitleaks 的 8 条命中也已逐项核对，均为扩展公钥、界面存储键名或测试数据\u2026', '过长的预览在分句处截断', long)
}

group('过程摘要：按工具类型归类并带改动行数')
{
  ok(JSON.stringify(lineDelta('a\nb\nc', 'a\nB\nc')) === JSON.stringify({ added: 1, removed: 1 }), '行增删按公共首尾裁掉后计算', lineDelta('a\nb\nc', 'a\nB\nc'))
  ok(JSON.stringify(estimateCallLines({ args: { path: 'a', edits: [{ oldText: 'x', newText: 'y\nz' }] } })) === JSON.stringify({ added: 2, removed: 1 }), '没有快照时用 edit 参数估算行数')
  ok(JSON.stringify(estimateCallLines({ args: {}, details: { fileDiff: { path: 'a', added: 4, removed: 2, status: 'modified', patch: '', before: {}, after: {} } } })) === JSON.stringify({ added: 4, removed: 2 }), '有快照时以快照为准')
  const mixed = processSummary([seg('p0', { tools: [
    tool('b1', 'bash', 'ok', { args: { command: 'ls' } }),
    tool('b2', 'bash', 'ok', { args: { command: 'pwd' } }),
    tool('c1', 'codemode', 'ok', { args: { code: 'x' } }),
    tool('r1', 'read', 'ok', { args: { path: 'a.md' } }),
    tool('r2', 'read', 'ok', { args: { path: 'a.md' } }),
    tool('r3', 'read', 'ok', { args: { path: 'b.md' } }),
    tool('e1', 'edit', 'ok', { args: { path: '.local-docs/STATUS.md', edits: [{ oldText: 'old', newText: 'new' }] } }),
    tool('w1', 'write', 'ok', { args: { path: 'new.md', content: 'a\nb' } }),
    tool('w2', 'edit', 'ok', { args: { path: 'new.md', edits: [{ oldText: 'a', newText: 'A' }] } }),
    tool('x1', 'edit', 'error', { args: { path: 'bad.md', edits: [{ oldText: 'a', newText: 'b' }] } }),
    tool('q1', 'AskUserQuestion', 'ok', { args: { questions: [] } }),
    tool('g1', 'grep', 'ok', { args: { pattern: 'x' } })
  ] })])
  ok(mixed.commands === 2 && mixed.code === 1, '命令与 codemode 分开计', mixed)
  ok(mixed.reads === 2, '读取按不同文件计', mixed.reads)
  ok(mixed.edits.length === 1 && mixed.edits[0].base === 'STATUS.md' && mixed.edits[0].added === 1 && mixed.edits[0].removed === 1, '编辑记文件名与行数，失败的编辑不算', mixed.edits)
  ok(mixed.creates.length === 1 && mixed.creates[0].added === 3 && mixed.creates[0].removed === 1, '新建后再编辑仍算新建，行数累加', mixed.creates)
  ok(mixed.searches === 1 && mixed.other === 0, '提问不算其他操作，grep 记为搜索', mixed)
  const web = processSummary([seg('w0', { tools: [tool('ws', 'web_search', 'ok', { args: { query: 'float rounding' } })] })])
  ok(web.web === 1 && web.other === 0, '单独一次联网搜索记为联网搜索，不算其他操作', web)
  const fetched = processSummary([seg('w1', { tools: [tool('wf', 'web_fetch', 'ok', { args: { url: 'https://example.com' } }), tool('ls', 'ls', 'ok', { args: { path: '.' } }), tool('mc', 'mcp__srv__thing', 'ok')] })])
  ok(fetched.fetches === 1 && fetched.lists === 1 && fetched.other === 1, '网页抓取与列目录各自计数，MCP 仍归其他', fetched)
}

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
if (fail > 0) process.exitCode = 1
