import { mkdirSync } from 'node:fs'

const EVIDENCE = 'E:/pi-desktop/.local-docs/evidence/2026-10-31-quota-t3'
const PREFIX = 'v2-'

export const meta = { demo: true, description: '右栏用量页：多账号 / 接近上限 / 已用尽 / 过期 / 错误 / 无数据 的浅深主题截图' }

const HOUR = 3600_000
const DAY = 24 * HOUR

const win = (id, label, used, durationMs, leftMs, extra = {}) => ({ id, label, used, total: 100, durationMs, resetAt: Date.now() + leftMs, ...extra })

const scenarios = () => {
  const now = Date.now()
  return {
    multi: {
      checkedAt: now,
      cards: [
        { key: 'a', source: 'yan', provider: 'openai-codex', name: 'main', label: '主号', email: 'main@example.com', plan: 'pro', active: true, switchable: true, status: 'ok', checkedAt: now,
          windows: [win('5h', '5 小时', 38, 5 * HOUR, 3 * HOUR + 12 * 60_000), win('weekly', '每周', 71, 7 * DAY, 2 * DAY + 4 * HOUR)] },
        { key: 'b', source: 'yan', provider: 'openai-codex', name: 'alt', label: '备用', email: 'backup-account@example.com', plan: 'plus', switchable: true, status: 'ok', checkedAt: now,
          windows: [win('5h', '五小时', 8, 5 * HOUR, 4 * HOUR + 30 * 60_000, { forecast: { kind: 'sampling', needMs: 15 * 60_000 } }), win('weekly', '本周', 12, 7 * DAY, 5 * DAY, { forecast: { kind: 'uncertain' } })] },
        { key: 'c', source: 'claude-code', provider: 'anthropic', name: 'claude', email: 'me@example.com', plan: 'max', active: true, status: 'ok', alsoIn: ['yan'], checkedAt: now,
          windows: [win('5h', '5 小时', 55, 5 * HOUR, 2 * HOUR), win('weekly', '每周', 24, 7 * DAY, 4 * DAY), win('monthly', '本月', 40, 30 * DAY, 12 * DAY, { estimated: true })] }
      ]
    },
    limit: {
      checkedAt: now,
      cards: [
        { key: 'a', source: 'yan', provider: 'openai-codex', name: 'main', label: '主号', email: 'main@example.com', plan: 'pro', active: true, status: 'limited', checkedAt: now,
          windows: [win('5h', '5 小时', 100, 5 * HOUR, 40 * 60_000, { exceeded: true }), win('weekly', '每周', 93, 7 * DAY, 1 * DAY)] },
        { key: 'b', source: 'yan', provider: 'anthropic', name: 'claude', email: 'me@example.com', plan: 'max', switchable: true, status: 'ok', checkedAt: now,
          windows: [win('5h', '5 小时', 82, 5 * HOUR, 90 * 60_000), win('weekly', '每周', 30, 7 * DAY, 3 * DAY)] },
        { key: 'c', source: 'yan', provider: 'google', name: 'gemini', email: 'g@example.com', status: 'expired', hint: '登录已过期，请在 设置 → 模型 重新登录', windows: [], checkedAt: now },
        { key: 'd', source: 'codex-cli', provider: 'openai-codex', name: 'cli', email: 'cli@example.com', plan: 'team', status: 'error', error: 'HTTP 429 请求过于频繁', windows: [], checkedAt: now },
        { key: 'e', source: 'gemini-cli', provider: 'google', name: 'old', email: 'old@example.com', status: 'ok', staleError: '网络超时', checkedAt: now - 3 * HOUR,
          windows: [win('5h', '5 小时', 20, 5 * HOUR, 2 * HOUR)] }
      ]
    },
    empty: { checkedAt: now, cards: [] }
  }
}

export default async function run({ cdp, check, sleep }) {
  mkdirSync(EVIDENCE, { recursive: true })
  const data = scenarios()
  await cdp.evaluate(`window.__yanRightPanel.getState().setOpen(true)`)
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'quota', kind: 'quota' })`)
  await sleep(600)
  const inject = (name) => cdp.evaluate(`(() => {
    const root = document.querySelector('[data-testid="v3-wb-quota"]')
    if (!root) return 'no-root'
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber'))
    let fiber = root[key]
    while (fiber && !(fiber.memoizedState && fiber.type && typeof fiber.type === 'function' && fiber.type.name === 'QuotaPane')) fiber = fiber.return
    if (!fiber) return 'no-fiber'
    const setters = []
    for (let hook = fiber.memoizedState; hook; hook = hook.next) if (hook.queue && typeof hook.queue.dispatch === 'function') setters.push(hook.queue.dispatch)
    if (setters.length < 4) return 'few-setters:' + setters.length
    const data = ${JSON.stringify(data)}
    const name = ${JSON.stringify(name)}
    setters[0](name === 'error' ? data.multi : data[name])
    setters[2](name === 'error' ? '无法连接额度服务' : '')
    return 'ok'
  })()`)
  const load = async (name) => {
    const result = await inject(name)
    if (result !== 'ok') throw new Error('注入失败：' + result)
    await sleep(500)
  }
  for (const theme of ['light', 'dark']) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN' })`)
    await sleep(500)
    for (const name of ['multi', 'limit', 'empty', 'error']) {
      await load(name)
      check(`${theme}/${name} 有内容`, await cdp.evaluate(`!!document.querySelector('[data-testid="v3-wb-quota"]')?.innerText`))
      await cdp.shot(`${PREFIX}quota-${name}-${theme}`, EVIDENCE)
    }
  }
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await load('multi')
  await cdp.evaluate(`window.__yanRightPanel.getState().setWidth?.(360)`)
  await sleep(500)
  const overflow = await cdp.evaluate(`(() => { const el = document.querySelector('[data-testid="v3-wb-quota"]'); return el ? el.scrollWidth - el.clientWidth : null })()`)
  check('用量页无横向溢出', overflow === 0, overflow)
  await cdp.shot(PREFIX + 'quota-multi-narrow', EVIDENCE)
}
