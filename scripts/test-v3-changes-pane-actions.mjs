#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

function importedNames(fromPattern) {
  const dir = join(ROOT, 'src/renderer/src/features/changes')
  const names = new Set()
  for (const entry of readdirSync(dir)) {
    if (!/\.tsx?$/.test(entry)) continue
    const source = readFileSync(join(dir, entry), 'utf8')
    for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*(['"][^'"]+['"])/g)) {
      if (!fromPattern.test(match[2])) continue
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name && !part.trim().startsWith('type ')) names.add(name)
      }
    }
  }
  return [...names]
}

const REACT_SHIM = `const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useInsertionEffect() {}
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn, deps) { return rt().useMemo(fn, deps) }
export function useCallback(fn, deps) { return rt().useCallback(fn, deps) }
export function useId() { return rt().useId() }
export function useContext(ctx) { return ctx && '__value' in ctx ? ctx.__value : null }
export function createContext(value) { return { __isContext: true, __value: value, Provider: (p) => (p ? p.children : null) } }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out, key: out.key === undefined ? null : out.key } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export function isValidElement(el) { return !!el && typeof el === 'object' && 'type' in el && 'props' in el }
export default { Fragment, useState, useEffect, useLayoutEffect, useInsertionEffect, useRef, useMemo, useCallback, useId, useContext, createContext, createElement, forwardRef, memo, isValidElement }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

const UI_STUB = [...importedNames(/['"](?:\.\.\/)+ui['"]/), 'TextField']
  .filter((name, index, all) => name !== 'cx' && all.indexOf(name) === index)
  .map((name) => `export function ${name}() { return null }`)
  .concat("export function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' ') }")
  .join('\n')

const ICON_STUB = `export function FileTypeIcon() { return null }`

const I18N_STUB = `export function useI18n() { return { lang: 'zh-CN', setLang() {}, toggleLang() {}, t: (k) => String(k) } }
export function useT() { return (k) => String(k) }
export function translate(_lang, key) { return String(key) }`

const UI_TEXT_STUB = `export function uiText(key) { return String(key) }`

const CHROME_STUB = `export function PaneTools() { return null }
export function usePaneChrome() { return null }
export function usePaneMenu() {}`

const DIFF_STUB = `export function ChangesFileDiff() { return null }`

const LUCIDE_STUB = importedNames(/['"]lucide-react['"]/)
  .map((name) => `export function ${name}() { return null }`)
  .join('\n')

function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/ui/FileTypeIcon.tsx': ICON_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/i18n/ui-text.ts': UI_TEXT_STUB,
      'src/renderer/src/features/workbench/pane-chrome.tsx': CHROME_STUB,
      'src/renderer/src/features/changes/ChangesFileDiff.tsx': DIFF_STUB
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

function stubPlugin(stubMap, reactShimPath, jsxShimPath) {
  return {
    name: 'v3-changes-pane-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'react') return { path: reactShimPath }
        if (args.path === 'react/jsx-runtime') return { path: jsxShimPath }
        if (args.path === 'react/jsx-dev-runtime') return { path: jsxShimPath }
        if (args.path === 'lucide-react') return { path: 'v3stub:lucide', namespace: 'v3stub' }
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (stubMap.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        if (args.path === 'v3stub:lucide') return { contents: LUCIDE_STUB, loader: 'js' }
        const key = args.path.slice('v3stub:'.length)
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
      })
    }
  }
}

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entry = join(outdir, 'changes-pane-entry.ts')
  await writeFile(
    entry,
    `export { ChangesPane } from '${posix(resolve(ROOT, 'src/renderer/src/features/changes/ChangesPane.tsx'))}'
export { Button } from '${posix(resolve(ROOT, 'src/renderer/src/ui/index.ts'))}'
`
  )
  const outfile = join(outdir, 'changes-pane-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    plugins: [stubPlugin(makeStubMap(), reactShim, jsxShim)]
  })
  return outfile
}

function sameDeps(prev, next) {
  if (!prev || !next || prev.length !== next.length) return false
  return prev.every((value, index) => Object.is(value, next[index]))
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
    useMemo(fn, deps) {
      const c = rt.slot('memo')
      if (!c.has || deps === undefined || !sameDeps(c.deps, deps)) {
        c.value = fn()
        c.deps = deps ? [...deps] : undefined
        c.has = true
      }
      return c.value
    },
    useCallback(fn, deps) {
      const c = rt.slot('callback')
      if (!c.has || deps === undefined || !sameDeps(c.deps, deps)) {
        c.value = fn
        c.deps = deps ? [...deps] : undefined
        c.has = true
      }
      return c.value
    },
    useEffect(fn, deps) {
      const c = rt.slot('effect')
      const changed = !c.has || deps === undefined || !sameDeps(c.deps, deps)
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

async function flush(rt, Component, props, rounds = 8) {
  let tree = null
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await Promise.resolve()
    tree = rt.render(Component, props)
  }
  return tree
}

function childrenArray(kids) {
  if (kids === undefined || kids === null || kids === false || kids === true) return []
  if (Array.isArray(kids)) return kids.flatMap(childrenArray)
  return [kids]
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const kid of childrenArray(node.props?.children)) walk(kid, visit)
}

function findAllByType(node, type) {
  const hits = []
  walk(node, (el) => {
    if (el?.type === type) hits.push(el)
  })
  return hits
}

function textOf(node) {
  return childrenArray(node?.props?.children)
    .map((kid) => (typeof kid === 'string' ? kid : textOf(kid)))
    .join('')
}

const HEAD = 'a'.repeat(40)
const STALE_MESSAGE = '仓库状态在你操作前发生了变化，已为你刷新'

function fixtures(actionResult) {
  const reads = { state: 0, changes: 0 }
  const repo = {
    root: 'C:/proj/demo',
    name: 'demo',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    branch: 'main',
    detached: false,
    unborn: false,
    head: HEAD,
    upstream: null,
    ahead: 0,
    behind: 0,
    busyBranches: [],
    changedCount: 1,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
    unpushedCount: null,
    hasCommit: true
  }
  const files = [
    { x: '.', y: 'M', path: 'a.txt', untracked: false, ignored: false, unmerged: false, staged: false, unstaged: true }
  ]
  const source = {
    async state() {
      reads.state += 1
      return { repo, expected: { head: HEAD, indexDigest: 'index-1', statusDigest: 'status-1' } }
    },
    async untracked() {
      return []
    },
    async changes() {
      reads.changes += 1
      return {
        files,
        head: HEAD,
        scopeKind: 'working',
        baseRef: null,
        baseSha: null,
        targetSha: null,
        added: 1,
        removed: 0,
        patches: {}
      }
    }
  }
  const action = async () => {
    reads.action = (reads.action ?? 0) + 1
    return actionResult
  }
  return { reads, source, action }
}

async function run() {
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-changes-pane-'))
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
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
  globalThis.__V3_HOOKS = makeHookRuntime()

  try {
    const mod = await import(pathToFileURL(await buildBundle(outdir)).href)
    const { ChangesPane, Button } = mod
    const owner = { key: 'sess-a', cwd: 'C:/proj/demo', active: true }

    assert.equal(typeof ChangesPane, 'function', 'ChangesPane 应能浅渲染')

    {
      const { reads, source, action } = fixtures({ ok: false, failure: { code: 'stale', message: STALE_MESSAGE, retrySafe: false } })
      globalThis.window = { yan: { git: { action } }, addEventListener() {}, removeEventListener() {} }
      const props = { owner, gitSource: source }
      const tree = await flush(globalThis.__V3_HOOKS, ChangesPane, props)
      assert.equal(reads.state, 1, '首次渲染应读一次仓库状态')
      assert.equal(reads.changes, 1, '首次渲染应读一次改动列表')

      const actionable = findAllByType(tree, Button).filter((el) => typeof el.props?.onPress === 'function' && !el.props.isDisabled)
      assert.equal(actionable.length, 1, `可点击的写操作按钮应只有一个，实际 ${actionable.length}`)
      await actionable[0].props.onPress()
      const after = await flush(globalThis.__V3_HOOKS, ChangesPane, props)

      assert.equal(reads.action, 1, '点了按钮应真的调用 git action')
      assert.equal(reads.state, 2, 'stale 失败后必须重新读仓库状态（否则 expected 永远过期）')
      assert.equal(reads.changes, 2, 'stale 失败后必须重新读改动列表')
      const alerts = []
      walk(after, (el) => {
        if (el?.props?.role === 'alert' || (el?.props?.tone === 'fail' && el?.props?.role === undefined)) alerts.push(textOf(el))
      })
      assert.ok(
        alerts.some((line) => line.includes(STALE_MESSAGE)),
        `失败提示仍要留在界面上，实际 ${JSON.stringify(alerts)}`
      )
    }

    {
      const { reads, source, action } = fixtures({ ok: false, failure: { code: 'hook', message: 'pre-commit 拒绝', retrySafe: false } })
      globalThis.window = { yan: { git: { action } }, addEventListener() {}, removeEventListener() {} }
      globalThis.__V3_HOOKS = makeHookRuntime()
      const props = { owner, gitSource: source }
      const tree = await flush(globalThis.__V3_HOOKS, ChangesPane, props)
      const actionable = findAllByType(tree, Button).filter((el) => typeof el.props?.onPress === 'function' && !el.props.isDisabled)
      assert.equal(actionable.length, 1)
      await actionable[0].props.onPress()
      await flush(globalThis.__V3_HOOKS, ChangesPane, props)
      assert.equal(reads.action, 1)
      assert.equal(reads.state, 1, '非 stale 失败不额外重读（面板只在状态真的过期时才刷新）')
    }

    console.log('test-v3-changes-pane-actions: 全部通过')
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
