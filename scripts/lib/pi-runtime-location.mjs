import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { reportSkip } from './test-skip.mjs'

export function selectedPiRuntime(root) {
  const manifest = join(root, 'current.json')
  if (!existsSync(manifest)) return root
  const { generation } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof generation !== 'string' || !/^versions\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(generation)) {
    throw new Error('pi runtime current.json contains an invalid generation')
  }
  return join(root, generation)
}

export function bundledPiRuntimeForTest(label, root = resolve(process.env.YAN_TEST_PI_RUNTIME_ROOT ?? 'resources/pi-runtime')) {
  const dir = selectedPiRuntime(root)
  if (existsSync(join(dir, 'dist', 'bundle', 'cli.js'))) return dir
  const message = `${label}：缺少随包 pi 运行时 ${root}（先运行 npm run vendor:pi）`
  if (process.env.CI) throw new Error(message)
  reportSkip(`${message}，跳过`)
  return null
}
