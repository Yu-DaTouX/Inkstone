export const meta = { description: '汇报三层字色：主体标准字、*附带说明* 变浅不倾斜、**需要注意** 加粗更亮，深浅主题截图' }

export default async function run({ cdp, check, waitFor, turn, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await turn('请按 REPORTDEMO 汇报')
  await waitFor(`(s.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '').includes('跑之前会先问你')`, 20000)
  await sleep(600)
  const styles = await ev(`(() => {
    const prose = [...document.querySelectorAll('.v3-stream .v3-prose')].at(-1)
    if (!prose) return null
    const em = prose.querySelector('em'), strong = prose.querySelector('strong'), p = prose.querySelector('p')
    const pick = (el) => el ? (({ color, fontStyle, fontWeight }) => ({ color, fontStyle, fontWeight }))(getComputedStyle(el)) : null
    return { em: pick(em), strong: pick(strong), p: pick(p) }
  })()`)
  check('回复里有浅色说明与加粗', !!styles?.em && !!styles?.strong, styles)
  check('附带说明不倾斜', styles?.em?.fontStyle === 'normal', styles?.em)
  check('附带说明颜色比正文浅', !!styles && styles.em.color !== styles.p.color, styles)
  check('加粗为 700', styles?.strong?.fontWeight === '700', styles?.strong)
  check('加粗颜色与正文不同（更亮）', !!styles && styles.strong.color !== styles.p.color, styles)
  await shot('report-tiers-dark')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(500)
  await shot('report-tiers-light')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark' })`)
}
