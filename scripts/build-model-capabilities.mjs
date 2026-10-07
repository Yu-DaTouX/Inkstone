/**
 * 把 src/shared/custom-provider.ts 打成随包 pi 扩展能直接 import 的 ESM：
 * resources/pi-extensions/generated/model-capabilities.mjs。
 *
 * 设置页的自定义服务（主进程）与内置 Command Code 扩展（pi 进程）用同一套
 * 「端点信息 + pi 模型目录 → 模型能力」的判断，不各写一份。生成物提交进仓库，
 * 改了 TS 源却忘了重新生成时 `--check` 失败（test-unit 会跑）。
 *
 * 用法：
 *   node scripts/build-model-capabilities.mjs          # 重新生成
 *   node scripts/build-model-capabilities.mjs --check  # 只比对
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'src/shared/custom-provider.ts')
const outputPath = resolve(root, 'resources/pi-extensions/generated/model-capabilities.mjs')
const checkOnly = process.argv.includes('--check')

const source = await readFile(sourcePath, 'utf8')
const sourceHash = createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex')
const result = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  logLevel: 'silent'
})
const expected = `/* 由 src/shared/custom-provider.ts 生成，勿手改；重新生成：node scripts/build-model-capabilities.mjs\n * source-sha256: ${sourceHash}\n */\n${result.outputFiles[0].text}`

if (checkOnly) {
  const current = await readFile(outputPath, 'utf8').catch(() => '')
  if (current.replace(/\r\n/g, '\n') !== expected) {
    console.error('✗ resources/pi-extensions/generated/model-capabilities.mjs 与 TS 源不一致 —— 跑 node scripts/build-model-capabilities.mjs')
    process.exit(1)
  }
  console.log('✓ model-capabilities.mjs 与 TS 源一致')
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, expected, 'utf8')
  console.log(`已写入 ${outputPath}`)
}
