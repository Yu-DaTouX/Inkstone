import { click } from '../lib/review-kit.mjs'

export const meta = { description: '全应用视觉统一：左栏玻璃、中间与右栏同色调，消息流、输入框和外围控件同一套底色、圆角与阴影；深浅色截图并统计各区域用到的取值', observation: true }

const AUDIT = `(() => {
  const regions = { side: '.v3-side', main: '.v3-main', panel: '.t3-rp' }
  const out = {}
  for (const [name, sel] of Object.entries(regions)) {
    const root = document.querySelector(sel)
    if (!root) continue
    const bg = new Map(), radius = new Map(), shadow = new Map()
    const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
    for (const node of [root, ...root.querySelectorAll('*')]) {
      const r = node.getBoundingClientRect()
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue
      const s = getComputedStyle(node)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') add(bg, s.backgroundColor)
      if (s.borderTopLeftRadius !== '0px') add(radius, s.borderTopLeftRadius)
      if (s.boxShadow !== 'none') add(shadow, s.boxShadow.replace(/\\s+/g, ' '))
    }
    const top = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ×' + n)
    out[name] = { surface: getComputedStyle(root).backgroundColor, backgrounds: top(bg), radii: top(radius), shadows: top(shadow) }
  }
  return out
})()`

export default async function run({ cdp, check, waitFor, sleep, newSession, shot, report }) {
  const ev = (expr) => cdp.evaluate(expr)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1480, height: 900, deviceScaleFactor: 1, mobile: false })
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({lang:'zh-CN',workspaceTiles:true,promptSuggestions:false,reduceMotion:true,windowGlass:'side'})`)
  await ev(`window.__yanStore.setState(s => ({ messages: [
    { id: 'u1', role: 'user', text: '看看导出脚本改了什么，再跑一下相关测试。' },
    { id: 'a1', role: 'assistant', text: '现在会先检查输出目录，已有同名文件时不再静默覆盖。\\n\\n- 新增 \`ensureFree()\`\\n- 测试 12/12 通过\\n\\n\`\`\`ts\\nexport function ensureFree(dir: string) {\\n  return !existsSync(dir)\\n}\\n\`\`\`',
      toolCalls: [{ id: 't1', name: 'bash', args: { command: 'npm test -- export' }, output: '12 passed', status: 'ok' }] },
    { id: 'u2', role: 'user', text: '好，再把额度面板打开看看。' }
  ], session: { ...s.session, isAgentRunning: false, isStreaming: false }, historyLoading: false, switchLoading: false }))`)
  await waitFor(`!!document.querySelector('.v3-conv [data-turn-id="a1"]')`, 12000)
  await ev(`window.__yanRightPanel.getState().open({ id: 'quota', kind: 'quota' })`)
  await waitFor(`!!document.querySelector('[data-testid="v3-wb-quota"]')`, 12000)
  await sleep(600)

  report.audit = {}
  for (const theme of ['dark', 'light']) {
    await ev(`window.__yanStore.getState().patchSettings({theme:${JSON.stringify(theme)}})`)
    await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`)
    await sleep(500)
    const audit = await ev(AUDIT)
    report.audit[theme] = audit
    check(`${theme} 中间与右栏同底`, !!audit.main && !!audit.panel, { main: audit.main?.surface, panel: audit.panel?.surface })
    await shot(`unify-${theme}`)
  }

  await click(cdp, '[data-chat-provider-model-picker]')
  await sleep(500)
  await shot('unify-light-model-menu')
  report.menu = await ev(`(() => { const n = document.querySelector('.t3-model-popover, .ui-float'); if (!n) return null; const s = getComputedStyle(n); return { bg: s.backgroundColor, radius: s.borderRadius, shadow: s.boxShadow } })()`)
}
