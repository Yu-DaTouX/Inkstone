import { runSuite } from './lib/test-suite.mjs'
import { parseHTML } from 'linkedom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

await runSuite(import.meta.url, async (ok, compile) => {
  const stubs = {
    '../../i18n': 'export const useT = () => key => key',
    '../../state/store': 'export const useStore = selector => selector({ messages: [], previewFile() {} })',
    '../../ui': "import React from 'react'; const Item = p => React.createElement('button', { onClick: p.onPress, 'data-testid': p['data-testid'] }, p.children); export const Button = Item, IconButton = Item, Badge = Item, Notice = Item",
    '../../lib/file-preview-url': 'export const filePreviewUrl = path => path',
    '../artifacts/HtmlArtifactThumb': 'export const HtmlArtifactThumb = () => null',
    '../artifacts/widget-lifecycle': 'export const deriveArtifactIdentityKey = (...args) => args.join("|"); export const useNearViewport = () => [true, () => {}]; export const usePreviewSnapshot = () => ({ status: "idle" })',
    './Icon': 'export const Icon = () => null',
    '../composer/image-viewer': 'export const ImageViewer = () => null'
  }
  const { TurnArtifacts } = await compile('src/renderer/src/features/session/MessageParts.tsx', {
    packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'artifact-ui', setup(build) {
      build.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : null)
      build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: stubs[path], resolveDir: process.cwd() }))
    } }]
  })
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const requests = []
  window.yan = { readPreview: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })) }
  const root = createRoot(document.getElementById('root'))
  const artifact = (id, extra = {}) => ({ id, sourceId: id, path: `C:/fixture/${id}.md`, filename: `${id}.md`, kind: 'code', mediaType: 'text/markdown', bytes: 100, createdAt: 1, previewable: true, ...extra })
  const render = async item => act(async () => root.render(item ? React.createElement(TurnArtifacts, { artifacts: [item], sessionId: 'fixture' }) : null))
  const content = () => document.querySelector('[data-testid="v3-artifact-code"]')?.textContent
  const resolve = async (request, text) => act(async () => request.resolve({ ok: true, text }))
  const body = Array.from({ length: 20 }, (_, i) => `预览内容第 ${i + 1} 行`).join('\n')
  try {
    const first = artifact('one')
    await render(first)
    ok(requests.length === 1 && content() === 'artifact.reading', '首次挂载按原流程读取')
    await resolve(requests[0], body)
    ok(content() === body.split('\n').slice(0, 12).join('\n'), '默认仍显示十二行预览')
    await render(null)
    const beforeRemount = requests.length
    await render({ ...first })
    ok(content() === body.split('\n').slice(0, 12).join('\n'), '虚拟行重挂载立即保留已读正文，不缩回加载占位')
    ok(requests.length === beforeRemount, '同一成果重挂载不重复发读取请求')
    await act(async () => document.querySelector('[data-testid="v3-artifact-code-toggle"]').click())
    ok(content() === body, '缓存不丢失展开所需的剩余正文')

    const pending = artifact('pending')
    await render(pending)
    const pendingRequest = requests.at(-1)
    await render(null)
    await resolve(pendingRequest, body)
    const beforePending = requests.length
    await render(pending)
    ok(content().startsWith('预览内容第 1 行') && requests.length === beforePending, '读取期间卸载，完成结果仍供下次挂载复用')

    const failed = artifact('failed')
    await render(failed)
    await act(async () => requests.at(-1).resolve({ ok: false }))
    ok(content() === 'artifact.htmlRead', '读取失败保留原错误提示')
    await render(null)
    const beforeRetry = requests.length
    await render(failed)
    ok(requests.length === beforeRetry + 1, '失败不缓存，下次挂载允许重试')
    await resolve(requests.at(-1), 'retry succeeded')
    await render(null)
    await render(artifact('one', { sha256: 'changed' }))
    ok(content() === 'artifact.reading', '内容指纹变化不沿用旧版本正文')
    await resolve(requests.at(-1), 'new version')
    await render(null)
    const beforeUnavailable = requests.length
    await render({ ...first, unavailable: true })
    ok(content() === 'artifact.noPreview' && requests.length === beforeUnavailable, '已不可用的成果不显示缓存正文或继续读取')

    for (let i = 0; i < 34; i++) {
      await render(artifact(`evict-${i}`))
      await resolve(requests.at(-1), 'short text')
    }
    await render(null)
    const beforeEvicted = requests.length
    await render(artifact('evict-0'))
    ok(requests.length === beforeEvicted + 1, '条目上限淘汰旧预览')
    await resolve(requests.at(-1), 'old read again')
    for (let i = 0; i < 3; i++) {
      await render(artifact(`large-${i}`))
      await resolve(requests.at(-1), 'x'.repeat(800000))
    }
    await render(null)
    const beforeBudget = requests.length
    await render(artifact('large-0'))
    ok(requests.length === beforeBudget + 1, '总字符预算淘汰旧大文件，不无界保留正文')
  } finally {
    await act(async () => root.unmount())
  }
})
