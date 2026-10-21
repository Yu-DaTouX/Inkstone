import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(root, 'src/renderer/src/ui')
const workDir = join(root, '.tmp/p3-table-check')

const count = (html, needle) => html.split(needle).length - 1

async function loadPureModel() {
  const result = await build({
    entryPoints: [join(uiDir, 'table-model.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  const dataUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  return import(dataUrl)
}

async function loadSsrModule() {
  const entry = [
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { TableLayout, Rect } from 'react-aria-components'",
    "import { Table, TableHeader, Column, TableBody, Row, Cell, TableEmptyState } from './Table'",
    '',
    '// 无视口时只把宽度补成声明宽度，保证表头列出全；高度仍为 0，数据行不进 DOM。',
    'class HeaderLayout extends TableLayout {',
    '  getVisibleLayoutInfos(rect) {',
    '    if (!(rect.width > 1)) rect = new Rect(rect.x, rect.y, 320, rect.height)',
    '    return super.getVisibleLayoutInfos(rect)',
    '  }',
    '}',
    '// 无视口时补出高度，驱动 RAC 真实行渲染以核对数据行 aria-rowindex。',
    'class DeterministicLayout extends TableLayout {',
    '  getVisibleLayoutInfos(rect) {',
    '    if (!(rect.height > 1)) rect = new Rect(rect.x, rect.y, Math.max(rect.width, 320), 100000)',
    '    return super.getVisibleLayoutInfos(rect)',
    '  }',
    '}',
    '',
    'const COLUMNS = [',
    "  { id: 'name', label: '名称', width: 200 },",
    "  { id: 'size', label: '大小', width: 100 }",
    ']',
    'const header = (',
    '  <TableHeader>',
    '    {COLUMNS.map((column) => (',
    '      <Column key={column.id} id={column.id} width={column.width} allowsSorting isRowHeader={column.id === "name"}>',
    '        {column.label}',
    '      </Column>',
    '    ))}',
    '  </TableHeader>',
    ')',
    'const longRows = Array.from({ length: 1000 }, (_, index) => ({ id: "long-" + index, name: "行 " + index, size: index }))',
    'const smallRows = Array.from({ length: 6 }, (_, index) => ({ id: "r" + index, name: "行 " + index, size: index }))',
    'const plainRows = smallRows.slice(0, 3)',
    'const body = (rows) => (',
    '  <TableBody items={rows}>',
    '    {(row) => (',
    '      <Row id={row.id}>',
    '        <Cell>{row.name}</Cell>',
    '        <Cell>{row.size}</Cell>',
    '      </Row>',
    '    )}',
    '  </TableBody>',
    ')',
    '',
    'export const longVirtualized = renderToStaticMarkup(',
    '  <Table aria-label="长表" isVirtualized layout={HeaderLayout} layoutOptions={{ rowHeight: 32 }} style={{ width: 300, height: 400 }}>',
    '    {header}',
    '    {body(longRows)}',
    '  </Table>',
    ')',
    '',
    'export const forcedRows = renderToStaticMarkup(',
    '  <Table aria-label="强制窗口" isVirtualized layout={DeterministicLayout} layoutOptions={{ rowHeight: 32 }} style={{ width: 300, height: 400 }}>',
    '    {header}',
    '    {body(smallRows)}',
    '  </Table>',
    ')',
    '',
    'export const plain = renderToStaticMarkup(',
    '  <Table aria-label="普通表" selectionMode="multiple" selectedKeys={["r0", "r2"]} onSelectionChange={() => {}} disabledKeys={["r1"]} sortDescriptor={{ column: "name", direction: "ascending" }} onSortChange={() => {}}>',
    '    {header}',
    '    {body(plainRows)}',
    '  </Table>',
    ')',
    '',
    'export const empty = renderToStaticMarkup(',
    '  <Table aria-label="空表" isVirtualized layout={DeterministicLayout} layoutOptions={{ rowHeight: 32 }} style={{ width: 300, height: 400 }}>',
    '    {header}',
    '    <TableBody items={[]} renderEmptyState={() => <TableEmptyState>暂无数据</TableEmptyState>}>{() => null}</TableBody>',
    '  </Table>',
    ')',
    '',
    'export const loading = renderToStaticMarkup(',
    '  <Table aria-label="加载表" style={{ width: 300 }}>',
    '    {header}',
    '    <TableBody items={[]} isLoading>{() => null}</TableBody>',
    '  </Table>',
    ')'
  ].join('\n')

  const result = await build({
    stdin: { contents: entry, resolveDir: uiDir, loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server', 'react-aria-components'],
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' }
  })
  await mkdir(workDir, { recursive: true })
  const outfile = join(workDir, 'ssr.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  return import(pathToFileURL(outfile).href)
}

try {
  const model = await loadPureModel()
  const { sortRows, compareTableValues } = model

  const rows = [
    { id: 'a', group: 2, name: 'b' },
    { id: 'b', group: 1, name: 'a' },
    { id: 'c', group: 2, name: 'a' },
    { id: 'd', group: 1, name: 'b' },
    { id: 'e', group: 2, name: 'a' }
  ]
  assert.deepEqual(
    sortRows(rows, { column: 'group', direction: 'ascending' }).map((row) => row.id),
    ['b', 'd', 'a', 'c', 'e'],
    '升序同组保持原顺序'
  )
  assert.deepEqual(
    sortRows(rows, { column: 'group', direction: 'descending' }).map((row) => row.id),
    ['a', 'c', 'e', 'b', 'd'],
    '降序同组仍保持原顺序'
  )
  assert.deepEqual(
    sortRows(rows, { column: 'name', direction: 'ascending' }, (row) => row.name).map((row) => row.id),
    ['b', 'c', 'e', 'a', 'd'],
    '自定义取值函数参与排序'
  )

  const withEmpty = [
    { id: 'x', value: 1 },
    { id: 'y', value: null },
    { id: 'z', value: 0 },
    { id: 'w', value: undefined }
  ]
  assert.deepEqual(
    sortRows(withEmpty, { column: 'value', direction: 'ascending' }).map((row) => row.id),
    ['z', 'x', 'y', 'w'],
    '空值升序排在后面'
  )
  assert.deepEqual(
    sortRows(withEmpty, { column: 'value', direction: 'descending' }).map((row) => row.id),
    ['y', 'w', 'x', 'z'],
    '空值降序排在前面'
  )
  assert.equal(compareTableValues(1, 2), -1)
  assert.equal(compareTableValues('b', 'a'), 1)
  assert.equal(compareTableValues(null, 5), 1)
  assert.equal(compareTableValues(undefined, null), 0)
  assert.equal(compareTableValues('', 'a'), 1)

  const ssr = await loadSsrModule()

  assert.match(ssr.longVirtualized, /class="[^"]*ui-table/)
  assert.match(ssr.longVirtualized, /role="grid"/)
  assert.match(ssr.longVirtualized, /aria-rowcount="1001"/)
  assert.match(ssr.longVirtualized, /aria-colcount="2"/)
  assert.match(ssr.longVirtualized, /aria-rowindex="1"/)
  assert.equal(count(ssr.longVirtualized, 'aria-colindex="1"'), 1, '表头第一列列号')
  assert.equal(count(ssr.longVirtualized, 'aria-colindex="2"'), 1, '表头第二列列号')
  assert.equal(count(ssr.longVirtualized, 'role="row"'), 1, '无视口时数据行不进 DOM，只有表头行')
  assert.ok(!ssr.longVirtualized.includes('行 999'), '1000 行不整表渲染')
  assert.match(ssr.longVirtualized, /width:200px/, '表头第一列按声明的 200px 布局')
  assert.match(ssr.longVirtualized, /left:200px;width:100px/, '表头第二列紧接第一列对齐')
  assert.match(ssr.longVirtualized, /class="[^"]*ui-table__column/)

  assert.match(ssr.forcedRows, /aria-rowcount="7"/)
  for (const index of [2, 3, 4, 5, 6, 7]) {
    assert.ok(ssr.forcedRows.includes(`aria-rowindex="${index}"`), `数据行 aria-rowindex=${index}`)
  }
  assert.equal(count(ssr.forcedRows, 'aria-colindex="1"'), 7, '表头加六行第一列')
  assert.equal(count(ssr.forcedRows, 'aria-colindex="2"'), 7, '表头加六行第二列')
  assert.equal(count(ssr.forcedRows, 'left:200px;width:100px'), 7, '表头与六行的第二列都对齐到 left:200px/width:100px')
  assert.equal(count(ssr.forcedRows, 'width:200px'), 7, '每行第一列 200px')

  assert.equal(count(ssr.plain, '<th '), 2, '表头两列')
  assert.equal(count(ssr.plain, '<td '), 6, '三行各两列')
  assert.equal(count(ssr.plain, 'aria-selected="true"'), 2)
  assert.equal(count(ssr.plain, 'aria-selected="false"'), 1)
  assert.ok(count(ssr.plain, 'aria-disabled="true"') >= 1, '禁用行带 aria-disabled')
  assert.ok(count(ssr.plain, 'data-disabled') >= 1, '禁用行带 data-disabled')
  assert.match(ssr.plain, /aria-sort="ascending"/)
  assert.match(ssr.plain, /data-key="r0"/)
  assert.match(ssr.plain, /data-key="r2"/)
  assert.match(ssr.plain, /class="[^"]*ui-table__row/)

  assert.match(ssr.empty, /data-empty/)
  assert.match(ssr.empty, /暂无数据/)
  assert.match(ssr.empty, /class="[^"]*ui-table__empty/)
  assert.match(ssr.empty, /aria-rowcount="1"/)
  assert.match(ssr.loading, /class="[^"]*ui-table__loading/)
  assert.match(ssr.loading, /role="status"/)
  assert.match(ssr.loading, /aria-busy="true"/)
  assert.match(ssr.loading, /正在加载/)

  console.log('v3 Table 原语：纯模型（排序稳定性、空值、窗口边界）与 SSR（rowcount/rowindex/colindex、列宽对齐、空/加载/选中/禁用）检查通过')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
