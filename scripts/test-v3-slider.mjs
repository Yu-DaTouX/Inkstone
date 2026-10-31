import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
    'export { React, renderToStaticMarkup, Slider }'
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

function inputs(html) {
  return [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

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
  const { React, renderToStaticMarkup, Slider } = bundle
  const render = (props) => renderToStaticMarkup(React.createElement(Slider, props))

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

  const range = render({ label: '区间', defaultValue: [20, 80], thumbLabels: ['下限', '上限'], showValue: true })
  const rangeInputs = inputs(range)
  ok(rangeInputs.length === 2, '数组值渲染两个手柄 input')
  ok(attr(rangeInputs[0], 'aria-label') === '下限' && attr(rangeInputs[1], 'aria-label') === '上限', 'thumbLabels 透传到各自 input')
  ok(attr(rangeInputs[0], 'min') === '0' && attr(rangeInputs[0], 'max') === '80', '下限被 RAC 夹在另一手柄之前')
  ok(attr(rangeInputs[1], 'min') === '20' && attr(rangeInputs[1], 'max') === '100', '上限被 RAC 夹在另一手柄之后')
  ok((range.match(/class="ui-slider__thumb"/g) ?? []).length === 2, '轨道里有两个手柄外观节点')
  ok(range.includes('width:60%') && range.includes('>20–80</output>'), '范围填充与显示值来自同一状态')

  const controlled = render({ label: '并发', value: 70, onChange: () => {}, showValue: true })
  ok(attr(inputs(controlled)[0], 'value') === '70', '受控 value 呈现为 70')

  const decimal = render({ label: '温度', defaultValue: 0.7, minValue: 0, maxValue: 1, step: 0.1 })
  ok(attr(inputs(decimal)[0], 'value') === '0.7', '非受控小数 defaultValue 呈现为 0.7')

  const disabled = render({ label: '禁用', defaultValue: 10, isDisabled: true })
  ok(attr(root(disabled), 'data-disabled') === 'true', '根标记 data-disabled')
  ok(/\bdisabled(="")?(\s|>)/.test(inputs(disabled)[0]), '原生 input 带 disabled')

  const long = render({ label: '请求超时前的重试次数（Retries before the request times out，长标签不截断）', defaultValue: 3 })
  ok(long.includes('Retries before the request times out') && long.includes('长标签不截断'), '长标签文字完整透传')

  const invalid = render({ label: '上限', description: '本机说明', errorMessage: '必须更高', defaultValue: 90, isInvalid: true })
  ok(attr(root(invalid), 'class').includes('ui-slider--invalid'), '无效态在根上加 ui-slider--invalid')
  const ii = inputs(invalid)[0]
  ok(attr(ii, 'aria-invalid') === 'true', '无效时 input 带 aria-invalid')
  const errId = attr(ii, 'aria-errormessage')
  ok(!!errId && invalid.includes(`id="${errId}"`) && invalid.includes('>必须更高<'), '错误文案经 aria-errormessage 指向真实 id')
  const descId = attr(ii, 'aria-describedby')
  ok(!!descId && invalid.includes(`id="${descId}"`) && invalid.includes('>本机说明<'), '说明经 aria-describedby 指向真实 id')

  const ariaLabeled = render({ 'aria-label': 'Reasoning effort', defaultValue: 20 })
  ok(attr(root(ariaLabeled), 'aria-label') === 'Reasoning effort', 'aria-label 透传到滑杆根')
  ok(!ariaLabeled.includes('ui-field__label'), '只给 aria-label 时不渲染可见标签')

  const pct = render({ label: '占比', defaultValue: 0.4, minValue: 0, maxValue: 1, step: 0.01, formatOptions: { style: 'percent' }, showValue: true })
  ok(attr(inputs(pct)[0], 'aria-valuetext') === '40%' && pct.includes('>40%</output>'), 'formatOptions 让值与 aria-valuetext 显示为百分比')

  const vertical = render({ label: '音量', defaultValue: 45, orientation: 'vertical' })
  ok(attr(root(vertical), 'data-orientation') === 'vertical' && attr(inputs(vertical)[0], 'aria-orientation') === 'vertical', '竖向方向透传根与 input')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3 Slider：${checks} 项 SSR 检查通过（未做真实键鼠与视觉验证）`)
}

await main()
