/**
 * v3 滑杆原语（`ui/Slider`）的直接相关小检查。
 *
 * 用 `react-dom/server` 渲染**生产组件**，核对它确实复用 React Aria Components 的
 * 滑杆状态机与无障碍结构，而不是自造键盘逻辑：
 *   · 单值 / 范围值各渲染对应数量的原生 `input[type=range]`，带 min/max/step/value
 *     与 `aria-valuetext`、`aria-orientation`；标签经 `role="group"` 关联。
 *   · 受控 `value` 与非受控 `defaultValue` 都在初始标记里如实呈现。
 *   · `isDisabled` 落到根 `data-disabled` 与原生 `disabled`。
 *   · 说明经 `aria-describedby`、错误经 `aria-errormessage` 关联到真实 id，
 *     无效时 input 带 `aria-invalid`；`aria-label` 与长标签原样透传。
 *   · `formatOptions` 影响显示值；竖向方向透传。
 *   · 故事文件可被真实加载，且默认 / 受控 / 范围 / 禁用 / 长标签 / 错误状态都有导出。
 *   · 组件与样式不依赖 v2 `styles/`，CSS 只用令牌变量并落在 `primitives` 层。
 *
 * 这里只做 SSR 结构与纯文本检查；**没有**真实键鼠、拖动、焦点或视觉验证，
 * 也**没有**启动 Electron / 构建 / 联网 / 连 pi 或读取任何用户数据。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

/** React Aria 在模块导入期挂全局焦点/指针监听；SSR 只需要最小原型桩。 */
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

async function buildBundle(outdir) {
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import { Slider } from '${p('src/renderer/src/ui/Slider.tsx')}'`,
    `import * as stories from '${p('src/renderer/src/ui/Slider.stories.tsx')}'`,
    'export { React, renderToStaticMarkup, Slider, stories }'
  ].join('\n')
  const outfile = join(outdir, 'v3-slider.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

/** 取所有 `<input ...>` 开标签。 */
function inputs(html) {
  return [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
}

/** 取某个标签里的属性值（属性值中不含引号）。 */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

/** 取根 `<div class="ui-slider ...">` 开标签。 */
function root(html) {
  const m = html.match(/^<div class="ui-slider[^"]*"[^>]*>/)
  assert.ok(m, '根元素应带 ui-slider 类')
  return m[0]
}

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-slider-'))
  const require = createRequire(import.meta.url)
  const bundle = require(await buildBundle(outdir))
  const { React, renderToStaticMarkup, Slider, stories } = bundle
  const render = (props) => renderToStaticMarkup(React.createElement(Slider, props))

  /* 1. 单值 · 非受控 + 标签 + 值 */
  const single = render({ label: '阈值', defaultValue: 40, minValue: 0, maxValue: 100, step: 5, showValue: true })
  const singRoot = root(single)
  ok(attr(singRoot, 'role') === 'group' && attr(singRoot, 'data-orientation') === 'horizontal', '根是 role=group 的横向滑杆')
  ok(attr(singRoot, 'class').includes('ui-field') && single.includes('class="ui-field__label"'), '根带 ui-field 版面，标签用 ui-field__label')
  ok(single.includes('>阈值</label>'), '可见标签文字原样渲染')
  const singleInputs = inputs(single)
  ok(singleInputs.length === 1, '单值只渲染一个 input[type=range]')
  const si = singleInputs[0]
  ok(attr(si, 'type') === 'range' && attr(si, 'tabindex') === '0', '用原生 range 输入承接键盘，tabindex=0')
  ok(attr(si, 'min') === '0' && attr(si, 'max') === '100' && attr(si, 'step') === '5', 'min/max/step 原样透传')
  ok(attr(si, 'value') === '40' && attr(si, 'aria-valuetext') === '40', '非受控 defaultValue 与 aria-valuetext 如实呈现')
  ok(/<output[^>]*class="ui-slider__value"[^>]*>40<\/output>/.test(single), 'showValue 渲染当前值')

  /* 2. 范围值 · 双手柄 */
  const range = render({ label: '区间', defaultValue: [20, 80], thumbLabels: ['下限', '上限'], showValue: true })
  const rangeInputs = inputs(range)
  ok(rangeInputs.length === 2, '数组值渲染两个手柄 input')
  ok(attr(rangeInputs[0], 'aria-label') === '下限' && attr(rangeInputs[1], 'aria-label') === '上限', 'thumbLabels 透传到各自 input')
  ok(attr(rangeInputs[0], 'min') === '0' && attr(rangeInputs[0], 'max') === '80', '下限被 RAC 夹在另一手柄之前')
  ok(attr(rangeInputs[1], 'min') === '20' && attr(rangeInputs[1], 'max') === '100', '上限被 RAC 夹在另一手柄之后')
  ok((range.match(/class="ui-slider__thumb"/g) ?? []).length === 2, '轨道里有两个手柄外观节点')
  ok(range.includes('width:60%') && range.includes('>20–80</output>'), '范围填充与显示值来自同一状态')

  /* 3. 受控 value */
  const controlled = render({ label: '并发', value: 70, onChange: () => {}, showValue: true })
  ok(attr(inputs(controlled)[0], 'value') === '70', '受控 value 呈现为 70')

  /* 4. 非受控 defaultValue 与 step 取整 */
  const decimal = render({ label: '温度', defaultValue: 0.7, minValue: 0, maxValue: 1, step: 0.1 })
  ok(attr(inputs(decimal)[0], 'value') === '0.7', '非受控小数 defaultValue 呈现为 0.7')

  /* 5. 禁用 */
  const disabled = render({ label: '禁用', defaultValue: 10, isDisabled: true })
  ok(attr(root(disabled), 'data-disabled') === 'true', '根标记 data-disabled')
  ok(/\bdisabled(="")?(\s|>)/.test(inputs(disabled)[0]), '原生 input 带 disabled')

  /* 6. 长标签中英混排不被改写 */
  const long = render({ label: '请求超时前的重试次数（Retries before the request times out，长标签不截断）', defaultValue: 3 })
  ok(long.includes('Retries before the request times out') && long.includes('长标签不截断'), '长标签文字完整透传')

  /* 7. 错误与说明的可访问关联 */
  const invalid = render({ label: '上限', description: '本机说明', errorMessage: '必须更高', defaultValue: 90, isInvalid: true })
  ok(attr(root(invalid), 'class').includes('ui-slider--invalid'), '无效态在根上加 ui-slider--invalid')
  const ii = inputs(invalid)[0]
  ok(attr(ii, 'aria-invalid') === 'true', '无效时 input 带 aria-invalid')
  const errId = attr(ii, 'aria-errormessage')
  ok(!!errId && invalid.includes(`id="${errId}"`) && invalid.includes('>必须更高<'), '错误文案经 aria-errormessage 指向真实 id')
  const descId = attr(ii, 'aria-describedby')
  ok(!!descId && invalid.includes(`id="${descId}"`) && invalid.includes('>本机说明<'), '说明经 aria-describedby 指向真实 id')

  /* 8. aria-label 透传（无可见标签的英文名） */
  const ariaLabeled = render({ 'aria-label': 'Reasoning effort', defaultValue: 20 })
  ok(attr(root(ariaLabeled), 'aria-label') === 'Reasoning effort', 'aria-label 透传到滑杆根')
  ok(!ariaLabeled.includes('ui-field__label'), '只给 aria-label 时不渲染可见标签')

  /* 9. formatOptions 影响显示值 */
  const pct = render({ label: '占比', defaultValue: 0.4, minValue: 0, maxValue: 1, step: 0.01, formatOptions: { style: 'percent' }, showValue: true })
  ok(attr(inputs(pct)[0], 'aria-valuetext') === '40%' && pct.includes('>40%</output>'), 'formatOptions 让值与 aria-valuetext 显示为百分比')

  /* 10. 竖向方向透传 */
  const vertical = render({ label: '音量', defaultValue: 45, orientation: 'vertical' })
  ok(attr(root(vertical), 'data-orientation') === 'vertical' && attr(inputs(vertical)[0], 'aria-orientation') === 'vertical', '竖向方向透传根与 input')

  /* 11. 故事文件可加载，状态齐全 */
  const storyNames = Object.keys(stories).filter((k) => k !== 'default')
  for (const name of ['Default', 'Controlled', 'Range', 'Disabled', 'LongLabel', 'Invalid']) {
    ok(storyNames.includes(name), `故事导出 ${name}`)
  }
  ok(stories.default && stories.default.title === 'v3/原语/Slider', '故事登记在 v3/原语/Slider 工作台')

  /* 12. 组件与样式不依赖 v2，样式只用令牌 */
  const sliderSrc = await readFile(join(process.cwd(), 'src/renderer/src/ui/Slider.tsx'), 'utf8')
  ok(sliderSrc.includes("from 'react-aria-components'"), 'Slider 复用 React Aria Components')
  ok(!/from\s+['"][^'"]*styles\//.test(sliderSrc) && !/from\s+['"][^'"]*components\/ui/.test(sliderSrc), '不 import v2 styles 或旧控件')
  ok(!/onKeyDown|onKeyUp|keydown/.test(sliderSrc), '不重写键盘逻辑，键盘交给 RAC')

  const css = await readFile(join(process.cwd(), 'src/renderer/src/ui/Slider.css'), 'utf8')
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  ok(cssCode.includes('@layer primitives'), 'Slider.css 落在 primitives 层')
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(cssCode) && !/rgba?\(/.test(cssCode), 'CSS 不写死色值')
  ok(cssCode.includes('var(--ink)') && cssCode.includes('var(--accent)') && cssCode.includes('var(--sunken)'), 'CSS 颜色取界面令牌')
  ok(cssCode.includes('.ui-slider__thumb[data-focus-visible]'), 'CSS 提供键盘焦点环样式')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3 Slider：${checks} 项 SSR / 结构 / 纯文本检查通过（未做真实键鼠与视觉验证）`)
}

await main()
