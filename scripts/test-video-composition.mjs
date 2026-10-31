import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const GUIDE = 'resources/skills/artifact/guides/video.md'
const SAMPLE = '.tmp/canvas-w3-视频成果指南/sample/index.html'
const CLOCK_TOKENS = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'Math.random', 'Date.now']
const CONTROLLER_METHODS = ['duration', 'seek', 'play', 'pause', 'paused']

let checks = 0
const ok = (value, label) => {
  assert.ok(value, label)
  checks++
}

function readAttrs(source) {
  const out = {}
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4]
  }
  return out
}

function parseTags(html) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  return [...markup.matchAll(/<([a-zA-Z][\w:-]*)((?:\s[^<>]*?)?)\s*\/?>/g)].map((match) => ({
    name: match[1].toLowerCase(),
    attrs: readAttrs(match[2])
  }))
}

function checkComposition(html, label, minimumClips = 2) {
  const tags = parseTags(html)
  const root = tags.find((tag) => tag.attrs['data-composition-id'] !== undefined)
  ok(root, `${label}：有 data-composition-id 的合成根元素`)
  ok(root.attrs.id === 'stage', `${label}：合成根元素 id 是 stage`)
  const id = root.attrs['data-composition-id'].trim()
  ok(id.length > 0, `${label}：data-composition-id 非空`)
  const total = Number(root.attrs['data-duration'])
  ok(Number.isFinite(total) && total > 0, `${label}：data-duration 是正数秒`)
  ok(Number(root.attrs['data-width']) > 0 && Number(root.attrs['data-height']) > 0, `${label}：data-width / data-height 是正数`)

  const clips = tags.filter((tag) => tag.attrs['data-start'] !== undefined)
  ok(clips.length >= minimumClips, `${label}：至少 ${minimumClips} 个带 data-start 的片段，实际 ${clips.length}`)
  let end = 0
  for (const clip of clips) {
    const start = Number(clip.attrs['data-start'])
    const span = Number(clip.attrs['data-duration'])
    ok(Number.isFinite(start) && start >= 0, `${label}：片段 data-start ${clip.attrs['data-start']} 是有效秒数`)
    ok(Number.isFinite(span) && span > 0, `${label}：片段 data-duration ${clip.attrs['data-duration']} 是正数秒`)
    ok(start + span <= total + 1e-6, `${label}：片段 ${start}s + ${span}s 落在总时长 ${total}s 内`)
    ok(/^\d+$/.test(String(clip.attrs['data-track-index'] ?? '')), `${label}：片段带数字 data-track-index`)
    end = Math.max(end, start + span)
  }
  ok(Math.abs(end - total) < 1e-6, `${label}：最后一镜结束于 ${end}s，与 data-duration ${total}s 一致`)

  ok(!/https?:\/\//i.test(html), `${label}：没有 http(s):// 外链`)
  ok(!/["'(]\s*\/\/[a-z0-9]/i.test(html), `${label}：没有协议相对的 CDN 地址`)
  ok(!/@import/i.test(html), `${label}：没有 @import`)
  ok(!/fonts\.googleapis|cdn\./i.test(html), `${label}：没有网络字体或 CDN 主机`)
  for (const token of CLOCK_TOKENS) ok(!html.includes(token), `${label}：没有 ${token}`)
  ok(!/\bautoplay\b/i.test(html), `${label}：没有 autoplay`)

  for (const media of tags.filter((tag) => tag.name === 'audio' || tag.name === 'video')) {
    ok(media.attrs['data-start'] !== undefined && media.attrs['data-duration'] !== undefined, `${label}：${media.name} 带 data-start 与 data-duration`)
    ok(media.attrs['data-track-index'] !== undefined, `${label}：${media.name} 带 data-track-index`)
  }

  ok(html.includes('__timelines'), `${label}：注册了 window.__timelines`)
  ok(html.includes(`__timelines['${id}']`) || html.includes(`__timelines["${id}"]`), `${label}：控制器挂在 __timelines['${id}']`)
  const controller = html.slice(html.indexOf('__timelines'))
  for (const method of CONTROLLER_METHODS) ok(new RegExp(`${method}\\s*[:(]`).test(controller), `${label}：控制器暴露 ${method}()`)
  ok(html.includes('.currentTime'), `${label}：seek 靠 currentTime 定位动画`)
  ok(html.includes('steps(1'), `${label}：片段进出用阶梯关键帧，不淡入淡出`)

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((body) => body.trim())
  ok(scripts.length >= 1, `${label}：有内联脚本`)
  for (const body of scripts) {
    let compiles = true
    try {
      new Function(body)
    } catch {
      compiles = false
    }
    ok(compiles, `${label}：内联脚本语法有效`)
  }
  return { id, total, clips: clips.length }
}

function checkThreeComposition(html, label) {
  const tags = parseTags(html)
  const root = tags.find((tag) => tag.attrs['data-composition-id'] !== undefined)
  ok(root && root.attrs.id === 'stage', `${label}：合成根元素 id 是 stage`)
  const id = root.attrs['data-composition-id'].trim()
  const total = Number(root.attrs['data-duration'])
  ok(id && Number.isFinite(total) && total > 0 && Number(root.attrs['data-width']) > 0, `${label}：根元素带 id、时长与尺寸`)
  const clips = tags.filter((tag) => tag.attrs['data-start'] !== undefined)
  ok(clips.length >= 2 && clips.every((clip) => Number(clip.attrs['data-start']) + Number(clip.attrs['data-duration']) <= total + 1e-6), `${label}：片段落在总时长内`)
  ok(html.includes('<script data-yan-lib="three"></script>'), `${label}：用占位标签引入随包 three.js`)
  ok(!/https?:\/\/|@import|\bimport\s|cdn\./i.test(html), `${label}：没有外链、import 或 CDN`)
  for (const token of ['setTimeout', 'setInterval', 'Math.random', 'Date.now', 'THREE.Clock']) ok(!html.includes(token), `${label}：没有 ${token}`)
  ok(/preserveDrawingBuffer:\s*true/.test(html), `${label}：渲染器开 preserveDrawingBuffer`)
  const controller = html.slice(html.indexOf(`__timelines['${id}']`))
  ok(controller.length < html.length, `${label}：控制器挂在 __timelines['${id}']`)
  for (const method of CONTROLLER_METHODS) ok(new RegExp(`${method}\\s*[:(]`).test(controller), `${label}：控制器暴露 ${method}()`)
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((body) => body.trim())
  ok(scripts.length >= 1, `${label}：有内联脚本`)
  for (const body of scripts) {
    let compiles = true
    try { new Function(body) } catch { compiles = false }
    ok(compiles, `${label}：内联脚本语法有效`)
  }
}

const guide = readFileSync(GUIDE, 'utf8')
const allBlocks = [...guide.matchAll(/```html\n([\s\S]*?)```/g)].map((match) => match[1])
const threeBlocks = allBlocks.filter((block) => block.includes('data-yan-lib') && block.includes('data-composition-id'))
ok(threeBlocks.length >= 1, '指南里有 three.js 合成模板')
for (const [index, block] of threeBlocks.entries()) checkThreeComposition(block, `三维模板 ${index + 1}`)
const blocks = allBlocks.filter((block) => !block.includes('data-yan-lib'))
ok(blocks.length >= 1, '指南里有 html 模板代码块')
for (const [index, block] of blocks.entries()) checkComposition(block, `指南模板 ${index + 1}`)
for (const [index, block] of blocks.entries()) {
  const inlineScripts = [...block.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((match) => !/\bsrc\s*=/.test(match[1]))
  ok(inlineScripts.length > 0, `指南模板 ${index + 1} 有可执行的内联脚本`)
  for (const [, , source] of inlineScripts) {
    const anything = () => new Proxy(function () {}, {
      get: (_target, key) => (key === Symbol.toPrimitive ? () => 1 : key === Symbol.iterator ? function* () {} : key === 'length' ? 0 : anything()),
      apply: () => anything()
    })
    const run = new Function('window', 'document', source)
    const fakeWindow = {}
    let thrown = null
    try {
      run(fakeWindow, anything())
    } catch (error) {
      thrown = error
    }
    ok(thrown === null, `指南模板 ${index + 1} 的脚本能直接执行：${thrown ? thrown.message : 'ok'}`)
    ok(fakeWindow.__timelines && Object.keys(fakeWindow.__timelines).length > 0, `指南模板 ${index + 1} 注册了 window.__timelines`)
  }
}

if (existsSync(SAMPLE)) {
  const summary = checkComposition(readFileSync(SAMPLE, 'utf8'), '样例合成', 3)
  console.log(`video composition: 样例 ${summary.id} ${summary.total}s / ${summary.clips} 镜`)
} else {
  console.log(`video composition: 样例不在本机（${SAMPLE}），只检查指南模板`)
}

console.log(`video composition: ${checks} checks passed`)
