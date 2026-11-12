export const meta = { description: '流式输出中右栏开合：消息流变窄再变宽后，末行不应留下旧高度造成的空白；用假模型，不调用真实模型' }

export default async function run({ cdp, box, check, report, sleep, newSession, turn, autoApprove }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light', lang: 'zh-CN', workspaceTiles: true, promptSuggestions: false })`)
  await ev(`window.__yanRightPanel.getState().setOpen(false)`)
  await autoApprove()
  await newSession(box.project)
  const measure = () => ev(`(() => {
    const scroller = document.querySelector('.v3-stream')
    const tail = scroller.querySelector('.v3-stream-row--tail') ?? scroller.querySelector('.v3-stream-inner')
    const last = tail.lastElementChild
    const natural = last ? last.getBoundingClientRect().bottom - tail.getBoundingClientRect().top : tail.getBoundingClientRect().height
    return { width: scroller.clientWidth, height: Math.round(tail.getBoundingClientRect().height), natural: Math.round(natural), minHeight: tail.style.minHeight }
  })()`)
  const samples = {}
  await turn('MDSHOW CHUNK4 GAP60 先写一大段', {
    timeout: 180000,
    during: async () => {
      await sleep(2500)
      samples.wide = await measure()
      await ev(`window.__yanRightPanel.getState().setOpen(true)`)
      await sleep(1200)
      samples.narrow = await measure()
      await ev(`window.__yanRightPanel.getState().setOpen(false)`)
      await sleep(1200)
      samples.restored = await measure()
    }
  })
  report.samples = samples
  console.log(JSON.stringify(samples))
  const gap = (sample) => sample.height - sample.natural
  const extra = gap(samples.restored) - gap(samples.wide)
  check('变窄后末行确实变高', samples.narrow.natural > samples.wide.natural + 20, samples)
  check('变宽还原后末行没有残留旧高度的空白（相对变窄前）', extra <= 24, { extra, samples })
}
