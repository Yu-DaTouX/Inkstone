import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

function constant(file, name) {
  const match = new RegExp(`export const ${name} = (\\d+)`).exec(readFileSync(resolve(root, file), 'utf8'))
  if (!match) throw new Error(`读不到 ${file} 的 ${name}`)
  return Number(match[1])
}

export function narrowPanelWidths() {
  return {
    sidebar: constant('src/renderer/src/features/sidebar/sidebar-layout.ts', 'SIDEBAR_WIDTH_MIN'),
    rightPanel: constant('src/renderer/src/state/right-panel.ts', 'PANEL_WIDTH_MIN'),
    tiles: constant('src/renderer/src/app/tiles-width.ts', 'TILES_WIDTH_MIN')
  }
}

export async function applyNarrowPanels(cdp, until) {
  const widths = narrowPanelWidths()
  let applied = null
  for (let attempt = 0; attempt < 3; attempt++) {
    applied = await writeAndReload(cdp, until, widths)
    if (applied.sidebar === widths.sidebar && applied.tiles === widths.tiles && applied.rightPanel === widths.rightPanel) break
  }
  return { widths, applied }
}

async function writeAndReload(cdp, until, widths) {
  await new Promise((done) => setTimeout(done, 1000))
  await cdp.evaluate(`(() => {
    localStorage.setItem('inkstone.v3.sidebarWidth', '${widths.sidebar}')
    localStorage.setItem('inkstone.v3.tilesWidth', '${widths.tiles}')
    window.__yanRightPanel?.getState().setWidth(${widths.rightPanel})
    const raw = JSON.parse(localStorage.getItem('inkstone.v3.rightPanel') ?? 'null')
    if (raw && typeof raw === 'object') localStorage.setItem('inkstone.v3.rightPanel', JSON.stringify({ ...raw, width: ${widths.rightPanel} }))
    return true
  })()`)
  await new Promise((done) => setTimeout(done, 400))
  await cdp.evaluate('location.reload()').catch(() => {})
  await new Promise((done) => setTimeout(done, 800))
  if (!(await until('true', 30000))) throw new Error('重载后渲染端没有暴露 __yanStore')
  await until('s.conn === "ready"', 60000)
  await new Promise((done) => setTimeout(done, 1000))
  return cdp.evaluate(`({ sidebar: Number(localStorage.getItem('inkstone.v3.sidebarWidth')), tiles: Number(localStorage.getItem('inkstone.v3.tilesWidth')), rightPanel: window.__yanRightPanel?.getState().width ?? null })`)
}
