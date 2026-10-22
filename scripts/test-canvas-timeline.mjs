#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

const outdir = join('.tmp', 'canvas-w3-时间轴')
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
try {
  await build({
    entryPoints: [
      'src/shared/html-canvas-bridge.ts',
      'src/renderer/src/features/preview/html-canvas-model.ts',
      'src/renderer/src/features/preview/canvas-tools/timeline-model.ts'
    ],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const bridge = await import(pathToFileURL(join(outdir, 'shared', 'html-canvas-bridge.js')).href)
  const canvas = await import(pathToFileURL(join(outdir, 'renderer', 'src', 'features', 'preview', 'html-canvas-model.js')).href)
  const timeline = await import(
    pathToFileURL(join(outdir, 'renderer', 'src', 'features', 'preview', 'canvas-tools', 'timeline-model.js')).href
  )

  assert.equal(bridge.HTML_CANVAS_COMPOSITION_KIND, 'composition', '合成消息频道名')
  assert.equal(bridge.HTML_CANVAS_TIMELINE_KIND, 'timeline', '时间轴控制频道名')
  assert.equal(bridge.HTML_CANVAS_TIME_KIND, 'time', '时间回传频道名')
  assert.ok(bridge.CANVAS_BRIDGE_PARTS.length >= 3, '合成脚本追加到桥接片段')
  const runtime = bridge.canvasBridgeRuntime()
  ok(runtime.includes('data-composition-id'), '页面侧脚本读取 data-composition-id')
  ok(runtime.includes('__timelines'), '页面侧脚本读取 __timelines')
  ok(runtime.includes('ev.source!==parent'), '页面侧校验消息来源是父页')
  ok(runtime.includes('document.getAnimations'), '没有控制器时退回页面动画')
  ok(runtime.includes('currentTime=target*1000'), '退回模式按秒设置动画时间')
  for (const part of bridge.CANVAS_BRIDGE_PARTS) new Function(part)
  ok(true, '每个桥接片段可被解析为合法脚本')

  const sample = {
    'yan-canvas': 'composition',
    id: 'eight-seconds',
    width: 1920,
    height: 1080,
    duration: 8,
    hasTimeline: true,
    clips: [
      { id: 'shot1', label: 'shot1', start: 0, duration: 2.7, track: 1 },
      { id: 'shot2', label: '.shot2', start: 2.7, duration: 2.8, track: 1 },
      { id: 'bgm', label: 'bgm', start: 0, duration: 8, track: 2 }
    ]
  }
  const parsed = bridge.readCanvasComposition(sample)
  assert.deepEqual(parsed, {
    id: 'eight-seconds',
    width: 1920,
    height: 1080,
    duration: 8,
    clips: sample.clips,
    hasTimeline: true
  }, '合成消息按样例解析')
  ok(parsed.clips.length === 3 && parsed.clips[2].track === 2, '片段保留轨道号')

  assert.equal(bridge.readCanvasComposition({ ...sample, id: '  ' }), null, '缺少合成 id 时丢弃')
  assert.equal(bridge.readCanvasComposition({ ...sample, duration: 0 }), null, '总时长为 0 时丢弃')
  assert.equal(bridge.readCanvasComposition({ ...sample, width: -1 }), null, '画幅宽度非正时丢弃')
  assert.equal(bridge.readCanvasComposition({ ...sample, clips: null }), null, '片段不是数组时丢弃')
  assert.equal(bridge.readCanvasComposition({ ...sample, hasTimeline: 'yes' }).hasTimeline, false, 'hasTimeline 只认 true')
  const mixed = bridge.readCanvasComposition({
    ...sample,
    clips: [
      { start: -1, duration: 1, track: 0 },
      { start: 1, duration: 0, track: 0 },
      { start: 2, duration: 1, track: -3, label: 'x'.repeat(400) },
      null
    ]
  })
  assert.equal(mixed.clips.length, 1, '非法片段被丢弃')
  assert.equal(mixed.clips[0].track, 0, '负轨道号回到 0')
  assert.equal(mixed.clips[0].label.length, bridge.CANVAS_INFO_TEXT_MAX, '片段标签有长度上限')

  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'composition', ...sample }).kind, 'composition', '桥接事件识别合成')
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'time', t: 1.5, paused: false }), {
    kind: 'time',
    time: { t: 1.5, paused: false }
  }, '桥接事件识别播放时间')
  assert.equal(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'time', paused: true }), null, '没有时间戳的播放事件丢弃')
  assert.deepEqual(bridge.readCanvasBridgeEvent({ 'yan-canvas': 'time', t: 2 }), { kind: 'time', time: { t: 2, paused: true } }, '缺省按暂停处理')

  assert.deepEqual(bridge.canvasTimelineMessage('seek', 2.5), { 'yan-canvas': 'timeline', action: 'seek', t: 2.5 }, '定位消息带时间')
  assert.deepEqual(bridge.canvasTimelineMessage('play'), { 'yan-canvas': 'timeline', action: 'play' }, '播放消息不带时间')
  assert.deepEqual(bridge.canvasTimelineMessage('pause', Number.NaN), { 'yan-canvas': 'timeline', action: 'pause' }, '非法时间不写入消息')

  assert.equal(timeline.formatTimecode(0), '00:00.00', '零秒时间码')
  assert.equal(timeline.formatTimecode(3.2), '00:03.20', '评论里显示 00:03.20')
  assert.equal(timeline.formatTimecode(75.5), '01:15.50', '超过一分钟进位')
  assert.equal(timeline.formatTimecode(-4), '00:00.00', '负时间回到零')
  assert.equal(timeline.formatTimecode(Number.NaN), '00:00.00', '非法时间回到零')
  assert.equal(timeline.formatTimecode(59.999), '01:00.00', '百分秒四舍五入到上一分钟')
  assert.equal(timeline.formatSeconds(3.2), '3.20', '提示文本里的秒数')
  assert.equal(timeline.formatSeconds(Number.NaN), '0.00', '非法秒数补零')

  assert.equal(timeline.clampTimelineTime(12, 8), 8, '时间不超过总时长')
  assert.equal(timeline.clampTimelineTime(-1, 8), 0, '时间不小于 0')
  assert.equal(timeline.clampTimelineTime(Number.NaN, 8), 0, '非法时间回到 0')

  const rawClips = [
    { id: 'a', label: 'a', start: 0, duration: 2.7, track: 1 },
    { id: 'b', label: 'b', start: 2.7, duration: 0, track: 1 },
    { id: 'c', label: 'c', start: 5.5, duration: 5, track: 2 },
    { id: 'd', label: 'd', start: 9, duration: 1, track: 0 },
    { id: 'e', label: 'e', start: -2, duration: 1, track: 0 }
  ]
  const normalized = timeline.normalizeClips(rawClips, 8)
  assert.deepEqual(
    normalized.map((clip) => clip.id),
    ['a', 'b', 'c'],
    '缺省时长补到总时长、越界与负起点片段被裁掉'
  )
  assert.equal(normalized[1].duration, 5.3, '时长缺省时结束在总时长')
  assert.equal(normalized[2].duration, 2.5, '超出总时长的部分被裁掉')
  assert.equal(normalized[0].track, 1, '轨道号保留')

  const grouped = timeline.timelineTracks(normalized)
  assert.deepEqual(grouped.map((track) => track.track), [1, 2], '按轨道分组并升序')
  assert.deepEqual(grouped[0].clips.map((clip) => clip.id), ['a', 'b'], '轨道内按开始时间排序')

  assert.equal(timeline.stepFrames(0, 1, 8), 0.033, '30fps 下一帧')
  assert.equal(timeline.stepFrames(0.033, -1, 8), 0, '上一帧回到 0')
  assert.equal(timeline.stepFrames(8, 1, 8), 8, '最后一帧不越过结尾')
  assert.equal(timeline.stepFrames(0, -1, 8), 0, '开头不再往前')
  assert.equal(timeline.stepSeconds(2, 1, 8), 3, 'Shift 步进 1 秒')
  assert.equal(timeline.stepSeconds(7.5, 1, 8), 8, '1 秒步进夹在结尾')

  const span = timeline.clipSpan(normalized[0], 8)
  ok(Math.abs(span.left - 0) < 1e-9 && Math.abs(span.width - 0.3375) < 1e-9, '片段块按 start/duration 定位')
  const tiny = timeline.clipSpan({ start: 7.9, duration: 0.05 }, 8)
  ok(tiny.width >= timeline.TIMELINE_MIN_CLIP_RATIO, '极短片段保留最小宽度')
  assert.equal(timeline.playheadRatio(4, 8), 0.5, '播放头位置按比例')
  assert.equal(timeline.playheadRatio(20, 8), 1, '播放头不超过右端')
  assert.equal(timeline.playheadRatio(4, 0), 0, '时长未知时播放头贴左')

  const ticks = timeline.timelineTicks(8)
  assert.deepEqual(ticks.map((tick) => tick.t), [0, 1, 2, 3, 4, 5, 6, 7, 8], '8 秒按 1 秒刻度')
  ok(ticks[0].major && !ticks[1].major && ticks[5].major, '每 5 个刻度加大标')
  assert.deepEqual(timeline.timelineTicks(0), [], '时长未知时不画刻度')

  assert.equal(timeline.sameComposition(parsed, { ...parsed }), true, '相同合成消息判等')
  assert.equal(timeline.sameComposition(parsed, { ...parsed, clips: [] }), false, '片段变化不算相同')
  assert.equal(timeline.sameComposition(parsed, null), false, '合成与空值不同')
  ok(timeline.compositionSignature(parsed) !== timeline.compositionSignature({ ...parsed, duration: 9 }), '签名随时长变化')

  assert.deepEqual(canvas.compositionSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 }, '合成画幅照抄页面画幅')
  assert.deepEqual(canvas.compositionSize({ width: 10, height: 20000 }), {
    width: canvas.CANVAS_COMPOSITION_MIN,
    height: canvas.CANVAS_COMPOSITION_MAX
  }, '合成画幅夹在上下限之间')
  assert.equal(canvas.compositionSize({ width: 0, height: 1080 }), null, '宽度为 0 时不算合成画幅')
  assert.equal(canvas.compositionSize(null), null, '没有合成时没有画幅')

  assert.deepEqual(canvas.compositionViewport({ width: 1920, height: 1080 }), {
    id: 'composition',
    width: 1920,
    height: 1080
  }, '合成画框用固定 id')
  const state = canvas.parseCanvasFrameState(null)
  assert.deepEqual(canvas.visibleViewports(state), [
    { id: 'desktop', width: 1440, height: 900 },
    { id: 'phone', width: 390, height: 844 }
  ], '没有合成时仍是网页设备画框')
  const composed = canvas.visibleViewports(state, { width: 1920, height: 1080 })
  assert.deepEqual(composed, [{ id: 'composition', width: 1920, height: 1080 }], '合成时只留一个画框')
  const composedLayout = canvas.layoutFrames(composed)
  assert.equal(composedLayout.width, 1920, '合成画布宽度等于画幅')
  assert.equal(composedLayout.height, 1080 + canvas.CANVAS_HEADER, '合成画布高度加画框标题')
  assert.deepEqual(composedLayout.frames[0], { viewport: composed[0], left: 0, top: canvas.CANVAS_HEADER }, '合成画框从原点开始')
  const portrait = canvas.layoutFrames(canvas.visibleViewports(state, { width: 1080, height: 1920 }))
  ok(portrait.frames[0].viewport.height === 1920, '竖屏合成画幅保持尺寸')

  const fakeEl = (attrs, props = {}) => ({
    id: props.id ?? '',
    classList: props.classes ?? [],
    tagName: props.tagName ?? 'SECTION',
    textContent: props.text ?? '',
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    clientWidth: props.clientWidth ?? 0,
    offsetWidth: props.offsetWidth ?? 0,
    clientHeight: props.clientHeight ?? 0,
    offsetHeight: props.offsetHeight ?? 0,
    querySelectorAll: (selector) => (selector === '[data-start]' ? props.children ?? [] : [])
  })
  const shot1 = fakeEl({ 'data-start': '0', 'data-duration': '2.7', 'data-track-index': '1' }, { id: 'shot1', classes: ['clip'] })
  const shot2 = fakeEl({ 'data-start': '2.7', 'data-track-index': '1' }, { classes: ['clip', 'shot2'] })
  const shot3 = fakeEl({ 'data-start': '5.5', 'data-duration': '2.5' }, { tagName: 'SECTION', text: '第三镜：收尾文字要多一点' })
  const root = fakeEl(
    { 'data-composition-id': 'eight-seconds', 'data-width': '1920', 'data-height': '1080', 'data-duration': '8' },
    { id: 'stage', clientWidth: 1920, clientHeight: 1080, children: [shot1, shot2, shot3] }
  )
  const posted = []
  const parentWindow = { postMessage: (message) => posted.push(message) }
  const seeks = []
  const plays = []
  let paused = true
  const controller = {
    duration: () => 8,
    seek: (value) => seeks.push(value),
    play: () => {
      plays.push('play')
      paused = false
    },
    pause: () => {
      plays.push('pause')
      paused = true
    },
    paused: () => paused,
    time: () => 3
  }
  let messageListener = null
  const fakeWindow = {
    __timelines: { 'eight-seconds': controller },
    addEventListener: (type, handler) => {
      if (type === 'message') messageListener = handler
    }
  }
  const fakeDocument = {
    readyState: 'complete',
    querySelector: (selector) => (selector === '[data-composition-id]' ? root : null),
    getAnimations: () => [],
    addEventListener: () => {}
  }
  const compositionScript = bridge.CANVAS_BRIDGE_PARTS.find((part) => part.includes('data-composition-id'))
  assert.ok(compositionScript, '合成片段可从桥接片段中取出')
  const factory = new Function(
    'window',
    'document',
    'parent',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setInterval',
    'clearInterval',
    'YAN_CANVAS',
    compositionScript
  )
  factory(fakeWindow, fakeDocument, parentWindow, { now: () => 0 }, () => 1, () => {}, () => 1, () => {}, { nonce: 'composition-nonce' })
  const compositionMessage = posted.find((message) => message['yan-canvas'] === 'composition')
  assert.ok(compositionMessage, '页面加载后向父页上报合成')
  assert.equal(compositionMessage.nonce, 'composition-nonce', '合成上报带画框 nonce')
  assert.deepEqual(
    {
      id: compositionMessage.id,
      width: compositionMessage.width,
      height: compositionMessage.height,
      duration: compositionMessage.duration,
      hasTimeline: compositionMessage.hasTimeline
    },
    { id: 'eight-seconds', width: 1920, height: 1080, duration: 8, hasTimeline: true },
    '上报合成 id、画幅、时长与控制器状态'
  )
  assert.deepEqual(
    compositionMessage.clips.map((clip) => [clip.id, clip.label, clip.start, clip.duration, clip.track]),
    [
      ['shot1', 'shot1', 0, 2.7, 1],
      ['', '.clip', 2.7, 5.3, 1],
      ['', '第三镜：收尾文字要多一点', 5.5, 2.5, 0]
    ],
    '片段标签优先用文字，缺省时长、轨道按页面属性归一化'
  )
  assert.ok(messageListener, '页面监听父页的时间轴消息')
  messageListener({ source: {}, data: { 'yan-canvas': 'timeline', action: 'seek', t: 2 } })
  assert.deepEqual(seeks, [], '非父页发来的消息被忽略')
  messageListener({ source: parentWindow, data: { 'yan-canvas': 'timeline', action: 'seek', t: 2 } })
  assert.deepEqual(seeks, [2], 'seek 调到控制器')
  const seeked = posted.filter((message) => message['yan-canvas'] === 'time').at(-1)
  assert.deepEqual({ t: seeked.t, paused: seeked.paused }, { t: 2, paused: true }, 'seek 后回传当前时间')
  messageListener({ source: parentWindow, data: { 'yan-canvas': 'timeline', action: 'play' } })
  assert.deepEqual(plays, ['play'], 'play 调到控制器')

  console.log(`canvas timeline: ${checks} checks passed`)
} finally {
  await rm(outdir, { recursive: true, force: true })
}
