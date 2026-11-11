import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const dir = await mkdtemp(resolve('node_modules/.inkstone-translate-renderer-'))
let root
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
try {
  const outfile = join(dir, 'hook.mjs')
  await build({
    stdin: { contents: "export { useThinkingTranslation } from './src/renderer/src/features/session/thinking-translate'; export { useStore } from './src/renderer/src/state/store'", resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'translation-deps', setup(b) {
      b.onResolve({ filter: /state\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
      b.onResolve({ filter: /^\.\.\/\.\.\/ui$|^\.\/text$/ }, () => ({ path: 'ui', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ resolveDir: process.cwd(), contents: path === 'store'
        ? "import { create } from 'zustand'; export const useStore = create(() => ({ settings: {} }))"
        : 'export const Button = () => null; export const Spinner = () => null; export const useSessionText = () => () => ""' }))
    } }]
  })
  const { useThinkingTranslation, useStore } = await import(pathToFileURL(outfile).href)
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const requests = []
  window.yan = { translateText: (text) => new Promise((resolve, reject) => requests.push({ text, resolve, reject })) }
  let state
  let text = 'Same reasoning text'
  function Probe() { state = useThinkingTranslation(text); return null }
  root = createRoot(document.getElementById('root'))
  const render = () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)))
  const patch = async (settings) => act(async () => useStore.setState({ settings: { ...useStore.getState().settings, ...settings } }))
  const request = async () => { await act(async () => state.request()); return requests.at(-1) }
  const resolveRequest = async (request, value) => act(async () => request.resolve({ ok: true, text: value, service: 'bing', cached: false }))
  await act(async () => render())
  ok(state.phase === 'idle' && !state.showing, 'new text starts untranslated')

  for (const [settings, expected] of [
    [{ translateService: 'bing', translateTarget: 'ja' }, 'bing-ja'],
    [{ translateTarget: 'zh-Hans' }, 'bing-zh'],
    [{ translateService: 'google' }, 'google-zh'],
    [{ translateService: 'model', translateModel: 'fixture/one' }, 'model-one'],
    [{ translateModel: 'fixture/two' }, 'model-two']
  ]) {
    await patch(settings)
    ok(state.phase === 'idle' && !state.showing && state.translated === null, `${expected}: changing configuration clears the previous translation`)
    const before = requests.length
    const pending = await request()
    await request()
    ok(requests.length === before + 1 && pending.text === text, `${expected}: one in-flight request per hook`)
    await resolveRequest(pending, expected)
    ok(state.phase === 'done' && state.showing && state.translated === expected, `${expected}: matching result is shown`)
  }
  await patch({ translateService: 'bing', translateTarget: 'ja', translateModel: '' })
  const beforeCached = requests.length
  await request()
  ok(requests.length === beforeCached && state.translated === 'bing-ja', 'returning to a completed configuration uses its own cache')
  await act(async () => state.toggle())
  ok(!state.showing && state.translated === 'bing-ja', 'show original retains the translation')
  await act(async () => state.toggle())
  ok(state.showing && requests.length === beforeCached, 'toggle back does not translate again')

  await patch({ translateTarget: 'auto', lang: 'en-US' })
  const english = await request()
  await patch({ lang: 'zh-CN' })
  await resolveRequest(english, 'stale English')
  ok(!state.showing && state.translated === 'bing-zh', 'auto target follows app language and drops a pending old-language response')

  for (const [name, from, to] of [
    ['service', { translateService: 'bing' }, { translateService: 'google' }],
    ['model', { translateService: 'model', translateModel: 'fixture/one' }, { translateModel: 'fixture/two' }]
  ]) {
    text = `In-flight ${name} race`
    await patch(from)
    const old = await request()
    await patch(to)
    const fresh = await request()
    await resolveRequest(old, `obsolete ${name}`)
    ok(state.phase === 'loading' && !state.showing, `${name}: pending response from the previous configuration is ignored`)
    await resolveRequest(fresh, `current ${name}`)
    ok(state.translated === `current ${name}`, `${name}: current response is shown`)
  }

  text = 'In-flight settings race'
  await act(async () => render())
  const oldA = await request()
  await patch({ translateTarget: 'ko' })
  const oldB = await request()
  await patch({ translateTarget: 'auto' })
  const newA = await request()
  await resolveRequest(oldA, 'obsolete A')
  ok(state.phase === 'loading' && !state.showing, 'A to B to A does not revive the original A request')
  await act(async () => oldB.reject(new Error('obsolete B failure')))
  ok(state.phase === 'loading' && state.error === '', 'stale rejection cannot overwrite the current request')
  await resolveRequest(newA, 'current A')
  ok(state.translated === 'current A' && state.showing, 'new A result wins')

  text = 'Text change race'
  await act(async () => render())
  const oldText = await request()
  text = 'Replacement text'
  await act(async () => render())
  await resolveRequest(oldText, 'obsolete text')
  ok(state.phase === 'idle' && state.translated === null, 'changing source text drops its pending response')
  const failed = await request()
  await act(async () => failed.resolve({ ok: false, error: 'fixture failure' }))
  ok(state.phase === 'failed' && state.error === 'fixture failure', 'current request failure remains visible')
  const retry = await request()
  await resolveRequest(retry, 'retry succeeded')
  ok(state.phase === 'done' && state.error === '', 'failed requests can be retried')

  text = 'Unmounted request'
  await act(async () => render())
  const unmounted = await request()
  await act(async () => root.unmount())
  root = null
  await resolveRequest(unmounted, 'unmounted translation')
  root = createRoot(document.getElementById('root'))
  await act(async () => render())
  ok(state.phase === 'idle' && state.translated === null, 'unmounted responses do not pollute the shared cache')
  console.log(`translate-renderer: ${checks} checks passed (React hooks, no network, no model)`)
} finally {
  if (root) await act(async () => root.unmount())
  await rm(dir, { recursive: true, force: true })
}
