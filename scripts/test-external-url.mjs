/**
 * 外部地址白名单（`src/main/external-url.ts`）：不启动 Electron、不联网。
 * 用法： node scripts/test-external-url.mjs
 */
import { build } from '../node_modules/esbuild/lib/main.js'

await build({
  entryPoints: ['src/main/external-url.ts'],
  outfile: 'out/test/external-url.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { openableExternalUrl, openableAuthUrl } = await import('../out/test/external-url.mjs')

let failed = 0
const ok = (cond, name) => {
  if (!cond) failed += 1
  console.log(`${cond ? '✓' : '✗'} ${name}`)
}

ok(openableExternalUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1', 'https 放行')
ok(openableExternalUrl('http://example.com') === 'http://example.com/', 'http 放行并规范化')
ok(openableExternalUrl('  mailto:a@b.co ') === 'mailto:a@b.co', 'mailto 放行')
for (const bad of [
  'file:///C:/Windows/System32/calc.exe',
  'ms-msdt:/id PCWDiagnostic',
  'search-ms:query=x',
  'vscode://x',
  'javascript:alert(1)',
  'data:text/html,x',
  'C:\\Windows\\System32\\calc.exe',
  '\\\\server\\share\\a.exe',
  'not a url',
  '',
  '   ',
  null,
  42
]) ok(openableExternalUrl(bad) === null, `拒绝 ${JSON.stringify(bad)}`)
ok(openableExternalUrl(`https://a.co/${'x'.repeat(9000)}`) === null, '超长地址拒绝')

ok(openableAuthUrl('https://auth.example.com/authorize?x=1') !== null, '授权页 https 放行')
ok(openableAuthUrl('http://auth.example.com/') === null, '授权页 http 拒绝')
ok(openableAuthUrl('mailto:a@b.co') === null, '授权页 mailto 拒绝')

if (failed) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('外部地址白名单：全部通过')
