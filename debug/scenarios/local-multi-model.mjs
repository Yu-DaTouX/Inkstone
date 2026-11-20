import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evidenceDir } from '../lib/env.mjs'

const EVIDENCE = evidenceDir('2026-11-20-local-multi-model')

export const meta = { description: '本地多模型设置菜单与模型选择器验收（深浅主题、添加/删除、窄屏）' }

export default async function run({ cdp, box, runDir, check, sleep, waitFor }) {
  mkdirSync(EVIDENCE, { recursive: true })
  const scriptsDir = join(runDir, 'local-scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const qwenBat = join(scriptsDir, '启动-NInfer.bat')
  const scarletBat = join(scriptsDir, '启动-ScarletKc2.bat')
  const stopBat = join(scriptsDir, '停止-NInfer.bat')
  writeFileSync(qwenBat, '@echo off\r\n')
  writeFileSync(scarletBat, '@echo off\r\n')
  writeFileSync(stopBat, '@echo off\r\n')

  const modelsPath = join(box.piDir, 'models.json')
  const existing = JSON.parse(readFileSync(modelsPath, 'utf8'))
  existing.providers.ninfer = {
    name: '本地 NInfer (8080)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    api: 'openai-completions',
    apiKey: 'ninfer-local',
    models: [
      {
        id: 'qwen3.8-27b-orcarouter-v21',
        name: 'Qwen3.8-27B',
        contextWindow: 65536,
        maxTokens: 8192,
        reasoning: true,
        input: ['text', 'image']
      },
      {
        id: 'scarletkc-2.0',
        name: 'ScarletKc2',
        contextWindow: 49152,
        maxTokens: 8192,
        reasoning: true,
        input: ['text', 'image']
      }
    ]
  }
  writeFileSync(modelsPath, JSON.stringify(existing, null, 2))
  writeFileSync(
    join(box.dataDir, 'local-models.json'),
    JSON.stringify(
      {
        launchers: {
          ninfer: {
            stopCommand: stopBat,
            models: {
              'qwen3.8-27b-orcarouter-v21': { command: qwenBat },
              'scarletkc-2.0': { command: scarletBat }
            }
          }
        }
      },
      null,
      2
    )
  )

  const patch = (theme) => cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: ${JSON.stringify(theme)}, lang: 'zh-CN' })`)
  await patch('dark')
  await sleep(400)
  await cdp.evaluate(`window.__yanStore.getState().openSettings('models')`)
  await sleep(1000)

  const hasRow = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="ms-local-launch-row-ninfer"]');
    if (el) el.scrollIntoView({ block: 'start' });
    return !!el;
  })()`)
  check('本地服务卡片已渲染', hasRow)
  await sleep(400)

  const modelCards = await cdp.evaluate(`document.querySelectorAll('[data-testid="ms-local-launch-row-ninfer"] .ms-local-model-card').length`)
  check('两个本地模型分别渲染为独立配置块', modelCards === 2, modelCards)
  await cdp.shot('01-local-models-dark', EVIDENCE)

  await cdp.evaluate(`document.querySelector('[data-testid="ms-local-add-model-ninfer"]')?.click()`)
  await sleep(400)
  const formVisible = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="ms-local-add-form-ninfer"]');
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  })()`)
  check('点击添加模型展开内联表单', formVisible)
  await sleep(300)
  await cdp.shot('02-local-add-form-dark', EVIDENCE)

  const addedRes = await cdp.evaluate(`window.yan.addLocalModel('ninfer', { id: 'demo-third', name: 'Demo3', contextWindow: 32768, reasoning: true })`)
  check('通过 IPC 添加第三个本地模型成功', addedRes?.launchers?.find((item) => item.provider === 'ninfer')?.models?.length === 3)
  await cdp.evaluate(`window.__yanStore.getState().closeSettings()`)
  await sleep(300)
  await cdp.evaluate(`window.__yanStore.getState().openSettings('models')`)
  await sleep(900)
  await cdp.evaluate(`document.querySelector('[data-testid="ms-local-model-remove-demo-third"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(200)
  const removedRes = await cdp.evaluate(`window.yan.removeLocalModel('ninfer', 'demo-third')`)
  check('通过 IPC 移除第三个本地模型成功', removedRes?.find((item) => item.provider === 'ninfer')?.models?.length === 2)

  await cdp.evaluate(`window.__yanStore.getState().closeSettings()`)
  await sleep(300)
  await patch('light')
  await cdp.evaluate(`window.__yanStore.getState().openSettings('models')`)
  await sleep(900)
  await cdp.evaluate(`document.querySelector('[data-testid="ms-local-launch-row-ninfer"]')?.scrollIntoView({ block: 'start' })`)
  await sleep(400)
  await cdp.shot('03-local-models-light', EVIDENCE)

  await patch('dark')
  await sleep(300)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 640, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  await cdp.evaluate(`document.querySelector('[data-testid="ms-local-launch-row-ninfer"]')?.scrollIntoView({ block: 'start' })`)
  await sleep(300)
  const overflow = await cdp.evaluate(`(() => { const c = document.querySelector('.ui-settings__content'); return c ? c.scrollWidth - c.clientWidth : null })()`)
  check('窄屏 640px 下本地模型设置无横向溢出', overflow === 0, overflow)
  await cdp.shot('04-local-models-narrow', EVIDENCE)
  await cdp.call('Emulation.clearDeviceMetricsOverride', {})
  await sleep(300)

  await cdp.evaluate(`window.__yanStore.getState().closeSettings()`)
  await waitFor(`s.models?.some((m) => m.provider === 'ninfer' && m.id === 'scarletkc-2.0')`, 15000)
  await sleep(400)
  await cdp.evaluate(`document.querySelector('[data-chat-provider-model-picker="true"]')?.click()`)
  await sleep(500)
  await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('[data-model-picker-sidebar] button'));
    const target = buttons.find((b) => /ninfer/i.test(b.getAttribute('aria-label') || b.textContent || '') || b.getAttribute('data-provider-instance') === 'ninfer');
    target?.click();
  })()`)
  await sleep(400)
  const pickerInfo = await cdp.evaluate(`(() => {
    const groups = document.querySelectorAll('[data-model-picker-group]').length;
    const rows = Array.from(document.querySelectorAll('.t3-model-row .t3-model-row__name')).map((n) => n.textContent?.trim());
    return { groups, rows };
  })()`)
  check('模型选择菜单本地服务商平铺列出两个模型且不被拆分组', pickerInfo.groups === 0 && pickerInfo.rows.includes('ScarletKc2') && pickerInfo.rows.includes('Qwen3.8-27B'), pickerInfo)
  await cdp.shot('05-model-picker-local-dark', EVIDENCE)
}
