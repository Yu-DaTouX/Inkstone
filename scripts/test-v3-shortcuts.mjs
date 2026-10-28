import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const shortcuts = await load('../src/renderer/src/app/shortcuts.ts')
const items = await load('../src/renderer/src/features/commands/command-items.ts')

const { SHORTCUTS, resolveV3Shortcut, shortcutSignature, findShortcutConflicts } = shortcuts
const {
  COMMAND_GROUP_ORDER,
  COMMAND_PREFIXES,
  PALETTE_GROUP_ORDER,
  commandsInGroups,
  limitCommandGroup,
  messageSnippet,
  parsePaletteQuery
} = items

assert.deepEqual(
  SHORTCUTS.map((def) => def.id),
  ['commandPalette', 'newSession', 'switchSessionNext', 'switchSessionPrevious', 'toggleSidebar', 'toggleWorkspace', 'openSettings', 'shortcutSheet', 'goBack',
    'stopRun', 'focusComposer', 'copyLastReply', 'openTerminal',
    'workspaceTab1', 'workspaceTab2', 'workspaceTab3', 'workspaceTab4', 'workspaceTab5', 'workspaceTab6',
    'workspaceClosePane', 'workspaceToggleMaximize',
    'splitFocusNext', 'splitFocusPrevious', 'splitNewRight', 'splitNewBelow', 'splitClose', 'splitFocusLeft', 'splitFocusRight', 'splitFocusUp', 'splitFocusDown', 'cycleTranscriptView',
    'cycleModel', 'cycleModelBack', 'cycleThinking', 'quickAsk'],
  '外壳绑定项在前，宿主已注册项在后；顺序即展示顺序'
)
assert.deepEqual(
  SHORTCUTS.filter((def) => def.rebindable).map((def) => def.id),
  ['newSession', 'switchSessionNext', 'switchSessionPrevious', 'toggleWorkspace', 'openSettings', 'shortcutSheet', 'goBack', 'stopRun', 'openTerminal',
    'workspaceTab1', 'workspaceTab2', 'workspaceTab3', 'workspaceTab4', 'workspaceTab5', 'workspaceTab6',
    'workspaceClosePane', 'workspaceToggleMaximize',
    'splitFocusNext', 'splitFocusPrevious', 'splitNewRight', 'splitNewBelow', 'splitClose', 'splitFocusLeft', 'splitFocusRight', 'splitFocusUp', 'splitFocusDown'],
  '只让非终端让键、未由宿主注册的项可改绑'
)
for (const def of SHORTCUTS) {
  assert.equal(def.scope, 'global', `${def.id} 属于全局组`)
  assert.equal(def.purposeKey, def.id, `${def.id} 的作用文案键指向自己`)
  assert.ok(def.keys.length >= 2, `${def.id} 至少一个修饰键 + 触发键`)
}
assert.ok(SHORTCUTS.filter((def) => def.terminalsYield).every((def) => !def.rebindable), '终端让键保持固定')
assert.deepEqual(
  SHORTCUTS.find((def) => def.id === 'toggleWorkspace').keys,
  ['Ctrl', 'Alt', 'B'],
  'Ctrl+Alt+B 是切换工作区'
)
assert.equal(shortcutSignature(SHORTCUTS.find((def) => def.id === 'goBack')), 'alt+arrowleft', '← 归一为 ArrowLeft')

assert.deepEqual(findShortcutConflicts(), [], '注册表内没有重复键位')
const dupe = [
  { id: 'newSession', keys: ['Ctrl', 'Alt', 'B'], purposeKey: 'newSession', rebindable: false, scope: 'global', terminalsYield: false },
  { id: 'openSettings', keys: ['Alt', 'Ctrl', 'B'], purposeKey: 'openSettings', rebindable: false, scope: 'global', terminalsYield: false }
]
assert.equal(findShortcutConflicts(dupe).length, 1, '修饰键顺序不同但键位相同也要算冲突')

const key = (over = {}) => ({
  key: 'a',
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  ...over
})
const pressed = (over) => resolveV3Shortcut(key(over))

assert.equal(pressed({ key: 'k', ctrl: true }), 'commandPalette', 'Ctrl+K 命令面板')
assert.equal(pressed({ key: 'K', meta: true }), 'commandPalette', 'Cmd+K 命令面板（macOS 用 Cmd）')
assert.equal(pressed({ key: 'n', ctrl: true }), 'newSession', 'Ctrl+N 新会话')
assert.equal(pressed({ key: 'b', ctrl: true }), 'toggleSidebar', 'Ctrl+B 侧栏')
assert.equal(pressed({ key: ',', ctrl: true }), 'openSettings', 'Ctrl+, 设置')
assert.equal(pressed({ key: '/', ctrl: true }), 'shortcutSheet', 'Ctrl+/ 快捷键表')
assert.equal(pressed({ key: 'ArrowLeft', alt: true }), 'goBack', 'Alt+← 返回')

assert.equal(pressed({ key: 'b', ctrl: true, alt: true }), 'toggleWorkspace', 'Ctrl+Alt+B 是工作区')
assert.equal(pressed({ key: 'b', ctrl: true, shift: true }), null, 'Ctrl+Shift+B 没有绑定')
assert.equal(pressed({ key: 'b', ctrl: true, alt: true, shift: true }), null, '多按 Shift 不算命中')

const overrides = { newSession: ['Ctrl', 'Alt', 'N'], openSettings: ['Ctrl', 'Shift', ','] }
assert.equal(
  resolveV3Shortcut(key({ key: 'n', ctrl: true, alt: true }), overrides),
  'newSession',
  '覆盖后 Ctrl+Alt+N 触发新会话'
)
assert.equal(resolveV3Shortcut(key({ key: 'n', ctrl: true }), overrides), null, '旧键位 Ctrl+N 已被覆盖，不再触发')
assert.equal(
  resolveV3Shortcut(key({ key: ',', ctrl: true, shift: true }), overrides),
  'openSettings',
  '覆盖后的组合键生效'
)
assert.equal(resolveV3Shortcut(key({ key: 'k', ctrl: true }), overrides), 'commandPalette', '未覆盖的项保持默认')
assert.equal(resolveV3Shortcut(key({ key: 'b', ctrl: true }), overrides), 'toggleSidebar', '未覆盖的固定项保持默认')

assert.equal(pressed({ key: 'y', alt: true }), null, 'Alt+Y 留给确认卡')
assert.equal(pressed({ key: 'n', alt: true }), null, 'Alt+N 留给确认卡')
assert.equal(pressed({ key: 'y', alt: true, ctrl: true }), null, 'Ctrl+Alt+Y 也没有绑定')

assert.equal(pressed({ key: 'k', ctrl: true, composing: true }), null, 'IME 组字中不触发')
assert.equal(pressed({ key: 'k', ctrl: true, repeat: true }), null, '长按重复不触发')
assert.equal(pressed({ key: 'k', ctrl: true, altGraph: true }), null, 'AltGr 组合不当 Ctrl+Alt')
assert.equal(pressed({ key: 'k', ctrl: true, modalOpen: true }), null, '模态打开时不响应')

assert.equal(pressed({ key: 'k', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+K 让位')
assert.equal(pressed({ key: 'b', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+B 让位')
assert.equal(pressed({ key: 'j', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+J 让位')
assert.equal(pressed({ key: 'n', ctrl: true, inTerminal: true }), 'newSession', '终端里 Ctrl+N 仍是新会话')
assert.equal(pressed({ key: 'b', ctrl: true, alt: true, inTerminal: true }), 'toggleWorkspace', '终端里 Ctrl+Alt+B 仍切换工作区')
assert.equal(pressed({ key: '/', ctrl: true, inTerminal: true }), 'shortcutSheet', '终端里 Ctrl+/ 仍开快捷键表')

assert.deepEqual(COMMAND_PREFIXES, ['>', '@', '#', '?'], '前缀顺序即帮助顺序')
assert.deepEqual(parsePaletteQuery(''), { mode: 'default', term: '' }, '空查询是默认模式')
assert.deepEqual(parsePaletteQuery('new'), { mode: 'default', term: 'new' }, '普通查询不切模式')
assert.deepEqual(parsePaletteQuery('>'), { mode: 'action', term: '' }, '> 只看操作')
assert.deepEqual(parsePaletteQuery('> 新'), { mode: 'action', term: '新' }, '前缀后空白被吃掉')
assert.deepEqual(parsePaletteQuery('@ 登录'), { mode: 'session', term: '登录' }, '@ 只看会话')
assert.deepEqual(parsePaletteQuery('#token'), { mode: 'message', term: 'token' }, '# 搜消息')
assert.deepEqual(parsePaletteQuery('?'), { mode: 'help', term: '' }, '? 是帮助')
assert.deepEqual(parsePaletteQuery('>>'), { mode: 'action', term: '>' }, '第二个 > 作为检索词')
assert.deepEqual(parsePaletteQuery('hello'), { mode: 'default', term: 'hello' })
assert.deepEqual(parsePaletteQuery('》新'), { mode: 'action', term: '新' }, '中文书名号 》 等同 >')
assert.deepEqual(parsePaletteQuery('＞ 新'), { mode: 'action', term: '新' }, '全角 ＞ 等同 >')
assert.deepEqual(parsePaletteQuery('＠登录'), { mode: 'session', term: '登录' }, '全角 ＠ 等同 @')
assert.deepEqual(parsePaletteQuery('＃token'), { mode: 'message', term: 'token' }, '全角 ＃ 等同 #')
assert.deepEqual(parsePaletteQuery('？'), { mode: 'help', term: '' }, '全角 ？ 等同 ?')
assert.deepEqual(parsePaletteQuery('》》'), { mode: 'action', term: '》' }, '只归一化首字符')
assert.deepEqual(parsePaletteQuery('《新'), { mode: 'default', term: '《新' }, '其他中文标点不切模式')

assert.deepEqual(COMMAND_GROUP_ORDER, ['action', 'session'], '旧默认顺序保持不变')
assert.deepEqual(PALETTE_GROUP_ORDER, ['action', 'session', 'message', 'help'], '面板渲染顺序')

assert.equal(messageSnippet('  hello\n  world  '), 'hello world', '压平空白')
assert.equal(messageSnippet('abcdef', 4), 'abc…', '超长截断并加省略号')
assert.equal(messageSnippet('abcd', 4), 'abcd', '刚好不截断')

const pool = [
  { id: 'a1', group: 'action', label: 'A', keywords: '' },
  { id: 'm1', group: 'message', label: 'M1', keywords: '' },
  { id: 'm2', group: 'message', label: 'M2', keywords: '' },
  { id: 'm3', group: 'message', label: 'M3', keywords: '' },
  { id: 's1', group: 'session', label: 'S', keywords: '' }
]
assert.deepEqual(
  limitCommandGroup(pool, 'message', 2).map((entry) => entry.id),
  ['a1', 'm1', 'm2', 's1'],
  '只截消息组，其它组原样保留'
)
assert.deepEqual(
  commandsInGroups(pool, ['message']).map((entry) => entry.id),
  ['m1', 'm2', 'm3'],
  '前缀模式只取自己那组'
)
assert.equal(limitCommandGroup(pool, 'message', -1).length, pool.length, '负数上限表示不限')

console.log('v3 快捷键与命令面板前缀：注册表 / 冲突 / 精确匹配 / 抑制 / 终端让键 / 前缀解析检查通过')
