import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))

async function loadTs(rel) {
  const result = await build({
    entryPoints: [here(rel)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const shortcuts = await loadTs('../src/renderer/src/app/shortcuts.ts')
const texts = await loadTs('../src/renderer/src/features/commands/shortcut-text.ts')
const items = await loadTs('../src/renderer/src/features/commands/command-items.ts')

async function runShortcutsAndPalette() {
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
      'stopRun', 'focusComposer', 'copyLastReply', 'openTerminal', 'runProjectScript',
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

  assert.deepEqual(COMMAND_PREFIXES, ['>', '@', '#', '/', '%', '?'], '前缀顺序即帮助顺序')
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
  assert.deepEqual(PALETTE_GROUP_ORDER, ['action', 'session', 'message', 'file', 'content', 'help'], '面板渲染顺序')

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
}

async function runShortcutRegistry() {
  const {
    SHORTCUTS,
    RENDERER_SHORTCUTS,
    HOST_SHORTCUTS,
    resolveV3Shortcut,
    shortcutSignature,
    shortcutKeyToken,
    findShortcutConflicts,
    sanitizeShortcutOverrides,
    shortcutOverridesFromSettings,
    applyShortcutOverrides,
    EMPTY_SHORTCUT_OVERRIDES
  } = shortcuts
  const { shortcutText } = texts
  const { COMMAND_ACTION_IDS } = items

  const key = (over = {}) => ({
    key: 'a',
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    ...over
  })
  const pressed = (over) => resolveV3Shortcut(key(over))

  const RENDERER_IDS = [
    'commandPalette',
    'newSession',
    'switchSessionNext',
    'switchSessionPrevious',
    'toggleSidebar',
    'toggleWorkspace',
    'openSettings',
    'shortcutSheet',
    'goBack',
    'stopRun',
    'focusComposer',
    'copyLastReply',
    'openTerminal',
    'runProjectScript',
    'workspaceTab1',
    'workspaceTab2',
    'workspaceTab3',
    'workspaceTab4',
    'workspaceTab5',
    'workspaceTab6',
    'workspaceClosePane',
    'workspaceToggleMaximize',
    'splitFocusNext',
    'splitFocusPrevious',
    'splitNewRight',
    'splitNewBelow',
    'splitClose',
    'splitFocusLeft',
    'splitFocusRight',
    'splitFocusUp',
    'splitFocusDown',
    'cycleTranscriptView'
  ]
  const HOST_IDS = ['cycleModel', 'cycleModelBack', 'cycleThinking', 'quickAsk']

  assert.deepEqual(RENDERER_SHORTCUTS.map((def) => def.id), RENDERER_IDS, '外壳绑定的键位齐全且顺序稳定')
  assert.deepEqual(HOST_SHORTCUTS.map((def) => def.id), HOST_IDS, '宿主已注册的键位单列，供帮助与冲突检测使用')
  assert.equal(SHORTCUTS.length, RENDERER_IDS.length + HOST_IDS.length, '注册表不再漏项')

  for (const def of SHORTCUTS) {
    assert.equal(def.scope, 'global', `${def.id} 属于全局组`)
    assert.equal(def.purposeKey, def.id, `${def.id} 的作用文案键指向自己`)
    assert.ok(['renderer', 'host'].includes(def.registeredBy), `${def.id} 的 registeredBy 合法`)
    assert.ok(def.keys.length >= 2, `${def.id} 至少一个修饰键 + 触发键`)
  }

  assert.deepEqual(
    SHORTCUTS.filter((def) => def.rebindable).map((def) => def.id),
    ['newSession', 'switchSessionNext', 'switchSessionPrevious', 'toggleWorkspace', 'openSettings', 'shortcutSheet', 'goBack', 'stopRun', 'openTerminal',
      'workspaceTab1', 'workspaceTab2', 'workspaceTab3', 'workspaceTab4', 'workspaceTab5', 'workspaceTab6',
      'workspaceClosePane', 'workspaceToggleMaximize',
      'splitFocusNext', 'splitFocusPrevious', 'splitNewRight', 'splitNewBelow', 'splitClose', 'splitFocusLeft', 'splitFocusRight', 'splitFocusUp', 'splitFocusDown'],
    '非终端让键、未由宿主注册的项可改绑'
  )
  assert.deepEqual(
    SHORTCUTS.filter((def) => def.terminalsYield).map((def) => def.id),
    ['commandPalette', 'toggleSidebar', 'focusComposer', 'copyLastReply', 'runProjectScript', 'cycleTranscriptView'],
    '终端让键只覆盖 xterm 真正会用的键'
  )
  assert.ok(SHORTCUTS.filter((def) => def.terminalsYield).every((def) => !def.rebindable), '终端让键保持固定')
  assert.ok(HOST_SHORTCUTS.every((def) => !def.rebindable), '宿主已注册的键不参与改绑')

  const rendererSignatures = new Set(RENDERER_SHORTCUTS.map(shortcutSignature))
  for (const def of HOST_SHORTCUTS) {
    assert.ok(!rendererSignatures.has(shortcutSignature(def)), `${def.id} 未在外壳重复注册`)
  }

  assert.deepEqual(findShortcutConflicts(), [], '注册表内没有重复键位')
  const dupe = [
    { id: 'stopRun', keys: ['Ctrl', 'Shift', 'C'], purposeKey: 'stopRun', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'renderer' },
    { id: 'copyLastReply', keys: ['Shift', 'Ctrl', 'C'], purposeKey: 'copyLastReply', rebindable: false, scope: 'global', terminalsYield: false, registeredBy: 'renderer' }
  ]
  assert.equal(findShortcutConflicts(dupe).length, 1, '修饰键顺序不同但键位相同也要算冲突')

  assert.equal(pressed({ key: '.', ctrl: true }), 'stopRun', 'Ctrl+. 停止当前运行')
  assert.equal(pressed({ key: 'l', ctrl: true }), 'focusComposer', 'Ctrl+L 聚焦输入框')
  assert.equal(pressed({ key: 'L', meta: true }), 'focusComposer', 'Cmd+L 聚焦输入框（macOS 用 Cmd）')
  assert.equal(pressed({ key: 'c', ctrl: true, shift: true }), 'copyLastReply', 'Ctrl+Shift+C 复制上一条回复')
  assert.equal(pressed({ key: '`', ctrl: true }), 'openTerminal', 'Ctrl+` 打开终端')
  assert.equal(pressed({ key: '\\', ctrl: true }), 'workspaceClosePane', 'Ctrl+\\ 关闭当前面板')
  assert.equal(pressed({ key: '\\', ctrl: true, shift: true }), 'workspaceToggleMaximize', 'Ctrl+Shift+\\ 最大化或还原当前面板')
  assert.equal(pressed({ key: '\\', ctrl: true, alt: true }), 'splitNewRight', 'Ctrl+Alt+\\ 仍是右侧分屏')
  assert.deepEqual(
    ['1', '2', '3', '4', '5', '6'].map((digit) => pressed({ key: digit, alt: true })),
    ['workspaceTab1', 'workspaceTab2', 'workspaceTab3', 'workspaceTab4', 'workspaceTab5', 'workspaceTab6'],
    'Alt+1…6 依次切换工作区页签'
  )
  assert.equal(pressed({ key: 'k', ctrl: true }), 'commandPalette', '既有 Ctrl+K 保持')
  assert.equal(pressed({ key: 'b', ctrl: true, alt: true }), 'toggleWorkspace', '既有 Ctrl+Alt+B 保持')

  assert.equal(pressed({ key: '.', ctrl: true, shift: true }), null, 'Ctrl+Shift+. 没有绑定')
  assert.equal(pressed({ key: '.', ctrl: true, alt: true }), null, 'Ctrl+Alt+. 没有绑定')
  assert.equal(pressed({ key: 'l', ctrl: true, shift: true }), null, 'Ctrl+Shift+L 没有绑定')
  assert.equal(pressed({ key: 'c', ctrl: true }), null, 'Ctrl+C 不触发复制上一条回复')
  assert.equal(pressed({ key: '1' }), null, '裸 1 不切页签')
  assert.equal(pressed({ key: '1', ctrl: true, alt: true }), null, 'Ctrl+Alt+1 没有绑定')
  assert.equal(pressed({ key: '`', ctrl: true, shift: true }), null, 'Ctrl+Shift+` 没有绑定')

  assert.equal(pressed({ key: 'j', ctrl: true, shift: true }), null, 'Ctrl+Shift+J（运行总览浮层）没有实现，不注册')
  assert.equal(pressed({ key: '[', ctrl: true }), null, 'Ctrl+[（上一个运行中的会话）没有实现，不注册')
  assert.equal(pressed({ key: ']', ctrl: true }), null, 'Ctrl+]（下一个运行中的会话）没有实现，不注册')
  assert.equal(pressed({ key: 'F8' }), null, 'F8（跳到下一个需要处理的）没有实现，不注册')
  assert.equal(pressed({ key: 'ArrowUp', ctrl: true }), null, 'Ctrl+↑（上一条用户消息）没有实现，不注册')
  assert.equal(pressed({ key: 'ArrowDown', ctrl: true }), null, 'Ctrl+↓（下一条用户消息）没有实现，不注册')
  assert.equal(pressed({ key: 't', ctrl: true }), null, 'Ctrl+T 思考档与现有 Shift+Tab 冲突，选已有语义，不注册')

  assert.equal(pressed({ key: 'p', ctrl: true }), null, 'Ctrl+P 由主进程注册，外壳不重复分发')
  assert.equal(pressed({ key: 'P', ctrl: true, shift: true }), null, 'Ctrl+Shift+P 由主进程注册')
  assert.equal(pressed({ key: 'Tab', shift: true }), null, 'Shift+Tab 由主进程注册')
  assert.equal(pressed({ key: ' ', alt: true, shift: true }), null, 'Alt+Shift+Space 由独立快速提问窗口注册')
  assert.equal(resolveV3Shortcut(key({ key: 'p', ctrl: true }), { cycleModel: ['Ctrl', 'Alt', 'P'] }), null,
    '宿主项的覆盖也不会被外壳命中')

  assert.equal(pressed({ key: 'ArrowLeft', alt: true }), 'goBack', '不在输入控件时 Alt+← 返回')
  assert.equal(pressed({ key: 'ArrowLeft', alt: true, editing: true }), null, '输入控件里 Alt+← 让给编辑器')
  assert.equal(pressed({ key: 'ArrowUp', editing: true }), null, '输入控件里裸方向键不抢')
  assert.equal(pressed({ key: 'Backspace', editing: true }), null, '输入控件里退格不抢')
  assert.equal(pressed({ key: 'Enter', editing: true }), null, '输入控件里回车不抢（发送语义在 Composer）')
  assert.equal(pressed({ key: 'l', ctrl: true, editing: true }), 'focusComposer', '输入控件里 Ctrl+L 仍聚焦输入框')
  assert.equal(pressed({ key: '1', alt: true, editing: true }), 'workspaceTab1', '输入控件里 Alt+1 仍切页签')
  assert.equal(pressed({ key: 'c', ctrl: true, shift: true, editing: true }), 'copyLastReply', '输入控件里 Ctrl+Shift+C 可用')

  for (const [label, state] of [
    ['IME 组字', { composing: true }],
    ['长按重复', { repeat: true }],
    ['AltGr', { altGraph: true }],
    ['模态打开', { modalOpen: true }]
  ]) {
    assert.equal(pressed({ key: '.', ctrl: true, ...state }), null, `${label} 时 Ctrl+. 不触发`)
    assert.equal(pressed({ key: 'l', ctrl: true, ...state }), null, `${label} 时 Ctrl+L 不触发`)
    assert.equal(pressed({ key: 'c', ctrl: true, shift: true, ...state }), null, `${label} 时 Ctrl+Shift+C 不触发`)
    assert.equal(pressed({ key: '1', alt: true, ...state }), null, `${label} 时 Alt+1 不触发`)
    assert.equal(pressed({ key: '`', ctrl: true, ...state }), null, `${label} 时 Ctrl+\` 不触发`)
  }

  for (const def of RENDERER_SHORTCUTS) {
    assert.ok(!['enter', 'space', ' ', 'escape'].includes(shortcutKeyToken(def.keys)), `${def.id} 不占用确认键`)
  }
  assert.equal(pressed({ key: 'y', alt: true }), null, 'Alt+Y 留给确认卡')
  assert.equal(pressed({ key: 'n', alt: true }), null, 'Alt+N 留给确认卡')
  assert.equal(pressed({ key: 'Enter' }), null, '裸 Enter 不是全局快捷键')

  assert.equal(pressed({ key: 'k', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+K 让位')
  assert.equal(pressed({ key: 'b', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+B 让位')
  assert.equal(pressed({ key: 'j', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+J 让位')
  assert.equal(pressed({ key: 'l', ctrl: true, inTerminal: true }), null, '终端里 Ctrl+L 让位（xterm 清屏）')
  assert.equal(pressed({ key: 'c', ctrl: true, shift: true, inTerminal: true }), null, '终端里 Ctrl+Shift+C 让位（xterm 复制）')
  assert.equal(pressed({ key: 'n', ctrl: true, inTerminal: true }), 'newSession', '终端里 Ctrl+N 仍是新会话')
  assert.equal(pressed({ key: '.', ctrl: true, inTerminal: true }), 'stopRun', '终端里 Ctrl+. 仍停止')
  assert.equal(pressed({ key: '1', alt: true, inTerminal: true }), 'workspaceTab1', '终端里 Alt+1 仍切页签')
  assert.equal(pressed({ key: '/', ctrl: true, inTerminal: true }), 'shortcutSheet', '终端里 Ctrl+/ 仍开快捷键表')

  const overrides = { stopRun: ['Ctrl', 'Alt', '.'], workspaceTab1: ['Ctrl', 'Alt', '1'], cycleModel: ['Ctrl', 'Alt', 'P'] }
  assert.equal(resolveV3Shortcut(key({ key: '.', ctrl: true, alt: true }), { stopRun: ['Ctrl', 'Alt', '.'] }), 'stopRun', '覆盖后 Ctrl+Alt+. 生效')
  assert.equal(resolveV3Shortcut(key({ key: '.', ctrl: true }), { stopRun: ['Ctrl', 'Alt', '.'] }), null, '旧键位被覆盖后不再触发')
  assert.equal(resolveV3Shortcut(key({ key: 'k', ctrl: true }), { stopRun: ['Ctrl', 'Alt', '.'] }), 'commandPalette', '未覆盖项保持默认')
  assert.equal(resolveV3Shortcut(key({ key: '1', alt: true, ctrl: true }), { workspaceTab1: ['Ctrl', 'Alt', '1'] }), 'workspaceTab1', '页签可改绑')
  assert.deepEqual(
    sanitizeShortcutOverrides(overrides),
    { stopRun: ['Ctrl', 'Alt', '.'], workspaceTab1: ['Ctrl', 'Alt', '1'] },
    '清洗丢掉宿主项与未知项，保留可改项'
  )
  assert.deepEqual(sanitizeShortcutOverrides({ focusComposer: ['Ctrl', 'Alt', 'L'] }), {}, '固定项残留覆盖被丢掉')
  assert.deepEqual(sanitizeShortcutOverrides(undefined), {}, '非对象返回空覆盖')
  assert.deepEqual(shortcutOverridesFromSettings({ shortcutOverrides: { openTerminal: ['Ctrl', 'Alt', '`'] } }),
    { openTerminal: ['Ctrl', 'Alt', '`'] }, '从设置形状读取覆盖')
  assert.deepEqual(
    applyShortcutOverrides(EMPTY_SHORTCUT_OVERRIDES).map((def) => def.id),
    SHORTCUTS.map((def) => def.id),
    '无覆盖时原样返回注册表'
  )

  const zh = shortcutText('zh-CN')
  const en = shortcutText('en-US')
  const allIds = SHORTCUTS.map((def) => def.id).sort()
  assert.deepEqual(Object.keys(zh.purposes).sort(), allIds, '中文作用文案覆盖全部 ShortcutId')
  assert.deepEqual(Object.keys(en.purposes).sort(), allIds, '英文作用文案覆盖全部 ShortcutId')
  assert.ok(zh.approval.allow && zh.approval.deny && en.approval.allow && en.approval.deny, '确认卡 Alt+Y/N 文案中英都有')

  for (const id of ['stopSession', 'workspaceTerminal', 'workspaceChanges', 'workspaceFiles', 'workspaceBrowser', 'workspacePreview']) {
    assert.ok(Object.values(COMMAND_ACTION_IDS).includes(id), `命令面板存在动作 ${id}`)
  }

  const sheet = readFileSync(here('../src/renderer/src/features/commands/ShortcutSheet.tsx'), 'utf8')
  assert.ok(sheet.includes('applyShortcutOverrides') && sheet.includes('shortcutOverridesFromSettings'),
    '帮助表按用户改绑后的生效键位显示')
  assert.ok(sheet.includes("from '../../app/shortcuts'") || sheet.includes("from '../../app/shortcuts\"") ||
    sheet.includes("app/shortcuts"), '帮助表从注册表取全局组')
  assert.ok(sheet.includes('text.approval.allow') && sheet.includes('text.approval.deny'), '帮助表补上确认卡 Alt+Y/N 行')
  assert.ok(sheet.includes('SHORTCUT_NOTE_GROUPS'), '输入框 / 审批 / 终端组仍复用共享说明数据')
  assert.ok(!sheet.includes('components/shell/ShortcutSheet'), '不引入 v2 旧快捷键表')

  console.log('v3 快捷键注册表补齐：注册表 / 冲突 / 精确匹配 / 焦点 / IME / 模态 / 终端 / 宿主去重 / 文案 / 面板一致性检查通过')
}

await runShortcutsAndPalette()
await runShortcutRegistry()
