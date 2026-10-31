import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

async function load(entry, out) {
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' })
  return import(pathToFileURL(out).href)
}

export async function runSplitViewTests(ok) {
  const split = await load('src/renderer/src/state/split-view.ts', 'out/test/split-view.mjs')
  const { reconcileSplit, sameSplitSession, displayedSessionOf, useSplitView, placeInSplit, removeSplitTile, MAX_SPLIT_TILES } = split

  const mk = (id) => ({ sessionId: id, path: `C:/s/${id}.jsonl` })
  const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map(mk)
  const ids = (sp) => sp?.tiles.map((t) => t.sessionId).join('')
  const base = { tiles: [a, b], live: 0 }

  ok(MAX_SPLIT_TILES === 5, '同屏最多 5 块')
  ok(reconcileSplit(base, a) === base, '活动会话就是焦点那一块：分屏不变（同一对象）')
  const moved = reconcileSplit(base, b)
  ok(moved.live === 1 && moved.tiles[0] === a && ids(moved) === 'ab', '活动会话是另一块：焦点移过去，位置不交换')
  const replaced = reconcileSplit(base, c)
  ok(replaced.live === 0 && ids(replaced) === 'cb' && replaced.tiles[1] === b, '从左栏切到别的会话：替换焦点那一块，其余不动')
  const mid3 = reconcileSplit({ tiles: [a, b, c], live: 0 }, c)
  ok(mid3.live === 2 && ids(mid3) === 'abc', '三块时点第三块：焦点移到第三块')
  const repl3 = reconcileSplit({ tiles: [a, b, c], live: 1 }, d)
  ok(ids(repl3) === 'adc' && repl3.live === 1, '三块时切到别的会话：只替换焦点那一块')
  ok(reconcileSplit(base, null) === base && reconcileSplit(base, {}) === base, '还不知道显示哪条会话时不动')
  const filled = reconcileSplit({ tiles: [{ sessionId: 'a' }, b], live: 0 }, a)
  ok(filled.tiles[0].path === a.path, '新会话落盘后补上文件路径')
  ok(reconcileSplit(filled, a) === filled, '补完之后不再反复写回')

  ok(sameSplitSession({ path: 'C:\\S\\A.jsonl' }, { path: 'c:/s/a.jsonl' }), '只有路径时按路径比较（大小写、斜杠不敏感）')
  ok(!sameSplitSession({ sessionId: 'a', path: 'x' }, { sessionId: 'b', path: 'x' }), '两边都有 id 时以 id 为准')

  ok(displayedSessionOf({ peekedSessionId: 'b', peekedPath: b.path, session: { sessionId: 'a', sessionFile: a.path } }).sessionId === 'b', '切换途中以先铺上的会话为准')
  ok(displayedSessionOf({ peekedSessionId: null, peekedPath: null, session: { sessionId: 'a', sessionFile: a.path } }).path === a.path, '没有预览时取运行实例的会话')
  ok(displayedSessionOf({ peekedSessionId: null, peekedPath: null, session: null }) === null, '没有会话时为空')

  ok(placeInSplit(null, a, a) === null, '在旁边打开当前会话：不分屏')
  let sp = placeInSplit(null, b, a)
  ok(ids(sp) === 'ab' && sp.live === 0, '打开分屏：当前会话在左、焦点不动，新的追加到右')
  sp = placeInSplit(null, b, a, 0)
  ok(ids(sp) === 'ba' && sp.live === 1, '没分屏时放到最左：当前会话挪到右并保持焦点')
  sp = placeInSplit({ tiles: [a, b], live: 0 }, c, a)
  ok(ids(sp) === 'abc' && sp.live === 0, '已分屏再打开：追加成第三块，焦点不动')
  sp = placeInSplit({ tiles: [a, b, c], live: 1 }, d, b, 0)
  ok(ids(sp) === 'dabc' && sp.live === 2, '插到最左：焦点跟着原会话右移一位')
  sp = placeInSplit({ tiles: [a, b, c], live: 1 }, d, b, 2)
  ok(ids(sp) === 'abdc' && sp.live === 1, '插到中间：焦点位置不变')
  sp = placeInSplit({ tiles: [a, b, c], live: 0 }, c, a, 0)
  ok(ids(sp) === 'cab' && sp.live === 1, '目标已在分屏里：挪过去而不是重复开，焦点跟着会话走')
  const same = { tiles: [a, b, c], live: 0 }
  ok(ids(placeInSplit(same, c, a, 3)) === 'abc', '目标已在最右、再放到最右：顺序不变')
  let five = { tiles: [a, b, c, d, e], live: 2 }
  sp = placeInSplit(five, f, c)
  ok(ids(sp) === 'abcdf', '已满 5 块：挤掉离落点最近的非焦点块（这里是最右的 e）')
  ok(sp.tiles.length === 5 && sp.tiles.some((t) => t.sessionId === 'f') && sp.tiles[sp.live].sessionId === 'c', '已满：新会话进来、焦点会话还在')
  sp = placeInSplit(five, f, c, 0)
  ok(ids(sp) === 'fbcde', '已满插到最左：挤掉最左的非焦点块 a')

  const { splitColumnLimit, SPLIT_COLUMN_MIN_WIDTH } = split
  ok(SPLIT_COLUMN_MIN_WIDTH === 360, '分屏每列最小约 360px')
  ok(splitColumnLimit(0) === 5 && splitColumnLimit(1900) === 5 && splitColumnLimit(1200) === 3 && splitColumnLimit(700) === 2 && splitColumnLimit(300) === 2, '列数按容器宽度限制：未量到宽度不限、最少保留 2 列、最多 5 列')
  sp = placeInSplit({ tiles: [a, b, c], live: 0 }, d, a, undefined, 3)
  ok(sp.tiles.length === 3 && sp.tiles.some((t) => t.sessionId === 'd') && sp.tiles[sp.live].sessionId === 'a', '宽度只容得下 3 列：不再新增第 4 列，改为替换离落点最近的非焦点块')
  useSplitView.getState().close()
  useSplitView.getState().setContainerWidth(1100)
  useSplitView.getState().open(b, a)
  useSplitView.getState().open(c, a)
  useSplitView.getState().open(d, a)
  ok(useSplitView.getState().split.tiles.length === 3, '仓库按容器宽度（1100px ⇒ 3 列）拒绝新增第 4 列')
  useSplitView.getState().close()
  useSplitView.getState().setContainerWidth(0)

  ok(ids(removeSplitTile({ tiles: [a, b, c], live: 2 }, 0)) === 'bc' && removeSplitTile({ tiles: [a, b, c], live: 2 }, 0).live === 1, '去掉焦点左边的块：焦点下标跟着前移')
  ok(removeSplitTile({ tiles: [a, b, c], live: 0 }, 2).live === 0, '去掉焦点右边的块：焦点不动')
  ok(removeSplitTile({ tiles: [a, b], live: 0 }, 1) === null, '只剩一块：退出分屏')

  const store = useSplitView
  store.getState().close()
  store.getState().open(b, a)
  ok(ids(store.getState().split) === 'ab' && store.getState().split?.live === 0, 'store：打开分屏')
  store.getState().open(c, a)
  store.getState().sync(c)
  ok(ids(store.getState().split) === 'abc' && store.getState().split?.live === 2, 'store：按活动会话写回焦点')
  store.getState().remove(0)
  ok(ids(store.getState().split) === 'bc' && store.getState().split?.live === 1, 'store：去掉一块')
  store.getState().close()
  ok(store.getState().split === null, '关闭回到单会话')

  const snaps = await load('src/renderer/src/state/split-snapshots.ts', 'out/test/split-snapshots.mjs')
  const msg = (id, ts) => ({ id, role: 'assistant', text: id, ...(ts ? { timestamp: ts } : {}) })
  const shownNew = [msg('u1', 100), msg('a1', 200), msg('u2', 300), msg('a2', 400)]
  const cacheOld = [msg('u1', 100), msg('t1', 150), msg('t2', 160), msg('a1', 200), msg('t3', 210)]
  ok(snaps.newestMessages(shownNew, undefined, cacheOld) === shownNew, '运行缓存条数更多但更旧：仍用屏幕上那份（用户截图里少了最后一轮）')
  const cacheNewer = [...shownNew, msg('u3', 500)]
  ok(snaps.newestMessages(shownNew, undefined, cacheNewer) === cacheNewer, '后台又跑出了新消息：用运行缓存')
  const tied = [msg('u1', 100), msg('a2', 400)]
  ok(snaps.newestMessages(shownNew, tied) === shownNew, '一样新：取靠前的（屏幕上那份，含只推给活动会话的卡片）')
  ok(snaps.newestMessages(undefined, [], tied) === tied, '空的跳过')
  const sv = useSplitView.getState()
  sv.close()
  sv.open(b, a)
  useSplitView.getState().open(c, a)
  const [ka, kb, kc] = useSplitView.getState().split.tiles.map(split.splitTileKey)
  useSplitView.getState().setWeights({ [ka]: 2, [kb]: 3, [kc]: 4 })
  useSplitView.getState().remove(2)
  const kept = useSplitView.getState().weights
  ok(kept[ka] === 2 && kept[kb] === 3 && !(kc in kept), '关掉一块：它的宽度份额一并清掉')
  const pathOnly = { path: 'C:/s/p.jsonl' }
  const withUidSplit = placeInSplit(null, pathOnly, a)
  const uid0 = withUidSplit.tiles[1].uid
  const enriched = reconcileSplit(withUidSplit, { sessionId: 'p', path: 'C:/s/p.jsonl' })
  ok(!!uid0 && enriched.tiles[1].uid === uid0 && enriched.tiles[1].sessionId === 'p', '会话后来补上 id：列的编号不变')
  const movedSplit = placeInSplit(withUidSplit, { path: 'C:/s/p.jsonl' }, a, 0)
  ok(movedSplit.tiles[0].uid === uid0 && movedSplit.tiles.length === 2, '拖已在分屏里的会话挪位置：列的编号不变')
  const swapped = reconcileSplit(withUidSplit, c)
  ok(swapped.tiles[0].uid === withUidSplit.tiles[0].uid && swapped.tiles[0].sessionId === 'c', '焦点那一块换了会话：列的编号沿用')
  const wk = await load('src/renderer/src/state/workspace-key.ts', 'out/test/workspace-key.mjs')
  ok(wk.workspaceKeyFor({ sessionId: 'z', path: 'C:/s/z.jsonl' }) === 'C:/s/z.jsonl', '会话键优先用文件路径')
  ok(wk.workspaceKeyFor({ sessionId: 'z' }) === 'z' && wk.workspaceKeyFor({}) === 'pending', '没有文件时退回 id，都没有时用 pending')
  ok(wk.workspaceKeyFor({ path: 'C:\\S\\z.jsonl' }) === 'C:\\S\\z.jsonl', '路径原样作为键，不做归一化')
  useSplitView.getState().close()
  ok(Object.keys(useSplitView.getState().weights).length === 0, '回到单会话：份额清空')
  const lsData = new Map()
  globalThis.localStorage = { getItem: (k) => lsData.get(k) ?? null, setItem: (k, v) => void lsData.set(k, String(v)) }
  const owners = await load('src/renderer/src/state/resource-owners.ts', 'out/test/resource-owners.mjs')
  ok(owners.claimResource('terminal:1', 'X') === 'X' && owners.claimResource('terminal:1', 'Y') === 'X', '资源归第一个认领的会话，不被后来者改走')
  owners.releaseResource('terminal:1')
  ok(owners.resourceOwner('terminal:1') === undefined, '释放后不再有主人')
  owners.claimResource('browser', 'X')
  owners.claimResource('browser', 'Y')
  ok(owners.resourceOwner('browser') === 'X', '浏览器绑定原会话，另一列取得焦点不抢占')
  owners.releaseResource('browser')
  ok(owners.claimResource('browser', 'Y') === 'Y', '关闭浏览器释放归属，下次打开绑定新会话')
  const brokenKey = 'inkstone.workspace.owners.v1.broken.'
  ok(![...lsData.keys()].some((k) => k.startsWith(brokenKey)), '存储正常时不留损坏备份')
  const brokenOwners = await load('src/renderer/src/state/resource-owners.ts', 'out/test/resource-owners-broken.mjs')
  lsData.set('inkstone.workspace.owners.v1', '{oops')
  ok(brokenOwners.claimResource('file:x', 'S') === 'S', '存储损坏时仍可重新登记')
  const backupKey = [...lsData.keys()].find((k) => k.startsWith(brokenKey))
  ok(!!backupKey && lsData.get(backupKey) === '{oops', '损坏的原始内容另存一份，不被覆盖')
  ok(JSON.parse(lsData.get('inkstone.workspace.owners.v1'))['file:x'] === 'S', '重写后只含新内容')
  ok(brokenOwners.resourceOwner('file:x') === 'S', '重新登记后读得回来')
  ok(snaps.newestMessages([msg('x')], [msg('y', 1)]) !== undefined && snaps.latestTimestamp([msg('a', 5), msg('b')]) === 5, '没有时间的消息不算，往前找带时间的')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0
  let passed = 0
  await runSplitViewTests((cond, name) => { if (cond) passed++; else { failed++; console.error('✗', name) } })
  console.log(failed ? `✗ ${failed} 项失败，${passed} 项通过` : `✓ 分屏 ${passed} 项通过`)
  process.exit(failed ? 1 : 0)
}
