import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const source = fileURLToPath(new URL(`../src/${rel}`, import.meta.url))
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

const crumbs = await load('renderer/src/features/files/breadcrumb-model.ts')

assert.deepEqual(crumbs.breadcrumbParts('a/b/c'), ['a', 'b', 'c'], '按 / 切分路径')
assert.deepEqual(crumbs.breadcrumbParts('a\\b\\c'), ['a', 'b', 'c'], '反斜杠同样切分')
assert.deepEqual(crumbs.breadcrumbParts('/a//b/'), ['a', 'b'], '忽略重复与前后的分隔符')
assert.deepEqual(crumbs.breadcrumbParts(''), [], '空路径没有层级')

assert.deepEqual(crumbs.breadcrumbCrumbs('inkstone', ''), [{ path: '', label: 'inkstone' }], '根目录只有项目名一级')
assert.deepEqual(
  crumbs.breadcrumbCrumbs('inkstone', 'src/main/ipc'),
  [
    { path: '', label: 'inkstone' },
    { path: 'src', label: 'src' },
    { path: 'src/main', label: 'main' },
    { path: 'src/main/ipc', label: 'ipc' }
  ],
  '每级累积相对路径'
)
assert.deepEqual(
  crumbs.breadcrumbCrumbs('inkstone', 'src\\renderer\\src\\').map((item) => item.path),
  ['', 'src', 'src/renderer', 'src/renderer/src'],
  '反斜杠与尾部斜杠归一成 / 形式'
)

assert.equal(crumbs.breadcrumbParent(''), null, '根目录没有上级')
assert.equal(crumbs.breadcrumbParent('src'), '', '一级目录的上级是根')
assert.equal(crumbs.breadcrumbParent('src/main/ipc'), 'src/main')
assert.equal(crumbs.breadcrumbParent('src\\main\\'), 'src', '尾部斜杠不影响上级')
assert.equal(crumbs.breadcrumbParent('/'), null)

assert.equal(crumbs.breadcrumbDirectory('', false), '', '未聚焦时停在根')
assert.equal(crumbs.breadcrumbDirectory('src/main.ts', false), 'src', '聚焦文件时面包屑停在所在目录')
assert.equal(crumbs.breadcrumbDirectory('src/main', true), 'src/main', '聚焦目录时面包屑就是该目录')
assert.equal(crumbs.breadcrumbDirectory('src/renderer/', true), 'src/renderer', '目录路径去掉尾部分隔符')
assert.equal(crumbs.breadcrumbDirectory('README.md', false), '', '根下文件的目录是根')

const short = crumbs.foldBreadcrumbs(
  crumbs.breadcrumbCrumbs('inkstone', 'src/main')
)
assert.equal(short.hidden.length, 0, '层级不多时不折叠')
assert.deepEqual(short.visible.map((item) => item.label), ['inkstone', 'src', 'main'], '不折叠时原样显示')

const deep = crumbs.breadcrumbCrumbs('inkstone', 'src/renderer/features/files/pane')
const folded = crumbs.foldBreadcrumbs(deep)
assert.deepEqual(folded.visible.map((item) => item.label), ['inkstone', 'features', 'files', 'pane'], '折叠时保留根与末尾层级')
assert.deepEqual(folded.hidden.map((item) => item.label), ['src', 'renderer'], '被折叠的层级按顺序放进菜单')
assert.equal(folded.hidden[0].path, 'src', '折叠项保留可跳转的路径')
assert.equal(folded.visible[0].path, '', '根一级始终可见')
assert.equal(folded.visible[folded.visible.length - 1].path, deep[deep.length - 1].path, '最后一级始终可见')

const singleHidden = crumbs.foldBreadcrumbs(crumbs.breadcrumbCrumbs('inkstone', 'src/renderer/features/files'))
assert.deepEqual(singleHidden.visible.map((item) => item.label), ['inkstone', 'renderer', 'features', 'files'], '只折叠一层时也给出省略项')
assert.deepEqual(singleHidden.hidden.map((item) => item.label), ['src'])

const custom = crumbs.foldBreadcrumbs(deep, 3)
assert.deepEqual(custom.visible.map((item) => item.label), ['inkstone', 'pane'], '更小的上限只保留根与当前级')
assert.deepEqual(custom.hidden.map((item) => item.label), ['src', 'renderer', 'features', 'files'])

assert.deepEqual(crumbs.foldBreadcrumbs(deep, 99).hidden, [], '上限大于层级数时不折叠')
assert.equal(crumbs.foldBreadcrumbs([{ path: '', label: 'x' }]).visible.length, 1, '只有根时不折叠也不出错')

const entries = [
  { name: 'src', dir: true },
  { name: 'README.md', dir: false },
  { name: 'linked', dir: true, link: { state: 'ok', target: '../out' } },
  { name: 'dangling', dir: true, link: { state: 'dangling' } },
  { name: 'cycle', dir: true, link: { state: 'cycle' } },
  { name: 'pkg', dir: true }
]
assert.deepEqual(
  crumbs.breadcrumbChildDirs(entries, '').map((item) => item.path),
  ['src', 'linked', 'pkg'],
  '下拉只列出目录，跳过坏链接，保持原有顺序'
)
assert.deepEqual(
  crumbs.breadcrumbChildDirs(entries, 'src').map((item) => item.path),
  ['src/src', 'src/linked', 'src/pkg'],
  '下拉项路径基于当前目录'
)
assert.deepEqual(crumbs.breadcrumbChildDirs(entries, 'src\\main\\').map((item) => item.path)[0], 'src/main/src', '当前目录先归一化')
assert.deepEqual(crumbs.breadcrumbChildDirs(undefined, 'src'), [], '目录未加载时没有可选项')
assert.deepEqual(crumbs.breadcrumbChildDirs(null, 'src'), [], '目录读取失败时没有可选项')
assert.deepEqual(crumbs.breadcrumbChildDirs([{ name: 'a.txt', dir: false }], ''), [], '只有文件时没有可选项')

assert.equal(crumbs.estimateCrumbWidth('project'), 58, '英文层级按字符宽度估算')
assert.equal(crumbs.estimateCrumbWidth('源码'), 34, '中文层级按更宽的字符估算')
assert.equal(crumbs.estimateCrumbWidth('a'.repeat(80)), 160, '过长的名字按上限截断估算')
assert.ok(crumbs.estimateCrumbWidth('reader') > crumbs.estimateCrumbWidth('read'), '名字越长估算越宽')

const trail = crumbs.breadcrumbCrumbs('project', 'src/renderer/features/files/pane')
const wide = crumbs.foldBreadcrumbsToWidth(trail, 380)
assert.deepEqual(wide.hidden, [], '宽度够时不折叠')
assert.equal(wide.visible.length, trail.length)

const narrow = crumbs.foldBreadcrumbsToWidth(trail, 260)
assert.deepEqual(narrow.visible.map((item) => item.label), ['project', 'files', 'pane'], '窄面板只保留根与能放下的末尾层级')
assert.deepEqual(narrow.hidden.map((item) => item.label), ['src', 'renderer', 'features'], '放不下的层级进入折叠菜单')

const tight = crumbs.foldBreadcrumbsToWidth(trail, 60)
assert.deepEqual(tight.visible.map((item) => item.label), ['project', 'pane'], '极窄时至少留下根与当前目录')
assert.deepEqual(tight.hidden.map((item) => item.label), ['src', 'renderer', 'features', 'files'])

const wideTrail = crumbs.foldBreadcrumbsToWidth(crumbs.breadcrumbCrumbs('项目', '源码/组件'), 400)
assert.deepEqual(wideTrail.hidden, [], '中文层级同样按宽度判定')
assert.equal(crumbs.foldBreadcrumbsToWidth([{ path: '', label: 'p' }], 10).visible.length, 1, '只有根时不折叠')

console.log('✓ breadcrumb-model：路径切分、折叠、上级与子目录全部通过')
