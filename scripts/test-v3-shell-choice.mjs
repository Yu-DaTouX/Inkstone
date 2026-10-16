/** 只检查外壳选择纯函数；不启动应用、不读写用户设置、不调用模型。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/shared/ui-version.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const { asUiVersion, resolveUiVersion, uiVersionArgument } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

assert.equal(resolveUiVersion(undefined, undefined), 'v2')
assert.equal(resolveUiVersion(null, 'v3'), 'v3')
assert.equal(resolveUiVersion('v2', 'v3'), 'v2')
assert.equal(resolveUiVersion('v3', 'v2'), 'v3')
for (const dirty of [true, false, {}, [], 3, 'V3', 'v4', '', null, undefined]) {
  assert.equal(asUiVersion(dirty), null)
  assert.equal(resolveUiVersion(dirty, dirty), 'v2')
}
assert.equal(resolveUiVersion('bad', 'v3'), 'v3')
assert.equal(uiVersionArgument(['--yan-isolated-probe', '--yan-ui=v3']), 'v3')
assert.equal(uiVersionArgument(['--yan-ui=v2']), 'v2')
assert.equal(uiVersionArgument(['--yan-ui=bad']), null)
assert.equal(uiVersionArgument([]), null)
console.log('v3 外壳选择：默认值、环境优先、脏值拒绝、沙箱参数检查通过')
