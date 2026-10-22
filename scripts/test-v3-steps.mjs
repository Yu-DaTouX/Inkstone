#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
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
  await writeFile(entry, `export { ToolSteps, detailKind, visibleNestedNodes, collapsedNest } from '${posix(abs('src/renderer/src/features/session/ToolSteps.tsx'))}'\nexport { toolExpansion } from '${posix(abs('src/renderer/src/features/session/tool-expansion.ts'))}'\n`)
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
      return tree
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
  const { ToolSteps, detailKind, toolExpansion } = bundle

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

  group('失败：组头写失败数，失败只留红字，不再自动展开')
  {
    const { tree } = renderSteps([
      tool({ id: 'read-3', name: 'read' }),
      tool({ id: 'bash-err', name: 'bash', args: { command: 'false' }, status: 'error', output: 'Permission denied' })
    ])
    const g = renderSub(tree, 'ToolGroupRow')
    const head = byTestId(g.tree, 'v3-step-group')
    ok(head.props['aria-expanded'] === false, '有失败也保持折叠', head.props['aria-expanded'])
    ok(textOf(head).includes('（1 个失败）'), '摘要写失败数', textOf(head))
    ok(collect(g.tree, (el) => el.type && el.type.__stub === 'ui-badge' && el.props.tone === 'fail').length === 0, '组头不再挂失败徽标')
    head.props.onClick()
    const opened = renderComponent(g.rt, g.el.type, g.el.props)
    const failedNode = renderStepNode(opened, 'bash-err')
    ok(byTestId(failedNode.tree, 'v3-step').props['aria-expanded'] === false, '失败那一步默认折叠')
    ok(collect(failedNode.tree, (el) => el.type && el.type.__stub === 'ui-badge').length === 0, '失败那一步不挂徽标')
    ok(textOf(byTestId(failedNode.tree, 'v3-step')).includes('运行失败'), '失败那一步的标题用失败时态的动词', textOf(byTestId(failedNode.tree, 'v3-step')))
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

  process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '有失败项'}：${report.pass} 通过 / ${report.fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(report.fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
