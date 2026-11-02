import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const here = process.cwd()
const p = (rel) => join(here, rel).replace(/\\/g, '/')
const metricsSource = p('src/shared/session-metrics.ts')

const countingMetrics = {
  name: 'counting-session-metrics',
  setup(builder) {
    builder.onResolve({ filter: /session-metrics$/ }, (args) =>
      args.importer.replace(/\\/g, '/').endsWith('features/workbench/RailStats.tsx') ? { path: 'counted', namespace: 'counted-metrics' } : undefined
    )
    builder.onLoad({ filter: /.*/, namespace: 'counted-metrics' }, () => ({
      resolveDir: here,
      loader: 'ts',
      contents: [
        `import * as real from '${metricsSource}'`,
        `export * from '${metricsSource}'`,
        'export function projectSessionMetrics(...args) {',
        '  globalThis.__railHistoryRuns = (globalThis.__railHistoryRuns ?? 0) + 1',
        '  return real.projectSessionMetrics(...args)',
        '}'
      ].join('\n')
    }))
  }
}

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
const memory = new Map()
const storage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
Object.assign(globalThis, { window, document, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true })
window.localStorage = storage
window.yan = {}
window.screen = Object.assign(new EventTarget(), { width: 1920, height: 1080, orientation: Object.assign(new EventTarget(), { angle: 0, type: 'landscape-primary' }) })
if (!window.visualViewport) window.visualViewport = Object.assign(new EventTarget(), { width: 1920, height: 1080, scale: 1 })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
if (!globalThis.navigator) globalThis.navigator = window.navigator ?? { userAgent: 'node' }

const outdir = await mkdtemp(join(tmpdir(), 'inkstone-rail-stats-isolation-'))
try {
  const entry = [
    "import * as React from 'react'",
    "import { createRoot } from 'react-dom/client'",
    `import { useRailStats } from '${p('src/renderer/src/features/workbench/RailStats.tsx')}'`,
    `import { useStore } from '${p('src/renderer/src/state/store.ts')}'`,
    `import { I18nProvider } from '${p('src/renderer/src/i18n/index.tsx')}'`,
    'export { React, createRoot, useRailStats, useStore, I18nProvider }'
  ].join('\n')
  const outfile = join(outdir, 'rail-stats-isolation.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'empty', '.json': 'json' },
    plugins: [countingMetrics],
    logLevel: 'silent'
  })
  const bundle = createRequire(import.meta.url)(outfile)
  const { React, createRoot, useRailStats, useStore, I18nProvider } = bundle
  const h = React.createElement
  const act = React.act

  const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: 0.01 })
  const history = Array.from({ length: 40 }, (_, i) =>
    i % 2 === 0
      ? { id: `u${i}`, role: 'user', text: `问题 ${i}`, timestamp: 1_000 + i * 1000 }
      : { id: `a${i}`, role: 'assistant', text: `回答 ${i}`, timestamp: 1_000 + i * 1000, usage: usage(100, 40) }
  )
  const session = { sessionId: 'S1', sessionFile: 'E:/sessions/s1.jsonl', isStreaming: false, isAgentRunning: false }
  const run = (id, parentSessionId, tokens, tick = 0) => ({
    id,
    task: id,
    cwd: 'E:/sim',
    parentSessionId,
    model: 'p/m',
    status: 'running',
    startedAt: 1,
    latestActivity: `tick ${tick}`,
    transcript: [{ id: `${id}-t`, role: 'assistant', text: 'x'.repeat(tick) }],
    toolCalls: 0,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 }
  })

  useStore.setState({
    session,
    messages: history,
    stats: null,
    peekNote: null,
    peekedSessionId: null,
    peekedPath: null,
    runners: [],
    subagents: [run('own', 'S1', 500), run('foreign', 'S2', 900)]
  })

  const seen = []
  function Probe() {
    seen.push(useRailStats(true))
    return null
  }
  const root = createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(h(I18nProvider, null, h(Probe)))
  })
  const runs = () => globalThis.__railHistoryRuns ?? 0
  const latest = () => seen[seen.length - 1]
  const childValue = (model) => model?.facts.find((fact) => fact.key === 'subagents')?.value ?? null
  const first = latest()
  const baseline = runs()
  ok(first && baseline >= 1, '首次渲染算出会话栏统计')
  ok(childValue(first) === '+500', '本会话子代理用量计入，其它会话子代理不计入')

  const patch = (id, change) =>
    useStore.setState((s) => ({ subagents: s.subagents.map((r) => (r.id === id ? change(r) : r)) }))

  for (let i = 1; i <= 30; i++) {
    await act(async () => patch('foreign', (r) => run('foreign', 'S2', 900 + i * 10, i)))
  }
  ok(runs() === baseline, `其它会话子代理 30 次更新不重算主会话历史（${runs() - baseline} 次）`)
  ok(latest() === first, '其它会话子代理更新后统计对象保持不变')

  for (let i = 1; i <= 30; i++) {
    await act(async () => patch('own', (r) => ({ ...run('own', 'S1', 500, i) })))
  }
  ok(runs() === baseline, `本会话子代理只改转录的 30 次更新不重算主会话历史（${runs() - baseline} 次）`)
  ok(latest() === first, '用量不变时统计对象保持不变')

  await act(async () => patch('own', () => run('own', 'S1', 2000, 31)))
  ok(runs() === baseline, '子代理用量变化不重算主会话历史')
  ok(latest() !== first && childValue(latest()) === '+2.0K', '子代理用量变化仍更新会话栏显示')

  await act(async () => useStore.setState((s) => ({ session: { ...s.session, thinkingLevel: 'high' } })))
  ok(runs() === baseline, '会话对象换新但视图身份不变时不重算历史')

  await act(async () =>
    useStore.setState((s) => ({ messages: [...s.messages, { id: 'u-next', role: 'user', text: '再问', timestamp: 90_000 }, { id: 'a-next', role: 'assistant', text: '答', timestamp: 91_000, usage: usage(300, 60) }] }))
  )
  ok(runs() === baseline + 1, '消息变化仍会重算历史一次')

  await act(async () => useStore.setState({ peekedSessionId: 'S2', peekedPath: 'E:/sessions/s2.jsonl' }))
  ok(runs() === baseline + 2, '切换到只读视图时按新视图重算')
  ok(childValue(latest()) === '+1.2K', '只读视图只计入被查看会话的子代理用量')

  await act(async () => root.unmount())
  console.log(`\n${checks} 项通过`)
} finally {
  await rm(outdir, { recursive: true, force: true })
}
process.exit(0)
