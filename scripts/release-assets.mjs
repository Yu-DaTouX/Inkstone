import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const source = process.env.YAN_RELEASE_SOURCE ?? 'release'
const out = process.argv[2] ?? join(source, 'public')
if (existsSync(out)) throw new Error(`输出目录已存在：${out}`)
mkdirSync(out, { recursive: true })

const pairs = [
  [`砚-${version}-setup.exe`, `Inkstone-${version}-win-1-setup.exe`],
  [`砚-${version}-setup.exe.blockmap`, `Inkstone-${version}-win-1-setup.exe.blockmap`],
  [`砚-${version}-portable.exe`, `Inkstone-${version}-win-2-portable.exe`],
  [`砚-${version}-portable-fast.zip`, `Inkstone-${version}-win-3-portable-fast.zip`]
]
for (const [from, to] of pairs) {
  if (!existsSync(join(source, from))) throw new Error(`缺少打包产物：${join(source, from)}`)
  copyFileSync(join(source, from), join(out, to))
}

const hash = (file, algorithm, encoding) => createHash(algorithm).update(readFileSync(file)).digest(encoding)
const setupName = pairs[0][1]
const setup = join(out, setupName)
const latestRaw = readFileSync(join(source, 'latest.yml'), 'utf8')
const oldUrl = /url: (.+)/.exec(latestRaw)?.[1]?.trim()
if (!oldUrl) throw new Error('latest.yml 里没有 url')
const latest = latestRaw.split(oldUrl).join(setupName)
if (!latest.includes(`version: ${version}`)) throw new Error(`latest.yml 的版本不是 ${version}`)
writeFileSync(join(out, 'latest.yml'), latest)
const latestSha512 = /^sha512: (.+)$/m.exec(latest)?.[1]?.trim()
const latestSize = Number(/size: (\d+)/.exec(latest)?.[1])
if (hash(setup, 'sha512', 'base64') !== latestSha512 || statSync(setup).size !== latestSize) throw new Error('latest.yml 的 sha512 或大小与安装包不一致')

const names = [...pairs.map(([, to]) => to), 'latest.yml']
const assets = names.map((name) => ({ name, size: statSync(join(out, name)).size, sha256: hash(join(out, name), 'sha256', 'hex') }))
writeFileSync(join(out, 'SHA256SUMS.txt'), assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n')
console.log(JSON.stringify({ version, out, assets }, null, 2))
