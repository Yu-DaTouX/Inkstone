#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    try {
      fn(0)
    } catch {
    }
    return 0
  }
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { style: {}, clientWidth: 0, clientHeight: 0 }
  }
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }
}

const REACT_SHIM = `const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useInsertionEffect() {}
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useSyncExternalStore(_s, get) { return get() }
export function useDebugValue() {}
export function useId() { return rt().useId() }
export function useContext(ctx) { return ctx && '__value' in ctx ? ctx.__value : null }
export function createContext(value) { return { __isContext: true, __value: value, Provider: (p) => (p ? p.children : null) } }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out, key: out.key === undefined ? null : out.key } }
export function forwardRef(fn) { return fn }
export function useImperativeHandle(ref, factory) { const handle = factory(); if (ref) { if (typeof ref === 'function') ref(handle); else ref.current = handle } return handle }
export function memo(fn) { return fn }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, useId, useContext, createContext, createElement, forwardRef, useImperativeHandle, memo }
`
const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

const STORE_STUB = `const state = {
  runners: [], activeRunnerId: null, session: null, settings: { sendKey: 'auto' },
  attachments: [], messages: [], sessions: [], stats: null, models: [], commands: [], thinkingLevels: [],
  peekedSessionId: null, peekNote: null, sessionRuntimes: {}, authProviders: [],
  queue: { steering: [], followUp: [] }, pendingSends: [], notices: [], pendingSourceLinks: [],
  editorInject: null, composerInsert: null, queueRestore: null, composerFocus: { tick: 0 },
  send: async () => true, abort: async () => {}, runBash: async () => {}, notify: () => {}, holdSend: async () => {},
  clearAttachments: () => {}, addAttachments: () => {}, addFileRefs: async () => {}, addFileRefPaths: async () => {},
  setSessionDraft: () => {}, consumeEditorInject: () => {}, clearComposerInsert: () => {}, consumeQueueRestore: () => {},
  restoreSend: () => {}, removeQueued: async () => {}
}
export function pendingSendsForView(){ return [] }
export function currentThinkingLevels(s){ return s.thinkingLevels }
export function useStore(sel){ return sel ? sel(state) : state }
useStore.getState = () => state
useStore.setState = (patch) => { Object.assign(state, typeof patch === 'function' ? patch(state) : patch) }
useStore.subscribe = () => () => {}
export const __state = state
`

const STUBS = {
  'src/renderer/src/state/store.ts': STORE_STUB,
  'src/renderer/src/i18n/index.tsx': 'export function useT(){ return (k, p) => k === "composer.historyStatus" ? "历史记录 " + p.n + "/" + p.total : k }\nexport function useI18n(){ return { lang: "zh-CN" } }\nexport function translate(_l, k){ return String(k) }',
  'src/renderer/src/lib/composer-submit.ts': 'export async function submitComposerInput(){ return undefined }',
  'src/renderer/src/lib/v3-submit-ownership.ts': 'export function attachmentsAfterSubmit(a){ return a }\nexport async function runLocalCommandGuarded(){ return "ran" }',
  'src/renderer/src/features/composer/attachment-files.ts': 'export async function readFiles(){ return [] }',
  'src/renderer/src/ui/index.ts': 'export function Button(){ return null }\nexport function cx(){ return "" }',
  'src/renderer/src/patterns/ModelThinkingPicker.tsx': 'export function ModelThinkingPicker(){ return null }',
  'src/renderer/src/patterns/ContextRing.tsx': 'export function ContextRing(){ return null }',
  'src/renderer/src/features/composer/AttachmentStrip.tsx': 'export function AttachmentStrip(){ return null }\nexport function ImageRefWarning(){ return null }',
  'src/renderer/src/features/composer/ComposerMenu.tsx': 'export function ComposerMenu(){ return null }',
  'src/renderer/src/features/composer/useCompletion.ts': 'export function useCompletion(){ return { open: false, index: 0, slashMatches: [], atMatches: [], handleKey(){ return false } } }',
  'src/renderer/src/features/composer/ComposerBorder.tsx': 'export function ComposerBorder(){ return null }',
  'src/renderer/src/features/composer/PermissionToggle.tsx': 'export function PermissionToggle(){ return null }',
  'src/renderer/src/features/composer/PlusMenu.tsx': 'export function PlusMenu(){ return null }',
  'src/renderer/src/features/composer/ProjectPicker.tsx': 'export function ProjectPicker(){ return null }',
  'src/renderer/src/features/composer/QueueEditor.tsx': 'export function QueueEditor(){ return null }',
  'src/renderer/src/features/composer/VoiceButton.tsx': 'export function VoiceButton(){ return null }'
}

async function buildComposer(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entry = join(outdir, 'entry.ts')
  await writeFile(
    entry,
    `export { Composer } from '${posix(resolve(ROOT, 'src/renderer/src/features/composer/Composer'))}'\n` +
      `export { __state } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'\n` +
      `export * as layout from '${posix(resolve(ROOT, 'src/renderer/src/features/composer/composer-layout'))}'\n`
  )
  const stubMap = new Map(Object.entries(STUBS).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src]))
  const outfile = join(outdir, 'composer-layout.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'a2-layout-stubs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'react') return { path: reactShim }
            if (args.path === 'react/jsx-runtime' || args.path === 'react/jsx-dev-runtime') return { path: jsxShim }
            if (args.path === 'lucide-react') return { path: 'a2:lucide', namespace: 'a2' }
            if (!args.importer || !args.resolveDir) return undefined
            const base = resolve(args.resolveDir, args.path)
            for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
              const key = normalize(base + e)
              if (stubMap.has(key)) return { path: `a2:${key}`, namespace: 'a2' }
            }
            return undefined
          })
          b.onLoad({ filter: /.*/, namespace: 'a2' }, (args) => {
            if (args.path === 'a2:lucide') {
              return { contents: 'export function ArrowUp(){return null}\nexport function Square(){return null}\nexport function Hourglass(){return null}\nexport function GitMerge(){return null}', loader: 'js' }
            }
            return { contents: stubMap.get(args.path.slice('a2:'.length)) ?? 'export {}', loader: 'js' }
          })
        }
      }
    ]
  })
  return outfile
}

function hookRuntime() {
  const rt = {
    cells: [],
    idx: 0,
    effects: [],
    dirty: false,
    seq: 0,
    slot(kind) {
      const i = rt.idx++
      let c = rt.cells[i]
      if (!c || c.kind !== kind) c = rt.cells[i] = { kind, has: false, value: undefined, deps: undefined }
      return c
    },
    useState(init) {
      const c = rt.slot('state')
      if (!c.has) {
        c.value = typeof init === 'function' ? init() : init
        c.has = true
      }
      const set = (v) => {
        const next = typeof v === 'function' ? v(c.value) : v
        if (!Object.is(next, c.value)) {
          c.value = next
          rt.dirty = true
        }
      }
      return [c.value, set]
    },
    useRef(init) {
      const c = rt.slot('ref')
      if (!c.has) {
        c.value = { current: init }
        c.has = true
      }
      return c.value
    },
    useEffect(fn, deps) {
      const c = rt.slot('effect')
      const prev = c.deps
      const changed = !c.has || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]))
      if (changed) {
        c.deps = deps ? [...deps] : undefined
        c.has = true
        rt.effects.push(fn)
      }
    },
    useId() {
      return `v3id-${rt.seq++}`
    },
    render(Component, props) {
      let tree
      let guard = 0
      do {
        rt.dirty = false
        rt.idx = 0
        rt.effects = []
        tree = Component(props || {})
        for (const fn of rt.effects) fn()
      } while (rt.dirty && ++guard < 100)
      if (guard >= 100) throw new Error('浅渲染未收敛')
      return tree
    }
  }
  return rt
}

const children = (node) => {
  const c = node && node.props ? node.props.children : undefined
  if (c === undefined || c === null || c === false) return []
  return Array.isArray(c) ? c.filter((x) => x !== null && x !== undefined && x !== false) : [c]
}
const nameOf = (node) => (node && typeof node.type === 'function' ? node.type.name : node && typeof node.type === 'string' ? node.type : '')

function byClass(node, cls, out = null) {
  if (out) return out
  if (!node || typeof node !== 'object') return null
  const cn = node.props?.className
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) return node
  for (const child of children(node)) {
    const hit = byClass(child, cls)
    if (hit) return hit
  }
  return null
}

function byTestId(node, id) {
  if (!node || typeof node !== 'object') return null
  if (node.props?.['data-testid'] === id) return node
  for (const child of children(node)) {
    const hit = byTestId(child, id)
    if (hit) return hit
  }
  return null
}

function controlNames(node) {
  return children(node)
    .filter((child) => typeof child === 'object' && child)
    .map((child) => {
      const testid = child.props?.['data-testid']
      return testid ? `#${testid}` : nameOf(child)
    })
}

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-layout-'))
  try {
    const bundle = await import(pathToFileURL(await buildComposer(outdir)).href)
    const { Composer, __state, layout } = bundle

    ok(layout.COMPOSER_LEFT_ORDER.join('>') === 'mode>permission>plus', '底栏左侧顺序：模式徽标→权限→＋')
    ok(layout.COMPOSER_RIGHT_ORDER.join('>') === 'voice>context>model-thinking>run>send', '底栏右侧顺序：语音→上下文环→模型+思考→运行位→发送')
    ok(layout.composerMode('!ls') === 'bash' && layout.composerMode('/model') === 'cmd' && layout.composerMode('你好') === null, '模式徽标判据与 v3 现有 bash/ slash 一致')
    ok(layout.composerPrompt('!ls') === '$' && layout.composerPrompt('普通') === '›', '提示符：直执行 $、普通 ›')
    ok(layout.composerLocalCommand('!ls', []) === true, '! 前缀是本地命令')
    ok(layout.composerLocalCommand('/ultracode', [{ source: 'yan', name: 'ultracode' }]) === true, '单独的 /ultracode 走本地提示用法')
    ok(layout.composerLocalCommand('/ultracode 审一遍接口', [{ source: 'yan', name: 'ultracode' }]) === false, '/ultracode 带任务按普通消息发送')
    ok(layout.composerLocalCommand('/login', []) === true, '/login 是本地命令')
    ok(layout.composerLocalCommand('/login extra', []) === true, '/login 带参数也是本地命令')
    ok(
      layout.composerLocalCommand('/model x', [{ source: 'yan', name: 'Model' }]) === true,
      'yan/compatibility 命令名大小写不敏感'
    )
    ok(layout.composerLocalCommand('/model x', [{ source: 'pi', name: 'model' }]) === false, 'pi 命令不下发到本地通道')
    ok(layout.composerLocalCommand('/nope', [{ source: 'yan', name: 'model' }]) === false, '未知命令不是本地命令')
    ok(layout.composerLocalCommand(' /login', []) === false, '带前导空格的 /login 按普通文本发送')
    ok(layout.composerLocalCommand('  !ls', []) === false, '带前导空格的 ! 不进直执行')
    ok(layout.composerLocalCommand('/modely', [{ source: 'yan', name: 'model' }]) === false, '命令名需完整匹配')
    ok(layout.composerSubmitAction({ running: true, hasText: false, hasAttachments: false }) === 'stop', '运行中 + 空 + 无附件 → 停止')
    ok(layout.composerSubmitAction({ running: true, hasText: true, hasAttachments: false }) === 'send', '运行中 + 有字 → 发送（插话）')
    ok(layout.composerSubmitAction({ running: true, hasText: false, hasAttachments: true }) === 'send', '运行中 + 有附件 → 发送')
    ok(layout.composerSubmitAction({ running: false, hasText: false, hasAttachments: false }) === 'send', '空闲 → 发送')

    const rt = hookRuntime()
    globalThis.__V3_HOOKS = rt
    Object.assign(__state, {
      runners: [],
      activeRunnerId: null,
      session: null,
      settings: { sendKey: 'auto' },
      attachments: [],
      queue: { steering: [], followUp: [] },
      pendingSends: [],
      editorInject: null,
      composerInsert: null,
      queueRestore: null,
      composerFocus: { tick: 0 },
      sessionRuntimes: {}
    })
    let tree = rt.render(Composer, {})
    const wrap = tree
    ok(typeof wrap.props.className === 'string' && wrap.props.className.includes('composer-wrap'), '根是框外的 composer-wrap')
    const wrapChildren = children(wrap).filter((child) => nameOf(child) !== 'IsolationMergeBar')
    ok(nameOf(wrapChildren[0]) === 'QueueEditor', '队列紧挨根、在输入框卡片外上方（合入确认条除外）')
    ok(byClass(wrap, 'composer') === wrapChildren[1], '输入框卡片紧跟队列')
    ok(byClass(wrap, 'composer') === children(wrap)[children(wrap).length - 1], '输入框卡片在根末尾，下方不再有会话统计行（统计改到会话栏卡片）')

    const card = byClass(wrap, 'composer')
    ok(nameOf(children(card)[0]) === 'ComposerBorder', '卡片首行是输入框顶边')
    ok(nameOf(children(card)[1]) === 'AttachmentStrip', '附件条在卡片内、输入行之前')

    const line = byClass(card, 'composer-line')
    const lineChildren = children(line)
    ok(nameOf(lineChildren[0]) === 'span' && lineChildren[0].props['aria-hidden'] === true, '提示符在最左且 aria-hidden')
    ok(typeof lineChildren[1].type === 'function' && lineChildren[1].props['data-testid'] === 'composer-input', '提示符之后是编辑器门面，testid 保留')
    ok(typeof lineChildren[1].props.onChange === 'function' && typeof lineChildren[1].props.onKeyDown === 'function', '门面仍以 onChange / onKeyDown 回调上层')

    const editorText = await readFile(join(ROOT, 'src/renderer/src/features/composer/ComposerEditor.tsx'), 'utf8')
    ok(!/<textarea/.test(editorText), '编辑器门面不再渲染 textarea')
    ok(
      /role="textbox"/.test(editorText) && /contentEditable/.test(editorText),
      '宿主是可编辑节点（role=textbox + contenteditable）'
    )
    ok(/data-testid=\{props\['data-testid'\]\}/.test(editorText), '宿主透传 data-testid=composer-input')
    ok(
      /new EditorView\(/.test(editorText) && /from 'prosemirror-view'/.test(editorText),
      '门面内部挂 ProseMirror EditorView'
    )
    ok(/data-empty="/.test(editorText) && /dataset\.empty/.test(editorText), '空态用 data-empty 驱动占位符')

    const tools = byClass(card, 'composer-tools')
    ok(controlNames(tools).join('>') === 'PermissionToggle>ProjectPicker>PlusMenu', '左侧控件：权限在最左、新会话项目选择次之、＋随后；无模式/提示时不显示')
    const bar = byClass(card, 'composer-bar')
    const barControls = controlNames(bar)
    ok(
      barControls.join('>') === 'div>div>ModelThinkingPicker>#composer-send',
      '底栏右侧顺序：语音与上下文一组→模型+思考→发送（运行中只换成停止键，不另显标注）',
      barControls
    )
    ok(controlNames(byClass(card, 'composer-aux')).join('>') === 'VoiceButton>ContextRing', '语音与上下文环收在右侧同一组')
    ok(byTestId(card, 'composer-send').props.size === 'sm', '发送键用小号按钮')
    ok(byTestId(card, 'composer-send') !== null && byTestId(card, 'composer-stop') === null, '空闲时发送键在发送位')

    const ta = byTestId(card, 'composer-input')
    ta.props.onChange({ text: '你好', cursor: 2 })
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-send') !== null && byTestId(tree, 'composer-stop') === null, '空闲 + 有字 → 发送')

    __state.runners = [{ runId: 'r1', running: true }]
    __state.activeRunnerId = 'r1'
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-stop') !== null, '运行中 + 空 + 无附件 → 停止')
    const ta2 = byTestId(tree, 'composer-input')
    ta2.props.onChange({ text: '插一句', cursor: 3 })
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-send') !== null && byTestId(tree, 'composer-stop') === null, '运行中 + 有字 → 发送（插话）')

    const ta3 = byTestId(tree, 'composer-input')
    ta3.props.onChange({ text: '', cursor: 0 })
    __state.attachments = [{ id: 'a1', name: 'x.png', mimeType: 'image/png', size: 1, data: '', preview: '', kind: 'image' }]
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-send') !== null && byTestId(tree, 'composer-stop') === null, '运行中 + 有附件 → 发送')
    __state.attachments = []

    const ta4 = byTestId(tree, 'composer-input')
    ta4.props.onChange({ text: '!npm test', cursor: 9 })
    tree = rt.render(Composer, {})
    const tools2 = byClass(tree, 'composer-tools')
    ok(controlNames(tools2)[0] === '#composer-mode', '输入 `!` 时模式徽标排在最左')
    ok(byClass(tree, 'composer-prompt').props.children === '$', '直执行模式提示符为 $')

    __state.settings = { sendKey: 'ctrlEnter' }
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-keyhint') === null, '发送键非默认时也不在底栏显示按键提示')


    const composerCssText = await readFile(join(ROOT, 'src/renderer/src/features/composer/composer.css'), 'utf8')
    ok(/\n\s*\.composer\s*\{[^}]*position:\s*relative/.test(composerCssText), '卡片为绝对定位的顶边提供定位上下文')
    ok(/\n\s*\.cborder\s*\{[^}]*position:\s*absolute/.test(composerCssText), '顶边绝对定位，不占用卡片高度')
    ok(/\n\s*\.cborder\s*\{[^}]*opacity:\s*0/.test(composerCssText), '空闲时顶边完全不可见')
    ok(/\n\s*\.cborder\[data-state='working'\]\s*\{\s*opacity:\s*1/.test(composerCssText), '只有运行中才亮起顶边')
    ok(/\n\s*\.cborder\s*\{[^}]*border-radius:\s*inherit/.test(composerCssText), '顶边继承卡片圆角，不在圆角外露直角')
    ok(/\.cborder\[data-level='max'\]\s*\{\s*border-top-color:/.test(composerCssText), '顶边只染上边且颜色取档位')
    ok(/\n\s*\.composer-text\s*\{[^}]*white-space:\s*pre-wrap/.test(composerCssText), '编辑器宿主保留连续空白与手动换行（pre-wrap）')
    ok(/\n\s*\.composer-text\s*\{[^}]*max-height:/.test(composerCssText), '编辑器宿主自增高到上限后内部滚动')
    ok(
      /\.composer-text\[data-placeholder-visible='true'\]\[data-placeholder\]::before/.test(composerCssText),
      '占位符由 data-placeholder 伪元素绘制（contenteditable 没有 ::placeholder）'
    )
    ok(!/\.composer-text::placeholder/.test(composerCssText), '不再残留 textarea 的 ::placeholder 规则')
    for (const rel of [
      'src/renderer/src/features/composer/Composer.tsx',
      'src/renderer/src/features/composer/composer.css',
      'src/renderer/src/features/composer/VoiceButton.tsx',
      'src/renderer/src/features/composer/ComposerBorder.tsx',
      'src/renderer/src/patterns/ModelThinkingPicker.tsx',
      'src/renderer/src/patterns/model-thinking-picker.css'
    ]) {
      const text = await readFile(join(ROOT, rel), 'utf8')
      const v2Entry = /\bfrom\s+['"][^'"]*components\/ui['"]/.test(text)
      ok(!/styles\//.test(text) && !v2Entry, `${rel} 不 import v2 样式/旧控件入口（只允许复用 pulse-field 纯模块）`)
    }

    const menuText = await readFile(join(ROOT, 'src/renderer/src/features/composer/ComposerMenu.tsx'), 'utf8')
    ok(
      menuText.includes(`querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })`),
      '补全菜单把高亮项按 nearest 滚进视野'
    )
    ok(/querySelector<HTMLElement>\('\[data-selected="true"\]'\)[\s\S]{0,120}?\}, \[open, index\]\)/.test(menuText), '滚动只跟随高亮索引变化触发')
    ok(
      /pointerIndex\.current = next === index \? null : next\s*completion\.setIndex\(next\)/.test(menuText) &&
        /if \(pointerIndex\.current === index\) \{\s*pointerIndex\.current = null\s*return\s*\}/.test(menuText),
      '鼠标悬停改的高亮不回滚列表'
    )
    ok((menuText.match(/onMouseEnter=\{\(\) => hoverIndex\(/g) ?? []).length === 3, '三处选项的悬停都走同一入口')
    ok(
      /data-testid="composer-menu-status"/.test(menuText) && /aria-live="polite"/.test(menuText),
      '补全浮层 portal 里带 aria-live 播报行'
    )

    ok(layout.composerPlaceholderKey({ bash: true, session: true, firstRun: true }) === 'composer.phBash', '占位符：bash 模式优先')
    ok(layout.composerPlaceholderKey({ bash: false, session: true, firstRun: false }) === 'composer.phSession', '占位符：已有会话')
    ok(layout.composerPlaceholderKey({ bash: false, session: false, firstRun: true }) === 'composer.phFirst', '占位符：首次使用')
    ok(layout.composerPlaceholderKey({ bash: false, session: false, firstRun: false }) === 'composer.phDraft', '占位符：普通草稿')

    const placeholderOf = () => byTestId(rt.render(Composer, {}), 'composer-input').props.placeholder
    const typeInto = (text) => byTestId(rt.render(Composer, {}), 'composer-input').props.onChange({ text, cursor: text.length })
    typeInto('')
    __state.runners = []
    __state.activeRunnerId = null
    __state.sessions = [{ id: 's0', messageCount: 0 }]
    __state.session = null
    __state.messages = []
    ok(placeholderOf() === 'composer.phFirst', '首次使用（没有任何会话消息）→ 「描述要构建…」')
    __state.sessions = [{ id: 's0', messageCount: 3 }]
    ok(placeholderOf() === 'composer.phDraft', '首页草稿（已有历史会话但当前没有会话）→ 「描述任务或提问」')
    __state.session = { sessionId: 's1' }
    __state.messages = [{ id: 'm1', role: 'user', text: '你好' }]
    ok(placeholderOf() === 'composer.phSession', '会话内且无输入 → 「输入 / 使用命令」')
    typeInto('!ls')
    ok(placeholderOf() === 'composer.phBash', 'bash 模式 → 「输入 shell 命令」')
    typeInto('')
    __state.runners = [{ runId: 'r1', running: true }]
    __state.activeRunnerId = 'r1'
    ok(String(placeholderOf()).includes('Enter') && String(placeholderOf()).includes('queue.queueIt'), '回合运行中 → 保留发送/排队两条车道提示')
    __state.runners = []
    __state.activeRunnerId = null

    __state.messages = [
      { id: 'h1', role: 'user', text: '第一条' },
      { id: 'h2', role: 'assistant', text: '回复' },
      { id: 'h3', role: 'user', text: '第二条' }
    ]
    typeInto('')
    ok(byTestId(rt.render(Composer, {}), 'composer-history-status') === null, '未浏览历史时不占用提示行')
    const pressHistoryKey = (key) => {
      byTestId(rt.render(Composer, {}), 'composer-input').props.onKeyDown({
        key, preventDefault() {}, nativeEvent: {}
      })
      return rt.render(Composer, {})
    }
    tree = pressHistoryKey('ArrowUp')
    let history = byTestId(tree, 'composer-history-status')
    ok(history?.props.children === '历史记录 2/2', '首次 ↑ 显示最新一条的序号与用户消息总数')
    ok(history?.props.className === 'composer-history' && !history.props.className.includes('sr-only'), '历史序号可见，不再仅供读屏')
    ok(children(byClass(tree, 'composer-input')).indexOf(history) < children(byClass(tree, 'composer-input')).indexOf(byClass(tree, 'composer-line')), '历史序号位于输入内容上方')
    tree = pressHistoryKey('ArrowUp')
    ok(byTestId(tree, 'composer-history-status')?.props.children === '历史记录 1/2', '继续 ↑ 显示更早的序号')
    tree = pressHistoryKey('ArrowDown')
    ok(byTestId(tree, 'composer-history-status')?.props.children === '历史记录 2/2', '↓ 回到较新序号')
    tree = pressHistoryKey('ArrowDown')
    ok(byTestId(tree, 'composer-history-status') === null, '↓ 回到草稿后隐藏提示')
    pressHistoryKey('ArrowUp')
    tree = pressHistoryKey('a')
    ok(byTestId(tree, 'composer-history-status') === null, '开始编辑后隐藏历史序号')
    pressHistoryKey('ArrowUp')
    __state.session = { sessionId: 'history-other' }
    tree = rt.render(Composer, {})
    ok(byTestId(tree, 'composer-history-status') === null, '切换会话后清除历史序号')
    for (const [lang, label] of [['zh-CN', '历史记录 {n}/{total}'], ['en-US', 'History {n}/{total}']]) {
      const messages = JSON.parse(await readFile(join(ROOT, `src/renderer/src/i18n/${lang}.json`), 'utf8'))
      ok(messages['composer.historyStatus'] === label, `${lang} 历史序号文案使用当前条/总条数`)
    }

    console.log(`\n结果：${checks} 项通过`)
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
