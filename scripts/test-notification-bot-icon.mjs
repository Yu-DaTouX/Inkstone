import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'yan-bot-icon-'))
try {
  const outfile = join(temp, 'bot-icon.mjs')
  await build({ entryPoints: ['src/main/bot-icon.ts'], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
  const { botIconDirs, botIconFile, notificationBotMood } = await import(pathToFileURL(outfile).href)

  assert.equal(notificationBotMood('done'), 'done')
  assert.equal(notificationBotMood('error'), 'fail')
  assert.equal(notificationBotMood('question'), 'ask')
  assert.equal(notificationBotMood(undefined), 'rest')

  const dir = join(process.cwd(), 'resources', 'bot-icons')
  const real = (model, mood, dark = false) => botIconFile(model, mood, dark, { dir })
  assert.equal(real(undefined, 'done'), null)
  assert.equal(real(null, 'done'), null)
  assert.equal(real('', 'done'), null)
  assert.equal(real({ provider: '', id: '' }, 'done'), null)
  assert.match(real({ provider: 'anthropic', id: 'claude-sonnet-4' }, 'done'), /claude-done\.png$/)
  assert.match(real('deepseek/deepseek-chat', 'fail'), /deepseek-fail\.png$/)
  assert.match(real({ provider: 'openai', id: 'gpt-5' }, 'ask'), /codex-ask\.png$/)
  assert.match(real('moonshotai/kimi-k2', 'rest', false), /kimi-rest-light\.png$/)
  assert.match(real('moonshotai/kimi-k2', 'rest', true), /kimi-rest-dark\.png$/)
  assert.match(real('mystery/unknown', 'done'), /pi-done-(light|dark)\.png$/)

  const fake = new Set(['/i/claude-done.png', '/i/grok-ask-dark.png'])
  const probe = (model, mood, dark) => botIconFile(model, mood, dark, { dir: '/i', exists: (file) => fake.has(file.split(sep).join('/')) })
  assert.equal(probe('claude/x', 'done', true), join('/i', 'claude-done.png'))
  assert.equal(probe('claude/x', 'fail', true), null)
  assert.equal(probe('x-ai/grok-4', 'ask', true), join('/i', 'grok-ask-dark.png'))
  assert.equal(probe('x-ai/grok-4', 'ask', false), null)

  const dirs = botIconDirs('C:/app/resources', 'C:/app/out/main', 'C:/work')
  assert.equal(dirs.length, 3)
  assert.equal(botIconDirs(undefined, 'C:/app/out/main', 'C:/work').length, 2)

  console.log(`✓ 通知 Bot 图标：状态映射、品牌选择、深浅主题回退`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
