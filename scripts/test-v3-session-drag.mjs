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

const model = await loadTs('../src/renderer/src/features/sidebar/sidebar-model.ts')

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
