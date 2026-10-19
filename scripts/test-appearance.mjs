import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runAppearanceTests(ok) {
  await build({ entryPoints: ['src/shared/appearance.ts'], outfile: 'out/test/appearance.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const a = await import(pathToFileURL('out/test/appearance.mjs').href)

  ok(a.sanitizeFontName('  Microsoft   YaHei UI ') === 'Microsoft YaHei UI', '字体名：收空白')
  ok(a.sanitizeFontName('思源黑体 CN') === '思源黑体 CN', '字体名：允许汉字')
  ok(a.sanitizeFontName('x"; background:red') === undefined && a.sanitizeFontName('a{b}') === undefined, '字体名：引号、分号、括号拒绝')
  ok(a.sanitizeFontName('x'.repeat(65)) === undefined && a.sanitizeFontName(3) === undefined, '字体名：超长与非字符串拒绝')
  ok(a.sanitizeFontUiPreset('maple') === 'maple' && a.sanitizeFontUiPreset('sans') === undefined && a.sanitizeFontUiPreset('serif') === 'serif' && a.sanitizeFontUiPreset('comic') === undefined, '界面字体预设：系统无衬线缺省，终端风格可落盘，未知值丢弃')
  ok(a.sanitizeFontCodePreset('maple') === 'maple' && a.sanitizeFontCodePreset('custom') === 'custom' && a.sanitizeFontCodePreset('mono') === undefined && a.sanitizeFontCodePreset('sans') === undefined, '代码字体预设：系统等宽缺省，Maple 与自定义可落盘，未知值丢弃')
  ok(a.sanitizeFontSize(15, 12, 22, 15) === undefined, '字号：等于缺省不落盘')
  ok(a.sanitizeFontSize(40, 12, 22, 15) === 22 && a.sanitizeFontSize(3, 12, 22, 15) === 12 && a.sanitizeFontSize(16.6, 12, 22, 15) === 17, '字号：夹进区间并取整')
  ok(a.sanitizeFontSize('abc', 12, 22, 15) === undefined && a.sanitizeFontSize(0, 12, 22, 15) === undefined, '字号：脏值丢弃')
  ok(a.resolveUiDensity(undefined) === 'compact' && a.resolveUiDensity('standard') === 'compact' && a.resolveUiDensity('compact') === 'compact', '密度：缺省、旧「标准」与紧凑都落到紧凑')
  ok(a.resolveUiDensity('comfortable') === 'comfortable' && a.resolveUiDensity('compact', 11) === 'compact', '密度：旧「宽松」映射为舒适，小字号保持紧凑')
  ok(a.resolveUiDensity('standard', 14) === 'comfortable' && a.resolveUiDensity('compact', 16) === 'comfortable' && a.resolveUiDensity(undefined, 13) === 'compact', '密度：旧界面字号调大（≥14）迁移为舒适')
  ok(a.resolveUiDensity('weird', 'abc') === 'compact', '密度：脏值回退紧凑')
}
