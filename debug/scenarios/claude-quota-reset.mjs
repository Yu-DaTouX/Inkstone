import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { evidenceDir } from '../lib/env.mjs'
import { claudeQuotaFixture } from '../../scripts/fixtures/claude-quota.mjs'
import quotaStates from './quota-states.mjs'

export const meta = { description: 'Claude Fable 用量、两类重置卡、取消与二次确认；接口全部由隔离主进程桩替代，不消耗真实卡' }

async function mainInspector() {
  const port = process.env.YAN_DEBUG_MAIN_INSPECT
  if (!port) throw new Error('此场景需要 YAN_DEBUG_MAIN_INSPECT 指向隔离主进程')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data)
    if (reply.id) { pending.get(reply.id)?.(reply); pending.delete(reply.id) }
  }
  return {
    async evaluate(expression) {
      const reply = await new Promise((resolve) => {
        const request = ++id
        pending.set(request, resolve)
        ws.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      })
      if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text)
      return reply.result?.result?.value
    },
    close: () => ws.close()
  }
}

export default async function run({ cdp, runDir, check, sleep, waitFor }) {
  const main = await mainInspector()
  const output = evidenceDir('2026-11-11-claude-quota-reset')
  mkdirSync(output, { recursive: true })
  const prefix = String(Date.now())
  const bundle = join(runDir, 'claude-quota-shared.mjs')
  await build({ entryPoints: ['src/shared/account-quota.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const shared = await import(pathToFileURL(bundle).href)
  const payload = claudeQuotaFixture()
  const report = { checkedAt: Date.now(), cards: [{ key: 'fixture-claude', source: 'yan', provider: 'anthropic', name: 'Claude', plan: 'max', active: true, status: 'ok', checkedAt: Date.now(), windows: shared.claudeUsageWindows(payload), resetCredits: shared.claudeResetCredits(payload.cedar_ember, Date.now()) }] }
  try {
    const installed = await main.evaluate(`(() => {
      const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')
      if (electron.app.getAppPath().replaceAll('\\\\', '/') !== ${JSON.stringify(process.env.YAN_DEBUG_APP_DIR?.replaceAll('\\', '/'))}) throw new Error('不是本场景的隔离应用')
      if (!process.env.YAN_PI_DIR || !process.env.YAN_USER_DATA) throw new Error('缺少隔离数据目录')
      const channels = ['yan:accountQuota', 'yan:accountResetCredit']
      const original = channels.map((channel) => electron.ipcMain._invokeHandlers.get(channel))
      globalThis.__quotaResetFixture = { report: ${JSON.stringify(report)}, calls: [], restore() {
        channels.forEach((channel, index) => { electron.ipcMain.removeHandler(channel); if (original[index]) electron.ipcMain.handle(channel, original[index]) })
      } }
      channels.forEach((channel) => electron.ipcMain.removeHandler(channel))
      electron.ipcMain.handle(channels[0], () => globalThis.__quotaResetFixture.report)
      electron.ipcMain.handle(channels[1], (_event, provider, key, creditId) => {
        globalThis.__quotaResetFixture.calls.push({ provider, key, creditId })
        return { ok: true, outcome: 'reset' }
      })
      return true
    })()`)
    check('仅在隔离数据实例替换用量和重置接口', installed)
    const ev = (expression) => cdp.evaluate(expression)
    const calls = () => main.evaluate('globalThis.__quotaResetFixture.calls')
    const click = async (selector) => {
      await ev(`document.querySelector(${JSON.stringify(selector)})?.click()`)
      await sleep(180)
    }
    const row = (kind) => `[data-credit-kind="${kind}"]`
    const use = (kind) => `${row(kind)} [data-testid="v3-wb-quota-credit-use"]`
    await ev(`window.__yanRightPanel.getState().setOpen(true); window.__yanRightPanel.getState().open({ id: 'quota', kind: 'quota' })`)
    await waitFor(`document.querySelectorAll('[data-testid="v3-wb-quota-credits"]').length === 2`)
    check('Fable 显示模型名与 99% 用量', await ev(`Array.from(document.querySelectorAll('.wb-quota-win')).some((el) => el.innerText.includes('Fable') && el.innerText.includes('99%'))`))
    check('普通卡与 Fable 卡分别显示次数', await ev(`document.querySelector('${row('fable')}').innerText.includes('Fable 重置卡 ×1') && document.querySelector('${row('full')}').innerText.includes('普通重置卡 ×2')`))
    check('打开用量页不会消耗卡', (await calls()).length === 0)
    for (const theme of ['light', 'dark']) {
      await ev(`window.__yanStore.getState().patchSettings({ theme: '${theme}', lang: 'zh-CN' }); window.__yanRightPanel.getState().setWidth(340)`)
      await sleep(250)
      await cdp.shot(`${prefix}-quota-${theme}`, output)
      for (const kind of ['fable', 'full']) {
        await click(use(kind))
        await waitFor(`!!document.querySelector('[data-testid="v3-wb-quota-credit-confirm"]')`)
        const dialog = await ev(`document.querySelector('[role="alertdialog"]')?.innerText ?? document.querySelector('.ui-confirm')?.innerText`)
        check(`${theme}/${kind} 确认框明确卡种`, dialog?.includes(kind === 'fable' ? 'Fable 重置卡' : '普通重置卡'))
        check(`${theme}/${kind} 确认框明确重置范围`, kind === 'fable' ? dialog?.includes('不会清空其他模型用量') : dialog?.includes('5 小时') && dialog?.includes('本周'))
        const countBefore = (await calls()).length
        check(`${theme}/${kind} 首次点击只打开确认`, countBefore === 0)
        await cdp.shot(`${prefix}-confirm-${kind}-${theme}`, output)
        await click('.ui-confirm button')
        check(`${theme}/${kind} 取消不消耗卡`, (await calls()).length === countBefore)
      }
    }
    for (const kind of ['fable', 'full']) {
      await click(use(kind))
      await waitFor(`!!document.querySelector('[data-testid="v3-wb-quota-credit-confirm"]')`)
      await click('[data-testid="v3-wb-quota-credit-confirm"]')
      await waitFor(`!document.querySelector('[data-testid="v3-wb-quota-credit-confirm"]')`)
      const used = await calls()
      check(`${kind} 二次确认仅使用所选卡`, used.at(-1)?.creditId === (kind === 'fable' ? 'fable-grant' : 'normal-grant') && used.at(-1)?.key === 'fixture-claude')
      check(`${kind} 每次只发一个请求`, used.length === (kind === 'fable' ? 1 : 2))
    }
    await click(use('fable'))
    await main.evaluate(`globalThis.__quotaResetFixture.report.cards[0].resetCredits.groups[0].nextId = 'replacement-fable'`)
    await click('[data-testid="v3-wb-quota-refresh"]')
    check('刷新改变卡编号后不能把确认偷换到另一张卡', await ev(`document.querySelector('[data-testid="v3-wb-quota-credit-confirm"]')?.disabled === true`))
    await click('.ui-confirm button')
    await main.evaluate(`delete globalThis.__quotaResetFixture.report.cards[0].resetCredits.groups[0].nextId`)
    await click('[data-testid="v3-wb-quota-refresh"]')
    check('暂不可用的 Fable 卡仍显示库存且禁用按钮', await ev(`document.querySelector('${row('fable')}').innerText.includes('×1') && document.querySelector('${use('fable')}').disabled === true`))
    await ev(`window.__yanRightPanel.getState().setWidth(300)`)
    await sleep(250)
    check('窄右栏无横向溢出', await ev(`(() => { const el = document.querySelector('[data-testid="v3-wb-quota"]'); return el.scrollWidth <= el.clientWidth })()`))
    await cdp.shot(`${prefix}-quota-narrow-unavailable`, output)
    check('所有重置只落到假接口', (await calls()).length === 2)
    await quotaStates({ cdp: { ...cdp, shot: (name) => cdp.shot(`${prefix}-${name}`, output) }, check, sleep })
  } finally {
    await main.evaluate('globalThis.__quotaResetFixture?.restore(); delete globalThis.__quotaResetFixture').catch(() => {})
    main.close()
  }
}
