/**
 * 「失败子代理不再处理」的隔离回归：纯投影 + 聊天卡片 + 子 Agent 总览。
 *
 * 用户反馈：已失败的子 Agent 只有「重试 / 详情」，没有退出口。本轮修好后钉住：
 *   ① 纯投影 `subagentOutcome`：`error` 且带有效 `dismissedAt` → quiet / mute /
 *      `key='dismissed'` / 不再 attention / rank 2；原 `status` 与 `error` 原文不动。
 *   ② 聊天卡片 `SubagentGroup`：常规失败显示「不再处理」次要操作；点后调用
 *      `window.yan.subagents.dismiss(id)`，成功后 `loadSubagents` 重读快照，
 *      失败就地 `role=alert`；在途重复点击只发一次请求；不触发 retry/stop/clearAll；
 *      不乐观隐藏（快照未变时入口仍在）；待审阅（pending/conflict）不可点；
 *      已标记的卡片不再显示入口，进默认折叠的已完成区，详情仍保留失败原因。
 *   ③ 总览 `SubagentPlan`：同一 API、同一分区规则；已处理进「已完成」且默认折叠。
 *
 * 本脚本用 esbuild 现场编译到 `.tmp/`，React 用最小桩（只实现 useState/useRef/
 * useEffect），直接调用组件真实 `onClick` 驱动请求；不启动 Electron、不连接 pi、
 * 不访问网络、不读写真实用户数据。
 *
 * 导出 `runSubagentDismissTests(ok)`；直接运行本文件也会执行并在失败时置退出码。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/* ------------------------------------------------ 最小 React 桩：支持重渲染 */

const FragmentType = Symbol('Fragment')

function createElement(type, config, ...children) {
  const props = { ...(config || {}) }
  const kids = []
  const append = (child) => {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (Array.isArray(child)) { for (const c of child) append(c); return }
    kids.push(child)
  }
  if (children.length) for (const c of children) append(c)
  else if (props.children !== undefined) append(props.children)
  delete props.children
  delete props.key
  delete props.ref
  return { type, props, children: kids }
}

let hookStates = []
let hookIndex = 0
let rootElement = null
let latest = []

/** 状态变更后按同一遍历顺序重放，扁平 hook 槽位随之复用。 */
function scheduleRerender() {
  hookIndex = 0
  latest = renderChild(rootElement)
}

function useState(initial) {
  const i = hookIndex++
  if (!(i in hookStates)) hookStates[i] = { value: typeof initial === 'function' ? initial() : initial }
  const slot = hookStates[i]
  const setState = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next
    if (Object.is(value, slot.value)) return
    slot.value = value
    scheduleRerender()
  }
  return [slot.value, setState]
}

function useRef(initial) {
  const i = hookIndex++
  if (!(i in hookStates)) hookStates[i] = { current: initial }
  return hookStates[i]
}

/* 时间类副作用在测试里不需要：只占一个槽位，保持 hook 顺序稳定。 */
function useEffect() { hookIndex++ }

function renderChild(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [{ kind: 'text', text: String(node) }]
  if (Array.isArray(node)) return node.flatMap(renderChild)
  const { type, props, children } = node
  if (type === FragmentType) return children.flatMap(renderChild)
  if (typeof type === 'function') {
    const rendered = type({ ...props, children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children })
    return renderChild(rendered)
  }
  return [{ kind: 'host', type, props, children: children.flatMap(renderChild) }]
}

function mount(element) {
  hookStates = []
  hookIndex = 0
  rootElement = element
  latest = renderChild(element)
  return latest
}

function findAll(tree, predicate) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'host' && predicate(node)) out.push(node)
      if (node.children) walk(node.children)
    }
  }
  walk(tree)
  return out
}

const byTestId = (tree, id) => findAll(tree, (n) => n.props?.['data-testid'] === id)

function textOf(node) {
  if (!node) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.kind === 'text') return node.text
  return (node.children ?? []).map(textOf).join('')
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/* --------------------------------------------------------------- 测试主体 */

export async function runSubagentDismissTests(ok) {
  const check = typeof ok === 'function'
    ? ok
    : (condition, label) => { if (!condition) throw new Error(`✗ ${label}`) }

  const realReact = Object.getOwnPropertyDescriptor(globalThis, 'React')
  const realStub = Object.getOwnPropertyDescriptor(globalThis, '__dismissReact')
  const realState = Object.getOwnPropertyDescriptor(globalThis, '__dismissState')
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

  await mkdir(resolve('.tmp/subagent-dismiss-ui'), { recursive: true })
  const buildDir = await mkdtemp(resolve('.tmp/subagent-dismiss-ui/run-'))
  try {
    /* 用 React 桩接管 JSX 与 hooks；组件源码原样编译，不改生产代码。 */
    const reactStub = { createElement, Fragment: FragmentType, useState, useRef, useEffect }
    globalThis.React = { createElement, Fragment: FragmentType }
    globalThis.__dismissReact = reactStub

    const calls = { dismiss: [], start: [], stop: [], clear: 0, load: 0 }
    let dismissImpl = async () => ({ ok: true })

    globalThis.window = {
      dispatchEvent: () => {},
      yan: {
        subagents: {
          dismiss: async (id) => { calls.dismiss.push(id); return dismissImpl(id) },
          start: async () => { calls.start.push(1); return { ok: true } },
          stop: async () => { calls.stop.push(1); return { ok: true } },
          clearFinished: async () => { calls.clear++ }
        }
      }
    }
    globalThis.__dismissState = {
      models: [],
      settings: { modelFavorites: [] },
      stopSubagent: async () => {},
      mergeSubagent: async () => {},
      discardSubagent: async () => {},
      loadSubagents: async () => { calls.load++ }
    }

    const modules = {
      react: `const R = globalThis.__dismissReact
export const useState = R.useState
export const useRef = R.useRef
export const useEffect = R.useEffect
export const createElement = R.createElement
export const Fragment = R.Fragment`,
      store: `export const useStore = (selector) => selector(globalThis.__dismissState)
useStore.getState = () => globalThis.__dismissState`,
      i18n: `export const useT = () => (key, vars) => { let s = 'T:' + key; if (vars && vars.n !== undefined) s += ':' + vars.n; return s }`,
      confirm: `export const useConfirm = () => async () => true`,
      ui: `const h = globalThis.__dismissReact.createElement
export const Button = ({ variant, size, active, trailingIcon, icon, className, children, ...rest }) => h('button', rest, children)`,
      model: `export const resolveSubagentModelDisplay = () => ({ label: 'M' })`
    }

    const outfile = join(buildDir, 'dismiss-ui.mjs')
    await build({
      stdin: {
        contents: [
          `export { SubagentGroup } from './src/renderer/src/components/chat/SubagentCards'`,
          `export { SubagentPlan } from './src/renderer/src/components/workbench/SubagentPlan'`,
          `export { subagentOutcome, isDismissed } from './src/shared/subagent-outcome'`
        ].join('\n'),
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
      plugins: [{
        name: 'dismiss-ui-fixtures',
        setup(b) {
          const fixtures = [
            [/^react$/, 'react'],
            [/state\/store$/, 'store'],
            [/(^|\/)i18n$/, 'i18n'],
            [/ui\/confirm$/, 'confirm'],
            [/(^|\/)ui$/, 'ui'],
            [/chat\/turn-model-display$/, 'model']
          ]
          for (const [filter, name] of fixtures) b.onResolve({ filter }, () => ({ path: name, namespace: 'fixture' }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: modules[args.path], loader: 'js' }))
        }
      }]
    })

    const mod = await import(pathToFileURL(outfile).href)
    const { SubagentGroup, SubagentPlan, subagentOutcome } = mod

    const baseRun = (extra = {}) => ({
      id: 'fail1',
      task: 'Do a thing',
      cwd: '/tmp/fixture',
      isolation: 'worktree',
      status: 'error',
      startedAt: 1,
      endedAt: 2,
      transcript: [],
      review: 'none',
      error: 'boom failed',
      ...extra
    })

    const reset = () => { calls.dismiss.length = 0; calls.start.length = 0; calls.stop.length = 0; calls.clear = 0; calls.load = 0 }

    /* ① 纯投影：dismissedAt 有效 → quiet / mute / dismissed；原记录不动。 */
    const dismissedInput = baseRun({ dismissedAt: 123 })
    const projected = subagentOutcome(dismissedInput)
    check(projected.key === 'dismissed', '投影：已处理的 key 是 dismissed')
    check(projected.tone === 'mute', '投影：已处理语气为 mute')
    check(projected.live === false && projected.attention === false, '投影：已处理不再运行、不再需处理')
    check(projected.rank === 2 && projected.partial === false, '投影：已处理排进完成区，不是部分结论')
    check(dismissedInput.status === 'error' && dismissedInput.error === 'boom failed', '投影不改写原 status / error')
    check(subagentOutcome(baseRun()).key === 'failed', '投影：未标记的 error 仍是 failed')
    check(subagentOutcome(baseRun({ dismissedAt: Number.NaN })).key === 'failed', '投影：无效 dismissedAt 不算已处理')
    check(subagentOutcome(baseRun({ endReason: 'timeout', dismissedAt: 1 })).key === 'dismissed', '投影：超时失败被标记后同样退出')

    /* ② 聊天卡片：常规失败显示「不再处理」，点击驱动真实请求。 */
    reset()
    dismissImpl = async () => ({ ok: true })
    mount(createElement(SubagentGroup, { runs: [baseRun()] }))
    check(byTestId(latest, 'subagent-note-dismiss-fail1').length === 1, '常规失败卡片显示「不再处理」')
    check(byTestId(latest, 'subagent-note-dismiss-fail1')[0].props.title === 'T:sa.dismissHint', '入口带「保留错误记录」提示')
    check(byTestId(latest, 'subagent-note-retry-fail1').length === 1, '重试入口保留，不互相替代')

    /* 成功：调用 API → loadSubagents 重读；快照未变不乐观隐藏。 */
    byTestId(latest, 'subagent-note-dismiss-fail1')[0].props.onClick()
    await flush()
    check(calls.dismiss.length === 1 && calls.dismiss[0] === 'fail1', '点击调用 dismiss(id)')
    check(calls.load === 1, '成功后 loadSubagents 重读快照')
    check(calls.start.length === 0 && calls.stop.length === 0 && calls.clear === 0, '不触发 retry / stop / clearAll')
    check(byTestId(latest, 'subagent-note-dismiss-fail1').length === 1, '快照未变时不乐观隐藏')

    /* 失败：就地 role=alert；仍留在需处理区，原因保留。 */
    reset()
    dismissImpl = async () => ({ ok: false, error: 'nope' })
    mount(createElement(SubagentGroup, { runs: [baseRun()] }))
    byTestId(latest, 'subagent-note-dismiss-fail1')[0].props.onClick()
    await flush()
    const fails = findAll(latest, (n) => n.props?.role === 'alert')
    check(fails.length === 1 && fails[0].props['data-testid'] === 'subagent-note-dismiss-failed-fail1', '保存失败就地 role=alert')
    check(textOf(fails[0]) === 'T:sa.dismissFailed', '提示用 dismissFailed 文案')
    check(byTestId(latest, 'subagent-note-dismiss-fail1').length === 1, '失败后仍留在需处理区')
    check(byTestId(latest, 'subagent-note-reason-fail1').map(textOf).includes('boom failed'), '失败原因仍在')
    check(calls.load === 0, '保存失败不重读快照（未乐观改动）')

    /* 在途防重：同步连点只发一次请求。 */
    reset()
    let release
    dismissImpl = () => new Promise((res) => { release = res })
    mount(createElement(SubagentGroup, { runs: [baseRun()] }))
    const inflight = byTestId(latest, 'subagent-note-dismiss-fail1')[0]
    inflight.props.onClick()
    inflight.props.onClick()
    check(calls.dismiss.length === 1, '在途时重复点击只发一次请求')
    release({ ok: true })
    await flush()
    check(calls.load === 1, '在途请求完成后只重读一次')

    /* 待审阅：pending / conflict 不能用「不再处理」绕过。 */
    for (const review of ['pending', 'conflict']) {
      reset()
      mount(createElement(SubagentGroup, { runs: [baseRun({ review })] }))
      check(byTestId(latest, 'subagent-note-dismiss-fail1').length === 0, `待审阅 ${review} 不提供「不再处理」`)
      check(byTestId(latest, 'subagent-note-merge-fail1').length === 1, `待审阅 ${review} 仍走合并/放弃审阅`)
    }

    /* 已处理：不再显示入口，进默认折叠的已完成区，详情仍保留失败原因。 */
    reset()
    mount(createElement(SubagentGroup, { runs: [baseRun({ dismissedAt: 123 })] }))
    check(byTestId(latest, 'subagent-note-fail1')[0].props['data-outcome'] === 'dismissed', '已处理卡片标记为 dismissed')
    check(textOf(byTestId(latest, 'subagent-note-state-fail1')[0]) === 'T:sa.state.dismissed', '状态文案为「已处理」')
    check(byTestId(latest, 'subagent-note-dismiss-fail1').length === 0, '已处理不再显示入口')
    check(byTestId(latest, 'subagent-note-reason-fail1').map(textOf).includes('boom failed'), '详情仍保留原始失败原因')

    /* 同组混合：已处理的默认收进汇总行，展开后可见。 */
    mount(createElement(SubagentGroup, { runs: [baseRun({ id: 'active' }), baseRun({ id: 'done-dismiss', dismissedAt: 5 })] }))
    check(byTestId(latest, 'subagent-note-active').length === 1, '需处理的那条始终逐张显示')
    check(byTestId(latest, 'subagent-note-done-dismiss').length === 0, '已处理的默认收进汇总行')
    check(textOf(byTestId(latest, 'subagent-group-head')[0]).includes('T:sa.group.quiet:1'), '汇总行计入已完成 1')
    byTestId(latest, 'subagent-group-toggle')[0].props.onClick()
    check(byTestId(latest, 'subagent-note-done-dismiss').length === 1, '展开后可逐张查看已处理')
    check(byTestId(latest, 'subagent-note-dismiss-done-dismiss').length === 0, '展开的已处理卡片没有「不再处理」入口')

    /* ③ 总览：同一 API；已处理进「已完成」且默认折叠。 */
    reset()
    dismissImpl = async () => ({ ok: true })
    mount(createElement(SubagentPlan, { runs: [baseRun()], onOpen: () => {} }))
    check(byTestId(latest, 'subagent-zone-attention').length === 1, '总览失败任务在需处理区')
    check(byTestId(latest, 'sa-room-dismiss-fail1').length === 1, '总览失败任务提供「不再处理」')
    byTestId(latest, 'sa-room-dismiss-fail1')[0].props.onClick()
    await flush()
    check(calls.dismiss.length === 1, '总览点击调用同一 dismiss(id)')
    check(calls.load === 1, '总览成功后同样重读快照')

    mount(createElement(SubagentPlan, { runs: [baseRun({ dismissedAt: 123 })], onOpen: () => {} }))
    check(byTestId(latest, 'subagent-zone-done').length === 1, '已处理进入已完成区')
    check(byTestId(latest, 'subagent-zone-attention').length === 0, '已处理不再留在需处理区')
    check(byTestId(latest, 'sa-room-dismiss-fail1').length === 0, '已完成区默认折叠，不渲染卡片')
    byTestId(latest, 'subagent-group-toggle')[0].props.onClick()
    check(textOf(latest).includes('T:sa.state.dismissed'), '展开后总览状态为「已处理」')
    check(byTestId(latest, 'sa-room-dismiss-fail1').length === 0, '展开的已处理卡片也没有「不再处理」入口')
  } finally {
    if (realReact) Object.defineProperty(globalThis, 'React', realReact); else delete globalThis.React
    if (realStub) Object.defineProperty(globalThis, '__dismissReact', realStub); else delete globalThis.__dismissReact
    if (realState) Object.defineProperty(globalThis, '__dismissState', realState); else delete globalThis.__dismissState
    if (realWindow) Object.defineProperty(globalThis, 'window', realWindow); else delete globalThis.window
    await rm(buildDir, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------------- 直接运行入口 */

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  let passed = 0
  let failed = 0
  try {
    await mkdir('.tmp/subagent-dismiss-ui', { recursive: true })
    await runSubagentDismissTests((condition, label) => {
      if (condition) {
        passed++
        console.log(`  ok  ${label}`)
      } else {
        failed++
        console.log(`  ✗ ${label}`)
      }
    })
    console.log(failed ? `\n✗ 失败子代理不再处理：失败 ${failed} 项` : `\n✓ 失败子代理不再处理：${passed} 项通过`)
    if (failed) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
