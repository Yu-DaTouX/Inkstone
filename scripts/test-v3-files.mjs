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
  toAbsolutePath
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
assert.equal(rows[0].path, '', '第一行是根')
assert.equal(rows[1].kind, 'state', '未加载的展开目录给加载行')
assert.equal(rows[1].state, 'loading')

view = { ...view, listings: { '': listing('', [dir('src'), file('README.md')]), src: listing('src', []) } }
rows = flattenRows(view)
assert.deepEqual(
  rows.map((row) => row.path),
  ['', 'src', 'src', 'README.md'],
  '根 / src 目录 / src 空提示 / 文件 的顺序正确'
)
assert.equal(rows[2].state, 'empty', '空目录有明确空态行')
assert.equal(rows[2].focusable, false, '状态行不可聚焦')
assert.deepEqual(focusablePaths(rows), ['', 'src', 'README.md'], '可聚焦行只有目录与文件')

view = { ...view, listings: { ...view.listings, '': null } }
rows = flattenRows(view)
assert.equal(rows[1].state, 'error', '请求失败显示失败行')

view = { ...view, listings: { ...view.listings, '': listing('', [file('a')], { status: 'permission' }) } }
rows = flattenRows(view)
assert.equal(rows[1].state, 'permission', '权限态按宿主 status 展示')

view = { ...view, listings: { ...view.listings, '': listing('', [file('a'), file('b')], { truncated: true }) } }
rows = flattenRows(view)
assert.equal(rows[rows.length - 1].state, 'partial', '截断给「只列出一部分」提示')

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
  ['', 'src', 'src/a.ts', 'src/b.ts', 'README.md'],
  '展平顺序与键盘顺序是同一份'
)

assert.equal(moveFocus(treeRows, '', 'ArrowDown'), 'src')
assert.equal(moveFocus(treeRows, 'README.md', 'ArrowDown'), 'README.md', '末行 ArrowDown 不越界')
assert.equal(moveFocus(treeRows, '', 'ArrowUp'), '', '首行 ArrowUp 不越界')
assert.equal(moveFocus(treeRows, 'src/a.ts', 'End'), 'README.md')
assert.equal(moveFocus(treeRows, 'src/b.ts', 'Home'), '')
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
assert.equal(rootLabel('C:\\work\\app'), 'app')
assert.equal(rootLabel('/home/u/app', 'my-project'), 'my-project')

assert.equal(canAttachToContext(OWNER, 's1'), true, '当前会话匹配才可加')
assert.equal(canAttachToContext(OWNER, 's2'), false, '会话不匹配不可加')
assert.equal(canAttachToContext({ ...OWNER, active: false }, 's1'), false, '非活动会话不可加')
assert.equal(canAttachToContext({ ...OWNER, sessionId: null }, null), false, '没有会话 id 不可加')

console.log('v3 文件面板纯逻辑：reducer 代次 / 展平状态 / 键盘导航 / 虚拟化 / 路径 / 归属 检查通过')
