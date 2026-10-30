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
    const html = renderToStaticMarkup(
      React.createElement(ThinkingSection, { levels: LEVELS, level: 'medium', busy: false, onCommit: () => {} })
    )
    ok(html.includes('data-testid="thinking-stops"'), '刻度带 thinking-stops')
    ok(html.includes('ui-ascii-scale'), '刻度来自 ui/ 的 AsciiScale 基元')
    for (const l of LEVELS) ok(cell(html, l), `保留档位 testid thinking-${l}`)
    ok(/data-selected="true"/.test(cell(html, 'medium')), '当前档 medium 处于选中态')
    ok(['off', 'minimal', 'low', 'medium'].every((l) => /data-lit/.test(cell(html, l))) && !/data-lit/.test(cell(html, 'high')), '选中格及其左侧格点亮，右侧不点亮')
    const glyphs = [...html.matchAll(/class="ui-ascii-scale__glyph"[^>]*>([^<]*)</g)].map((m) => m[1]).join('')
    ok(glyphs === '▁▁▁▂▂▂▃▃▃▄▄▄▅▅▅▆▆▆▇▇▇', `七格字形逐级升高（实际 ${glyphs}）`)
    for (const l of LEVELS) ok(html.includes(`think.${l}`), `刻度字走 i18n 键 think.${l}`)
    ok(!html.includes('data-testid="thinking-current"'), '有档位且未开 Ultracode 时头部不再重复当前档')
    ok(/var\(--think-medium/.test(html), '选中格的色调取当前档位色')

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

  const pickerCss = await readFile(join(ROOT, 'src/renderer/src/patterns/model-thinking-picker.css'), 'utf8')
  const scaleCss = await readFile(join(ROOT, 'src/renderer/src/ui/AsciiScale.css'), 'utf8')
  const composerCss = await readFile(join(ROOT, 'src/renderer/src/features/composer/composer.css'), 'utf8')
  const pickerTsx = await readFile(join(ROOT, 'src/renderer/src/patterns/ModelThinkingPicker.tsx'), 'utf8')
  ok(!pickerCss.includes('@keyframes') && !pickerCss.includes('.mtp-thumb'), '选择器不再有点阵滑杆与闪烁光标')
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mtp-chev\s*\{\s*transition:\s*none/.test(pickerCss) && /:root\[data-reduce-motion='true'\] \.mtp-chev/.test(pickerCss), '减少动效（系统与应用两路）下箭头不转动')
  ok(scaleCss.includes('--ascii-ink') && scaleCss.includes('--ascii-dim') && scaleCss.includes('--ring-focus'), '刻度用 ASCII 墨色令牌，焦点环来自令牌')
  ok(/\.mtp-item\s*\{[^}]*grid-template-columns:[^;]*minmax\(0, 1fr\)/.test(pickerCss), '模型行是 grid，弹性列用 minmax(0, 1fr)')
  ok(/\.mtp-prov\s*\{[^}]*width:\s*13ch/.test(pickerCss) && /\.mtp-ctx\s*\{[^}]*text-align:\s*end/.test(pickerCss), '供应商列定宽、上下文列右对齐')
  ok(/\.mtp-pop\s*\{[^}]*container-type:\s*inline-size/.test(pickerCss) && pickerCss.includes('@container (max-width: 520px)'), '窄窗口下菜单收窄供应商栏')
  ok(/\n\s*\.mtp-level\s*\{[^}]*color:\s*var\(--fg2\)/.test(pickerCss) && !/\.mtp-level\[data-level/.test(pickerCss), '输入框里的档位字是次级灰，不按档位染色（档位色只留在输入框顶边）')
  ok(/\.mtp-trigger\[data-disabled\]\s*\{\s*opacity:\s*1;/.test(pickerCss), '运行中模型名保持常态，不变灰')
  ok(/\.mtp-think-trigger\s*\{\s*flex:\s*none;/.test(pickerCss), '思考档按钮不被压缩，档位字不会被裁成半个字')
  ok(!pickerCss.includes('@import'), '选择器 CSS 不 @import（尤其不引 v2 样式）')
  ok(composerCss.includes('--think-max') && composerCss.includes('.cborder'), '输入框顶边与档位色在 composer 专属 CSS 里派生')
  ok(composerCss.includes('prefers-reduced-motion: reduce') && /\.cborder\s*\{\s*transition:\s*none;/.test(composerCss), 'reduced-motion 下顶边换色无过渡')
  ok(/\.composer-tools\s*\{[^}]*min-width:\s*0/.test(composerCss), '状态行左组可收缩，右侧发送组不被挤出')
  ok(/@container \(max-width: 560px\)\s*\{\s*\.composer-bar \.mtp-think-icon\s*\{\s*display:\s*none/.test(composerCss), '更窄时先收起「思考」前缀，档位字保留')
  ok(pickerTsx.includes('MiddleTruncate') && pickerTsx.includes('modelNameTail(cur.name)'), '模型名在窄宽度下中间截断')
  ok(pickerTsx.includes('AsciiScale') && pickerTsx.includes("from '../ui'") && pickerTsx.includes('thinkingCommitAction'), '思考档用 ui/ 的字符刻度，提交走同一纯模型')
  ok(!pickerTsx.includes('PulseField') && !pickerTsx.includes('pulse-field'), '不再引用点阵引擎')
  ok(pickerTsx.includes('model-picker-tab-${provider}') && pickerTsx.includes('visibleCount(provider)'), '左栏按供应商分组并显示模型数')
  ok(pickerTsx.includes('data-testid="model-picker-favorites"') && pickerTsx.includes('jumpLabel(jump)'), '收藏区固定在菜单顶部并显示 Ctrl+N')
  ok(pickerTsx.includes('data-testid="model-picker-thinking"'), '模型菜单底部可直接调当前模型的思考档')
  ok(
    !/styles\//.test(pickerTsx) && !/\bfrom\s+['"][^'"]*components\/ui['"]/.test(pickerTsx),
    '选择器源文件不引 v2 样式 / 旧 ui 桶入口'
  )
  for (const lang of ['zh-CN', 'en-US']) {
    const dict = JSON.parse(await readFile(join(ROOT, `src/renderer/src/i18n/${lang}.json`), 'utf8'))
    ok(['picker.thinkLevelUnsupported', 'picker.deepAgain', 'picker.matchCount'].every((k) => typeof dict[k] === 'string' && dict[k]), `${lang} 有刻度与菜单新文案`)
  }
  const zh = JSON.parse(await readFile(join(ROOT, 'src/renderer/src/i18n/zh-CN.json'), 'utf8'))
  ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].every((l) => /^[\u4e00-\u9fff]+$/.test(zh[`think.${l}`])), '中文刻度字统一为中文（关 / 最低 / 低 / 中 / 高 / 极高 / 最高）')

  console.log(`\n结果：${checks} 项通过`)
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
