import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['mobile/src/windowLayout.ts'], bundle: true, platform: 'node', format: 'esm', write: false, external: ['react', 'react-native'] })
const { computeLayout } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const flat = { separating: false }
const cover = { x: 0, y: 34, width: 369, height: 840 }
assert.equal(computeLayout(cover, flat).mode, 'single', '封面屏单栏')

const inner = { x: 0, y: 33, width: 707, height: 770 }
const innerFlatFold = { separating: false, orientation: 'vertical', posture: 'flat', left: 353.5, right: 353.5, top: 0, bottom: 823 }
const innerFlat = computeLayout(inner, innerFlatFold)
assert.equal(innerFlat.mode, 'split')
assert.equal(innerFlat.side, 247, '平展内屏左栏占屏宽 35%')
assert.equal(computeLayout({ x: 0, y: 0, width: 600, height: 800 }, flat).side, 240, '左栏不小于 240')

const book = computeLayout(inner, { ...innerFlatFold, separating: true, posture: 'half-open' })
assert.equal(book.mode, 'book')
assert.equal(book.side, 348, '书本姿态左栏止于铰链前')
assert.equal(book.gap, 12, '零宽铰链补足 12dp 间隔')

const land = { x: 0, y: 33, width: 823, height: 650 }
const landFold = { separating: false, orientation: 'horizontal', posture: 'flat', left: 0, right: 823, top: 353.5, bottom: 353.5 }
const landFlat = computeLayout(land, landFold)
assert.equal(landFlat.mode, 'split', '横持平展仍是双栏')
assert.equal(landFlat.side, 288)

const table = computeLayout(land, { ...landFold, separating: true, posture: 'half-open' })
assert.equal(table.mode, 'tabletop')
assert.equal(table.top, 315, '桌面姿态上半止于铰链前')
assert.equal(table.topGap, 12)

const narrowWindow = { x: 0, y: 33, width: 350, height: 770 }
assert.equal(computeLayout(narrowWindow, innerFlatFold).mode, 'single', '分屏小窗按窗口宽度走单栏')
assert.equal(computeLayout({ x: 360, y: 33, width: 347, height: 770 }, { ...innerFlatFold, separating: true }).mode, 'single', '铰链不在窗口内时不进书本')

const tablet = computeLayout({ x: 0, y: 0, width: 1280, height: 800 }, flat)
assert.equal(tablet.mode, 'triple')
assert.equal(tablet.side, 420)
assert.equal(tablet.aside, 320)
assert.equal(computeLayout({ x: 0, y: 0, width: 900, height: 800 }, flat).mode, 'split', '主栏不足 400 时退回双栏')
assert.equal(computeLayout({ x: 0, y: 0, width: 1200, height: 800 }, flat).mode, 'triple')

assert.equal(computeLayout({ x: 0, y: 0, width: 0, height: 0 }, innerFlatFold).mode, 'single', '未测量时单栏')

console.log('mobile-window-layout: 19 assertions passed（Fold6 封面、内屏平展、书本、桌面、分屏与平板）')
