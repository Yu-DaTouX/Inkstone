import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      `import { ThinkingSection } from '${posix(join(ROOT, 'src/renderer/src/patterns/ModelThinkingPicker.tsx'))}'\n` +
      `export { React, renderToStaticMarkup, ThinkingSection }\n`
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
    const { React, renderToStaticMarkup, ThinkingSection } = require(await buildSsr(outdir))
    const html = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: LEVELS, level: 'medium', busy: false, onCommit: () => {} })
    )
    ok(html.includes('data-testid="thinking-current"'), '头部当前档位带 thinking-current')
    ok(/data-level="medium"/.test(html), '头部按 data-level 染色')
    ok(html.includes('think.medium'), '头部显示当前档位名（i18n 键）')
    ok(html.includes('data-testid="thinking-stops"'), '滑杆带 thinking-stops')
    ok(html.includes('mtp-field') && html.includes('mtp-thumb'), '滑杆里渲染点阵画布与块状光标')
    ok(html.includes('class="mtp-step"'), '滑杆与档位名包在同一档位容器里（共用档位色变量）')
    const input = (html.match(/<input\b[^>]*>/) ?? [])[0] ?? ''
    ok(/\btype="range"/.test(input) && /\bmin="0"/.test(input) && /\bmax="6"/.test(input) && /\bstep="1"/.test(input), '滑杆用原生 range，min/max/step 对齐七档')
    ok(/\bvalue="3"/.test(input), '当前档位 medium 落在下标 3')
    for (const l of LEVELS) ok(html.includes(`data-testid="thinking-${l}"`), `保留档位 testid thinking-${l}`)
    ok(/data-testid="thinking-medium"[^>]*data-active="true"/.test(html) || /data-active="true"[^>]*data-testid="thinking-medium"/.test(html), '当前档在刻度行高亮')

    const fallback = renderToStaticMarkup(
      React.createElement(ThinkingSection, {
        levels: ['off'],
        level: 'off',
        busy: false,
        onCommit: () => {},
        fallback: 'think.unsupported'
      })
    )
    ok(!fallback.includes('data-testid="thinking-stops"'), '只有「关」一档时不渲染滑杆')
    ok(fallback.includes('think.unsupported'), '只有「关」一档时头部给出能力说明')
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }

  const pickerCss = await readFile(join(ROOT, 'src/renderer/src/patterns/model-thinking-picker.css'), 'utf8')
  const composerCss = await readFile(join(ROOT, 'src/renderer/src/features/composer/composer.css'), 'utf8')
  const pickerTsx = await readFile(join(ROOT, 'src/renderer/src/patterns/ModelThinkingPicker.tsx'), 'utf8')
  ok(pickerCss.includes('@keyframes v3-step-value-in'), '新关键帧用 v3-step-value-in')
  ok(pickerCss.includes('@keyframes v3-step-caret'), '光标闪烁关键帧用 v3-step-caret')
  ok(pickerCss.includes('.mtp-field') && pickerCss.includes('.mtp-thumb'), '点阵画布与块状光标各有自己的类')
  ok(/@keyframes v3-step-caret\s*\{\s*50%\s*\{\s*opacity/.test(pickerCss), '光标闪烁只降透明度（v2 终端节拍）')
  ok(
    /\.mtp-thumb\s*\{[^}]*animation:\s*v3-step-caret/.test(pickerCss),
    '光标启动时按终端节拍闪四次'
  )
  ok(
    /\.mtp-scale-item\[data-active='true'\]\s*\{[^}]*color:\s*color-mix\(in srgb, var\(--mtp-think\) \d+%, var\(--fg\)\)/.test(pickerCss),
    '当前档名染档位色（可点击切档的一排）'
  )
  ok(pickerCss.includes('color-mix') && /\.mtp-thumb\s*\{[^}]*box-shadow/.test(pickerCss), '块状光标带发光')
  ok(pickerCss.includes('prefers-reduced-motion: reduce') && /\.mtp-thumb\s*\{\s*animation:\s*none;/.test(pickerCss), 'reduced-motion 下光标不闪')
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?scale:\s*none/.test(pickerCss), 'reduced-motion 下光标不放大')
  ok(pickerCss.includes('prefers-reduced-motion: reduce') && /\.mtp-step-value\s*\{\s*animation:\s*none;/.test(pickerCss), 'reduced-motion 下关闭档位切换动画')
  ok(pickerCss.includes('var(--think-'), '档位色引用 --think-*')
  ok(/\n\s*\.mtp-level\s*\{[^}]*color:\s*var\(--fg2\)/.test(pickerCss) && !/\.mtp-level\[data-level/.test(pickerCss), '输入框里的档位字是次级灰，不按档位染色（档位色只留在输入框顶边）')
  ok(/\.mtp-trigger\[data-disabled\]\s*\{\s*opacity:\s*1;/.test(pickerCss), '运行中模型名保持常态，不变灰')
  ok(!pickerCss.includes('@import'), '选择器 CSS 不 @import（尤其不引 v2 样式）')
  ok(composerCss.includes('--think-max') && composerCss.includes('.cborder'), '输入框顶边与档位色在 composer 专属 CSS 里派生')
  ok(composerCss.includes('prefers-reduced-motion: reduce') && /\.cborder\s*\{\s*transition:\s*none;/.test(composerCss), 'reduced-motion 下顶边换色无过渡')
  ok(pickerTsx.includes("setAttribute('aria-valuetext'") && pickerTsx.includes('levelLabel'), '运行时把隐藏 range 的 aria-valuetext 补成档位名')
  ok(pickerTsx.includes('PulseField') && pickerTsx.includes('pulse-field'), '滑杆复用 components/ui/pulse-field 的纯点阵引擎')
  ok(pickerTsx.includes('engine.dispose()') && pickerTsx.includes('fieldRef.current = null'), '菜单关闭时 dispose 点阵引擎')
  ok(pickerTsx.includes('dataset.theme'), '深浅主题按 v3 根元素主题属性判断')
  ok(pickerTsx.includes("from '../ui'") && pickerTsx.includes('thinkingDragAction') && pickerTsx.includes('thinkingCommitAction'), '滑杆来自 ui/，拖动预览 / 松手提交走同一纯模型')
  ok(
    !/styles\//.test(pickerTsx) && !/\bfrom\s+['"][^'"]*components\/ui['"]/.test(pickerTsx),
    '选择器源文件不引 v2 样式 / 旧 ui 桶入口（只复用 pulse-field 纯模块）'
  )

  console.log(`\n结果：${checks} 项通过`)
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
