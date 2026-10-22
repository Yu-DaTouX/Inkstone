#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'w4-export', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}

const electronStub = join(workDir, 'electron-stub.mjs')
writeFileSync(
  electronStub,
  [
    'export class BrowserWindow {}',
    'export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }',
    'export const session = { defaultSession: { webRequest: { onBeforeRequest() {} } } }',
    'export const nativeImage = { createFromBitmap: () => ({}) }',
    ''
  ].join('\n')
)

const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
  }
}

const outfile = join(workDir, 'video-export.mjs')
await build({
  entryPoints: ['src/main/video-export.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [stubElectron]
})
const mod = await import(pathToFileURL(outfile).href)

assert.equal(mod.VIDEO_EXPORT_DEFAULT_FPS, 30, '默认 30fps')
assert.equal(mod.VIDEO_EXPORT_MAX_FRAMES, 18000, '帧数上限 30*600')
assert.equal(mod.VIDEO_EXPORT_MAX_DURATION, 600, '时长上限 10 分钟')
assert.equal(mod.VIDEO_EXPORT_MAX_WIDTH, 3840, '宽度上限')
assert.equal(mod.VIDEO_EXPORT_MAX_HEIGHT, 2160, '高度上限')

assert.equal(mod.normalizeExportFps(undefined), 30, '缺省 fps 回到 30')
assert.equal(mod.normalizeExportFps('12'), 12, '字符串 fps 生效')
assert.equal(mod.normalizeExportFps(0), 30, '0 回到默认值')
assert.equal(mod.normalizeExportFps(-5), 30, '负数回到默认值')
assert.equal(mod.normalizeExportFps(Number.NaN), 30, 'NaN 回到默认值')
assert.equal(mod.normalizeExportFps(30.6), 31, '四舍五入到整数')
assert.equal(mod.normalizeExportFps(240), 60, '上限 60')
ok(true, 'fps 归一化')

assert.equal(mod.exportFrameCount(10, 10), 100, '10 秒 10fps = 100 帧')
assert.equal(mod.exportFrameCount(6, 30), 180, '6 秒 30fps = 180 帧')
assert.equal(mod.exportFrameCount(6.004, 30), 181, '小数时长向上取整')
assert.equal(mod.exportFrameCount(0.01, 30), 1, '极短合成至少 1 帧')
assert.equal(mod.exportFrameCount(0, 30), 0, '零时长没有帧')
assert.equal(mod.exportFrameCount(-3, 30), 0, '负时长没有帧')
assert.equal(mod.exportFrameCount(10, 0), 0, '零 fps 没有帧')
assert.equal(mod.exportFrameCount(3.3333333, 30), 100, '浮点误差不会多出一帧')
ok(true, '帧数计算')

assert.equal(mod.exportWithinLimits(18000, 30), true, '18000 帧 / 600 秒在限内')
assert.equal(mod.exportWithinLimits(18001, 30), false, '超过 18000 帧不行')
assert.equal(mod.exportWithinLimits(6001, 10), false, '超过 600 秒不行')
assert.equal(mod.exportWithinLimits(0, 30), false, '零帧不行')
ok(true, '上限判断')

const full = mod.exportPixelSize(1920, 1080, 1)
assert.deepEqual(full, { width: 1920, height: 1080, scale: 1, zoom: 1 }, '1920x1080 scale 1 原样')
const quarter = mod.exportPixelSize(1920, 1080, 0.25)
assert.deepEqual(quarter, { width: 480, height: 270, scale: 0.25, zoom: 0.25 }, 'scale 0.25 得到 480x270')
const vertical = mod.exportPixelSize(1080, 1920, 0.5)
assert.deepEqual(vertical, { width: 540, height: 960, scale: 0.5, zoom: 0.5 }, '竖屏按比例缩放')
const odd = mod.exportPixelSize(1921, 1081, 1)
assert.deepEqual(odd, { width: 1922, height: 1082, scale: 1922 / 1921, zoom: 1922 / 1921 }, '奇数尺寸补齐到偶数（yuv420p 需要）')
const capped = mod.exportPixelSize(7680, 4320, 1)
assert.deepEqual(capped, { width: 3840, height: 2160, scale: 0.5, zoom: 0.5 }, '超过 4K 按比例缩到 3840x2160')
const noUpscale = mod.exportPixelSize(1920, 1080, 2)
assert.deepEqual(noUpscale, { width: 1920, height: 1080, scale: 1, zoom: 1 }, 'scale 最大 1，不放大')
const tiny = mod.exportPixelSize(1920, 1080, 0.01)
assert.deepEqual(tiny, { width: 480, height: 270, scale: 0.25, zoom: 0.25 }, 'scale 下限 0.25')
const fallback = mod.exportPixelSize(0, 0, 1)
assert.deepEqual(fallback, { width: 1920, height: 1080, scale: 1, zoom: 1 }, '缺尺寸时回到 1920x1080')
ok(true, '输出尺寸与像素比')

const args = mod.ffmpegEncodeArgs({ fps: 30, outPath: 'C:/tmp/out.mp4' })
assert.equal(args[args.length - 1], 'C:/tmp/out.mp4', '参数末尾是输出路径')
assert.deepEqual(args.slice(0, 9), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'image2pipe', '-framerate', '30'], '从 stdin 读 PNG 图片流')
for (const flag of ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart']) {
  ok(args.includes(flag), `ffmpeg 参数包含 ${flag}`)
}
assert.ok(args.indexOf('-i') === args.indexOf('-') - 1, '-i - 表示从管道读')
assert.ok(args.includes('-an'), '不写音轨')

const known = new Set(['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\other\\ffmpeg.exe'])
const fromEnv = mod.findFfmpeg({ env: { YAN_FFMPEG: 'C:\\ffmpeg\\bin\\ffmpeg.exe', PATH: '' }, platform: 'win32', exists: (p) => known.has(p) })
assert.equal(fromEnv, 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'YAN_FFMPEG 优先')
const fromPath = mod.findFfmpeg({
  env: { PATH: '"C:\\other";C:\\nowhere;' },
  platform: 'win32',
  exists: (p) => known.has(p)
})
assert.equal(fromPath, 'C:\\other\\ffmpeg.exe', 'PATH 里找到 ffmpeg.exe（带引号的目录也能剥离）')
const posixBinary = join('/usr/local/bin', 'ffmpeg')
const posix = mod.findFfmpeg({ env: {}, pathValue: '/usr/local/bin:/usr/bin', platform: 'linux', exists: (p) => p === posixBinary })
assert.equal(posix, posixBinary, '非 Windows 只找 ffmpeg')
const missing = mod.findFfmpeg({ env: {}, pathValue: '/nowhere', platform: 'linux', exists: () => false })
assert.equal(missing, null, '找不到返回 null')
assert.ok(mod.ffmpegMissingMessage({ YAN_FFMPEG: 'C:\\bad\\ffmpeg.exe' }).includes('C:\\bad\\ffmpeg.exe'), '缺失提示带上 YAN_FFMPEG 路径')
assert.ok(mod.ffmpegMissingMessage({}).includes('winget install Gyan.FFmpeg'), '缺失提示给出 winget 安装命令')
ok(true, 'ffmpeg 查找与提示')

const pageDir = join(root, 'p')
const takenSet = new Set([join(pageDir, 'demo.mp4'), join(pageDir, 'demo-2.mp4')])
assert.equal(mod.uniqueVideoPath(join(pageDir, 'demo.mp4'), (p) => takenSet.has(p)), join(pageDir, 'demo-3.mp4'), '已存在时加序号')
assert.equal(mod.uniqueVideoPath(join(pageDir, 'fresh.mp4'), () => false), join(pageDir, 'fresh.mp4'), '不存在时原样')
assert.equal(mod.defaultVideoPath(join(pageDir, 'demo.html'), () => false), join(pageDir, 'demo.mp4'), '默认输出到 HTML 同目录同名 mp4')
assert.equal(mod.defaultVideoPath(join(pageDir, 'demo.htm'), (p) => p === join(pageDir, 'demo.mp4')), join(pageDir, 'demo-2.mp4'), '默认名冲突时加序号')
assert.equal(mod.defaultVideoPath(join(pageDir, 'a.b.html'), () => false), join(pageDir, 'a.b.mp4'), '只去掉最后的扩展名')
ok(true, '输出路径去重')

console.log(`video export: ${checks} checks passed`)

if (process.env.YAN_VIDEO_EXPORT_SMOKE !== '1') {
  console.log('video export: 冒烟导出未运行（设 YAN_VIDEO_EXPORT_SMOKE=1 开启，需要一个可用的 FFmpeg）')
} else {
  await runSmoke()
}

async function runSmoke() {
  const ffmpeg = mod.findFfmpeg()
  if (!ffmpeg) {
    console.log('video export: 本机没有 FFmpeg，跳过冒烟导出')
    return
  }
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (match) => (match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))
  const hasProbe = existsSync(ffprobe)
  const sample = join(root, '.tmp', 'canvas-live', 'video', 'index.html')
  if (!existsSync(sample)) {
    console.log(`video export: 样例不在本机（${sample}），跳过冒烟导出`)
    return
  }
  const electronBinary = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(electronBinary)) {
    console.log('video export: node_modules 里没有 electron，跳过冒烟导出')
    return
  }

  const smokeDir = join(root, '.tmp', 'w4-export', 'smoke')
  await rm(smokeDir, { recursive: true, force: true })
  await mkdir(smokeDir, { recursive: true })
  const outDir = join(smokeDir, 'out')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, 'yan-export-smoke.mp4')
  rmSync(outPath, { force: true })
  const reportPath = join(smokeDir, 'report.json')

  writeFileSync(
    join(smokeDir, 'entry.ts'),
    [
      "export { exportVideo, VideoExportError } from '../../../src/main/video-export'",
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
      "import { exportVideo, registerHtmlArtifactProtocol } from './bundle.mjs'",
      '',
      'const htmlPath = process.env.SMOKE_HTML',
      'const rootDir = process.env.SMOKE_ROOT',
      'const outPath = process.env.SMOKE_OUT',
      'const reportPath = process.env.SMOKE_REPORT',
      '',
      "app.on('window-all-closed', () => {})",
      'app.whenReady().then(run)',
      '',
      'async function run() {',
      '  try {',
      '    registerHtmlArtifactProtocol()',
      '    const result = await exportVideo({',
      '      htmlPath,',
      '      root: rootDir,',
      '      outPath,',
      '      fps: 10,',
      '      scale: 0.25',
      '    })',
      '    mkdirSync(dirname(reportPath), { recursive: true })',
      '    writeFileSync(reportPath, JSON.stringify({ ok: true, ...result }))',
      '  } catch (error) {',
      '    mkdirSync(dirname(reportPath), { recursive: true })',
      "    writeFileSync(reportPath, JSON.stringify({ ok: false, code: error?.code, error: String(error?.stack ?? error) }))",
      '  }',
      '  app.exit(0)',
      '}',
      ''
    ].join('\n')
  )

  const env = { ...process.env, SMOKE_HTML: sample, SMOKE_ROOT: root, SMOKE_OUT: outPath, SMOKE_REPORT: reportPath, YAN_DATA_DIR: join(smokeDir, 'data'), YAN_PI_DIR: join(smokeDir, 'pi') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RUN_AS_NODE_BIN
  const started = Date.now()
  const run = spawnSync(electronBinary, [join(smokeDir, 'main.mjs')], { env, encoding: 'utf8', timeout: 240000 })
  const elapsed = Date.now() - started
  assert.equal(existsSync(reportPath), true, `冒烟脚本写出了报告（stderr: ${(run.stderr ?? '').slice(-2000)}）`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.ok, true, `冒烟导出成功：${report.error ?? ''}`)
  assert.equal(existsSync(outPath), true, 'MP4 文件存在')
  assert.equal(report.frames, 100, '导出 100 帧（10 秒 × 10fps）')
  assert.equal(report.width, 480, '输出宽度 480')
  assert.equal(report.height, 270, '输出高度 270')
  ok(true, `冒烟导出 ${outPath}（${Math.round(elapsed / 1000)}s）`)

  if (hasProbe) {
    const probe = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate:format=duration,size', '-of', 'json', outPath], { encoding: 'utf8' })
    const info = JSON.parse(probe.stdout || '{}')
    const stream = (info.streams ?? [])[0] ?? {}
    const duration = Number(info.format?.duration)
    ok(Math.abs(duration - 10) < 0.6, `ffprobe 时长 ≈ 10 秒（实际 ${duration}）`)
    ok(Number(stream.nb_read_frames) === 100, `ffprobe 读出 100 帧（实际 ${stream.nb_read_frames}）`)
    ok(Number(stream.width) === 480 && Number(stream.height) === 270, `ffprobe 读出 480x270（实际 ${stream.width}x${stream.height}）`)
    ok(stream.avg_frame_rate === '10/1', `帧率 10fps（实际 ${stream.avg_frame_rate}）`)
    ok(Number(info.format?.size) > 1000, '文件非空')
    const hashes = new Set()
    for (const second of [0.5, 5, 9.5]) {
      const framePath = join(smokeDir, `frame-${second}.png`)
      const grab = spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(second), '-i', outPath, '-frames:v', '1', framePath], { encoding: 'utf8' })
      assert.equal(grab.status, 0, `抽第 ${second} 秒的画面失败：${(grab.stderr ?? '').slice(-500)}`)
      hashes.add(createHash('sha1').update(readFileSync(framePath)).digest('hex'))
    }
    ok(hashes.size === 3, `不同时间点画面不同（逐帧 seek 生效，得到 ${hashes.size} 张不同截图）`)
  } else {
    console.log(`video export: 没有 ffprobe（${ffprobe}），只校验文件存在与导出报告`)
  }
  console.log(`video export: 冒烟导出 ${report.frames} 帧 ${report.width}x${report.height}，${report.bytes} bytes，耗时 ${report.elapsedMs}ms，ffmpeg=${report.ffmpeg}`)
}
