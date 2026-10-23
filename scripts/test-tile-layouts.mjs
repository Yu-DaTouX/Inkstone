#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }

function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${extra}\n`)
  return pass
}

const outdir = await mkdtemp(join(tmpdir(), 'yan-tile-layouts-'))
let mod
const persisted = new Map()
globalThis.localStorage = {
  getItem: (key) => (persisted.has(key) ? persisted.get(key) : null),
  setItem: (key, value) => {
    persisted.set(key, String(value))
  },
  removeItem: (key) => {
    persisted.delete(key)
  },
  clear: () => persisted.clear()
}

try {
  const entry = join(outdir, 'entry.ts')
  await writeFile(
    entry,
    `export * from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/tile-tree'))}'
export * from '${posix(resolve(ROOT, 'src/renderer/src/state/tile-layouts'))}'
export * from '${posix(resolve(ROOT, 'src/renderer/src/state/ui-v3'))}'
`
  )
  const outfile = join(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json']
  })
  mod = await import(pathToFileURL(outfile).href)
} catch (err) {
  process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
  group('按会话切换（ui-v3 镜像）')
{
  reset()
  const ui = mod.useUiV3
  ok(ui.getState().layoutKey === HOME_LAYOUT_KEY, '启动时先挂在 home 上', ui.getState().layoutKey)
  ok(panesOfEntry({ tileLayout: ui.getState().workspaceLayout, baseLayout: null, expandedTile: null }).length === 0, 'home 初始没有面板')
  ui.getState().setWorkspaceTab('files')
  ok(ui.getState().workspacePanes.join() === 'files' && panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)).join() === 'files', '打开文件面板写进 home', panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)))
  ui.getState().loadLayoutSession('A')
  ok(ui.getState().layoutKey === 's:A', '切到会话 A 用它的 entry', ui.getState().layoutKey)
  ok(panesOfEntry(readTileLayoutEntry('s:A')).join() === 'files', '从 home 进入无记录的会话时继承 home 的布局', panesOfEntry(readTileLayoutEntry('s:A')))
  ok(ui.getState().workspacePanes.join() === 'files', '会话 A 载入后仍显示文件面板', ui.getState().workspacePanes)
  ui.getState().setWorkspaceTab('terminal')
  ui.getState().toggleWorkspaceExpanded('terminal')
  ok(ui.getState().workspaceExpandedTile === 'terminal' && ui.getState().workspaceFocus === true, '会话 A 最大化终端', ui.getState().workspaceExpandedTile)
  ok(readTileLayoutEntry('s:A').expandedTile === 'terminal', '最大化立即落盘', readTileLayoutEntry('s:A').expandedTile)
  ui.getState().loadLayoutSession('B')
  const inB = ui.getState()
  ok(inB.layoutKey === 's:B' && inB.workspacePanes.length === 0 && inB.workspaceExpandedTile === null, '切到没有记录的会话 B 时用 chat-only', inB.workspacePanes)
  ok(inB.workspaceFocus === false && inB.workspaceTab === 'overview', '会话 B 没有最大化也不指向旧页签', inB.workspaceTab)
  ui.getState().loadLayoutSession('A')
  const backA = ui.getState()
  ok(backA.workspacePanes.join() === 'files,terminal', '切回 A 恢复它的两块', backA.workspacePanes)
  ok(backA.workspaceExpandedTile === 'terminal' && backA.workspaceFocus === true, '切回 A 恢复最大化', backA.workspaceExpandedTile)
  ok(orderedTileIds(backA.workspaceLayout).join() === 'terminal', '最大化时渲染用的树只有终端', orderedTileIds(backA.workspaceLayout))
  ok(orderedTileIds(backA.workspaceBaseLayout).join() === 'chat,files,terminal', '基准树留在 workspaceBaseLayout', orderedTileIds(backA.workspaceBaseLayout))
  ui.getState().setWorkspaceFocus(false)
  ok(ui.getState().workspaceExpandedTile === null && orderedTileIds(ui.getState().workspaceLayout).join() === 'chat,files,terminal', '退出最大化回到原树', orderedTileIds(ui.getState().workspaceLayout))
  ok(readTileLayoutEntry('s:A').expandedTile === null, '退出最大化也落盘')
  ui.getState().setWorkspaceTab('overview')
  ok(ui.getState().workspacePanes.length === 0 && ui.getState().workspaceTab === 'overview', '回到概览关掉所有面板', ui.getState().workspacePanes)
  ok(orderedTileIds(readTileLayoutEntry('s:A').tileLayout).join() === 'chat', '会话 A 的 entry 退回只有聊天')
}

await rm(outdir, { recursive: true, force: true })
  process.exit(1)
}

const {
  CHAT_TILE_ID,
  TILE_GAP,
  chatOnlyLayout,
  columnLayout,
  layoutWithChat,
  orderedTileIds,
  hasTile,
  tileLeaf,
  tileStack,
  TILE_LAYOUTS_KEY,
  TILE_LAYOUTS_VERSION,
  MAX_LAYOUT_SESSIONS,
  HOME_LAYOUT_KEY,
  LEGACY_PANES_KEY,
  LEGACY_LAYOUT_KEY,
  LEGACY_FLEX_KEY,
  LEGACY_WIDTH_KEY,
  sessionLayoutKey,
  emptyTileLayoutEntry,
  sanitizeTileLayoutEntry,
  sanitizeTileLayouts,
  capLayoutSessions,
  panesOfEntry,
  expandLayoutEntry,
  collapseLayoutEntry,
  toggleExpandedEntry,
  withoutLayoutTiles,
  readTileLayouts,
  writeTileLayouts,
  readTileLayoutEntry,
  writeTileLayoutEntry,
  readPaneFlexByKind,
  rememberPaneFlexByKind,
  migrateLegacyTileLayouts
} = mod

const reset = () => persisted.clear()
const raw = () => JSON.parse(persisted.get(TILE_LAYOUTS_KEY) ?? 'null')
const flexOf = (layout) => {
  const out = {}
  const walk = (node) => {
    if (node.kind === 'tile') out[node.tileId] = node.flex
    else node.children.forEach(walk)
  }
  walk(layout.root)
  return out
}
const entryWith = (tileIds) => ({ tileLayout: layoutWithChat(columnLayout(tileIds)), baseLayout: null, expandedTile: null })
void TILE_GAP
void tileLeaf
void tileStack

group('键与空态')
{
  ok(sessionLayoutKey('abc') === 's:abc', '会话 key 带 s: 前缀', sessionLayoutKey('abc'))
  ok(sessionLayoutKey(null) === HOME_LAYOUT_KEY && sessionLayoutKey('') === HOME_LAYOUT_KEY, '没有会话 id 时用 home', sessionLayoutKey(null))
  ok(sessionLayoutKey('  ') === HOME_LAYOUT_KEY, '空白 id 归到 home', sessionLayoutKey('  '))
  const empty = readTileLayouts()
  ok(empty.version === TILE_LAYOUTS_VERSION && empty.sessions && Object.keys(empty.sessions).length === 0, '空库可读', empty)
  ok(orderedTileIds(emptyTileLayoutEntry().tileLayout).join() === CHAT_TILE_ID, '空 entry 只有聊天块', orderedTileIds(emptyTileLayoutEntry().tileLayout))
}

group('按会话写入与读取')
{
  reset()
  const a = entryWith(['files', 'changes'])
  const b = entryWith(['terminal'])
  writeTileLayoutEntry('s:a', a)
  writeTileLayoutEntry('s:b', b)
  ok(panesOfEntry(readTileLayoutEntry('s:a')).join() === 'files,changes', '会话 A 拿回自己的两块', panesOfEntry(readTileLayoutEntry('s:a')))
  ok(panesOfEntry(readTileLayoutEntry('s:b')).join() === 'terminal', '会话 B 拿回自己的一块', panesOfEntry(readTileLayoutEntry('s:b')))
  ok(readTileLayoutEntry('s:missing') === null, '没有记录返回 null（调用方退回 chat-only）', readTileLayoutEntry('s:missing'))
  ok(raw().order.join() === 's:a,s:b', '写入顺序进 order', raw().order)
  writeTileLayoutEntry('s:a', a)
  ok(raw().order.join() === 's:b,s:a', '再写同一会话把它移到末尾（最近使用）', raw().order)
  ok(hasTile(readTileLayoutEntry('s:a').tileLayout, CHAT_TILE_ID), '落盘的树里始终带聊天块')
}

group('LRU 裁剪：最多 100 条，最久未用先丢')
{
  reset()
  for (let index = 0; index < MAX_LAYOUT_SESSIONS + 5; index += 1) writeTileLayoutEntry(`s:${index}`, entryWith(['files']))
  const store = readTileLayouts()
  ok(store.order.length === MAX_LAYOUT_SESSIONS, `order 封顶 ${MAX_LAYOUT_SESSIONS}`, store.order.length)
  ok(Object.keys(store.sessions).length === MAX_LAYOUT_SESSIONS, 'sessions 同步裁剪', Object.keys(store.sessions).length)
  ok(!store.sessions['s:0'] && !store.sessions['s:4'], '最久未用的 5 条被丢', store.order[0])
  ok(!!store.sessions[`s:${MAX_LAYOUT_SESSIONS + 4}`], '最新一条保留')
  writeTileLayoutEntry('s:5', entryWith(['files']))
  const touched = readTileLayouts()
  ok(touched.order.length === MAX_LAYOUT_SESSIONS && touched.order[touched.order.length - 1] === 's:5', '重新使用旧条目后它回到末尾且不超上限', touched.order.slice(-2))
  const capped = capLayoutSessions({ version: 1, lastPaneFlexByKind: {}, sessions: { a: entryWith([]), b: entryWith([]) }, order: ['a', 'b'] }, 1)
  ok(capped.order.join() === 'b' && !capped.sessions.a, 'capLayoutSessions 是纯函数，可单测', capped.order)
}

group('最大化往返：baseLayout / expandedTile')
{
  const tree = layoutWithChat(columnLayout(['files', 'changes']))
  const entry = { tileLayout: tree, baseLayout: null, expandedTile: null }
  const expanded = toggleExpandedEntry(entry, 'files')
  ok(expanded.expandedTile === 'files', '展开写入 expandedTile', expanded.expandedTile)
  ok(orderedTileIds(expanded.tileLayout).join() === 'files', '展开时 tileLayout 只剩被展开的块', orderedTileIds(expanded.tileLayout))
  ok(expanded.baseLayout && orderedTileIds(expanded.baseLayout).join() === `chat,files,changes`, '展开时原树存进 baseLayout', orderedTileIds(expanded.baseLayout))
  ok(panesOfEntry(expanded).join() === 'files,changes', '展开时面板清单仍来自 baseLayout（其它块不丢）', panesOfEntry(expanded))
  const restored = toggleExpandedEntry(expanded, 'files')
  ok(restored.expandedTile === null && restored.baseLayout === null, '再点一次清空最大化', restored)
  ok(!restored.tileLayout.root.children[0].flex || restored.tileLayout.root.children[0].flex > 0, '还原后聊天块回到原比例')
  ok(flexOf(restored.tileLayout)[CHAT_TILE_ID] === flexOf(tree)[CHAT_TILE_ID], '还原后的树与展开前逐块一致', flexOf(restored.tileLayout))
  const switched = toggleExpandedEntry(expanded, 'changes')
  ok(switched.expandedTile === 'changes' && orderedTileIds(switched.tileLayout).join() === 'changes', '最大化另一个块时直接换块', switched.expandedTile)
  ok(orderedTileIds(switched.baseLayout).join() === 'chat,files,changes', '换块时 baseLayout 仍是原树')
  const collapsed = collapseLayoutEntry(switched)
  ok(collapsed.expandedTile === null && flexOf(collapsed.tileLayout)[CHAT_TILE_ID] === flexOf(tree)[CHAT_TILE_ID], '折叠回原树')
  ok(toggleExpandedEntry(entry, 'missing') === entry, '展开树里没有的块不改 entry')
}

group('最大化落盘与恢复')
{
  reset()
  const tree = layoutWithChat(columnLayout(['files', 'changes']))
  writeTileLayoutEntry('s:x', toggleExpandedEntry({ tileLayout: tree, baseLayout: null, expandedTile: null }, 'changes'))
  const stored = readTileLayoutEntry('s:x')
  ok(stored.expandedTile === 'changes', '刷新后 expandedTile 还在', stored.expandedTile)
  ok(orderedTileIds(stored.baseLayout).join() === 'chat,files,changes', '刷新后 baseLayout 还在')
  const badExpanded = sanitizeTileLayoutEntry({ tileLayout: columnLayout(['files']), baseLayout: tree, expandedTile: 'terminal' })
  ok(badExpanded.expandedTile === null && badExpanded.baseLayout === null && orderedTileIds(badExpanded.tileLayout).join() === 'chat,files,changes', 'expandedTile 不在树里时丢弃最大化并还原原树', badExpanded.expandedTile)
  const orphan = sanitizeTileLayoutEntry({ tileLayout: tree, baseLayout: null, expandedTile: 'files' })
  ok(orphan.expandedTile === null && orderedTileIds(orphan.tileLayout).join() === 'chat,files,changes', '只有 expandedTile 没有 baseLayout 时也丢弃', orphan.expandedTile)
  const noChat = sanitizeTileLayoutEntry({ tileLayout: columnLayout(['files']), baseLayout: null, expandedTile: null })
  ok(orderedTileIds(noChat.tileLayout).join() === 'chat,files', '没有最大化时缺聊天块的树会补上聊天', orderedTileIds(noChat.tileLayout))
}

group('关闭面板后退出最大化')
{
  const tree = layoutWithChat(columnLayout(['files', 'changes']))
  const expanded = toggleExpandedEntry({ tileLayout: tree, baseLayout: null, expandedTile: null }, 'files')
  const dropped = withoutLayoutTiles(expanded, new Set(['files']))
  ok(dropped.expandedTile === null, '关掉被最大化的块时退出最大化', dropped.expandedTile)
  ok(panesOfEntry(dropped).join() === 'changes', '剩下的块还在', panesOfEntry(dropped))
  const kept = withoutLayoutTiles(expanded, new Set(['changes']))
  ok(kept.expandedTile === 'files' && orderedTileIds(kept.tileLayout).join() === 'files', '关掉别的块时保持最大化', kept.expandedTile)
  ok(panesOfEntry(kept).join() === 'files', '其它块被关掉后清单只剩被最大化的块', panesOfEntry(kept))
}

group('旧键迁移')
{
  reset()
  const legacyTree = layoutWithChat(columnLayout(['files', 'terminal']), 2)
  persisted.set(LEGACY_PANES_KEY, JSON.stringify(['files', 'terminal']))
  persisted.set(LEGACY_LAYOUT_KEY, JSON.stringify(legacyTree))
  persisted.set(LEGACY_FLEX_KEY, JSON.stringify({ files: 3, terminal: 1 }))
  persisted.set(LEGACY_WIDTH_KEY, '420')
  const migrated = migrateLegacyTileLayouts()
  ok(migrated === true, '没有新键时做一次迁移', migrated)
  const store = readTileLayouts()
  ok(!!store.sessions[HOME_LAYOUT_KEY], '旧布局迁到 home（旧键本来是全局的）', Object.keys(store.sessions))
  ok(panesOfEntry(store.sessions[HOME_LAYOUT_KEY]).join() === 'files,terminal', '旧面板清单与嵌套结构保留', panesOfEntry(store.sessions[HOME_LAYOUT_KEY]))
  ok(store.lastPaneFlexByKind.files === 3 && store.lastPaneFlexByKind.terminal === 1, '旧比例并进 lastPaneFlexByKind', store.lastPaneFlexByKind)
  ok(!persisted.has(LEGACY_PANES_KEY) && !persisted.has(LEGACY_LAYOUT_KEY) && !persisted.has(LEGACY_FLEX_KEY) && !persisted.has(LEGACY_WIDTH_KEY), '迁移后旧键全部删除', [...persisted.keys()])
  ok(migrateLegacyTileLayouts() === false, '再跑一次迁移是空操作', false)
}

group('旧布局没有聊天块 / 新键读失败兜底')
{
  reset()
  const bare = columnLayout(['files', 'changes'])
  persisted.set(LEGACY_PANES_KEY, JSON.stringify(['files', 'changes']))
  persisted.set(LEGACY_LAYOUT_KEY, JSON.stringify(bare))
  migrateLegacyTileLayouts()
  const entry = readTileLayoutEntry(HOME_LAYOUT_KEY)
  ok(hasTile(entry.tileLayout, CHAT_TILE_ID), '旧树缺聊天块时补上聊天', orderedTileIds(entry.tileLayout))
  ok(orderedTileIds(entry.tileLayout).join() === 'chat,files,changes', '补聊天不改变旧面板顺序', orderedTileIds(entry.tileLayout))

  reset()
  persisted.set(LEGACY_PANES_KEY, JSON.stringify(['files']))
  persisted.set(LEGACY_LAYOUT_KEY, JSON.stringify(layoutWithChat(columnLayout(['files']))))
  persisted.set(LEGACY_FLEX_KEY, JSON.stringify({ files: 2.5 }))
  persisted.set(TILE_LAYOUTS_KEY, '{ this is not json')
  const fallback = readTileLayouts()
  ok(panesOfEntry(fallback.sessions[HOME_LAYOUT_KEY]).join() === 'files', '新键读失败时回退读旧键', Object.keys(fallback.sessions))
  ok(fallback.lastPaneFlexByKind.files === 2.5, '回退时旧比例也读回', fallback.lastPaneFlexByKind)
  ok(persisted.has(LEGACY_PANES_KEY) && persisted.has(LEGACY_LAYOUT_KEY), '兜底路径不删旧键', [...persisted.keys()])
  ok(migrateLegacyTileLayouts() === true, '坏新键会被旧键重写一次', true)
  ok(persisted.get(TILE_LAYOUTS_KEY).includes('"version":1'), '重写后新键可解析', persisted.get(TILE_LAYOUTS_KEY))
}

group('比例记忆并进同一个键')
{
  reset()
  const tree = layoutWithChat({ root: tileStack('row', [tileLeaf('files', 3), tileLeaf('changes', 3)]) }, 2)
  writeTileLayoutEntry('s:flex', { tileLayout: tree, baseLayout: null, expandedTile: null })
  const memory = rememberPaneFlexByKind(tree, ['changes'])
  ok(memory.changes === 1.5, '按 2*side/chat 记比例（chat 2、changes 1.5）', memory)
  ok(readPaneFlexByKind().changes === 1.5, '比例记忆与布局写在同一个键里', raw().lastPaneFlexByKind)
  ok(Object.keys(raw().sessions).join() === 's:flex', '写比例不丢会话布局', Object.keys(raw().sessions))
  const sanitized = sanitizeTileLayouts({ version: 1, lastPaneFlexByKind: { files: 2, terminal: 0, logs: 120 }, sessions: {}, order: [] })
  ok(sanitized.lastPaneFlexByKind.files === 2 && sanitized.lastPaneFlexByKind.terminal === undefined && sanitized.lastPaneFlexByKind.logs === undefined, '读盘丢弃非法比例', sanitized.lastPaneFlexByKind)
}

group('坏结构')
{
  ok(sanitizeTileLayouts(null) === null && sanitizeTileLayouts([]) === null, '非对象视为没有库', null)
  ok(sanitizeTileLayouts({ version: 2, sessions: {}, order: [] }) === null, '版本不符视为没有库', null)
  ok(sanitizeTileLayouts({ version: 1, sessions: [], order: [] }) === null, 'sessions 非对象视为没有库', null)
  const partial = sanitizeTileLayouts({ version: 1, sessions: { home: { tileLayout: chatOnlyLayout() } }, order: ['home', 'stray'] })
  ok(partial.order.join() === 'home', 'order 里没有对应会话的键被丢掉', partial.order)
  ok(partial.sessions.home.expandedTile === null && partial.sessions.home.baseLayout === null, '缺字段的 entry 补齐空值')
}

group('按会话切换（ui-v3 镜像）')
{
  reset()
  const ui = mod.useUiV3
  ok(ui.getState().layoutKey === HOME_LAYOUT_KEY, '启动时先挂在 home 上', ui.getState().layoutKey)
  ok(panesOfEntry({ tileLayout: ui.getState().workspaceLayout, baseLayout: null, expandedTile: null }).length === 0, 'home 初始没有面板')
  ui.getState().setWorkspaceTab('files')
  ok(ui.getState().workspacePanes.join() === 'files' && panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)).join() === 'files', '打开文件面板写进 home', panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)))
  ui.getState().loadLayoutSession('A')
  ok(ui.getState().layoutKey === 's:A', '切到会话 A 用它的 entry', ui.getState().layoutKey)
  ok(panesOfEntry(readTileLayoutEntry('s:A')).join() === 'files', '从 home 进入无记录的会话时继承 home 的布局', panesOfEntry(readTileLayoutEntry('s:A')))
  ok(ui.getState().workspacePanes.join() === 'files', '会话 A 载入后仍显示文件面板', ui.getState().workspacePanes)
  ui.getState().setWorkspaceTab('terminal')
  ui.getState().toggleWorkspaceExpanded('terminal')
  ok(ui.getState().workspaceExpandedTile === 'terminal' && ui.getState().workspaceFocus === true, '会话 A 最大化终端', ui.getState().workspaceExpandedTile)
  ok(readTileLayoutEntry('s:A').expandedTile === 'terminal', '最大化立即落盘', readTileLayoutEntry('s:A').expandedTile)
  ui.getState().loadLayoutSession('B')
  const inB = ui.getState()
  ok(inB.layoutKey === 's:B' && inB.workspacePanes.length === 0 && inB.workspaceExpandedTile === null, '切到没有记录的会话 B 时用 chat-only', inB.workspacePanes)
  ok(inB.workspaceFocus === false && inB.workspaceTab === 'overview', '会话 B 没有最大化也不指向旧页签', inB.workspaceTab)
  ui.getState().loadLayoutSession('A')
  const backA = ui.getState()
  ok(backA.workspacePanes.join() === 'files,terminal', '切回 A 恢复它的两块', backA.workspacePanes)
  ok(backA.workspaceExpandedTile === 'terminal' && backA.workspaceFocus === true, '切回 A 恢复最大化', backA.workspaceExpandedTile)
  ok(orderedTileIds(backA.workspaceLayout).join() === 'terminal', '最大化时渲染用的树只有终端', orderedTileIds(backA.workspaceLayout))
  ok(orderedTileIds(backA.workspaceBaseLayout).join() === 'chat,files,terminal', '基准树留在 workspaceBaseLayout', orderedTileIds(backA.workspaceBaseLayout))
  ui.getState().setWorkspaceFocus(false)
  ok(ui.getState().workspaceExpandedTile === null && orderedTileIds(ui.getState().workspaceLayout).join() === 'chat,files,terminal', '退出最大化回到原树', orderedTileIds(ui.getState().workspaceLayout))
  ok(readTileLayoutEntry('s:A').expandedTile === null, '退出最大化也落盘')
  ui.getState().setWorkspaceTab('overview')
  ok(ui.getState().workspacePanes.length === 0 && ui.getState().workspaceTab === 'overview', '回到概览关掉所有面板', ui.getState().workspacePanes)
  ok(orderedTileIds(readTileLayoutEntry('s:A').tileLayout).join() === 'chat', '会话 A 的 entry 退回只有聊天')
}

group('工作区收起状态保持')
{
  reset()
  const ui = mod.useUiV3
  ui.getState().loadLayoutSession(null)
  ui.getState().setWorkspaceTab('files')
  ui.getState().setWorkspaceOpen(true)
  ui.getState().loadLayoutSession('C')
  ok(ui.getState().workspacePanes.join() === 'files', '新会话继承 home 的文件面板', ui.getState().workspacePanes)
  ui.getState().closeWorkspacePane('files')
  ok(ui.getState().workspacePanes.length === 0 && ui.getState().workspaceOpen === false, '在会话里关掉最后一个面板后工作区收起')
  ok(panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)).length === 0, '关掉的面板同时从 home 布局里去掉', panesOfEntry(readTileLayoutEntry(HOME_LAYOUT_KEY)))
  ui.getState().loadLayoutSession(null)
  ok(ui.getState().workspacePanes.length === 0, '新会话不再从 home 继承已关掉的文件面板', ui.getState().workspacePanes)
  ui.getState().loadLayoutSession('C')
  ui.getState().setWorkspaceTab('files')
  ui.getState().setWorkspaceOpen(false)
  ui.getState().loadLayoutSession('D')
  ui.getState().loadLayoutSession('C')
  ok(ui.getState().workspacePanes.join() === 'files' && ui.getState().workspaceOpen === false, '手动收起工作区后切回有面板的会话仍保持收起', { panes: ui.getState().workspacePanes, open: ui.getState().workspaceOpen })
}

await rm(outdir, { recursive: true, force: true })
assert.ok(true)
process.stdout.write(`\n全部通过：${report.pass}/${report.pass + report.fail}\n`)
if (report.fail > 0) process.exit(1)
