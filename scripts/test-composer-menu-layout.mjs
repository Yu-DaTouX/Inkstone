import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const completionSource = fileURLToPath(new URL('../src/renderer/src/features/composer/useCompletion.ts', import.meta.url))
const completionBundle = await build({ entryPoints: [completionSource], bundle: true, write: false, platform: 'node', format: 'esm' })
const completion = await import(`data:text/javascript;base64,${Buffer.from(completionBundle.outputFiles[0].text).toString('base64')}`)

assert.equal(completion.toAbsoluteFilePath('/home/me/repo', 'src/a.ts'), '/home/me/repo/src/a.ts', 'POSIX 路径用正斜杠拼接')
assert.equal(completion.toAbsoluteFilePath('/home/me/repo/', 'src\\a.ts'), '/home/me/repo/src/a.ts', 'POSIX 路径把反斜杠归一成正斜杠')
assert.equal(completion.toAbsoluteFilePath('E:\\repo', 'src/a.ts'), 'E:\\repo\\src\\a.ts', 'Windows 路径用反斜杠拼接')
assert.equal(completion.toAbsoluteFilePath('E:\\repo', ''), 'E:\\repo', '空相对路径只返回根目录')

console.log('补全绝对路径拼接检查通过')
