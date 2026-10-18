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
  await writeFile(entry, `export { ToolSteps, detailKind } from '${posix(abs('src/renderer/src/features/session/ToolSteps.tsx'))}'\n`)
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
        'src/renderer/src/features/artifacts/McpAppFrame.tsx': `export function McpAppResult(){ return null }\nexport function McpAppStepAudit(){ return null }`,
        'src/renderer/src/ui/index.ts': `export function Button(props){ return null }\nButton.__stub='ui-button'\nexport function IconButton(props){ return null }\nIconButton.__stub='ui-iconbutton'\nexport function ShimmerText(props){ return [props.lead ?? null, props.children] }\nexport function CompletionSweep(){ return null }`,
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
  const { ToolSteps, detailKind } = bundle

  const renderSteps = (tools) => {
    const rt = makeHookRuntime()
    return { rt, tree: renderComponent(rt, ToolSteps, { tools }) }
  }
  const renderStepsOpen = (tools) => {
    const rt = makeHookRuntime()
    const first = renderComponent(rt, ToolSteps, { tools })
    const summary = byTestId(first, 'v3-steps-toggle')
    if (summary.props['aria-expanded'] === false) summary.props.onClick()
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

  group('摘要行：默认折叠、真实增删数、缺快照不编造')
  {
    const { tree } = renderSteps([tool({ id: 'read-1', name: 'read' }), diffCall()])
    const summary = byTestId(tree, 'v3-steps-toggle')
    ok(!!summary && summary.type === 'button', '摘要是一个原生 button（可聚焦）')
    ok(summary.props['aria-expanded'] === false, '没有失败时摘要默认折叠', summary.props['aria-expanded'])
    ok(byTestId(tree, 'v3-steps-list') === null, '折叠时不铺步骤列表')
    ok(textOf(summary).includes('已读取 1 个文件') && textOf(summary).includes('已编辑 1 个文件'), '摘要按类别写（已读取 / 已编辑）', textOf(summary))
    const stats = collect(summary, (el) => el.props && String(el.props.className || '').includes('v3-steps-stats'))
    ok(stats.length === 1 && textOf(stats[0]) === '+2−1', '只按有快照的改动统计增删（+2−1）', stats.map(textOf))

    const noSnap = renderSteps([tool({ id: 'read-2', name: 'read' }), tool({ id: 'write-1', name: 'write', args: { path: 'x' }, output: 'w' })])
    const noStats = collect(byTestId(noSnap.tree, 'v3-steps-toggle'), (el) => el.props && String(el.props.className || '').includes('v3-steps-stats'))
    ok(noStats.length === 0, '没有执行前后快照时不写增删，也不编造文件数', noStats.length)
  }

  group('失败时：摘要自动展开，失败的那一步详情也自动展开')
  {
    const { tree } = renderSteps([
      tool({ id: 'read-3', name: 'read' }),
      tool({ id: 'bash-err', name: 'bash', args: { command: 'false' }, status: 'error', output: 'Permission denied' })
    ])
    const summary = byTestId(tree, 'v3-steps-toggle')
    ok(summary.props['aria-expanded'] === true, '有失败时摘要自动展开', summary.props['aria-expanded'])
    ok(byTestId(tree, 'v3-steps-list') !== null, '展开后步骤列表出现')
    ok(textOf(summary).includes('（1 个失败）'), '摘要写失败数', textOf(summary))

    const failedNode = renderStepNode(tree, 'bash-err')
    const failedHead = byTestId(failedNode.tree, 'v3-step')
    ok(failedHead.props['aria-expanded'] === true, '失败那一步的详情自动展开', failedHead.props['aria-expanded'])
    ok(byTypeName(failedNode.tree, 'StepDetail').length === 1, '失败那一步渲染详情')

    const okNode = renderStepNode(tree, 'read-3')
    const okHead = byTestId(okNode.tree, 'v3-step')
    ok(okHead.props['aria-expanded'] === false, '成功那一步保持折叠', okHead.props['aria-expanded'])
    ok(byTypeName(okNode.tree, 'StepDetail').length === 0, '成功那一步不渲染详情')
  }

  group('用户手动开合优先于失败自动展开')
  {
    const { rt, tree } = renderSteps([tool({ id: 'bash-e', name: 'bash', args: { command: 'false' }, status: 'error' })])
    const summary = byTestId(tree, 'v3-steps-toggle')
    summary.props.onClick()
    const after = renderComponent(rt, ToolSteps, { tools: [tool({ id: 'bash-e', name: 'bash', args: { command: 'false' }, status: 'error' })] })
    ok(byTestId(after, 'v3-steps-toggle').props['aria-expanded'] === false, '手动收起后即使有失败也保持收起')
  }

  group('运行中：折叠态单独铺出进行中的那一步')
  {
    const { tree } = renderSteps([
      tool({ id: 'read-4', name: 'read' }),
      tool({ id: 'bash-run', name: 'bash', args: { command: 'sleep 1' }, status: 'running', startedAt: 1 })
    ])
    ok(byTestId(tree, 'v3-steps-list') === null, '没有失败时列表仍折叠')
    const live = byTestId(tree, 'v3-steps-live')
    ok(!!live, '折叠态有专门的进行中区域')
    const liveNodes = byTypeName(live, 'StepNode')
    ok(liveNodes.length === 1 && liveNodes[0].props.node.call.id === 'bash-run', '进行中区域只放未收敛的那一步', liveNodes.map((el) => el.props.node.call.id))

    const runningNode = renderStepNode(tree, 'bash-run')
    const icons = collect(runningNode.tree, (el) => typeof el.type === 'function' && el.type.name === 'Icon')
    ok(!icons.some((el) => el.props.name === 'spinner' || el.props.name === 'check'), '进行中的步骤不画圆环也不画完成勾，只留呼吸的状态点', icons.map((el) => el.props.name))
    ok(byTestId(runningNode.tree, 'v3-step').props['aria-expanded'] === false, '进行中的步骤详情默认不占版面')

    const pending = renderSteps([tool({ id: 'p-1', name: 'read', status: 'pending' })])
    ok(byTestId(pending.tree, 'v3-steps-live') !== null, 'pending 也算进行中')
  }

  group('并行大量调用：连续同类合并成一行，点开才逐条看')
  {
    const cmds = Array.from({ length: 7 }, (_, i) => tool({ id: `run-${i}`, name: 'bash', args: { command: `echo ${i}` } }))
    const reads = Array.from({ length: 5 }, (_, i) => tool({ id: `rd-${i}`, name: 'read', args: { path: `f${i}.ts` } }))
    const { tree } = renderStepsOpen([...cmds, ...reads])
    const groupEls = byTypeName(tree, 'StepGroupRow')
    ok(groupEls.length === 2, '7 个命令与 5 个读取各合并成一行', groupEls.length)
    ok(byTypeName(tree, 'StepNode').length === 0, '合并行折叠时不铺逐条步骤')
    const renderGroup = (el) => {
      const rt = makeHookRuntime()
      return { rt, el, tree: renderComponent(rt, el.type, el.props) }
    }
    const first = renderGroup(groupEls[0])
    const second = renderGroup(groupEls[1])
    ok(textOf(byTestId(first.tree, 'v3-step-group')) === '运行 7 个命令' && textOf(byTestId(second.tree, 'v3-step-group')) === '读取 5 个文件', '合并行写类别与数量', [textOf(byTestId(first.tree, 'v3-step-group')), textOf(byTestId(second.tree, 'v3-step-group'))])
    ok(byTestId(first.tree, 'v3-step-group').props['aria-expanded'] === false, '合并行默认折叠')
    byTestId(first.tree, 'v3-step-group').props.onClick()
    const opened = renderComponent(first.rt, first.el.type, first.el.props)
    ok(byTypeName(opened, 'StepNode').length === 7, '点开后逐条展示 7 个命令', byTypeName(opened, 'StepNode').length)

    const few = renderStepsOpen([tool({ id: 'a', name: 'bash' }), tool({ id: 'b', name: 'bash' }), tool({ id: 'c', name: 'read' })])
    ok(byTypeName(few.tree, 'StepGroupRow').length === 0 && byTypeName(few.tree, 'StepNode').length === 3, '不足 3 个同类时保持逐条', byTypeName(few.tree, 'StepNode').length)

    const broken = renderStepsOpen([...cmds.slice(0, 3), tool({ id: 'g', name: 'grep' }), ...cmds.slice(3, 6)])
    ok(byTypeName(broken.tree, 'StepGroupRow').length === 2 && byTypeName(broken.tree, 'StepNode').length === 1, '被别的类别打断后分别合并', byTypeName(broken.tree, 'StepNode').length)

    const mixed = cmds.slice(0, 4).map((c, i) => i === 1 ? { ...c, status: 'error', output: 'boom' } : i === 3 ? { ...c, status: 'running', startedAt: 1 } : c)
    const gt = renderSteps(mixed).tree
    const failing = renderGroup(byTypeName(gt, 'StepGroupRow')[0])
    const extraIds = byTypeName(failing.tree, 'StepNode').map((el) => el.props.node.call.id)
    ok(extraIds.join() === 'run-1,run-3', '折叠的合并行下仍露出失败与进行中的那几条', extraIds)
    ok(collect(failing.tree, (el) => el.props && el.props.className === 'v3-badge err').length === 1, '合并行头部带失败徽标')
  }


  group('运行中折叠态：进行中的步骤最多露出最近几条')
  {
    const running = Array.from({ length: 7 }, (_, i) => tool({ id: `live-${i}`, name: 'bash', args: { command: `sleep ${i}` }, status: 'running', startedAt: 1 }))
    const { tree } = renderSteps(running)
    const live = byTestId(tree, 'v3-steps-live')
    const ids = byTypeName(live, 'StepNode').map((el) => el.props.node.call.id)
    ok(ids.join() === 'live-4,live-5,live-6', '只露最近 3 条进行中的', ids)
    const more = byTypeName(live, 'MoreRow')[0]
    ok(!!more && more.props.count === 4, '其余收进「另外 4 项」', more && more.props)
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
    const parent = renderStepNode(tree, 'parent')
    const nest = collect(parent.tree, (el) => el.props && String(el.props.className || '').includes('v3-step-nest'))
    ok(nest.length === 1, '父步骤下有嵌套容器')
    const childEl = byTypeName(parent.tree, 'StepNode')
    ok(childEl.length === 1 && childEl[0].props.depth === 1, '子调用缩进一级', childEl.map((el) => el.props.depth))
    const child = renderComponent(makeHookRuntime(), childEl[0].type, childEl[0].props)
    ok(collect(child, (el) => el.props && el.props['data-depth'] === 1).length === 1, '子步骤根节点标记 depth=1')
  }

  process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '有失败项'}：${report.pass} 通过 / ${report.fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(report.fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
