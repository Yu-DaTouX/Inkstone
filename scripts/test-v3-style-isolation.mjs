import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkV3StyleIsolation } from './design/check-v3-style-isolation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, '.tmp'), { recursive: true })
const dir = await mkdtemp(join(root, '.tmp/v3-style-isolation-'))
const entry = join(dir, 'entry.ts')
const font = '@fontsource/maple-mono'
try {
  await writeFile(entry, "import './theme.css'; export const ready = true\n")
  await writeFile(join(dir, 'theme.css'), "/* @import '@fontsource/comment-only'; */\n:root { --example: '@import text'; }\n")
  assert.equal(checkV3StyleIsolation(entry).violations.length, 0, '注释或文本不是活的样式依赖')

  await writeFile(join(dir, 'theme.css'), `@import '${font}';\n`)
  const nested = checkV3StyleIsolation(entry)
  assert.equal(nested.violations.length, 1, '必须识别 CSS @import 间接带回的字体包')
  assert.equal(nested.violations[0].file, font)

  await writeFile(join(dir, 'theme.css'), `@import url("${font}");\n`)
  assert.equal(checkV3StyleIsolation(entry).violations.length, 1, '带 url() 的字符串导入也必须拒绝')

  await writeFile(entry, `import '${font}';\n`)
  assert.equal(checkV3StyleIsolation(entry).violations.length, 1, '界面字体包不能经值导入回来')

  await writeFile(entry, `import type { Unused } from '${font}'; export type Font = typeof import('@fontsource/not-loaded');\n`)
  assert.equal(checkV3StyleIsolation(entry).violations.length, 0, '纯类型导入不是运行时样式')

  await writeFile(entry, `export { Font } from '${font}';\n`)
  assert.equal(checkV3StyleIsolation(entry).violations.length, 1, '不能借值导出重新加载字体包')

  await writeFile(join(dir, 'glob-hit.ts'), `import '${font}';\n`)
  await writeFile(entry, "const pages = import.meta.glob('./glob-*.ts');\n")
  assert.equal(checkV3StyleIsolation(entry).violations.length, 1, '懒加载 glob 的值依赖也必须扫描')
  await writeFile(entry, "const pages = import.meta.glob(['./glob-*.ts', '!./glob-hit.ts']);\n")
  assert.equal(checkV3StyleIsolation(entry).violations.length, 0, 'glob 排除模式不应制造假依赖')
  await writeFile(entry, "const pages = import.meta.glob('./optional-missing-*.tsx');\n")
  assert.equal(checkV3StyleIsolation(entry).unresolved.length, 0, '合法的可选模块 glob 空集不是缺模块')
  await writeFile(entry, "const pattern = './glob-*.ts'; const pages = import.meta.glob(pattern);\n")
  assert.equal(checkV3StyleIsolation(entry).unresolved.length, 1, '不能把不可静态解析的 glob 算已覆盖')

  await writeFile(entry, "import './missing-module';\n")
  assert.equal(checkV3StyleIsolation(entry).unresolved.length, 1, '缺模块不能报成已经核查通过')
  console.log('v3 样式隔离检查器：值导入、懒加载 glob、CSS 间接导入、字体包、纯类型与缺依赖正负对照通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
