import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/workbench/tile-tree.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const tree = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const {
  CHAT_TILE_ID,
  CHAT_PANES_ID,
  CHAT_MIN_WIDTH_PX,
  CHAT_FLEX,
  CHAT_PANES_FLEX,
  TILE_MIN_WIDTH_PX,
  TILE_MIN_HEIGHT_PX,
  tileMinPxOf,
  tileLeaf,
  tileStack,
  columnLayout,
  orderedTileIds,
  hasTile,
  sanitizeLayout,
  chatOnlyLayout,
  chatFlexOf,
  panesLayoutOf,
  panesOnlyLayout,
  foldChat,
  layoutWithChat,
  normalizeLayout,
  withStackFlexes,
  adjustFlexes
} = tree

const legacy = {
  root: {
    kind: 'stack',
    id: 'seed-root',
    direction: 'column',
    flex: 1,
    children: [
      { kind: 'tile', tileId: 'files', flex: 1 },
      { kind: 'tile', tileId: 'terminal', flex: 1 },
      { kind: 'tile', tileId: 'changes', flex: 2 }
    ]
  }
}

assert.equal(CHAT_TILE_ID, 'chat')
assert.equal(CHAT_MIN_WIDTH_PX, 320, '聊天最小宽 320')
assert.equal(CHAT_FLEX, 2)
assert.equal(CHAT_PANES_FLEX, 3)

assert.equal(tileMinPxOf('chat', 'row'), 320, '聊天块横向最小宽取 320')
assert.equal(tileMinPxOf('files', 'row'), TILE_MIN_WIDTH_PX, '面板横向最小宽仍取 280')
assert.equal(tileMinPxOf('chat', 'column'), TILE_MIN_HEIGHT_PX, '聊天块纵向最小高与面板一致')
assert.equal(tileMinPxOf('files', 'column'), TILE_MIN_HEIGHT_PX)

const onlyChat = chatOnlyLayout()
assert.deepEqual(orderedTileIds(onlyChat), ['chat'], '空工作区只有聊天块')
assert.equal(onlyChat.root.direction, 'row', '根节点仍是栈')
assert.equal(chatFlexOf(null), CHAT_FLEX, '没有布局时聊天按 2 份')
assert.equal(chatFlexOf(onlyChat), CHAT_FLEX, '聊天单块时记住 2 份，开第一个面板按 2:3')

const migrated = layoutWithChat(sanitizeLayout(legacy, new Set(['files', 'terminal', 'changes'])))
assert.deepEqual(orderedTileIds(migrated), ['chat', 'files', 'terminal', 'changes'], '旧布局迁移后聊天在前，面板顺序不变')
assert.equal(migrated.root.direction, 'row', '迁移后根是行：聊天 + 面板列')
assert.equal(migrated.root.children.length, 2, '根行只有聊天与面板列两个直接子块')
assert.equal(migrated.root.children[0].tileId, 'chat')
assert.equal(migrated.root.children[0].flex, 2, '聊天 2 份')
const lanes = migrated.root.children[1]
assert.equal(lanes.direction, 'column', '旧的上下列整体放进一列，保留上下叠放')
assert.equal(lanes.flex, 3, '面板列 3 份（2:3）')
assert.equal(lanes.id, CHAT_PANES_ID, '面板列用固定 id，规范化时不会被并进根行')
assert.deepEqual(lanes.children.map((child) => child.tileId), ['files', 'terminal', 'changes'], '旧的上下列原样保留用户手调的顺序')
assert.deepEqual(lanes.children.map((child) => child.flex), [1, 1, 2], '旧面板之间的相对比例不变')

const roundTrip = panesLayoutOf(migrated)
assert.deepEqual(orderedTileIds(roundTrip), ['files', 'terminal', 'changes'], '面板子树可以还原，聊天块不混进面板布局')
assert.deepEqual(orderedTileIds(layoutWithChat(roundTrip)), ['chat', 'files', 'terminal', 'changes'], '还原后再包一层结果一致（幂等）')

assert.equal(chatFlexOf(migrated), 2)
const wider = layoutWithChat(roundTrip, 5)
assert.equal(chatFlexOf(wider), 5, '已有聊天 flex 在重排时保留')
assert.equal(layoutWithChat(null).root.children[0].tileId, 'chat', '没有面板时退回只有聊天')

const flown = panesOnlyLayout(migrated)
assert.deepEqual(orderedTileIds(flown), ['files', 'terminal', 'changes'], '全屏/展开时去掉聊天块，只留面板树')
assert.equal(flown.root.direction, 'column', '去聊天后面板树保留原来的上下叠')
assert.deepEqual(orderedTileIds(panesOnlyLayout(chatOnlyLayout())), [], '只有聊天时去聊天得到空布局')

const folded = foldChat(migrated)
assert.deepEqual(orderedTileIds(folded), ['chat', 'files', 'terminal', 'changes'], '展开/全屏折叠聊天不丢块也不改顺序')
assert.equal(folded.root.children[0].tileId, 'chat')
assert.equal(folded.root.children[0].flex, 0, '折叠后聊天 flex=0，不占宽')
assert.equal(folded.root.children[1].flex, 3, '折叠不动面板列的比例')
assert.equal(folded.root.children[1].id, CHAT_PANES_ID, '折叠不改树结构')
assert.deepEqual(orderedTileIds(foldChat(chatOnlyLayout())), ['chat'], '只有聊天时折叠仍保留聊天块')

const resized = withStackFlexes(migrated, migrated.root.id, [4, 6])
assert.equal(resized.root.direction, 'row', '拖动根行分隔条后根仍是行')
assert.equal(resized.root.children[1].id, CHAT_PANES_ID, '规范化不会把面板列并进根行')
assert.deepEqual(orderedTileIds(resized), ['chat', 'files', 'terminal', 'changes'], '规范化不丢块也不改顺序')
assert.equal(resized.root.children[0].flex, 4, '聊天 flex 写回')

const nestedRow = normalizeLayout({
  root: tileStack('column', [tileLeaf('files'), tileStack('row', [tileLeaf('terminal'), tileLeaf('changes')])])
})
const nested = layoutWithChat(nestedRow)
assert.equal(nested.root.children.length, 2, '面板区域内部的行拆分不会把块摊到根行上')
assert.deepEqual(orderedTileIds(nested), ['chat', 'files', 'terminal', 'changes'])
assert.deepEqual(orderedTileIds(foldChat(nested)), ['chat', 'files', 'terminal', 'changes'], '嵌套布局折叠聊天同样只把聊天置零')

const shrunk = adjustFlexes([4, 6], 0, -10000, 100, tileMinPxOf('chat', 'row'))
assert.ok(Math.abs(shrunk[0] - 3.2) < 1e-9 && Math.abs(shrunk[1] - 6.8) < 1e-9, '拖分隔条时聊天停在 320', shrunk)
const floorForPane = adjustFlexes([6, 4], 0, 10000, 100, tileMinPxOf('files', 'row'))
assert.ok(Math.abs(floorForPane[1] - 2.8) < 1e-9 && Math.abs(floorForPane[0] - 7.2) < 1e-9, '面板停在 280', floorForPane)

const rowOfPanes = columnLayout(['files'])
const single = layoutWithChat(rowOfPanes)
assert.equal(single.root.children.length, 2, '单个面板也在根行里与聊天并列')
assert.equal(single.root.children[1].tileId, 'files')
assert.equal(single.root.children[1].flex, 3, '单个面板占 3 份')

const horizontal = normalizeLayout({ root: tileStack('row', [tileLeaf('files'), tileLeaf('changes')]) })
const flat = layoutWithChat(horizontal)
assert.deepEqual(orderedTileIds(flat), ['chat', 'files', 'changes'], '旧布局本身是行时把聊天插到行首，比例按 2:3 缩放')
const flexSum = flat.root.children.slice(1).reduce((sum, child) => sum + child.flex, 0)
assert.ok(Math.abs(flat.root.children[0].flex - 2) < 1e-9 && Math.abs(flexSum - 3) < 1e-9, '行合并后聊天 2 份、面板合计 3 份', flat.root.children.map((c) => c.flex))

console.log('聊天进树：迁移、聊天块约束、面板子树还原检查通过')
