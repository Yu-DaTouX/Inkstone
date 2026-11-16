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

{
  const identity = { sessionId: 's1', messageId: 'm1', partIndex: 2, toolCallId: 't1' }
  assert.equal(model.identityKey(identity), model.identityKey({ ...identity }), '同身份得到同一个键')
  assert.notEqual(model.identityKey(identity), model.identityKey({ ...identity, partIndex: 3 }), 'partIndex 参与身份')
}

{
  const slots = (count, visible = true) =>
    Array.from({ length: count }, (_, i) => ({ key: `f${i}`, generation: 1, visible, lastSeenAt: i }))
  assert.deepEqual(model.selectFrameEvictions(slots(4, false)), [], '视口外上限内不淘汰')
  assert.deepEqual(model.selectFrameEvictions(slots(5, false)), ['f0'], '视口外超过上限先淘汰最久未见')
  assert.deepEqual(model.selectFrameEvictions(slots(6, false)), ['f0', 'f1'])
  assert.deepEqual(model.selectFrameEvictions(slots(6)), [], '视口内的不受视口外上限限制')
  assert.deepEqual(model.selectFrameEvictions(slots(model.MAX_TOTAL_FRAMES + 1)), ['f8'], '视口内超过总上限淘汰最近进入视口的')
  const entered = slots(model.MAX_TOTAL_FRAMES + 1).map((slot, i) => ({ ...slot, lastSeenAt: 1000, enteredAt: 100 - i }))
  assert.deepEqual(model.selectFrameEvictions(entered), ['f0'], '按进入视口时间而不是最近一次可见时间排')
  const crowded = [...slots(6), ...Array.from({ length: 4 }, (_, i) => ({ key: `o${i}`, generation: 1, visible: false, lastSeenAt: 100 + i }))]
  assert.deepEqual(model.selectFrameEvictions(crowded), ['o0', 'o1'], '视口外只占总上限剩下的名额')
  const overfull = [...slots(model.MAX_TOTAL_FRAMES + 2), { key: 'off', generation: 1, visible: false, lastSeenAt: 999 }]
  assert.deepEqual(model.selectFrameEvictions(overfull), ['f8', 'f9', 'off'], '视口内超过总上限时视口外全部淘汰')
  const tied = Array.from({ length: 6 }, (_, i) => ({ key: `t${i}`, generation: 1, visible: false, lastSeenAt: 5 }))
  assert.deepEqual(model.selectFrameEvictions(tied), ['t4', 't5'], 'lastSeenAt 并列时保留先登记的')
  const tiedOn = Array.from({ length: model.MAX_TOTAL_FRAMES + 1 }, (_, i) => ({ key: `v${i}`, generation: 1, visible: true, lastSeenAt: 5, enteredAt: 5 }))
  assert.deepEqual(model.selectFrameEvictions(tiedOn), [`v${model.MAX_TOTAL_FRAMES}`], '进入时间并列时淘汰后登记的')
  assert.deepEqual(model.selectFrameEvictions([...slots(2), ...slots(3, false).map((x) => ({ ...x, key: 'o' + x.key }))], 0), ['of0', 'of1', 'of2'], 'offscreenLimit=0 时视口外全部淘汰')
  assert.deepEqual(model.selectFrameEvictions([...slots(1), ...slots(3, false).map((x) => ({ ...x, key: 'o' + x.key }))], 4, 2), ['of0', 'of1'], 'totalLimit 小于 offscreenLimit 时以总上限为准')
  assert.deepEqual(model.selectFrameEvictions(slots(3), 4, 0), ['f0', 'f1', 'f2'], 'totalLimit=0 全部淘汰')

  const mixed = [
    { key: 'on', generation: 1, visible: true, lastSeenAt: 100 },
    { key: 'off', generation: 1, visible: false, lastSeenAt: 999 }
  ]
  assert.deepEqual(model.selectFrameEvictions(mixed, 1, 1), ['off'], '离屏优先淘汰')
}

{
  const next = model.nextFrameRecord
  assert.equal(next(undefined, 'k', false, false, 10), null, '不在近处的首次登记不建记录')
  const warm = next(undefined, 'k', true, false, 10)
  assert.deepEqual(warm, { key: 'k', visible: true, onscreen: false, lastSeenAt: 0, enteredAt: 0 }, '只是预热时 lastSeenAt 为 0')
  const seen = next(warm, 'k', true, true, 20)
  assert.equal(seen.lastSeenAt, 20)
  assert.equal(seen.enteredAt, 20, '进入视口记进入时间')
  const still = next(seen, 'k', true, true, 30)
  assert.equal(still.enteredAt, 20, '仍在视口内不改进入时间')
  const left = next(still, 'k', true, false, 50)
  assert.deepEqual(left, { key: 'k', visible: true, onscreen: false, lastSeenAt: 50, enteredAt: 0 }, '离开视口时刷新 lastSeenAt')
  const idle = next(left, 'k', true, false, 90)
  assert.equal(idle.lastSeenAt, 50, '一直在视口外不刷新')
  const far = next(idle, 'k', false, false, 120)
  assert.deepEqual(far, { key: 'k', visible: false, onscreen: false, lastSeenAt: 50, enteredAt: 0 }, '远离后保留上次可见时间')
  assert.equal(next(undefined, 'k', false, true, 10), null, '不在近处时视口标记无效')
  const read = next(next(undefined, 'a', true, true, 0), 'a', true, false, 100)
  const skim = next(next(undefined, 'b', true, true, 60), 'b', true, false, 70)
  assert.ok(read.lastSeenAt > skim.lastSeenAt, '刚读完离开的比之前掠过的更新')
}

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

{
  const owner = { key: 'k', sessionId: 's1', cwd: '/p', active: false }
  assert.equal(model.ownerOwnsSession(owner, 's1'), true)
  assert.equal(model.ownerOwnsSession(owner, 's2'), false)
  assert.equal(model.ownerOwnsSession({ ...owner, sessionId: null }, 's1'), false)
  assert.equal(model.ownerOwnsSession(owner, null), false)
}

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

{
  const limiter = new model.BridgeRateLimiter()
  for (let i = 0; i < model.BRIDGE_MESSAGE_RATE; i++) assert.equal(limiter.allow(1000 + i), true, `第 ${i + 1} 条放行`)
  assert.equal(limiter.allow(1100), false, '窗口内超限先节流')
  assert.equal(limiter.allow(2000), true, '窗口滑过后恢复')
  limiter.reset()
  assert.equal(limiter.allow(3000), true, '重置后放行')
}

{
  assert.equal(model.previewKindOf('a.html'), 'html')
  assert.equal(model.previewKindOf('a.HTM'), 'html')
  assert.equal(model.previewKindOf('photo.PNG'), 'image')
  assert.equal(model.previewKindOf('report.docx'), 'office')
  assert.equal(model.previewKindOf('slides.pptx'), 'office')
  assert.equal(model.previewKindOf('main.ts'), 'text')
  assert.equal(model.previewKindOf('README'), 'binary')
}

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
