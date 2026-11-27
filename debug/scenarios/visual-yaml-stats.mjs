export const meta = { description: '模型把 yan-stats 写成 YAML（真实样本：墨尔本四天天气）时，流式中显示「绘制中」、结束后画成指标块而不是报「图示数据无效」' }

export default async function run({ newSession, turn, cdp, check, shot, sleep }) {
  await newSession()
  let sawInvalidWhileLive = false
  await turn('VISUALGALLERY VGONLY=stats-yaml CHUNK12 GAP30', {
    during: async () => {
      for (let i = 0; i < 40; i++) {
        if (await cdp.evaluate(`!!document.querySelector('.v3-msg.assistant:last-of-type .v3-visual-invalid')`)) sawInvalidWhileLive = true
        await sleep(50)
      }
    }
  })
  await sleep(500)
  const view = await cdp.evaluate(`(() => {
    const msg = [...document.querySelectorAll('.v3-msg.assistant')].pop()
    return {
      invalid: !!msg?.querySelector('.v3-visual-invalid'),
      text: msg?.innerText ?? ''
    }
  })()`)
  check('流式中不报无效', !sawInvalidWhileLive)
  check('结束后画成指标块，不报「图示数据无效」', !view.invalid && !view.text.includes('图示数据无效'), view.text.slice(0, 200))
  check('四天数据与 hint 说明都显示', ['今天 11/27', '23.6° / 19.1°', '中阵雨，98% 有雨', '11/30', '小雨转凉，33%'].every((part) => view.text.includes(part)), view.text.slice(0, 300))
  await cdp.evaluate(`[...document.querySelectorAll('.v3-msg.assistant')].pop()?.scrollIntoView({ block: 'center' })`)
  await sleep(400)
  await shot('yaml-stats-light')
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
  await sleep(600)
  await shot('yaml-stats-dark')
}
