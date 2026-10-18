import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const PROBE_MODEL = {
  claude: 'anthropic/claude-sonnet-4', codex: 'openai/gpt-5', deepseek: 'deepseek/deepseek-chat', qwen: 'qwen/qwen3-coder',
  gemini: 'google/gemini-2.5-pro', kimi: 'moonshot/kimi-k2', glm: 'zai/glm-4.6', grok: 'xai/grok-4', pi: 'mystery/unknown'
}

const temp = await mkdtemp(join(tmpdir(), 'yan-bot-icon-'))
try {
  const outfile = join(temp, 'bot-icon.mjs')
  await build({ entryPoints: ['src/main/bot-icon.ts'], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
  const { botIconDirs, botIconFile, notificationBotMood } = await import(pathToFileURL(outfile).href)
  const { MODEL_BRANDS } = await import(pathToFileURL((await bundleBrands(temp)).outfile).href)

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

  let checked = 0
  for (const brand of MODEL_BRANDS) {
    for (const mood of ['done', 'fail', 'ask', 'rest']) {
      for (const dark of [false, true]) {
        const file = real(PROBE_MODEL[brand], mood, dark)
        assert.ok(file, `${brand}/${mood} 缺少图标`)
        const png = readFileSync(file)
        assert.equal(png.subarray(1, 4).toString(), 'PNG')
        assert.equal(png.readUInt32BE(16), 128)
        assert.equal(png.readUInt32BE(20), 128)
        checked += 1
      }
    }
  }
  console.log(`✓ 通知 Bot 图标：状态映射、品牌选择、深浅主题回退、${checked} 个图标文件均为 128px PNG`)
} finally {
  await rm(temp, { recursive: true, force: true })
}

async function bundleBrands(temp) {
  const outfile = join(temp, 'brands.mjs')
  await build({ entryPoints: ['src/shared/model-brand.ts'], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
  return { outfile }
}
