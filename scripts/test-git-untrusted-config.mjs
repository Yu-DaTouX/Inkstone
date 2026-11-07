import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-git-untrusted-'))
const outfile = join(root, 'git-service.mjs')
await build({ entryPoints: ['src/main/git-service.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { readStatus, gitRun } = await import(pathToFileURL(outfile).href)

const slash = (path) => path.replace(/\\/g, '/')
const hook = (name, marker) => {
  const file = join(root, name)
  writeFileSync(file, `#!/bin/sh\necho ran > "${slash(marker)}"\ncat\n`)
  return `sh "${slash(file)}"`
}

let counter = 0
function makeRepo(attributes) {
  counter += 1
  const repo = join(root, `repo-${counter}`)
  mkdirSync(repo)
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'yan-tests@example.invalid')
  git('config', 'user.name', 'Yan tests')
  writeFileSync(join(repo, 'a.txt'), 'x\n')
  writeFileSync(join(repo, '.gitattributes'), attributes)
  git('add', '.')
  git('commit', '-qm', 'base')
  const touchSameSize = () => {
    writeFileSync(join(repo, 'a.txt'), 'y\n')
    const later = new Date(Date.now() + 60_000 + counter * 1000)
    utimesSync(join(repo, 'a.txt'), later, later)
  }
  return { repo, git, touchSameSize }
}

try {
  {
    const { repo, git, touchSameSize } = makeRepo('* text\n')
    const marker = join(root, 'fsmonitor.txt')
    git('config', 'core.fsmonitor', hook('fsmonitor.sh', marker))
    touchSameSize()
    await readStatus(repo)
    assert.equal(existsSync(marker), false, '状态轮询不执行 core.fsmonitor')
    await gitRun(repo, ['ls-files'], { allowFailure: true })
    assert.equal(existsSync(marker), false, 'gitRun 的其他命令也不执行 core.fsmonitor')
    console.log('✓ 不执行 core.fsmonitor')
  }

  {
    const { repo, git, touchSameSize } = makeRepo('* filter=evil\n')
    const marker = join(root, 'filter.txt')
    git('config', 'filter.evil.clean', hook('filter.sh', marker))
    git('config', 'filter.evil.required', 'true')
    touchSameSize()
    execFileSync('git', ['status', '--porcelain=v2'], { cwd: repo, stdio: 'ignore' })
    assert.equal(existsSync(marker), true, '前提：不加保护时 git status 确实会执行 filter 驱动')
    rmSync(marker)
    touchSameSize()
    const status = await readStatus(repo)
    assert.equal(existsSync(marker), false, '状态轮询不执行仓库配置里的 filter 驱动')
    assert.ok(status.files?.length ?? status.entries?.length ?? true, '状态仍能读出')
    console.log('✓ 不执行仓库配置里的 filter 驱动')
  }

  {
    const { repo, git, touchSameSize } = makeRepo('* filter=a=b\n')
    const marker = join(root, 'filter-eq.txt')
    git('config', 'filter.a=b.clean', hook('filter-eq.sh', marker))
    touchSameSize()
    await readStatus(repo)
    assert.equal(existsSync(marker), false, '名字里带等号的 filter 也被中和')
    console.log('✓ 名字带等号的 filter 也不执行')
  }

  {
    const { repo, git, touchSameSize } = makeRepo('* filter=viainclude\n')
    const marker = join(root, 'include.txt')
    const included = join(root, 'included.cfg')
    writeFileSync(included, `[filter "viainclude"]\n\tclean = ${hook('include.sh', marker).replace(/"/g, '\\"')}\n`)
    git('config', 'include.path', slash(included))
    touchSameSize()
    await readStatus(repo)
    assert.equal(existsSync(marker), false, '通过 include 引入的 filter 也被中和')
    console.log('✓ include 引入的 filter 也不执行')
  }

  {
    const { repo, git, touchSameSize } = makeRepo('*.bin filter=lfs\n')
    const marker = join(root, 'lfs.txt')
    git('config', 'filter.lfs.clean', hook('lfs.sh', marker))
    writeFileSync(join(repo, 'b.bin'), 'x\n')
    git('add', 'b.bin')
    git('commit', '-qm', 'bin')
    rmSync(marker, { force: true })
    touchSameSize()
    writeFileSync(join(repo, 'b.bin'), 'y\n')
    await readStatus(repo)
    assert.equal(existsSync(marker), false, '伪装成 lfs 名字但命令不是 git-lfs 的不放行')
    console.log('✓ 伪装成 lfs 的 filter 不放行')
  }

  {
    const { repo } = makeRepo('* text\n')
    const env = (await gitRun(repo, ['config', '--show-scope', '--includes', '-z', '--get-regexp', '^filter\\.'], { allowFailure: true })).stdout
    assert.ok(!env.includes('local\0'), '干净仓库没有本地 filter')
    await readStatus(repo)
    console.log('✓ 干净仓库正常读状态')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('仓库配置不能借状态轮询执行命令')
