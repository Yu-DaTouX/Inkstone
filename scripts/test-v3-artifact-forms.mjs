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

const model = await loadTs('../src/renderer/src/features/artifacts/model.ts')
const mermaid = await loadTs('../src/renderer/src/features/artifacts/mermaid-theme.ts')

{
  assert.equal(model.inlineMaxHeight(1000), 700, 'min(70vh, 720)')
  assert.equal(model.inlineMaxHeight(2000), 720, 'vh 超过 720 时封顶 720')
  assert.equal(model.clampInlineHeight(900, 1000), 700)
  assert.equal(model.clampInlineHeight(400, 1000), 400)
  assert.equal(model.clampInlineHeight(Number.NaN, 1000), model.INLINE_MIN_HEIGHT, '非法高度退回下限')

  assert.equal(model.inlineOverflows(700, 1000), false, '正好到上限不算溢出')
  assert.equal(model.inlineOverflows(702, 1000), true, '超过上限 1px 以上才算溢出')
  assert.equal(model.inlineOverflows(1200, 1000), true)
  assert.equal(model.inlineOverflows(Number.NaN, 1000), false, '未回报自然高度不假装溢出')
}

{
  const viewport = { width: 1280, height: 800 }

  const fallback = model.defaultPipRect(viewport)
  assert.deepEqual(fallback, { x: 904, y: 484, width: 360, height: 300 }, '缺省贴右下角')
  assert.ok(model.clampFrameSize(fallback, model.PIP_SIZE).width === fallback.width)

  const moved = model.moveFrame({ x: 100, y: 100, width: 360, height: 300 }, 5000, 5000, viewport)
  assert.equal(moved.x, viewport.width - 360 - model.PIP_VIEWPORT_MARGIN, '向右拖出后夹回右上边界')
  assert.equal(moved.y, viewport.height - 300 - model.PIP_VIEWPORT_MARGIN, '向下拖出后夹回下边界')

  const back = model.moveFrame({ x: 900, y: 480, width: 360, height: 300 }, -5000, -5000, viewport)
  assert.equal(back.x, model.PIP_VIEWPORT_MARGIN, '向左上拖出后夹回左上边界')

  const resized = model.resizeFrame({ x: 40, y: 40, width: 360, height: 300 }, 5000, 5000, viewport)
  assert.deepEqual(
    { width: resized.width, height: resized.height },
    model.PIP_SIZE.max,
    '缩放不超过 PIP_SIZE 上限'
  )
  const shrunk = model.resizeFrame({ x: 40, y: 40, width: 360, height: 300 }, -5000, -5000, viewport)
  assert.deepEqual(
    { width: shrunk.width, height: shrunk.height },
    model.PIP_SIZE.min,
    '缩放不低于 PIP_SIZE 下限'
  )

  const tiny = model.clampFramePosition({ x: 100, y: 100, width: 720, height: 640 }, { width: 500, height: 400 })
  assert.equal(tiny.x, model.PIP_VIEWPORT_MARGIN)
  assert.equal(tiny.y, model.PIP_VIEWPORT_MARGIN)
}

{
  assert.deepEqual([...model.ARTIFACT_FORMS], ['inline', 'panel', 'fullscreen', 'pip'])
  for (const form of model.ARTIFACT_FORMS) assert.equal(model.isArtifactForm(form), true)
  assert.equal(model.isArtifactForm('hologram'), false)

  const identity = { sessionId: 's1', messageId: 'm1', partIndex: 2 }
  assert.equal(model.identityKey(identity), model.identityKey({ ...identity }), '身份在形态无关处稳定')
}

{
  assert.deepEqual(mermaid.MERMAID_THEME_TOKEN_NAMES, {
    bg: '--bg',
    surface: '--surface',
    surfaceAlt: '--hover',
    sunken: '--sunken',
    fg: '--fg',
    fgMute: '--fg3',
    line2: '--line2',
    accent: '--accent',
    font: '--font-ui'
  })

  const light = mermaid.mermaidThemeVariables({
    dark: false,
    bg: 'bg-light',
    surface: 'surface-light',
    surfaceAlt: 'hover-light',
    sunken: 'sunken-light',
    fg: 'fg-light',
    fgMute: 'fg3-light',
    line2: 'line2-light',
    accent: 'accent-light',
    font: 'font-light'
  })
  assert.equal(light.darkMode, false, '浅色主题随 data-theme 报告')
  assert.equal(light.background, 'bg-light')
  assert.equal(light.primaryColor, 'surface-light')
  assert.equal(light.primaryTextColor, 'fg-light')
  assert.equal(light.primaryBorderColor, 'accent-light')
  assert.equal(light.secondaryColor, 'hover-light')
  assert.equal(light.tertiaryColor, 'sunken-light')
  assert.equal(light.lineColor, 'fg3-light', '连线/网格用 fg3')
  assert.equal(light.noteBorderColor, 'line2-light')
  assert.equal(light.clusterBorder, 'line2-light')
  assert.equal(light.fontFamily, 'font-light')

  const dark = mermaid.mermaidThemeVariables({
    dark: true,
    bg: 'bg-dark',
    surface: 'surface-dark',
    surfaceAlt: 'hover-dark',
    sunken: 'sunken-dark',
    fg: 'fg-dark',
    fgMute: 'fg3-dark',
    line2: 'line2-dark',
    accent: 'accent-dark',
    font: 'font-dark'
  })
  assert.equal(dark.darkMode, true, '深色主题随 data-theme 报告')
  assert.equal(dark.background, 'bg-dark')
  assert.equal(dark.primaryBorderColor, 'accent-dark')
  for (const value of Object.values(dark)) {
    if (typeof value === 'string' && value !== '13px') {
      assert.ok(!/^#|^rgb/.test(value), '不出现硬编码色值：' + value)
    }
  }
}

{
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/features/artifacts/ArtifactFrame.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(source, /const frameKey = `\$\{key\}#\$\{reload\}`/, 'iframe key 由身份 + 主动重载组成')
  assert.match(source, /key=\{frameKey\}/, 'iframe 用 frameKey')
  assert.ok(!/frameKey[^\n]*\bform\b/.test(source), 'form 不得进入 iframe key')
  assert.ok(!/key=\{[^}]*\bform\b[^}]*\}/.test(source), '任何形态 key 都不能绑定 form')

  const markdown = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/features/session/Markdown.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(markdown, /MermaidBlock/, 'mermaid 段改用 MermaidBlock')
  assert.ok(!/VisualFallback/.test(markdown), '旧 mermaid 回退已移除')
}

console.log('test-v3-artifact-forms: all checks passed')
