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

  const render = ({ todos = [], agentRunning = false, lang = 'zh-CN' }) =>
    renderToStaticMarkup(
      createElement(View.TodoTileRows, { model: Model.buildTodoTileModel(todos, agentRunning), text: View.todoTileText(lang) })
    )

  const empty = Model.buildTodoTileModel([], true)
  ok(!Model.hasTodoTileContent([]), '空清单 hasTodoTileContent=false（计划卡不渲染）')
  ok(empty.total === 0 && empty.done === 0 && empty.rows.length === 0 && empty.activeIndex === -1, '空清单模型全为零、没有进行中', empty)
  ok(Model.activeTodoRow(empty) === undefined, '空清单没有当前项')

  const partial = Model.buildTodoTileModel(
    [todo('a', { done: true }), todo('b'), todo('c')],
    false
  )
  ok(partial.total === 3 && partial.done === 1, '部分完成：完成数/总数正确', { done: partial.done, total: partial.total })
  ok(JSON.stringify(kinds(partial)) === JSON.stringify(['done', 'pending', 'pending']), '无 status 且回合未跑：没人被猜成进行中', kinds(partial))
  ok(partial.activeIndex === -1, '回合未跑时 activeIndex=-1（不猜永远在转的项）', partial.activeIndex)
  ok(Model.activeTodoRow(partial) === undefined, '没有进行中项时 activeTodoRow 为空')

  const runningInferred = Model.buildTodoTileModel([todo('a', { done: true }), todo('b'), todo('c')], true)
  ok(runningInferred.activeIndex === 1 && kinds(runningInferred)[1] === 'running', '无 status 但回合在跑：第一个未完成算进行中', { activeIndex: runningInferred.activeIndex, kinds: kinds(runningInferred) })
  ok(Model.activeTodoRow(runningInferred)?.text === 'b', 'activeTodoRow 取到当前项文字')

  const explicit = Model.buildTodoTileModel(
    [todo('a', { done: true, status: 'done' }), todo('b', { status: 'running' }), todo('c', { status: 'blocked' }), todo('d', { status: 'pending' })],
    false
  )
  ok(JSON.stringify(kinds(explicit)) === JSON.stringify(['done', 'running', 'blocked', 'pending']), '有 status 时逐行按显式状态', kinds(explicit))
  ok(explicit.activeIndex === 1, '有 running 时 activeIndex 指向它，即使回合标记为未跑', explicit.activeIndex)

  const parallel = Model.buildTodoTileModel(
    [todo('a', { status: 'running' }), todo('b', { status: 'done' }), todo('c', { status: 'running' }), todo('d', { status: 'done' })],
    true
  )
  ok(JSON.stringify(kinds(parallel)) === JSON.stringify(['running', 'done', 'running', 'done']), '并行进度：保留多项进行中和非连续完成位置', kinds(parallel))
  ok(parallel.done === 2 && parallel.total === 4, '非连续完成项按实际状态计数', parallel)

  const explicitNoRunning = Model.buildTodoTileModel([todo('a', { status: 'pending' }), todo('b', { status: 'blocked' })], true)
  ok(explicitNoRunning.activeIndex === -1, '有 status 但无 running：不退回推断（不把 pending 当进行中）', explicitNoRunning.activeIndex)

  const allDone = Model.buildTodoTileModel([todo('a', { done: true }), todo('b', { status: 'done' })], true)
  ok(allDone.done === 2 && allDone.total === 2 && allDone.activeIndex === -1, '全部完成：done=total 且无进行中', allDone)

  ok(Model.anchorTodoIndex(runningInferred) === 1, '展开时对准进行中项', Model.anchorTodoIndex(runningInferred))
  ok(Model.anchorTodoIndex(partial) === 1, '没有进行中项时对准第一个未完成项', Model.anchorTodoIndex(partial))
  ok(Model.anchorTodoIndex(explicitNoRunning) === 0, '有 status 无 running 时对准第一个未完成项（受阻也算未完成）', Model.anchorTodoIndex(explicitNoRunning))
  ok(Model.anchorTodoIndex(allDone) === -1 && Model.anchorTodoIndex(empty) === -1, '全部完成或空清单没有对准目标')

  const long = Model.buildTodoTileModel(
    Array.from({ length: 250 }, (_, i) => todo(`t${i}`, { done: i % 2 === 0 })),
    false
  )
  ok(long.total === 250 && long.rows.length === 250 && long.done === 125, '超长列表：完整清单与统计不丢、不做窗口截断（卡内滚动代替截断）', { total: long.total, done: long.done, rows: long.rows.length })

  const emptyHtml = render({ todos: [] })
  ok(!emptyHtml.includes('data-testid="v3-todo-row"'), '无待办时没有任何清单行', emptyHtml)

  const partialHtml = render({ todos: [todo('写模型'), todo('做磁贴', { done: true }), todo('跑测试')] })
  ok((partialHtml.match(/data-testid="v3-todo-row"/g) ?? []).length === 3, '逐行渲染清单')
  ok(partialHtml.includes('data-kind="done"') && partialHtml.includes('lucide-circle-check'), '完成项打勾（实心圆勾）')
  ok(!partialHtml.includes('text-decoration'), '完成项不加删除线')
  ok(!partialHtml.includes('data-kind="running"'), '没有 status 且回合未跑：不画进行中')

  const runningHtml = render({ todos: [todo('跑起来'), todo('收尾')], agentRunning: true })
  ok(
    runningHtml.includes('data-kind="running"') && runningHtml.includes('lucide-circle-ellipsis') && runningHtml.includes('aria-label="进行中"'),
    '无 status 且回合在跑：进行中项画省略号圆，并带读屏名'
  )

  const runningStatusHtml = render({ todos: [todo('甲乙', { status: 'running' }), todo('丙', { status: 'pending' })], agentRunning: false })
  ok(
    runningStatusHtml.includes('data-kind="running"') && runningStatusHtml.includes('lucide-circle-ellipsis'),
    '有显式 running 时即使回合未标记也显示进行中'
  )
  ok(runningStatusHtml.includes('data-kind="pending"') && runningStatusHtml.includes('lucide-circle-dashed'), '待做项画虚线圆')

  const blockedHtml = render({ todos: [todo('受阻项', { status: 'blocked' }), todo('普通项')] })
  ok(blockedHtml.includes('data-kind="blocked"') && blockedHtml.includes('lucide-circle-alert') && blockedHtml.includes('受阻'), 'blocked 行有警示色图标，可与待办区分')

  const enHtml = render({ todos: [todo('blocked', { status: 'blocked' })], lang: 'en-US' })
  ok(enHtml.includes('Blocked'), '英文语言走自有常量', { blocked: enHtml.includes('Blocked') })

  const sidebar = await readFile(join(ROOT, 'src/renderer/src/features/sidebar/Sidebar.tsx'), 'utf8')
  ok(!sidebar.includes('TodoTile'), '待办磁贴已不在左侧栏')
  const panel = await readFile(join(ROOT, 'src/renderer/src/features/workbench/RightPanelT3.tsx'), 'utf8')
  ok(!panel.includes('<TodoTile />'), '待办不再固定在右栏标签条下方')

  const overview = await readFile(join(ROOT, 'src/renderer/src/features/workbench/OverviewPane.tsx'), 'utf8')
  ok(!overview.includes('todo-tile-model') && !overview.includes('TodoTileView'), '总览已不再引用待办模型/视图')
  ok(!/progress:\s*{/.test(overview), '总览的「进度」分区已删除')

  const railSections = await readFile(join(ROOT, 'src/renderer/src/features/workbench/rail-sections.ts'), 'utf8')
  ok(!railSections.includes("'progress'"), 'rail 分区列表不再含 progress')
  const railTextSrc = await readFile(join(ROOT, 'src/renderer/src/features/workbench/rail-text.ts'), 'utf8')
  ok(!railTextSrc.includes('progress'), 'rail 文案不再含 progress 字段')

  const composer = await readFile(join(ROOT, 'src/renderer/src/features/composer/Composer.tsx'), 'utf8')
  ok(composer.includes("import { PlanCard } from './PlanCard'"), 'Composer 引入计划卡')
  const planIdx = composer.indexOf('<PlanCard')
  const queueIdx = composer.indexOf('<QueueEditor')
  const cardIdx = composer.indexOf('<div className="composer">')
  const borderIdx = composer.indexOf('<ComposerBorder')
  const attachIdx = composer.indexOf('<AttachmentStrip')
  ok(
    planIdx >= 0 && cardIdx < borderIdx && borderIdx < planIdx && planIdx < queueIdx && queueIdx < attachIdx,
    '计划卡挂在输入框卡片内顶边之后，排队行紧随其后，都在附件条之前（和输入框连成一体，不再是框外独立卡片）'
  )

  const planCard = await readFile(join(ROOT, 'src/renderer/src/features/composer/PlanCard.tsx'), 'utf8')
  ok(planCard.includes("s.todos") && !planCard.includes('peekedSessionId'), '计划卡只读当前会话的 store.todos（不自行跨会话取数据）')
  ok(planCard.includes('hasTodoTileContent(todos)') && planCard.includes('model.done >= model.total'), '清单为空或全部完成时卡片隐藏')
  ok(planCard.includes('todoHistory') && planCard.includes('userMessageCount') && planCard.includes('round'), '标题的「早于上一条消息」判断比较 todoHistory 的 round 与当前用户消息数')
  ok(planCard.includes("t('plan.stale')") && planCard.includes("t('plan.title'"), '按是否过期在两种标题间切换')
  ok(planCard.includes('aria-expanded') && planCard.includes("type=\"button\""), '收起/展开用 button + aria-expanded，键盘可用')
  ok(planCard.includes('useState(readExpanded)') && planCard.includes("=== '1'"), '默认收成一行，只有记住的展开偏好才展开')
  ok(planCard.includes('localStorage.setItem(PLAN_EXPANDED_STORAGE_KEY'), '展开状态记在 localStorage')
  ok(planCard.includes('el.scrollTop =') && !planCard.includes('scrollIntoView'), '展开时只在卡内滚动对准当前项，不带动外层滚动')
  ok(planCard.includes('onScroll') && planCard.includes('hidesRowsBelow'), '滚到底后取消底部渐隐')
  ok(!planCard.includes('ResizeObserver') && !planCard.includes('NARROW_WIDTH'), '不再按宽度测量：任何宽度都默认收起')

  const view = await readFile(join(ROOT, 'src/renderer/src/features/todos/TodoTileView.tsx'), 'utf8')
  ok(view.includes("from 'lucide-react'"), '勾 / 省略号 / 虚线圆 / 受阻图标都来自 lucide（并非自绘控件外观）')

  const css = await readFile(join(ROOT, 'src/renderer/src/features/todos/todo-tile.css'), 'utf8')
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  ok(cssCode.includes('@layer features'), '专属 CSS 落在 features 层')
  ok(!cssCode.includes('text-decoration'), '完成项不加删除线')
  ok(!cssCode.includes('@import') && !cssCode.includes('.rp-') && !/styles\/|chat\.css/.test(cssCode), 'CSS 只做版面，不引 v2 样式、不回写 v2 类名')
  ok(!cssCode.includes('var(--ok)'), '完成勾不再用成功绿')
  ok(/\[data-kind='done'\] \.v3-todo-mark \{\s*color: var\(--fg2\)/.test(cssCode) && /\[data-kind='done'\] \.v3-todo-mark circle \{\s*fill: currentColor/.test(cssCode), '完成勾是次级灰的单色实心勾')
  ok(/\[data-kind='running'\] \.v3-todo-mark \{\s*color: var\(--run\);\s*\}/.test(cssCode) && !cssCode.includes('animation'), '进行中保留运行蓝、不加呼吸动画')
  ok(/\[data-kind='blocked'\] \.v3-todo-mark \{\s*color: var\(--fail\)/.test(cssCode), '受阻仍用警示色')

  const planCss = await readFile(join(ROOT, 'src/renderer/src/features/composer/plan-card.css'), 'utf8')
  ok(planCss.includes('@layer features'), '计划卡外壳 CSS 落在 features 层')
  ok(/\.plan-card \{[^}]*margin: calc\(-1 \* var\(--s-8\)\) calc\(-1 \* var\(--s-8\)\)/.test(planCss), '计划行铺满输入框卡片的上沿和两侧')
  ok(/\.plan-card \{[^}]*border-bottom: 1px solid var\(--line\)/.test(planCss), '计划行和输入区之间只有一条细分隔线')
  ok(!/\.plan-card \{[^}]*(background|border-radius|border:)/.test(planCss), '计划行没有自己的底色、外框和圆角（沿用输入框的）')
  ok(/max-height: min\(calc\(6\.5 \*[^;]*32svh\)/.test(planCss) && planCss.includes('overflow-y: auto'), '展开时最多约六行、不超过三分之一屏高，超出卡内滚动')
  ok(planCss.includes('mask-image'), '底部渐隐用 mask-image')
  ok(!planCss.includes('animation') && !planCss.includes('transition'), '计划行没有动效，不需要另做 reduced-motion 分支')

  const zhI18n = JSON.parse(await readFile(join(ROOT, 'src/renderer/src/i18n/zh-CN.json'), 'utf8'))
  const enI18n = JSON.parse(await readFile(join(ROOT, 'src/renderer/src/i18n/en-US.json'), 'utf8'))
  for (const key of ['plan.title', 'plan.stale', 'plan.workingOn', 'plan.expand', 'plan.collapse']) {
    ok(typeof zhI18n[key] === 'string' && typeof enI18n[key] === 'string', `i18n 两份词典都有 ${key}`)
  }
  ok(zhI18n['plan.stale'] === '上一轮' && enI18n['plan.stale'] === 'Earlier', 'plan.stale 是计数后的短标记')

  const agentSrc = await readFile(join(ROOT, 'src/main/agent.ts'), 'utf8')
  ok(!agentSrc.includes('panel_todos'), '死分支 panel_todos 已删除（真正的工具叫 todos，tasks.apply 已即时刷新）')

  const pushConsumers = await readFile(join(ROOT, 'src/renderer/src/state/push-consumers.ts'), 'utf8')
  ok(pushConsumers.includes("case 'todos':") && pushConsumers.includes('set({ todos: m.payload })'), 'store.todos 只由 todos 推送套用')
  const routing = await readFile(join(ROOT, 'src/renderer/src/state/push-routing.ts'), 'utf8')
  ok(routing.includes('viewingSessionId') && routing.includes('belongsToView'), '后台会话的待办只进 sessionRuntimes，不覆盖当前视图')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3-todo-tile: ${checks} checks passed`)
}

await main()
