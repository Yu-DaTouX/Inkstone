import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/commands/command-items.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  COMMAND_GROUP_ORDER,
  commandMatchScore,
  commandTokens,
  groupCommands,
  limitCommands,
  navigableCommands,
  rankCommands,
  shouldExecuteOnEnter
} = mod

assert.deepEqual(commandTokens('  Foo  foo BAR '), ['foo', 'bar'], '去空白、转小写、去重')
assert.deepEqual(commandTokens('a b c d e f g h'), ['a', 'b', 'c', 'd', 'e', 'f'], '最多保留 6 个词')
assert.deepEqual(commandTokens(''), [])
assert.deepEqual(commandTokens('   '), [])

const item = (over = {}) => ({
  id: over.id ?? 'x',
  group: over.group ?? 'action',
  label: over.label ?? 'New chat',
  keywords: over.keywords ?? '',
  ...over
})

assert.equal(commandMatchScore(item(), []), 0, '空 token 视为命中（基准分）')
assert.equal(commandMatchScore(item(), ['new']), 0, '标题前缀最高')
assert.equal(commandMatchScore(item({ label: 'Stop current chat' }), ['current']), 1, '标题包含次之')
assert.equal(
  commandMatchScore(item({ label: 'Stop current chat', keywords: 'abort cancel' }), ['abort']),
  2,
  '只在关键词命中最低'
)
assert.equal(commandMatchScore(item(), ['nope']), null, '完全不命中为 null')
assert.equal(
  commandMatchScore(item({ label: 'New chat', keywords: 'session' }), ['new', 'chat']),
  0,
  '多词都出现才算命中'
)
assert.equal(
  commandMatchScore(item({ label: 'New chat', keywords: 'session' }), ['new', 'missing']),
  null,
  '多词缺一个即不命中'
)

const ranked = rankCommands(
  [
    item({ id: 'kw', label: 'Zed', keywords: 'alpha' }),
    item({ id: 'include', label: 'Beta alpha' }),
    item({ id: 'prefix', label: 'Alpha beta' }),
    item({ id: 'second-prefix', label: 'Alpha zed' }),
    item({ id: 'miss', label: 'Gamma' })
  ],
  'alpha'
)
assert.deepEqual(
  ranked.map((entry) => entry.id),
  ['prefix', 'second-prefix', 'include', 'kw'],
  '按 0/1/2 分排序；同分保持原顺序；不命中被过滤'
)

const grouped = groupCommands(
  [
    item({ id: 's1', group: 'session' }),
    item({ id: 'a1', group: 'action' }),
    item({ id: 's2', group: 'session' })
  ],
  COMMAND_GROUP_ORDER
)
assert.deepEqual(
  grouped.map((section) => section.group),
  ['action', 'session'],
  '动作组在会话组之前'
)
assert.deepEqual(
  grouped[0].items.map((entry) => entry.id),
  ['a1']
)
assert.deepEqual(
  grouped[1].items.map((entry) => entry.id),
  ['s1', 's2']
)
assert.deepEqual(groupCommands([item({ group: 'action' })]).map((s) => s.group), ['action'], '空组不出现')

const many = [
  item({ id: 'a1', group: 'action' }),
  ...Array.from({ length: 5 }, (_, i) => item({ id: `s${i}`, group: 'session' })),
  item({ id: 'a2', group: 'action' })
]
assert.deepEqual(
  limitCommands(many, 2).map((entry) => entry.id),
  ['a1', 's0', 's1', 'a2'],
  '动作全留，会话截前 2 条'
)
assert.deepEqual(limitCommands(many, -1).length, many.length, '负数上限表示不限')

assert.deepEqual(
  navigableCommands([
    item({ id: 'a', disabled: true }),
    item({ id: 'b' }),
    item({ id: 'c', disabled: true })
  ]).map((entry) => entry.id),
  ['b']
)

assert.equal(shouldExecuteOnEnter({ key: 'Enter' }), true, '普通 Enter 执行')
assert.equal(shouldExecuteOnEnter({ key: 'Enter', isComposing: true }), false, '组字中的 Enter 不执行（isComposing）')
assert.equal(shouldExecuteOnEnter({ key: 'Enter', keyCode: 229 }), false, '组字中的 Enter 不执行（keyCode 229）')
assert.equal(shouldExecuteOnEnter({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
assert.equal(shouldExecuteOnEnter({ key: 'a' }), false, '非 Enter 不执行')
assert.equal(shouldExecuteOnEnter({ key: 'Escape' }), false)

const actionItems = [
  item({ id: 'newSession', label: '新建会话', keywords: 'new chat 新建 新对话' }),
  item({ id: 'openSettings', label: '运行总览', keywords: 'runs overview 运行 总览' })
]
const sessionItems = [
  item({ id: 'session:/a', group: 'session', label: '修复登录', keywords: 'C:/work/app' }),
  item({ id: 'session:/b', group: 'session', label: '重构运行列表', keywords: 'C:/work/runs' })
]

const emptyPool = limitCommands(rankCommands(actionItems, ''), 8)
assert.deepEqual(emptyPool.map((e) => e.id), ['newSession', 'openSettings'], '空查询不铺会话')

const runQueryPool = limitCommands(rankCommands([...actionItems, ...sessionItems], '运行'), 8)
assert.deepEqual(
  runQueryPool.map((e) => e.id),
  ['openSettings', 'session:/b'],
  '「运行」同时命中命令（前缀）与会话（标题）'
)

const sessionOnly = limitCommands(rankCommands([...actionItems, ...sessionItems], '登录'), 8)
assert.deepEqual(sessionOnly.map((e) => e.id), ['session:/a'], '只搜到会话时只有会话组')

console.log('v3 命令面板纯逻辑：分词 / 打分 / 排序 / 分组 / 上限 / 禁用 / IME 检查通过')
