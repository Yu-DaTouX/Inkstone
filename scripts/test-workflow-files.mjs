import './lib/test-isolate.mjs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

function unlinkLink(path) {
  try {
    unlinkSync(path)
  } catch {
    try { rmdirSync(path) } catch {}
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { createProjectFiles, PROJECT_FILE_LIMITS } = await compile('src/main/workflows/project-files.ts')
  const base = mkdtempSync(join(tmpdir(), 'yan-project-files-'))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'docs', 'deep'), { recursive: true })
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'sub', '.git'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'docs', 'a.txt'), '甲', 'utf8')
  writeFileSync(join(root, 'docs', 'b.md'), 'b', 'utf8')
  writeFileSync(join(root, 'docs', 'deep', 'c.txt'), 'c', 'utf8')
  writeFileSync(join(root, '.git', 'config'), '[core]', 'utf8')
  writeFileSync(join(root, 'sub', '.git', 'x'), 'x', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
  const links = []
  const files = createProjectFiles(root)
  const rejects = (fn, label, pattern = /./) => {
    let message = ''
    try {
      fn()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    ok(message !== '' && pattern.test(message), label, message || '没有被拒绝')
  }

  try {
    ok(PROJECT_FILE_LIMITS.maxReadBytes === 4 * 1024 * 1024 && PROJECT_FILE_LIMITS.maxWriteBytes === 4 * 1024 * 1024, '读写上限各 4MB')
    ok(files.readText('docs/a.txt') === '甲' && files.readText('docs\\a.txt') === '甲' && files.readText(join(root, 'docs', 'a.txt')) === '甲', '项目内相对路径、反斜杠与项目内绝对路径都能读')

    rejects(() => files.readText('../outside/secret.txt'), '.. 逃出项目被拒', /项目目录/)
    rejects(() => files.readText('docs/../../outside/secret.txt'), '中间夹 .. 逃出项目被拒', /项目目录/)
    rejects(() => files.writeText('../outside/new.txt', 'x'), '.. 写到项目外被拒', /项目目录/)
    ok(!existsSync(join(outside, 'new.txt')), '越界写入没有落盘')
    rejects(() => files.readText(join(outside, 'secret.txt')), '项目外绝对路径被拒', /项目目录/)
    rejects(() => files.readText(resolve(root).slice(0, 2) === 'C:' ? 'D:/outside/secret.txt' : 'C:/outside/secret.txt'), '其他盘符被拒', /项目目录/)
    rejects(() => files.readText('C:secret.txt'), '盘符相对路径被拒', /盘符|项目目录/)
    for (const unc of ['\\\\server\\share\\x.txt', '//server/share/x.txt', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\pipe\\x', '\\\\127.0.0.1\\c$\\Windows\\win.ini']) {
      rejects(() => files.readText(unc), `UNC / 设备路径被拒：${unc}`, /网络|设备|UNC|项目目录/)
      rejects(() => files.writeText(unc, 'x'), `UNC / 设备路径写入被拒：${unc}`, /网络|设备|UNC|项目目录/)
    }
    rejects(() => files.readText('.git/config'), '.git 目录读取被拒', /\.git/)
    rejects(() => files.readText('.GIT/config'), '.git 大小写变体被拒', /\.git/)
    rejects(() => files.writeText('.git/hooks/pre-commit', 'evil'), '.git 目录写入被拒', /\.git/)
    rejects(() => files.writeText('sub/.git/x', 'evil'), '子目录里的 .git 也被拒', /\.git/)
    ok(!existsSync(join(root, '.git', 'hooks', 'pre-commit')), '.git 写入没有落盘')
    rejects(() => files.listFiles('.git'), 'listFiles 列 .git 被拒', /\.git/)
    rejects(() => files.writeText('docs/a.txt:stream', 'x'), 'NTFS 备用数据流被拒', /字符|名称/)
    rejects(() => files.writeText('CON', 'x'), '设备名 CON 被拒', /设备|名称/)
    rejects(() => files.writeText('docs/nul.txt', 'x'), '设备名 NUL.txt 被拒', /设备|名称/)
    rejects(() => files.writeText('docs/x. ', 'x'), '以点或空格结尾的名称被拒', /名称/)
    rejects(() => files.readText('.. /outside/secret.txt'), '「.. 」这类会被 Windows 剥成 .. 的段被拒', /名称|项目目录/)
    rejects(() => files.readText('docs/a\u0000.txt'), 'NUL 字符被拒')
    rejects(() => files.readText(''), '空路径被拒')
    rejects(() => files.readText(42), '非字符串路径被拒')

    let junction = false
    try {
      symlinkSync(outside, join(root, 'jout'), 'junction')
      links.push(join(root, 'jout'))
      symlinkSync(join(root, '.git'), join(root, 'jgit'), 'junction')
      links.push(join(root, 'jgit'))
      junction = true
    } catch (error) {
      console.log(`  （建不了目录联接，跳过：${error.message}）`)
    }
    if (junction) {
      rejects(() => files.readText('jout/secret.txt'), '目录联接指向项目外：读取被拒', /项目目录/)
      rejects(() => files.writeText('jout/new.txt', 'x'), '目录联接指向项目外：写入被拒', /项目目录/)
      rejects(() => files.writeText('jout/deeper/new.txt', 'x'), '目录联接指向项目外：经联接建子目录被拒', /项目目录/)
      ok(!existsSync(join(outside, 'new.txt')) && !existsSync(join(outside, 'deeper')), '经联接的越界写入没有落盘，也没建目录')
      rejects(() => files.readText('jgit/config'), '目录联接指向 .git：读取被拒', /\.git/)
      rejects(() => files.listFiles('jout'), '目录联接指向项目外：列目录被拒', /项目目录/)
      const listed = files.listFiles('.')
      ok(!listed.some((path) => path.startsWith('jout') || path.startsWith('jgit')), 'listFiles 不跟随联接', listed.join(','))
    }

    let symlink = false
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'docs', 'link.txt'), 'file')
      links.push(join(root, 'docs', 'link.txt'))
      symlinkSync(outside, join(root, 'dlink'), 'dir')
      links.push(join(root, 'dlink'))
      symlink = true
    } catch (error) {
      console.log(`  （本机不允许建符号链接（需开发者模式或管理员），符号链接用例跳过：${error.code ?? error.message}）`)
    }
    if (symlink) {
      rejects(() => files.readText('docs/link.txt'), '文件符号链接指向项目外：读取被拒', /项目目录/)
      rejects(() => files.writeText('docs/link.txt', 'x'), '文件符号链接指向项目外：写入被拒', /项目目录/)
      ok(readFileSync(join(outside, 'secret.txt'), 'utf8') === 'secret', '项目外的文件没被改写')
      rejects(() => files.readText('dlink/secret.txt'), '目录符号链接指向项目外：读取被拒', /项目目录/)
    }

    rejects(() => files.readText('docs'), '读取目录被拒', /不是文件/)
    rejects(() => files.readText('docs/missing.txt'), '读取不存在的文件报错', /不存在|找不到/)
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(PROJECT_FILE_LIMITS.maxReadBytes + 1, 97))
    rejects(() => files.readText('big.txt'), '读取超过 4MB 被拒', /4MB|上限/)
    rejects(() => files.writeText('out/huge.txt', '字'.repeat(Math.ceil(PROJECT_FILE_LIMITS.maxWriteBytes / 3) + 1)), '写入超过 4MB（按 UTF-8 字节）被拒', /4MB|上限/)
    rejects(() => files.writeText('out/x.txt', 42), '写入非字符串被拒', /字符串/)
    rejects(() => files.writeText('docs', 'x'), '写到已有目录被拒', /目录/)

    const written = files.writeText('out/nested/r.txt', '结果')
    ok(written.path === 'out/nested/r.txt' && written.bytes === 6 && readFileSync(join(root, 'out', 'nested', 'r.txt'), 'utf8') === '结果', 'writeText 自动建父目录并返回相对路径与字节数', JSON.stringify(written))
    files.writeText('out/nested/r.txt', '覆盖')
    ok(readFileSync(join(root, 'out', 'nested', 'r.txt'), 'utf8') === '覆盖' && readdirSync(join(root, 'out', 'nested')).length === 1, '覆盖写入是原子替换，没有残留临时文件', readdirSync(join(root, 'out', 'nested')).join(','))

    const all = files.listFiles()
    ok(all.includes('docs/a.txt') && all.includes('docs/deep/c.txt') && !all.some((path) => path.includes('.git')), 'listFiles 默认列整个项目、跳过 .git', all.join(','))
    ok(JSON.stringify(all) === JSON.stringify([...all].sort()), 'listFiles 结果排序稳定')
    ok(files.listFiles('docs', '*.txt').join() === 'docs/a.txt', 'glob 的 * 不跨目录', files.listFiles('docs', '*.txt').join())
    ok(files.listFiles('docs', '**/*.txt').join() === 'docs/a.txt,docs/deep/c.txt', '** 跨目录', files.listFiles('docs', '**/*.txt').join())
    ok(files.listFiles('docs', '*.{md,txt}').join() === 'docs/a.txt,docs/b.md', '{a,b} 备选', files.listFiles('docs', '*.{md,txt}').join())
    rejects(() => files.listFiles('../outside'), 'listFiles 列项目外被拒', /项目目录/)
    rejects(() => files.listFiles('docs/a.txt'), 'listFiles 指向文件被拒', /不是目录/)
  } finally {
    for (const link of links) unlinkLink(link)
    ok(links.every((link) => !existsSync(link)) && existsSync(join(outside, 'secret.txt')), '测试建的联接/链接已删除，只删联接本身')
    rmSync(base, { recursive: true, force: true })
  }
})
