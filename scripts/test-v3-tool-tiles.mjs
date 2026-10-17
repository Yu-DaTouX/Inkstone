#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sources = [
  'src/renderer/src/state/split-view.ts',
  'src/renderer/src/app/SideBySideLayout.ts',
  'src/renderer/src/features/workbench/tool-tile-refs.ts',
  'src/renderer/src/features/sidebar/session-drag.ts'
].map((file) => resolve(ROOT, file))

const result = await build({
  stdin: {
    contents: sources.map((file) => `export * from ${JSON.stringify(file)}`).join('\n'),
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const {
  TILE_TOOLS,
  canTileTool,
  collapsedPanes,
  isAuxTile,
  isSessionTile,
  moveSplitTile,
  nearestSessionOf,
  placeInSplit,
  reconcileSplit,
  removeSplitTile,
  roomForAnotherTile,
  TOOL_TILE_MIN_WIDTH,
  tileCapacity,
  fitToolTiles,
  fitPaneTiles,
  dropZonesFor,
  sessionTiles,
  subagentTileRef,
  toolTabOf,
  toolTileIndex,
  toolTileRef,
  useSplitView,
  visibleToolTiles
} = mod

const report = { pass: 0, fail: 0 }
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}
function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${pass ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  return pass
}

const A = { sessionId: 'sa', path: 'C:/p/a.jsonl', uid: 'ta' }
const B = { sessionId: 'sb', path: 'C:/p/b.jsonl', uid: 'tb' }
const C = { sessionId: 'sc', path: 'C:/p/c.jsonl', uid: 'tc' }
const TERM = { ...toolTileRef('terminal'), uid: 'tt' }
const FILES = { ...toolTileRef('files'), uid: 'tf' }
const SUB = { ...subagentTileRef('r1'), uid: 'tr' }
const order = (split) => split?.tiles.map((t) => toolTabOf(t) ?? t.sessionId).join(',')

group('工具磁贴身份')
ok(toolTileRef('terminal').sessionId === 'tool:terminal', '工具磁贴 id 带 tool: 前缀')
ok(toolTabOf(TERM) === 'terminal' && toolTabOf(A) === null && toolTabOf(SUB) === null, '能从磁贴还原工具，会话与子代理列不算工具')
ok(toolTabOf({ sessionId: 'tool:quota' }) === null, '不在可磁贴清单里的工具不认')
ok(TILE_TOOLS.join(',') === 'changes,terminal,files,browser,preview,logs,branch', '可做磁贴的是工具栏里的 7 个工具')
ok(canTileTool('preview') && !canTileTool('context') && !canTileTool('quota'), '上下文、额度归会话栏，不做磁贴')
ok(isAuxTile(TERM) && isAuxTile(SUB) && !isAuxTile(A) && !isAuxTile({ path: 'C:/x.jsonl' }), '工具与子代理是辅助列，会话不是')
ok(!isSessionTile(TERM) && isSessionTile(A), '工具磁贴不算会话')
ok(sessionTiles([A, TERM, SUB, B]).length === 2, '会话可见性只收会话列')

group('打开工具磁贴')
let sp = placeInSplit(null, TERM, A)
ok(order(sp) === 'sa,terminal' && sp.live === 0, '单会话打开：会话在左、工具在右，焦点留在会话')
sp = placeInSplit({ tiles: [A, B], live: 1 }, FILES, B, 2)
ok(order(sp) === 'sa,sb,files' && sp.live === 1, '分屏时放到焦点会话右侧')
sp = placeInSplit({ tiles: [A, TERM], live: 0 }, TERM, A, 0)
ok(order(sp) === 'terminal,sa' && sp.tiles.length === 2, '同一工具再次放置只挪位，不重复开')
ok(placeInSplit(null, TERM, null) === null, '没有当前会话时不开工具磁贴')
const withTool = { tiles: [A, TERM], live: 0 }
const swapped = reconcileSplit(withTool, C)
ok(order(swapped) === 'sc,terminal' && swapped.live === 0, '焦点会话切换时只换会话列，工具磁贴保留')

group('可见的工具磁贴')
ok(visibleToolTiles({ tiles: [A, TERM, FILES], live: 0 }, false).join(',') === 'terminal,files', '宽屏列出全部工具磁贴')
ok(visibleToolTiles({ tiles: [A, TERM], live: 0 }, true).length === 0, '窄屏不显示工具磁贴（工具回到工具栏）')
ok(visibleToolTiles(null, false).length === 0, '没分屏时没有工具磁贴')
ok(TOOL_TILE_MIN_WIDTH === 280, '工具磁贴最小宽 280')
ok(roomForAnotherTile(560, 0) && roomForAnotherTile(560, 1), '单会话 560 宽可以再并排一块')
ok(!roomForAnotherTile(566, 2), '两列时 566 宽放不下第三块')
ok(roomForAnotherTile(986, 2) && !roomForAnotherTile(986, 3), '986 宽最多三列')
ok(tileCapacity(566) === 2 && tileCapacity(986) === 3 && tileCapacity(100) === 1, '容量按每列 280 取整，至少一列')
ok(tileCapacity(0) === Infinity, '还没量到宽度时不限制')
ok(fitToolTiles([A, TERM, FILES], 3).length === 3, '放得下时全部显示')
ok(order({ tiles: fitToolTiles([A, TERM, FILES], 2) }) === 'sa,terminal', '放不下时先藏最右边的工具磁贴')
ok(order({ tiles: fitToolTiles([A, TERM, B], 2) }) === 'sa,sb', '会话列不因宽度隐藏，只藏工具')
ok(order({ tiles: fitToolTiles([A, B, TERM], 1) }) === 'sa,sb', '会话本身超出容量时工具全部收回')
const fitted = fitPaneTiles({ tiles: [TERM, FILES, A], live: 2 }, 2)
ok(order(fitted) === 'terminal,sa' && fitted.live === 1, '隐藏工具后焦点列序号随之换算')
const sameLayout = { tiles: [A, TERM], live: 0 }
ok(fitPaneTiles(sameLayout, 5) === sameLayout && fitPaneTiles(null, 2) === null, '无需隐藏时原样返回')
const slotted = dropZonesFor(null, [
  { left: 0, top: 0, width: 300, height: 400, slot: 0 },
  { left: 300, top: 0, width: 300, height: 400, slot: 2 }
])
ok(slotted.map((zone) => zone.at).join(',') === '0,1,2,3', '落点序号按分屏序号给出（跳过隐藏列）')
ok(toolTileIndex({ tiles: [A, B, TERM], live: 0 }, 'terminal') === 2 && toolTileIndex(null, 'terminal') === -1, '按工具找到列下标')
const narrowed = collapsedPanes({ tiles: [TERM, A], live: 1 }, true)
ok(narrowed.tiles.length === 1 && narrowed.tiles[0] === A, '窄屏只留焦点会话')

group('关闭列时焦点不落到工具上')
ok(nearestSessionOf([A, B, TERM], 1) === 0, '右邻是工具时找左边的会话')
ok(nearestSessionOf([A, TERM, B], 0) === 2, '跳过工具找右边的会话')
ok(nearestSessionOf([A, TERM], 0) === -1, '没有别的会话时返回 -1')
let rm = removeSplitTile({ tiles: [A, B, TERM], live: 1 }, 1)
ok(order(rm) === 'sa,terminal' && rm.live === 0, '关焦点会话：焦点落到另一条会话而不是工具')
rm = removeSplitTile({ tiles: [A, TERM, FILES], live: 0 }, 0)
ok(rm === null, '关掉最后一条会话：退出分屏，工具回到工具栏')
rm = removeSplitTile({ tiles: [A, TERM, B], live: 0 }, 0)
ok(order(rm) === 'terminal,sb' && rm.live === 1, '关最左会话：焦点跨过工具到右边会话')
rm = removeSplitTile({ tiles: [A, TERM, B], live: 2 }, 1)
ok(order(rm) === 'sa,sb' && rm.live === 1, '关工具磁贴：焦点跟着会话前移')
rm = removeSplitTile({ tiles: [A, B, C], live: 1 }, 1)
ok(order(rm) === 'sa,sc' && rm.live === 1, '只有会话时仍优先去右邻')
rm = removeSplitTile({ tiles: [A, B, C], live: 2 }, 2)
ok(rm.live === 1, '最右的焦点关掉后去左邻')

group('拖动换位')
const base = { tiles: [A, TERM, B], live: 2 }
let mv = moveSplitTile(base, 1, 0)
ok(order(mv) === 'terminal,sa,sb' && mv.live === 2, '工具挪到最左，焦点跟着会话')
mv = moveSplitTile(base, 0, 3)
ok(order(mv) === 'terminal,sb,sa' && mv.live === 1, '会话挪到最右，焦点下标随之更新')
mv = moveSplitTile(base, 2, 0)
ok(order(mv) === 'sb,sa,terminal' && mv.live === 0, '焦点会话自己挪位置')
ok(moveSplitTile(base, 1, 1) === base && moveSplitTile(base, 1, 2) === base, '落在原位两侧：不变（同一对象）')
ok(moveSplitTile(base, 0, -5) === base, '越界落点按最左处理：已在最左则不变')
ok(order(moveSplitTile(base, 0, 99)) === 'terminal,sb,sa', '越界落点按最右处理')
ok(moveSplitTile(base, 7, 0) === base, '无效来源不变')
ok(moveSplitTile(base, 1, 3).tiles[2].uid === 'tt', '换位保留列编号（宽度份额跟着走）')

useSplitView.getState().close()
useSplitView.getState().open(TERM, A)
useSplitView.getState().open(B, A)
ok(order(useSplitView.getState().split) === 'sa,terminal,sb', 'store：会话、工具、会话三列')
useSplitView.getState().setWeights({ tt: 2 })
useSplitView.getState().move(1, 3)
ok(order(useSplitView.getState().split) === 'sa,sb,terminal' && useSplitView.getState().split.live === 0, 'store.move：换位且焦点不变')
ok(useSplitView.getState().weights.tt === 2, 'store.move：宽度份额保留')
useSplitView.getState().move(0, 0)
ok(order(useSplitView.getState().split) === 'sa,sb,terminal', 'store.move：原位不动')
useSplitView.getState().close()

process.stdout.write(`\n${report.fail ? '✗' : '✓'} 工具磁贴：通过 ${report.pass}，失败 ${report.fail}\n`)
process.exitCode = report.fail ? 1 : 0
