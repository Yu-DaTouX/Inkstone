import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

await build({
  entryPoints: ['src/shared/native-session.ts'],
  outfile: 'out/test/native-session.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent'
})
const native = await import(pathToFileURL(resolve('out/test/native-session.mjs')).href)

let failed = 0
const ok = (cond, name, extra = '') => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

const entry = (id, parentId, type = 'message', extra = {}) => ({ id, parentId, type, timestamp: '2026-10-14T00:00:00.000Z', ...extra })
const node = (id, parentId, children = [], extra = {}) => ({ entry: entry(id, parentId, extra.type ?? 'message', extra.entry ?? {}), children, ...(extra.label ? { label: extra.label } : {}) })
const userMsg = (id, parentId, text) => node(id, parentId, [], { entry: { message: { role: 'user', content: text } } })

{
  const parsed = native.parseTreePayload({ tree: [{ entry: { id: 'a' }, children: [] }], leafId: 'a' })
  ok(parsed.tree.length === 1 && parsed.leafId === 'a', 'parse：取出 tree 与 leafId')
  ok(native.parseTreePayload(null).tree.length === 0 && native.parseTreePayload(null).leafId === null, 'parse：null 退回空树')
  ok(native.parseTreePayload({ tree: 'nope', leafId: 42 }).leafId === null, 'parse：非法 leafId 不当成字符串')
}

{
  ok(native.describeEntry({ type: 'message', message: { role: 'user', content: '  你好\n世界 ' } }).kind === 'user', 'describe：用户消息')
  ok(native.describeEntry({ type: 'message', message: { role: 'user', content: '  你好\n世界 ' } }).text === '你好 世界', 'describe：压成一行')
  const assistant = native.describeEntry({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '答' }, { type: 'image' }] } })
  ok(assistant.kind === 'assistant' && assistant.text === '答', 'describe：助手内容块取文字')
  const tool = native.describeEntry({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] } })
  ok(tool.kind === 'tool' && tool.text === 'bash ok', 'describe：工具结果带工具名')
  ok(native.describeEntry({ type: 'compaction', summary: '摘要' }).kind === 'summary', 'describe：压缩条目')
  ok(native.describeEntry({ type: 'branch_summary', summary: '岔路' }).kind === 'branch', 'describe：分支摘要')
  ok(native.describeEntry({ type: 'label', label: '检查点' }).kind === 'label', 'describe：标签')
  const change = native.describeEntry({ type: 'model_change', provider: 'anthropic', modelId: 'sonnet' })
  ok(change.kind === 'meta' && change.text === 'anthropic/sonnet', 'describe：模型切换')
  ok(native.describeEntry({ type: 'made_up' }).kind === 'unknown', 'describe：未知类型不猜测')
  ok(native.nativeOneLine('x'.repeat(50), 10).endsWith('…'), 'oneLine：超长截断')
}

{
  const models = [
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', inScope: true, current: true },
    { provider: 'openai', id: 'gpt', name: 'GPT', inScope: false, current: false }
  ]
  ok(native.nativeModelKey(models[0]) === 'anthropic/sonnet', 'model：稳定键是 provider/id')
}

{
  const huge = 'x'.repeat(100000)
  const slim = native.slimNativeEntry({ id: 'a', parentId: null, type: 'message', timestamp: 't', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: huge }], details: { blob: huge } } })
  ok(JSON.stringify(slim).length < 400, 'slim：条目只保留预览所需的短字段')
  ok(native.describeEntry(slim).kind === 'tool' && native.describeEntry(slim).text.startsWith('read x'), 'slim：瘦身后描述不变')
}

{
  let node0 = userMsg('leaf', 'n2999', '最深一条')
  const DEPTH = 3000
  for (let i = DEPTH - 1; i >= 0; i -= 1) {
    node0 = node(`n${i}`, i === 0 ? null : `n${i - 1}`, [node0])
  }
  const side = userMsg('side', 'n10', '旁支')
  let cursor = node0
  for (let i = 0; i < 10; i += 1) cursor = cursor.children[0]
  cursor.children.unshift(side)

  const flat = native.flattenNativeTree([node0])
  ok(flat.length === DEPTH + 2, 'flat：所有条目都被展平')
  ok(flat.every((item) => !('children' in item)), 'flat：传输结构没有嵌套')
  ok(flat.find((item) => item.entry.id === 'side').parentId === 'n10', 'flat：保留结构上的父节点')
  let threw = null
  try {
    structuredClone({ ok: true, tree: flat, leafId: 'leaf' })
  } catch (error) {
    threw = error
  }
  ok(threw === null, 'flat：结果可以安全跨进程克隆')

  const parsed = native.parseTreePayload({ tree: flat, leafId: 'leaf' })
  ok(parsed.tree.length === 1 && parsed.tree[0].entry.id === 'n0', 'flat：渲染端按 parentId 还原成树')
}

{
  const flat = native.flattenNativeTree([
    node('r1', null, [userMsg('x', 'r1', '一')]),
    node('r2', null, [userMsg('y', 'r2', '二')]),
    'not-a-node',
    null
  ])
  ok(flat.filter((item) => item.parentId === null).length === 2, 'flat：多个根都保留，非法条目被跳过')
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
