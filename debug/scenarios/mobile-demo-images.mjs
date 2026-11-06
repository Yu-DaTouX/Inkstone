export const meta = { description: 'MOBILEDEMO 的工具结果图片：运行中只留文件地址（无 base64），界面里图片真正加载出来（naturalWidth > 0）' }

export default async function run({ cdp, box, check, report, sleep, newSession, state, turn, autoApprove, until }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('MOBILEDEMO 看图')`)
  await until(`s.messages.some((m) => (m.toolCalls ?? []).some((c) => (c.images ?? []).length))`, 60000)
  await sleep(1500)
  const imgs = await state('s.messages.flatMap((m) => m.toolCalls ?? []).flatMap((c) => c.images ?? []).map((im) => ({ data: im.data.length, url: im.url ?? null }))')
  report.imgs = imgs
  check('工具图片只留文件地址', imgs.length > 0 && imgs.every((im) => im.data === 0 && /^file:/.test(im.url ?? '')), imgs)
  const loaded = await ev(`new Promise((done) => { const img = new Image(); img.onload = () => done(img.naturalWidth > 0); img.onerror = () => done(false); img.src = ${JSON.stringify(imgs[0]?.url ?? '')} })`)
  check('渲染端能加载该文件地址', loaded)
}
