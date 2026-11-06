export const probe = `(() => {
  const s = window.__yanStore.getState()
  const card = document.querySelector('[data-testid="v3-error-card"]')
  const sc = document.querySelector('.v3-stream')
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

export async function sample(cdp, sleep, ms, every = 120, shots) {
  const rows = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { rows.push(await cdp.evaluate(probe)) } catch (error) { rows.push({ error: String(error).slice(0, 100) }) }
    if (shots) await shots(rows.length)
    else await sleep(every)
  }
  return rows
}

export function analyse(rows) {
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


export function timeline(rows) {
  const key = (r) => JSON.stringify([r.card, r.msgs, r.running, r.retry])
  return rows.map((r, i) => (i === 0 || key(r) !== key(rows[i - 1]) ? { dt: r.t - rows[0].t, card: r.card?.slice(0, 40) ?? null, msgs: r.msgs, running: r.running, retry: r.retry?.slice(0, 60) ?? null, scrollTop: r.scrollTop } : null)).filter(Boolean)
}
