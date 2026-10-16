#!/usr/bin/env node
/**
 * 并排视图回归（WP-20b）。
 *
 * 现场编译**真实生产模块**，不用源码字符串断言：
 *   · `state/split-view.ts`（真实分屏状态与纯函数，zustand）；
 *   · `app/SideBySideLayout.ts`（列投影、窄屏退回、子 Agent 伪列、命令候选）。
 *
 * 钉住的规则：
 *   · 两条不同会话才能并排；同一条不重复开；只剩一列时退出分屏（关闭一侧回单视图）；
 *   · 窄屏只画焦点那一列，分屏状态保留（宽回来恢复）；
 *   · 子 Agent 转录列是伪会话，不能进 runner 可见性、不能被当成可激活会话；
 *   · 焦点换边时只替换焦点那一列，其他列（含子 Agent 列）不动；
 *   · 命令面板「并排打开」挑最近活动、未归档、且不在当前分屏里的会话。
 *
 * 用法：node scripts/test-v3-side-by-side.mjs
 * 不启动 Electron、不连 pi、不读用户数据、不调用真实模型。
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const splitSrc = resolve(ROOT, 'src/renderer/src/state/split-view.ts')
const layoutSrc = resolve(ROOT, 'src/renderer/src/app/SideBySideLayout.ts')

const result = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(splitSrc)}\nexport * from ${JSON.stringify(layoutSrc)}\n`,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const {
  collapsedPanes,
  isSessionTile,
  placeInSplit,
  reconcileSplit,
  removeSplitTile,
  sameSplitSession,
  sessionTiles,
  sideBySideCandidate,
  subagentRunIdOf,
  subagentTileRef,
  useSplitView
} = mod

/* ------------------------------------------------------------------ 断言 */

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

const A = { sessionId: 'sa', path: 'C:/projects/a/session.jsonl', uid: 'ta' }
const B = { sessionId: 'sb', path: 'C:/projects/b/session.jsonl', uid: 'tb' }
const C = { sessionId: 'sc', path: 'C:/projects/c/session.jsonl', uid: 'tc' }
const SUB = subagentTileRef('run-1')

/* ── 子 Agent 伪列 ─────────────────────────────────────────── */
group('子 Agent 伪列身份')
ok(subagentTileRef('run-1').sessionId === 'subagent:run-1', '伪列 id 带固定前缀')
ok(subagentRunIdOf(SUB) === 'run-1', '能从伪列还原子 Agent runId')
ok(subagentRunIdOf(A) === null, '会话列不带子 Agent runId')
ok(subagentRunIdOf(null) === null, '空列传 null')
ok(isSessionTile(A) === true, '有 id 的会话列是会话')
ok(isSessionTile({ path: 'C:/x.jsonl' }) === true, '只有路径的新会话也仍算会话')
ok(isSessionTile(SUB) === false, '子 Agent 伪列不是会话')
ok(isSessionTile(null) === false, '空列不是会话')
ok(sessionTiles([SUB, A, { path: 'C:/only.jsonl' }]).length === 2, 'runner 可见性只收会话列')
ok(sessionTiles([SUB]).length === 0, '只有子 Agent 伪列时没有可报告的会话')
ok(sessionTiles([SUB])[0] === undefined, '子 Agent 伪列不进可见性')

/* ── 窄屏退回单栏 ─────────────────────────────────────────── */
group('窄屏退回单栏')
ok(collapsedPanes(null, false) === null, '无分屏 → 单会话版面')
ok(collapsedPanes({ tiles: [A], live: 0 }, false) === null, '只剩一列也算无分屏')
const wide = collapsedPanes({ tiles: [A, B], live: 1 }, false)
ok(wide && wide.tiles.length === 2 && wide.live === 1, '宽屏保留全部列与焦点')
ok(wide.tiles[0] === A && wide.tiles[1] === B, '宽屏列顺序不变')
const narrow = collapsedPanes({ tiles: [A, B], live: 1 }, true)
ok(narrow && narrow.tiles.length === 1 && narrow.tiles[0] === B && narrow.live === 0, '窄屏只留焦点那一列')
const narrowSub = collapsedPanes({ tiles: [A, SUB], live: 0 }, true)
ok(narrowSub && narrowSub.tiles.length === 1 && narrowSub.tiles[0] === A, '窄屏含子 Agent 列时仍只留焦点会话')

/* ── 真实分屏状态：开 / 换焦点 / 关 ─────────────────────────── */
group('真实分屏状态')
ok(placeInSplit(null, C, A) !== null, '不同会话能并排')
ok(placeInSplit(null, C, C) === null, '同一条会话不重复开')
const placed = placeInSplit(null, C, A)
ok(placed.tiles[0].sessionId === 'sa' && placed.tiles[1].sessionId === 'sc' && placed.live === 0, '当前会话在左、新会话在右、焦点留在当前')
const placedLeft = placeInSplit(null, C, A, 0)
ok(placedLeft.tiles[0].sessionId === 'sc' && placedLeft.tiles[1].sessionId === 'sa' && placedLeft.live === 1, '指定落点 0 时新会话在左')
ok(placeInSplit({ tiles: [A, B], live: 0 }, A, A) !== null, '已在分屏里的会话可挪位')
ok(placeInSplit({ tiles: [A, B], live: 0 }, A, A).tiles.length === 2, '挪动不重复增加列')

const withSub = { tiles: [A, SUB], live: 0 }
ok(reconcileSplit(withSub, A) === withSub, '显示的还是 A 时不动分屏')
const replaced = reconcileSplit(withSub, C)
ok(replaced.tiles[0].sessionId === 'sc' && replaced.tiles[1] === SUB && replaced.live === 0, '焦点换到 C 只替换焦点列，子 Agent 列保留')
ok(replaced !== withSub, '替换返回新对象')

ok(removeSplitTile({ tiles: [A, B], live: 0 }, 1) === null, '关掉一侧只剩一列 → 退出分屏（回单视图）')
const three = removeSplitTile({ tiles: [A, B, C], live: 1 }, 0)
ok(three && three.tiles.length === 2 && three.tiles[0] === B && three.live === 0, '多列时关闭非焦点列，其余顺序不变')
ok(sameSplitSession(A, { path: 'c:/PROJECTS/a/session.JSONL' }) === true, '路径比较大小写与分隔符不敏感')

/* 走一遍 store 动作，确认「开 → 加一列 → 关闭回单视图」的真实状态流转 */
useSplitView.getState().close()
useSplitView.getState().open(B, A)
ok(!!useSplitView.getState().split, 'store.open 后进入分屏')
useSplitView.getState().open(C, A)
ok(useSplitView.getState().split.tiles.length === 3, 'store.open 追加第三列')
useSplitView.getState().setWeights({ ta: 2, tb: 1 })
useSplitView.getState().remove(0)
ok(useSplitView.getState().split?.tiles.length === 2, '从三列关到两列仍在分屏')
ok(useSplitView.getState().weights.ta === undefined && useSplitView.getState().weights.tb === 1, '关掉的列宽被清掉，保留列宽不变')
useSplitView.getState().remove(0)
ok(useSplitView.getState().split === null, '关到只剩一列时 split 归 null')
ok(Object.keys(useSplitView.getState().weights).length === 0, '退出分屏后清掉不再存在的列宽')
useSplitView.getState().close()
ok(useSplitView.getState().split === null, 'close 回到无分屏')

/* ── 命令面板候选 ───────────────────────────────────────── */
group('命令面板「并排打开」候选')
const sessions = [
  { id: 'sa', path: 'C:/projects/a/session.jsonl', lastActivityAt: 100 },
  { id: 'sb', path: 'C:/projects/b/session.jsonl', lastActivityAt: 300 },
  { id: 'sc', path: 'C:/projects/c/session.jsonl', lastActivityAt: 200 },
  { id: 'sz', path: 'C:/projects/z/session.jsonl', lastActivityAt: 999, archivedAt: 1 }
]
const picked = sideBySideCandidate(sessions, A, [])
ok(picked && picked.id === 'sb', '挑最近活动、非归档的另一条会话')
ok(sideBySideCandidate(sessions, { sessionId: 'sb', path: 'C:/projects/b/session.jsonl' }, []).id === 'sc', '不把当前会话当成候选')
ok(sideBySideCandidate(sessions, A, [{ sessionId: 'sb' }]).id === 'sc', '已在分屏里的会话不重复挑')
ok(sideBySideCandidate(sessions, A, [{ path: 'C:/projects/b/session.jsonl' }]).id === 'sc', '分屏里按路径命中的也不重复挑')
ok(sideBySideCandidate([{ id: 'sa', path: 'C:/projects/a/session.jsonl' }], A, []) === null, '没有别的会话时返回 null')
ok(sideBySideCandidate(sessions, null, []).id === 'sb', '未知当前会话时仍按最近活动挑')
ok(sideBySideCandidate(sessions.filter((item) => item.id !== 'sb' && item.id !== 'sc'), A, []) === null, '只剩归档会话时没有候选')

/* ------------------------------------------------------------------ 收尾 */

process.stdout.write(`\n${report.fail ? '✗' : '✓'} 并排视图回归：通过 ${report.pass}，失败 ${report.fail}\n`)
process.exitCode = report.fail ? 1 : 0
