#!/usr/bin/env node
import './lib/test-isolate.mjs'
import { resolve } from 'node:path'
import { parseHTML } from 'linkedom'
import { runSuite } from './lib/test-suite.mjs'

const storeStub = `import { create } from 'zustand'
export const useStore = create(() => ({ sessions: [], session: null, peekedSessionId: null, peekedPath: null }))`
const actionsStub = `export const focused = []
export function focusSplitSession(ref) { focused.push(ref) }`

const stubs = {
  name: 'split-persistence-stubs',
  setup(build) {
    build.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    build.onResolve({ filter: /split-actions$/ }, () => ({ path: 'actions-stub', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'store-stub' ? storeStub : actionsStub,
      loader: 'js',
      resolveDir: resolve('.')
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  const memory = new Map()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.localStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k)
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const mod = await compile(null, {
    stdin: {
      contents: `export { useSplitPersistence } from './src/renderer/src/features/split/use-split-persistence'
export { useStore } from './src/renderer/src/state/store'
export { useSplitView } from './src/renderer/src/state/split-view'
export { SPLIT_STORAGE_KEY } from './src/renderer/src/features/split/split-persist'`,
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    packages: 'external',
    plugins: [stubs]
  })
  const { useSplitPersistence, useStore, useSplitView, SPLIT_STORAGE_KEY } = mod
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { act } = React
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  function Probe() {
    useSplitPersistence()
    return null
  }

  const sessions = [
    { id: 'a', path: 'C:/s/a.jsonl', title: 'A' },
    { id: 'b', path: 'C:/s/b.jsonl', title: 'B' }
  ]
  const tile = (s, uid) => ({ sessionId: s.id, path: s.path, uid })

  useStore.setState({ sessions })
  useSplitView.setState({ split: null, weights: {}, rowSplit: 0.5 })
  let root = createRoot(window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(Probe)) })
  ok(memory.get(SPLIT_STORAGE_KEY) === undefined, '启动时没有已存分屏，也不写入')

  await act(async () => {
    useSplitView.setState({ split: { tiles: [tile(sessions[0], 'u1'), tile(sessions[1], 'u2')], live: 0 } })
    await delay(400)
  })
  const saved = memory.get(SPLIT_STORAGE_KEY)
  ok(typeof saved === 'string' && JSON.parse(saved).tiles.length === 2, '首次拖出分屏、会话列表不变时，防抖后写入 localStorage', String(saved))

  await act(async () => { root.unmount() })
  memory.clear()
  useSplitView.setState({ split: null, weights: {}, rowSplit: 0.5 })
  root = createRoot(window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(Probe)) })
  await act(async () => {
    useSplitView.setState({ split: { tiles: [tile(sessions[1], 'u3'), tile(sessions[0], 'u4')], live: 1 } })
  })
  window.dispatchEvent(new window.Event('pagehide'))
  const flushed = memory.get(SPLIT_STORAGE_KEY)
  ok(typeof flushed === 'string' && JSON.parse(flushed).tiles[0].sessionId === 'b', '防抖期间 pagehide 立即写入新建的分屏', String(flushed))

  await act(async () => { root.unmount() })
  useSplitView.setState({ split: null, weights: {}, rowSplit: 0.5 })
  root = createRoot(window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(Probe)) })
  const restored = useSplitView.getState().split
  ok(restored?.tiles.map((t) => t.sessionId).join('') === 'ba' && restored.live === 1, '重载后按已存布局恢复分屏', JSON.stringify(restored))
  await act(async () => { root.unmount() })
})
