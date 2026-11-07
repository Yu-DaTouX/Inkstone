export const meta = { description: '假模型经 bash 调 yan phone devices / ui / key，验证 CLI→宿主→adb 全链路（需要连着真机，PHONE_DEVICE 指定序列号）；运行中截侧栏状态（圆环转动、只显示时长）' }

export default async function run({ cdp, box, waitFor, check, sleep, shot, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  const device = process.env.PHONE_DEVICE ?? ''
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send(${JSON.stringify(`PHONE${device ? ` PHONEDEV=${device}` : ''}`)})`)
  await waitFor(`!!document.querySelector('[data-status-icon="working"]')`, 30000, 50)
  const ring = await ev(`(() => { const el = document.querySelector('[data-status-icon="working"]'); const cs = getComputedStyle(el); const slot = el.parentElement; return { animation: cs.animationName, duration: cs.animationDuration, text: slot.innerText.trim(), title: slot.querySelector('[title]')?.title ?? '' } })()`)
  check('运行中圆环在转', ring.animation === 'spin', ring)
  check('状态只显示时长，「运行中」进提示', !ring.text.includes('运行中') && /\d+s/.test(ring.text) && ring.title === '运行中', ring)
  await shot('sidebar-running-dark')
  await waitFor(`(s.messages.at(-1)?.text ?? '').includes('手机测试结束')`, 120000, 200)
  const outputs = await ev(`window.__yanStore.getState().messages.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === 'bash').map((c) => String(c.output ?? ''))`)
  check('devices 经宿主返回设备列表', /"kind":"phone".*"action":"devices"/.test(outputs[0] ?? ''), (outputs[0] ?? '').slice(0, 300))
  check('ui 经宿主返回界面元素', /"action":"ui".*"elements":"e1 /.test(outputs[1] ?? ''), (outputs[1] ?? '').slice(0, 300))
  check('key 经宿主执行并回读界面', /"action":"key".*"key":"KEYCODE_HOME"/.test(outputs[2] ?? ''), (outputs[2] ?? '').slice(0, 300))
}
