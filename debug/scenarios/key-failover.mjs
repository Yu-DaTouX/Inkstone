import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: 'API Key 失效：开关打开时切到下一个 Key 并继续，关闭时停在错误上；重启后的运行实例不需要再重启就用上新 Key' }

export default async function run({ cdp, box, waitFor, check, sleep, shot, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  const authKey = () => JSON.parse(readFileSync(join(box.piDir, 'auth.json'), 'utf8')).fake?.key
  const addKey = (key, label) => ev(`window.yan.addApiKey('fake', ${JSON.stringify(key)}, ${JSON.stringify(label)})`)
  const idle = `!!s.session?.sessionId && !window.__yanRuns.getState().runs.some((r) => r.phase.kind === 'running')`
  const settle = `!s.streaming && !window.__yanRuns.getState().runs.some((r) => r.phase.kind === 'running')`
  await autoApprove()
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)

  await addKey('good-key', 'Key 好')
  await addKey('bad-key', 'Key 坏')
  await sleep(6000)
  check('当前 Key 是失效的那个', authKey() === 'bad-key', authKey())

  await newSession(box.project)
  await waitFor(idle, 30000, 100)
  await ev(`window.__yanStore.getState().send('KEYFAILOVER off')`)
  await sleep(1500)
  await waitFor(settle, 60000, 100)
  await sleep(1000)
  check('开关关闭时不切 Key', authKey() === 'bad-key', authKey())
  const offText = await ev(`document.body.innerText`)
  check('开关关闭时停在错误上', !offText.includes('好的，收到。'))
  await shot('failover-off')

  await ev(`window.__yanStore.getState().patchSettings({ apiKeyFailover: true })`)
  await sleep(300)
  await newSession(box.project)
  await waitFor(idle, 30000, 100)
  await ev(`window.__yanStore.getState().send('KEYFAILOVER on')`)
  await waitFor(`document.body.innerText.includes('好的，收到。')`, 60000, 100)
  await sleep(800)
  await shot('failover-on')
  check('开关打开时切到下一个 Key', authKey() === 'good-key', authKey())
  check('切换后同会话继续并拿到回答', (await ev(`document.body.innerText`)).includes('好的，收到。'))
  const page = await ev(`document.body.innerText`)
  check('提示写明换了哪个 Key', page.includes('已切到 Key 好'))
  check('提示不含 Key 原文', !page.includes('good-key') && !page.includes('bad-key'))
  check('续跑提示说的是 Key 不可用', page.includes('API Key 不可用'))
}
