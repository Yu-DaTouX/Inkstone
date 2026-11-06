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
  const tree = [node('a', null, [node('b', 'a', [userMsg('c', 'b', '第三句')], { entry: { message: { role: 'user', content: '第二句' } } })], { entry: { message: { role: 'user', content: '第一句' } } })]
  const view = native.buildTreeView(tree, 'c')
  ok(view.rows.map((r) => r.entryId).join('') === 'abc', 'line：按根到叶顺序投影')
  ok(view.rows.map((r) => r.depth).join('') === '000', 'line：没有分叉的线性链平铺在同一层')
  ok(view.rows[2].leaf === true && view.rows[0].leaf === false, 'line：只标记当前 leaf')
  ok(view.activePath.join('') === 'abc', 'line：活动分支是 leaf → 根')
  ok(view.rows.every((r) => r.onActiveBranch), 'line：整条链都在活动分支上')
  ok(view.rows[0].parentId === null && view.rows[1].parentId === 'a', 'line：parentId 保留')
}

{
  const view = native.buildTreeView([userMsg('r1', null, '一'), userMsg('r2', null, '二')], null)
  ok(view.rows.length === 2, 'roots：多个根都显示')
  ok(view.rows.every((r) => r.leaf === false), 'roots：没有 leaf 时不误标')
}

{
  const tree = [node('root', null, [node('a', 'root', [userMsg('b', 'a', '岔路终点')]), node('c', 'root', [userMsg('d', 'c', '另一岔')])])]
  const collapsed = native.initialCollapsedForLeaf(tree, 'b')
  ok(collapsed.has('c'), 'fold：非活动分支默认收起')
  ok(!collapsed.has('a'), 'fold：活动分支的祖先默认展开')
  ok(!collapsed.has('root'), 'fold：活动分支的根默认展开')

  const view = native.buildTreeView(tree, 'b', collapsed)
  ok(view.rows.map((r) => r.entryId).join(',') === 'root,c,a,b', 'fold：旁支排在分叉行下，主线沿活动分支平铺')
  ok(view.rows.map((r) => r.depth).join('') === '0100', 'fold：只有旁支缩进一级')
  const cRow = view.rows.find((r) => r.entryId === 'c')
  ok(cRow.folded === true && cRow.hiddenCount === 1, 'fold：折叠行给出隐藏后代数')
  ok(view.rows.find((r) => r.entryId === 'root').hasChildren === true, 'fold：分叉行可展开收起')

  const expanded = native.buildTreeView(tree, 'b', new Set())
  ok(expanded.rows.length === 5, 'fold：展开后显示全部条目')
}

{
  const a = node('a', null, [])
  const b = node('b', 'a', [])
  a.children.push(b)
  b.children.push(a)
  const view = native.buildTreeView([a], 'a')
  ok(view.rows.length === 2, 'cycle：重访节点只处理一次')
  ok(view.stats.cycles >= 1, 'cycle：计入保护统计')
  const dup = node('dup', null, [userMsg('same', 'dup', '一')])
  const dup2 = node('dup2', null, [userMsg('same', 'dup2', '二')])
  const dupView = native.buildTreeView([dup, dup2], null)
  ok(dupView.rows.length === 3 && dupView.stats.cycles === 1, 'cycle：跨根重复 id 跳过后一棵子树')
}

{
  const chain = []
  let parent = null
  for (let i = 0; i < 30; i += 1) {
    const n = userMsg(`n${i}`, parent, `第 ${i} 层`)
    chain.push(n)
    parent = `n${i}`
  }
  const root = chain[0]
  let cursor = root
  for (let i = 1; i < chain.length; i += 1) {
    cursor.children.push(chain[i])
    cursor = chain[i]
  }
  const view = native.buildTreeView([root], 'n29', new Set(), { maxDepth: 4 })
  ok(view.rows.length === 30, 'depth：长线性链全部显示，不受分叉深度上限影响')
  ok(view.rows.every((r) => r.depth === 0 && !r.truncated), 'depth：长线性链不缩进也不截断')
  ok(view.stats.depthTruncated === 0 && view.rows[29].leaf === true, 'depth：不计保护统计，叶子可见')
}

{
  const root = node('root', null, ['a', 'b', 'c', 'd', 'e'].map((id) => userMsg(id, 'root', id)))
  const view = native.buildTreeView([root], null, new Set(), { maxRows: 3 })
  ok(view.rows.length === 3, 'rows：超过上限只渲染上限行')
  ok(view.stats.rowTruncated === 3, 'rows：未渲染行如实计数')
  ok(view.rows.map((r) => r.entryId).join('') === 'cde', 'rows：超出时保留最新的行')
}

{
  const tree = [node('root', null, [node('a', 'root', [userMsg('b', 'a', 'x')])])]
  ok(native.pathToEntry(tree, 'b').join(',') === 'root,a,b', 'path：leaf → 根')
  ok(native.pathToEntry(tree, 'nope').length === 0, 'path：找不到返回空')
  ok(native.pathToEntry(tree, null).length === 0, 'path：没有 leaf 返回空')
}

{
  const models = [
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', inScope: true, current: true },
    { provider: 'openai', id: 'gpt', name: 'GPT', inScope: false, current: false }
  ]
  ok(native.nativeModelKey(models[0]) === 'anthropic/sonnet', 'model：稳定键是 provider/id')
}

{
  const meta = node('m', null, [node('t', 'm', [userMsg('u', 't', '问题')], { type: 'thinking_level_change', entry: { thinkingLevel: 'medium' } })], { type: 'model_change', entry: { provider: 'anthropic', modelId: 'opus' } })
  const view = native.buildTreeView([meta], 'u')
  ok(view.rows.length === 1 && view.rows[0].entryId === 'u', 'meta：模型与档位切换不单独占行')
  ok(JSON.stringify(view.rows[0].tags) === JSON.stringify(['anthropic/opus', 'medium']), 'meta：收成下一行的小标签')
  ok(native.buildTreeView([meta], 'm').rows[0].entryId === 'm', 'meta：当前叶子是元信息时照常显示')
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
  ok(native.pathToEntry(parsed.tree, 'leaf').length === DEPTH + 1, 'flat：深链上 leaf → 根路径完整')
  const view = native.buildTreeView(parsed.tree, 'leaf', native.initialCollapsedForLeaf(parsed.tree, 'leaf'))
  ok(view.rows.length === native.NATIVE_TREE_MAX_ROWS && view.rows.at(-1).leaf, 'flat：超长深链保留最新的行，叶子可见')
  const wide = native.buildTreeView(parsed.tree, 'leaf', new Set(), { maxRows: 5000 })
  ok(wide.rows.length === DEPTH + 2, 'flat：上限足够时全部显示')
  ok(wide.rows.find((r) => r.entryId === 'side').depth === 1 && wide.rows.filter((r) => r.depth > 0).length === 1, 'flat：只有旁支缩进')
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
