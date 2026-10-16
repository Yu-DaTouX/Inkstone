#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = join(ROOT, 'src/renderer/src/ui')

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const count = (text, needle) => text.split(needle).length - 1
const read = (rel) => readFile(join(ROOT, rel), 'utf8')

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible'
  }
}

async function buildBundle(outdir) {
  const p = (rel) => join(ROOT, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as UI from '${p('src/renderer/src/ui/index.ts')}'`,
    'export { React, renderToStaticMarkup, UI }'
  ].join('\n')
  const outfile = join(outdir, 'v3-ui-exports.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

async function main() {

  const indexSource = await read('src/renderer/src/ui/index.ts')
  for (const module of ['./Slider', './Tree', './Table', './table-model', './Splitter']) {
    ok(indexSource.includes(`from '${module}'`), `ui/index.ts 转出 ${module} 的导出`)
  }
  for (const name of [
    'Slider',
    'Tree',
    'TreeItem',
    'TreeItemContent',
    'TreeChevron',
    'TreeItemLabel',
    'TreeSection',
    'TreeHeader',
    'TreeEmptyState',
    'Table',
    'TableHeader',
    'Column',
    'TableBody',
    'Row',
    'Cell',
    'TableFooter',
    'TableEmptyState',
    'TableLoadingState',
    'Splitter',
    'sortRows'
  ]) {
    ok(new RegExp(`\\b${name}\\b`).test(indexSource), `ui/index.ts 导出 ${name}`)
  }

  const uiCss = await read('src/renderer/src/ui/ui.css')
  ok(count(uiCss, "@import './Slider.css';") === 1, 'ui.css 只挂载一次 Slider.css')
  ok(count(uiCss, "@import './Tree.css';") === 1, 'ui.css 只挂载一次 Tree.css')
  ok(count(uiCss, "@import './Table.css';") === 0, 'ui.css 不重复挂载 Table.css（组件自带）')
  ok(count(uiCss, "@import './Splitter.css';") === 0, 'ui.css 不重复挂载 Splitter.css（组件自带）')
  ok(
    uiCss.includes('@layer reset, tokens, base, primitives, patterns, features, utilities;'),
    'ui.css 保持既有 layer 顺序声明'
  )
  ok(!/from\s+['"][^'"]*features\//.test(indexSource), 'index.ts 不把 features 模块混进原语出口')

  const tableTsx = await read('src/renderer/src/ui/Table.tsx')
  const splitterTsx = await read('src/renderer/src/ui/Splitter.tsx')
  const sliderTsx = await read('src/renderer/src/ui/Slider.tsx')
  const treeTsx = await read('src/renderer/src/ui/Tree.tsx')
  ok(tableTsx.includes("import './Table.css'"), 'Table.tsx 自带 import Table.css')
  ok(splitterTsx.includes("import './Splitter.css'"), 'Splitter.tsx 自带 import Splitter.css')
  ok(!sliderTsx.includes("import './Slider.css'"), 'Slider.tsx 不自带 CSS（由 ui.css 聚合）')
  ok(!treeTsx.includes("import './Tree.css'"), 'Tree.tsx 不自带 CSS（由 ui.css 聚合）')

  for (const file of ['Slider.css', 'Tree.css', 'Table.css', 'Splitter.css']) {
    const css = await read(`src/renderer/src/ui/${file}`)
    ok(css.includes('@layer primitives'), `${file} 规则落在 primitives 层`)
    ok(!/features\//.test(css), `${file} 不引用 features 样式`)
  }

  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-ui-exports-'))
  try {
    const require = createRequire(import.meta.url)
    const bundle = require(await buildBundle(outdir))
    const { React, renderToStaticMarkup, UI } = bundle
    const h = React.createElement

    for (const name of ['Slider', 'Tree', 'Table', 'Splitter', 'sortRows']) {
      ok(UI[name] !== undefined, `从 ui/index.ts 能导入 ${name}`)
    }
    ok(typeof UI.sortRows === 'function', 'sortRows 是可调用的纯函数')

    const sliderHtml = renderToStaticMarkup(h(UI.Slider, { label: '阈值', defaultValue: 40, showValue: true }))
    ok(sliderHtml.includes('ui-slider'), '经 index 渲染 Slider 得到 .ui-slider')

    const treeHtml = renderToStaticMarkup(
      h(
        UI.Tree,
        { 'aria-label': '出口检查' },
        h(
          UI.TreeItem,
          { id: 'a', textValue: 'a' },
          h(UI.TreeItemContent, null, h(UI.TreeChevron, null), h(UI.TreeItemLabel, null, 'a'))
        )
      )
    )
    ok(treeHtml.includes('ui-tree'), '经 index 渲染 Tree 得到 .ui-tree')

    const tableHtml = renderToStaticMarkup(
      h(
        UI.Table,
        { 'aria-label': '出口检查' },
        h(UI.TableHeader, null, h(UI.Column, { id: 'name' }, '名称')),
        h(
          UI.TableBody,
          { items: [], renderEmptyState: () => h(UI.TableEmptyState, null, '暂无数据') },
          () => null
        )
      )
    )
    ok(tableHtml.includes('ui-table'), '经 index 渲染 Table 得到 .ui-table')

    const splitterHtml = renderToStaticMarkup(
      h(UI.Splitter, { 'aria-label': '出口检查', value: 100, min: 0, max: 300, onChange: () => undefined })
    )
    ok(splitterHtml.includes('ui-splitter'), '经 index 渲染 Splitter 得到 .ui-splitter')

    console.log(`\nv3 原语正式出口/样式装配检查：${checks} 项通过`)
    console.log('边界：本检查不运行 Storybook、不做交互/a11y/视觉验证；外观以真实运行结果为准。')
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

await main()
