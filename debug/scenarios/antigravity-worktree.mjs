import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installAntigravityFixture } from '../lib/antigravity-fixture.mjs'
import { shotKit } from '../lib/ui-shots.mjs'

export const meta = { description: '新建会话选 Antigravity 后开工作树发送，新工作树会话保持 Antigravity 后端' }

export default async function run({ box, cdp, runDir, check, waitFor, sleep }) {
  const { effortFailure } = installAntigravityFixture(box)
  writeFileSync(join(dirname(effortFailure), 'start-delay.txt'), String(process.env.YAN_AGY_START_DELAY_MS ?? 2500))
  const kit = shotKit(cdp, runDir)
  const ev = (expression) => cdp.evaluate(expression)
  const app = 'window.__yanStore.getState()'
  const picker = '[data-chat-provider-model-picker]'
  const menu = '[data-model-picker-content]'
  const worktree = '[data-testid="composer-worktree"]'
  const click = async (selector) => {
    assert.ok(await ev(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.disabled) return false; target.click(); return true })()`), selector)
  }
  const choose = async (providerId, text, wait = true) => {
    await click(picker)
    const tab = `[data-model-picker-provider="${providerId}"] button`
    await waitFor(`!!document.querySelector(${JSON.stringify(tab)})`)
    await click(tab)
    const option = `Array.from(document.querySelectorAll('${menu} [role="option"]')).find(e => e.textContent.includes(${JSON.stringify(text)}))`
    await waitFor(`!!(${option})`)
    assert.ok(await ev(`(() => { const row = ${option}; row?.click(); return !!row })()`))
    if (wait) await waitFor(`s.session?.model?.provider === ${JSON.stringify(providerId)}`)
    for (let index = 0; index < 3 && await ev(`!!document.querySelector('${menu}')`); index++) await kit.key('Escape')
    await waitFor(`!document.querySelector('${menu}')`)
  }
  const toggleWorktree = async () => {
    await waitFor(`!!document.querySelector('${worktree}')`)
    assert.ok(await kit.click(worktree))
    await waitFor(`document.querySelector('${worktree}')?.hasAttribute('data-selected')`)
  }

  const project = mkdtempSync(join(tmpdir(), 'inkstone-agy-worktree-'))
  assert.equal(spawnSync('git', ['init', '-q', project], { windowsHide: true }).status, 0)
  assert.equal(spawnSync('git', ['-C', project, '-c', 'user.name=Inkstone Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture', '--allow-empty'], { windowsHide: true }).status, 0)
  writeFileSync(join(box.piDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  await waitFor('!!s.settings?.cwd')
  await ev(`${app}.newSession({ cwd: ${JSON.stringify(project)} })`)
  await waitFor(`s.session?.cwd === ${JSON.stringify(project)} && s.conn === 'ready'`)
  await ev(`${app}.openSettings('models')`)
  await waitFor('!!document.querySelector(\'[data-testid="ms-antigravity-connect"]\')')
  await click('[data-testid="ms-antigravity-connect"]')
  await waitFor('document.querySelector(\'[data-testid="ms-service-antigravity"]\')?.textContent.includes("3 个模型")')
  await ev(`${app}.closeSettings()`)

  const rounds = Number(process.env.YAN_AGY_WORKTREE_ROUNDS || 6)
  const outcomes = []
  for (let round = 0; round < rounds; round++) {
    const text = `工作树首条 ${round}`
    await ev(`${app}.newSession({ cwd: ${JSON.stringify(project)} })`)
    await waitFor(`s.session?.cwd === ${JSON.stringify(project)} && s.conn === 'ready' && !s.messages.length`)
    const toastsBefore = await ev(`document.querySelectorAll('.ui-toast').length`)
    const order = ['model-first', 'worktree-first', 'send-while-switching'][round % 3]
    if (order === 'worktree-first') {
      await toggleWorktree()
      await choose('antigravity', 'Gemini Pro')
    } else {
      await choose('antigravity', 'Gemini Pro', order === 'model-first')
      await toggleWorktree()
    }
    await ev(`document.querySelector('[data-testid="composer-input"]').focus()`)
    await cdp.call('Input.insertText', { text })
    await waitFor("!!document.querySelector('.composer-v3 .t3-send:not(:disabled)')")
    await click('.composer-v3 .t3-send')
    let outcome
    for (let i = 0; i < 300 && !outcome; i++) {
      outcome = await ev(`(() => {
        const s = ${app}
        const toasts = [...document.querySelectorAll('.ui-toast')].slice(${toastsBefore}).map(n => n.textContent.trim()).filter(t => t.includes('Antigravity') || t.includes('工作树'))
        const failed = toasts.find(t => !t.includes('已创建') || t.includes('未能'))
        const replied = s.messages.some(m => m.role === 'assistant' && m.entryId && m.text.includes('模拟回复')) && !s.session?.isAgentRunning && !s.session?.isStreaming
        if (!failed && !replied) return null
        return { failed: failed ?? null, replied, provider: s.session?.model?.provider ?? null, worktree: s.session?.cwd !== ${JSON.stringify(project)},
          sent: s.messages.some(m => m.role === 'user' && m.text === ${JSON.stringify(text)}) }
      })()`)
      if (!outcome) await sleep(100)
    }
    outcome ??= { timeout: true, provider: await ev(`${app}.session?.model?.provider ?? null`) }
    outcomes.push({ round, order, ...outcome, runners: await ev(`window.yan.runnerStatuses()`) })
    writeFileSync(join(runDir, 'outcomes.json'), JSON.stringify(outcomes, null, 2))
    if (!outcome.replied) await kit.shot(`round-${round}-failed`, { native: false })
  }
  writeFileSync(join(runDir, 'outcomes.json'), JSON.stringify(outcomes, null, 2))
  const bad = outcomes.filter((item) => !item.replied || item.provider !== 'antigravity' || !item.worktree || !item.sent)
  check(`工作树首条消息 ${rounds} 轮都在 Antigravity 后端的新工作树里发出`, bad.length === 0, bad.length ? bad : undefined)
}
