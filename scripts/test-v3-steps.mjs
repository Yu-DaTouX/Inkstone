#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const __EXTRA = {'Collapsible': 'export function Collapsible(p){ return p.children ?? null }', 'CollapsibleHeader': 'export function CollapsibleHeader(p){ return p.children ?? null }', 'CollapsiblePanel': 'export function CollapsiblePanel(p){ return p.children ?? null }', 'DiffStat': 'export function DiffStat(){ return null }', 'DialogFooter': 'export function DialogFooter(p){ return p.children ?? null }', 'FindBar': 'export function FindBar(){ return null }', 'ListRow': 'export function ListRow(p){ return p.children ?? null }', 'Spinner': 'export function Spinner(){ return null }'}
function __patch(key, src){ if (!/[\\/]ui[\\/]index\.ts$/.test(key)) return src; let out = src; for (const [n, code] of Object.entries(__EXTRA)) { if (!new RegExp('export (function|const|class) '+n+'\\b').test(out) && !new RegExp('export \\{[^}]*\\b'+n+'\\b').test(out)) out += '\n' + code } return out }
function __findHeader(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = __findHeader(item)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'function' && /^CollapsibleHeader\d*$/.test(node.type.name)) return node
  if (node.props && 'isExpanded' in node.props) return null
  return node.props?.children !== undefined ? __findHeader(node.props.children) : null
}
function __wireCollapsibles(node) {
  if (Array.isArray(node)) {
    for (const item of node) __wireCollapsibles(item)
    return node
  }
  if (!node || typeof node !== 'object') return node
  const props = node.props
  if (props && 'isExpanded' in props && typeof props.onExpandedChange === 'function') {
    const head = __findHeader(props.children)
    if (head) {
      head.type = 'button'
      head.props = { ...head.props, 'aria-expanded': !!props.isExpanded, onClick: () => props.onExpandedChange(!props.isExpanded) }
    }
  }
  if (props?.children !== undefined) __wireCollapsibles(props.children)
  return node
}

const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }

function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const mark = pass ? '  ✓' : '  ✗'
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${mark} ${label}${extra}\n`)
  return pass
}

function installGlobals() {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    try {
      fn(0)
    } catch {
    }
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} }
  globalThis.__V3_LANG = 'zh-CN'
}

const REACT_SHIM = `/* v3 步骤回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useInsertionEffect() {}
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() }
export function useDebugValue() {}
export function useId() { return rt().useId() }
export function useContext(ctx) { return ctx && '__value' in ctx ? ctx.__value : null }
export function createContext(value) { return { __isContext: true, __value: value, Provider: (p) => (p ? p.children : null), Consumer: (p) => (p && typeof p.children === 'function' ? p.children(value) : null) } }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out, key: out.key === undefined ? null : out.key } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export function isValidElement(el) { return !!el && typeof el === 'object' && 'type' in el && 'props' in el }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, useId, useContext, createContext, createElement, forwardRef, memo, isValidElement }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

function abs(rel) {
  return normalize(resolve(ROOT, rel))
}

function makeStubPlugin(rawMap) {
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
  return {
    name: 'v3-steps-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (stubMap.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        const key = args.path.slice('v3stub:'.length)
        return { contents: __patch(key, stubMap.get(key) ?? 'export {}'), loader: 'js' }
      })
    }
  }
}

const DEFINE = {
  'import.meta.env.DEV': 'false',
  'import.meta.env.PROD': 'true',
  'process.env.NODE_ENV': '"production"',
  requestAnimationFrame: 'globalThis.requestAnimationFrame',
  cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
}

async function buildSteps(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entry = join(outdir, 'steps-entry.ts')
  await writeFile(entry, `export { ToolSteps, detailKind, visibleNestedNodes, collapsedNest, stepIconName, groupIconName } from '${posix(abs('src/renderer/src/features/session/ToolSteps.tsx'))}'\nexport { toolExpansion } from '${posix(abs('src/renderer/src/features/session/tool-expansion.ts'))}'\n`)
  const out = join(outdir, 'steps-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    define: DEFINE,
    alias: { react: reactShim, 'react/jsx-runtime': jsxShim, 'react/jsx-dev-runtime': jsxShim },
    plugins: [
      makeStubPlugin({
        'src/renderer/src/features/session/Icon.tsx': `export function Icon(props){ return { type: Icon, props, key: null } }`,
        'src/renderer/src/features/session/ApprovalCard.tsx': `export function ApprovalCard(){ return null }`,
        'src/renderer/src/patterns/HighlightedCode.tsx': `export function HighlightedCode(props){ return null }`,
        'src/renderer/src/features/artifacts/McpAppFrame.tsx': `export function McpAppResult(){ return null }\nexport function McpAppStepAudit(){ return null }`,
        'src/renderer/src/features/session/web-search/SearchStep.tsx': 'export function SearchStepView(p){ return p.children }',
        'src/renderer/src/ui/index.ts': `export function Button(props){ return null }\nButton.__stub='ui-button'\nexport function IconButton(props){ return null }\nIconButton.__stub='ui-iconbutton'\nexport function ShimmerText(props){ return [props.lead ?? null, props.children] }\nexport function CompletionSweep(){ return null }
export function Badge(props){ return null }
Badge.__stub='ui-badge'
export function Notice(props){ return null }
Notice.__stub='ui-notice'
export function TextField(props){ return null }
export function TextArea(props){ return null }
export function Input(props){ return null }
export function Slider(props){ return null }`,
        'src/renderer/src/i18n/index.tsx': `export function useI18n(){ return { lang: globalThis.__V3_LANG || 'zh-CN' } }
export function useT(){ return (k, vars) => { let s = (globalThis.__V3_LANG === 'en-US' ? 'EN:' : 'ZH:') + String(k); if (vars) for (const [n, v] of Object.entries(vars)) s += '|' + n + '=' + v; return s } }
export function translate(_l, k){ return String(k) }`
      })
    ]
  })
  return out
}

function makeHookRuntime() {
  const rt = {
    cells: [],
    idx: 0,
    effects: [],
    dirty: false,
    seq: 0,
    slot(kind) {
      const i = rt.idx++
      let c = rt.cells[i]
      if (!c || c.kind !== kind) c = rt.cells[i] = { kind, has: false, value: undefined, deps: undefined }
      return c
    },
    useState(init) {
      const c = rt.slot('state')
      if (!c.has) {
        c.value = typeof init === 'function' ? init() : init
        c.has = true
      }
      const set = (v) => {
        const next = typeof v === 'function' ? v(c.value) : v
        if (!Object.is(next, c.value)) {
          c.value = next
          rt.dirty = true
        }
      }
      return [c.value, set]
    },
    useRef(init) {
      const c = rt.slot('ref')
      if (!c.has) {
        c.value = { current: init }
        c.has = true
      }
      return c.value
    },
    useEffect(fn, deps) {
      const c = rt.slot('effect')
      const prev = c.deps
      const changed = !c.has || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]))
      if (changed) {
        c.deps = deps ? [...deps] : undefined
        c.has = true
        rt.effects.push(fn)
      }
    },
    useId() {
      return `v3id-${rt.seq++}`
    },
    render(Component, props) {
      let tree
      let guard = 0
      do {
        rt.dirty = false
        rt.idx = 0
        rt.effects = []
        tree = Component(props || {})
        for (const fn of rt.effects) fn()
      } while (rt.dirty && ++guard < 100)
      if (guard >= 100) throw new Error('浅渲染未收敛（疑似 effect 里无限 setState）')
      return __wireCollapsibles(tree)
    }
  }
  return rt
}

function renderComponent(rt, type, props) {
  globalThis.__V3_HOOKS = rt
  return rt.render(type, props)
}

function collect(node, pred, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, pred, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  const kids = node.props?.children
  if (kids !== undefined) collect(kids, pred, out)
  return out
}

const byTypeName = (tree, name) => collect(tree, (el) => typeof el.type === 'function' && el.type.name === name)
const byTestId = (tree, id) => collect(tree, (el) => el.props && el.props['data-testid'] === id)[0] ?? null

function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const longOutput = (n) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join('\n')

function tool(over) {
  return { id: 't', name: 'read', args: {}, status: 'ok', ...over }
}

const diffCall = (over = {}) =>
  tool({
    id: 'edit-1',
    name: 'edit',
    args: { path: 'src/example.ts' },
    output: 'Edited',
    details: {
      fileDiff: {
        path: 'src/example.ts',
        before: { tooLarge: false },
        after: { tooLarge: false },
        added: 2,
        removed: 1,
        status: 'modified',
        patch: '- const old = 1\n+ const next = 2'
      }
    },
    ...over
  })

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-steps-'))
  let bundle
  let bundlePath
  try {
    bundlePath = await buildSteps(outdir)
    bundle = await import(pathToFileURL(bundlePath).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }
  const { ToolSteps, detailKind, toolExpansion, stepIconName, groupIconName } = bundle

  const renderSteps = (tools, approvalIds) => {
    const rt = makeHookRuntime()
    return { rt, tree: renderComponent(rt, ToolSteps, approvalIds ? { tools, approvalIds } : { tools }) }
  }
  const renderStepsOpen = (tools) => {
    const rt = makeHookRuntime()
    return { rt, tree: renderComponent(rt, ToolSteps, { tools }) }
  }
  const renderStepNode = (stepsTree, id) => {
    const el = byTypeName(stepsTree, 'StepNode').find((node) => node.props.node.call.id === id)
    if (!el) throw new Error(`找不到 StepNode ${id}`)
    const rt = makeHookRuntime()
    return { rt, el, tree: renderComponent(rt, el.type, el.props) }
  }
  const renderSub = (parentTree, name, pred) => {
    const all = byTypeName(parentTree, name)
    const el = pred ? all.find(pred) : all[0]
    if (!el) throw new Error(`找不到 ${name}`)
    const rt = makeHookRuntime()
    return { rt, el, tree: renderComponent(rt, el.type, el.props) }
  }

  group('detailKind：按工具分流详情')
  {
    ok(detailKind('bash') === 'command' && detailKind('exec') === 'command', '命令类工具归 command')
    ok(detailKind('edit') === 'change' && detailKind('apply_patch') === 'change', '编辑类工具归 change')
    ok(detailKind('read') === 'result' && detailKind('mcp_thing') === 'result', '其余归 result')
  }

  group('成组：连续 2 条以上即成组、不要求同类，组头写多类别摘要与增删')
  {
    toolExpansion.clear()
    const { tree } = renderSteps([tool({ id: 'read-1', name: 'read' }), diffCall()])
    ok(byTestId(tree, 'v3-steps-toggle') === null, '不再有外层摘要按钮，组本身就是一行')
    const groups = byTypeName(tree, 'ToolGroupRow')
    ok(groups.length === 1 && byTypeName(tree, 'StepNode').length === 0, '读取 + 编辑合成一组', groups.length)
    const g = renderSub(tree, 'ToolGroupRow')
    const head = byTestId(g.tree, 'v3-step-group')
    ok(!!head && head.type === 'button', '组头是原生 button（可聚焦）')
    ok(head.props['aria-expanded'] === false, '组默认折叠', head.props['aria-expanded'])
    ok(textOf(head).includes('读取 1 个文件，编辑 1 个文件'), '摘要拼接多个类别', textOf(head))
    const stats = byTypeName(g.tree, 'ToolRunStats')[0]
    ok(stats && stats.props.summary.added === 2 && stats.props.summary.removed === 1, '组头带 +2 −1（只按有快照的改动）', stats && stats.props.summary)
    const statsTree = renderComponent(makeHookRuntime(), stats.type, stats.props)
    ok(textOf(statsTree) === '+2−1', '增删文本', textOf(statsTree))

    const noSnap = renderSteps([tool({ id: 'read-2', name: 'read' }), tool({ id: 'write-1', name: 'write', args: { path: 'x' }, output: 'w' })])
    const noSnapGroup = renderSub(noSnap.tree, 'ToolGroupRow')
    const noStats = byTypeName(noSnapGroup.tree, 'ToolRunStats')[0]
    ok(renderComponent(makeHookRuntime(), noStats.type, noStats.props) === null, '没有执行前后快照时不写增删，也不编造文件数')

    const one = renderSteps([tool({ id: 'solo', name: 'read' })])
    ok(byTypeName(one.tree, 'ToolGroupRow').length === 0 && byTypeName(one.tree, 'StepNode').length === 1, '只有 1 条时保持单行')
  }

  group('失败：组头可见文字不写失败数（避免和独立失败状态重复），分段只留红字，不再自动展开')
  {
    const { tree } = renderSteps([
      tool({ id: 'read-3', name: 'read' }),
      tool({ id: 'bash-err', name: 'bash', args: { command: 'false' }, status: 'error', output: 'Permission denied' })
    ])
    const g = renderSub(tree, 'ToolGroupRow')
    const head = byTestId(g.tree, 'v3-step-group')
    ok(head.props['aria-expanded'] === false, '有失败也保持折叠', head.props['aria-expanded'])
    ok(!textOf(head).includes('个失败'), '组头可见文字不再写失败数，失败数改由独立状态展示', textOf(head))
    const failedPart = collect(head, (el) => el.props && el.props['data-failed'] !== undefined)
    ok(failedPart.length === 1, '失败的分段仍单独标红', failedPart.length)
    const stats = byTypeName(g.tree, 'ToolRunStats')[0]
    ok(stats && stats.props.summary.failed === 1, '失败总数仍挂在 summary 上，交给独立状态展示', stats && stats.props.summary.failed)
    ok(collect(g.tree, (el) => el.type && el.type.__stub === 'ui-badge' && el.props.tone === 'fail').length === 0, '组头不再挂失败徽标')
    head.props.onClick()
    const opened = renderComponent(g.rt, g.el.type, g.el.props)
    const failedNode = renderStepNode(opened, 'bash-err')
    ok(byTestId(failedNode.tree, 'v3-step').props['aria-expanded'] === false, '失败那一步默认折叠')
    ok(collect(failedNode.tree, (el) => el.type && el.type.__stub === 'ui-badge').length === 0, '失败那一步不挂徽标')
    ok(textOf(byTestId(failedNode.tree, 'v3-step')).includes('运行失败'), '失败那一步的标题用失败时态的动词', textOf(byTestId(failedNode.tree, 'v3-step')))
  }

  group('F02：部分失败也标红，失败数独立于标题省略显示')
  {
    toolExpansion.clear()
    const { tree } = renderSteps([
      tool({ id: 'c1', name: 'bash', args: { command: 'a' }, status: 'error' }),
      tool({ id: 'c2', name: 'bash', args: { command: 'b' }, status: 'error' }),
      tool({ id: 'c3', name: 'bash', args: { command: 'c' } })
    ])
    const g = renderSub(tree, 'ToolGroupRow')
    const head = byTestId(g.tree, 'v3-step-group')
    const failedParts = collect(head, (el) => el.props && el.props['data-failed'] !== undefined)
    ok(failedParts.length === 1, '部分失败（2/3）的分段也带 data-failed，不再要求整段全部失败', failedParts.length)
    ok(!textOf(head).includes('个失败'), '部分失败的分段文字里也不再写失败数，只留红字', textOf(head))
    const stats = byTypeName(g.tree, 'ToolRunStats')[0]
    ok(stats && stats.props.summary.failed === 2, 'ToolRunStats 拿到与分组一致的失败总数', stats && stats.props.summary.failed)
    const statsTree = renderComponent(makeHookRuntime(), stats.type, stats.props)
    const failedStat = collect(statsTree, (el) => el.props && el.props['data-kind'] === 'failed')
    ok(failedStat.length === 1, '失败数作为独立状态渲染，不和标题共用同一个会被省略的节点', failedStat.length)
    ok(textOf(failedStat[0]).includes('tool.wsFailed') && textOf(failedStat[0]).includes('n=2'), '独立失败状态带上失败总数', textOf(failedStat[0]))
  }

  group('R02：已恢复的轮次不再警示，分组汇总跟着转灰，单条失败命令仍标红')
  {
    toolExpansion.clear()
    const tools = [
      tool({ id: 'r1', name: 'bash', args: { command: 'a' } }),
      tool({ id: 'r2', name: 'bash', args: { command: 'b' }, status: 'error', output: 'TS2322' }),
      tool({ id: 'r3', name: 'bash', args: { command: 'c' } })
    ]
    const render = (props) => {
      const rt = makeHookRuntime()
      const tree = renderComponent(rt, ToolSteps, { tools, ...props })
      const g = renderSub(tree, 'ToolGroupRow')
      const head = byTestId(g.tree, 'v3-step-group')
      const stats = byTypeName(g.tree, 'ToolRunStats')[0]
      const statsTree = renderComponent(makeHookRuntime(), stats.type, stats.props)
      return { g, head, failedParts: collect(head, (el) => el.props && el.props['data-failed'] !== undefined), failedStat: collect(statsTree, (el) => el.props && el.props['data-kind'] === 'failed')[0] }
    }
    const alerting = render({})
    ok(alerting.failedParts.length === 1, '默认仍警示：失败分段带 data-failed', alerting.failedParts.length)
    ok(String(alerting.failedStat.props.className).includes('err'), '默认仍警示：失败数标红', alerting.failedStat.props.className)
    const recovered = render({ alertFailures: false })
    ok(recovered.failedParts.length === 0, '已恢复：汇总分段不带 data-failed', recovered.failedParts.length)
    ok(recovered.failedStat && !String(recovered.failedStat.props.className).includes('err'), '已恢复：失败数仍显示但不标红', recovered.failedStat && recovered.failedStat.props.className)
    ok(textOf(recovered.failedStat).includes('n=1'), '已恢复：失败数保留事实', textOf(recovered.failedStat))
    recovered.head.props.onClick()
    const opened = renderComponent(recovered.g.rt, recovered.g.el.type, recovered.g.el.props)
    const failedNode = renderStepNode(opened, 'r2')
    ok(failedNode.tree.props['data-state'] === 'error', '已恢复：单条失败命令仍带 error 状态，红字保留', failedNode.tree.props['data-state'])
  }

  group('F04：待办调用默认不进入消息流，出错时仍显示')
  {
    toolExpansion.clear()
    const onlyTodo = renderSteps([tool({ id: 't1', name: 'todo_write' })])
    ok(onlyTodo.tree === null, '只有成功的待办调用时，ToolSteps 整段不渲染', onlyTodo.tree)
    const mixed = renderSteps([tool({ id: 'r1', name: 'read' }), tool({ id: 't1', name: 'todos' }), tool({ id: 'r2', name: 'read' })])
    ok(byTypeName(mixed.tree, 'ToolGroupRow').length === 1, '成功的待办调用被过滤后，前后两次读取仍合并成组', byTypeName(mixed.tree, 'ToolGroupRow').length)
    ok(byTypeName(mixed.tree, 'StepNode').length === 0, '待办调用不单独占一行')
    const failedTodo = renderSteps([tool({ id: 't1', name: 'update_todos', status: 'error', output: '写入失败' })])
    ok(byTypeName(failedTodo.tree, 'StepNode').length === 1, '出错的待办调用仍然显示')
  }

  group('展开状态存在会话级存储：重挂载不丢，重试时清除')
  {
    const tools = [tool({ id: 'keep-1', name: 'read' }), tool({ id: 'keep-2', name: 'grep' })]
    const g = renderSub(renderSteps(tools).tree, 'ToolGroupRow')
    byTestId(g.tree, 'v3-step-group').props.onClick()
    const remount = renderSub(renderSteps(tools).tree, 'ToolGroupRow')
    ok(byTestId(remount.tree, 'v3-step-group').props['aria-expanded'] === true, '换一套 hook 状态（模拟虚拟化卸载）后仍展开')
    ok(byTypeName(remount.tree, 'StepNode').length === 2, '展开后逐条展示')
    toolExpansion.forget('')
    const cleared = renderSub(renderSteps(tools).tree, 'ToolGroupRow')
    ok(byTestId(cleared.tree, 'v3-step-group').props['aria-expanded'] === false, '清除该会话后回到默认折叠')
  }

  group('运行中：组头显示正在运行的那一步，单行照常')
  {
    const { tree } = renderSteps([
      tool({ id: 'read-4', name: 'read' }),
      tool({ id: 'bash-run', name: 'bash', args: { command: 'sleep 1' }, status: 'running', startedAt: 1 })
    ])
    const g = renderSub(tree, 'ToolGroupRow')
    const shimmer = byTypeName(g.tree, 'ShimmerText')
    ok(shimmer.some((el) => el.props.active === true && textOf(el.props.children).includes('正在运行 sleep 1')), '折叠的组头显示运行中的工具与进行时动词，文字带闪烁', shimmer.map((el) => [el.props.active, el.props.children]))
    ok(collect(g.tree, (el) => el.props && String(el.props.className || '').startsWith('v3-dot')).length === 0, '不再画状态点')

    const single = renderSteps([tool({ id: 'p-1', name: 'read', status: 'pending' })])
    const runningNode = renderStepNode(single.tree, 'p-1')
    const icons = collect(runningNode.tree, (el) => typeof el.type === 'function' && el.type.name === 'Icon')
    ok(!icons.some((el) => el.props.name === 'spinner' || el.props.name === 'check'), '进行中的步骤不画圆环也不画完成勾', icons.map((el) => el.props.name))
    ok(byTestId(runningNode.tree, 'v3-step').props['aria-expanded'] === false, '进行中的步骤详情默认不占版面')
  }

  group('需要审批：组头与单行都带小标')
  {
    const tools = [tool({ id: 'r-a', name: 'read' }), tool({ id: 'b-a', name: 'bash', args: { command: 'rm -rf x' }, status: 'running' })]
    const g = renderSub(renderSteps(tools, new Set(['b-a'])).tree, 'ToolGroupRow')
    ok(byTestId(g.tree, 'v3-step-group-approval') !== null, '组头带「需要审批」')
    ok(collect(g.tree, (el) => el.props && String(el.props.className || '').startsWith('v3-dot')).length === 0, '不靠状态点表示等待审批')
    const lone = renderSteps([tools[1]], new Set(['b-a']))
    const node = renderStepNode(lone.tree, 'b-a')
    ok(byTestId(node.tree, 'v3-step-approval') !== null, '单行带「需要审批」')
  }

  group('审批回执：已决定的调用单独成行，在原位置显示决定与时间')
  {
    toolExpansion.clear()
    const receipt = { id: 'ap-1', toolCallId: 'b-r', kind: 'danger', tool: 'bash', title: '难以撤销的操作', choice: 'deny', feedback: '先别删', askedAt: 1, at: 2 }
    const tools = [tool({ id: 'r-r', name: 'read' }), tool({ id: 'b-r', name: 'bash', args: { command: 'rm -rf x' }, status: 'error', denied: true, approval: receipt }), tool({ id: 'r-r2', name: 'read' })]
    const { tree } = renderSteps(tools)
    ok(byTypeName(tree, 'ToolGroupRow').length === 0 && byTypeName(tree, 'StepNode').length === 3, '带回执的调用不并进操作组，前后各自成行', byTypeName(tree, 'StepNode').length)
    const node = renderStepNode(tree, 'b-r')
    const receipts = byTypeName(node.tree, 'ApprovalReceipt')
    ok(receipts.length === 1 && receipts[0].props.approval === receipt, '单行下方挂上审批回执', receipts.length)
    const card = renderComponent(makeHookRuntime(), receipts[0].type, receipts[0].props)
    ok(card.props['data-choice'] === 'deny' && card.props['data-testid'] === 'v3-approval-receipt' && card.props.receipt === true, '回执用卡片的回执外观并标出决定', card.props['data-choice'])
    ok(textOf(card).includes('已拒绝') && textOf(card).includes('先别删'), '拒绝回执写出决定与反馈', textOf(card))
    const once = renderComponent(makeHookRuntime(), receipts[0].type, { approval: { ...receipt, choice: 'session', feedback: undefined } })
    ok(textOf(once).includes('本会话内允许') && !textOf(once).includes('先别删'), '会话内允许写出范围，不带反馈', textOf(once))
    const pending = renderComponent(makeHookRuntime(), node.el.type, { ...node.el.props, asking: true })
    ok(byTypeName(pending, 'ApprovalReceipt').length === 0 && byTypeName(pending, 'ApprovalCard').length === 1, '仍在等待审批时显示审批卡而不是回执')
  }

  group('并行大量调用：不同类别连续也合成一组；独立工具断开分组；同路径相邻折成一行')
  {
    const cmds = Array.from({ length: 7 }, (_, i) => tool({ id: `run-${i}`, name: 'bash', args: { command: `echo ${i}` } }))
    const reads = Array.from({ length: 5 }, (_, i) => tool({ id: `rd-${i}`, name: 'read', args: { path: `f${i}.ts` } }))
    const { tree } = renderSteps([...cmds, ...reads])
    const groupEls = byTypeName(tree, 'ToolGroupRow')
    ok(groupEls.length === 1, '7 个命令与 5 个读取合成一组', groupEls.length)
    const g = renderSub(tree, 'ToolGroupRow')
    ok(textOf(byTestId(g.tree, 'v3-step-group')) === '运行 7 条命令，读取 5 个文件', '组头写各类别与数量', textOf(byTestId(g.tree, 'v3-step-group')))
    ok(byTypeName(g.tree, 'StepNode').length === 0, '折叠时不铺逐条步骤')
    byTestId(g.tree, 'v3-step-group').props.onClick()
    const opened = renderComponent(g.rt, g.el.type, g.el.props)
    ok(byTypeName(opened, 'StepNode').length === 12, '点开后逐条展示 12 步', byTypeName(opened, 'StepNode').length)

    const broken = renderSteps([...cmds.slice(0, 3), tool({ id: 'ask', name: 'question' }), ...cmds.slice(3, 6)])
    ok(byTypeName(broken.tree, 'ToolGroupRow').length === 2 && byTypeName(broken.tree, 'QuestionReceipt').length === 1 && byTypeName(broken.tree, 'StepNode').length === 0, '提问工具独立成行（问答回执）并断开分组', byTypeName(broken.tree, 'QuestionReceipt').length)

    const rereads = Array.from({ length: 3 }, (_, i) => tool({ id: `same-${i}`, name: 'read', args: { path: 'docs/a.md' } }))
    const same = renderSub(renderSteps(rereads).tree, 'ToolGroupRow')
    ok(textOf(byTestId(same.tree, 'v3-step-group')) === '读取 a.md（3 次）', '同一路径多次读取合成文件段', textOf(byTestId(same.tree, 'v3-step-group')))
    byTestId(same.tree, 'v3-step-group').props.onClick()
    const sameOpen = renderComponent(same.rt, same.el.type, same.el.props)
    const rows = byTypeName(sameOpen, 'StepNode')
    ok(rows.length === 1 && rows[0].props.repeat === 3 && rows[0].props.node.call.id === 'same-2', '相邻同路径读取折成一行，显示最新一次', rows.map((el) => [el.props.node.call.id, el.props.repeat]))
  }

  group('长输出：先截断预览，展开后铺全（键盘可达的共享按钮）')
  {
    const output = longOutput(60)
    const { tree } = renderStepsOpen([tool({ id: 'read-long', name: 'read', output })])
    const node = renderStepNode(tree, 'read-long')
    byTestId(node.tree, 'v3-step').props.onClick()
    const nodeOpen = renderComponent(node.rt, node.el.type, node.el.props)
    const detail = renderSub(nodeOpen, 'StepDetail')
    const outputView = renderSub(detail.tree, 'StepOutput')

    const pre = byTestId(outputView.tree, 'v3-step-output')
    const preText = textOf(pre)
    ok(preText.split('\n').length === 16 && preText.includes('line-16'), '折叠时只渲染预览行数', preText.split('\n').length)
    ok(!preText.includes('line-17') && !preText.includes('line-60'), '超出预览的行不渲染（不是靠滚动藏起来）')

    let toggle = byTestId(outputView.tree, 'v3-step-output-toggle')
    ok(!!toggle && toggle.type.__stub === 'ui-button', '展开控件来自共享 ui Button', toggle && toggle.type && toggle.type.__stub)
    ok(toggle.props['aria-expanded'] === false, '展开控件初始 aria-expanded=false')
    ok(toggle.props.onPress !== undefined, '展开控件用 onPress（RAC 键盘可用）')
    ok(textOf(toggle) === '展开全部输出（60 行）', '展开控件写明总行数', textOf(toggle))

    toggle.props.onPress()
    const expandedView = renderComponent(outputView.rt, outputView.el.type, outputView.el.props)
    const expandedPre = textOf(byTestId(expandedView, 'v3-step-output'))
    ok(expandedPre.split('\n').length === 60 && expandedPre.includes('line-60'), '展开后铺全输出', expandedPre.split('\n').length)
    toggle = byTestId(expandedView, 'v3-step-output-toggle')
    ok(toggle.props['aria-expanded'] === true && textOf(toggle) === '收起输出', '再次点击可收起，按钮状态同步', { expanded: toggle.props['aria-expanded'], label: textOf(toggle) })

    const short = renderStepsOpen([tool({ id: 'read-short', name: 'read', output: 'one\ntwo' })])
    const shortNode = renderStepNode(short.tree, 'read-short')
    byTestId(shortNode.tree, 'v3-step').props.onClick()
    const shortOpen = renderComponent(shortNode.rt, shortNode.el.type, shortNode.el.props)
    const shortView = renderSub(renderSub(shortOpen, 'StepDetail').tree, 'StepOutput')
    ok(textOf(byTestId(shortView.tree, 'v3-step-output')).includes('one'), '短输出正常显示')
    ok(byTestId(shortView.tree, 'v3-step-output-toggle') === null, '短输出不给展开控件')
  }

  group('详情分节：bash 不重复写 Bash / 输出 小标题，有参数段时才分节标注')
  {
    const sectionHeads = (call) => {
      const { tree } = renderStepsOpen([call])
      const node = renderStepNode(tree, call.id)
      byTestId(node.tree, 'v3-step').props.onClick()
      const nodeOpen = renderComponent(node.rt, node.el.type, node.el.props)
      const detail = renderSub(nodeOpen, 'StepDetail')
      const heads = collect(detail.tree, (el) => el.props && el.props.className === 'v3-step-sec-head').map(textOf)
      const secs = collect(detail.tree, (el) => el.props && el.props.className === 'v3-step-sec').map((el) => el.props['data-sec'])
      return { heads, secs }
    }
    const bash = sectionHeads(tool({ id: 'sh-only', name: 'bash', args: { command: 'npm run typecheck' }, status: 'error', output: 'TS2322' }))
    ok(bash.heads.length === 0, 'bash 只有命令与输出：两段都不写小标题', bash.heads)
    ok(bash.secs.join() === 'command,output', 'bash 仍按命令、输出两段排列', bash.secs)
    const extra = sectionHeads(tool({ id: 'sh-cwd', name: 'bash', args: { command: 'ls', cwd: 'C:/a' }, output: 'a.txt' }))
    ok(extra.heads.join() === '参数,输出', 'bash 带额外参数：参数段与输出段保留小标题', extra.heads)
    const read = sectionHeads(tool({ id: 'read-args', name: 'read', args: { path: 'a.md' }, output: 'hello' }))
    ok(read.heads.length === 0 && read.secs.join() === 'path,output', '读文件首行是路径，不再写 JSON 参数段', read)
    const other = sectionHeads(tool({ id: 'other-args', name: 'mystery', args: { a: 1 }, output: 'hello' }))
    ok(other.heads.join() === '参数,输出', '其它工具有参数时仍分「参数 / 输出」', other.heads)
    const bare = sectionHeads(tool({ id: 'bare-out', name: 'mystery', args: {}, output: 'only output' }))
    ok(bare.heads.length === 0 && bare.secs.join() === 'output', '只有输出一段时不写小标题', bare)
  }

  group('英文文案同步（会话模块自有文案表）')
  {
    globalThis.__V3_LANG = 'en-US'
    const output = longOutput(30)
    const { tree } = renderStepsOpen([tool({ id: 'read-en', name: 'read', output })])
    const node = renderStepNode(tree, 'read-en')
    byTestId(node.tree, 'v3-step').props.onClick()
    const nodeOpen = renderComponent(node.rt, node.el.type, node.el.props)
    const outputView = renderSub(renderSub(nodeOpen, 'StepDetail').tree, 'StepOutput')
    ok(textOf(byTestId(outputView.tree, 'v3-step-output-toggle')) === 'Show all output (30 lines)', '英文展开文案存在且带行数', textOf(byTestId(outputView.tree, 'v3-step-output-toggle')))
    globalThis.__V3_LANG = 'zh-CN'
  }

  group('嵌套调用：缩进在父步骤下')
  {
    const { tree } = renderStepsOpen([
      tool({ id: 'parent', name: 'codemode', args: { code: 'x' } }),
      tool({ id: 'child', name: 'read', parentToolCallId: 'parent' })
    ])
    const collapsed = renderStepNode(tree, 'parent')
    ok(byTypeName(collapsed.tree, 'StepNode').length === 0, '收起且已结束的父步骤不列子调用（标题已汇总）')
    byTestId(collapsed.tree, 'v3-step').props.onClick()
    const parent = { ...collapsed, tree: renderComponent(collapsed.rt, collapsed.el.type, collapsed.el.props) }
    const nest = collect(parent.tree, (el) => el.props && String(el.props.className || '').includes('v3-step-nest'))
    ok(nest.length === 1, '展开后父步骤下有嵌套容器')
    const childEl = byTypeName(parent.tree, 'StepNode')
    ok(childEl.length === 1 && childEl[0].props.depth === 1, '子调用缩进一级', childEl.map((el) => el.props.depth))
    const child = renderComponent(makeHookRuntime(), childEl[0].type, childEl[0].props)
    ok(collect(child, (el) => el.props && el.props['data-depth'] === 1).length === 1, '子步骤根节点标记 depth=1')
  }

  group('嵌套调用：超过 3 条时只显示最后 3 条，前面折叠')
  {
    const kids = Array.from({ length: 7 }, (_, i) => tool({ id: 'kid-' + i, name: 'bash', args: { command: 'echo ' + i }, parentToolCallId: 'parent-many' }))
    const { tree } = renderStepsOpen([tool({ id: 'parent-many', name: 'codemode', args: { code: 'x' } }), ...kids])
    const collapsed = renderStepNode(tree, 'parent-many')
    byTestId(collapsed.tree, 'v3-step').props.onClick()
    const parent = { ...collapsed, tree: renderComponent(collapsed.rt, collapsed.el.type, collapsed.el.props) }
    const shown = byTypeName(parent.tree, 'StepNode')
    ok(shown.length === 3 && shown[0].props.node.call.id === 'kid-4', '只渲染最后 3 个子调用', shown.map((el) => el.props.node.call.id))
    const earlier = byTestId(parent.tree, 'v3-step-earlier')
    ok(earlier && textOf(earlier).includes('4'), '折叠按钮写出前面隐藏的数量', earlier && textOf(earlier))
    earlier.props.onPress()
    const again = renderComponent(parent.rt, parent.el.type, parent.el.props)
    ok(byTypeName(again, 'StepNode').length === 7, '点开后显示全部子调用', byTypeName(again, 'StepNode').length)
    ok(bundle.visibleNestedNodes([1, 2, 3], false).earlier === 0, '不超过 3 条时不折叠')
    const all = bundle.visibleNestedNodes([1, 2, 3, 4], false)
    ok(bundle.collapsedNest(all, [1, 2, 3, 4], false, true).shown.join() === '4', '收起但仍在运行时只显示正在执行的那条')
    ok(bundle.collapsedNest(all, [1, 2, 3, 4], false, false).shown.length === 0, '收起且已结束时不显示子调用')
    ok(bundle.collapsedNest(all, [1, 2, 3, 4], true, false).shown.join() === '2,3,4', '展开后按原折叠规则显示')
  }


  const openDetail = (call) => {
    const { tree } = renderStepsOpen([call])
    const node = renderStepNode(tree, call.id)
    byTestId(node.tree, 'v3-step').props.onClick()
    const nodeOpen = renderComponent(node.rt, node.el.type, node.el.props)
    return { node, nodeOpen, detail: renderSub(nodeOpen, 'StepDetail') }
  }

  const piDiff = ['   1 import a', '-  2 const old = 1', '+  2 const next = 2', '+  3 const more = 3', '   4 export {}', '     ...', '  40 tail'].join('\n')
  const piEdit = (over = {}) => tool({ id: 'pi-edit', name: 'edit', args: { path: 'src/pi.ts', edits: [{ oldText: 'a', newText: 'b' }] }, output: 'Successfully replaced 1 block(s) in src/pi.ts.', details: { diff: piDiff, patch: '@@', firstChangedLine: 2 }, ...over })

  group('#1 历史编辑：没有 fileDiff 时用 pi 的 details.diff 渲染带行号的增删行')
  {
    toolExpansion.clear()
    const { detail } = openDetail(piEdit())
    const change = renderSub(detail.tree, 'ChangeDetail')
    const diffEl = renderSub(change.tree, 'DiffLines')
    const lines = collect(diffEl.tree, (el) => el.props && el.props.className === 'v3-diff-line')
    ok(lines.map((el) => el.props['data-kind']).join() === 'context,del,add,add,context,skip,context', '按 pi 前缀分出上下文、删除、新增与省略', lines.map((el) => el.props['data-kind']))
    const nums = collect(diffEl.tree, (el) => el.props && el.props.className === 'v3-diff-num').map(textOf)
    ok(nums.slice(0, 4).join() === '1,2,2,3', '保留 pi 的行号', nums)
    ok(textOf(change.tree).includes('+2') && textOf(change.tree).includes('−1'), '路径行恢复 +a −b 统计', textOf(change.tree))
    ok(!textOf(change.tree).includes('tool.diffUnavailable'), '有 pi diff 时不再提示「没有快照」', textOf(change.tree))
    ok(byTypeName(change.tree, 'StepOutput').length === 0, '成功的编辑不再铺「Successfully replaced」')

    const g = renderSub(renderSteps([tool({ id: 'r-pi', name: 'read' }), piEdit()]).tree, 'ToolGroupRow')
    const stats = byTypeName(g.tree, 'ToolRunStats')[0]
    ok(stats.props.summary.added === 2 && stats.props.summary.removed === 1 && stats.props.summary.changedFiles === 1, '分组头同步拿到 pi diff 的增删', stats.props.summary)

    const argsOnly = openDetail(tool({ id: 'args-edit', name: 'edit', args: { path: 'x.ts', oldText: 'a\nb', newText: 'c' }, output: 'ok' }))
    const argsChange = renderSub(argsOnly.detail.tree, 'ChangeDetail')
    const argsDiff = renderSub(argsChange.tree, 'DiffLines')
    ok(collect(argsDiff.tree, (el) => el.props && el.props.className === 'v3-diff-line').map((el) => el.props['data-kind']).join() === 'del,del,add', '连 pi diff 也没有时显示调用里的替换片段', textOf(argsDiff.tree))
    ok(textOf(argsChange.tree).includes('tool.diffUnavailable'), '退回替换片段时仍说明没有快照')
  }

  group('#2 codemode：code 当代码块高亮显示，输出去掉固定前缀')
  {
    ok(detailKind('codemode') === 'code', 'codemode 归 code')
    const code = 'const r = await tools.read({ path: "a" })\nreturn r'
    const { detail } = openDetail(tool({ id: 'cm', name: 'codemode', args: { code }, output: 'Script completed\nWall time 1.4 seconds\nOutput:\nhello\nworld' }))
    const block = byTestId(detail.tree, 'v3-step-code')
    const hl = byTypeName(block, 'HighlightedCode')[0]
    ok(hl && hl.props.code === code && hl.props.lang === 'javascript', '代码交给 HighlightedCode，按 JavaScript 高亮', hl && hl.props)
    ok(!JSON.stringify(detail.tree.props.children).includes('\\"code\\"'), '不再显示 JSON 转义的参数')
    const out = renderSub(detail.tree, 'StepOutput')
    ok(out.el.props.text === 'hello\nworld', '输出去掉 Script completed / Wall time / Output: 前缀', out.el.props.text)
    ok(collect(detail.tree, (el) => el.props && el.props.className === 'v3-step-sec-head').length === 0, '只有代码与输出时不写小标题')
  }

  group('#3 MCP：标题去前缀带参数值，服务名放提示')
  {
    const node = renderStepNode(renderSteps([tool({ id: 'mcp', name: 'mcp__inkstone_minecraft__mc_view', args: { target: 'screen', project: 'demo' } })]).tree, 'mcp')
    const head = byTestId(node.tree, 'v3-step')
    ok(textOf(head).includes('mc_view') && !textOf(head).includes('mcp__'), '标题是去掉前缀的工具名', textOf(head))
    ok(textOf(head).includes('screen · demo'), '摘要是参数值', textOf(head))
    const line = collect(head, (el) => el.props && el.props.className === 'v3-step-line')[0]
    ok(line.props.title.includes('MCP 服务：inkstone_minecraft'), '服务名在提示里', line.props.title)
    ok(head.props.icon && head.props.icon.props.name === 'wrench', '未归类工具用通用图标', head.props.icon && head.props.icon.props.name)
  }

  group('#4 命令描述作主标题，后跟弱化的等宽命令预览；行首按类别放图标')
  {
    const node = renderStepNode(renderSteps([tool({ id: 'desc', name: 'bash', args: { command: 'rg -n "foo" src | head', description: '找调用点' } })]).tree, 'desc')
    const head = byTestId(node.tree, 'v3-step')
    ok(textOf(head).includes('找调用点'), '描述作主标题', textOf(head))
    const target = collect(head, (el) => el.props && el.props.className === 'v3-step-target')[0]
    ok(target && target.props['data-code'] === true && textOf(target) === 'rg -n "foo" src | head', '命令首行作等宽预览', target && textOf(target))
    ok(head.props.icon.props.name === 'terminal' && head.props.icon.props.size === 13, '命令行首是 13px 终端图标', head.props.icon.props)
    ok(stepIconName(tool({ name: 'read' })) === 'eye' && stepIconName(tool({ name: 'edit' })) === 'edit' && stepIconName(tool({ name: 'web_fetch' })) === 'globe', '读 / 改 / 联网分别用 eye / pen / globe')
    ok(stepIconName(tool({ name: 'bash', args: { command: 'yan subagent start --task x' } })) === 'bot', '派子代理用 bot')
    ok(stepIconName(tool({ name: 'codemode', args: { code: 'x' } })) === 'code', 'codemode 用代码图标')
    const g = renderSub(renderSteps([tool({ id: 'ga', name: 'read' }), tool({ id: 'gb', name: 'read' })]).tree, 'ToolGroupRow')
    ok(byTestId(g.tree, 'v3-step-group').props.icon.props.name === 'eye', '同类分组沿用该类图标')
    ok(groupIconName([{ call: tool({ name: 'read' }), children: [] }, { call: tool({ name: 'bash', args: { command: 'ls' } }), children: [] }]) === 'layers', '混合分组用 layers')
  }

  group('#6 长输出：命令与失败默认显示末尾，提示更早输出未显示；pi 截断提示变成一行说明')
  {
    const output = `${longOutput(60)}\n\n[Showing lines 1-60 of 900. Full output: C:\\tmp\\pi-bash.log]`
    const { detail } = openDetail(tool({ id: 'tail', name: 'bash', args: { command: 'npm test' }, output }))
    const out = renderSub(detail.tree, 'StepOutput')
    const pre = textOf(byTestId(out.tree, 'v3-step-output'))
    ok(pre.split('\n').length === 16 && pre.startsWith('line-45') && pre.endsWith('line-60'), '默认显示最后 16 行', pre.split('\n')[0])
    ok(textOf(byTestId(out.tree, 'v3-step-output-earlier')) === '更早的 44 行输出未显示', '写明更早的输出未显示', textOf(byTestId(out.tree, 'v3-step-output-earlier')))
    ok(!pre.includes('Showing lines'), 'pi 的截断提示不当正文')
    const notes = renderSub(detail.tree, 'OutputNotes')
    ok(textOf(byTestId(notes.tree, 'v3-step-output-notice')) === '显示第 1–60 行，共 900 行 · 输出过长，已截断 · 完整输出：C:\\tmp\\pi-bash.log', '截断提示变成一行弱化说明', textOf(byTestId(notes.tree, 'v3-step-output-notice')))
    byTestId(out.tree, 'v3-step-output-toggle').props.onPress()
    const all = renderComponent(out.rt, out.el.type, out.el.props)
    ok(textOf(byTestId(all, 'v3-step-output')).split('\n').length === 60 && byTestId(all, 'v3-step-output-earlier') === null, '展开后铺全且不再提示', textOf(byTestId(all, 'v3-step-output')).split('\n').length)
    const mcp = openDetail(tool({ id: 'mcp-trunc', name: 'mcp__s__build', args: {}, output: 'Warning: truncated output (original token count: 99999)\n[Full output: C:\\tmp\\o.txt (read it with offset/limit)]\nbody' }))
    ok(renderSub(mcp.detail.tree, 'StepOutput').el.props.text === 'body', 'MCP 截断警告不进正文', renderSub(mcp.detail.tree, 'StepOutput').el.props.text)
    ok(textOf(byTestId(renderSub(mcp.detail.tree, 'OutputNotes').tree, 'v3-step-output-notice')).includes('C:\\tmp\\o.txt'), 'MCP 截断说明带完整输出位置')
  }

  group('#7 失败：只把状态标记染红，错误正文正常色、首行加粗，退出码单独一行')
  {
    const failed = tool({ id: 'fail', name: 'bash', args: { command: 'npm run build' }, status: 'error', output: 'Error: TS2322 bad\n  at a.ts:1\n\nCommand exited with code 2' })
    const node = renderStepNode(renderSteps([failed]).tree, 'fail')
    const mark = byTestId(node.tree, 'v3-step-failed')
    ok(mark && mark.props['aria-label'] === '失败' && mark.props.role === 'img', '标题行带可读的失败标记', mark && mark.props)
    const { detail } = openDetail(failed)
    const out = renderSub(detail.tree, 'StepOutput')
    ok(out.el.props.text === 'Error: TS2322 bad\n  at a.ts:1', '退出码不混在正文里', out.el.props.text)
    const lead = collect(out.tree, (el) => el.props && el.props.className === 'v3-step-out-lead')
    ok(lead.length === 1 && textOf(lead[0]) === 'Error: TS2322 bad', '错误首行单独加粗', lead.map(textOf))
    const exit = byTestId(renderSub(detail.tree, 'OutputNotes').tree, 'v3-step-exit')
    ok(textOf(exit) === '退出码 2', '非 0 退出码单独一行', textOf(exit))
    const okNode = renderStepNode(renderSteps([tool({ id: 'okc', name: 'bash', args: { command: 'ls' }, output: 'a' })]).tree, 'okc')
    ok(byTestId(okNode.tree, 'v3-step-failed') === null, '成功时没有失败标记')
  }

  group('#8 读文件：展开首行是项目相对路径加范围')
  {
    const { detail } = openDetail(tool({ id: 'rr', name: 'read', args: { path: 'E:\\repo\\docs\\r3.md', offset: 105, limit: 95 }, output: 'x' }))
    const path = byTestId(detail.tree, 'v3-step-read-path')
    ok(textOf(path).includes('r3.md') && textOf(path).includes('105–199 行'), '路径行带行范围', textOf(path))
    ok(!textOf(detail.tree).includes('"path"'), '不再显示 JSON 参数')
  }

  group('#9 写文件：没有 diff 时显示内容前 40 行与总行数，可展开')
  {
    const content = Array.from({ length: 55 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
    const { detail } = openDetail(tool({ id: 'wr', name: 'write', args: { path: 'notes/a.md', content }, output: 'Successfully wrote to notes/a.md' }))
    const change = renderSub(detail.tree, 'ChangeDetail')
    ok(textOf(change.tree).includes('共 55 行'), '路径行写总行数', textOf(change.tree))
    ok(byTypeName(change.tree, 'StepOutput').length === 0, '成功时不铺「Successfully wrote」')
    const preview = renderSub(change.tree, 'FileContentPreview')
    const hl = byTypeName(preview.tree, 'HighlightedCode')[0]
    ok(hl.props.code.split('\n').length === 40 && hl.props.lang === 'md', '默认只显示前 40 行并按扩展名高亮', [hl.props.code.split('\n').length, hl.props.lang])
    const toggle = byTestId(preview.tree, 'v3-step-content-toggle')
    ok(textOf(toggle) === '展开全部内容（55 行）' && toggle.props['aria-expanded'] === false, '展开控件写明行数', textOf(toggle))
    toggle.props.onPress()
    const all = renderComponent(preview.rt, preview.el.type, preview.el.props)
    ok(byTypeName(all, 'HighlightedCode')[0].props.code.split('\n').length === 55, '展开后显示全部内容')
  }

  group('#10 历史里的 yan search / yan browser JSON 解析成标题加要点')
  {
    const json = JSON.stringify({ ok: true, operationId: '9be2bd50-6850-495f-a810-3393dfb1707c', summary: { kind: 'search', action: 'query', count: 18, queries: [{ query: 'Swift 1.5', count: 6, summary: '6 条结果 · ddg 6 条' }, { query: 'Qwen3.8', count: 12 }] } })
    const search = openDetail(tool({ id: 'ys', name: 'bash', args: { command: 'yan search query --query-text "Swift 1.5" 2>&1 | tail -20; ls ~/models' }, output: `${json}\nmodel-a` }))
    const list = renderSub(search.detail.tree, 'YanSummaryList')
    ok(textOf(list.tree).includes('联网搜索 · 18 条结果'), '搜索摘要显示成标题', textOf(list.tree))
    ok(textOf(list.tree).includes('Swift 1.5 · 6 条结果 · ddg 6 条') && textOf(list.tree).includes('Qwen3.8 · 12'), '每个查询一条要点', textOf(list.tree))
    ok(renderSub(search.detail.tree, 'StepOutput').el.props.text === 'model-a', '其余非 JSON 输出照常显示')
    const browserJson = JSON.stringify({ ok: true, summary: { kind: 'browser', action: 'run', ok: true, url: 'https://www.google.com/travel/flights', title: 'Sydney to Tokyo | Google Flights', logs: 3, logTail: ['URL: https://www.google.com/travel/flights', 'LEN: 2105', 'Skip to main content\nmore'] } })
    const browser = openDetail(tool({ id: 'yb', name: 'bash', args: { command: 'yan browser run --file x.mjs 2>&1 | tail -5' }, output: browserJson }))
    const blist = renderSub(browser.detail.tree, 'YanSummaryList')
    ok(textOf(blist.tree).startsWith('Sydney to Tokyo | Google Flights'), '浏览器操作以页面标题作标题', textOf(blist.tree))
    ok(textOf(blist.tree).includes('LEN: 2105') && !textOf(blist.tree).includes('URL: https'), '要点取日志尾部，跳过重复的地址行', textOf(blist.tree))
    ok(byTypeName(browser.detail.tree, 'StepOutput').length === 0, '整段都是 JSON 时不再铺原文')
    const guideJson = JSON.stringify({ ok: true, summary: { kind: 'browser', action: 'api', ok: true, guide: '砚内置浏览器脚本\n\npage.goto(url)  打开页面' } })
    const guide = openDetail(tool({ id: 'yg', name: 'bash', args: { command: 'yan browser api 2>&1 | head -60' }, output: guideJson }))
    const glist = renderSub(guide.detail.tree, 'YanSummaryList')
    ok(textOf(glist.tree).includes('browser api'), '没有标题时用动作作标题', textOf(glist.tree))
    const body = byTypeName(glist.tree, 'StepOutput')[0]
    ok(body && body.props.text.includes('page.goto(url)'), '摘要里的长文本字段照常显示，不被丢掉', body && body.props.text)
    const broken = openDetail(tool({ id: 'yx', name: 'bash', args: { command: 'yan search query --query-text x' }, output: '{"ok":true,"summary":' }))
    ok(byTypeName(broken.detail.tree, 'YanSummaryList').length === 0 && renderSub(broken.detail.tree, 'StepOutput').el.props.text === '{"ok":true,"summary":', '解析失败保持原样')
    const plainCmd = openDetail(tool({ id: 'yp', name: 'bash', args: { command: 'cat a.json' }, output: json }))
    ok(byTypeName(plainCmd.detail.tree, 'YanSummaryList').length === 0, '非 yan 命令的 JSON 不改写')
  }

  group('录屏追加：命令折叠行带状态图标与退出码，测试命令带通过/失败小标签，单文件编辑带增删')
  {
    const head = (call) => byTestId(renderStepNode(renderSteps([call]).tree, call.id).tree, 'v3-step')
    const running = head(tool({ id: 'st-run', name: 'bash', args: { command: 'sleep 3', description: '等待' }, status: 'running' }))
    const spin = collect(running, (el) => typeof el.type === 'function' && el.type.name === 'Spinner')
    ok(spin.length === 1 && spin[0].props.label === '运行中', '运行中的命令带转圈与读屏文字', spin.map((el) => el.props))
    const done = head(tool({ id: 'st-ok', name: 'bash', args: { command: 'ls' }, output: 'a' }))
    ok(byTestId(done, 'v3-step-done') !== null && byTestId(done, 'v3-step-failed') === null, '完成的命令带完成标记')
    const failedHead = head(tool({ id: 'st-err', name: 'bash', args: { command: 'npm run build' }, status: 'error', output: 'boom\n\nCommand exited with code 2' }))
    ok(byTestId(failedHead, 'v3-step-failed') !== null && textOf(byTestId(failedHead, 'v3-step-exit-code')) === '退出码 2', '失败的命令带失败标记与非 0 退出码', textOf(failedHead))
    ok(byTestId(head(tool({ id: 'st-read', name: 'read', args: { path: 'a' }, output: 'x' })), 'v3-step-done') === null, '非命令工具不加完成标记')
    const testOut = `${longOutput(80)}\n# tests 15\n# pass 14\n# fail 1\n\nCommand exited with code 1`
    const testHead = head(tool({ id: 'st-test', name: 'bash', args: { command: 'npm test', description: '运行测试' }, status: 'error', output: testOut }))
    const badge = byTestId(testHead, 'v3-step-tests')
    ok(badge && badge.props.tone === 'fail' && textOf(badge) === '14 通过 / 1 失败', '测试命令带「N 通过 / M 失败」小标签', badge && textOf(badge))
    const passHead = head(tool({ id: 'st-pass', name: 'bash', args: { command: 'npx vitest run' }, output: ' Test Files  3 passed (3)\n      Tests  15 passed (15)' }))
    ok(byTestId(passHead, 'v3-step-tests').props.tone === 'ok' && textOf(byTestId(passHead, 'v3-step-tests')) === '15 通过 / 0 失败', '全部通过时用成功色，取末尾的测试数', textOf(byTestId(passHead, 'v3-step-tests')))
    ok(byTestId(head(tool({ id: 'st-nt', name: 'bash', args: { command: 'echo 3 passed' }, output: '3 passed' })), 'v3-step-tests') === null, '非测试命令不加小标签')
    const { detail } = openDetail(tool({ id: 'st-test2', name: 'bash', args: { command: 'npm test' }, status: 'error', output: testOut }))
    const out = textOf(byTestId(renderSub(detail.tree, 'StepOutput').tree, 'v3-step-output'))
    ok(out.includes('# pass 14') && out.includes('# fail 1'), '测试输出截断时保留末尾汇总', out.slice(-40))
    const editHead = head(diffCall())
    const stat = byTypeName(editHead, 'DiffStat')[0]
    ok(stat && stat.props.added === 2 && stat.props.removed === 1, '单文件编辑折叠行带 +a −b', stat && stat.props)
    const piHead = head(piEdit())
    ok(byTypeName(piHead, 'DiffStat')[0]?.props.removed === 1, '历史编辑的折叠行也带增删')
    ok(byTypeName(head(tool({ id: 'st-edit-err', name: 'edit', args: { path: 'a' }, status: 'error', output: 'x' })), 'DiffStat').length === 0, '失败的编辑不写增删')
  }
  process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '有失败项'}：${report.pass} 通过 / ${report.fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(report.fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
