import { runSuite } from './lib/test-suite.mjs'

const stubStore = {
  name: 'panel-dock-isolated',
  setup(build) {
    build.onResolve({ filter: /(\/state\/store|\/sidebar\/session-drag|\/split\/split-drag)$/ }, (args) => ({ path: args.path, namespace: 'panel-dock-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'panel-dock-stub' }, () => ({
      contents: 'export const useStore = { getState: () => ({}) }; export const trackPointerDrag = () => {}; export const labelGhost = () => ({}); export const setSplitBadge = () => {}'
    }))
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const store = new Map()
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) }
  const rp = await compile('src/renderer/src/state/right-panel.ts')
  const drag = await compile('src/renderer/src/features/workbench/panel-tab-drag.ts', { plugins: [stubStore] })

  const ids = (group) => group.surfaces.map((item) => item.id).join(',')
  const sides = (entry) => rp.panelGroups(entry).map((group) => `${rp.groupSide(group)}:${ids(group)}`).join(' | ')
  let entry = rp.EMPTY_PANEL
  for (const kind of ['files', 'terminal', 'context']) entry = rp.upsertSurface(entry, rp.toolSurface(kind))

  const left = rp.moveSurfaceToDock(entry, 'terminal', 'left')
  ok(sides(left) === 'right:files,context | left:terminal', '标签停靠到左侧：新建左侧分组，右侧保留其余标签', sides(left))
  ok(left.active === 'terminal' && left.open, '停靠后焦点落到被移动的标签')
  const both = rp.moveSurfaceToDock(left, 'context', 'bottom')
  ok(sides(both) === 'right:files | left:terminal | bottom:context', '再停靠到下方：三处各一组，侧边分组排在右侧列之后', sides(both))
  const joined = rp.moveSurfaceToDock(both, 'files', 'left')
  ok(sides(joined) === 'left:terminal,files | bottom:context', '停靠到已有左侧栏：并入同一组，右侧清空', sides(joined))
  ok(rp.rightGroupCount(rp.panelGroups(joined)) === 0, '右侧列数为 0')
  ok(rp.moveSurfaceToDock(joined, 'files', 'left') === joined, '已在目标停靠栏时不变')

  const back = rp.moveSurfaceToRight(joined, 'files')
  ok(sides(back) === 'right:files | left:terminal | bottom:context', '移回右侧：右侧重新出现一列', sides(back))
  const whole = rp.moveSurfaceToRight(back, 'context')
  ok(sides(whole) === 'right:files | right:context | left:terminal', '下方栏唯一标签移回右侧：整组转成右侧新列', sides(whole))
  const leftPair = rp.moveSurfaceToDock(joined, 'terminal', 'bottom')
  ok(rp.splitSurface(joined, 'files') === joined && rp.splitSurface(leftPair, 'files') === leftPair, '停靠栏里的标签不做列拆分')

  let full = rp.EMPTY_PANEL
  for (const kind of ['files', 'terminal', 'context', 'changes', 'logs']) full = rp.upsertSurface(full, rp.toolSurface(kind))
  full = rp.splitSurface(full, 'logs')
  full = rp.splitSurface(full, 'changes')
  ok(rp.rightGroupCount(rp.panelGroups(full)) === 3, '右侧已拆满 3 列')
  const fullDocked = rp.moveSurfaceToDock(full, 'files', 'bottom')
  ok(rp.rightGroupCount(rp.panelGroups(fullDocked)) === 3 && rp.dockGroupIndex(fullDocked, 'bottom') === 3, '右侧满列时仍可停靠到下方，停靠栏不占右侧列额度')
  const intoLast = rp.moveSurfaceToRight(fullDocked, 'files')
  ok(rp.rightGroupCount(rp.panelGroups(intoLast)) === 3 && rp.dockGroupIndex(intoLast, 'bottom') < 0, '右侧满列时移回右侧：并入最后一列，不超过上限', sides(intoLast))
  const resized = rp.resizeGroups(fullDocked, 0, 0.7)
  ok(rp.panelGroups(resized).slice(0, 3).every((group) => group.size > 0) && rp.panelGroups(resized)[3].size === 1, '调整右侧列宽不影响停靠栏分组')

  const closed = rp.closeSurface(both, 'terminal')
  ok(rp.dockGroupIndex(closed, 'left') < 0 && sides(closed) === 'right:files | bottom:context', '关掉停靠栏最后一个标签：停靠栏消失')

  const saved = rp.sanitizeRightPanel({
    version: 1,
    width: 720,
    dockLeft: 50,
    dockBottom: 'x',
    order: ['s:a'],
    byKey: { 's:a': { open: true, groups: [{ surfaces: [{ kind: 'files' }], size: 1 }, { surfaces: [{ kind: 'terminal' }], size: 1, side: 'left' }, { surfaces: [{ kind: 'context' }], size: 1, side: 'left' }, { surfaces: [{ kind: 'logs' }], size: 2, side: 'nowhere' }] } }
  })
  const restored = saved.byKey['s:a']
  ok(sides(restored) === 'right:files | right:logs | left:terminal,context', '恢复存档：重复的左侧分组合并，未知方向回到右侧', sides(restored))
  ok(saved.dockLeft === rp.DOCK_LEFT_MIN && saved.dockBottom === rp.DOCK_BOTTOM_DEFAULT, '停靠栏尺寸夹到下限，坏值回默认')
  const legacy = rp.sanitizeRightPanel({ version: 1, width: 720, order: ['home'], byKey: { home: { open: true, active: 'files', surfaces: [{ kind: 'files' }] } } })
  ok(sides(legacy.byKey.home) === 'right:files' && legacy.dockLeft === rp.DOCK_LEFT_DEFAULT, '旧版存档照常读取，全部在右侧')

  const chat = { left: 300, top: 50, width: 800, height: 600 }
  const columns = [{ left: 1100, top: 0, width: 400, height: 650 }]
  const layout = { columns, chat, left: null, bottom: null }
  const zone = (x, y, l = layout) => JSON.stringify(drag.panelDropZone(l, x, y, 0, null))
  ok(zone(350, 200) === '{"kind":"dock","side":"left"}', '对话区左侧四分之一：停靠到左侧')
  ok(zone(700, 600) === '{"kind":"dock","side":"bottom"}', '对话区下方：停靠到下方')
  ok(zone(1050, 200) === '{"kind":"edge","side":"left"}', '对话区右侧且右栏有列：贴右栏左边新建列')
  ok(zone(1050, 200, { ...layout, columns: [] }) === '{"kind":"right"}', '右栏没有列时：移回右侧面板')
  ok(zone(700, 200) === 'null', '对话区中间：不落')
  ok(zone(1300, 200) === '{"kind":"split","index":0}', '右栏内部沿用原有落点')
  ok(zone(150, 200, { ...layout, left: { left: 100, top: 0, width: 200, height: 650 } }) === '{"kind":"dock","side":"left"}', '已有左侧栏范围内：并入左侧栏')

  const box = drag.predictedDockBox(layout, { kind: 'dock', side: 'bottom' }, { left: 360, bottom: 280, right: 720 })
  ok(box.top === 50 + 600 - 280 + 8 && box.width === 800 - 16, '下方停靠预览贴在对话区底部', JSON.stringify(box))
  const half = drag.predictedDockBox(layout, { kind: 'dock', side: 'left' }, { left: 2000, bottom: 280, right: 720 })
  ok(half.width === 400 - 16, '左侧停靠预览最多占对话区一半', JSON.stringify(half))
  ok(drag.droppedEntry(entry, 'terminal', { kind: 'dock', side: 'left' }).groups.length === 2, '落点执行与状态函数一致')
})
