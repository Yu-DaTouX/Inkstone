#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  entryPoints: [resolve(ROOT, 'src/renderer/src/app/tiles-width.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const {
  TILES_WIDTH_DEFAULT,
  TILES_WIDTH_MIN,
  TILES_WIDTH_MAX,
  TILES_WIDTH_KEY,
  clampTilesWidth,
  tilesWidthRoom,
  readTilesWidth,
  writeTilesWidth
} = mod

const report = { pass: 0, fail: 0 }
function check(name, fn) {
  try {
    fn()
    report.pass += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    report.fail += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
const memory = (seed) => {
  const map = new Map(Object.entries(seed ?? {}))
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)), map }
}

check('默认宽度与现有 token 一致，且在上下限内', () => {
  assert.equal(TILES_WIDTH_DEFAULT, 300)
  assert.ok(TILES_WIDTH_MIN <= TILES_WIDTH_DEFAULT && TILES_WIDTH_DEFAULT <= TILES_WIDTH_MAX)
})

check('clampTilesWidth：夹取到上下限并取整', () => {
  assert.equal(clampTilesWidth(100), TILES_WIDTH_MIN)
  assert.equal(clampTilesWidth(9999), TILES_WIDTH_MAX)
  assert.equal(clampTilesWidth(333.6), 334)
  assert.equal(clampTilesWidth(Number.NaN), TILES_WIDTH_DEFAULT)
})

check('clampTilesWidth：空间不足时上限收紧，但不低于下限', () => {
  assert.equal(clampTilesWidth(480, 340), 340)
  assert.equal(clampTilesWidth(480, 100), TILES_WIDTH_MIN)
  assert.equal(clampTilesWidth(Number.NaN, 280), 280)
})

check('tilesWidthRoom：消息列最小宽与间隙之外的剩余宽度', () => {
  assert.equal(tilesWidthRoom(1000, 16, 520), 464)
  assert.equal(tilesWidthRoom(836, 16, 520), 300)
})

check('readTilesWidth：缺省、非法、越界值', () => {
  assert.equal(readTilesWidth(memory()), TILES_WIDTH_DEFAULT)
  assert.equal(readTilesWidth(memory({ [TILES_WIDTH_KEY]: 'abc' })), TILES_WIDTH_DEFAULT)
  assert.equal(readTilesWidth(memory({ [TILES_WIDTH_KEY]: '10' })), TILES_WIDTH_MIN)
  assert.equal(readTilesWidth(memory({ [TILES_WIDTH_KEY]: '5000' })), TILES_WIDTH_MAX)
  assert.equal(readTilesWidth(null), TILES_WIDTH_DEFAULT)
  assert.equal(readTilesWidth({ getItem: () => { throw new Error('blocked') } }), TILES_WIDTH_DEFAULT)
})

check('writeTilesWidth：持久化夹取后的值并可读回；存储异常不抛', () => {
  const store = memory()
  writeTilesWidth(store, 400)
  assert.equal(store.map.get(TILES_WIDTH_KEY), '400')
  assert.equal(readTilesWidth(store), 400)
  writeTilesWidth(store, 1)
  assert.equal(readTilesWidth(store), TILES_WIDTH_MIN)
  writeTilesWidth(null, 400)
  writeTilesWidth({ setItem: () => { throw new Error('quota') } }, 400)
})

console.log(`\nv3 磁贴宽度：${report.pass} 通过 / ${report.fail} 失败`)
if (report.fail > 0) process.exit(1)
