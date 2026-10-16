/**
 * 品牌设计真源的**纯逻辑**（不依赖 Electron / Node fs 之外的任何东西）。
 *
 * `resources/brand/inkstone-design.json` 是唯一真源：几何 SVG、像素 mask、配色、
 * 透明度与缓动、各状态四段时长。这个模块负责把它解析成生成脚本与测试共用的
 * 结构：mask → 单元格、时间线 → 去重帧时长、命名 → manifest、几何 → SVG 字符串。
 *
 * 之所以独立成一个模块：`scripts/build-icon.mjs` 需要 Electron 离屏渲染，而一致性
 * 小测（`scripts/test-brand-assets.mjs`）要在纯 Node 下核对真源与产物，两者共用这里的
 * 计算就不可能出现“脚本一套、测试另一套”的漂移。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const DESIGN_PATH = 'resources/brand/inkstone-design.json'
export const SVG_OUT = 'build/prompt-stone.svg'
export const GEOMETRY_OUT = 'src/shared/brand-geometry.ts'
export const MANIFEST_NAME = 'manifest.json'

export function readDesign(path) {
  const raw = readFileSync(path, 'utf8')
  return { design: JSON.parse(raw), hash: createHash('sha256').update(raw, 'utf8').digest('hex') }
}

export function sourceHash(design) {
  return createHash('sha256').update(JSON.stringify(design)).digest('hex')
}

/* ───────────────────────── 结构校验 ───────────────────────── */

function fail(message) {
  throw new Error(`品牌真源无效：${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateDesign(design) {
  if (!isPlainObject(design)) fail('根节点不是对象')
  if (design.version !== 1) fail(`version 必须是 1，实际 ${String(design.version)}`)

  const geometry = design.geometry
  if (!isPlainObject(geometry)) fail('缺少 geometry')
  if (!Array.isArray(geometry.viewBox) || geometry.viewBox.length !== 4 || !geometry.viewBox.every((n) => typeof n === 'number')) {
    fail('geometry.viewBox 必须是 4 个数字')
  }
  if (!isPlainObject(geometry.frame) || typeof geometry.frame.path !== 'string' || !geometry.frame.path) fail('geometry.frame.path 缺失')
  if (typeof geometry.frame.strokeWidth !== 'number' || geometry.frame.strokeWidth <= 0) fail('geometry.frame.strokeWidth 必须是正数')
  if (!Array.isArray(geometry.prompt) || geometry.prompt.length === 0) fail('geometry.prompt 必须是非空数组')
  for (const part of geometry.prompt) {
    if (!isPlainObject(part) || typeof part.path !== 'string' || !part.path) fail('geometry.prompt[].path 缺失')
    if (typeof part.strokeWidth !== 'number' || part.strokeWidth <= 0) fail('geometry.prompt[].strokeWidth 必须是正数')
  }

  const colors = design.colors
  if (!isPlainObject(colors)) fail('缺少 colors')
  for (const key of ['tile', 'rim', 'frame', 'accent', 'trayOnLight', 'trayOnDark']) {
    if (typeof colors[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colors[key])) fail(`colors.${key} 必须是 #rrggbb`)
  }

  if (!isPlainObject(design.masks)) fail('缺少 masks')
  for (const [key, mask] of Object.entries(design.masks)) {
    if (!/^\d+$/.test(key)) fail(`masks 的键必须是网格尺寸，实际 ${key}`)
    const grid = Number(key)
    if (!isPlainObject(mask) || mask.grid !== grid) fail(`masks.${key}.grid 必须是 ${grid}`)
    const cells = { frame: new Set(), prompt: new Set(), question: new Set() }
    for (const layer of ['frame', 'prompt', 'question']) {
      const rows = mask[layer]
      if (!Array.isArray(rows) || rows.length !== grid) fail(`masks.${key}.${layer} 必须有 ${grid} 行`)
      rows.forEach((row, y) => {
        if (typeof row !== 'string' || row.length !== grid) fail(`masks.${key}.${layer} 第 ${y} 行必须是 ${grid} 个字符`)
        for (let x = 0; x < grid; x += 1) {
          const ch = row[x]
          if (!'.FAQ'.includes(ch)) fail(`masks.${key}.${layer} 第 ${y} 行出现非法字符 ${JSON.stringify(ch)}`)
          const mark = ch === '.' ? null : ch
          const want = layer === 'frame' ? 'F' : layer === 'prompt' ? 'A' : 'Q'
          if (mark && mark !== want) fail(`masks.${key}.${layer} 第 ${y} 行应为 ${want} 或 .，实际 ${mark}`)
          if (mark) cells[layer].add(`${x},${y}`)
        }
      })
    }
    for (const a of cells.frame) {
      if (cells.prompt.has(a) || cells.question.has(a)) fail(`masks.${key}：符号与石框在第 ${a} 格相交`)
    }
    if (cells.prompt.size === 0) fail(`masks.${key}.prompt 为空`)
    if (cells.question.size === 0) fail(`masks.${key}.question 为空`)
  }

  const anim = design.animation
  if (!isPlainObject(anim)) fail('缺少 animation')
  if (!Number.isInteger(anim.samples) || anim.samples <= 1) fail('animation.samples 必须是大于 1 的整数')
  if (!isPlainObject(anim.alpha)) fail('缺少 animation.alpha')
  if (!(anim.alpha.bright > anim.alpha.dark) || anim.alpha.dark < 0 || anim.alpha.bright > 1) fail('animation.alpha 必须满足 1 >= bright > dark >= 0')
  if (anim.alpha.easing !== 'smoothstep') fail(`animation.alpha.easing 只支持 smoothstep，实际 ${String(anim.alpha.easing)}`)
  if (!isPlainObject(anim.states) || !anim.states.running || !anim.states.waiting) fail('animation.states 必须有 running 与 waiting')

  for (const state of ['running', 'waiting']) {
    const spec = anim.states[state]
    if (!['prompt', 'question'].includes(spec.symbol)) fail(`animation.states.${state}.symbol 必须是 prompt 或 question`)
    if (!Number.isInteger(spec.periodMs) || spec.periodMs <= 0) fail(`animation.states.${state}.periodMs 必须是正整数`)
    if (spec.periodMs % anim.samples !== 0) fail(`animation.states.${state}.periodMs 必须能被 samples 整除`)
    const segments = spec.segmentsMs
    if (!isPlainObject(segments)) fail(`animation.states.${state}.segmentsMs 缺失`)
    const sum = ['brightHold', 'fadeDown', 'darkHold', 'fadeUp'].reduce((acc, name) => {
      const value = segments[name]
      if (!Number.isInteger(value) || value < 0) fail(`animation.states.${state}.segmentsMs.${name} 必须是非负整数`)
      if (value % (spec.periodMs / anim.samples) !== 0) fail(`animation.states.${state} 的 ${name} 必须是原生帧长的整数倍`)
      return acc + value
    }, 0)
    if (sum !== spec.periodMs) fail(`animation.states.${state} 四段之和 ${sum} 不等于 periodMs ${spec.periodMs}`)
  }

  const outputs = design.outputs
  if (!isPlainObject(outputs)) fail('缺少 outputs')
  if (!Number.isInteger(outputs.iconPng) || outputs.iconPng <= 0) fail('outputs.iconPng 必须是正整数')
  if (!Array.isArray(outputs.icoSizes) || outputs.icoSizes.length === 0 || !outputs.icoSizes.every((n) => Number.isInteger(n) && n > 0)) fail('outputs.icoSizes 必须是正整数数组')
  if (!Array.isArray(outputs.traySizes) || outputs.traySizes.length === 0) fail('outputs.traySizes 缺失')
  for (const entry of outputs.traySizes) {
    if (!isPlainObject(entry) || !Number.isInteger(entry.px) || entry.px <= 0 || typeof entry.suffix !== 'string') fail('outputs.traySizes[] 必须是 { px, suffix }')
  }
  if (!Array.isArray(outputs.trayThemes) || outputs.trayThemes.length === 0 || !outputs.trayThemes.every((t) => ['on-light', 'on-dark'].includes(t))) {
    fail('outputs.trayThemes 必须只含 on-light / on-dark')
  }
  return design
}

/* ───────────────────────── 像素 mask ───────────────────────── */

/** 解析某一网格的某一层为 `x,y` 集合。 */
export function maskCells(design, gridKey, layer) {
  const mask = design.masks[String(gridKey)]
  if (!mask) fail(`没有 ${gridKey} 网格`)
  const rows = mask[layer]
  if (!rows) fail(`网格 ${gridKey} 没有 ${layer} 层`)
  const cells = new Set()
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== '.') cells.add(`${x},${y}`)
  })
  return cells
}

/* ───────────────────────── 时间线 ───────────────────────── */

const SEGMENT_ORDER = ['brightHold', 'fadeDown', 'darkHold', 'fadeUp']

function smoothstep(p) {
  const t = Math.min(1, Math.max(0, p))
  return t * t * (3 - 2 * t)
}

/** 第 i 帧中心的 alpha（0..1）。 */
export function frameAlpha(design, state, index) {
  const anim = design.animation
  const spec = anim.states[state]
  const frameMs = spec.periodMs / anim.samples
  const t = (index + 0.5) * frameMs
  const seg = spec.segmentsMs
  const b1 = seg.brightHold
  const b2 = b1 + seg.fadeDown
  const b3 = b2 + seg.darkHold
  const { bright, dark } = anim.alpha
  if (t < b1) return bright
  if (t < b2) return bright - (bright - dark) * smoothstep((t - b1) / seg.fadeDown)
  if (t < b3) return dark
  return dark + (bright - dark) * smoothstep((t - b3) / seg.fadeUp)
}

/** alpha 的 0..255 整数表示；去重比较与生成都用它。 */
export function frameAlpha255(design, state, index) {
  return Math.round(frameAlpha(design, state, index) * 255)
}

/**
 * 把 `samples` 帧按连续相同 alpha 合并成去重帧。
 * 返回 `[{ index, alpha255, durationMs, samples }]`，所有 durationMs 之和等于 periodMs。
 */
export function dedupedFrames(design, state) {
  const anim = design.animation
  const spec = anim.states[state]
  const frameMs = spec.periodMs / anim.samples
  const out = []
  for (let i = 0; i < anim.samples; i += 1) {
    const alpha255 = frameAlpha255(design, state, i)
    const last = out[out.length - 1]
    if (last && last.alpha255 === alpha255) {
      last.durationMs += frameMs
      last.samples += 1
      continue
    }
    out.push({ index: out.length, alpha255, durationMs: frameMs, samples: 1 })
  }
  const total = out.reduce((acc, f) => acc + f.durationMs, 0)
  if (total !== spec.periodMs) fail(`状态 ${state} 去重帧总时长 ${total} 不等于 periodMs ${spec.periodMs}`)
  return out
}

/* ───────────────────────── 命名与 manifest ───────────────────────── */

function pad2(n) {
  return String(n).padStart(2, '0')
}

function suffixFor(design, px) {
  const size = design.outputs.traySizes.find((entry) => entry.px === px)
  if (!size) fail(`未定义 ${px}px 托盘尺寸`)
  return size.suffix
}

/** 生成脚本与 manifest 共用的托盘文件名（相对 build/tray/，base 名供 nativeImage 自动挑 @1.5x/@2x）。 */
export function trayNames(design) {
  const names = {}
  for (const theme of design.outputs.trayThemes) {
    const entry = {
      static: {
        idle: `tray-${theme}.png`,
        running: `tray-${theme}.png`,
        waiting: `tray-${theme}-waiting.png`
      },
      running: [],
      waiting: []
    }
    for (const state of ['running', 'waiting']) {
      const count = dedupedFrames(design, state).length
      for (let i = 0; i < count; i += 1) entry[state].push(`tray-${theme}-${state}-${pad2(i)}.png`)
    }
    names[theme] = entry
  }
  return names
}

/** 每个 (theme,size,state,index) 的实际落盘文件名。 */
export function trayFilePath(design, theme, px, state, index, kind = 'frame') {
  const suffix = suffixFor(design, px)
  if (kind === 'frame') return `tray-${theme}-${state}-${pad2(index)}${suffix}.png`
  if (kind === 'static-idle' || kind === 'static-running') return `tray-${theme}${suffix}.png`
  if (kind === 'static-waiting') return `tray-${theme}-waiting${suffix}.png`
  fail(`未知的托盘文件类型 ${kind}`)
}

export function buildManifest(design, hash) {
  const manifest = {
    version: 1,
    generatedBy: 'scripts/build-icon.mjs',
    source: DESIGN_PATH,
    sourceHash: hash,
    timelines: {},
    themes: {}
  }
  for (const state of ['running', 'waiting']) {
    const spec = design.animation.states[state]
    manifest.timelines[state] = {
      symbol: spec.symbol,
      periodMs: spec.periodMs,
      frameMs: spec.periodMs / design.animation.samples,
      easing: design.animation.alpha.easing,
      alpha: { bright: design.animation.alpha.bright, dark: design.animation.alpha.dark },
      frames: dedupedFrames(design, state).map((frame) => ({ index: frame.index, alpha255: frame.alpha255, durationMs: frame.durationMs }))
    }
  }
  for (const theme of design.outputs.trayThemes) {
    manifest.themes[theme] = {
      static: {
        idle: trayFilePath(design, theme, 16, 'idle', 0, 'static-idle'),
        running: trayFilePath(design, theme, 16, 'running', 0, 'static-running'),
        waiting: trayFilePath(design, theme, 16, 'waiting', 0, 'static-waiting')
      },
      running: [],
      waiting: []
    }
    for (const state of ['running', 'waiting']) {
      const count = dedupedFrames(design, state).length
      for (let i = 0; i < count; i += 1) manifest.themes[theme][state].push(trayFilePath(design, theme, 16, state, i))
    }
  }
  return manifest
}

/* ───────────────────────── SVG 渲染 ───────────────────────── */

/**
 * 几何真源 → SVG 字符串。
 *
 * 分组标签上带 `stroke`，且 id 固定为 `stone-frame` / `prompt`：安装器侧栏与手机端
 * 生成脚本按这两个 id + `stroke="currentColor"` 换色，格式不能改。
 */
export function renderSvg(design, { frame = 'currentColor', accent = 'currentColor' } = {}) {
  const { viewBox, frame: frameGeom, prompt } = design.geometry
  const frameLine =
    `<g id="stone-frame" fill="none" stroke="${frame}" stroke-width="${frameGeom.strokeWidth}"` +
    `${frameGeom.linecap ? ` stroke-linecap="${frameGeom.linecap}"` : ''}` +
    `${frameGeom.linejoin ? ` stroke-linejoin="${frameGeom.linejoin}"` : ''}>` +
    `<path d="${frameGeom.path}"/></g>`
  const promptPaths = prompt
    .map(
      (part) =>
        `<path d="${part.path}" stroke-width="${part.strokeWidth}"` +
        `${part.linecap ? ` stroke-linecap="${part.linecap}"` : ''}` +
        `${part.linejoin ? ` stroke-linejoin="${part.linejoin}"` : ''}/>`
    )
    .join('')
  const promptGroup = `<g id="prompt" fill="none" stroke="${accent}">${promptPaths}</g>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBox[2]}" height="${viewBox[3]}" viewBox="${viewBox.join(' ')}" fill="none" role="img" aria-label="Inkstone · 砚">` +
    `<title>Inkstone · 砚</title>` +
    `<desc>开口石框 + &gt;_。几何与配色来自 resources/brand/inkstone-design.json；生成物，请勿手改。</desc>` +
    frameLine +
    promptGroup +
    `</svg>`
  )
}

/** 生成渲染端可直接 import 的几何常量模块（由 build-icon 写入）。 */
export function renderGeometryModule(design, hash) {
  const { viewBox, frame, prompt } = design.geometry
  const lines = [
    '/* 由 scripts/build-icon.mjs 从 resources/brand/inkstone-design.json 生成，请勿手改。 */',
    `/* source-hash: ${hash} */`,
    '',
    `export const BRAND_VIEW_BOX = '${viewBox.join(' ')}'`,
    '',
    'export const BRAND_FRAME = {',
    `  path: ${JSON.stringify(frame.path)},`,
    `  strokeWidth: ${frame.strokeWidth},`,
    `  linecap: ${JSON.stringify(frame.linecap)},`,
    `  linejoin: ${JSON.stringify(frame.linejoin)}`,
    '} as const',
    '',
    'export const BRAND_PROMPT = [',
    ...prompt.map(
      (part) =>
        `  { path: ${JSON.stringify(part.path)}, strokeWidth: ${part.strokeWidth}, linecap: ${JSON.stringify(part.linecap)}, linejoin: ${JSON.stringify(part.linejoin)} },`
    ),
    '] as const',
    ''
  ]
  return lines.join('\n')
}

export { SEGMENT_ORDER }
