import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

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
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as T from '${p('src/renderer/src/ui/Tree.tsx')}'`,
    'export { React, renderToStaticMarkup, T }'
  ].join('\n')
  const outfile = join(outdir, 'v3-tree-ui.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
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
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-tree-ui-'))
  const require = createRequire(import.meta.url)
  const bundle = require(await buildBundle(outdir))
  const { React, renderToStaticMarkup, T } = bundle
  const { createElement: h } = React

  const row = (label, kids) =>
    h(T.TreeItemContent, null, h(T.TreeChevron, null), h(T.TreeItemLabel, null, label), ...(kids ?? []))
  const leaf = (id, label, extra) =>
    h(T.TreeItem, { id, textValue: label, ...extra }, row(label))

  const LONG = '一个长到必须靠 CSS 单行省略的目录名称-'.repeat(4) + 'end.ts'

  const tree = h(
    T.Tree,
    {
      'aria-label': '源码',
      selectionMode: 'single',
      defaultExpandedKeys: ['root', 'src'],
      defaultSelectedKeys: ['index'],
      disabledKeys: ['legacy']
    },
    h(
      T.TreeItem,
      { id: 'root', textValue: '项目' },
      row('项目'),
      h(
        T.TreeItem,
        { id: 'src', textValue: 'src' },
        row('src'),
        leaf('index', 'index.ts'),
        leaf('legacy', 'legacy.ts', { isDisabled: true })
      ),
      leaf('readme', 'README.md'),
      leaf('long-name', LONG)
    )
  )

  const html = renderToStaticMarkup(tree)

  ok(html.includes('class="ui-tree"') && html.includes('role="treegrid"'), 'Tree 渲染为 role="treegrid" 的 .ui-tree 容器')
  ok(html.includes('aria-label="源码"'), '容器保留 aria-label')
  ok(!/class="ui-tree"[^>]*\brole="list"/.test(html), '不是伪造的 role="list" 列表')

  ok(html.includes('aria-level="1"') && html.includes('data-level="1"'), '第 1 层行有 aria-level / data-level=1')
  ok(html.includes('aria-level="3"') && html.includes('data-level="3"'), '嵌套第 3 层行有 aria-level / data-level=3')
  ok(html.includes('style="--tree-item-level:1"') && html.includes('style="--tree-item-level:3"'), '行保留 RAC 写入的 --tree-item-level（CSS 据其缩进）')

  ok((html.match(/aria-expanded="true"/g) ?? []).length >= 2, '已展开的父行带 aria-expanded="true"', (html.match(/aria-expanded="true"/g) ?? []).length)
  ok(html.includes('data-expanded="true"') && html.includes('data-has-child-items="true"'), '父行带 data-expanded / data-has-child-items（CSS 据此旋转箭头）')
  ok(html.includes('slot="chevron"') && html.includes('class="ui-tree__chevron"'), '展开按钮是带 slot="chevron" 的 .ui-tree__chevron')
  ok(html.includes('aria-label="Collapse"') && html.includes('aria-label="Expand"'), 'chevron 的 aria-label 由 RAC 提供（展开 / 收起）')
  ok(html.includes('data-react-aria-prevent-focus="true"') && /class="ui-tree__chevron"[^>]*tabindex="-1"/.test(html), 'chevron 被排除出 Tab 顺序（键盘用方向键）')

  ok(html.includes('aria-selected="true"') && html.includes('data-selected="true"'), '选中行带 aria-selected / data-selected')
  ok(html.includes('aria-selected="false"'), '未选中行 aria-selected="false"')
  ok(html.includes('aria-disabled="true"') && html.includes('data-disabled="true"'), '禁用行带 aria-disabled / data-disabled')
  ok(/data-key="legacy"[^>]*data-disabled="true"/.test(html) || /data-disabled="true"[^>]*data-key="legacy"/.test(html), '禁用的是指定的 legacy 行')

  ok((html.match(/class="ui-tree__label"/g) ?? []).length >= 4, '每个可见行都有 .ui-tree__label')
  ok(html.includes(LONG), '长名称完整进入 DOM（不截字符串，交给 CSS 省略）')

  const emptyHtml = renderToStaticMarkup(
    h(T.Tree, { 'aria-label': '空树', renderEmptyState: () => h(T.TreeEmptyState, null, '没有文件') })
  )
  ok(emptyHtml.includes('data-empty="true"'), '空树带 data-empty')
  ok(emptyHtml.includes('class="ui-tree__empty"') && emptyHtml.includes('没有文件'), 'renderEmptyState 渲染 TreeEmptyState 内容')

  const sectionHtml = renderToStaticMarkup(
    h(
      T.Tree,
      { 'aria-label': '分组树' },
      h(
        T.TreeSection,
        null,
        h(T.TreeHeader, null, '第一组'),
        leaf('one', 'one.txt')
      )
    )
  )
  ok(sectionHtml.includes('第一组') && sectionHtml.includes('class="ui-tree__header"'), 'TreeHeader 渲染组标题与 .ui-tree__header')
  ok(sectionHtml.includes('class="ui-tree__section"'), 'TreeSection 渲染 .ui-tree__section')

  const treeTsx = await readFile(join(process.cwd(), 'src/renderer/src/ui/Tree.tsx'), 'utf8')
  ok(treeTsx.includes("from 'react-aria-components'"), 'Tree.tsx 从 react-aria-components 引入原语')
  ok(treeTsx.includes('Tree as RACTree') && treeTsx.includes('TreeItem as RACTreeItem'), 'Tree.tsx 包装 RAC 的 Tree / TreeItem')
  ok(treeTsx.includes('composeRenderProps'), 'Tree.tsx 用 composeRenderProps 合并调用方 className')
  ok(!/styles\/|components\/ui|\.ui-btn|\.ui-list-row/.test(treeTsx), 'Tree.tsx 不依赖 v2 样式或旧控件')
  ok(treeTsx.includes('export function TreeChevron') && treeTsx.includes('slot="chevron"'), 'TreeChevron 通过 RAC 的 slot="chevron" 接入展开语义')
  ok(!/import\s+['"]\.\/Tree\.css['"]/.test(treeTsx), 'Tree.tsx 不自行 import CSS（样式经聚合入口加载）')

  const treeCss = await readFile(join(process.cwd(), 'src/renderer/src/ui/Tree.css'), 'utf8')
  const treeCode = treeCss.replace(/\/\*[\s\S]*?\*\//g, '')
  ok(treeCode.includes('@layer primitives'), 'Tree.css 落在 @layer primitives')
  ok(!treeCode.includes('@import'), 'Tree.css 不 @import 其它文件')
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(treeCode), 'Tree.css 不写死颜色（只用令牌变量）')
  ok(treeCode.includes('var(--d-row)') && treeCode.includes('var(--tree-item-level'), 'Tree.css 用密度令牌 --d-row 与层级变量缩进')
  ok(treeCode.includes('text-overflow: ellipsis') && treeCode.includes('@media (prefers-reduced-motion: reduce)'), 'Tree.css 处理长名称截断与减少动态效果')
  ok(/\.ui-tree__item\[data-focus-visible\][\s\S]*outline:\s*2px solid var\(--accent\)/.test(treeCode), 'Tree.css 自带与 ui.css 同值的焦点环')
  ok(!/styles\/|ui-list-row|ui-btn/.test(treeCode), 'Tree.css 不复用 v2 类名')

  const story = await readFile(join(process.cwd(), 'src/renderer/src/ui/Tree.stories.tsx'), 'utf8')
  for (const name of ['层级', '展开', '禁用', '空态', '长名称']) {
    ok(story.includes(name), `故事覆盖「${name}」`)
  }
  ok(story.includes("import './Tree.css'"), '故事显式加载 Tree.css（Storybook 自足）')
  ok(story.includes('Tree') && story.includes('TreeItem'), '故事用真实的 Tree / TreeItem 原语')

  console.log(`\nv3 Tree 原语回归：${checks} 项通过`)
  await rm(outdir, { recursive: true, force: true })
}

await main()
