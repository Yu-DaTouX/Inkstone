export const meta = { description: '带图消息触发模型错误（FAIL）后点重试：重试请求里仍带原图（图片已落盘只剩文件地址），读不回时给错误提示而不是不带图重发' }

export default async function run({ cdp, box, fake, check, report, sleep, log, newSession, state, waitFor, until }) {
  const ev = (expr) => cdp.evaluate(expr)
  await newSession(box.project)
  const images = await ev(`(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 64); return [{ data: c.toDataURL('image/png').split(',')[1], mimeType: 'image/png' }] })()`)
  await ev(`window.__yanStore.getState().send('FAIL 带图重试', ${JSON.stringify(images)})`)
  const found = await until(`!!document.querySelector('[data-testid="v3-error-card"]')`, 120000)
  check('出现错误卡', found)
  if (!found) return
  const before = fake.requests.length
  const first = fake.requests.slice(0, before).map((r) => r.images)
  log('first requests images', first)
  const clicked = await ev(`(() => { const card = document.querySelector('[data-testid="v3-error-card"]'); const b = [...card.querySelectorAll('button')].find((x) => /重试|Retry/.test(x.textContent)); if (!b) return false; b.click(); return true })()`)
  check('点到重试', clicked)
  await until(`false`, 1)
  const t = Date.now()
  const failing = () => fake.requests.slice(before).filter((r) => r.text.startsWith('FAIL'))
  while (Date.now() - t < 60000 && failing().length === 0) await sleep(200)
  const after = failing()
  report.retry = { first, after: after.map((r) => ({ text: r.text, images: r.images })) }
  log('retry', report.retry)
  check('重试请求发出且带原图', after.length > 0 && after.every((r) => r.images >= 1), report.retry)
  const msgImages = await state('s.messages.filter((m) => m.role === "user").flatMap((m) => m.images ?? []).map((im) => ({ data: im.data.length, url: !!im.url }))')
  report.msgImages = msgImages
  check('消息里不再持有 base64', msgImages.length > 0 && msgImages.every((im) => im.data === 0 && im.url), msgImages)
}
