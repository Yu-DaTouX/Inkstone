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
  const swapped = rp.moveSurfaceToDock(both, 'files', 'left')
  ok(sides(swapped) === 'right:terminal | left:files | bottom:context', '拖到已有磁贴的位置：互换，原磁贴回右栏', sides(swapped))
  ok(swapped.open, '右栏还有标签时保持打开')
  ok(rp.moveSurfaceToDock(swapped, 'files', 'left') === swapped, '已在目标位置时不变')
  const emptied = rp.moveSurfaceToDock(rp.moveSurfaceToDock(rp.moveSurfaceToDock(entry, 'terminal', 'left'), 'context', 'bottom'), 'files', 'left')
  ok(sides(emptied) === 'right:terminal | left:files | bottom:context' && emptied.open, '右栏最后一个标签拖走但换回一个：右栏仍开', sides(emptied))
  const lastOut = rp.moveSurfaceToDock(rp.moveSurfaceToDock(rp.upsertSurface(rp.EMPTY_PANEL, rp.toolSurface('files')), 'files', 'left'), 'files', 'left')
  ok(sides(lastOut) === 'left:files' && !lastOut.open, '右栏最后一个标签变成磁贴：右栏按原规则收起，磁贴保留', sides(lastOut))
  const reopened = rp.upsertSurface({ ...lastOut, focus: 0 }, rp.toolSurface('logs'))
  ok(sides(reopened) === 'right:logs | left:files' && reopened.open, '焦点在磁贴上时新开面板：进右栏，不挤掉磁贴', sides(reopened))

  const back = rp.moveSurfaceToRight(swapped, 'files')
  ok(sides(back) === 'right:terminal,files | bottom:context', '磁贴移回右栏', sides(back))
  const whole = rp.moveSurfaceToRight(back, 'context')
  ok(sides(whole) === 'right:terminal,files,context', '下方磁贴移回右栏：作为标签并入右栏，不新拆列', sides(whole))
  const solo = rp.moveSurfaceToRight(lastOut, 'files')
  ok(sides(solo) === 'right:files' && solo.open, '右栏为空时移回：右栏重新打开', sides(solo))
  ok(rp.splitSurface(swapped, 'files') === swapped, '磁贴不做列拆分')

  let full = rp.EMPTY_PANEL
  for (const kind of ['files', 'terminal', 'context', 'changes', 'logs']) full = rp.upsertSurface(full, rp.toolSurface(kind))
  full = rp.splitSurface(full, 'logs')
  full = rp.splitSurface(full, 'changes')
  ok(rp.rightGroupCount(rp.panelGroups(full)) === 3, '右侧已拆满 3 列')
  const fullDocked = rp.moveSurfaceToDock(full, 'files', 'bottom')
  ok(rp.rightGroupCount(rp.panelGroups(fullDocked)) === 3 && rp.dockGroupIndex(fullDocked, 'bottom') === 3, '右侧满列时仍可停靠到下方，停靠栏不占右侧列额度')
  const intoLast = rp.moveSurfaceToRight(fullDocked, 'files')
  ok(rp.rightGroupCount(rp.panelGroups(intoLast)) === 3 && rp.dockGroupIndex(intoLast, 'bottom') < 0, '右侧满列时移回右侧：并入已有列，不超过上限', sides(intoLast))
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
  ok(sides(restored) === 'right:files,terminal | right:logs | left:context', '恢复存档：同一位置只留一张磁贴，多的回右栏，未知方向回到右侧', sides(restored))
  ok(saved.dockLeft === rp.DOCK_LEFT_MIN && saved.dockBottom === rp.DOCK_BOTTOM_DEFAULT, '停靠栏尺寸夹到下限，坏值回默认')
  const legacy = rp.sanitizeRightPanel({ version: 1, width: 720, order: ['home'], byKey: { home: { open: true, active: 'files', surfaces: [{ kind: 'files' }] } } })
  ok(sides(legacy.byKey.home) === 'right:files' && legacy.dockLeft === rp.DOCK_LEFT_DEFAULT, '旧版存档照常读取，全部在右侧')

  const chat = { left: 300, top: 50, width: 800, height: 600 }
  const columns = [{ left: 1100, top: 0, width: 400, height: 650 }]
  const layout = { columns, chat, left: null, bottom: null }
  const zone = (x, y, l = layout) => JSON.stringify(drag.panelDropZone(l, x, y, 0, null))
  ok(zone(350, 200) === '{"kind":"dock","side":"left"}', '对话区左侧四分之一：停靠到左侧')
  ok(zone(700, 600) === '{"kind":"dock","side":"bottom"}', '对话区下方：停靠到下方')
  ok(zone(1050, 200) === '{"kind":"right"}', '对话区右侧：回到右栏')
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
