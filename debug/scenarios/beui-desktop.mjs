import { seedBeuiDemo } from '../lib/beui-demo.mjs'
import { shotKit } from '../lib/ui-shots.mjs'

export const meta = { description: 'beUI 桌面五项：图片翻页缩放、双图对照、引用清单、窄栏菜单、生图原位状态；本地夹具' }

export default async function run({ cdp, box, runDir, newSession, waitFor, check, shot, sleep }) {
  const ev = (code) => cdp.evaluate(code)
  const kit = shotKit(cdp, runDir)
  const find = (s) => `document.querySelector(${JSON.stringify(s)})`
  const click = async (s) => {
    await waitFor(`!!${find(s)}`)
    await ev(`${find(s)}.click()`)
  }
  const shown = (s) => `!!${find(s)}?.getClientRects().length`
  const slot = '[data-testid="generated-image-slot"]'
  const open = '.v3-artifact-image-open'
  const image = '.imgv-image'
  await newSession()
  const demo = await seedBeuiDemo(cdp, box)
  await demo.show('generating')
  await waitFor(shown(`${slot}[data-image-state="generating"] [data-testid="image-generation-progress"]`))
  const measure = () => ev(`${find(`${slot} .v3-artifact-image`)}.getBoundingClientRect().height`)
  const beforeHeight = await measure()
  await ev(`(${find(slot)}.scrollIntoView({block:'center'}), true)`)
  await kit.clip('generation-active', slot)
  await demo.show('done')
  await waitFor(shown(`${slot}[data-image-state="done"] ${open}`))
  const afterHeight = await measure()
  check('真实事件夹具让成图占用同一格，图像视窗高度不变', beforeHeight > 0 && Math.abs(beforeHeight - afterHeight) <= 1, { beforeHeight, afterHeight })
  await demo.show('error')
  await waitFor(`${find(`${slot}[data-image-state="error"]`)}?.textContent.includes('本地夹具失败回执')`)
  check('失败保留真实回执，不显示活动加载图标', await ev(`!${find(`${slot} .ui-term-spinner`)}`))
  await demo.show('done')

  const sources = '[data-testid="reply-sources-toggle"]'
  await click(sources)
  const row = '[data-testid="reply-source"]'
  await waitFor(shown(row))
  check('来源清单只显示正文引用过的唯一来源，并保留编号', await ev(`document.querySelectorAll('${row}').length === 1 && ${find(row)}.innerText.includes('工作台设计规范') && ${find(row)}.innerText.startsWith('1')`))
  const stream = await ev(`(() => {const r=${find('.v3-stream')}.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}})()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...stream, deltaX: 0, deltaY: -320 })
  await sleep(280)
  await ev(`(${find(row)}.scrollIntoView({block:'center', behavior:'instant'}), true)`)
  await sleep(280)
  if (await ev(`(() => {const el=${find(row)}; const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left+35,r.top+r.height/2))})()`)) {
    await kit.clip('reply-sources', '[data-testid="reply-sources"]')
  }
  await click(`${row} button`)
  check('回到引用会聚焦原正文链接', await ev(`document.activeElement?.matches('[data-citation-reply] [data-citation-number="1"]')`))

  await click(`${open}[aria-label$="工作台预览-v2.png"]`)
  await waitFor(`${find(image)}?.naturalWidth === 720`)
  check('大图没有外框或底板，没有关闭按钮，标题居中无阴影，底部工具独立悬浮', await ev(`(() => {
    const modal=${find('.imgv-modal')}, viewport=${find('.imgv-viewport')}, dock=${find('.imgv-dock')};
    return [modal, viewport].every(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(el).boxShadow === 'none') &&
      dock.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom && !modal.querySelector('.imgv-close') && getComputedStyle(modal.querySelector('.imgv-label')).boxShadow === 'none' && getComputedStyle(modal.querySelector('.imgv-label')).textAlign === 'center';
  })()`))
  await sleep(250)
  await shot('image-viewer-frameless-dark')
  const viewport = '[data-testid="image-viewer-viewport"]'
  const index = '[data-testid="image-viewer-index"]'
  const next = '[data-testid="image-viewer-next"]'
  const previous = '[data-testid="image-viewer-previous"]'
  const symmetric = `(() => {
    const l=${find(`${previous} span`)}.getBoundingClientRect(), r=${find(`${next} span`)}.getBoundingClientRect(), v=${find(viewport)}.getBoundingClientRect();
    return l.width>=39 && Math.abs(l.width-r.width)<0.5 && Math.abs(l.height-r.height)<0.5 &&
      Math.abs(l.top-r.top)<0.5 && Math.abs((v.left-l.right)-(r.left-v.right))<0.5;
  })()`
  check('两侧箭头同样大小、与图片等距且居中', await ev(symmetric))
  const edgePositions = `(() => [${find(`${previous} span`)},${find(`${next} span`)}].map(el => {
    const r=el.getBoundingClientRect();return r.top+r.height/2;
  }))()`
  const atMidline = async () => ev(`${edgePositions}.every(y => Math.abs(y-innerHeight/2)<1)`)
  check('箭头初始位于窗口中线', await atMidline())
  const wheel = async (deltaX, deltaY, modifiers = 0, point) => {
    point ??= await ev(`(() => {const r=${find(viewport)}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY, modifiers })
  }
  const anchor = await ev(`(() => {const r=${find(image)}.getBoundingClientRect();return {x:Math.round(r.left+r.width*0.33),y:Math.round(r.top+r.height*0.39)}})()`)
  const zoomValue = `Number(${find(viewport)}.style.getPropertyValue('--imgv-zoom'))`
  const anchoredWheel = async (delta, point) => {
    const before = await ev(`(() => {const r=${find(image)}.getBoundingClientRect();return {zoom:${zoomValue},u:(${point.x}-r.left)/r.width,v:(${point.y}-r.top)/r.height}})()`)
    await wheel(0, delta, 2, point)
    await waitFor(`(${zoomValue}-${before.zoom})*${Math.sign(delta)}<0`)
    return ev(`(() => {const r=${find(image)}.getBoundingClientRect();return Math.abs(r.left+${before.u}*r.width-${point.x})<=2 && Math.abs(r.top+${before.v}*r.height-${point.y})<=2})()`)
  }
  check('Ctrl+滚轮放大后鼠标仍指向同一个图像位置', await anchoredWheel(-120, anchor))
  check('Ctrl+滚轮不翻页或缩放整个窗口', await ev(`(() => {
    const el=${find(viewport)};return el.scrollWidth>el.clientWidth && ${find(index)}.textContent==='2 / 3' && visualViewport.scale===1;
  })()`))
  await shot('image-viewer-zoom')
  const pan = await ev(`(() => {const r=${find(viewport)}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pan, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pan.x - 80, y: pan.y, buttons: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pan.x - 80, y: pan.y, button: 'left', clickCount: 1 })
  check('滚轮放大后仍能拖动图片，不会误翻页', await ev(`${find(viewport)}.scrollLeft>0 && ${find(index)}.textContent==='2 / 3'`))
  const panned = { x: Math.round(pan.x + 30), y: Math.round(pan.y - 45) }
  check('拖动之后，Ctrl+滚轮继续以鼠标为中心放大和缩小', await anchoredWheel(-120, panned) && await anchoredWheel(120, panned))
  await wheel(0, 120, 2)
  await waitFor(`!${find(viewport)}?.hasAttribute('data-zoomed')`)
  check('Ctrl+反向滚轮缩小，不切到下一张', await ev(`${find(index)}.textContent==='2 / 3'`))
  await wheel(0, -120)
  await waitFor(`${find(index)}.textContent==='1 / 3'`)
  check('首张仍保留左右对称，上一张按钮置灰且不响应', await ev(`${symmetric} && ${find(previous)}.disabled && getComputedStyle(${find(previous)}).opacity==='0.4'`))
  await wheel(120, 0)
  await waitFor(`${find(index)}.textContent==='2 / 3'`)
  await wheel(120, 0)
  check('普通滚轮能前后翻页，同向连续事件不会立刻跳过多张', await ev(`${find(index)}.textContent==='2 / 3'`))
  await waitFor(`${find(image)}?.naturalWidth === 720`)
  await kit.click(next, 150)
  await waitFor(`${find(index)}.textContent==='3 / 3'`)
  check('换到无说明的图片，两个箭头仍在窗口中线', await atMidline())
  check('末张仍保留左右对称，下一张按钮置灰且不响应', await ev(`${symmetric} && ${find(next)}.disabled && getComputedStyle(${find(next)}).opacity==='0.4'`))
  await kit.click(previous, 150)
  await waitFor(`${find(index)}.textContent==='2 / 3'`)
  check('点击图片旁边的左右热区可前后翻页', true)
  await click('[data-testid="image-viewer-zoom-in"]')
  await click('[data-testid="image-viewer-compare"]')
  const slider = '.ui-image-wipe input[type="range"]'
  await waitFor(`!!${find(slider)}`)
  check('切换到对照模式，两个箭头仍在窗口中线', await atMidline())
  await ev(`(${find(slider)}.focus(), true)`)
  await kit.key('ArrowRight')
  check('同一成果的两个已知版本支持键盘调整分界线', await ev(`${find(slider)}.value === '51'`))
  check('查看器对照轨道无外框且分界线跟随图片高度', await ev(`(() => {
    const track=${find('.ui-image-wipe__track')};
    return getComputedStyle(track).boxShadow === 'none' && track.clientHeight > 100 && Math.abs(track.clientWidth / track.clientHeight - 1.6) < 0.02;
  })()`))
  await shot('image-viewer-compare')
  await kit.click(next, 150)
  check('成果图片可翻页，下一张不继承放大和对照状态', await ev(`${find(image)}?.alt === '另一张示例图.png' && !${find('[data-zoomed]')}`))
  await kit.key('Escape')
  await waitFor(`!${find('[data-testid="image-viewer"]')}`)

  await kit.theme('light')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 600, deviceScaleFactor: 1, mobile: false })
  await click(`${open}[aria-label$="工作台预览-v2.png"]`)
  await waitFor(`${find(image)}?.naturalWidth === 720`)
  await sleep(250)
  check('浅色窄窗下工具可换行，图片和按钮都在窗口内', await ev(`(() => {
    const scope=${find('[data-testid="image-viewer"]')};
    return [...scope.querySelectorAll('button, .imgv-viewport')].every(el => {const r=el.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;});
  })()`))
  check('浅色窄窗下两侧按钮仍同尺寸、等距', await ev(symmetric))
  await shot('image-viewer-frameless-light-narrow')
  const blank = await ev(`(() => {const r=${find('.imgv-head')}.getBoundingClientRect(); return {x: r.left + 8, y: r.top + r.height / 2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...blank, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  await waitFor(`!${find('[data-testid="image-viewer"]')}`)
  await cdp.call('Emulation.clearDeviceMetricsOverride')
  await kit.theme('dark')

  await ev(`(() => { const rp=window.__yanRightPanel.getState();rp.open({id:'changes',kind:'changes'});rp.setOpen(true) })()`)
  await click('[data-path="beui-compare.png"] .ui-collapsible__trigger')
  const compare = '[data-testid="changes-image-compare"]'
  await click(compare)
  await waitFor(shown('.changes-pane .ui-image-wipe'))
  check('Git 修改前后图可由并排切换到拖动对照', await ev(`document.querySelectorAll('.changes-pane .ui-image-wipe img').length === 2`))
  await kit.clip('git-compare', '.changes-pane .ui-image-wipe')
  await ev(`(window.__yanRightPanel.getState().setOpen(false), window.location.hash='#/artifacts', true)`)
  await click('[data-testid="v3-artifact-library-view-grid"]')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 850, deviceScaleFactor: 1, mobile: false })
  await waitFor(shown('.artifact-library-card'))
  const more = '[data-testid="artifact-library-more"]'
  await waitFor(shown(more))
  await ev(`(${find(more)}.focus(), true)`)
  await kit.key('Enter')
  await waitFor(shown('[role="menu"][aria-label="更多操作"]'))
  check('窄卡仅保留置顶和更多，键盘能打开次要操作', await ev(`document.querySelectorAll('[role="menu"][aria-label="更多操作"] [role="menuitem"]').length === 3 && !${find('.artifact-library-card .artifact-library-secondary-actions')}?.getClientRects().length`))
  await shot('artifact-overflow')
  await kit.key('Escape')
  await click('.artifact-library-thumb-image')
  await waitFor(`${find(image)}?.naturalWidth === 720`)
  check('从成果库打开看图器可翻看筛选结果中的图片', await ev(`${find('[data-testid="image-viewer-index"]')}?.textContent.endsWith('/ 2')`))
  await kit.key('Escape')
  await cdp.call('Emulation.clearDeviceMetricsOverride')
  await sleep(150)
}
