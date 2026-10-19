import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/files/files-model.ts', import.meta.url))
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
  canAttachToContext,
  computeWindow,
  filesTreeReducer,
  flattenRows,
  focusablePaths,
  freshTreeState,
  handleTreeKey,
  isDescendantPath,
  moveFocus,
  parentPath,
  rootLabel,
  rootStatus,
  tabbablePath,
  toAbsolutePath,
  toRelativePath,
  treeIndent,
  ancestorPaths
} = mod

const OWNER = { key: 'k', sessionId: 's1', cwd: '/proj', active: true }

function listing(path, entries, over = {}) {
  return {
    path,
    abs: `/proj/${path}`.replace(/\/$/, ''),
    entries: entries.map((entry) =>
      typeof entry === 'string' ? { name: entry, dir: false, size: 10 } : entry
    ),
    skipped: [],
    truncated: false,
    status: entries.length ? 'ok' : 'empty',
    ...over
  }
}

const dir = (name, size) => (size === undefined ? { name, dir: true } : { name, dir: true, size })
const file = (name, size = 10) => ({ name, dir: false, size })

let state = freshTreeState('A', '/a', 1, false)
state = filesTreeReducer(state, { type: 'loadStart', path: '', generation: 1 })
assert.equal(state.loading[''], true, '新代次请求进入 loading')
state = filesTreeReducer(state, { type: 'loadOk', path: '', generation: 2, listing: listing('', ['x']) })
assert.equal(state.listings[''], undefined, '旧代次回包被丢弃')
assert.equal(state.loading[''], true, '被丢弃的回包不清新代次的 loading 标记')
state = filesTreeReducer(state, { type: 'loadOk', path: '', generation: 1, listing: listing('', ['x']) })
assert.equal(state.listings[''].entries.length, 1, '同代次回包写入')
assert.equal(state.loading[''], undefined, '写入后清 loading')

state = filesTreeReducer(state, { type: 'loadStart', path: 'x', generation: 1 })
state = filesTreeReducer(state, { type: 'loadError', path: 'x', generation: 9 })
assert.equal(state.listings['x'], undefined, '旧代次错误被丢弃')
state = filesTreeReducer(state, { type: 'loadError', path: 'x', generation: 1 })
assert.equal(state.listings['x'], null, '同代次错误记为 null')

let reset = filesTreeReducer(state, { type: 'reset', ownerKey: 'B', cwd: '/b', generation: 3 })
assert.equal(reset.ownerKey, 'B')
assert.equal(reset.cwd, '/b')
assert.deepEqual(reset.listings, {}, '换 owner 清目录缓存')
assert.deepEqual(reset.open, { '': true }, '只留根展开')
assert.equal(reset.focusPath, '', '焦点回根')

reset = filesTreeReducer({ ...reset, showHidden: false }, { type: 'toggleHidden', generation: 4 })
assert.equal(reset.showHidden, true, '隐藏开关翻转')
assert.deepEqual(reset.listings, {}, '隐藏开关变化也清缓存')

let focusState = freshTreeState('A', '/a', 1, false)
focusState = { ...focusState, open: { '': true, src: true }, focusPath: 'src/a.ts' }
focusState = filesTreeReducer(focusState, { type: 'toggle', path: 'src' })
assert.equal(focusState.open.src, undefined, '收起 src')
assert.equal(focusState.focusPath, 'src', '焦点退回被收起的目录')

const expanded = { '': true, src: true }

let view = freshTreeState('A', '/a', 1, false)
view = { ...view, open: { ...expanded } }
let rows = flattenRows(view)
assert.equal(rows.length, 0, '没有根行；根目录未加载时不出行')
assert.equal(rootStatus(view), 'loading', '根目录读取中由整块状态表达')
assert.equal(rootStatus({ ...view, cwd: '' }), 'none', '没有工作目录')

view = { ...view, listings: { '': listing('', [dir('src'), file('README.md')]), src: listing('src', []) } }
rows = flattenRows(view)
assert.equal(rootStatus(view), 'ready')
assert.deepEqual(
  rows.map((row) => row.path),
  ['src', 'src', 'README.md'],
  'src 目录 / src 空提示 / 文件 的顺序正确'
)
assert.equal(rows[0].depth, 0, '顶层行层级为 0')
assert.equal(rows[1].state, 'empty', '空子目录有明确空态行')
assert.equal(rows[1].focusable, false, '状态行不可聚焦')
assert.deepEqual(focusablePaths(rows), ['src', 'README.md'], '可聚焦行只有目录与文件')

view = { ...view, listings: { ...view.listings, src: null } }
rows = flattenRows(view)
assert.equal(rows[1].state, 'error', '子目录读取失败给失败行')

view = { ...view, listings: { ...view.listings, '': null } }
assert.equal(rootStatus(view), 'error', '根目录失败是整块错误态')
assert.equal(flattenRows(view).length, 0)

view = { ...view, listings: { ...view.listings, '': listing('', [file('a')], { status: 'permission' }) } }
assert.equal(rootStatus(view), 'error', '根目录权限问题归为读取失败')

view = { ...view, listings: { ...view.listings, '': listing('', []) } }
assert.equal(rootStatus(view), 'empty', '根目录为空')

view = { ...view, listings: { ...view.listings, '': listing('', [file('a'), file('b')], { truncated: true }) } }
rows = flattenRows(view)
assert.equal(rows[rows.length - 1].state, 'partial', '截断给「只列出一部分」提示')

let chainState = freshTreeState('A', '/a', 1, false)
chainState = filesTreeReducer(chainState, { type: 'loadOk', path: '', generation: 1, listing: listing('', [dir('a'), file('x')]) })
chainState = filesTreeReducer(chainState, { type: 'toggle', path: 'a' })
assert.equal(chainState.chain.a, 16, '展开未加载目录时记下连续展开余量')
chainState = filesTreeReducer(chainState, { type: 'loadOk', path: 'a', generation: 1, listing: listing('a', [dir('b')]) })
assert.equal(chainState.open['a/b'], true, '只有一个子文件夹时连续展开')
assert.equal(chainState.chain['a/b'], 15, '连续展开继续等待下一层')
chainState = filesTreeReducer(chainState, { type: 'loadOk', path: 'a/b', generation: 1, listing: listing('a/b', [dir('c'), file('d')]) })
assert.equal(chainState.open['a/b/c'], undefined, '多于一个子项时停止')
assert.equal(chainState.chain['a/b'], undefined, '停止后清余量')
chainState = filesTreeReducer(chainState, { type: 'toggle', path: 'a' })
chainState = filesTreeReducer(chainState, { type: 'toggle', path: 'a' })
assert.equal(chainState.open['a/b'], true, '已缓存的单子目录链立即展开')

const linkRows = flattenRows({
  ...freshTreeState('A', '/a', 1, false),
  listings: {
    '': listing('', [
      { name: 'bad', dir: true, link: { state: 'dangling' } },
      { name: 'ok', dir: true, link: { state: 'ok', target: '/x', targetKind: 'dir' } },
      { name: 'loop', dir: true, link: { state: 'cycle' } }
    ])
  },
  open: { '': true }
})
assert.equal(linkRows[0].blocked, true, '坏链不可展开')
assert.equal(linkRows[0].open, undefined, '坏链不带展开状态')
assert.equal(linkRows[1].blocked, undefined, '正常链接可展开')
assert.equal(linkRows[1].open, false)
assert.equal(linkRows[2].blocked, true, '循环链接不可展开')
assert.deepEqual(
  handleTreeKey({ rows: linkRows, currentPath: 'bad', key: 'Enter', canAdd: false }),
  { type: 'none' },
  '坏链 Enter 无动作'
)
assert.deepEqual(
  handleTreeKey({ rows: linkRows, currentPath: 'loop', key: 'ArrowRight', canAdd: false }),
  { type: 'none' },
  '循环链接 ArrowRight 无动作'
)

let revealState = filesTreeReducer(freshTreeState('A', '/a', 1, false), { type: 'reveal', path: 'src/lib/a.ts' })
assert.equal(revealState.open.src, true, '在树中显示：展开祖先')
assert.equal(revealState.open['src/lib'], true)
assert.equal(revealState.open['src/lib/a.ts'], undefined, '不展开目标本身')
assert.equal(revealState.focusPath, 'src/lib/a.ts', '焦点落到目标')
assert.deepEqual(ancestorPaths('src/lib/a.ts'), ['', 'src', 'src/lib'])

assert.equal(treeIndent(0), 8, '缩进 = 8 + 层级 × 10')
assert.equal(treeIndent(3), 38)

const treeRows = flattenRows({
  ...freshTreeState('A', '/a', 1, false),
  listings: {
    '': listing('', [dir('src'), file('README.md')]),
    src: listing('src', [file('a.ts'), file('b.ts')])
  },
  open: { '': true, src: true }
})
assert.deepEqual(
  focusablePaths(treeRows),
  ['src', 'src/a.ts', 'src/b.ts', 'README.md'],
  '展平顺序与键盘顺序是同一份'
)
assert.equal(tabbablePath(treeRows, ''), 'src', '焦点在根时 Tab 落到第一行')
assert.equal(tabbablePath(treeRows, 'src/b.ts'), 'src/b.ts')

assert.equal(moveFocus(treeRows, '', 'ArrowDown'), 'src')
assert.equal(moveFocus(treeRows, 'README.md', 'ArrowDown'), 'README.md', '末行 ArrowDown 不越界')
assert.equal(moveFocus(treeRows, 'src', 'ArrowUp'), 'src', '首行 ArrowUp 不越界')
assert.equal(moveFocus(treeRows, 'src/a.ts', 'End'), 'README.md')
assert.equal(moveFocus(treeRows, 'src/b.ts', 'Home'), 'src')
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'ArrowLeft', canAdd: false }),
  { type: 'none' },
  '顶层行 ArrowLeft 不跳到不存在的根行'
)
assert.equal(parentPath('src/a.ts'), 'src')
assert.equal(parentPath('README.md'), '')
assert.equal(parentPath(''), undefined)
assert.equal(isDescendantPath('src/a.ts', 'src'), true)
assert.equal(isDescendantPath('src', 'src'), false)

const key = (over) => handleTreeKey({ rows: treeRows, currentPath: over.path ?? '', canAdd: false, ...over })

const closedRows = flattenRows({
  ...freshTreeState('A', '/a', 1, false),
  listings: {
    '': listing('', [dir('src'), file('README.md')]),
    src: listing('src', [file('a.ts')])
  },
  open: { '': true }
})

assert.deepEqual(key({ path: 'src', key: 'ArrowRight' }), { type: 'focus', path: 'src/a.ts' }, '已展开目录 ArrowRight 移到第一个子行')
assert.deepEqual(
  handleTreeKey({ rows: closedRows, currentPath: 'src', key: 'ArrowRight', canAdd: false }),
  { type: 'toggle', path: 'src' },
  '已收起目录 ArrowRight 展开'
)
assert.deepEqual(key({ path: 'src', key: 'ArrowLeft' }), { type: 'toggle', path: 'src' }, '已展开目录 ArrowLeft 收起')
assert.deepEqual(key({ path: 'src/a.ts', key: 'ArrowLeft' }), { type: 'focus', path: 'src' }, '文件 ArrowLeft 回父目录')
assert.deepEqual(key({ path: 'src/a.ts', key: 'Enter' }), { type: 'preview', path: 'src/a.ts' }, 'Enter 文件 = 预览')
assert.deepEqual(key({ path: 'src', key: 'Enter' }), { type: 'toggle', path: 'src' }, 'Enter 目录 = 展开')
assert.deepEqual(key({ path: 'README.md', key: ' ' }), { type: 'preview', path: 'README.md' }, 'Space 文件 = 预览')
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'ArrowRight', canAdd: false }),
  { type: 'none' },
  '文件 ArrowRight 无动作'
)
assert.deepEqual(key({ path: 'README.md', key: 'a' }), { type: 'none' }, 'canAdd=false 时 a 不加入上下文')
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'a', canAdd: true }),
  { type: 'add', path: 'README.md' },
  'canAdd=true 时 a 加入上下文'
)
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'Enter', altKey: true, canAdd: true }),
  { type: 'add', path: 'README.md' },
  'Alt+Enter 加入上下文'
)
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'Enter', altKey: true, canAdd: false }),
  { type: 'preview', path: 'README.md' },
  '不能加时 Alt+Enter 退化为预览'
)
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'a', ctrlKey: true, canAdd: true }),
  { type: 'none' },
  'Ctrl+A 不是加入上下文'
)
assert.deepEqual(
  handleTreeKey({ rows: treeRows, currentPath: 'README.md', key: 'Enter', isComposing: true, canAdd: true }),
  { type: 'none' },
  'IME 组字中的 Enter 不动作'
)
assert.deepEqual(key({ path: 'README.md', key: 'Delete' }), { type: 'none' }, '首版没有删除动作')

const big = computeWindow({ count: 1000, scrollTop: 0, viewportHeight: 200, rowHeight: 20, overscan: 1 })
assert.deepEqual(big, { start: 0, end: 11, padTop: 0, padBottom: (1000 - 11) * 20 }, '顶部窗口含 overscan')

const mid = computeWindow({ count: 1000, scrollTop: 1000, viewportHeight: 200, rowHeight: 20, overscan: 1 })
assert.equal(mid.start, 49)
assert.equal(mid.end, 61)
assert.equal(mid.padTop, 49 * 20)

const anchored = computeWindow({ count: 1000, scrollTop: 0, viewportHeight: 200, rowHeight: 20, overscan: 1, includeIndex: 400 })
assert.equal(anchored.start, 0, '焦点行远在视口外也并进渲染范围，否则键盘找不到节点')
assert.equal(anchored.end, 401)
assert.equal(anchored.padTop, 0)
assert.equal(anchored.padBottom, (1000 - 401) * 20)

assert.deepEqual(
  computeWindow({ count: 0, scrollTop: 0, viewportHeight: 200, rowHeight: 20 }),
  { start: 0, end: 0, padTop: 0, padBottom: 0 },
  '空列表窗口为空'
)

assert.equal(toAbsolutePath('C:\\work\\app', 'src/a.ts'), 'C:\\work\\app\\src\\a.ts')
assert.equal(toAbsolutePath('C:\\work\\app\\', 'a.ts'), 'C:\\work\\app\\a.ts')
assert.equal(toAbsolutePath('/home/u/app', 'src/a.ts'), '/home/u/app/src/a.ts')
assert.equal(toAbsolutePath('/home/u/app/', ''), '/home/u/app')
assert.equal(toRelativePath('C:\\work\\app', 'C:\\Work\\App\\src\\a.ts'), 'src/a.ts', 'Windows 路径大小写不敏感')
assert.equal(toRelativePath('/home/u/app', '/home/u/other/a.ts'), null, '根外返回 null')
assert.equal(rootLabel('C:\\work\\app'), 'app')
assert.equal(rootLabel('/home/u/app', 'my-project'), 'my-project')

assert.equal(canAttachToContext(OWNER, 's1'), true, '当前会话匹配才可加')
assert.equal(canAttachToContext(OWNER, 's2'), false, '会话不匹配不可加')
assert.equal(canAttachToContext({ ...OWNER, active: false }, 's1'), false, '非活动会话不可加')
assert.equal(canAttachToContext({ ...OWNER, sessionId: null }, null), false, '没有会话 id 不可加')

console.log('v3 文件面板纯逻辑：reducer 代次 / 展平状态 / 键盘导航 / 虚拟化 / 路径 / 归属 检查通过')
