import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-turn-outcome-'))
try {
  const load = async (entry, name) => {
    const outfile = join(dir, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { settledTurnOutcome, attentionForOutcome } = await load('src/shared/turn-outcome.ts', 'turn-outcome')
  const { plainTitleText, stripTitleMarkdown } = await load('src/shared/title-text.ts', 'title-text')

  const outcome = (aborted, terminal, modelError = false) => settledTurnOutcome({ aborted, terminal, modelError })
  assert.equal(outcome(false, 'completed'), 'completed')
  assert.equal(outcome(true, 'stopped'), 'stopped')
  assert.equal(outcome(false, 'stopped'), 'stopped')
  assert.equal(outcome(false, 'failed', true), 'failed')
  assert.equal(outcome(false, 'completed', true), 'failed')
  assert.equal(outcome(true, 'interrupted'), 'failed')
  assert.equal(outcome(true, 'completed'), 'failed')

  assert.equal(attentionForOutcome('completed'), 'done')
  assert.equal(attentionForOutcome('failed'), 'error')
  assert.equal(attentionForOutcome('stopped'), null)

  assert.equal(stripTitleMarkdown('## 修复 **标题** 生成'), '修复 标题 生成')
  assert.equal(stripTitleMarkdown('- [x] 完成 `build`'), '完成 build')
  assert.equal(stripTitleMarkdown('```ts'), '')
  assert.equal(plainTitleText('# 问题\n\n```ts\nconst a = 1\n```\n> 见 [文档](https://x.y)'), '问题 const a = 1 见 文档')
  assert.equal(plainTitleText('  普通   一句话  '), '普通 一句话')
  assert.equal(plainTitleText(''), '')

  console.log('turn-outcome / title-text: 16 项通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
