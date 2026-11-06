import { mkdirSync } from 'node:fs'

export const meta = { description: '模型失败各类状态（502 / 额度 / 鉴权 / HTML 错页 / 断网 / 半途断开 / 挂起 / 间歇失败后重试）：逐帧采样错误卡进出、消息数回退、转圈卡死、原始英文与堆栈外露，并截图' }

const OUT = process.env.YAN_STATES_OUT ?? 'E:/pi-desktop/.local-docs/evidence/2026-11-07-night/states'

const probe = `(() => {
  const s = window.__yanStore.getState()
  const card = document.querySelector('[data-testid="v3-error-card"]')
  const sc = document.querySelector('[data-testid="v3-session-scroll"]') ?? document.querySelector('.v3-session-scroll')
  return {
    t: Date.now(),
    card: card ? card.innerText.slice(0, 300) : null,
    msgs: s.messages.length,
    running: !!(s.session?.isStreaming || s.session?.isAgentRunning),
    retry: s.session?.retry ? JSON.stringify(s.session.retry).slice(0, 120) : null,
    notices: (s.notices ?? []).map((n) => n.text ?? n.message ?? '').slice(0, 3),
    scrollTop: Math.round(sc?.scrollTop ?? -1),
    spinners: document.querySelectorAll('[class*="spin"], [class*="Spin"], [data-spinning="true"]').length
  }
})()`

async function sample(cdp, sleep, ms, every = 120, shots) {
  const rows = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { rows.push(await cdp.evaluate(probe)) } catch (error) { rows.push({ error: String(error).slice(0, 100) }) }
    if (shots) await shots(rows.length)
    else await sleep(every)
  }
  return rows
}

function analyse(rows) {
  const ok = rows.filter((r) => !r.error)
  let cardFlips = 0
  let msgDrops = 0
  for (let i = 1; i < ok.length; i++) {
    if (!!ok[i].card !== !!ok[i - 1].card) cardFlips++
    if (ok[i].msgs < ok[i - 1].msgs) msgDrops++
  }
  const texts = [...new Set(ok.map((r) => r.card).filter(Boolean))]
  return { frames: ok.length, cardFlips, msgDrops, texts, last: ok.at(-1) }
}

export default async function run({ cdp, box, fake, check, report, sleep, log, newSession, state, waitFor, until, shot }) {
  mkdirSync(OUT, { recursive: true })
  const cases = [
    ['FAIL', 'FAIL 502 普通失败', 25000],
    ['FAILQUOTA', 'FAILQUOTA 额度用完', 25000],
    ['FAILAUTH', 'FAILAUTH 鉴权失败', 25000],
    ['FAILHTML', 'FAILHTML 网关错页', 40000],
    ['FAILNET', 'FAILNET 断网', 40000],
    ['FAILMID', 'FAILMID 半途断开', 40000]
  ]
  report.cases = {}
  const only = process.env.YAN_STATES_ONLY?.split(',')
  for (const lang of (process.env.YAN_STATES_LANGS ?? 'zh-CN,en-US').split(',')) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: ${JSON.stringify(lang)} })`)
    for (const [tag, text, wait] of cases) {
      if (only && !only.includes(tag)) continue
      await newSession(box.project)
      await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify(text)})`)
      const rows = await sample(cdp, sleep, wait, 150, process.env.YAN_STATES_FRAMES === tag ? (i) => shot(`frame-${lang}-${tag}-${String(i).padStart(3, "0")}`) : null)
      const result = analyse(rows)
      const name = `${lang}-${tag}`
      report.cases[name] = { ...result, timeline: rows.map((r, i) => i === 0 || JSON.stringify([r.card, r.msgs, r.running, r.retry]) !== JSON.stringify([rows[i - 1].card, rows[i - 1].msgs, rows[i - 1].running, rows[i - 1].retry]) ? { dt: r.t - rows[0].t, card: r.card?.slice(0, 40) ?? null, msgs: r.msgs, running: r.running, retry: r.retry } : null).filter(Boolean) }
      log(name, { cardFlips: result.cardFlips, msgDrops: result.msgDrops, texts: result.texts, last: result.last })
      await shot(`${lang}-${tag}-end`)
      check(`${name} 最终有错误卡且不再运行`, !!result.last?.card && !result.last.running, result.last)
      check(`${name} 错误卡不反复进出`, result.cardFlips <= 2, result.cardFlips)
      check(`${name} 消息数不回退`, result.msgDrops === 0, result.msgDrops)
      const joined = result.texts.join(' | ')
      check(`${name} 无堆栈外露`, !/\bat \w+.*\.js:\d+|<html|<\/h1>/i.test(joined), joined.slice(0, 200))
    }
  }
}
