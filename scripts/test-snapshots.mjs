/**
 * 写入类工具的执行前后快照（src/main/snapshots.ts）。
 *
 * 为什么值得单独测：这是「改动归属」的证据来源 ——
 * 它算错了，界面就会把「没改」说成「改了」，或者把两次不同的修改
 * 混成一次。而且这里是纯文件逻辑，用临时文件就能确定性地验证。
 */
export async function runSnapshotTests(ok) {
  const { snapshotBefore, snapshotAfter, captureSide, clearSnapshots, isWriteTool, writePathOf } =
    await import('../out/test/snapshots.mjs')
  const { mkdtemp, writeFile, rm, unlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'yan-snap-'))
  try {
    /* ---- 工具识别 ---- */
    ok(isWriteTool('write') && isWriteTool('edit') && isWriteTool('apply_patch'), '写入类工具被识别')
    ok(!isWriteTool('read') && !isWriteTool('bash'), '读取/命令类不是写入工具')
    ok(writePathOf({ path: 'a.ts' }) === 'a.ts', '从 path 取路径')
    ok(writePathOf({ file_path: 'b.ts' }) === 'b.ts', '兼容 file_path 字段')
    ok(writePathOf({ command: 'ls' }) === undefined, '没有路径的工具返回 undefined')

    /* ---- 修改 ---- */
    const target = join(dir, 'mod.txt')
    await writeFile(target, 'line1\nline2\nline3\n', 'utf8')
    snapshotBefore('c1', target)
    await writeFile(target, 'line1\nline2 changed\nline3\nline4\n', 'utf8')
    const mod = snapshotAfter('c1')
    ok(!!mod, '拿到差异对象')
    ok(mod.status === 'modified', `识别为修改（实际 ${mod.status}）`)
    ok(mod.added === 2 && mod.removed === 1, `增删行数正确（+${mod.added} -${mod.removed}）`)
    ok(mod.patch.includes('- line2') && mod.patch.includes('+ line2 changed'), 'patch 里有对应的 -/+ 行')
    ok(mod.before.hash && mod.after.hash && mod.before.hash !== mod.after.hash, '前后哈希不同')
    ok(mod.before.content === undefined && mod.after.content === undefined, '内容全文不往外传')

    /* ---- 新建 ---- */
    const fresh = join(dir, 'new.txt')
    snapshotBefore('c2', fresh)
    await writeFile(fresh, 'hello\nworld\n', 'utf8')
    const created = snapshotAfter('c2')
    ok(created.status === 'created', '新建文件识别为 created')
    ok(created.added === 2 && created.removed === 0, `新建时全是新增（+${created.added}）`)
    ok(created.before.exists === false && created.after.exists === true, '前后存在性正确')

    /* ---- 删除 ---- */
    const gone = join(dir, 'gone.txt')
    await writeFile(gone, 'a\nb\n', 'utf8')
    snapshotBefore('c3', gone)
    await unlink(gone)
    const deleted = snapshotAfter('c3')
    ok(deleted.status === 'deleted', '删除文件识别为 deleted')
    ok(deleted.removed === 2 && deleted.added === 0, `删除时全是删除（-${deleted.removed}）`)

    /* ---- 没变 ---- */
    const same = join(dir, 'same.txt')
    await writeFile(same, 'same\n', 'utf8')
    snapshotBefore('c4', same)
    const unchanged = snapshotAfter('c4')
    ok(unchanged.status === 'unchanged', '内容没变时如实标 unchanged')
    ok(unchanged.added === 0 && unchanged.removed === 0, 'unchanged 时增删都是 0')

    /* ---- 大文件：不读内容，也不谎报“没变” ---- */
    const big = join(dir, 'big.txt')
    await writeFile(big, 'x'.repeat(3 * 1024 * 1024), 'utf8')
    const side = captureSide(big)
    ok(side.exists && side.tooLarge === true, '超过 2MB 标记 tooLarge')
    ok(side.content === undefined, '大文件不读内容进内存')
    snapshotBefore('c5', big)
    const bigDiff = snapshotAfter('c5')
    ok(bigDiff.status === 'unknown', '大文件拿不到内容时标 unknown（不假装没变化）')
    ok(bigDiff.patch === '', '大文件不给逐行 patch')

    /* ---- 没有前置快照 ---- */
    ok(snapshotAfter('never') === null, '没有前置快照时返回 null（如实退化）')

    /* ---- 清理 ---- */
    clearSnapshots()
    ok(snapshotAfter('c4') === null, 'clearSnapshots 之后查不到')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
