#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
  ok(partialHtml.includes('data-kind="done"'), '完成项标记 done')
  ok(!partialHtml.includes('data-kind="running"'), '没有 status 且回合未跑：不画进行中')

  const runningHtml = render({ todos: [todo('跑起来'), todo('收尾')], agentRunning: true })
  ok(
    runningHtml.includes('data-kind="running"') && runningHtml.includes('aria-label="进行中"'),
    '无 status 且回合在跑：进行中项带读屏名'
  )

  const runningStatusHtml = render({ todos: [todo('甲乙', { status: 'running' }), todo('丙', { status: 'pending' })], agentRunning: false })
  ok(
    runningStatusHtml.includes('data-kind="running"'),
    '有显式 running 时即使回合未标记也显示进行中'
  )
  ok(runningStatusHtml.includes('data-kind="pending"'), '待做项标记 pending')

  const blockedHtml = render({ todos: [todo('受阻项', { status: 'blocked' }), todo('普通项')] })
  ok(blockedHtml.includes('data-kind="blocked"') && blockedHtml.includes('受阻'), 'blocked 行可与待办区分')

  const enHtml = render({ todos: [todo('blocked', { status: 'blocked' })], lang: 'en-US' })
  ok(enHtml.includes('Blocked'), '英文语言走自有常量', { blocked: enHtml.includes('Blocked') })

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3-todo-tile: ${checks} checks passed`)
}

await main()
