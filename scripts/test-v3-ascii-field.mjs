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

const model = await loadTs('../src/renderer/src/features/ambient/ascii-field-model.ts')
const W = 1280
const H = 720

{
  const a = model.fieldValue(0.3, 0.7, 1.2, 42)
  assert.equal(a, model.fieldValue(0.3, 0.7, 1.2, 42), '同输入必得同输出')
  assert.ok(a >= 0 && a <= 1, '值场落在 [0,1]')
  assert.notEqual(a, model.fieldValue(0.3, 0.7, 1.2, 43), '换种子换画面')
  assert.notEqual(a, model.fieldValue(0.3, 0.7, 1.5, 42), '推进时间换画面')
  const n1 = model.valueNoise3(1.2, 3.4, 5.6, 7)
  assert.equal(n1, model.valueNoise3(1.2, 3.4, 5.6, 7))
  assert.ok(n1 >= 0 && n1 < 1, 'value noise 落在 [0,1)')
  assert.equal(model.valueNoise2(0.5, 0.5, 9), model.valueNoise3(0.5, 0.5, 0, 9), '二维即 z=0')
  const f = model.fbm(0.4, 0.9, 0.1, 3)
  assert.ok(f >= 0 && f < 1, '分形噪声归一化到 [0,1)')
}

{
  assert.deepEqual(model.computeGrid(1920, 1080, 13), { cols: Math.ceil(1920 / 13), rows: Math.ceil(1080 / 13), cell: 13 })
  assert.deepEqual(model.computeGrid(0, 0, 13), { cols: 0, rows: 0, cell: 13 }, '零尺寸不产生负列')
  assert.equal(model.computeGrid(100, 100, 0).cell, 6, '单元边长有下限，防退化')
  assert.ok(model.CELL_SIZE >= 12 && model.CELL_SIZE <= 14, '单元边长落在 12–14')
}

{
  for (let i = 0; i <= 40; i++) {
    const v = i / 40
    const a = model.cellAlpha(v)
    const band = model.inkBand(v)
    if (v <= model.INK_LOW) {
      assert.equal(a, 0, `碎墨阈值以下不画（v=${v}）`)
      assert.equal(band, 0)
    } else {
      assert.ok(a >= model.MIN_ALPHA - 1e-9 && a <= model.MAX_ALPHA + 1e-9, `透明度在下限与上限之间（v=${v}）`)
      assert.equal(band, v > model.INK_CORE ? 2 : 1)
    }
  }
  assert.ok(model.cellAlpha(model.INK_CORE - 0.001) < model.CORE_ALPHA, '碎墨比墨芯淡')
  assert.ok(model.cellAlpha(0.8) > model.cellAlpha(0.6), '墨越浓越深')
  assert.equal(/[一-鿿]/.test(model.CHARSET), false, '字符集不含中文')
  assert.equal(/\s/.test(model.CHARSET), false, '字符集不含空白')
  assert.ok(/[A-Za-z]/.test(model.CORE) && /[0-9]/.test(model.CORE), '墨芯是字母数字')
  assert.ok(!/[A-Za-z0-9]/.test(model.DUST), '碎墨只用标点')
  for (let k = 0; k < 50; k++) {
    const dust = model.pickGlyph(1, k, 3, 7, 1337)
    const core = model.pickGlyph(2, k, 3, 7, 1337)
    assert.ok(dust >= 0 && dust < model.DUST.length, '碎墨字形取自 DUST')
    assert.ok(core >= model.DUST.length && core < model.CHARSET.length, '墨芯字形取自 CORE')
  }
}

{
  const zone = [{ x: 100, y: 100, rx: 50, ry: 50, feather: 0.5 }]
  assert.equal(model.maskFactor(100, 100, zone), 0, '区内全清')
  assert.equal(model.maskFactor(200, 100, zone), 1, '区外不衰减')
  const mid = model.maskFactor(100 + 50 * 1.25, 100, zone)
  assert.ok(mid > 0 && mid < 1, '边缘 smoothstep 过渡')
  const zones = model.defaultClearZones(1000, 700)
  assert.equal(model.maskFactor(500, 700 * 0.46, zones), 0, '兜底中心镂空')
  assert.equal(model.maskFactor(0, 0, zones), 1, '角落不受影响')
  const text = model.textClearZone({ left: 100, top: 100, width: 200, height: 40 }, 20)
  assert.equal(model.maskFactor(200, 120, [text]), 0, '文字中心全清')
  assert.ok(text.rx === 120 && text.ry === 40, '镂空只比文字多一圈边距')
  assert.equal(model.maskFactor(100 - 15, 100 - 15, [text]), 0, '矩形镂空盖住文字块四角')
  assert.equal(model.maskFactor(400, 300, [text]), 1, '矩形镂空羽化之外不受影响')
  const f = model.computeFieldFrame({ width: W, height: H, time: 4, zones: [text] })
  assert.equal(f.alpha[Math.floor(120 / f.cell) * f.cols + Math.floor(200 / f.cell)], 0, '镂空处不画')
}

{
  const input = { width: 1920, height: 1080, cell: model.CELL_SIZE, seed: model.FIELD_SEED }
  let frame = null
  for (let i = 0; i < 8; i++) frame = model.computeFieldFrame({ ...input, time: i * 0.033, tick: i }, frame)
  const rounds = 30
  let sink = 0
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) {
    frame = model.computeFieldFrame({ ...input, time: 1 + i * 0.033, tick: 8 + i }, frame)
    sink += frame.visible
  }
  const frameAvg = (performance.now() - t0) / rounds
  assert.ok(sink > 0, '基准必须读取结果，避免被 JIT 消掉')
  console.log(`  1080p 单帧纯计算：${frameAvg.toFixed(2)} ms/帧（目标 < 4ms）`)
  assert.ok(frameAvg < 20, `单帧纯计算不应超过 20ms（实测 ${frameAvg.toFixed(2)}ms）`)
}

{
  const coverage = []
  for (let t = 0; t < 90; t += 3) {
    const f = model.computeFieldFrame({ width: W, height: H, time: t, zones: [] })
    coverage.push(f.visible / f.alpha.length)
  }
  const sorted = [...coverage].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  console.log(`  覆盖率 最低 / 中位 / 最高：${(sorted[0] * 100).toFixed(0)}% / ${(median * 100).toFixed(0)}% / ${(sorted.at(-1) * 100).toFixed(0)}%`)
  assert.ok(median > 0.35 && median < 0.75, `中位覆盖率在四到七成之间（实际 ${(median * 100).toFixed(1)}%）`)
  assert.ok(sorted.at(-1) - sorted[0] > 0.1, '覆盖率随时间明显浮动，不是恒定纹理')

  const f = model.computeFieldFrame({ width: W, height: H, time: 7, zones: [] })
  let bestEmpty = 0
  let bestCore = 0
  for (let r = 0; r < f.rows; r += 4) {
    let emptyRun = 0
    let coreRun = 0
    for (let c = 0; c < f.cols; c++) {
      const i = r * f.cols + c
      emptyRun = f.alpha[i] > 0 ? 0 : emptyRun + 1
      coreRun = f.band[i] === 2 && f.alpha[i] > 0 ? coreRun + 1 : 0
      bestEmpty = Math.max(bestEmpty, emptyRun)
      bestCore = Math.max(bestCore, coreRun)
    }
  }
  assert.ok(bestEmpty >= 8 && bestCore >= 8, `既有留白也有成片墨芯（空 ${bestEmpty} / 芯 ${bestCore}）`)

  const series = Array.from({ length: 40 }, (_, k) => model.fieldValue(0.6, 0.5, k * 0.5, model.FIELD_SEED))
  assert.ok(Math.max(...series) - Math.min(...series) > 0.08, '同一点的墨值随时间缓慢起伏')
}

{
  const counts = []
  for (let t = 0; t < 120; t += 0.5) counts.push(model.inkSources(t, model.FIELD_SEED, 16 / 9).drops.length)
  assert.ok(counts.some((n) => n > 0), '一段时间内会出现滴墨')
  assert.ok(new Set(counts).size >= 3, '同时存在的滴墨数在变化，节奏不固定')
  const births = []
  for (let k = 0; k < 60; k++) {
    if (model.hash3i(k, 0, 0, model.FIELD_SEED + 90) < model.DROP_CHANCE) births.push((k + model.hash3i(k, 1, 0, model.FIELD_SEED + 90)) * model.DROP_SLOT)
  }
  const gaps = births.slice(1).map((b, i) => b - births[i])
  const minGap = Math.min(...gaps)
  const maxGap = Math.max(...gaps)
  assert.ok(maxGap - minGap > 1.5, `滴墨间隔不定（${minGap.toFixed(2)}–${maxGap.toFixed(2)}s）`)
  const src = model.inkSources(10, model.FIELD_SEED, 16 / 9)
  assert.equal(src.plumes.length, model.PLUME_COUNT, '墨源个数固定')
  const later = model.inkSources(25, model.FIELD_SEED, 16 / 9)
  assert.ok(Math.hypot(src.plumes[0].x - later.plumes[0].x, src.plumes[0].y - later.plumes[0].y) > 0.02, '墨源会游走')
}

{
  assert.ok(model.edgeActivity(model.INK_CORE) > 0.99, '贴近墨芯阈值时边缘活跃度最高')
  assert.equal(model.edgeActivity(model.INK_CORE + 0.2), 0, '墨芯深处不活跃')
  const input = { width: W, height: H, zones: [] }
  let frame = null
  let changed = 0
  let stable = 0
  let edgeChanged = 0
  let edgeTotal = 0
  let deepChanged = 0
  let deepTotal = 0
  frame = model.computeFieldFrame({ ...input, time: 5, tick: 1 }, frame)
  for (let k = 2; k < 30; k++) {
    const before = Uint8Array.from(frame.glyph)
    const bandBefore = Uint8Array.from(frame.band)
    frame = model.computeFieldFrame({ ...input, time: 5, tick: k }, frame)
    for (let i = 0; i < frame.glyph.length; i++) {
      if (bandBefore[i] === 0 || frame.band[i] !== bandBefore[i]) continue
      const diff = frame.glyph[i] !== before[i]
      if (diff) changed++
      else stable++
      const act = model.edgeActivity(frame.value[i])
      if (act > 0.6) {
        edgeTotal++
        if (diff) edgeChanged++
      } else if (act === 0) {
        deepTotal++
        if (diff) deepChanged++
      }
    }
  }
  const rate = changed / (changed + stable)
  console.log(`  每帧换字比例：${(rate * 100).toFixed(2)}%（边缘 ${(edgeChanged / edgeTotal * 100).toFixed(1)}% / 深处 ${(deepChanged / deepTotal * 100).toFixed(2)}%）`)
  assert.ok(rate < 0.08, '相邻两帧绝大多数字形保持，不全屏闪烁')
  assert.ok(edgeTotal > 0 && deepTotal > 0, '既有边缘带也有墨芯深处')
  assert.ok(edgeChanged / edgeTotal > deepChanged / deepTotal * 3, '边缘换字明显比内部频繁')

  let a = null
  let b = null
  for (let k = 0; k < 4; k++) {
    a = model.computeFieldFrame({ ...input, time: 2 + k / 30, tick: k }, a)
    b = model.computeFieldFrame({ ...input, time: 2 + k / 30, tick: k }, b)
  }
  assert.deepEqual(Array.from(a.glyph), Array.from(b.glyph), '字形状态确定')
  assert.deepEqual(Array.from(a.alpha), Array.from(b.alpha), '透明度确定')
}

{
  assert.equal(model.alphaLevel(0), -1)
  assert.equal(model.alphaLevel(0.001), 0)
  assert.equal(model.alphaLevel(model.ALPHA_CEILING), model.ALPHA_LEVELS - 1, '上限落在最高一级')
  assert.ok(model.ALPHA_LEVELS >= 12, '透明度级数足够细，亮度变化不跳档')
  for (let i = 0; i < model.ALPHA_LEVELS; i++) {
    const a = model.levelAlpha(i)
    assert.ok(a > 0 && a <= model.ALPHA_CEILING + 1e-9)
    assert.equal(model.alphaLevel(a), i, '级别往返一致')
  }
  let acc = 0
  let vis = 0
  let maxAlpha = 0
  for (let t = 0; t < 60; t += 4) {
    const f = model.computeFieldFrame({ width: W, height: H, time: t, zones: [] })
    for (let i = 0; i < f.alpha.length; i++) {
      if (f.alpha[i] > 0) {
        vis++
        acc += f.accent[i]
        maxAlpha = Math.max(maxAlpha, f.alpha[i])
      }
    }
  }
  console.log(`  强调色占可见格：${(acc / vis * 100).toFixed(1)}%`)
  assert.ok(acc > 0 && acc / vis < 0.2, '有强调色区域，但不超过可见格的两成')
  assert.ok(maxAlpha <= model.ALPHA_CEILING + 1e-9, '单格透明度不超过上限')

  assert.deepEqual(model.stirPoint(1, 1, null, 0.2, 0), { x: 1, y: 1, k: 0 }, '无指针不搅动')
  assert.equal(model.stirPoint(5, 5, { x: 0, y: 0 }, 0.2, 0).k, 0, '远处不搅动')
  const near = model.stirPoint(0.05, 0, { x: 0, y: 0 }, 0.2, 0)
  assert.ok(near.k > 0 && Math.abs(Math.hypot(near.x, near.y) - 0.05) < 1e-9, '附近绕指针旋转（半径不变）')
  const still = model.computeFieldFrame({ width: W, height: H, time: 6, zones: [] })
  const stirred = model.computeFieldFrame({ width: W, height: H, time: 6, zones: [], mouse: { x: 640, y: 360 } })
  let diff = 0
  for (let i = 0; i < still.value.length; i++) diff += Math.abs(still.value[i] - stirred.value[i])
  assert.ok(diff > 1, '指针附近墨流被搅动')
}

{
  const base = { width: W, height: H, time: 6, zones: [] }
  const start = model.computeFieldFrame({ ...base, enter: 0 })
  assert.equal(start.visible, 0, '入场起点：一格都不显影')
  const mid = model.computeFieldFrame({ ...base, enter: 0.15 })
  const full = model.computeFieldFrame({ ...base, enter: 1 })
  const sumAlpha = (frame) => frame.alpha.reduce((sum, a) => sum + a, 0)
  assert.ok(sumAlpha(mid) > 0 && sumAlpha(mid) < sumAlpha(full), '入场途中整体透明度介于空与满之间')

  const anchor = { x: 160, y: 160 }
  const early = model.computeFieldFrame({ ...base, anchor, enter: 0.12 })
  assert.ok(sumAlpha(early) > 0, '入场淡入覆盖真实涟漪，不额外计算扩散波前')
  let nearVisible = 0
  for (let row = 0; row < 25; row++) for (let col = 0; col < 25; col++) nearVisible += early.alpha[row * early.cols + col] > 0 ? 1 : 0
  assert.ok(nearVisible > 0, '落点附近先显影')

  const reachBy = new Map()
  for (let row = 0; row < early.rows; row++) {
    for (let col = 0; col < early.cols; col++) {
      if (early.alpha[row * early.cols + col] <= 0) continue
      const dx = (col + 0.5) * early.cell - anchor.x
      const dy = (row + 0.5) * early.cell - anchor.y
      const sector = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12)
      reachBy.set(sector, Math.max(reachBy.get(sector) ?? 0, Math.hypot(dx, dy)))
    }
  }
  const reaches = [...reachBy.values()]
  assert.ok(reaches.length >= 3 && Math.max(...reaches) - Math.min(...reaches) > 60, '洇开边界参差，不是正圆')

  let accentMid = 0
  let accentFull = 0
  for (let i = 0; i < mid.accent.length; i++) {
    accentMid += mid.accent[i]
    accentFull += full.accent[i]
  }
  assert.ok(accentMid <= accentFull, '入场不增加强调色闪光')

  const exitHalf = model.computeFieldFrame({ ...base, exit: 0.85 })
  const exitDone = model.computeFieldFrame({ ...base, exit: 1 })
  assert.ok(sumAlpha(exitHalf) < sumAlpha(full), '退场只降低透明度，不执行收拢闪光')
  assert.equal(exitDone.visible, 0, '退场结束全部收回')

  const reach = model.maxReach(1000, 600, { x: 500, y: 300 })
  assert.equal(model.revealRadius(reach, 0, 0), 0)
  assert.equal(model.revealRadius(reach, 1, 0), reach)
  assert.equal(model.revealRadius(reach, 1, 1), 0)
  assert.ok(model.revealRadius(reach, 0.5, 0.5) <= model.revealRadius(reach, 0.5, 0), '入场途中被打断：取较小者平滑收回')
  assert.equal(model.frontStrength(100, 100, false), 0, '静置时没有边界提亮')
  assert.ok(model.frontStrength(100 - model.FRONT_WIDTH * 0.5, 100, true) > 0.99, '边界提亮峰值落在显影边缘内侧')
  assert.ok(model.ENTER_MS <= 500, '入场不超过半秒')
  assert.ok(model.EXIT_MS <= 180, '退场短于 180ms')
}

{
  const input = { width: W, height: H, time: 3, zones: [] }
  const f = model.computeFieldFrame(input)
  assert.equal(model.computeFieldFrame({ ...input, time: 3.5 }, f), f, '同尺寸复用帧缓冲，不每帧分配')
  assert.notEqual(model.computeFieldFrame({ ...input, width: 640 }, f), f, '尺寸变化时重新分配')
  const fresh = model.computeFieldFrame({ ...input, time: 3.5 })
  const recycled = model.computeFieldFrame({ ...input, time: 3.5 }, model.computeFieldFrame({ ...input, time: 9 }))
  assert.deepEqual(Array.from(recycled.alpha), Array.from(fresh.alpha), '复用缓冲不残留上一帧的透明度')
}

{
  assert.deepEqual(model.animationPolicy({ visible: true, focused: true, reducedMotion: false }), { active: true, fps: model.TARGET_FPS })
  assert.deepEqual(model.animationPolicy({ visible: true, focused: false, reducedMotion: false }), { active: false, fps: 0 })
  assert.deepEqual(model.animationPolicy({ visible: false, focused: true, reducedMotion: false }), { active: false, fps: 0 })
  assert.deepEqual(model.animationPolicy({ visible: true, focused: true, reducedMotion: true }), { active: false, fps: 0 })
  assert.equal(model.TARGET_FPS, 30, '聚焦目标 30fps')
  assert.equal(model.frameInterval(30), 1000 / 30)
  assert.equal(model.frameInterval(0), Number.POSITIVE_INFINITY)
  assert.equal(model.shouldDraw(1000, 1000, 30), false, '同一时刻不重复画')
  assert.equal(model.shouldDraw(1034, 1000, 30), true, '过一个间隔才画')
  for (const [hz, expect] of [[60, 2], [144, 5]]) {
    const period = 1000 / hz
    let last = Number.NEGATIVE_INFINITY
    const gaps = new Set()
    let prevTick = -1
    for (let tick = 0; tick < hz * 3; tick++) {
      const now = tick * period + (tick % 3 === 1 ? 0.6 : tick % 3 === 2 ? -0.6 : 0)
      if (model.shouldDraw(now, last, 30)) {
        if (prevTick >= 0) gaps.add(tick - prevTick)
        prevTick = tick
        last = now
      }
    }
    assert.deepEqual([...gaps], [expect], `${hz}Hz 落帧间隔恒为 ${expect} 拍（实际 ${[...gaps]}）`)
  }
  const still = model.computeFieldFrame({ width: W, height: H, time: model.STATIC_TIME, zones: [] })
  assert.ok(still.visible / still.alpha.length > 0.3, '减少动态时的静态画面完整（有墨团）')
}

{
  assert.equal(model.asciiBackgroundEnabled(undefined), true)
  assert.equal(model.asciiBackgroundEnabled(null), true)
  assert.equal(model.asciiBackgroundEnabled({}), true)
  assert.equal(model.asciiBackgroundEnabled({ asciiBackground: true }), true)
  assert.equal(model.asciiBackgroundEnabled({ asciiBackground: false }), false)
  assert.deepEqual(model.asciiBackgroundPatch(false), { asciiBackground: false })
  assert.deepEqual(model.asciiBackgroundPatch(true), { asciiBackground: true })
}

console.log('v3 主页「墨迹」ASCII 背景纯逻辑：确定性 / 网格 / 墨带 / 遮罩 / 帧预算 / 不规则 / 滴墨 / 字形状态 / 色调 / 搅动 / 洇开与收拢 / 复用 / 节拍 / 开关 全部通过')
