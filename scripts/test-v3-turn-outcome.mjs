#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

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

const outdir = await mkdtemp(join(tmpdir(), 'v3-turn-outcome-'))
const outfile = join(outdir, 'turn-outcome.mjs')
await build({
  entryPoints: [normalize(resolve(ROOT, 'src/renderer/src/features/session/turn-outcome.ts'))],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: true,
  outfile,
  logLevel: 'silent'
})
const { splitDecision, decisionTitle, replyFileLinks, outcomeFiles, turnAnswers, userTurnOrdinals, decisionOutcomes, leadSentence } = await import(pathToFileURL(posix(outfile)).href)
await rm(outdir, { recursive: true, force: true })

process.stdout.write('\n▌待决策：只取答复末段的提问\n')
{
  const text = '草稿已经建好。\n\n- Windows 安装包\n- APK\n\n现在公开发布吗？回复「公开发布」，或者你先看看再说。'
  const out = splitDecision(text)
  ok(out?.question.startsWith('现在公开发布吗？'), '末段提问拆成决策块', out)
  ok(out?.body.endsWith('- APK'), '前文保留为正文', out?.body)
  ok(splitDecision('已经推送完成。\n\n没有需要你处理的事。') === null, '末段没有问号：不拆', null)
  ok(splitDecision('结论如下。\n\n- 要不要改？\n- 再看') === null, '末段是列表：不拆', null)
  ok(splitDecision('看这个：\n\n```js\nconst a = b ? c : d\n```') === null, '末段是代码块：不拆', null)
  ok(splitDecision('参考 `a?b` 和 [链接](https://x.dev/?q=1)。\n\n已完成 `x?y`。') === null, '问号只在行内代码或链接里：不拆', null)
  ok(splitDecision('要我继续吗？')?.body === '', '整条答复只有一句提问：正文为空', splitDecision('要我继续吗？'))
  ok(splitDecision(`${'说明'.repeat(10)}\n\n${'很长的段落'.repeat(80)}？`) === null, '末段过长：不当作决策', null)
}

process.stdout.write('\n▌待决策：问题本身作卡片标题\n')
{
  const a = decisionTitle('现在公开发布吗？回复「公开发布」，或者你先看看再说。')
  ok(a.title === '现在公开发布吗？' && a.rest === '回复「公开发布」，或者你先看看再说。', '提问句作标题，其余作说明', a)
  const b = decisionTitle('草稿已就绪。要推送 `v0.13.0` 吗？推送后 CI 会打包。')
  ok(b.title === '要推送 `v0.13.0` 吗？' && b.rest === '草稿已就绪。推送后 CI 会打包。', '标题取第一句提问，前后文按原顺序留作说明', b)
  const c = decisionTitle('参考 `a?b` 后决定：要继续「下一步」吗？')
  ok(c.title === '参考 `a?b` 后决定：要继续「下一步」吗？' && c.rest === '', '行内代码里的问号不断句', c)
  const d = decisionTitle(`${'很长的问题'.repeat(40)}？`)
  ok(d.title === '' && d.rest.length > 0, '提问句过长：不作标题，整段留作说明', d)
  const e = decisionTitle('Ship it? Reply "ship" or wait.')
  ok(e.title === 'Ship it?' && e.rest === 'Reply "ship" or wait.', '英文句子之间保留空格', e)
}

process.stdout.write('\n▌本轮文件：取答复里的本地文件链接\n')
{
  const text = '我已准备好[Support 请求草稿](E:/pi/.local-docs/support-request-draft.md)。\n\n完整记录在[撤下结果报告](E:/pi/.local-docs/result.md)，另见 [PR #1](https://github.com/a/b/pull/1)、[目录](E:/pi/docs/) 和 ![图](E:/pi/a.png)。\n\n```md\n[忽略](E:/pi/code.md)\n```\n\n再提一次[报告](E:/pi/.local-docs/result.md)。'
  const files = replyFileLinks(text)
  ok(files.map((f) => f.base).join() === 'support-request-draft.md,result.md', '只收本地文件，去重，跳过网址、目录、图片和代码块', files)
  ok(files[1]?.label === '撤下结果报告', '保留链接文字作用途说明', files[1])
}

process.stdout.write('\n▌本轮文件：不重复正文已写明的文件名和改动卡里的文件\n')
{
  const text = '草稿在[Support 请求草稿](E:/pi/.local-docs/support-request-draft.md)，记录写进了 [STATUS.md](E:/pi/.local-docs/STATUS.md) 和 [`.local-docs/result.md`](E:/pi/.local-docs/result.md)，改动见[说明](E:/pi/docs/notes.md)。'
  const links = replyFileLinks(text)
  const extra = outcomeFiles(links, ['docs/notes.md'])
  ok(extra.map((f) => f.base).join() === 'support-request-draft.md', '只留下正文用友好名称遮住真实文件名、且不在改动卡里的文件', extra)
  ok(outcomeFiles(links, ['E:\\pi\\.local-docs\\support-request-draft.md', 'docs/notes.md']).length === 0, '全部已在正文或改动卡里出现：不显示本轮文件', null)
}

process.stdout.write('\n▌回答归属：下一条用户消息\n')
{
  const turns = [
    { kind: 'user', id: 'u1', msg: { text: '发布吧' } },
    { kind: 'assistant', id: 'a1' },
    { kind: 'user', id: 'u2', msg: { text: ' 公开发布\n顺便更新说明 ' } },
    { kind: 'assistant', id: 'a2' },
    { kind: 'note', id: 'n1' },
    { kind: 'assistant', id: 'a3' }
  ]
  const answers = turnAnswers(turns)
  ok(answers.get('a1') === '公开发布\n顺便更新说明', '后面紧跟用户消息：记为已回答', answers.get('a1'))
  ok(!answers.has('a2'), '后面不是用户消息：不判断', answers.get('a2'))
  ok(answers.get('a3') === null, '最后一轮：仍待回答', answers.get('a3'))
}

process.stdout.write('\n▌回合序号：只数用户回合\n')
{
  const turns = [
    { kind: 'user', id: 'u1', msg: { text: '第一条' } },
    { kind: 'assistant', id: 'a1' },
    { kind: 'note', id: 'n1' },
    { kind: 'user', id: 'u2', msg: { text: '第二条' } },
    { kind: 'assistant', id: 'a2' }
  ]
  const ordinals = userTurnOrdinals(turns)
  ok(ordinals.get('u1') === 1 && ordinals.get('u2') === 2 && !ordinals.has('a1') && !ordinals.has('n1'), '用户回合按出现顺序编号', [...ordinals])
}

process.stdout.write('\n▌决策卡结局：取下一轮结论首句或状态\n')
{
  const reply = (text, extra = {}) => ({ kind: 'assistant', id: extra.id, segments: [{ response: { text } }], response: { text }, streaming: false, ...extra })
  const turns = [
    { kind: 'user', id: 'u1', msg: { text: '发布吧' } },
    reply('现在公开发布吗？', { id: 'a1' }),
    { kind: 'user', id: 'u2', msg: { text: '公开发布' } },
    reply('**Inkstone 0.13.0 已公开发布**，GitHub 上标为 Latest。附带文件见下。', { id: 'a2' }),
    { kind: 'user', id: 'u3', msg: { text: '再发手机版' } },
    reply('', { id: 'a3', streaming: true }),
    { kind: 'user', id: 'u4', msg: { text: '停' } },
    reply('做了一半', { id: 'a4', terminalReason: 'stopped' })
  ]
  const outcomes = decisionOutcomes(turns)
  ok(outcomes.get('a1')?.state === 'done' && outcomes.get('a1').text === 'Inkstone 0.13.0 已公开发布，GitHub 上标为 Latest。', '已回复：结局取下一轮答复首句，去掉 Markdown 标记', outcomes.get('a1'))
  ok(outcomes.get('a2')?.state === 'running', '下一轮还在跑：结局为进行中', outcomes.get('a2'))
  ok(outcomes.get('a3')?.state === 'stopped', '下一轮被中止：结局为已中止', outcomes.get('a3'))
  ok(!outcomes.has('a4'), '没有后续回复：不给结局', outcomes.get('a4'))
  ok(leadSentence('- 第一项很长' + '字'.repeat(200)).length <= 120, '首句过长时截断', leadSentence('- 第一项很长' + '字'.repeat(200)).length)
}

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
