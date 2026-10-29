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
const { splitDecision, replyFileLinks, turnAnswers } = await import(pathToFileURL(posix(outfile)).href)
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

process.stdout.write('\n▌本轮文件：取答复里的本地文件链接\n')
{
  const text = '我已准备好[Support 请求草稿](E:/pi/.local-docs/support-request-draft.md)。\n\n完整记录在[撤下结果报告](E:/pi/.local-docs/result.md)，另见 [PR #1](https://github.com/a/b/pull/1)、[目录](E:/pi/docs/) 和 ![图](E:/pi/a.png)。\n\n```md\n[忽略](E:/pi/code.md)\n```\n\n再提一次[报告](E:/pi/.local-docs/result.md)。'
  const files = replyFileLinks(text)
  ok(files.map((f) => f.base).join() === 'support-request-draft.md,result.md', '只收本地文件，去重，跳过网址、目录、图片和代码块', files)
  ok(files[1]?.label === '撤下结果报告', '保留链接文字作用途说明', files[1])
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

process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
