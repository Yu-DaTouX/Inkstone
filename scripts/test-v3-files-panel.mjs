import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const source = fileURLToPath(new URL(`../src/renderer/src/${rel}`, import.meta.url))
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

const search = await load('features/files/files-search.ts')
const menu = await load('features/files/files-menu.ts')
const split = await load('features/files/use-files-split.ts')
const issue = await load('features/preview/preview-issue.ts')
const language = await load('features/preview/preview-language.ts')
const unsaved = await load('features/editor/unsaved-registry.ts')

assert.deepEqual(search.parseFilesQuery(' ?todo '), { mode: 'content', query: 'todo' }, '? 前缀是内容搜索')
assert.deepEqual(search.parseFilesQuery('app'), { mode: 'name', query: 'app' })
assert.deepEqual(search.splitTreePath('src/lib/a.ts'), { parent: 'src/lib', name: 'a.ts' })
assert.deepEqual(search.splitTreePath('a.ts'), { parent: '', name: 'a.ts' })
assert.deepEqual(search.namePositions('src/app.ts', [0, 4, 5]), [0, 1], '只保留落在文件名上的匹配位置并换算偏移')
assert.deepEqual(
  search.highlightParts('app.ts', [0, 1]),
  [
    { text: 'ap', hit: true },
    { text: 'p.ts', hit: false }
  ],
  '相邻命中字符合并成一段'
)
const nameRows = search.nameSearchRows({
  request: { cwd: '/p', generation: 1, requestId: 'r', query: 'ap' },
  matches: [{ path: 'src/app.ts', name: 'app.ts', directory: false, positions: [4, 5], score: 1 }],
  truncated: false,
  source: 'git',
  scanned: 1
})
assert.equal(nameRows[0].parent, 'src', '文件结果带父路径')
assert.deepEqual(nameRows[0].nameParts[0], { text: 'ap', hit: true }, '文件结果带匹配高亮')
const contentRows = search.groupContentHits([
  { path: 'a.ts', name: 'a.ts', line: 3, text: '  const x = 1' },
  { path: 'a.ts', name: 'a.ts', line: 9, text: 'x()' },
  { path: 'b/c.ts', name: 'c.ts', line: 1, text: 'x' }
])
assert.deepEqual(
  contentRows.rows.map((row) => `${row.kind}:${row.path}:${row.line ?? ''}`),
  ['entry:a.ts:', 'line:a.ts:3', 'line:a.ts:9', 'entry:b/c.ts:', 'line:b/c.ts:1'],
  '内容匹配按文件分组，每行带行号'
)
assert.equal(contentRows.rows[1].text, 'const x = 1', '片段去掉首尾空白')
assert.equal(search.nameSearchFailed({ error: { code: 'superseded' } }), false, '被新请求取代不算失败')
assert.equal(search.nameSearchFailed({ error: { code: 'timeout' } }), true)

const one = [{ path: 'src/a.ts', name: 'a.ts', dir: false }]
const folder = [{ path: 'src', name: 'src', dir: true }]
const many = [...one, { path: 'b.md', name: 'b.md', dir: false }, ...folder]
let model = menu.filesMenuModel(one, { canAdd: true, canTerminal: true })
assert.equal(model.plural, false)
assert.equal(model.attach, true, '单个文件可作为上下文附加')
assert.equal(model.openPreview, true)
assert.equal(model.reveal, true)
assert.equal(model.terminal, false, '文件没有在终端中打开')
model = menu.filesMenuModel(folder, { canAdd: true, canTerminal: true })
assert.equal(model.terminal, true, '文件夹可在终端中打开')
assert.equal(model.attach, false, '文件夹不作为上下文附加')
model = menu.filesMenuModel(many, { canAdd: true, canTerminal: true })
assert.equal(model.plural, true, '多选用复数')
assert.equal(model.count, 3)
assert.equal(model.reveal, false, '多选没有在资源管理器中显示')
assert.equal(model.terminal, false, '多选没有在终端中打开')
assert.equal(model.attach, true)
assert.deepEqual(menu.attachablePaths(many), ['src/a.ts', 'b.md'], '附加只取文件')
assert.equal(menu.copyTextFor(many, 'C:\\p', 'relative'), 'src/a.ts\nb.md\nsrc', '复数复制按换行拼接')
assert.equal(menu.copyTextFor(one, 'C:\\p', 'absolute'), 'C:\\p\\src\\a.ts')
assert.equal(menu.copyTextFor(one, 'C:\\p', 'name'), 'a.ts')
assert.equal(menu.filesMenuModel([{ path: 'x', name: 'x', dir: true, blocked: true }], { canAdd: true, canTerminal: true }).terminal, false, '坏链不能在终端打开')
assert.equal(menu.canOpenWithSystem('run.bat'), false, '脚本不交给系统打开')
assert.equal(menu.canOpenWithSystem('a.lnk'), false)
assert.equal(menu.canOpenWithSystem('a.png'), true)
assert.equal(menu.cdCommandFor('C:\\a b'), 'cd "C:\\a b"\r')
assert.equal(menu.cdCommandFor('/work/my dir'), 'cd "/work/my dir"\r', 'POSIX 路径同样加引号')
assert.equal(menu.cdCommandFor('/work/a\nb'), null, '含换行的目录名不注入命令')
assert.equal(menu.cdCommandFor('/work/a' + String.fromCharCode(7)), null, '含控制字符的目录名不注入命令')
assert.equal(menu.cdCommandFor('/work/a"b'), null, '含双引号的目录名不注入命令')
assert.equal(menu.cdCommandFor('/work/a$(id)'), null, '含 $ 的目录名不注入命令')
assert.equal(menu.cdCommandFor('/work/a' + String.fromCharCode(96) + 'id'), null, '含反引号的目录名不注入命令')
assert.equal(menu.cdCommandFor('/work/a%b'), null, '含百分号的目录名不注入命令')
assert.equal(menu.cdCommandFor('   '), null, '空路径不生成命令')
assert.equal(menu.attachablePaths(Array.from({ length: 150 }, (_, i) => ({ path: `f${i}`, name: `f${i}`, dir: false }))).length, 100, '附加最多 100 项')

const layout = (over) => split.filesSplitLayout({ hasPreview: true, hasFile: false, paneWidth: 900, treeShown: true, narrowTree: false, ...over })
assert.deepEqual(layout({}), { split: true, narrow: false, showTree: true, showPreview: true, treePressed: true }, '宽面板树在左预览在右')
assert.equal(layout({ treeShown: false }).showTree, false, '树可收起')
assert.equal(layout({ treeShown: false }).showPreview, true)
const narrowFile = layout({ paneWidth: 380, hasFile: true })
assert.equal(narrowFile.showTree, false, '宽度 < 400 且有预览时隐藏树列')
assert.equal(narrowFile.showPreview, true)
assert.equal(layout({ paneWidth: 380, hasFile: true, narrowTree: true }).showTree, true, '窄屏可临时切到树')
assert.equal(layout({ paneWidth: 380, hasFile: false }).showTree, true, '窄屏没打开文件时显示树')
assert.equal(split.filesSplitLayout({ hasPreview: false, hasFile: false, paneWidth: 900, treeShown: false, narrowTree: false }).showTree, true, '没有预览组件时只显示树')
assert.equal(split.clampTreeWidth(100, 900), 160, '树宽下限 160')
assert.equal(split.clampTreeWidth(900, 2000), 640, '树宽上限 640')
assert.equal(split.clampTreeWidth(500, 600), 440, '不超过面板宽 - 160')
assert.equal(split.readTreeWidth('abc'), 240, '默认 240')

const base = { ok: true, path: 'a', abs: '/p/a', name: 'a', size: 1, kind: 'text', text: 'x' }
assert.equal(issue.previewProblem(base), null)
assert.deepEqual(issue.previewProblem({ ...base, ok: false, issue: 'missing', creatable: true, error: 'x' }), { kind: 'missing', creatable: true, message: 'x' }, '缺失可创建')
assert.equal(issue.previewProblem({ ...base, ok: false, issue: 'directory' }).kind, 'directory')
assert.equal(issue.previewProblem({ ...base, ok: false }).kind, 'failed')
assert.deepEqual(issue.previewNotes({ ...base, outsideRoot: true, issue: 'encoding' }), ['outside', 'encoding'], '根外与编码提示')
assert.deepEqual(issue.previewNotes({ ...base, issue: 'too_large', truncated: true }), ['too_large'])
assert.equal(issue.previewBodyKind({ ...base, kind: 'binary', issue: 'binary', text: undefined }), 'binary')
assert.equal(issue.previewBodyKind({ ...base, kind: 'other', media: 'video', text: undefined }), 'media')
assert.equal(issue.previewBodyKind({ ...base, kind: 'image', media: 'image', text: undefined }), 'image')

const registered = (name) => ['typescript', 'ts', 'javascript', 'xml', 'json', 'bash', 'makefile', 'markdown'].includes(name)
assert.equal(language.pickLanguage('a.ts', registered), 'ts')
assert.equal(language.pickLanguage('a.mjs', registered), 'javascript')
assert.equal(language.pickLanguage('App.vue', registered), 'xml')
assert.equal(language.pickLanguage('Makefile', registered), 'makefile')
assert.equal(language.pickLanguage('notes.weird', registered), null, '未知扩展名不高亮')

const registry = new unsaved.UnsavedRegistry()
assert.equal(registry.set('e1', '/p/a.ts'), true, '新增未保存文件需要上报')
assert.equal(registry.set('e2', '/p/a.ts'), false, '同一路径被两个编辑器改动时数量不变')
assert.equal(registry.set('e1', null), false, '另一个编辑器仍未保存')
assert.deepEqual(registry.paths(), ['/p/a.ts'])
assert.equal(registry.set('e2', null), true, '全部保存后上报清空')
assert.deepEqual(registry.paths(), [])

console.log('v3 文件面板：搜索结果 / 右键菜单 / 分栏 / 预览分类 / 高亮语言 / 未保存上报 检查通过')
