import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-subagent-model-label-'))
try {
  const load = async (entry, name) => {
    const outfile = join(dir, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { resolveSubagentModelLabel: resolve, resolveSubagentModelPick: pick } = await load('src/main/subagents/model-label.ts', 'model-label')
  const { parseSubagentBrief } = await load('src/shared/subagent-brief.ts', 'brief')

  const models = [
    { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash-fast' },
    { provider: 'yan-opencode', id: 'deepseek-v4.1-flash' },
    { provider: 'openai-codex', id: 'gpt-6-luna' }
  ]
  const parent = 'commandcode/deepseek/deepseek-v4.1-flash'

  assert.deepEqual(resolve('commandcode/deepseek/deepseek-v4.1-flash', models, parent), { ok: true, label: parent }, '完整名称原样使用')
  assert.deepEqual(resolve('deepseek-v4.1-flash', models, parent), { ok: true, label: parent }, '只写模型名时优先当前会话供应商')
  assert.deepEqual(resolve('deepseek/deepseek-v4.1-flash', models, parent), { ok: true, label: parent }, '带厂商前缀的模型 id 也能匹配')
  assert.deepEqual(resolve('gpt-6-luna', models, parent), { ok: true, label: 'openai-codex/gpt-6-luna' }, '唯一匹配补全供应商')
  assert.deepEqual(resolve('DeepSeek V4.1 Flash', models, parent), { ok: true, label: parent }, '按显示名匹配')
  assert.deepEqual(resolve('deepseek-v4.1-flash-fast', models, parent), { ok: true, label: 'commandcode/deepseek/deepseek-v4.1-flash-fast' }, '后缀不同的模型不会互相误配')
  assert.deepEqual(resolve('unknown-model', models, parent), { ok: true, label: 'unknown-model' }, '找不到时原样交给 pi 报错')
  assert.deepEqual(resolve('deepseek-v4.1-flash', [], parent), { ok: true, label: 'deepseek-v4.1-flash' }, '没有模型清单时不改写')

  const ambiguous = resolve('deepseek-v4.1-flash', models, 'openai-codex/gpt-6-luna')
  assert.equal(ambiguous.ok, false, '当前供应商无此模型且多处匹配时报歧义')
  assert.match(ambiguous.error, /commandcode\/deepseek\/deepseek-v4\.1-flash/, '歧义提示列出完整候选名')
  assert.match(ambiguous.error, /yan-opencode\/deepseek-v4\.1-flash/, '歧义提示包含另一个供应商')

  const titled = parseSubagentBrief({ title: '  写   解析器  ', goal: 'g' }, 'task')
  assert.equal(titled.ok && titled.brief.title, '写 解析器', '标题去掉多余空白')
  const long = parseSubagentBrief({ title: '标'.repeat(60) }, 'task')
  assert.equal(long.ok && [...long.brief.title].length, 40, '标题截到 40 字')
  const none = parseSubagentBrief({}, 'task')
  assert.equal(none.ok && 'title' in none.brief, false, '没给标题时不带 title 字段')

  const pref = { model: { provider: 'openai-codex', id: 'gpt-6-luna' } }
  assert.deepEqual(pick(undefined, models, parent), { ok: true, label: '' }, '无参数无设置时交还会话模型')
  assert.deepEqual(pick('  ', models, parent, pref), { ok: true, label: 'openai-codex/gpt-6-luna' }, '无显式参数时用设置')
  assert.deepEqual(pick('deepseek-v4.1-flash', models, parent, pref), { ok: true, label: parent }, '显式参数优先于设置')
  assert.deepEqual(pick('deepseek-v4.1-flash', models, parent, { ...pref, force: true }), { ok: true, label: 'openai-codex/gpt-6-luna' }, '强制时设置压过显式参数')
  assert.deepEqual(pick(undefined, models, parent, { model: { provider: 'gone', id: 'x' }, force: true }), { ok: true, label: '' }, '设置的模型已不可用时回到会话模型')
  assert.deepEqual(pick('gpt-6-luna', models, parent, { model: { provider: 'gone', id: 'x' }, force: true }), { ok: true, label: 'openai-codex/gpt-6-luna' }, '强制但模型不可用时仍用显式参数')
  assert.deepEqual(pick(undefined, [], parent, pref), { ok: true, label: 'openai-codex/gpt-6-luna' }, '没有模型清单时直接信任设置')
  assert.equal(pick('deepseek-v4.1-flash', models, 'openai-codex/gpt-6-luna').ok, false, '无设置时保持原有歧义报错')

  console.log('test-subagent-model-label: 22 项通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
