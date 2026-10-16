#!/usr/bin/env node
/**
 * v3 侧栏会话拖拽分屏的落点几何，以及侧栏「置顶」分区的纯逻辑回归。
 *
 * 现场编译 `features/sidebar/session-drag.ts` 与 `sidebar-model.ts`，只跑纯函数：
 * 不启动 Electron、不连 pi、不读用户数据。
 *
 *   node scripts/test-v3-session-drag.mjs
 */
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

const drag = await loadTs('../src/renderer/src/features/sidebar/session-drag.ts')
const model = await loadTs('../src/renderer/src/features/sidebar/sidebar-model.ts')

/* ── 落点几何 ─────────────────────────────────────────────── */
{
  const area = { left: 300, top: 50, width: 800, height: 600 }
  const single = drag.dropZonesFor(area, [])
  ok(single.length === 2, '单会话：对话区分左右两个落点', single.length)
  ok(single[0].at === 0 && single[0].side === 'left' && single[1].at === 1 && single[1].side === 'right', '左半插到前面、右半插到后面')
  ok(single[0].rect.width + single[1].rect.width === 800, '两半合起来正好铺满')
  ok(drag.hitDropZone(single, 310, 100) === 0, '命中左半')
  ok(drag.hitDropZone(single, 1090, 600) === 1, '命中右半')
  ok(drag.hitDropZone(single, 100, 100) === -1, '对话区外不命中')

  const cols = [
    { left: 720, top: 50, width: 380, height: 600 },
    { left: 300, top: 50, width: 400, height: 600 }
  ]
  const split = drag.dropZonesFor(area, cols)
  ok(split.length === 4, '分屏：每列各两个落点', split.length)
  ok(split.map((z) => z.at).join(',') === '0,1,1,2', '按列从左到右排序后的插入位置', split.map((z) => z.at))
  ok(split[0].rect.left === 300, '列按横坐标排序（与 DOM 顺序无关）', split[0].rect.left)

  const tiny = drag.dropZonesFor({ left: 0, top: 0, width: 120, height: 90 }, [])
  ok(tiny.length === 0, '区域过小（被挤没）不给落点')
  ok(drag.dropZonesFor(null, []).length === 0, '没有对话区不给落点')
}

/* ── 拖拽阈值 ─────────────────────────────────────────────── */
{
  ok(!drag.passedThreshold(3, 4), '移动 5px 仍算点击')
  ok(drag.passedThreshold(6, 0), '移动 6px 开始拖拽')
  ok(drag.DRAG_THRESHOLD === 6, '阈值 6px')
}

/* ── 置顶分区 ─────────────────────────────────────────────── */
{
  const s = (id, over = {}) => ({ id, path: `/s/${id}.jsonl`, cwd: '/p', title: id, updatedAt: 1, lastActivityAt: 1, ...over })
  const sessions = [s('a', { lastActivityAt: 5 }), s('b', { pinned: true, lastActivityAt: 3 }), s('c', { pinned: true, lastActivityAt: 9 }), s('d', { cwd: '/q', lastActivityAt: 2 })]
  const base = { sessions, query: '', projects: [], projectNames: {}, titles: {}, manualTitles: {} }
  const plain = model.buildSidebarGroups(base)
  ok(plain.every((g) => g.key !== 'pinned'), '不给分区名时不拆置顶（旧调用方行为不变）')
  const groups = model.buildSidebarGroups({ ...base, pinnedLabel: '置顶' })
  ok(groups[0].key === 'pinned' && groups[0].label === '置顶', '置顶分区排在最前', groups.map((g) => g.key))
  ok(groups[0].list.map((x) => x.id).join(',') === 'c,b', '置顶分区内按最近活动排序', groups[0].list.map((x) => x.id))
  ok(groups.slice(1).every((g) => g.list.every((x) => !x.pinned)), '置顶会话不在原项目分区里重复出现')
  const only = model.buildSidebarGroups({ ...base, sessions: [s('x', { pinned: true })], pinnedLabel: '置顶' })
  ok(only.length === 1 && only[0].key === 'pinned', '原分区被拿空后不留空分区', only.map((g) => g.key))
  const searched = model.buildSidebarGroups({ ...base, query: 'a', pinnedLabel: '置顶' })
  ok(searched.every((g) => g.key !== 'pinned'), '搜索未命中置顶会话时不显示置顶分区', searched.map((g) => g.key))
}

process.stdout.write(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
