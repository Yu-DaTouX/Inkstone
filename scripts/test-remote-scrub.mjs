import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'remote-scrub-'))
const root = process.cwd().split('\\').join('/')
const entry = join(dir, 'entry.ts')
await writeFile(entry, `export { scrubRemoteError } from '${root}/src/main/remote-server'\n`)
const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', external: ['electron'] })
const file = join(dir, 'bundle.mjs')
await writeFile(file, result.outputFiles[0].text)
const { scrubRemoteError } = await import(pathToFileURL(file).href)

assert.equal(scrubRemoteError('open C:\\Users\\x\\a.txt failed').includes('Users'), false, 'Windows 盘符路径被抹掉')
assert.equal(scrubRemoteError('open \\\\host\\share\\a.txt'), 'open …', 'UNC 路径被抹掉')
assert.equal(scrubRemoteError('open /home/dev/a.txt'), 'open …', 'POSIX 家目录路径被抹掉')
assert.equal(scrubRemoteError('请求 https://example.com/a 失败'), '请求 https://example.com/a 失败', '网址里的 s:/ 不是盘符，不能被当成路径抹掉')
assert.equal(scrubRemoteError('模型 gpt-5:/x 不可用'), '模型 gpt-5:/x 不可用', '单字母之外的 xx:/ 不是盘符')
console.log('remote-scrub ok')
process.exit(0)
