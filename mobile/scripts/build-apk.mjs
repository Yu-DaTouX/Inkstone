// 构建手机端 APK 并整理到 release/apk-<版本>-<提交>/（附 SHA-256）。
// 直接调用 Gradle 而不是经 npm 脚本里的 `gradlew.bat`：后者依赖 npm 使用 cmd，换成 Git Bash 时找不到。
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(mobile, '..')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: mobile, shell: false, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（${result.status}）`)
}

/* Android SDK 位置：环境变量优先，其次 android/local.properties 的 sdk.dir。 */
function sdkDir() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME
  const file = join(mobile, 'android', 'local.properties')
  const match = existsSync(file) ? readFileSync(file, 'utf8').match(/^sdk\.dir=(.+)$/m) : null
  if (!match) throw new Error('找不到 Android SDK：设置 ANDROID_HOME，或在 android/local.properties 写 sdk.dir')
  return match[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':')
}

const sdk = sdkDir()
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
const node = process.execPath
run(node, ['scripts/sync-brand.mjs'])
run(node, ['scripts/sync-terminal.mjs'])
run(node, ['../node_modules/electron/cli.js', 'scripts/build-launcher-icons.mjs'])
if (process.platform === 'win32') run('cmd.exe', ['/c', join(mobile, 'android', 'gradlew.bat'), 'assembleRelease', '--console=plain'], { cwd: join(mobile, 'android'), env })
else run('./gradlew', ['assembleRelease', '--console=plain'], { cwd: join(mobile, 'android'), env })

const apk = join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const version = JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8')).version
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const outDir = join(root, 'release', `apk-${version}-${commit}`)
mkdirSync(outDir, { recursive: true })
const name = `Inkstone-mobile-${version}.apk`
copyFileSync(apk, join(outDir, name))
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex')
writeFileSync(join(outDir, 'SHA256.txt'), `${sha} *${name}\n`)
console.log(`\nAPK：${join(outDir, name)}\nSHA-256：${sha}\n沿用调试密钥签名，只供本机安装验证，不是公开发布包。`)
