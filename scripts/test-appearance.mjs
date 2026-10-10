/** 外观个性化（shared/appearance.ts、lib/background.ts）：纯函数，不启动 Electron。 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

export async function runAppearanceTests(ok) {
  await build({ entryPoints: ['src/shared/appearance.ts'], outfile: 'out/test/appearance.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  await build({ entryPoints: ['src/renderer/src/lib/background.ts'], outfile: 'out/test/background.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const a = await import(pathToFileURL('out/test/appearance.mjs').href)
  const bg = await import(pathToFileURL('out/test/background.mjs').href)

  ok(a.sanitizeFontName('  Microsoft   YaHei UI ') === 'Microsoft YaHei UI', '字体名：收空白')
  ok(a.sanitizeFontName('思源黑体 CN') === '思源黑体 CN', '字体名：允许汉字')
  ok(a.sanitizeFontName('x"; background:red') === undefined && a.sanitizeFontName('a{b}') === undefined, '字体名：引号、分号、括号拒绝')
  ok(a.sanitizeFontName('x'.repeat(65)) === undefined && a.sanitizeFontName(3) === undefined, '字体名：超长与非字符串拒绝')
  ok(a.sanitizeFontUiPreset('maple') === undefined && a.sanitizeFontUiPreset('serif') === 'serif' && a.sanitizeFontUiPreset('comic') === undefined, '界面字体预设：缺省落成未设置，未知值丢弃')
  ok(a.sanitizeFontCodePreset('mono') === 'mono' && a.sanitizeFontCodePreset('sans') === undefined, '代码字体预设只认等宽')
  ok(a.sanitizeFontSize(15, 12, 22, 15) === undefined, '字号：等于缺省不落盘')
  ok(a.sanitizeFontSize(40, 12, 22, 15) === 22 && a.sanitizeFontSize(3, 12, 22, 15) === 12 && a.sanitizeFontSize(16.6, 12, 22, 15) === 17, '字号：夹进区间并取整')
  ok(a.sanitizeFontSize('abc', 12, 22, 15) === undefined && a.sanitizeFontSize(0, 12, 22, 15) === undefined, '字号：脏值丢弃')
  ok(a.fontUiStack(undefined, undefined).startsWith("'Maple Mono CN'"), '界面字体缺省 Maple Mono CN')
  ok(a.fontUiStack('custom', 'Inter').startsWith('"Inter", ') && a.fontUiStack('custom', 'bad;') === a.fontUiStack(), '自定义字体：加引号接回退，非法名回到缺省')
  ok(/Segoe UI/.test(a.fontUiStack('sans')) && /PingFang SC/.test(a.fontUiStack('sans')) && /Noto Sans CJK SC/.test(a.fontUiStack('sans')), '系统无衬线覆盖 Windows / macOS / Linux')
  ok(/monospace$/.test(a.fontCodeStack('mono')) && /monospace$/.test(a.fontCodeStack('custom', 'Fira Code')), '代码字体以 monospace 收尾')

  ok(bg.customForTheme('#112233', '#eeeeee', 'light') === '#eeeeee' && bg.customForTheme('#112233', undefined, 'light') === '#112233', '浅色自定义优先，未设时沿用深色那一个')
  ok(bg.customForTheme('#112233', '#eeeeee', 'dark') === '#112233' && bg.customForTheme('nope', undefined, 'dark') === undefined, '深色用自己的自定义色，脏值忽略')
  ok(bg.resolveBackground('custom', '#ffffff', 'dark') !== '#ffffff' && bg.resolveBackground('custom', '#000000', 'light') !== '#000000', '自定义色夹进主题可读范围')
  ok(bg.resolveBackground('default', undefined, 'dark') === null && bg.resolveBackground('midnight', undefined, 'light') === '#eef2f8', '模板与缺省')

  /* 同值跳过：第二次应用不改样式 */
  const style = new Map()
  const root = { style: { setProperty: (k, v) => style.set(k, v), removeProperty: (k) => style.delete(k) } }
  ok(bg.applyBackground(root, 'midnight', undefined, 'dark') === true && style.get('--bg-0') === '#0f1623', '应用模板写入层级令牌')
  ok(bg.applyBackground(root, 'midnight', undefined, 'dark') === false, '同值再次应用跳过')
  ok(bg.applyBackground(root, 'default', undefined, 'dark') === true && !style.has('--bg-0'), '回到缺省删掉覆盖')
}
