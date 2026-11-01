import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const meta = { demo: true, description: 'UI 审查：深色、中文、窗口最大化、左栏最窄（240）后运行 UI_AUDIT_SCRIPT 指向的脚本，截图存 UI_AUDIT_OUT' }

export default async function run(ctx) {
  const script = process.env.UI_AUDIT_SCRIPT
  if (!script) throw new Error('缺环境变量 UI_AUDIT_SCRIPT（审查脚本路径）')
  const out = resolve(process.env.UI_AUDIT_OUT || ctx.runDir)
  mkdirSync(out, { recursive: true })
  const { cdp, sleep, until, log } = ctx
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await cdp.evaluate(`localStorage.setItem('inkstone.v3.sidebarWidth', '240')`)
  if (!(await cdp.evaluate(`window.__yanStore.getState().maximized`))) await cdp.evaluate(`window.yan.win.maximize()`)
  await sleep(1000)
  await cdp.call('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await until(`s.conn === 'ready'`, 60000)
  await sleep(1500)
  const layout = await cdp.evaluate(`(() => { const side = document.querySelector('.v3-sidebar-resizer')?.getBoundingClientRect(); return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, maximized: screen.availWidth - outerWidth <= 16 && screen.availHeight - outerHeight <= 16, sidebarRight: side ? Math.round(side.left) : null, theme: document.documentElement.dataset.theme ?? document.documentElement.className } })()`)
  log('审查布局', layout)
  ctx.check('窗口已最大化', layout.maximized === true, layout)
  const shot = (name) => cdp.shot(name, out)
  const mod = await import(pathToFileURL(resolve(script)).href)
  await mod.default({ ...ctx, shot, out })
}
