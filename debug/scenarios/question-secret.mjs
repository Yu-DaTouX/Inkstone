import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SECRET_TEST_MARKER } from '../lib/fake-model.mjs'

export const meta = { description: '模型索要密码：提问卡切成密文输入，值只进环境变量，模型请求、工具结果和磁盘文件都没有原文' }

function filesContaining(root, needle) {
  const hits = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && statSync(path).size < 64 * 1024 * 1024) {
        try {
          if (readFileSync(path).includes(needle)) hits.push(path)
        } catch (error) {
          if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error
        }
      }
    }
  }
  walk(root)
  return hits
}

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('SECRETASK')`)
  await waitFor(`!!document.querySelector('[data-testid="v3-question-secret"]')`, 30000, 50)
  await sleep(300)
  const input = await ev(`document.querySelector('[data-testid="v3-question-secret"]').type`)
  check('识别到要密码时切成密文输入', input === 'password', input)
  check('自动识别的卡片有按普通文本回答的入口', await ev(`!!document.querySelector('[data-testid="v3-question-secret-plain"]')`))
  for (const theme of ['light', 'dark']) {
    await ev(`document.documentElement.setAttribute('data-theme', '${theme}')`)
    await sleep(200)
    await shot(`secret-card-${theme}`)
  }

  await ev(`(() => {
    const el = document.querySelector('[data-testid="v3-question-secret"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(SECRET_TEST_MARKER)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(100)
  await ev(`document.querySelector('[data-testid="v3-question-form-submit"]').click()`)

  await waitFor(`document.body.innerText.includes('MODEL-CLEAN') || document.body.innerText.includes('MODEL-SAW-SECRET')`, 60000, 100)
  await sleep(1500)
  await shot('secret-answered')
  const seen = await ev(`document.body.innerText`)
  check('模型请求里没有密文原文', seen.includes('MODEL-CLEAN') && !seen.includes('MODEL-SAW-SECRET'))
  check('界面上没有密文原文', !seen.includes(SECRET_TEST_MARKER))

  const output = await ev(`JSON.stringify(window.__yanStore.getState().messages.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === 'bash').map((c) => c.output ?? c.result ?? c))`)
  report.bashOutput = output
  check('bash 拿到了环境变量，输出被替换', output.includes('pw=[REDACTED]') && !output.includes(SECRET_TEST_MARKER), output)
  const encoded = Buffer.from(SECRET_TEST_MARKER).toString('base64')
  check('base64 形式也被替换', !output.includes(encoded), output)

  const root = dirname(box.userData)
  const raw = filesContaining(root, SECRET_TEST_MARKER)
  const b64 = filesContaining(root, encoded)
  report.filesWithSecret = raw
  report.filesWithBase64 = b64
  check('运行目录里没有文件含密文原文', raw.length === 0, raw)
  check('运行目录里没有文件含密文 base64', b64.length === 0, b64)
}
