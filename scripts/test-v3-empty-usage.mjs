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

function statsOf(shared, { main, subagents }, range, now) {
  return shared.aggregateUsageSources({ main: main ?? [], subagents: subagents ?? [] }, range, now)
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
    `import { V3EmptyState } from '${p('src/renderer/src/features/session/V3EmptyState.tsx')}'`,
    `import * as View from '${p('src/renderer/src/features/usage/UsageOverviewView.tsx')}'`,
    `import * as Pattern from '${p('src/renderer/src/patterns/UsagePattern.tsx')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    `import * as shared from '${p('src/shared/usage-stats.ts')}'`,
    'export { React, renderToStaticMarkup, V3EmptyState, View, Pattern, i18n, shared }'
  ].join('\n')
  const outfile = join(outdir, 'v3-empty-usage.bundle.cjs')
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

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-empty-usage-'))
  const require = createRequire(import.meta.url)
  const bundle = require(await buildBundle(outdir))
  const { React, renderToStaticMarkup, V3EmptyState, View, Pattern, i18n, shared } = bundle
  const { createElement } = React

  const now = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const recent = shared.localDay(now)
  const day = (date, m, t, hour, models) => ({ [date]: { m, t, h: { [hour]: m }, models } })
  const tOf = (lang) => (key, vars) => i18n.translate(lang, key, vars)

  const mainSub = statsOf(shared, { main: [day(recent, 1, 20000, 9, { 'p/a': 20000 })], subagents: [day(recent, 3, 80000, 9, { 'p/b': 80000 })] }, 'all', now)
  const childOnly = statsOf(shared, { subagents: [day(recent, 3, 80000, 9, { 'p/b': 80000 })] }, 'all', now)
  const empty = statsOf(shared, {}, 'all', now)

  const usageView = (stats, lang = 'zh-CN', renderToggle) =>
    createElement(View.UsageOverviewView, {
      stats,
      range: 'all',
      tab: 'overview',
      models: [],
      t: tOf(lang),
      onTabChange: () => {},
      onRangeChange: () => {},
      renderToggle
    })

  const renderEmpty = (usage, lang = 'zh-CN') => {
    globalThis.localStorage.setItem('yan.lang', lang)
    return renderToStaticMarkup(createElement(i18n.I18nProvider, null, createElement(V3EmptyState, { usage })))
  }

  const html = renderEmpty(usageView(mainSub, 'zh-CN', Pattern.renderUsageToggle))

  ok(html.includes('class="v3-empty v3-empty-page"') && html.includes('v3-empty-cols'), '空态根部使用生产版面类 v3-empty-page / v3-empty-cols')
  ok(html.includes('class="v3-empty-main"'), '左栏 primary 容器 v3-empty-main 存在')
  ok(html.includes('v3-empty-greet') && html.includes('Hello world') && !html.includes('HELLO WORLD') && !html.includes('v3-empty-prompt'), '问候用正文字体的 Hello world，不再是全大写终端提示')
  ok(html.indexOf('data-testid="usage-strip"') > html.indexOf('v3-empty-greet') && html.indexOf('data-testid="usage-strip"') < html.indexOf('data-testid="usage-overview"'), '一行用量紧跟在问候下方')
  ok(!html.includes('class="v3-empty-hint"'), '首页旧标语移除')
  const iMain = html.indexOf('class="v3-empty-main"')
  const iUsage = html.indexOf('data-testid="usage-overview"')
  ok(iMain >= 0 && iUsage > iMain, '用量面板在问候之后（右栏），不是替代左栏')

  ok(html.includes('data-testid="usage-tokens"') && html.includes('100K'), '空态右栏渲染 Token 合计 100K')
  ok(!html.includes('usage-token-breakdown') && !html.includes('主会话 20K'), '空态右栏只显示总数，不拆主会话 / 子代理')

  ok((html.match(/role="tablist"/g) ?? []).length === 1, 'v3 页签渲染出一个 role="tablist"（Tabs 原语）')
  ok(html.includes('aria-label="本机用量"') && html.includes('aria-label="统计范围"'), '页签与范围控件都有可读名称（键盘与读屏可用结构）')
  ok((html.match(/role="tab"/g) ?? []).length >= 2, '概览 / 模型渲染为 role="tab"', (html.match(/role="tab"/g) ?? []).length)
  ok(html.includes('ui-seg') && (html.match(/ui-seg__item/g) ?? []).length >= 3, '全部 / 30 天 / 7 天渲染为 SegmentedControl')
  ok(html.includes('aria-selected="true"') && html.includes('aria-selected="false"'), 'tab 有 aria-selected 选中态（键盘与读屏可用结构）')
  ok(html.includes('data-usage-control="tab"') && html.includes('data-usage-control="range"'), '两组控件分别标记 tab / range')
  ok(html.includes('>概览<') && html.includes('>模型<') && html.includes('>全部<') && html.includes('>30 天<') && html.includes('>7 天<'), '范围与页签文案都来自同一 API 的选项')
  ok(!html.includes('class="start-toggle"'), 'v3 路径不渲染旧的 .start-toggle 文字按钮')

  const childHtml = renderEmpty(usageView(childOnly, 'zh-CN', Pattern.renderUsageToggle))
  ok(childHtml.includes('data-testid="usage-overview"') && childHtml.includes('80K'), '只有子代理时空态仍渲染用量面板')
  ok(!childHtml.includes('主会话 0'), '只有子代理时也不出现拆分行')
  ok(childHtml.includes('>0</dd>'), '主会话相关计数如实渲染 0，不虚增')

  const emptyHtml = renderEmpty(usageView(empty, 'zh-CN', Pattern.renderUsageToggle))
  ok(!emptyHtml.includes('data-testid="usage-overview"'), '无历史时空态不渲染用量面板')
  ok(emptyHtml.includes('v3-empty-greet') && emptyHtml.includes('v3-empty-cols'), '无历史时问候与两栏版面仍在')

  const keepView = (stats) => createElement(View.UsageOverviewView, {
    stats, range: 'all', tab: 'overview', models: [], t: tOf('zh-CN'), onTabChange: () => {}, onRangeChange: () => {},
    renderToggle: Pattern.renderUsageToggle, keepWhenEmpty: true, emptyNote: '还没有用量记录'
  })
  const keepEmpty = renderEmpty(keepView(empty))
  ok(keepEmpty.includes('data-testid="usage-overview"') && keepEmpty.includes('data-testid="usage-empty-note"'), 'v3 无记录时仍渲染用量框架并给出说明')
  ok(keepEmpty.includes('>0</dd>'), 'v3 无记录时计数显示 0')
  const keepPending = renderEmpty(keepView(null))
  ok(keepPending.includes('data-testid="usage-overview"') && keepPending.includes('data-pending=""'), 'v3 取数中仍渲染用量框架并标记 pending')
  ok(keepPending.includes('>—</span>') && keepPending.includes('>—</dd>'), 'v3 取数中数字显示「—」占位')
  ok(!keepPending.includes('usage-empty-note'), '取数中不误报「无记录」')
  ok(html.includes('data-testid="usage-strip"'), '首页始终渲染一行用量条')
  ok(html.includes('ui-ascii-spark start-strip-spark') && html.includes('--spark-cell:12px') && (html.match(/ui-ascii-spark__cell/g) ?? []).length === 14 && !html.includes('start-strip-bars'), '首页用量柱是 14 格 AsciiSpark，字宽对齐字符场 12px 网格')

  const enHtml = renderEmpty(usageView(mainSub, 'en-US', Pattern.renderUsageToggle), 'en-US')
  ok(enHtml.includes('Hello world') && !enHtml.includes('class="v3-empty-hint"'), '英文空态同样使用终端问候，无旧标语')
  ok(enHtml.includes('data-testid="usage-overview"') && !enHtml.includes('Subagents 80K'), '英文长文案下用量面板仍渲染，不被内容长度错误隐藏')

  const css = await readFile(join(process.cwd(), 'src/renderer/src/features/session/v3-empty-state.css'), 'utf8')
  ok(css.includes("container-type: inline-size"), 'CSS：v3-empty-page 建立 inline-size 容器（按真实对话列宽度判定）')
  ok(/\.v3-empty-cols\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/.test(css), 'CSS：问候与用量同列堆叠')
  ok(/\.v3-empty-main\s*\{[^}]*align-items:\s*center;[^}]*text-align:\s*center;/.test(css), 'CSS：问候与用量居中，与输入框共用居中轴')
  ok(/\.v3-chat:has\(\.v3-empty-page\) > \.v3-composer\s*\{[^}]*bottom:\s*var\(--home-lift\)/.test(css) && /\.v3-empty\.v3-empty-page\s*\{[^}]*padding:\s*0 0 calc\(var\(--home-lift, 0px\) \+ var\(--s-20\)\)/.test(css), 'CSS：首页输入框与问候同一抬升量，三者成组位于主区约 40% 高度，统计行与输入框留出间距')
  ok(/\.v3-chat:has\(\.v3-empty-page\)\s*\{[^}]*--col-window-shift:\s*0px;[^}]*--col-pad-shift:\s*0px;/.test(css), 'CSS：首页按侧栏右侧的主区水平居中，不按整窗')
  ok(!css.includes('font-family: var(--font-mono)') && !css.includes('letter-spacing: 0.06em'), 'CSS：问候不再用等宽宽字距')
  const fixedCaps = [...css.replace(/@container\s*\([^)]*\)/g, '').matchAll(/max-width\s*:\s*([^;}]+)/g)].filter((m) => m[1].trim() !== '100%')
  ok(fixedCaps.length === 0, 'CSS：除容器查询判定外没有固定 max-width 规则（避免旧 max-width 让统计永远隐藏）', fixedCaps.map((m) => m[0]))

  const patternCss = await readFile(join(process.cwd(), 'src/renderer/src/patterns/usage-pattern.css'), 'utf8')
  const patternCode = patternCss.replace(/\/\*[\s\S]*?\*\//g, '')
  ok(patternCode.includes('@layer patterns'), 'CSS：用量领域排版在 @layer patterns（只随 v3 入口加载）')
  ok(!patternCode.includes('@import'), 'CSS：patterns 用量样式不 @import 任何文件')
  ok(!/styles\/|chat\.css/.test(patternCode), 'CSS：patterns 用量样式不依赖 v2 styles/chat.css')
  ok(!/\.ui-tab|\.ui-btn|\.start-toggle/.test(patternCode), 'CSS：patterns 只做领域排版 / 图形，不重写 Tabs 原语按钮皮肤')

  const sessionView = await readFile(join(process.cwd(), 'src/renderer/src/features/session/SessionView.tsx'), 'utf8')
  ok(sessionView.includes("import { V3EmptyState } from './V3EmptyState'"), 'SessionView 引入 V3EmptyState（入口补丁已应用）')
  ok(/turns\.length === 0 \?[\s\S]{0,160}?<V3EmptyState\b[^>]*\/>/.test(sessionView), 'SessionView 空态分支渲染 V3EmptyState')
  ok(sessionView.includes('switchLoading ? null : <V3EmptyState'), '切换会话加载中先不渲染空态（避免闪空）')
  ok(!sessionView.includes('function EmptyState(): JSX.Element') && !sessionView.includes('<EmptyState />'), '旧局部 EmptyState 已移除，不再有未接线的空态')

  const patternSrc = await readFile(join(process.cwd(), 'src/renderer/src/patterns/UsagePattern.tsx'), 'utf8')
  const pattern0 = () => patternSrc
  const emptyState = await readFile(join(process.cwd(), 'src/renderer/src/features/session/V3EmptyState.tsx'), 'utf8')
  ok(!emptyState.includes('UsagePattern'), 'V3EmptyState 首页不再渲染整块用量面板，只留一行用量')
  ok(pattern0().includes('keepWhenEmpty'), 'UsagePattern 让 v3 用量在取数中 / 无记录时保留框架')
  ok(emptyState.includes('<UsageStrip'), 'V3EmptyState 在问候下渲染一行用量条')
  ok(emptyState.includes("import './v3-empty-state.css'"), 'V3EmptyState 自己 import 专用版面 CSS')

  const pattern = patternSrc
  ok(pattern.includes("import { SegmentedControl, Tab, TabList, Tabs } from '../ui'"), 'UsagePattern 控件只来自 v3 ui/ primitives')
  ok(pattern.includes("import { UsageOverview } from '../features/usage/UsageOverview'"), 'UsagePattern 复用正式 UsageOverview 取数容器')
  ok(pattern.includes('renderToggle={renderUsageToggle}'), 'UsagePattern 把生产控件槽传进共享展示链')
  ok(pattern.includes("import './usage-pattern.css'"), 'UsagePattern 载入 patterns 领域 CSS')

  const viewSrc = await readFile(join(process.cwd(), 'src/renderer/src/features/usage/UsageOverviewView.tsx'), 'utf8')
  ok(viewSrc.includes('renderToggle: UsageToggleRenderer'), '共享展示件的 renderToggle 槽必填')
  ok(!viewSrc.includes('start-toggle'), '共享展示件不再保留无样式的 .start-toggle 回退')

  const designEntry = await readFile(join(process.cwd(), 'src/renderer/src/design/index.css'), 'utf8')
  ok(designEntry.includes('@layer reset, tokens, base, primitives, patterns, features, utilities;'), 'v3 入口声明 patterns 层，pattern CSS 落到既定层序')

  const chatMain = await readFile(join(process.cwd(), 'src/renderer/src/app/ChatMain.tsx'), 'utf8')
  ok(chatMain.includes('import { SessionView }') && chatMain.includes('<SessionView />'), '真实入口 ChatMain 渲染 SessionView（与 ShellV3 同一链）')

  ok(sessionView.includes("import { AsciiField } from '../ambient/AsciiField'") && /<AsciiField\s+active=\{turns\.length === 0[^}]*\}/.test(sessionView), 'ASCII 层与空态判定未被本任务改动')
  ok(!sessionView.includes('StalledCard') && sessionView.includes('className="v3-asks"') && sessionView.includes('onScroll={onScroll}'), '滚动 / 审批 / 提问分支仍保留，停滞卡已移除')
  ok(sessionView.includes('VList') && sessionView.includes('renderTurns'), '虚拟列表与回合投影仍保留')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3-empty-usage: ${checks} checks passed`)
}

await main()
