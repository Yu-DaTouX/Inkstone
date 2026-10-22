#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'artifact-preview-video', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}

const outDir = join(workDir, 'out')
await build({
  entryPoints: ['src/main/video-composition.ts', 'src/main/artifact-preview-command.ts'],
  outdir: outDir,
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const sampling = await import(pathToFileURL(join(outDir, 'main', 'video-composition.js')).href)
const command = await import(pathToFileURL(join(outDir, 'main', 'artifact-preview-command.js')).href)

assert.equal(sampling.PREVIEW_VIDEO_MAX_SAMPLES, 8, '默认最多 8 个取样时间点')
assert.equal(sampling.PREVIEW_VIDEO_MAX_EDGE, 1280, '视频截图长边不超过 1280')
assert.equal(sampling.PREVIEW_VIDEO_END_EPSILON, 0.001, '结尾帧取 duration - 0.001')
ok(sampling.VIDEO_COMPOSITION_PROBE.includes('[data-composition-id]'), '探测脚本按 data-composition-id 认合成')
ok(sampling.VIDEO_COMPOSITION_PROBE.includes('__timelines'), '探测脚本读 window.__timelines')
ok(sampling.VIDEO_COMPOSITION_PROBE.includes('data-start') && sampling.VIDEO_COMPOSITION_PROBE.includes('data-duration'), '探测脚本收集片段的 data-start / data-duration')
ok(sampling.VIDEO_COMPOSITION_PROBE.includes('data-width') && sampling.VIDEO_COMPOSITION_PROBE.includes('data-height'), '探测脚本读画幅')
const seekSource = sampling.videoSeekScript('demo', 1.5)
ok(seekSource.includes('seek(1.5)'), 'seek 脚本把秒数写进 controller.seek')
ok(seekSource.includes('list["demo"]'), 'seek 脚本按合成 id 取控制器')
ok(/requestAnimationFrame\(\(\) => requestAnimationFrame/.test(seekSource), 'seek 后等两帧再截图')
ok(!seekSource.includes('play()'), 'seek 脚本不播放（导出与预览都只用 seek）')
ok(true, '合成探测与取值脚本')

const pourOverClips = [
  { start: 0, duration: 2.4 },
  { start: 2.4, duration: 2.6 },
  { start: 5, duration: 2.6 },
  { start: 7.6, duration: 2.4 },
  { start: 10, duration: 2 }
]
const defaultTimes = sampling.previewSampleTimes({ duration: 12, clips: pourOverClips })
assert.deepEqual(defaultTimes, [1.2, 3.7, 6.3, 8.8, 11, 11.999], '默认取每个片段中点加结尾帧')
ok(defaultTimes[defaultTimes.length - 1] === 11.999, '最后一个取样是 duration - 0.001')
assert.deepEqual(sampling.previewSampleTimes({ duration: 6, clips: [{ start: 0, duration: 6 }] }), [3, 5.999], '单镜头：中点 + 结尾帧')
assert.deepEqual(sampling.previewSampleTimes({ duration: 4, clips: [{ start: 2, duration: 2 }] }), [3, 3.999], '相邻取样过近时按毫秒去重')
assert.deepEqual(
  sampling.previewSampleTimes({ duration: 4, clips: [{ start: 0, duration: 2 }, { start: 0, duration: 2 }] }),
  [1, 3.999],
  '重复片段只取一个中点'
)
assert.deepEqual(sampling.previewSampleTimes({ duration: 4, clips: [{ start: 0, duration: 0 }, { start: 1, duration: 0.5 }] }), [1.25, 3.999], '零长度片段被忽略')
assert.deepEqual(sampling.previewSampleTimes({ duration: 0, clips: pourOverClips }), [], '没有时长就没有取样')
assert.deepEqual(sampling.previewSampleTimes({ duration: Number.NaN, clips: pourOverClips }), [], 'NaN 时长没有取样')
assert.deepEqual(sampling.previewSampleTimes({ duration: 0.3333, clips: [{ start: 0, duration: 0.3333 }] }), [0.167, 0.332], '取样保留到毫秒')
ok(true, '默认取样时间点')

const manyClips = Array.from({ length: 20 }, (_, index) => ({ start: index * 0.5, duration: 0.5 }))
const capped = sampling.previewSampleTimes({ duration: 10, clips: manyClips })
ok(capped.length === 8, `片段很多时最多 8 个取样（实际 ${capped.length}）`)
ok(capped[capped.length - 1] === 9.999, '删减后保留结尾帧')
ok(capped.every((time, index) => index === 0 || time > capped[index - 1]), '删减后仍然升序且不重复')
assert.deepEqual(sampling.previewSampleTimes({ duration: 10, clips: manyClips, max: 3 }).length, 3, 'max 可以降到 3')
assert.equal(sampling.previewSampleTimes({ duration: 10, clips: manyClips, max: 1 }).length, 1, 'max 1 只留结尾帧')
ok(true, '取样上限')

assert.deepEqual(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [4, 1.5] }), [1.5, 4], '--at 覆盖默认时间点并排序')
assert.deepEqual(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [4] }), [4], '--at 不带隐式结尾帧')
assert.deepEqual(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [100, 0] }), [0, 11.999], '--at 越界时夹到有效区间')
assert.deepEqual(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [2, 2, 2.0004] }), [2], '--at 去重按毫秒')
assert.deepEqual(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [] }), defaultTimes, '空 --at 回落到默认取样')
assert.equal(sampling.previewSampleTimes({ duration: 12, clips: pourOverClips, at: [1, 2], max: 1 }).length, 1, '--at 同样受上限约束')
ok(true, '--at 覆盖')

assert.deepEqual(sampling.parsePreviewAt(undefined), { times: [], invalid: null }, '没有 --at 时不覆盖')
assert.deepEqual(sampling.parsePreviewAt(true), { times: [], invalid: null }, '--at 没带值当作没有')
assert.deepEqual(sampling.parsePreviewAt(''), { times: [], invalid: null }, '空字符串当作没有')
assert.deepEqual(sampling.parsePreviewAt('1.5,4'), { times: [1.5, 4], invalid: null }, '逗号分隔的秒数')
assert.deepEqual(sampling.parsePreviewAt(' 3 , 1 '), { times: [1, 3], invalid: null }, '容忍空格并排序')
assert.deepEqual(sampling.parsePreviewAt('1.5,'), { times: [1.5], invalid: null }, '忽略空段')
assert.deepEqual(sampling.parsePreviewAt(4), { times: [4], invalid: null }, '单个数字也接受')
assert.deepEqual(sampling.parsePreviewAt([2.5, 1]), { times: [1, 2.5], invalid: null }, 'JSON 请求文件里的数组')
assert.deepEqual(sampling.parsePreviewAt([0, 0.5]), { times: [0, 0.5], invalid: null }, '0 是合法时间点')
assert.equal(sampling.parsePreviewAt('1.5,abc').invalid, 'abc', '非数字段报错并指出坏值')
assert.equal(sampling.parsePreviewAt('-1').invalid, '-1', '负数时间点报错')
assert.equal(sampling.parsePreviewAt({ t: 1 }).invalid !== null, true, '对象形式按坏值处理')
ok(true, '--at 解析')

const portrait = sampling.videoPreviewPixelSize(1080, 1920)
assert.deepEqual(portrait, { width: 720, height: 1280, scale: 1280 / 1920, zoom: 720 / 1080 }, '竖版 1080x1920 缩到 720x1280')
const landscape = sampling.videoPreviewPixelSize(1920, 1080)
assert.deepEqual(landscape, { width: 1280, height: 720, scale: 1280 / 1920, zoom: 1280 / 1920 }, '横版 1920x1080 缩到 1280x720')
assert.deepEqual(sampling.videoPreviewPixelSize(640, 360), { width: 640, height: 360, scale: 1, zoom: 1 }, '小画幅不放大')
assert.deepEqual(sampling.videoPreviewPixelSize(3840, 2160), { width: 1280, height: 720, scale: 1280 / 3840, zoom: 1280 / 3840 }, '4K 也压到长边 1280')
assert.deepEqual(sampling.videoPreviewPixelSize(0, 0), { width: 1280, height: 720, scale: 1, zoom: 1 }, '缺画幅时回到 1280x720')
ok(true, '截图尺寸')

assert.equal(sampling.previewSampleLabel(1.2), 't=1.2s', '标签写 t=秒')
assert.equal(sampling.previewSampleLabel(0), 't=0s', '0 秒标签')
assert.equal(sampling.previewSampleLabel(11.999), 't=11.999s', '毫秒保留')
assert.equal(sampling.previewSampleLabel(2.5004), 't=2.5s', '标签去掉多余的零')
ok(true, '时间标签')

assert.equal(sampling.normalizeVideoComposition(null), null, '没有合成根元素返回 null')
assert.equal(sampling.normalizeVideoComposition('x'), null, '非对象返回 null')
const normalized = sampling.normalizeVideoComposition({
  id: 'pour-over',
  width: '1080',
  height: '1920',
  duration: '12',
  ready: true,
  clips: [{ start: 0, duration: 2 }, { start: -1, duration: 2 }, { start: 1 }, { start: 'x', duration: 2 }, { start: 3, duration: 0 }]
})
assert.deepEqual(normalized, { id: 'pour-over', width: 1080, height: 1920, duration: 12, ready: true, clips: [{ start: 0, duration: 2 }] }, '探测结果归一化，坏片段被丢掉')
assert.equal(sampling.normalizeVideoComposition({ id: '' }).ready, false, '没有 ready 标记时当作未就绪')
ok(true, '探测结果归一化')

const exportSource = readFileSync('src/main/video-export.ts', 'utf8')
ok(exportSource.includes("from './video-composition'"), '导出复用同一套合成探测与 seek 脚本')
ok(!exportSource.includes('PROBE_COMPOSITION'), '导出没有自己再留一份探测脚本')
ok(exportSource.includes('videoSeekScript('), '导出的逐帧 seek 用共享脚本')

const videoResult = {
  shots: [],
  consoleErrors: ['Uncaught TypeError: x is undefined'],
  video: {
    compositionId: 'pour-over',
    width: 1080,
    height: 1920,
    duration: 12,
    timelineReady: true,
    screenWidth: 720,
    screenHeight: 1280,
    sheetPath: 'C:/artifacts/sheet.png',
    samples: [
      { at: 1.2, path: 'C:/artifacts/t-1.2.png', overflow: ['h2#line1 超出画框 12x0px'], seeked: true },
      { at: 11.999, path: 'C:/artifacts/t-11.999.png', overflow: [], seeked: true }
    ]
  }
}
let capturedOptions
const videoSummary = await command.runArtifactPreview(async (_path, _root, options) => {
  capturedOptions = options
  return videoResult
}, 'demo.html', 'C:/project')
ok(/pour-over/.test(String(videoSummary.summary.composition)), '摘要写明是哪个合成')
ok(/1080×1920/.test(String(videoSummary.summary.composition)), '摘要写画幅')
ok(/12 秒/.test(String(videoSummary.summary.composition)), '摘要写时长')
ok(String(videoSummary.summary.sheet).includes('t=秒'), '摘要说明总览图带 t=秒 标注')
assert.equal(videoSummary.summary.samples.length, 2, '摘要逐时间点列截图')
ok(String(videoSummary.summary.samples[0]).startsWith('t=1.2s'), '摘要按 t=秒 标注时间点')
assert.equal(videoSummary.summary.overflow.length, 1, '有问题的取样都进摘要')
ok(String(videoSummary.summary.overflow[0]).includes('h2#line1'), '摘要写出超出画框的元素')
assert.equal(videoSummary.summary.consoleErrors, 1, '摘要报告控制台错误数')
ok(String(videoSummary.summary.note).includes('总览图'), '摘要说明这是视频合成总览图')
ok(videoSummary.summary.composition && !('shots' in videoSummary.summary), '视频合成不再返回整页拼版字段')
ok(true, '视频摘要')

await command.runArtifactPreview(async (_path, _root, options) => {
  capturedOptions = options
  return videoResult
}, 'demo.html', 'C:/project', '1.5,4')
assert.deepEqual(capturedOptions, { at: [1.5, 4] }, '--at 透传到截图实现')
await command.runArtifactPreview(async (_path, _root, options) => {
  capturedOptions = options
  return videoResult
}, 'demo.html', 'C:/project')
assert.deepEqual(capturedOptions, {}, '没有 --at 时不传覆盖参数')
await assert.rejects(
  command.runArtifactPreview(async () => videoResult, 'demo.html', 'C:/project', 'oops'),
  (error) => error.code === 'artifact_preview_at' && /1\.5,4/.test(error.message),
  '坏 --at 报 artifact_preview_at'
)
const notReadySummary = await command.runArtifactPreview(async () => ({
  ...videoResult,
  video: { ...videoResult.video, timelineReady: false }
}), 'demo.html', 'C:/project')
ok(/没等到 window.__timelines/.test(String(notReadySummary.summary.composition)), '控制器缺失时摘要说明 seek 可能没生效')
const staticSummary = await command.runArtifactPreview(async () => ({
  shots: [{ scheme: 'light', viewport: 'desktop', path: 'C:/artifacts/light-desktop.png', horizontalOverflow: false, pageHeight: 800, screens: 1 }],
  consoleErrors: []
}), 'page.html', 'C:/project')
assert.equal(staticSummary.summary.shots.length, 1, '非合成页面仍返回原有截图摘要')
ok(!('composition' in staticSummary.summary), '非合成页面不带视频合成字段')
ok(/浅色|整页/.test(String(staticSummary.summary.note)), '非合成页面说明保持原样')
ok(true, '预览命令摘要')

console.log(`artifact preview video: ${checks} checks passed`)

if (process.env.YAN_ARTIFACT_PREVIEW_VIDEO_SMOKE !== '1') {
  console.log('artifact preview video: Electron 冒烟未运行（设 YAN_ARTIFACT_PREVIEW_VIDEO_SMOKE=1 开启）')
} else {
  await runSmoke()
}

async function runSmoke() {
  const sample = join(root, '.tmp', 'flash-live', 'video', 'three-step-pour-over.html')
  if (!existsSync(sample)) {
    console.log(`artifact preview video: 样例不在本机（${sample}），跳过冒烟`)
    return
  }
  const electronBinary = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(electronBinary)) {
    console.log('artifact preview video: node_modules 里没有 electron，跳过冒烟')
    return
  }
  const smokeDir = join(root, '.tmp', 'artifact-preview-video', 'smoke')
  await rm(smokeDir, { recursive: true, force: true })
  await mkdir(smokeDir, { recursive: true })
  const shotsDir = join(smokeDir, 'shots')
  await mkdir(shotsDir, { recursive: true })
  const reportPath = join(smokeDir, 'report.json')

  writeFileSync(
    join(smokeDir, 'entry.ts'),
    [
      "export { captureHtmlPreviewShots } from '../../../src/main/artifact-preview-shots'",
      "export { htmlArtifactPreviews, registerHtmlArtifactProtocol } from '../../../src/main/html-artifact-preview'",
      ''
    ].join('\n')
  )
  await build({
    entryPoints: [join(smokeDir, 'entry.ts')],
    outfile: join(smokeDir, 'bundle.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    external: ['electron']
  })

  writeFileSync(
    join(smokeDir, 'main.mjs'),
    [
      "import { app } from 'electron'",
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      "import { captureHtmlPreviewShots, htmlArtifactPreviews, registerHtmlArtifactProtocol } from './bundle.mjs'",
      '',
      'const htmlPath = process.env.SMOKE_HTML',
      'const rootDir = process.env.SMOKE_ROOT',
      'const outDir = process.env.SMOKE_OUT',
      'const reportPath = process.env.SMOKE_REPORT',
      '',
      "app.on('window-all-closed', () => {})",
      'app.whenReady().then(run)',
      '',
      'async function run() {',
      '  try {',
      '    registerHtmlArtifactProtocol()',
      '    const first = await captureHtmlPreviewShots({ previews: htmlArtifactPreviews, htmlPath, root: rootDir, outDir })',
      '    const second = await captureHtmlPreviewShots({ previews: htmlArtifactPreviews, htmlPath, root: rootDir, outDir, at: [1, 2] })',
      '    mkdirSync(dirname(reportPath), { recursive: true })',
      "    writeFileSync(reportPath, JSON.stringify({ ok: true, first, second }))",
      '  } catch (error) {',
      '    mkdirSync(dirname(reportPath), { recursive: true })',
      "    writeFileSync(reportPath, JSON.stringify({ ok: false, error: String(error?.stack ?? error) }))",
      '  }',
      '  app.exit(0)',
      '}',
      ''
    ].join('\n')
  )

  const env = {
    ...process.env,
    SMOKE_HTML: sample,
    SMOKE_ROOT: root,
    SMOKE_OUT: shotsDir,
    SMOKE_REPORT: reportPath,
    YAN_DATA_DIR: join(smokeDir, 'data'),
    YAN_PI_DIR: join(smokeDir, 'pi')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RUN_AS_NODE_BIN
  const started = Date.now()
  const run = spawnSync(electronBinary, [join(smokeDir, 'main.mjs')], { env, encoding: 'utf8', timeout: 240000 })
  const elapsed = Date.now() - started
  assert.equal(existsSync(reportPath), true, `冒烟脚本写出了报告（stderr: ${(run.stderr ?? '').slice(-2000)}）`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.ok, true, `冒烟预览成功：${report.error ?? ''}`)

  const scan = (result, label) => {
    ok(result.video, `${label}：识别为视频合成`)
    const video = result.video
    assert.equal(video.compositionId, 'pour-over', `${label}：读到合成 id`)
    assert.deepEqual([video.width, video.height], [1080, 1920], `${label}：读到合成画幅 1080x1920`)
    assert.deepEqual([video.screenWidth, video.screenHeight], [720, 1280], `${label}：截图按比例缩到 720x1280`)
    assert.equal(video.duration, 12, `${label}：读到合成时长 12 秒`)
    assert.equal(video.timelineReady, true, `${label}：等到 window.__timelines 控制器`)
    assert.equal(result.shots.length, 0, `${label}：视频合成不走整页拼版`)
    ok(existsSync(video.sheetPath), `${label}：写出总览图`)
    const sheet = readFileSync(video.sheetPath)
    ok(sheet.slice(1, 4).toString() === 'PNG', `${label}：总览图是 PNG`)
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt((video.samples.length * video.screenHeight) / video.screenWidth))))
    const rows = Math.ceil(video.samples.length / columns)
    assert.equal(sheet.readUInt32BE(16), columns * video.screenWidth + (columns - 1) * 16, `${label}：总览图宽度按列数拼版`)
    assert.equal(sheet.readUInt32BE(20), rows * video.screenHeight + (rows - 1) * 16, `${label}：总览图高度按行数拼版`)
    const hashes = new Set()
    for (const item of video.samples) {
      ok(existsSync(item.path), `${label}：t=${item.at} 的截图存在`)
      const png = readFileSync(item.path)
      ok(png.readUInt32BE(16) === 720 && png.readUInt32BE(20) === 1280, `${label}：t=${item.at} 截图是 720x1280`)
      ok(item.seeked, `${label}：t=${item.at} seek 成功`)
      ok(Array.isArray(item.overflow), `${label}：t=${item.at} 带超出画框检查结果`)
      hashes.add(createHash('sha1').update(png).digest('hex'))
    }
    return { video, hashes }
  }

  const first = scan(report.first, '默认取样')
  assert.deepEqual(first.video.samples.map((item) => item.at), [1.2, 3.7, 6.3, 8.8, 11, 11.999], '默认取样 = 五个片段中点 + 结尾帧')
  ok(first.hashes.size >= 5, `不同时间点画面不同（${first.hashes.size}/${first.video.samples.length} 张不同）`)
  ok(report.first.consoleErrors.length === 0, `没有控制台错误（${report.first.consoleErrors.slice(0, 2).join(' | ')}）`)

  const second = scan(report.second, '--at 覆盖')
  assert.deepEqual(second.video.samples.map((item) => item.at), [1, 2], '--at 1,2 只取这两个时间点')
  ok(second.hashes.size === 2, '两个时间点画面不同')

  console.log(`artifact preview video: 冒烟 ${first.video.compositionId} ${first.video.width}x${first.video.height}，${first.video.samples.length} 个时间点，总览图 ${first.video.sheetPath}，耗时 ${Math.round(elapsed / 1000)}s`)
}
