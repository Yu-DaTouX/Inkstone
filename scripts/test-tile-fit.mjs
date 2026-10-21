#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }
let currentGroup = null

function group(name) {
  currentGroup = name
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${extra}\n`)
  return pass
}

const outdir = await mkdtemp(join(tmpdir(), 'yan-tile-fit-'))
let mod
try {
  const entry = join(outdir, 'entry.ts')
  await writeFile(
    entry,
    `export * from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/tile-tree'))}'
export * from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/tile-fit'))}'
export * from '${posix(resolve(ROOT, 'src/renderer/src/state/tile-layouts'))}'
`
  )
  const outfile = join(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json']
  })
  const persisted = new Map()
  globalThis.localStorage = {
    getItem: (key) => (persisted.has(key) ? persisted.get(key) : null),
    setItem: (key, value) => { persisted.set(key, String(value)) },
    removeItem: (key) => { persisted.delete(key) },
    clear: () => persisted.clear()
  }
  mod = await import(pathToFileURL(outfile).href)
} catch (err) {
  process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(1)
}

const {
  CHAT_TILE_ID,
  CHAT_MIN_WIDTH_PX,
  TILE_GAP,
  TILE_MIN_WIDTH_PX,
  openPane,
  initialLayout,
  stackUnder,
  orderedTileIds,
  hasTile,
  layoutKey,
  layoutsEqual,
  chatOnlyLayout,
  layoutWithChat,
  chatFlexOf,
  flexChanges,
  rememberPaneFlex,
  tileLeaf,
  tileStack,
  columnLayout,
  withStackFlexes,
  parentOfTile,
  fitOpenedLayout,
  withChatMinimum,
  distributeFlex,
  measureWidths,
  PANE_LANE_INSET_PX,
  readPaneFlexByKind,
  sanitizePaneFlexByKind,
  rememberPaneFlexByKind,
  TILE_LAYOUTS_KEY
} = mod

const rootOf = (layout) => layout.root
const flexMap = (layout) => {
  const out = {}
  const walk = (node) => {
    if (node.kind === 'tile') out[node.tileId] = node.flex
    else node.children.forEach(walk)
  }
  walk(layout.root)
  return out
}
const widths = (layout, width) => measureWidths(layout, width)
const chatWidthOf = (layout, width) => widths(layout, width).get(CHAT_TILE_ID)

group('openPane：首个面板 row[chat 2, kind flex]')
{
  const files = initialLayout('files')
  ok(layoutKey(files) === 'row(tile#chat|tile#files)', '文件面板：根行是聊天 + 文件', layoutKey(files))
  ok(flexMap(files)[CHAT_TILE_ID] === 2 && flexMap(files).files === 3, '宽面板（文件）默认 2:3', flexMap(files))
  const changes = initialLayout('changes')
  ok(flexMap(changes).changes === 3, '宽面板（更改）默认 2:3', flexMap(changes))
  const terminal = initialLayout('terminal')
  ok(flexMap(terminal).terminal === 1, '非宽面板（终端）默认 2:1', flexMap(terminal))
  const browser = initialLayout('browser')
  ok(flexMap(browser).browser === 1, '非宽面板（浏览器）默认 2:1', flexMap(browser))
  const remembered = initialLayout('files', { files: 5 })
  ok(flexMap(remembered).files === 5, '有记忆时用记忆的比例', flexMap(remembered))
  const guarded = initialLayout('files', { files: 0 })
  ok(flexMap(guarded).files === 3, '记忆为 0 时退回默认宽面板比例', flexMap(guarded))
  ok(openPane(null, 'files', {}).root.direction === 'row' && hasTile(openPane(null, 'files', {}), CHAT_TILE_ID), '空布局开面板也带聊天块')
  const onlyChat = openPane(chatOnlyLayout(), 'files', { files: 4 })
  ok(layoutKey(onlyChat) === 'row(tile#chat|tile#files)' && flexMap(onlyChat).files === 4, '只有聊天时按首个面板开列', layoutKey(onlyChat))
}

group('openPane：后续面板叠在右列 / 追加根行')
{
  const one = openPane(null, 'files')
  const two = openPane(one, 'changes')
  ok(
    layoutKey(two) === 'row(tile#chat|column(tile#files|tile#changes))',
    '第 2 个面板：末位面板包成一列，新块叠在它下面',
    layoutKey(two)
  )
  ok(flexMap(two).files === 1 && flexMap(two).changes === 1, '包进列后两块的 flex 取 1:1', flexMap(two))
  const column = two.root.children[1]
  ok(Math.abs(column.flex - 3) < 1e-9, '外层列保留面板列的比例 3', column.flex)
  const three = openPane(two, 'terminal')
  ok(
    layoutKey(three) === 'row(tile#chat|column(tile#files|tile#changes)|tile#terminal)',
    '第 3 个面板：根行末位是列，追加到根行',
    layoutKey(three)
  )
  const fourth = openPane(three, 'browser')
  ok(
    layoutKey(fourth) === 'row(tile#chat|column(tile#files|tile#changes)|column(tile#terminal|tile#browser))',
    '第 4 个面板：末位终端包成一列，浏览器叠在它下面',
    layoutKey(fourth)
  )
  const again = openPane(three, 'changes')
  ok(again === three || layoutsEqual(again, three), '已在树里的面板再点不动结构', layoutKey(again))
  const sequential = openPane(openPane(openPane(chatOnlyLayout(), 'files'), 'changes'), 'terminal')
  ok(orderedTileIds(sequential).join() === [CHAT_TILE_ID, 'files', 'changes', 'terminal'].join(), '依次开三个面板的块顺序不变', orderedTileIds(sequential))
  const stacked = stackUnder(columnLayout([CHAT_TILE_ID, 'files']), 'files', 'changes')
  ok(layoutKey(stacked) === 'column(tile#chat|tile#files|tile#changes)', '末位的父级本来就是列时，直接往列尾叠', layoutKey(stacked))
}

group('fitOpenedLayout：按容器宽让位一次')
{
  const roomy = openPane(null, 'files')
  const same = fitOpenedLayout(roomy, 1100)
  ok(layoutsEqual(same, roomy), '宽容器下 2:3 不动（没有触发最小宽）', flexMap(same))
  const roomyChat = chatWidthOf(same, 1100)
  ok(roomyChat > CHAT_MIN_WIDTH_PX && roomyChat < 460, '聊天按 2:3 分到约 435px', roomyChat)
  const dragged = withStackFlexes(roomy, roomy.root.id, [0.5, 4])
  const squeezed = chatWidthOf(dragged, 1100)
  ok(squeezed < CHAT_MIN_WIDTH_PX, '前提：被拖窄的聊天低于 320', squeezed)
  const fitted = fitOpenedLayout(dragged, 1100)
  const lifted = chatWidthOf(fitted, 1100)
  ok(lifted >= CHAT_MIN_WIDTH_PX - 0.5, '让位把聊天抬到 320 以上', lifted)
  ok(chatWidthOf(roomy, 1100) === roomyChat, '原布局没被就地改写', flexMap(roomy))
  const two = openPane(openPane(null, 'files'), 'changes')
  const twoFitted = fitOpenedLayout(two, 1100)
  for (const id of ['files', 'changes']) {
    const width = widths(twoFitted, 1100).get(id)
    ok(width >= TILE_MIN_WIDTH_PX - 0.5, `${id} 让位后不低于 ${TILE_MIN_WIDTH_PX}`, width)
  }
  const narrow = fitOpenedLayout(two, 700)
  const narrowWidths = widths(narrow, 700)
  const lanes = [...narrowWidths.entries()].filter(([id]) => id !== CHAT_TILE_ID)
  ok(narrowWidths.get(CHAT_TILE_ID) > 0, '窄容器下聊天仍有宽', narrowWidths.get(CHAT_TILE_ID))
  ok(lanes.every(([, width]) => width > 0), '窄容器下各块不被压成 0', lanes)
  const chatOnly = fitOpenedLayout(chatOnlyLayout(), 900)
  ok(layoutsEqual(chatOnly, chatOnlyLayout()), '只有聊天时不做让位', layoutKey(chatOnly))
  ok(fitOpenedLayout(two, 0) === two, '容器宽未知时原样返回')
}

group('withChatMinimum：恢复时把被拖窄的聊天拉回 320')
{
  const base = openPane(null, 'files')
  const dragged = withStackFlexes(base, base.root.id, [0.8, 6])
  ok(chatWidthOf(dragged, 1100) < CHAT_MIN_WIDTH_PX, '前提：拖窄后聊天低于 320', chatWidthOf(dragged, 1100))
  const restored = withChatMinimum(dragged, 1100)
  ok(chatWidthOf(restored, 1100) >= CHAT_MIN_WIDTH_PX - 0.5, '恢复后聊天回到 320', chatWidthOf(restored, 1100))
  ok(widths(restored, 1100).get('files') >= TILE_MIN_WIDTH_PX - 0.5, '恢复后文件面板仍不低于 280', widths(restored, 1100).get('files'))
  const chatOnly = withChatMinimum(chatOnlyLayout(), 900)
  ok(layoutsEqual(chatOnly, chatOnlyLayout()), '只有聊天时不需要恢复')
  const healthy = withChatMinimum(base, 1100)
  ok(healthy === base, '聊天已经够宽时原样返回（同一对象）')
  const tight = withChatMinimum(dragged, 520)
  const tightChat = chatWidthOf(tight, 520)
  ok(tightChat > 0 && tightChat < CHAT_MIN_WIDTH_PX + 1, '容器放不下 320+280 时聊天只拿到剩余宽', tightChat)
  const columnChat = withChatMinimum(columnLayout([CHAT_TILE_ID, 'files']), 900)
  ok(columnChat.root.direction === 'column', '聊天在列里时不做恢复（只处理根行）', layoutKey(columnChat))
}

group('比例记忆：根行非 chat 直接子块 2*side/chat')
{
  const one = openPane(null, 'files')
  const resized = withStackFlexes(one, one.root.id, [4, 5])
  const memory = rememberPaneFlex(resized, ['files'], {})
  ok(memory.files === (2 * 5) / 4, '记下 2*side/chat（files=2*5/4=2.5）', memory)
  const untouched = rememberPaneFlex(resized, [], {})
  ok(untouched !== null && Object.keys(untouched).length === 0, 'changedKeys 为空时不写')
  const chatChanged = rememberPaneFlex(resized, [CHAT_TILE_ID], {})
  ok(Object.keys(chatChanged).length === 0, '聊天自己变化不写记忆')
  const two = openPane(one, 'changes')
  const nested = rememberPaneFlex(two, ['changes'], {})
  ok(nested.changes === undefined, '嵌套在列里的块不写记忆', nested)
  ok(flexChanges(one, resized).includes('files'), 'flexChanges 找出被拖动的块', flexChanges(one, resized))
  ok(flexChanges(one, one).length === 0, '同布局没有变化')

  ok(TILE_LAYOUTS_KEY === 'inkstone.v3.tileLayouts', '比例记忆并入按会话的布局 store（同一个键）', TILE_LAYOUTS_KEY)
  const seedFlex = (flex) => {
    const raw = localStorage.getItem(TILE_LAYOUTS_KEY)
    const state = raw ? JSON.parse(raw) : { version: 1, lastPaneFlexByKind: {}, sessions: {}, order: [] }
    localStorage.setItem(TILE_LAYOUTS_KEY, JSON.stringify({ ...state, lastPaneFlexByKind: flex }))
  }
  seedFlex({ files: 1.5, changes: 0.75 })
  const read = readPaneFlexByKind()
  ok(read.files === 1.5 && read.changes === 0.75, '记忆能落盘并读回', read)
  seedFlex({ files: 1.5 })
  const remembered = rememberPaneFlexByKind(resized, ['files'])
  ok(remembered.files === 2.5 && readPaneFlexByKind().files === 2.5, '记住被拖动的块时保留已有记忆', remembered)
  const sanitized = sanitizePaneFlexByKind({ files: 2, terminal: -1, browser: 'x', logs: 200 })
  ok(sanitized.files === 2 && sanitized.terminal === undefined && sanitized.browser === undefined && sanitized.logs === undefined, '读盘时丢掉非法比例', sanitized)
  const openWithMemory = openPane(chatOnlyLayout(), 'files', readPaneFlexByKind())
  ok(flexMap(openWithMemory).files === 2.5, '关掉再开按类型记忆取比例', flexMap(openWithMemory))
}

group('distributeFlex：最小值优先、放不下时按最小宽比例')
{
  const roomy = distributeFlex([2, 3], [320, 280], 1000)
  ok(Math.abs(roomy[0] - 0.8) < 1e-9 && Math.abs(roomy[1] - 1.2) < 1e-9, '宽裕时按 flex 分配', roomy)
  const lifted = distributeFlex([1, 9], [320, 280], 1000)
  ok((lifted[0] / (lifted[0] + lifted[1])) * 1000 > 320 - 1, '被压块先抬到最小宽', lifted)
  const tight = distributeFlex([1, 1], [320, 280], 500)
  ok(Math.abs(tight[0] / tight[1] - 320 / 280) < 1e-6, '放不下时按最小宽比例分', tight)
  const twoLanes = fitOpenedLayout(openPane(null, 'files'), 900)
  const twoBoxes = widths(twoLanes, 900)
  ok(twoBoxes.get('files') + PANE_LANE_INSET_PX - 16 >= TILE_MIN_WIDTH_PX || twoBoxes.get('files') >= TILE_MIN_WIDTH_PX, '面板道宽扣除 16 内边距后仍按 280 计', twoBoxes.get('files'))
  const threeLanes = openPane(openPane(openPane(chatOnlyLayout(), 'files'), 'changes'), 'terminal')
  const threeFitted = fitOpenedLayout(threeLanes, 951)
  const threeBoxes = widths(threeFitted, 951)
  const laneIds = threeFitted.root.children.map((child) => (child.kind === 'tile' ? child.tileId : child.id))
  ok(threeBoxes.get(CHAT_TILE_ID) >= CHAT_MIN_WIDTH_PX - 0.5, '三道时聊天让到 320（容器 951）', threeBoxes.get(CHAT_TILE_ID))
  ok(
    laneIds.slice(1).every((id) => threeBoxes.get(id) >= TILE_MIN_WIDTH_PX - 0.5),
    '三道时其余道不低于 280（容器 951）',
    laneIds.slice(1).map((id) => threeBoxes.get(id))
  )
  ok(
    laneIds.slice(1).every((id) => threeBoxes.get(id) - PANE_LANE_INSET_PX >= TILE_MIN_WIDTH_PX - 0.5),
    '扣除面板道内边距后，可见面板仍不低于 280（容器 951）',
    laneIds.slice(1).map((id) => threeBoxes.get(id) - PANE_LANE_INSET_PX)
  )
  const gapAware = openPane(openPane(null, 'files'), 'changes')
  const fittedGap = fitOpenedLayout(gapAware, 900)
  const boxes = widths(fittedGap, 900)
  const columnBox = boxes.get(fittedGap.root.children[1].id)
  const tilesInside = ['files', 'changes'].map((id) => boxes.get(id))
  ok(
    Math.abs(columnBox + boxes.get(CHAT_TILE_ID) + TILE_GAP - 900) < 0.5,
    '根行：聊天 + gap + 面板列 = 容器宽',
    { chat: boxes.get(CHAT_TILE_ID), columnBox }
  )
  ok(
    tilesInside.every((width) => Math.abs(width - columnBox) < 0.5),
    '列里的两块与列同宽（纵向叠）',
    { columnBox, tilesInside }
  )
}

const total = report.pass + report.fail
process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '存在失败'}：${report.pass}/${total}\n`)
await rm(outdir, { recursive: true, force: true })
process.exit(report.fail === 0 ? 0 : 1)
