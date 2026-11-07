export const meta = { description: '顶栏「项目 / 会话标题」：空间够时项目名完整显示，变窄时项目名先缩；三种窗口宽度截图' }

export default async function run({ cdp, check, waitFor, sleep, shot, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await turn('你好')
  await waitFor(`!!document.querySelector('.v3-head-crumb')`, 20000)
  await ev(`(() => { document.querySelector('.v3-head-crumb').textContent = '水杉输入法'; const t = document.querySelector('.v3-head-title__text'); t.textContent = '手机端适配' })()`)
  const measure = () => ev(`(() => { const c = document.querySelector('.v3-head-crumb'); const t = document.querySelector('.v3-head-title__text'); return { crumbCut: c.scrollWidth > c.clientWidth + 1, crumbW: c.clientWidth, titleCut: t.scrollWidth > t.clientWidth + 1, titleW: t.clientWidth } })()`)
  for (const width of [1500, 900, 560]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const m = await measure()
    if (width >= 900) check(`${width}px：短标题时项目名与标题都不截断`, !m.crumbCut && !m.titleCut, m)
    else check(`${width}px：窄窗口下项目名仍保留一部分`, m.crumbW > 20, m)
    await shot(`head-crumb-${width}`)
  }
  await ev(`document.querySelector('.v3-head-title__text').textContent = '这是一个非常非常长的会话标题，用来看窄窗口下的截断顺序和效果是否合理'`)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const long = await measure()
  check('长标题时项目名仍保留可辨认的宽度', long.crumbW >= 40, long)
  await shot('head-crumb-long-900')
}
