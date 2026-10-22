import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { relative, join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_BYTES = 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')).digest('hex')
}

async function listNames(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function runFileEditorTests(ok, { readEditableFile, writeEditableFile }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-file-editor-'))
  const outside = await mkdtemp(join(tmpdir(), 'yan-file-editor-outside-'))
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    const content = 'hello\nworld\n'
    await writeFile(join(root, 'notes.txt'), content)
    await writeFile(join(root, 'src', 'nested.txt'), 'nested\n')
    await writeFile(join(outside, 'secret.txt'), 'secret\n')

    const view = await readEditableFile(root, 'notes.txt')
    ok(view.ok === true && view.text === content, '读取文本文件成功且内容一致')
    ok(view.hash === sha256(content), '读取返回的 hash 与内容一致')
    ok(view.name === 'notes.txt' && view.abs === join(root, 'notes.txt'), '读取返回文件名与绝对路径')
    ok(view.size === Buffer.byteLength(content) && view.mtimeMs > 0, '读取返回字节数与修改时间')

    const nested = await readEditableFile(root, 'src/nested.txt')
    ok(nested.ok === true && nested.text === 'nested\n', '读取子目录内相对路径成功')

    const missing = await readEditableFile(root, 'nope.txt')
    ok(missing.ok === false && missing.error === 'missing', '读取不存在的文件返回 missing')

    await writeFile(join(root, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]))
    const binary = await readEditableFile(root, 'blob.bin')
    ok(binary.ok === false && binary.error === 'binary', '含 NUL 的文件返回 binary')

    await writeFile(join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0xfd, 0x41]))
    const encoding = await readEditableFile(root, 'bad.txt')
    ok(encoding.ok === false && encoding.error === 'encoding', '非法 UTF-8 文件返回 encoding')

    await writeFile(join(root, 'big.txt'), Buffer.alloc(MAX_BYTES + 1, 0x61))
    const tooLarge = await readEditableFile(root, 'big.txt')
    ok(tooLarge.ok === false && tooLarge.error === 'too-large', '超过 1 MiB 的文件返回 too-large')
    await writeFile(join(root, 'limit.txt'), Buffer.alloc(MAX_BYTES, 0x61))
    const atLimit = await readEditableFile(root, 'limit.txt')
    ok(atLimit.ok === true, '恰好 1 MiB 的文件可以读取')

    const target = join(root, 'edit.txt')
    await writeFile(target, 'v1\n')
    const first = await writeEditableFile(root, 'edit.txt', 'v2\n', sha256('v1\n'))
    ok(first.status === 'saved' && first.hash === sha256('v2\n'), '写入成功并返回新内容 hash')
    ok((await readFile(target, 'utf8')) === 'v2\n', '写入内容落到磁盘')
    const reread = await readEditableFile(root, 'edit.txt')
    ok(reread.ok === true && reread.hash === first.hash, '写入返回的 hash 与再次读取一致')

    const bomTarget = join(root, 'bom.html')
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await writeFile(bomTarget, Buffer.concat([bom, Buffer.from('<p>a</p>\n')]))
    const bomView = await readEditableFile(root, 'bom.html')
    const bomSaved = await writeEditableFile(root, 'bom.html', bomView.text.replace('a', 'b'), bomView.hash)
    const bomBytes = await readFile(bomTarget)
    ok(bomSaved.status === 'saved' && bomBytes.subarray(0, 3).equals(bom) && bomBytes.subarray(3).toString('utf8') === '<p>b</p>\n', '改写带 BOM 的文件保留 BOM')
    ok(bomSaved.hash === (await readEditableFile(root, 'bom.html')).hash, '保留 BOM 后返回的 hash 与再次读取一致')

    const beforeConflict = await readFile(target)
    const conflict = await writeEditableFile(root, 'edit.txt', 'v3\n', sha256('stale\n'))
    ok(conflict.status === 'conflict', 'expectedHash 不匹配返回 conflict')
    ok(conflict.currentHash === sha256(beforeConflict), 'conflict 返回当前磁盘 hash')
    ok((await readFile(target)).equals(beforeConflict), 'conflict 时磁盘内容没有变化')

    const deniedRelative = await writeEditableFile(root, '../escaped.txt', 'x', null)
    ok(deniedRelative.status === 'denied', '相对越界写入返回 denied')
    const deniedReadRel = await readEditableFile(root, '../escaped.txt')
    ok(deniedReadRel.ok === false && deniedReadRel.error === 'denied', '相对越界读取返回 denied')

    const outsideAbs = join(outside, 'secret.txt')
    const deniedReadAbs = await readEditableFile(root, outsideAbs)
    ok(deniedReadAbs.ok === false && deniedReadAbs.error === 'denied', '绝对路径指向工作区外读取返回 denied')
    const deniedWriteAbs = await writeEditableFile(root, outsideAbs, 'changed', sha256('secret\n'))
    ok(deniedWriteAbs.status === 'denied', '绝对路径指向工作区外写入返回 denied')
    ok((await readFile(outsideAbs, 'utf8')) === 'secret\n', '工作区外文件未被修改')

    const overTraversal = relative(root, join(outside, 'secret.txt'))
    const deniedTraversal = await writeEditableFile(root, overTraversal, 'x', null)
    ok(deniedTraversal.status === 'denied', '跨目录相对路径写入返回 denied')

    const newFile = await writeEditableFile(root, 'created.txt', 'brand new', null)
    ok(newFile.status === 'saved' && newFile.hash === sha256('brand new'), 'expectedHash 为 null 时新建文件成功')
    ok((await readFile(join(root, 'created.txt'), 'utf8')) === 'brand new', '新建文件内容正确')
    const nullOnExisting = await writeEditableFile(root, 'created.txt', 'overwrite', null)
    ok(nullOnExisting.status === 'conflict', '已存在文件传 null 返回 conflict')
    ok((await readFile(join(root, 'created.txt'), 'utf8')) === 'brand new', '已存在文件未被 null 覆盖')

    const deepNew = await writeEditableFile(root, 'no/such/dir/file.txt', 'x', null)
    ok(deepNew.status === 'denied', '父目录不存在时新建返回 denied')

    if (process.platform !== 'win32') {
      const modeTarget = join(root, 'mode.txt')
      await writeFile(modeTarget, 'm1')
      await chmod(modeTarget, 0o600)
      const modeWrite = await writeEditableFile(root, 'mode.txt', 'm2', sha256('m1'))
      const modeStat = await stat(modeTarget)
      ok(modeWrite.status === 'saved' && (modeStat.mode & 0o777) === 0o600, '写入保留原文件权限位')
    }

    const deniedDir = await writeEditableFile(root, 'src', 'x', null)
    ok(deniedDir.status === 'denied', '写入目录返回 denied')

    const raceTarget = join(root, 'race.txt')
    await writeFile(raceTarget, 'base')
    const raceHash = sha256('base')
    const [raceA, raceB] = await Promise.all([
      writeEditableFile(root, 'race.txt', 'first', raceHash),
      writeEditableFile(root, 'race.txt', 'second', raceHash)
    ])
    const savedCount = [raceA, raceB].filter((item) => item.status === 'saved').length
    const conflictCount = [raceA, raceB].filter((item) => item.status === 'conflict').length
    ok(savedCount === 1 && conflictCount === 1, '并发写同一文件：仅一次成功、一次 conflict')
    const raceText = await readFile(raceTarget, 'utf8')
    ok(raceText === 'first' || raceText === 'second', '并发写入后磁盘内容为其中一次写入')

    let symlinkSupported = true
    try {
      await symlink(join(root, 'notes.txt'), join(root, 'link.txt'), 'file')
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
        symlinkSupported = false
        console.log('SKIP: 本机无文件符号链接权限，跳过符号链接用例')
      } else {
        throw error
      }
    }
    if (symlinkSupported) {
      const linkRead = await readEditableFile(root, 'link.txt')
      ok(linkRead.ok === false && linkRead.error === 'denied', '符号链接读取返回 denied')
      const linkWrite = await writeEditableFile(root, 'link.txt', 'x', sha256(content))
      ok(linkWrite.status === 'denied', '符号链接写入返回 denied')
    }

    const leftovers = (await listNames(root)).filter((name) => /\.yan-.*\.tmp$/.test(name))
    ok(leftovers.length === 0, '写入结束后目录不残留临时文件')
    const nestedLeftovers = (await listNames(join(root, 'src'))).filter((name) => /\.yan-.*\.tmp$/.test(name))
    ok(nestedLeftovers.length === 0, '子目录也不残留临时文件')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}
