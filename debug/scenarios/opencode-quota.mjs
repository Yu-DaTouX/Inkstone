import { writeFileSync } from 'node:fs'

export const meta = { description: 'OpenCode 用量：Go 三窗口、Zen 控制台说明、查询失败保留读数；需 --quota，只有本机 fixture' }

export default async function run({ cdp, box, check, waitFor, sleep, shot }) {
  if (!box.quotaFixture) throw new Error('请加 --quota，隔离场景不查询真实 OpenCode 服务')
  const now = Date.now()
  const hour = 3_600_000
  const windows = [
    { id: 'rolling', label: '五小时', used: 37, total: 100, durationMs: 5 * hour, resetAt: now + 3 * hour },
    { id: 'weekly', label: '本周', used: 61, total: 100, durationMs: 7 * 24 * hour, resetAt: now + 2 * 24 * hour },
    { id: 'monthly', label: '本月', used: 74, total: 100, durationMs: 30 * 24 * hour, resetAt: now + 9 * 24 * hour }
  ]
  const cards = [
    { key: 'debug:opencode', source: 'yan', provider: 'opencode', name: 'OpenCode Zen', status: 'ok', windows: [], hint: 'Zen 余额暂不支持 API 查询，请在 OpenCode Console 查看。', checkedAt: now },
    { key: 'debug:opencode-go', source: 'yan', provider: 'opencode-go', name: 'OpenCode Go', status: 'ok', windows, checkedAt: now }
  ]
  writeFileSync(box.quotaFixture, JSON.stringify(cards))
  const report = await cdp.evaluate('window.yan.accountQuota()')
  check('真实 IPC 返回两张 OpenCode 用量卡', report.cards.some((card) => card.provider === 'opencode') && report.cards.some((card) => card.provider === 'opencode-go'))
  await cdp.evaluate('window.__yanRightPanel.getState().setOpen(true)')
  await cdp.evaluate('window.__yanRightPanel.getState().open({ id: "quota", kind: "quota" })')
  await cdp.evaluate('window.__yanRightPanel.getState().setMaximized(false); window.__yanRightPanel.getState().setWidth(360)')
  await waitFor('!!document.querySelector("[data-testid=v3-wb-quota-card-yan-opencode-go]")')
  for (const theme of ['dark', 'light']) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN' })`)
    await sleep(450)
    const go = await cdp.evaluate('document.querySelector("[data-testid=v3-wb-quota-card-yan-opencode-go]").textContent')
    const zen = await cdp.evaluate('document.querySelector("[data-testid=v3-wb-quota-card-yan-opencode]").textContent')
    check(`${theme}：Go 五小时、周、月读数可见`, ['37%', '61%', '74%'].every((value) => go.includes(value)), go)
    check(`${theme}：Zen 不显示虚构余额`, zen.includes('Console') && !zen.includes('$0.00') && !zen.includes('HTTP'), zen)
    check(`${theme}：Zen 提供控制台入口`, await cdp.evaluate('!!document.querySelector("[data-testid=v3-wb-quota-console]")'))
    const overflow = await cdp.evaluate('(() => { const pane = document.querySelector("[data-testid=v3-wb-quota]"); return pane.scrollWidth - pane.clientWidth })()')
    check(`${theme}：窄栏无横向溢出`, overflow === 0, overflow)
    await shot(`opencode-quota-${theme}`)
  }

  cards[1] = { ...cards[1], status: 'error', error: 'HTTP 503', windows: [] }
  writeFileSync(box.quotaFixture, JSON.stringify(cards))
  await cdp.evaluate('document.querySelector("[data-testid=v3-wb-quota-refresh]").click()')
  await waitFor('!!document.querySelector("[data-testid=v3-wb-quota-card-yan-opencode-go] [data-testid=v3-wb-quota-stale-error]")')
  const stale = await cdp.evaluate('document.querySelector("[data-testid=v3-wb-quota-card-yan-opencode-go]").textContent')
  check('查询失败保留旧读数并显示失败原因，不整卡消失', stale.includes('HTTP 503') && stale.includes('37%') && stale.includes('74%'), stale)
  await shot('opencode-quota-stale')
}
