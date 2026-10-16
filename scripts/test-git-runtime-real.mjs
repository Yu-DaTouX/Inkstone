import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

if (process.env.YAN_REAL_GIT_DOWNLOAD !== '1') {
  console.log('跳过：设置 YAN_REAL_GIT_DOWNLOAD=1 才会真的下载并运行 PortableGit')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('跳过：只有 Windows 需要受管 Git')
  process.exit(0)
}

await build({
  entryPoints: ['src/main/git-runtime.ts'],
  outfile: 'out/test/git-runtime.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const runtime = await import('../out/test/git-runtime.mjs')

async function install(label, prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix))
  const root = join(work, 'tools', 'git')
  const started = Date.now()
  let lastPhase = ''
  const result = await runtime.installManagedGit({
    root,
    preferMirror: process.env.YAN_REAL_GIT_MIRROR !== '0',
    onProgress: (progress) => {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase
        console.log(`  [${label} ${((Date.now() - started) / 1000).toFixed(1)}s] ${progress.phase} ${progress.message ?? ''}`)
      }
    }
  })
  assert.equal(result.ok, true, `${label} 安装失败：${result.error}`)
  const paths = runtime.managedGitPaths(root)
  assert.ok(paths, `${label} 目录结构：找不到 cmd\\git.exe / bin\\bash.exe`)
  const version = execFileSync(paths.gitExe, ['--version'], { encoding: 'utf8' }).trim()
  assert.match(version, /git version 2\.56\.0/)
  const echoed = execFileSync(paths.bashExe, ['-c', 'echo ok-from-bash && uname -s'], { encoding: 'utf8' }).trim()
  assert.match(echoed, /ok-from-bash/)
  console.log(`  ✓ ${label}：${version}；bash：${echoed.replace(/\r?\n/g, ' | ')}（安装耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
  return { work, root, paths }
}

async function alignWithoutSystemGit(root, work) {
  const saved = { path: process.env.PATH, pf: process.env.ProgramFiles, pf86: process.env['ProgramFiles(x86)'] }
  process.env.PATH = (saved.path ?? '')
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, 'git.exe')) && !existsSync(join(dir, 'bash.exe')))
    .join(delimiter)
  process.env.ProgramFiles = join(work, 'none')
  process.env['ProgramFiles(x86)'] = join(work, 'none')
  try {
    const found = await runtime.refreshManagedGit(root)
    const hasBash = await runtime.hasBash()
    let whereHit = ''
    try {
      whereHit = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0]
    } catch {
      whereHit = ''
    }
    const gitVersion = (() => {
      try {
        return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })()
    return { found, hasBash, whereHit, gitVersion }
  } finally {
    process.env.PATH = saved.path
    process.env.ProgramFiles = saved.pf
    process.env['ProgramFiles(x86)'] = saved.pf86
  }
}

const cleanup = []
try {
  const a = await install('A 空格+中文', 'yan git 测试 ')
  cleanup.push(a.work)
  const alignedA = await alignWithoutSystemGit(a.root, a.work)
  assert.equal(alignedA.found.git, true, 'A：对齐后应当能找到 git')
  assert.match(alignedA.gitVersion, /git version 2\.56\.0/, 'A：直接调用 git 应命中受管那份')
  assert.equal(alignedA.found.bash, false, 'A：中文路径下 pi 的 where 找不到 bash，不能算可用')
  assert.equal(alignedA.hasBash, false, 'A：hasBash 应为假 → pi 退到 PowerShell，而不是调一个找不到的 bash')
  console.log('  ✓ A：中文路径下 git 可用；bash 如实判为不可用（pi 会退到 PowerShell）')
  rmSync(a.work, { recursive: true, force: true })

  const b = await install('B 空格', 'yan git test ')
  cleanup.push(b.work)
  const alignedB = await alignWithoutSystemGit(b.root, b.work)
  assert.equal(alignedB.found.git, true)
  assert.equal(alignedB.found.bash, true, 'B：ASCII 路径下 bash 应可用')
  assert.equal(alignedB.hasBash, true, 'B：hasBash 应为真（pi 不必退到 PowerShell）')
  assert.ok(alignedB.whereHit.toLowerCase().startsWith(b.root.toLowerCase()), `B：where bash.exe 首个命中应在受管目录：${alignedB.whereHit}`)
  assert.match(alignedB.gitVersion, /git version 2\.56\.0/)
  console.log(`  ✓ B：对齐 PATH 后 where bash.exe → ${alignedB.whereHit}`)
  console.log('git-runtime-real: ok')
} finally {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
}
