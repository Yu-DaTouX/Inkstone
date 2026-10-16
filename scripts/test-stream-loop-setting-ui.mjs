/**
 * 「循环中止后自动继续」设置开关的专项检查（设置 · 会话 · 常规页 WorkspaceTab）。
 *
 * 覆盖三件只与本次改动有关的事：
 *   ① WorkspaceTab 读取 `streamLoopAutoContinue`：`undefined` 视为开启，只有显式 `false` 才关闭；
 *   ② 切换开关调用 `patchSettings({ streamLoopAutoContinue })`，不碰旧 `autoArchiveDays`；
 *   ③ 文案键在 zh-CN / en-US 两份 i18n 里都存在，且复用既有 SettingRow + Switch（无新增控件）。
 *
 * 现场用 esbuild 编译；不启动 Electron、不连接 pi、不访问网络、不读写真实数据。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`  ok  ${label}`)
}

globalThis.React = { createElement, Fragment }
globalThis.__loopRows = []
globalThis.__loopSwitches = []

await mkdir('.tmp/loop-setting-ui', { recursive: true })
const dir = await mkdtemp(resolve('.tmp/loop-setting-ui/run-'))
try {
  /* ① WorkspaceTab：真实组件，桩掉 store / i18n / 共享控件，只验证本次接线。 */
  const tabOut = join(dir, 'workspace-tab.mjs')
  const tabStubs = {
    i18n: `export const useT = () => (key) => 'T:' + key;`,
    store: `export const calls = []; export let state = { settings: {}, patchSettings: async (p) => { calls.push(p); } }; export const useStore = (selector) => selector(state); export const setState = (value) => { state = value; };`,
    ui: `const h = (...a) => globalThis.React.createElement(...a);
export const SettingRow = ({ name, desc, title, children, ctlProps }) => {
  globalThis.__loopRows.push({ name, desc, title, ctlProps });
  return h('div', null, h('span', null, name), children);
};
export const Switch = (props) => {
  globalThis.__loopSwitches.push(props);
  return h('button', { role: 'switch', 'aria-checked': props.checked, 'data-testid': props.testId });
};`
  }
  await build({
    stdin: {
      contents: `export { WorkspaceTab } from './src/renderer/src/components/settings/WorkspaceTab'\nexport { setState, calls } from 'inkstone-loop-store'`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile: tabOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    plugins: [{
      name: 'workspace-tab-fixtures',
      setup(b) {
        const fixtures = [[/(^|\/)i18n$/, 'i18n'], [/state\/store$|^inkstone-loop-store$/, 'store'], [/\/ui$/, 'ui']]
        for (const [filter, name] of fixtures) b.onResolve({ filter }, () => ({ path: name, namespace: 'fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: tabStubs[args.path], loader: 'js' }))
      }
    }]
  })
  const tab = await import(pathToFileURL(tabOut).href)

  const renderTab = (settings) => {
    globalThis.__loopRows = []
    globalThis.__loopSwitches = []
    tab.setState({ settings, patchSettings: async (p) => tab.calls.push(p) })
    const html = renderToStaticMarkup(createElement(tab.WorkspaceTab))
    return { html, rows: globalThis.__loopRows, switches: globalThis.__loopSwitches }
  }

  const defaults = renderTab({})
  ok(defaults.switches.length === 1, '缺省 settings（undefined）时渲染一个开关')
  ok(defaults.switches[0].checked === true, 'undefined 视为开启')
  ok(defaults.switches[0].label === 'T:set.streamLoopAutoContinue', '开关无障碍名称走 i18n 键')
  ok(defaults.switches[0].testId === 'set-stream-loop-auto-continue', '开关带稳定 data-testid')
  const loopRow = defaults.rows.find((r) => r.name === 'T:set.streamLoopAutoContinue')
  ok(!!loopRow, '复用 SettingRow 承载名称')
  ok(loopRow.desc === 'T:set.streamLoopAutoContinueDesc', 'SettingRow 说明走 i18n 键')
  ok(loopRow.title === 'T:set.streamLoopAutoContinueTip', 'SettingRow title 补充完整边界说明')

  const off = renderTab({ streamLoopAutoContinue: false })
  ok(off.switches[0].checked === false, '显式 false 关闭开关')
  const on = renderTab({ streamLoopAutoContinue: true })
  ok(on.switches[0].checked === true, '显式 true 保持开启')

  const before = tab.calls.length
  await defaults.switches[0].onChange(false)
  const patch = tab.calls[tab.calls.length - 1]
  ok(tab.calls.length === before + 1, '切换只提交一次 patchSettings')
  ok(patch && patch.streamLoopAutoContinue === false, '关闭提交 streamLoopAutoContinue:false')
  ok(patch && !('autoArchiveDays' in patch), '开关 patch 不动旧 autoArchiveDays')
  await defaults.switches[0].onChange(true)
  ok(tab.calls[tab.calls.length - 1].streamLoopAutoContinue === true, '开启提交 streamLoopAutoContinue:true')

  /* 旧「自动归档」行仍在原地，未被本次编辑挤掉。 */
  ok(defaults.rows.some((r) => r.ctlProps && r.ctlProps['data-testid'] === 'set-auto-archive'), '旧 autoArchive 分段控件保留')

  /* ② 真实共享 Switch：确认 props 真的落到 role/aria 与开关类名上。 */
  const uiOut = join(dir, 'ui.mjs')
  await build({
    entryPoints: ['src/renderer/src/components/ui/index.tsx'],
    outfile: uiOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    plugins: [{
      name: 'ui-fixtures',
      setup(b) {
        const fixtures = [[/icons\/Icon$/, 'icon'], [/lib\/appearance$/, 'appearance'], [/ui\/Tip$/, 'tip']]
        for (const [filter, name] of fixtures) b.onResolve({ filter }, () => ({ path: name, namespace: 'fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
          const contents = args.path === 'icon'
            ? `const h = (...a) => globalThis.React.createElement(...a); export const Icon = ({ name }) => h('span', { 'data-icon': name });`
            : args.path === 'appearance'
              ? `export const APPEARANCE_EVENT = 'yan:appearance';`
              : `const h = (...a) => globalThis.React.createElement(...a); export const Tip = ({ children }) => h('span', null, children);`
          return { contents, loader: 'js' }
        })
      }
    }]
  })
  const ui = await import(pathToFileURL(uiOut).href)
  const switchHtml = renderToStaticMarkup(createElement(ui.Switch, { checked: true, onChange: () => {}, label: 'loop', testId: 't' }))
  ok(switchHtml.includes('role="switch"'), '共享 Switch 仍是 role=switch 按钮')
  ok(switchHtml.includes('aria-checked="true"'), '共享 Switch 的 aria-checked 跟随 checked')
  ok(switchHtml.includes('switch-pill') && switchHtml.includes('switch-pill on'), '共享 Switch 使用既有样式类')

  /* ③ 两份 i18n 都有这三条键，且都不是空串。 */
  const zh = JSON.parse(await readFile('src/renderer/src/i18n/zh-CN.json', 'utf8'))
  const en = JSON.parse(await readFile('src/renderer/src/i18n/en-US.json', 'utf8'))
  for (const key of ['set.streamLoopAutoContinue', 'set.streamLoopAutoContinueDesc', 'set.streamLoopAutoContinueTip']) {
    ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh-CN 有 ${key}`)
    ok(typeof en[key] === 'string' && en[key].length > 0, `en-US 有 ${key}`)
  }

  console.log(`stream-loop-setting-ui: ${checks} checks passed (静态渲染，无 Electron / 无模型)`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
