#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  }
}

async function loadTs(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const view = await loadTs('../src/renderer/src/state/split-view.ts')
const drop = await loadTs('../src/renderer/src/features/split/split-drop-model.ts')
const nav = await loadTs('../src/renderer/src/features/split/split-nav.ts')
const persist = await loadTs('../src/renderer/src/features/split/split-persist.ts')

const s = (id, extra = {}) => ({ sessionId: id, path: `/s/${id}.jsonl`, uid: `u-${id}`, ...extra })
const ids = (tiles) => tiles.map((tile) => `${tile.sessionId}${tile.below ? '↓' : ''}`).join(',')

console.log('网格：上下两行')
{
  const tiles = [s('a'), s('b', { below: true }), s('c'), s('d', { below: true }), s('e', { below: true })]
  const normalized = view.normalizeSplitTiles(tiles)
  ok(ids(normalized) === 'a,b↓,c,d↓,e', '一列最多两块，多出的下方块自己成一列', ids(normalized))
  ok(JSON.stringify(view.splitColumns(normalized)) === '[[0,1],[2,3],[4]]', '按列分组', view.splitColumns(normalized))
  ok(ids(view.normalizeSplitTiles([s('a', { below: true }), s('b')])) === 'a,b', '第一块不能在下方')
  const same = [s('a'), s('b')]
  ok(view.normalizeSplitTiles(same) === same, '已合法时原样返回（不触发重渲染）')

  const split = { tiles: [s('a'), s('b', { below: true }), s('c')], live: 2 }
  const removed = view.removeSplitTile(split, 0)
  ok(ids(removed.tiles) === 'b,c' && removed.live === 1, '关掉上方块：下方块升到上方，活动块索引跟着移', [ids(removed.tiles), removed.live])
  const moved = view.moveSplitTile(split, 1, 3)
  ok(ids(moved.tiles) === 'a,c,b' && moved.live === 1, '移动下方块：变成独立一列', [ids(moved.tiles), moved.live])
  const placed = view.placeInSplit(split, s('x'), s('a'), 1)
  ok(ids(placed.tiles) === 'a,b↓,x,c', '按插入位插入时不拆开一列', ids(placed.tiles))
  const reconciled = view.reconcileSplit({ tiles: [s('a'), s('b', { below: true })], live: 1 }, { sessionId: 'z', path: '/s/z.jsonl' })
  ok(ids(reconciled.tiles) === 'a,z↓', '活动块换会话时保留上下位置', ids(reconciled.tiles))
}

console.log('落点吸附（与参考 sessionDropCell 一致）')
const host = { left: 300, top: 50, width: 1000, height: 800 }
const geometry1 = { host, columns: [host], rowSplit: 0.5 }
const ctx1 = drop.dropContextFor(null, s('a'), s('x'), host.width)
{
  ok(ctx1.maxColumns === 2 && ctx1.canGrow && ctx1.canOpenLeft, '1000px 宽可放 2 列', ctx1)
  ok(drop.sessionDropTarget(ctx1, geometry1, 1200, 100)?.kind === 'right', '右半边：右侧新列')
  ok(drop.sessionDropTarget(ctx1, geometry1, 1200, 700)?.kind === 'right', '右半边下部也是右侧新列（先判列再判行）')
  const below = drop.sessionDropTarget(ctx1, geometry1, 500, 700)
  ok(below?.kind === 'below' && below.col === 0, '左半下部：下方新块', below)
  ok(drop.sessionDropTarget(ctx1, geometry1, 320, 100)?.kind === 'left', '左上 16px 之后、1/3 之前：左侧新列')
  ok(drop.sessionDropTarget(ctx1, geometry1, 310, 100) === null, '贴着左边 16px 内不吸附')
  ok(drop.sessionDropTarget(ctx1, geometry1, 700, 100) === null, '主块上半中间：无落点（显示默认提示）')
  ok(drop.sessionDropTarget(ctx1, geometry1, 200, 100) === null, '会话区外：无落点')
  const narrow = drop.dropContextFor(null, s('a'), s('x'), 600)
  ok(narrow.maxColumns === 1 && drop.sessionDropTarget(narrow, { ...geometry1, host: { ...host, width: 600 }, columns: [{ ...host, width: 600 }] }, 800, 100) === null, '窄于 720px：右半不再给新列')
  const shown = drop.dropContextFor(null, s('a'), s('a'), host.width)
  ok(!shown.canOpenLeft, '已显示的会话不能放到左侧')
}

const split3 = { tiles: [s('a'), s('b'), s('c', { below: true })], live: 0 }
const cols3 = [
  { left: 300, top: 50, width: 500, height: 800 },
  { left: 800, top: 50, width: 500, height: 800 }
]
const geometry3 = { host, columns: cols3, rowSplit: 0.5 }
const ctx3 = drop.dropContextFor(split3, s('a'), s('x'), host.width)
{
  const top = drop.sessionDropTarget(ctx3, geometry3, 1000, 200)
  ok(top?.kind === 'replace' && top.index === 1 && top.row === 0, '第二列上半：替换上方块', top)
  const bottom = drop.sessionDropTarget(ctx3, geometry3, 1000, 700)
  ok(bottom?.kind === 'replace' && bottom.index === 2 && bottom.row === 1, '第二列下半：替换下方块', bottom)
  const under = drop.sessionDropTarget(ctx3, geometry3, 500, 700)
  ok(under?.kind === 'below' && under.col === 0, '第一列下半：放到主块下方', under)
  ok(drop.sessionDropTarget(ctx3, geometry3, 1250, 200)?.kind === 'replace', '列数已满：右半不再给新列')
}

console.log('默认提示与浮层框')
{
  ok(drop.defaultDropTarget(ctx1)?.kind === 'right', '有空列：默认右侧新列')
  const full = drop.defaultDropTarget(ctx3)
  ok(full?.kind === 'below' && full.col === 0, '列满：默认第一列下方', full)
  const crowded = { ...ctx3, canGrow: false }
  const replace = drop.defaultDropTarget(crowded)
  ok(replace?.kind === 'replace' && replace.index === 2, '块数满：默认替换最后一个会话块', replace)

  const hint = drop.dropBadge(null, ctx1, geometry1)
  ok(hint.hint && hint.label === 'split', '无落点：默认目标变暗提示，文案「分屏」', hint)
  ok(hint.box.left === 300 + 500 + 8 && hint.box.width === 500 - 16 && hint.box.top === 58 && hint.box.height === 800 - 16, '右侧新列预览宽 = 宿主 / (列数 + 1)，四周 8px 内缩', hint.box)
  const left = drop.dropBadge({ kind: 'left' }, ctx1, geometry1)
  ok(left.box.left === 308 && left.box.width === 484 && !left.hint, '左侧新列预览在最左', left.box)
  const under = drop.dropBadge({ kind: 'below', col: 0 }, ctx1, geometry1)
  ok(under.box.top === 50 + 400 + 8 && under.box.height === 400 - 16, '下方新块预览占下半', under.box)
  const here = drop.dropBadge({ kind: 'replace', index: 1, col: 1, row: 0 }, ctx3, geometry3)
  ok(here.label === 'here' && here.box.left === 808 && here.box.height === 400 - 16, '替换上方块：文案「在此打开」，只框上半', here)
  const full2 = drop.dropBadge({ kind: 'replace', index: 1, col: 1, row: 0 }, drop.dropContextFor({ tiles: [s('a'), s('b')], live: 0 }, s('a'), s('x'), 1000), geometry3)
  ok(full2.box.height === 800 - 16, '替换单块列：框整列', full2.box)
  ok(drop.sameDropTarget({ kind: 'below', col: 1 }, { kind: 'below', col: 1 }) && !drop.sameDropTarget({ kind: 'below', col: 0 }, { kind: 'below', col: 1 }), '落点相等判断')
}

console.log('松手后的布局')
{
  const right = drop.applySessionDrop(null, { kind: 'right' }, s('x'), s('a'))
  ok(ids(right.tiles) === 'a,x' && right.live === 1, '右侧：新会话成为活动块（与参考一致）', [ids(right.tiles), right.live])
  const left = drop.applySessionDrop(null, { kind: 'left' }, s('x'), s('a'))
  ok(ids(left.tiles) === 'x,a' && left.live === 0, '左侧：插到最左')
  const below = drop.applySessionDrop(null, { kind: 'below', col: 0 }, s('x'), s('a'))
  ok(ids(below.tiles) === 'a,x↓' && below.live === 1, '下方：同列下半', ids(below.tiles))
  const replaced = drop.applySessionDrop(split3, { kind: 'replace', index: 2, col: 1, row: 1 }, s('x'), s('a'))
  ok(ids(replaced.tiles) === 'a,b,x↓' && replaced.live === 2, '替换：保留下方位置', ids(replaced.tiles))
  const again = drop.applySessionDrop(split3, { kind: 'right' }, s('b'), s('a'))
  ok(ids(again.tiles) === ids(split3.tiles) && again.live === 1, '已显示的会话只取得焦点')
  ok(drop.applySessionDrop(null, { kind: 'right' }, s('x'), null) === null, '没有当前会话时不建分屏')
}

console.log('分屏块拖动（与参考 dropZone / paneDrop 一致）')
{
  ok(drop.SESSION_DRAG_THRESHOLD === 4, '起拖阈值 4px（侧栏会话、分屏块、工作区面板共用）')
  const two = [s('a'), s('b')]
  const cols2 = [
    { left: 300, top: 50, width: 500, height: 800 },
    { left: 800, top: 50, width: 500, height: 800 }
  ]
  const zone = (x, y, cols = cols2, rowSplit = 0.5) => drop.paneDropZone(cols, rowSplit, x, y)
  const z1 = zone(1100, 450)
  ok(z1.col === 1 && z1.zone === 'swap' && z1.band === 'right' && !z1.edge, '右列中部：交换区，处在右侧边带但不在边缘 1/4', z1)
  ok(zone(1250, 450).edge, '右列最外 1/4：边缘')
  ok(zone(1000, 100).zone === 'above' && zone(1000, 800).zone === 'below', '上 1/3 叠到上方、下 1/3 叠到下方')
  const swap = drop.paneDropTarget(two, 0, z1, 3)
  ok(swap?.kind === 'swap' && swap.index === 1, '拖到另一块中部：交换', swap)
  const tall = [s('a'), s('b', { below: true }), s('c')]
  const edge = drop.paneDropTarget(tall, 1, zone(1250, 450), 3)
  ok(edge?.kind === 'column' && edge.at === 2, '拖到最右边缘：右侧新列', edge)
  const full = drop.paneDropTarget(tall, 1, zone(1250, 450), 2)
  ok(full?.kind === 'swap' && full.index === 2, '列数已满：边缘不再给新列，退回交换', full)
  ok(drop.paneDropTarget(two, 0, zone(1250, 450), 3)?.kind === 'swap', '两列时移到最右与交换结果相同：取交换')
  const under = drop.paneDropTarget(two, 0, zone(1000, 800), 3)
  ok(under?.kind === 'stack' && under.col === 1 && under.row === 1, '拖到另一列下 1/3：叠到下方', under)
  const over = drop.paneDropTarget(two, 0, zone(1000, 100), 3)
  ok(over?.kind === 'stack' && over.row === 0, '拖到另一列上 1/3：叠到上方', over)
  ok(drop.paneDropTarget(two, 0, zone(500, 450), 3) === null, '拖回自己身上：无落点')

  ok(ids(drop.applyPaneDrop(two, 0, { kind: 'swap', index: 1 })) === 'b,a', '交换两列')
  ok(ids(drop.applyPaneDrop(two, 0, { kind: 'stack', col: 1, row: 1 })) === 'b,a↓', '叠到下方：源列消失，并到目标列下半')
  ok(ids(drop.applyPaneDrop(two, 1, { kind: 'stack', col: 0, row: 0 })) === 'b,a↓', '叠到上方：原上方块降到下半')
  const stacked = [s('a'), s('b', { below: true }), s('c')]
  ok(ids(drop.applyPaneDrop(stacked, 1, { kind: 'column', at: 3 })) === 'a,c,b', '下方块拖到最右：拆成独立一列')
  ok(ids(drop.applyPaneDrop(stacked, 2, { kind: 'column', at: 0 })) === 'c,a,b↓', '拖到最左：插到第一列前')
  ok(ids(drop.applyPaneDrop(stacked, 2, { kind: 'swap', index: 1 })) === 'a,c↓,b', '与下方块交换：各自占对方的格子')
  ok(drop.applyPaneDrop(stacked, 1, { kind: 'stack', col: 0, row: 1 }) === null, '叠回本列：没有变化')
  ok(drop.applyPaneDrop(two, 0, { kind: 'column', at: 0 }) === null, '放回原位：没有变化')
  ok(drop.applyPaneDrop([s('a'), s('b', { below: true })], 1, { kind: 'column', at: 2 }, 1) === null, '超出列数上限：不成立')

  const four = [s('a'), s('b', { below: true }), s('c'), s('d', { below: true })]
  const ownTop = drop.paneDropTarget(four, 1, zone(500, 100), 3)
  ok(ownTop?.kind === 'swap' && ownTop.index === 0, '两块列的行内上下换位：下方块拖到上三分之一与上方块交换', ownTop)
  const ownBottom = drop.paneDropTarget(four, 0, zone(500, 780), 3)
  ok(ownBottom?.kind === 'swap' && ownBottom.index === 1, '上方块拖到本列下三分之一与下方块交换', ownBottom)
  ok(drop.paneDropTarget(four, 1, zone(500, 780), 3) === null, '下方块留在本列下方：没有落点')
  const foreignAbove = drop.paneDropTarget(four, 3, zone(400, 100), 3)
  ok(foreignAbove?.kind === 'swap' && foreignAbove.index === 0, '已有两块的列也能插到上方：与上方块交换而不是另开一列', foreignAbove)
  const foreignBelow = drop.paneDropTarget(four, 3, zone(400, 780), 3)
  ok(foreignBelow?.kind === 'swap' && foreignBelow.index === 1, '已有两块的列也能插到下方：与下方块交换', foreignBelow)
  ok(ids(drop.applyPaneDrop(four, 3, foreignAbove, 3)) === 'd,b↓,c,a↓', '插到上方后目标列仍是两块，源块占上方格', ids(drop.applyPaneDrop(four, 3, foreignAbove, 3)))

  const hint = drop.paneDropBadge(null, two, 1, { host, columns: cols2, rowSplit: 0.5 }, 3)
  ok(hint.hint && hint.label === 'swap' && hint.box.left === 308, '无落点：提示与第一列交换（变暗）', hint)
  const move = drop.paneDropBadge({ kind: 'stack', col: 1, row: 1 }, two, 0, { host, columns: cols2, rowSplit: 0.5 }, 3)
  ok(move.label === 'move' && !move.hint && move.box.top === 458 && move.box.height === 384, '叠到下方：文案「移到这里」，框下半', move)
  const right = drop.paneDropBadge({ kind: 'column', at: 2 }, two, 0, { host, columns: cols2, rowSplit: 0.5 }, 3)
  ok(Math.round(right.box.width) === Math.round(1000 / 3 - 16), '右侧新列：宽 = 宿主 / (列数 + 1)', right.box)
  const swapBox = drop.paneDropBox({ kind: 'swap', index: 1 }, stacked, { host, columns: cols2, rowSplit: 0.5 })
  ok(swapBox.top === 458 && swapBox.left === 308, '与下方块交换：只框下半', swapBox)
  ok(drop.samePaneTarget({ kind: 'column', at: 2 }, { kind: 'column', at: 2 }) && !drop.samePaneTarget({ kind: 'swap', index: 1 }, { kind: 'column', at: 1 }), '落点相等判断')
}

console.log('行高边界（两行都不低于 320px，15–85%）')
{
  const tall = drop.rowBoundsFor(1000)
  ok(Math.abs(tall.min - 0.32) < 1e-9 && Math.abs(tall.max - 0.68) < 1e-9, '1000px 高：32%–68%', tall)
  const short = drop.rowBoundsFor(600)
  ok(short.min === 0.5 && short.max === 0.5, '不足 640px：固定 50%', short)
  ok(Math.abs(drop.rowBoundsFor(4000).min - 0.15) < 1e-9, '很高时下限 15%')
  ok(Math.abs(drop.rowSplitFor(0.9, 1000) - 0.68) < 1e-9, '越界值夹到范围内')
  ok(view.clampRowSplit(Number.NaN) === 0.5 && view.clampRowSplit(0.99) === 0.85, '存储值夹在 15–85%')
}

console.log('焦点切换')
{
  const tiles = [s('a'), s('b', { below: true }), s('c')]
  ok(JSON.stringify(nav.splitReadingOrder(tiles)) === '[0,1,2]', '阅读顺序：按列、先上后下')
  ok(nav.nextSplitPane(tiles, 0, 1) === 1 && nav.nextSplitPane(tiles, 2, 1) === 0 && nav.nextSplitPane(tiles, 0, -1) === 2, '下一块/上一块循环')
  ok(nav.neighbourSplitPane(tiles, 0, 'down') === 1 && nav.neighbourSplitPane(tiles, 1, 'up') === 0, '上下')
  ok(nav.neighbourSplitPane(tiles, 1, 'right') === 2, '向右到下一列')
  ok(nav.neighbourSplitPane(tiles, 2, 'left') === 0, '向左落到同一行')
  ok(nav.neighbourSplitPane(tiles, 0, 'left') === null && nav.nextSplitPane([s('a')], 0, 1) === null, '没有可去的块时不消费按键')
}

console.log('持久化')
{
  const sessions = [
    { id: 'a', path: '/s/a.jsonl' },
    { id: 'b', path: '/s/b.jsonl' },
    { id: 'c', path: '/s/c.jsonl' },
    { id: 'old', path: '/s/old.jsonl', archivedAt: 1 }
  ]
  const tiles = [s('a'), s('b', { below: true }), s('c')]
  const saved = persist.serializeSplit({ split: { tiles, live: 2 }, weights: { 'u-a': 2, 'u-c': 1 }, rowSplit: 0.6 })
  ok(saved && saved.tiles.length === 3, '保存全部会话块', saved?.tiles)
  ok(saved.live === 2 && saved.rowSplit === 0.6, '保存活动块与行高', saved)
  ok(JSON.stringify(saved.weights) === '[2,1]', '列宽按列保存', saved.weights)
  const restored = persist.restoreSplit(JSON.parse(JSON.stringify(saved)), sessions)
  ok(restored && restored.split.tiles.length === 3 && restored.split.live === 2 && restored.rowSplit === 0.6, '原样恢复', restored)
  ok(Object.values(restored.weights).join(',') === '2,1', '恢复列宽')
  const pruned = persist.restoreSplit({ ...saved, tiles: [...saved.tiles, { sessionId: 'old', path: '/s/old.jsonl' }, { sessionId: 'gone' }] }, sessions)
  ok(pruned.split.tiles.length === 3, '过滤已归档和已删除的会话')
  ok(persist.restoreSplit({ ...saved, tiles: [{ sessionId: 'a' }, { sessionId: 'gone' }] }, sessions) === null, '剩不到两块不恢复')
  ok(persist.restoreSplit({ version: 99, tiles: saved.tiles }, sessions) === null && persist.restoreSplit('x', sessions) === null, '版本不符或格式错不恢复')
  ok(persist.serializeSplit({ split: null, weights: {}, rowSplit: 0.5 }) === null, '没有分屏时清掉存档')
  const store = new Map()
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  persist.writeSavedSplit(fake, saved)
  ok(JSON.stringify(persist.readSavedSplit(fake)) === JSON.stringify(saved), '写入后可读回')
  persist.writeSavedSplit(fake, null)
  ok(persist.readSavedSplit(fake) === null, '关闭分屏后清除')
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
