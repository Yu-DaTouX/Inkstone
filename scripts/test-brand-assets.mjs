import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import {
  DESIGN_PATH,
  GEOMETRY_OUT,
  MANIFEST_NAME,
  SVG_OUT,
  buildManifest,
  dedupedFrames,
  maskCells,
  readDesign,
  renderGeometryModule,
  renderSvg,
  trayFilePath,
  validateDesign
} from './lib/brand.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const abs = (rel) => `${root}${rel}`

const EXPECTED = {
  '16': {
    frame: [
      '................',
      '................',
      '..FFFFFFFFFF....',
      '..F.............',
      '..F.............',
      '..F.............',
      '..F.............',
      '..F.............',
      '..F..........F..',
      '..F..........F..',
      '..F..........F..',
      '..F..........F..',
      '..F..........F..',
      '..FFFFFFFFFFFF..',
      '................',
      '................'
    ],
    prompt: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '.....A..........',
      '......A.........',
      '.......A........',
      '......A.........',
      '.....A..........',
      '.........AAA....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    question: [
      '................',
      '................',
      '................',
      '................',
      '......QQQQ......',
      '.....QQ..QQ.....',
      '..........Q.....',
      '........QQ......',
      '.......QQ.......',
      '.......Q........',
      '................',
      '.......Q........',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  '24': {
    frame: [
      '........................',
      '........................',
      '........................',
      '....FFFFFFFFFFFFFF......',
      '...FFFFFFFFFFFFFFF......',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF...................',
      '...FF..............FF...',
      '...FF..............FF...',
      '...FF..............FF...',
      '...FF..............FF...',
      '...FF..............FF...',
      '...FF..............FF...',
      '...FFFFFFFFFFFFFFFFFF...',
      '....FFFFFFFFFFFFFFFF....',
      '........................',
      '........................',
      '........................'
    ],
    prompt: [
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........AA..............',
      '.........AA.............',
      '..........AA............',
      '...........AA...........',
      '..........AA............',
      '.........AA.............',
      '........AA....AAAA......',
      '..............AAAA......',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................'
    ],
    question: [
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '...........QQQQ.........',
      '..........QQ..QQ........',
      '.........QQ....QQ.......',
      '...............QQ.......',
      '...............QQ.......',
      '..............QQ........',
      '.............QQ.........',
      '............QQ..........',
      '........................',
      '............QQ..........',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................',
      '........................'
    ]
  }
}

function setOfRows(rows, marks) {
  const out = new Set()
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (marks.includes(row[x])) out.add(`${x},${y}`)
  })
  return out
}

function checkMasks(design) {
  const marks = { frame: 'F', prompt: 'A', question: 'Q' }
  for (const gridKey of ['16', '24']) {
    for (const layer of ['frame', 'prompt', 'question']) {
      const actual = maskCells(design, gridKey, layer)
      const expected = setOfRows(EXPECTED[gridKey][layer], marks[layer])
      assert.deepEqual([...actual].sort(), [...expected].sort(), `masks.${gridKey}.${layer} 与定稿不一致`)
    }
  }
}

function checkTimeline(design) {
  const running = dedupedFrames(design, 'running')
  const waiting = dedupedFrames(design, 'waiting')
  assert.equal(running.reduce((a, f) => a + f.durationMs, 0), 750, '运行周期必须是 750ms')
  assert.equal(waiting.reduce((a, f) => a + f.durationMs, 0), 1500, '等待周期必须是 1500ms')
  assert.deepEqual(design.animation.states.running.segmentsMs, { brightHold: 300, fadeDown: 125, darkHold: 200, fadeUp: 125 })
  assert.deepEqual(design.animation.states.waiting.segmentsMs, { brightHold: 600, fadeDown: 250, darkHold: 400, fadeUp: 250 })
  assert.equal(running[0].alpha255, 255, '亮停留 100%')
  assert.equal(running.find((f) => f.durationMs === 200).alpha255, 115, '暗停留 45%（115/255）')
  assert.equal(running.length, 12)
  assert.equal(waiting.length, 12)
  assert.equal(running[1].durationMs, 25, '运行原生帧长 25ms（不是 GIF 量化）')
  assert.equal(waiting[1].durationMs, 50, '等待原生帧长 50ms')
}

function checkGeneratedText(design, hash) {
  const svgPath = abs(SVG_OUT)
  if (existsSync(svgPath)) {
    assert.equal(readFileSync(svgPath, 'utf8'), renderSvg(design), `${SVG_OUT} 与真源不一致`)
    assert.match(readFileSync(svgPath, 'utf8'), /id="stone-frame"/)
    assert.match(readFileSync(svgPath, 'utf8'), /id="prompt"/)
    assert.match(readFileSync(svgPath, 'utf8'), /stroke="currentColor"/)
  }
  const geomPath = abs(GEOMETRY_OUT)
  if (existsSync(geomPath)) {
    assert.equal(readFileSync(geomPath, 'utf8'), renderGeometryModule(design, hash), `${GEOMETRY_OUT} 与真源不一致`)
  }
}

function decodePng(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'PNG 魔数')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  assert.equal(bitDepth, 8, '只支持 8bit PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  assert.ok(channels > 0, `不支持 PNG colorType ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  const filterBpp = channels
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const dst = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= filterBpp ? dst[x - filterBpp] : 0
      const up = prev[x]
      const upLeft = x >= filterBpp ? prev[x - filterBpp] : 0
      let value = src[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      dst[x] = value & 0xff
    }
  }
  return { width, height, channels, data: out }
}

function pixel(png, x, y) {
  const i = (y * png.width + x) * png.channels
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.channels === 4 ? png.data[i + 3] : 255]
}

function checkGeneratedAssets(design) {
  const manifestPath = abs(`build/tray/${MANIFEST_NAME}`)
  if (!existsSync(manifestPath)) {
    console.log('[跳过] 未找到 build/tray/manifest.json —— 先运行 npm run icon 再跑本检查。')
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const expected = buildManifest(design, readDesign(abs(DESIGN_PATH)).hash)
  assert.equal(manifest.sourceHash, expected.sourceHash, 'manifest.sourceHash 与真源不一致')
  assert.deepEqual(manifest.timelines, expected.timelines, 'manifest 时间线与真源不一致')

  const sizes = design.outputs.traySizes
  const grids = { 16: 16, 24: 24, 32: 16 }

  for (const theme of design.outputs.trayThemes) {
    for (const { px } of sizes) {
      for (const kind of ['static-idle', 'static-running', 'static-waiting']) {
        const rel = `build/tray/${trayFilePath(design, theme, px, 'idle', 0, kind)}`
        assert.ok(existsSync(abs(rel)), `缺静态托盘 ${rel}`)
        const png = decodePng(readFileSync(abs(rel)))
        assert.equal(png.width, px, `${rel} 宽度`)
        assert.equal(png.height, px, `${rel} 高度`)
      }

      for (const state of ['running', 'waiting']) {
        const grid = grids[px]
        const frameCells = [...maskCells(design, String(grid), 'frame')]
        const symbolCells = [...maskCells(design, String(grid), state === 'running' ? 'prompt' : 'question')]
        const count = dedupedFrames(design, state).length
        const pngs = []
        for (let i = 0; i < count; i += 1) {
          const rel = `build/tray/${trayFilePath(design, theme, px, state, i)}`
          assert.ok(existsSync(abs(rel)), `缺动画帧 ${rel}`)
          const png = decodePng(readFileSync(abs(rel)))
          assert.equal(png.width, px, `${rel} 宽度`)
          assert.equal(png.height, px, `${rel} 高度`)
          pngs.push({ rel, png })
        }
        const k = px / grid
        const toPx = (cell) => {
          const [x, y] = cell.split(',').map(Number)
          const x0 = Math.round(x * k)
          const y0 = Math.round(y * k)
          return { x0, y0, x1: Math.round((x + 1) * k), y1: Math.round((y + 1) * k) }
        }
        const sample = (png, cell) => {
          const box = toPx(cell)
          const colors = []
          for (let y = box.y0; y < box.y1; y += 1) for (let x = box.x0; x < box.x1; x += 1) colors.push(pixel(png, x, y).join(','))
          return colors
        }
        for (const cell of frameCells) {
          const first = sample(pngs[0].png, cell).join('|')
          for (const { rel, png } of pngs.slice(1)) assert.equal(sample(png, cell).join('|'), first, `${rel} 的石框像素与首帧不同`)
        }
        assert.equal(symbolCells.filter((cell) => frameCells.includes(cell)).length, 0, `${theme}/${px}/${state} 符号与石框相交`)
      }
    }
  }
  console.log('品牌生成物：SVG / 各 DPI 静态托盘 / 去重动画帧 / manifest 一致，石框逐帧不变、符号与框零相交。')
}

export function runBrandAssetTests() {
  const { design, hash } = readDesign(abs(DESIGN_PATH))
  validateDesign(design)
  checkMasks(design)
  checkTimeline(design)
  checkGeneratedText(design, hash)
  checkGeneratedAssets(design)
  console.log('brand assets：真源 / mask / 时间线 / 产物一致。')
}

runBrandAssetTests()
