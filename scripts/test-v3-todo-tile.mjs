#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, label + (detail === undefined ? '' : `  ← 实际: ${JSON.stringify(detail)}`))
  checks++
  console.log(`✓ ${label}`)
}

function abs(rel) {
  return normalize(resolve(ROOT, rel))
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
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as Model from '${posix(abs('src/renderer/src/features/todos/todo-tile-model.ts'))}'`,
    `import * as View from '${posix(abs('src/renderer/src/features/todos/TodoTileView.tsx'))}'`,
    'export { React, renderToStaticMarkup, Model, View }'
  ].join('\n')
  const outfile = join(outdir, 'v3-todo-tile.bundle.cjs')
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

const todo = (text, over = {}) => ({ text, done: false, ...over })
const kinds = (model) => model.rows.map((row) => row.kind)

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-todo-tile-'))
  const require = createRequire(import.meta.url)
  const bundle = require(await buildBundle(outdir))
  const { React, renderToStaticMarkup, Model, View } = bundle
  const { createElement } = React

  const render = (props) =>
    renderToStaticMarkup(
      createElement(View.TodoTileView, {
        todos: [],
        agentRunning: false,
        sessionId: 's1',
        foldMap: {},
        onToggleFold: () => {},
        lang: 'zh-CN',
        ...props
      })
    )

  const empty = Model.buildTodoTileModel([], true)
  ok(!Model.hasTodoTileContent([]), '空清单 hasTodoTileContent=false（整块不渲染）')
  ok(empty.total === 0 && empty.done === 0 && empty.rows.length === 0 && empty.activeIndex === -1, '空清单模型全为零、没有进行中', empty)

  const partial = Model.buildTodoTileModel(
    [todo('a', { done: true }), todo('b'), todo('c')],
    false
  )
  ok(partial.total === 3 && partial.done === 1, '部分完成：完成数/总数正确', { done: partial.done, total: partial.total })
  ok(JSON.stringify(kinds(partial)) === JSON.stringify(['done', 'pending', 'pending']), '无 status 且回合未跑：没人被猜成进行中', kinds(partial))
  ok(partial.activeIndex === -1, '回合未跑时 activeIndex=-1（不猜永远在转的项）', partial.activeIndex)

  const runningInferred = Model.buildTodoTileModel([todo('a', { done: true }), todo('b'), todo('c')], true)
  ok(runningInferred.activeIndex === 1 && kinds(runningInferred)[1] === 'running', '无 status 但回合在跑：第一个未完成算进行中', { activeIndex: runningInferred.activeIndex, kinds: kinds(runningInferred) })

  const explicit = Model.buildTodoTileModel(
    [todo('a', { done: true, status: 'done' }), todo('b', { status: 'running' }), todo('c', { status: 'blocked' }), todo('d', { status: 'pending' })],
    false
  )
  ok(JSON.stringify(kinds(explicit)) === JSON.stringify(['done', 'running', 'blocked', 'pending']), '有 status 时逐行按显式状态', kinds(explicit))
  ok(explicit.activeIndex === 1, '有 running 时 activeIndex 指向它，即使回合标记为未跑', explicit.activeIndex)

  const explicitNoRunning = Model.buildTodoTileModel([todo('a', { status: 'pending' }), todo('b', { status: 'blocked' })], true)
  ok(explicitNoRunning.activeIndex === -1, '有 status 但无 running：不退回推断（不把 pending 当进行中）', explicitNoRunning.activeIndex)

  const allDone = Model.buildTodoTileModel([todo('a', { done: true }), todo('b', { status: 'done' })], true)
  ok(allDone.done === 2 && allDone.total === 2 && allDone.activeIndex === -1, '全部完成：done=total 且无进行中', allDone)

  const long = Model.buildTodoTileModel(
    Array.from({ length: 250 }, (_, i) => todo(`t${i}`, { done: i % 2 === 0 })),
    false
  )
  ok(long.total === 250 && long.rows.length === 250 && long.done === 125, '超长列表：总数与完成数如实，逐行不丢', { total: long.total, done: long.done, rows: long.rows.length })

  const f0 = {}
  const f1 = Model.toggleTodoTileFold(f0, 'session-a')
  ok(f0['session-a'] === undefined, '切换折叠不修改传入的映射（纯函数）')
  ok(Model.isTodoTileFolded(f1, 'session-a') === true && Model.isTodoTileFolded(f1, 'session-b') === false, '折叠按会话 id 隔离', f1)
  const f2 = Model.toggleTodoTileFold(f1, 'session-a')
  ok(Model.isTodoTileFolded(f2, 'session-a') === false, '再次切换恢复展开')
  ok(Model.toggleTodoTileFold(f0, '') === f0, '空会话 id 不落折叠键（避免会话串状态）')

  const emptyHtml = render({ todos: [] })
  ok(emptyHtml === '', '无待办时生产版面件输出为空字符串（不占高度、无标题、无空态）', emptyHtml)

  const partialHtml = render({ todos: [todo('写模型'), todo('做磁贴', { done: true }), todo('跑测试')] })
  ok(partialHtml.includes('data-testid="v3-todo"'), '有待办时报文根部渲染')
  ok(partialHtml.includes('>1/3<'), '标题行显示 已完成/总数', partialHtml.match(/>\d+\/\d+</g))
  ok(partialHtml.includes('data-testid="v3-todo-toggle"') && partialHtml.includes('aria-expanded="true"'), '折叠开关是带 aria-expanded 的按钮，默认展开')
  ok(partialHtml.includes('data-testid="v3-todo-scroll"'), '展开时有内部滚动容器')
  ok((partialHtml.match(/data-testid="v3-todo-row"/g) ?? []).length === 3, '逐行渲染清单')
  ok(partialHtml.includes('data-kind="done"') && partialHtml.includes('lucide-check'), '完成项打勾')
  ok(!partialHtml.includes('ui-spinner'), '没有 status 且回合未跑：不画进行中')

  const runningHtml = render({ todos: [todo('跑起来'), todo('收尾')], agentRunning: true })
  ok(runningHtml.includes('data-kind="running"') && runningHtml.includes('ui-spinner') && runningHtml.includes('aria-label="正在进行"'), '无 status 且回合在跑：进行中项有明确标识（ui Spinner + 读屏名）')

  const runningStatusHtml = render({ todos: [todo('甲乙', { status: 'running' }), todo('丙', { status: 'pending' })], agentRunning: false })
  ok(runningStatusHtml.includes('data-kind="running"') && runningStatusHtml.includes('ui-spinner'), '有显式 running 时即使回合未标记也显示进行中')

  const blockedHtml = render({ todos: [todo('受阻项', { status: 'blocked' }), todo('普通项')] })
  ok(blockedHtml.includes('data-kind="blocked"') && blockedHtml.includes('lucide-circle-alert') && blockedHtml.includes('受阻'), 'blocked 行有图标与文字，可与待办区分')

  const foldedHtml = render({ todos: [todo('a'), todo('b')], sessionId: 'session-a', foldMap: { 'session-a': true } })
  ok(foldedHtml.includes('data-folded="1"') && !foldedHtml.includes('data-testid="v3-todo-scroll"') && !foldedHtml.includes('data-testid="v3-todo-row"'), '折叠后只剩标题行，清单不渲染')
  ok(foldedHtml.includes('>0/2<'), '折叠时计数仍在标题行')

  const otherSessionHtml = render({ todos: [todo('a'), todo('b')], sessionId: 'session-b', foldMap: { 'session-a': true } })
  ok(otherSessionHtml.includes('data-folded="0"') && otherSessionHtml.includes('data-testid="v3-todo-scroll"'), '折叠按会话：另一条会话不受影响，仍展开')

  const longHtml = render({ todos: Array.from({ length: 250 }, (_, i) => todo(`任务 ${i}`, { done: i % 2 === 0 })) })
  ok((longHtml.match(/data-testid="v3-todo-row"/g) ?? []).length === 250, '超长列表 250 行全部在滚动容器内渲染', (longHtml.match(/data-testid="v3-todo-row"/g) ?? []).length)
  ok(longHtml.includes('>125/250<'), '超长列表计数正确')

  const enHtml = render({ todos: [todo('blocked', { status: 'blocked' })], lang: 'en-US' })
  ok(enHtml.includes('Todos') && enHtml.includes('Blocked'), '英文语言走自有常量', { en: enHtml.includes('Todos'), blocked: enHtml.includes('Blocked') })

  const sidebar = await readFile(join(ROOT, 'src/renderer/src/features/sidebar/Sidebar.tsx'), 'utf8')
  ok(!sidebar.includes('TodoTile'), '待办磁贴已不在左侧栏')
  const panel = await readFile(join(ROOT, 'src/renderer/src/features/workbench/WorkbenchPanel.tsx'), 'utf8')
  const overview = await readFile(join(ROOT, 'src/renderer/src/features/workbench/OverviewPane.tsx'), 'utf8')
  ok(!panel.includes('<TodoTile />'), '待办不再固定在页签栏下方')
  ok(overview.includes("import { TodoTileRows, todoTileText } from '../todos/TodoTileView'") && overview.includes('useStore((s) => s.todos)'), '概览的待办磁贴复用 TodoTileRows，数据来自 store.todos')
  ok(!panel.includes('v3-todo-overlay') && !panel.includes('createPortal') && !overview.includes('createPortal'), '不另开浮层')

  const container = await readFile(join(ROOT, 'src/renderer/src/features/todos/TodoTile.tsx'), 'utf8')
  ok(container.includes('useStore((s) => s.todos)'), '容器只消费 store.todos')
  ok(!/components\/toolbar|TodoSection|subagents|subagent/i.test(container), '容器不引 v2 任务组件，也不掺子代理')
  ok(container.includes('s.peekedSessionId ?? s.session?.sessionId'), '折叠键优先用已铺上的会话身份')
  ok(container.includes('useState<TodoTileFolds>({})') && !container.includes('localStorage') && !container.includes('patchSettings'), '折叠状态只在内存，不写设置')

  const view = await readFile(join(ROOT, 'src/renderer/src/features/todos/TodoTileView.tsx'), 'utf8')
  ok(view.includes("import { Spinner } from '../../ui'"), '进行中标记来自 ui/ 原语')
  ok(view.includes("from 'lucide-react'"), '勾 / 受阻图标来自 lucide（并非自绘控件外观）')

  const css = await readFile(join(ROOT, 'src/renderer/src/features/todos/todo-tile.css'), 'utf8')
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  ok(cssCode.includes('@layer features'), '专属 CSS 落在 features 层')
  ok(cssCode.includes('max-height: 152px') && cssCode.includes('overflow-y: auto'), '高度有上限，超出在磁贴内部滚动')
  ok(!cssCode.includes('@import') && !cssCode.includes('.rp-') && !/styles\/|chat\.css/.test(cssCode), 'CSS 只做版面，不引 v2 样式、不回写 v2 类名')

  const pushConsumers = await readFile(join(ROOT, 'src/renderer/src/state/push-consumers.ts'), 'utf8')
  ok(pushConsumers.includes("case 'todos':") && pushConsumers.includes('set({ todos: m.payload })'), 'store.todos 只由 todos 推送套用')
  const routing = await readFile(join(ROOT, 'src/renderer/src/state/push-routing.ts'), 'utf8')
  ok(routing.includes('viewingSessionId') && routing.includes('belongsToView'), '后台会话的待办只进 sessionRuntimes，不覆盖当前视图')
  const sideBySide = await readFile(join(ROOT, 'src/renderer/src/app/SideBySide.tsx'), 'utf8')
  ok(sideBySide.includes('void store.switchSession(target.path)'), '并排切焦点列走正式 switchSession（随之重投影 store.todos）')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3-todo-tile: ${checks} checks passed`)
}

await main()
