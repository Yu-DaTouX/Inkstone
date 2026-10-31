import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, normalize } from 'node:path'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const posix = (p) => p.replace(/\\/g, '/')
let checks = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  checks++
  console.log(`✓ ${label}`)
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

async function loadLayout() {
  const result = await build({
    entryPoints: [join(ROOT, 'src/renderer/src/features/composer/composer-layout.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

async function buildSsr(outdir) {
  const stubMap = new Map(
    Object.entries({
      'src/renderer/src/state/store.ts': 'export function currentThinkingLevels(s){ return s.thinkingLevels }\nexport function useStore(sel){ return sel ? sel({ session: null, models: [], settings: {}, thinkingLevels: [], authProviders: [] }) : {} }\nuseStore.getState = () => ({ notify(){}, patchSettings: async()=>{}, openSettings(){} })\nuseStore.setState = () => {}\n',
      'src/renderer/src/i18n/index.tsx': 'export function useT(){ return (k) => String(k) }\nexport function useOptionalT(){ return (k) => String(k) }\nexport function useI18n(){ return { lang: "zh-CN" } }\nexport function translate(_l, k){ return String(k) }'
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
  const entry = join(outdir, 'ssr-entry.tsx')
  const outfile = join(outdir, 'thinking-ssr.cjs')
  await (await import('node:fs/promises')).writeFile(
    entry,
    `import * as React from 'react'\n` +
      `import { renderToStaticMarkup } from 'react-dom/server'\n` +
      `import { ThinkingSection, thinkingScale, modelNameTail } from '${posix(join(ROOT, 'src/renderer/src/patterns/ModelThinkingPicker.tsx'))}'\n` +
      `export { React, renderToStaticMarkup, ThinkingSection, thinkingScale, modelNameTail }\n`
  )
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'a2-thinking-stubs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (!args.importer || !args.resolveDir) return undefined
            const base = resolve(args.resolveDir, args.path)
            for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
              const key = normalize(base + e)
              if (stubMap.has(key)) return { path: `a2:${key}`, namespace: 'a2' }
            }
            return undefined
          })
          b.onLoad({ filter: /.*/, namespace: 'a2' }, (args) => {
            return { contents: stubMap.get(args.path.slice('a2:'.length)) ?? 'export {}', loader: 'js' }
          })
        }
      }
    ]
  })
  return outfile
}

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

async function main() {
  installGlobals()
  const layout = await loadLayout()

  ok(layout.thinkingLevelIndex(LEVELS, 'off') === 0, 'off → 下标 0')
  ok(layout.thinkingLevelIndex(LEVELS, 'medium') === 3, 'medium → 下标 3')
  ok(layout.thinkingLevelIndex(LEVELS, 'max') === 6, 'max → 下标 6')
  ok(layout.thinkingLevelIndex(LEVELS, 'unknown') === 0, '未知档位退到第一档')
  ok(layout.thinkingLevelAt(LEVELS, 5) === 'xhigh', '下标 5 → xhigh')
  ok(layout.thinkingLevelAt(LEVELS, 99) === 'max', '越界下标夹到最后一档')
  ok(layout.thinkingLevelAt([], 0) === null, '空档位表返回 null')

  for (let i = 0; i < LEVELS.length; i++) {
    const action = layout.thinkingDragAction(LEVELS, i)
    ok(action.kind === 'preview' && action.level === LEVELS[i], `拖动第 ${i} 档只返回 preview，不提交`)
  }
  ok(layout.thinkingCommitAction(LEVELS, 3, 'medium').kind === 'none', '确认到当前档是空操作')
  const commit = layout.thinkingCommitAction(LEVELS, 5, 'medium')
  ok(commit.kind === 'commit' && commit.level === 'xhigh', '确认到新档才提交 xhigh')

  const outdir = await mkdtemp(join(ROOT, '.tmp/v3-thinking-'))
  try {
    const require = createRequire(import.meta.url)
    const { React, renderToStaticMarkup, ThinkingSection, thinkingScale, modelNameTail } = require(await buildSsr(outdir))
    const cell = (html, level) => (html.match(new RegExp(`<button[^>]*data-testid="thinking-${level}"[^>]*>`)) ?? [])[0] ?? ''

    const partial = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: ['off', 'high'], level: 'high', busy: false, onCommit: () => {} })
    )
    ok(['minimal', 'low', 'medium', 'xhigh', 'max'].every((l) => /\bdisabled=""/.test(cell(partial, l))), '模型不支持的档位置灰禁用')
    ok(!/\bdisabled=""/.test(cell(partial, 'off')) && !/\bdisabled=""/.test(cell(partial, 'high')), '支持的档位可选')
    ok((partial.match(/title="picker\.thinkLevelUnsupported"/g) ?? []).length === 5, '置灰档位悬停说明原因')

    const deep = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: LEVELS, level: 'max', busy: false, onCommit: () => {}, ultracode: true })
    )
    ok(/data-testid="thinking-current"[^>]*>Ultracode</.test(deep), 'Ultracode 开启时头部标出 Ultracode')
    const again = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: LEVELS, level: 'max', busy: false, onCommit: () => {}, onUltracodeRequest: () => {} })
    )
    ok(again.includes('title="picker.deepAgain"'), '停在最高档时提示再按一次开启 Ultracode')
    const busy = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: LEVELS, level: 'low', busy: true, onCommit: () => {} })
    )
    ok(/data-disabled="true"/.test(busy) || /\bdisabled=""/.test(cell(busy, 'high')), '生成中刻度整体禁用')

    const fallback = renderToStaticMarkup(
      React.createElement(ThinkingSection, {
        levels: ['off'],
        level: 'off',
        busy: false,
        onCommit: () => {},
        fallback: 'think.unsupported',
        fallbackShort: 'short'
      })
    )
    ok(!fallback.includes('data-testid="thinking-stops"'), '只有「关」一档时不渲染刻度')
    ok(fallback.includes('think.unsupported') && fallback.includes('data-testid="thinking-current"'), '只有「关」一档时头部给出能力说明')

    ok(thinkingScale(['off', 'turbo']).join() === 'off,minimal,low,medium,high,xhigh,max,turbo', '刻度固定七档，未知档追加在末尾')
    ok(modelNameTail('Claude Opus 5.5') === 8 && modelNameTail('GPT-6.1 Sol') === 3 && modelNameTail('Fake') === undefined, '模型名中间截断保留品牌之后的部分')
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }

  console.log(`\n结果：${checks} 项通过`)
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
