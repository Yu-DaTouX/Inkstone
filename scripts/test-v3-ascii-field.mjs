import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

async function loadTs(relativePath) {
  const source = fileURLToPath(new URL(relativePath, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const model = await loadTs('../src/renderer/src/features/ambient/ascii-field-model.ts')

{
  const n1 = model.valueNoise3(1.2, 3.4, 5.6, 7)
  assert.equal(n1, model.valueNoise3(1.2, 3.4, 5.6, 7))
  assert.ok(n1 >= 0 && n1 < 1, 'value noise 落在 [0,1)')
  const f = model.fbm(0.4, 0.9, 0.1, 3)
  assert.ok(f >= 0 && f < 1, '分形噪声归一化到 [0,1)')
}

{
  assert.equal(/[一-鿿]/.test(model.CHARSET), false, '字符集不含中文')
  assert.equal(/\s/.test(model.CHARSET), false, '字符集不含空白')
  assert.ok(/[A-Za-z]/.test(model.CORE) && /[0-9]/.test(model.CORE), '墨芯是字母数字')
  assert.ok(!/[A-Za-z0-9]/.test(model.DUST), '碎墨只用标点')
}

{
  assert.deepEqual(model.animationPolicy({ visible: true, focused: true, reducedMotion: false }), { active: true, fps: model.TARGET_FPS })
  assert.deepEqual(model.animationPolicy({ visible: true, focused: false, reducedMotion: false }), { active: false, fps: 0 })
  assert.deepEqual(model.animationPolicy({ visible: false, focused: true, reducedMotion: false }), { active: false, fps: 0 })
  assert.deepEqual(model.animationPolicy({ visible: true, focused: true, reducedMotion: true }), { active: false, fps: 0 })
  assert.equal(model.TARGET_FPS, 30, '聚焦目标 30fps')
  assert.equal(model.frameInterval(30), 1000 / 30)
  assert.equal(model.frameInterval(0), Number.POSITIVE_INFINITY)
}

{
  assert.equal(model.asciiBackgroundEnabled(undefined), true)
  assert.equal(model.asciiBackgroundEnabled(null), true)
  assert.equal(model.asciiBackgroundEnabled({}), true)
  assert.equal(model.asciiBackgroundEnabled({ asciiBackground: true }), true)
  assert.equal(model.asciiBackgroundEnabled({ asciiBackground: false }), false)
  assert.deepEqual(model.asciiBackgroundPatch(false), { asciiBackground: false })
  assert.deepEqual(model.asciiBackgroundPatch(true), { asciiBackground: true })
}

console.log('v3 主页 ASCII 背景纯逻辑：确定性 / 字符集 / 节拍 / 开关 全部通过')
