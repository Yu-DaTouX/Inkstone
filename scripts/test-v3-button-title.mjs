#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const STUBS = {
  react: `
export function forwardRef(render) { return { render } }
export function useCallback(fn) { return fn }
export function createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } } }
`,
  'react/jsx-runtime': `
export function jsx(type, props) { return { type, props: props ?? {} } }
export const jsxs = jsx
export const Fragment = 'Fragment'
`,
  'react-aria-components': `
export function Button() { return null }
export function composeRenderProps(value, wrap) { return typeof value === 'function' ? (...args) => wrap(value(...args)) : wrap(value) }
`,
  tooltip: `
export function Tooltip() { return null }
export function TooltipHint() { return null }
export function TooltipTrigger() { return null }
`
}

const stubPlugin = {
  name: 'button-stubs',
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-aria-components)$/ }, (args) => ({ path: args.path === 'react/jsx-dev-runtime' ? 'react/jsx-runtime' : args.path, namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/Tooltip$/ }, () => ({ path: 'tooltip', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }))
  }
}

function findButton(el, RACButton) {
  if (!el || typeof el !== 'object') return null
  if (el.type === RACButton) return el
  const kids = el.props?.children
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = findButton(kid, RACButton)
    if (hit) return hit
  }
  return null
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { UiButton, RACButton } = await compile(null, {
    stdin: {
      contents: `export { Button as UiButton } from './src/renderer/src/ui/Button'\nexport { Button as RACButton } from 'react-aria-components'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    jsx: 'automatic',
    plugins: [stubPlugin]
  })

  const titleFor = (props) => {
    const tree = UiButton.render({ children: 'x', ...props }, null)
    const button = findButton(tree, RACButton)
    const node = { title: 'stale' }
    button.props.ref(node)
    return { node, wrapped: tree.type !== RACButton }
  }

  const disabled = titleFor({ isDisabled: true, tooltip: '未配置远端' })
  ok(disabled.node.title === '未配置远端', '禁用且 tooltip 为字符串时写原生 title', disabled.node.title)
  ok(disabled.wrapped, '禁用时仍保留 tooltip 包装', disabled.wrapped)

  const enabled = titleFor({ tooltip: '拉取' })
  ok(enabled.node.title === '', '启用时不写原生 title，避免两个提示', enabled.node.title)

  const enabledFalse = titleFor({ isDisabled: false, tooltip: '拉取' })
  ok(enabledFalse.node.title === '', 'isDisabled=false 时不写原生 title', enabledFalse.node.title)

  const nodeTip = titleFor({ isDisabled: true, tooltip: { type: 'span', props: { children: '富文本' } } })
  ok(nodeTip.node.title === '', '禁用但 tooltip 不是字符串时不写 title', nodeTip.node.title)

  const explicit = titleFor({ isDisabled: true, tooltip: '提示', title: '显式说明' })
  ok(explicit.node.title === '显式说明', '显式 title 优先于 tooltip', explicit.node.title)

  const explicitEnabled = titleFor({ title: '显式说明' })
  ok(explicitEnabled.node.title === '显式说明', '启用时显式 title 照常写入', explicitEnabled.node.title)

  const plain = titleFor({ isDisabled: true })
  ok(plain.node.title === '', '禁用但没有 tooltip 时 title 为空', plain.node.title)

  let forwarded = null
  const tree = UiButton.render({ children: 'x', isDisabled: true, tooltip: '原因' }, (node) => { forwarded = node })
  const node = { title: '' }
  findButton(tree, RACButton).props.ref(node)
  ok(forwarded === node && node.title === '原因', '外部 ref 照常转发并写入 title')
})
