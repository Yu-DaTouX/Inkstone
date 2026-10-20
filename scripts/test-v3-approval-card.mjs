#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
const out = []
const ok = (cond, label) => {
  if (!cond) throw new Error(label)
  out.push(label)
  console.log(`✓ ${label}`)
}

const storage = new Map()
const store = (k, v) => storage.set(String(k), String(v))
globalThis.localStorage = {
  getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
  setItem: (k, v) => store(k, v),
  removeItem: (k) => storage.delete(String(k)),
  clear: () => storage.clear(),
  key: () => null,
  length: 0
}
globalThis.window = globalThis
globalThis.HTMLElement = class HTMLElementStub {
  focus() {}
}
globalThis.screen = {
  width: 1440,
  height: 900,
  angle: 0,
  orientation: { angle: 0, addEventListener() {}, removeEventListener() {} }
}
globalThis.window.screen = globalThis.screen
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.window.addEventListener = () => undefined
globalThis.window.removeEventListener = () => undefined
globalThis.document = {
  readyState: 'complete',
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll: () => [],
  activeElement: null
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', clipboard: {} }, configurable: true })

await mkdir(join(ROOT, '.tmp'), { recursive: true })
const dir = await mkdtemp(join(ROOT, '.tmp', 'u5b-approval-'))
try {
  const entry = join(dir, 'entry.ts')
  await writeFile(
    entry,
    `export { ApprovalCard } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/features/session/ApprovalCard.tsx')))}\n` +
      `export { useStore } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/state/store.ts')))}\n` +
      `export { I18nProvider } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/i18n/index.tsx')))}\n`
  )
  const file = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.json': 'json', '.css': 'empty' },
    external: ['react', 'react-dom', 'react-dom/server', 'react-aria-components', 'react-aria', 'react-stately', '@react-aria/*', '@react-stately/*', '@react-types/*', 'lucide-react']
  })
  const mod = await import(pathToFileURL(file).href)

  const request = (over = {}) => ({
    id: 'a1',
    kind: 'danger',
    tool: 'bash',
    title: 'Agent 想运行一条命令',
    detail: 'rm -rf build && git push --force origin main',
    reasons: ['Git 强制推送，会覆盖远端历史'],
    cwd: 'E:/work/my-website',
    canRemember: false,
    createdAt: Date.now(),
    ...over
  })

  const render = (approval) => {
    const initial = mod.useStore.getInitialState()
    initial.approvals = approval ? [approval] : []
    return renderToStaticMarkup(createElement(mod.I18nProvider, { lang: 'zh-CN' }, createElement(mod.ApprovalCard)))
  }

  const html = render(request())
  ok(html.includes('data-testid="v3-approval-read-hint"'), '危险命令的审批卡显示「读完才能批准」提示')
  ok(html.includes('data-read="0"'), '刚出现的危险审批卡标记为未读完')
  ok(/data-testid="v3-approval-once"[^>]*disabled/.test(html), '未读完时允许按钮禁用')
  ok(!/data-testid="v3-approval-deny"[^>]*disabled/.test(html), '未读完时拒绝按钮仍可用')
  ok(html.includes('data-testid="v3-approval-feedback-open"'), '审批卡提供「拒绝并反馈」入口')
  ok(html.includes('data-armed="0"'), '刚出现的审批卡标记为未武装（400ms 防误触）')

  const safe = render(request({ kind: 'consent', detail: 'image.local', title: 'Agent 想使用「image.local」' }))
  ok(!safe.includes('data-testid="v3-approval-read-hint"'), '普通能力授权不出现读闸提示')
  ok(safe.includes('data-read="1"'), '普通能力授权直接可批准')
  ok(safe.includes('data-testid="v3-approval-feedback-open"'), '能力授权的审批卡提供「拒绝并反馈」入口')

  const harmless = render(request({ kind: 'move', tool: 'session' }))
  ok(!harmless.includes('data-testid="v3-approval-read-hint"'), '移动会话的确认不出现读闸提示')
  ok(harmless.includes('data-testid="v3-approval-feedback-open"'), '移动会话的审批卡提供「拒绝并反馈」入口')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`审批卡读闸与防误触：${out.length} 项通过`)
