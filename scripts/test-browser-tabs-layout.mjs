#!/usr/bin/env node
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const layout = await compile('src/renderer/src/features/browser/tabs-layout.ts')
  const groups = await compile('src/renderer/src/features/browser/local-server-groups.ts')
  const overlay = await compile('src/renderer/src/features/browser/overlay.ts')

  const store = new Map()
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  ok(layout.readTabsLayout(storage) === 'vertical', '默认竖排')
  layout.writeTabsLayout('horizontal', storage)
  ok(layout.readTabsLayout(storage) === 'horizontal', '横排偏好写入后读回')
  store.set(layout.TABS_LAYOUT_KEY, 'diagonal')
  ok(layout.readTabsLayout(storage) === 'vertical', '未知值回落竖排')
  ok(layout.pinnedTabsShown(true, 'vertical', 720) === true, '宽面板固定态显示')
  ok(layout.pinnedTabsShown(true, 'vertical', 400) === false, '窄面板固定态按收起显示')
  ok(layout.pinnedTabsShown(true, 'vertical', 0) === true, '尚未测量时保持偏好')
  ok(layout.pinnedTabsShown(true, 'horizontal', 900) === false, '横排没有固定列')

  const servers = [
    { host: '127.0.0.1', port: 5173, title: 'Vite' },
    { host: '0.0.0.0', port: 5522, processName: 'RGSUpdater' },
    { host: '0.0.0.0', port: 8080, title: 'Admin' },
    { host: '0.0.0.0', port: 3000, agentStarted: true }
  ]
  const split = groups.groupLocalServers(servers)
  ok(split.main.map((s) => s.port).join() === '5173,8080,3000', '有标题或 agent 起的服务留在主列表', JSON.stringify(split))
  ok(split.other.map((s) => s.port).join() === '5522', '监听 0.0.0.0 且无标题的折到其他')
  ok(groups.localServerMarkName({ title: ' Vite ', port: 1 }) === 'Vite', '图标名用标题')
  ok(groups.localServerMarkName({ processName: 'node', port: 1 }) === 'node', '无标题用进程名')
  ok(groups.localServerMarkName({ port: 8273 }) === '8273', '都没有用端口')

  const viewport = { name: 'viewport', contains: (other) => other === viewport }
  const sheet = { name: 'sheet', contains: (other) => other === sheet || other === viewport }
  const menu = { name: 'menu', contains: (other) => other === menu }
  ok(overlay.blocksSurface([sheet], viewport) === false, '包含网页视口的右栏浮层不算遮挡')
  ok(overlay.blocksSurface([sheet, menu], viewport) === true, '浮层上的菜单仍算遮挡')
  ok(overlay.blocksSurface([sheet], null) === true, '没有视口时按遮挡处理')
  ok(overlay.blocksSurface([], viewport) === false, '没有浮层不遮挡')
})
