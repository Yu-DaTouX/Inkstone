/**
 * 成果视图（WP-32 · R5）的 host-free 单测。
 *
 * 只现场编译三份**纯逻辑**文件，在 Node 里直接跑；不启动 Electron、不碰 pi、
 * 不读用户目录、不跑真实浏览器或模型：
 *
 *   src/renderer/src/features/artifacts/model.ts   身份 / 形态 / 活跃上限 / 安全桥 / 归属 / 预览分类
 *   src/shared/visual-blocks.ts                     结构化块校验（复用的既有纯逻辑）
 *   src/shared/html-artifact-preview.ts             离线协议与 CSP 契约（确认没有放宽）
 *
 *   node scripts/test-v3-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function loadTs(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const model = await loadTs('../src/renderer/src/features/artifacts/model.ts')
const visuals = await loadTs('../src/shared/visual-blocks.ts')
const html = await loadTs('../src/shared/html-artifact-preview.ts')

/* ── 身份 ─────────────────────────────────────────────────────── */
{
  const identity = { sessionId: 's1', messageId: 'm1', partIndex: 2, toolCallId: 't1' }
  assert.equal(model.identityKey(identity), model.identityKey({ ...identity }), '同身份得到同一个键')
  assert.notEqual(model.identityKey(identity), model.identityKey({ ...identity, partIndex: 3 }), 'partIndex 参与身份')
  assert.equal(model.sameIdentity(identity, { ...identity }), true)
  assert.equal(model.sameIdentity(identity, { ...identity, toolCallId: 'other' }), false)
}

/* ── 活跃框架上限与淘汰 ───────────────────────────────────────── */
{
  const slots = (count, visible = true) =>
    Array.from({ length: count }, (_, i) => ({ key: `f${i}`, generation: 1, visible, lastSeenAt: i }))
  assert.deepEqual(model.selectFrameEvictions(slots(4)), [], '上限内不淘汰')
  assert.deepEqual(model.selectFrameEvictions(slots(5)), ['f0'], '超过上限先淘汰最久未见')
  assert.deepEqual(model.selectFrameEvictions(slots(6)), ['f0', 'f1'])
  assert.deepEqual(model.framesToFreeFor(slots(4), 'f1'), [], '已存在的键不腾位')
  assert.deepEqual(model.framesToFreeFor(slots(4), 'new'), ['f0'], '新键满员时腾一个位置')
  assert.deepEqual(model.framesToFreeFor(slots(3), 'new'), [], '未满员不腾位')

  /* 离屏的优先让位，即使它最近才见过 */
  const mixed = [
    { key: 'on', generation: 1, visible: true, lastSeenAt: 100 },
    { key: 'off', generation: 1, visible: false, lastSeenAt: 999 }
  ]
  assert.deepEqual(model.selectFrameEvictions(mixed, 1), ['off'], '离屏优先淘汰')
}

/* ── 尺寸钳制 ─────────────────────────────────────────────────── */
{
  assert.equal(model.clampInlineHeight(400, 1000), 400)
  assert.equal(model.clampInlineHeight(900, 1000), 700, 'min(70vh, 720)')
  assert.equal(model.clampInlineHeight(900, 2000), 720, '上限 720')
  assert.deepEqual(
    model.clampFrameSize({ width: 100, height: 9999 }, model.PIP_SIZE),
    { width: 240, height: 640 },
    '画中画尺寸钳到边界'
  )
}

/* ── 归属 ─────────────────────────────────────────────────────── */
{
  const owner = { key: 'k', sessionId: 's1', cwd: '/p', active: false }
  assert.equal(model.ownerAllowsInteractive(owner), false)
  assert.equal(model.ownerAllowsInteractive({ ...owner, active: true }), true)
  assert.equal(model.ownerOwnsSession(owner, 's1'), true)
  assert.equal(model.ownerOwnsSession(owner, 's2'), false)
  assert.equal(model.ownerOwnsSession({ ...owner, sessionId: null }, 's1'), false)
  assert.equal(model.ownerOwnsSession(owner, null), false)
}

/* ── 异步归属核对 ─────────────────────────────────────────────── */
{
  const ok = await model.ownerScopedRead({ expectedKey: 'a', currentKey: () => 'a', read: async () => 42 })
  assert.deepEqual(ok, { ok: true, value: 42 })

  let calls = 0
  const stale = await model.ownerScopedRead({
    expectedKey: 'a',
    currentKey: () => (calls++ === 0 ? 'a' : 'b'),
    read: async () => 'value'
  })
  assert.deepEqual(stale, { ok: false, reason: 'stale' }, '读完 owner 已切走 → stale')

  const failed = await model.ownerScopedRead({
    expectedKey: 'a',
    currentKey: () => 'a',
    read: async () => {
      throw new Error('boom')
    }
  })
  assert.deepEqual(failed, { ok: false, reason: 'error' })
}

/* ── 安全桥：来源 / 代号 / 白名单 / 限速 ───────────────────────── */
{
  const ctx = { sourceOk: true, frameGeneration: 7 }
  const withGen = (message) => ({ ...message, yanGeneration: 7 })

  assert.deepEqual(model.decodeBridgeMessage(withGen({ method: 'ui/initialize', params: {} }), ctx), {
    ok: true,
    action: { kind: 'ready' }
  })
  assert.deepEqual(
    model.decodeBridgeMessage({ method: 'ui/initialize', params: {}, yanGeneration: 8 }, ctx),
    { ok: false, error: 'generation' },
    '实例代号不符拒绝'
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/initialize', params: {} }), { ...ctx, sourceOk: false }),
    { ok: false, error: 'source' },
    '非本 iframe 来源拒绝'
  )
  assert.deepEqual(model.decodeBridgeMessage(null, ctx), { ok: false, error: 'shape' })

  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/notifications/size-changed', params: { height: 999999 } }), ctx),
    { ok: true, action: { kind: 'size-changed', height: model.BRIDGE_SIZE_MAX } }
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ yanWidget: 1, type: 'height', h: 5 }), ctx),
    { ok: true, action: { kind: 'size-changed', height: model.BRIDGE_SIZE_MIN } },
    '兼容 v1 的高度回报并夹到下限'
  )

  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/request-display-mode', params: { mode: 'fullscreen' } }), ctx),
    { ok: true, action: { kind: 'request-display-mode', form: 'fullscreen' } }
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/request-display-mode', params: { mode: 'hologram' } }), ctx),
    { ok: false, error: 'shape' }
  )

  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/message', params: { content: '  你好  ' } }), ctx),
    { ok: true, action: { kind: 'message', text: '  你好  ' } }
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/message', params: { content: 'x'.repeat(model.BRIDGE_UI_MESSAGE_CHARS + 1) } }), ctx),
    { ok: false, error: 'limit' },
    'ui/message 超长拒绝'
  )

  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/open-link', params: { url: 'http://example.com' } }), ctx),
    { ok: false, error: 'url' },
    '只允许 https'
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/open-link', params: { url: 'https://example.com/a' } }), ctx),
    { ok: true, action: { kind: 'open-link', url: 'https://example.com/a' } }
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'ui/open-link', params: { url: 'https://u:p@example.com/' } }), ctx),
    { ok: false, error: 'url' },
    '带账号信息的 URL 拒绝'
  )

  /* MCP Apps 的工具/资源调用明确拒绝：普通 HTML 桥不冒充 MCP 宿主。 */
  for (const method of ['tools/call', 'resources/read', 'ui/resource-teardown']) {
    assert.deepEqual(model.decodeBridgeMessage(withGen({ method, params: {} }), ctx), { ok: false, error: 'unsupported' }, `${method} 拒绝`)
  }
  assert.deepEqual(model.decodeBridgeMessage(withGen({ method: 'ui/unknown', params: {} }), ctx), { ok: false, error: 'unsupported' })

  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'x-inkstone/state-save', params: { state: '{"a":1}' } }), ctx),
    { ok: true, action: { kind: 'state-save', text: '{"a":1}' } }
  )
  assert.deepEqual(
    model.decodeBridgeMessage(withGen({ method: 'x-inkstone/state-save', params: { state: 'x'.repeat(70 * 1024) } }), ctx),
    { ok: false, error: 'size' }
  )
  assert.deepEqual(model.decodeBridgeMessage(withGen({ method: 'x-inkstone/state-restore', params: {} }), ctx), {
    ok: true,
    action: { kind: 'state-restore' }
  })
}

/* ── 限速：≤50 条/秒 ─────────────────────────────────────────── */
{
  const limiter = new model.BridgeRateLimiter()
  for (let i = 0; i < model.BRIDGE_MESSAGE_RATE; i++) assert.equal(limiter.allow(1000 + i), true, `第 ${i + 1} 条放行`)
  assert.equal(limiter.allow(1100), false, '窗口内超限先节流')
  assert.equal(limiter.allow(2000), true, '窗口滑过后恢复')
  limiter.reset()
  assert.equal(limiter.allow(3000), true, '重置后放行')
}

/* ── 预览能力分类 ─────────────────────────────────────────────── */
{
  assert.equal(model.previewKindOf('a.html'), 'html')
  assert.equal(model.previewKindOf('a.HTM'), 'html')
  assert.equal(model.previewKindOf('photo.PNG'), 'image')
  assert.equal(model.previewKindOf('report.docx'), 'office')
  assert.equal(model.previewKindOf('slides.pptx'), 'office')
  assert.equal(model.previewKindOf('main.ts'), 'text')
  assert.equal(model.previewKindOf('README'), 'binary')
  assert.equal(model.previewNeedsOfficeIpc('office'), true)
  assert.equal(model.previewNeedsOfficeIpc('text'), false)
}

/* ── 结构化块：复用既有纯校验，不重造解析器 ───────────────────── */
{
  assert.equal(visuals.isVisualBlockLang('yan-chart'), true)
  assert.equal(visuals.isVisualBlockLang('mermaid'), true)
  assert.equal(visuals.isVisualBlockLang('ts'), false)

  const chart = visuals.parseVisualBlock(
    'yan-chart',
    JSON.stringify({
      title: '月度',
      source: '内部',
      labels: ['一月', '二月'],
      series: [{ name: '销量', values: [3, 5] }]
    })
  )
  assert.equal(chart.ok, true)
  assert.equal(chart.block.kind, 'chart')
  assert.equal(chart.block.series[0].values[1], 5)

  const invalid = visuals.parseVisualBlock('yan-chart', '{"labels":[]}')
  assert.equal(invalid.ok, false, '缺字段时明确失败，退回代码块')

  assert.deepEqual(visuals.niceScale(95, '%'), { max: 100, ticks: [0, 25, 50, 75, 100] })
}

/* ── 离线协议 / CSP：确认没有放宽 ─────────────────────────────── */
{
  assert.equal(html.HTML_ARTIFACT_SCHEME, 'inkstone-html')
  assert.equal(html.HTML_ARTIFACT_SANDBOX, 'allow-scripts')
  assert.ok(!html.HTML_ARTIFACT_SANDBOX.includes('allow-same-origin'), '不给同源权限')
  assert.ok(html.HTML_ARTIFACT_CSP.includes("default-src 'none'"), '默认全禁')
  assert.ok(html.HTML_ARTIFACT_CSP.includes('sandbox allow-scripts'), 'CSP 内再声明 sandbox')
  assert.ok(!/unsafe-eval/.test(html.HTML_ARTIFACT_CSP), '不放开 unsafe-eval')
  assert.ok(!/(^|;)\s*(https?|file):/.test(html.HTML_ARTIFACT_CSP), '不放开网络或 file 来源')

  const token = 'a'.repeat(32)
  assert.equal(html.htmlArtifactToken(`inkstone-html://${token}/index.html`), token)
  assert.equal(html.htmlArtifactToken(`inkstone-html://${token}/other.html`), null)
  assert.equal(html.htmlArtifactToken('https://example.com/index.html'), null)
  assert.equal(html.isHtmlArtifact({ filename: 'x.html' }), true)
  assert.equal(html.isHtmlArtifact({ filename: 'x.bin', mediaType: 'text/html; charset=utf-8' }), true)
  assert.equal(html.isHtmlArtifact({ filename: 'x.md' }), false)
}

console.log('test-v3-artifacts: all checks passed')
