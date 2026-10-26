import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `yan-ws-${label}-`))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeFile(root, rel, text) {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
}

async function measureTimerLag(run) {
  const gaps = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 10)
  const started = performance.now()
  const value = await run()
  const elapsed = performance.now() - started
  clearInterval(timer)
  return { value, elapsed, max: gaps.length ? Math.max(...gaps) : 0, samples: gaps.length }
}

export async function runWorkspaceChangesTests(ok, mod) {
  const { captureTree, diffTrees, beginTreeSnapshot, endTreeSnapshot, clearSnapshots } = mod

  const snap = (files) => ({
    root: '/x',
    truncated: false,
    unreadable: false,
    unreadableDirs: 0,
    scanned: files.size,
    files: new Map(Object.entries(files))
  })
  const entry = (size, extra = {}) => ({ size, mtimeMs: 1000, ...extra })

  const same = diffTrees(snap({ 'a.txt': entry(10) }), snap({ 'a.txt': entry(10) }))
  ok(same.length === 0, '两份完全相同的快照 → 没有差异', JSON.stringify(same))

  const added = diffTrees(snap({}), snap({ 'new.txt': entry(5) }))
  ok(added.length === 1 && added[0].status === 'created', '只有 after 有 → created', JSON.stringify(added))

  const removed = diffTrees(snap({ 'gone.txt': entry(5) }), snap({}))
  ok(removed.length === 1 && removed[0].status === 'deleted', '只有 before 有 → deleted', JSON.stringify(removed))
  ok(removed[0].beforeSize === 5 && removed[0].afterSize === -1, 'deleted 记录原大小，after 写 -1 表示没有')

  const sizeChanged = diffTrees(snap({ 'a.txt': entry(10) }), snap({ 'a.txt': entry(12) }))
  ok(sizeChanged.length === 1 && sizeChanged[0].status === 'modified', '大小变了 → modified', JSON.stringify(sizeChanged))

  const sameSize = diffTrees(
    snap({ 'a.txt': entry(10, { hash: 'aaaaaaaaaaaaaaaa' }) }),
    snap({ 'a.txt': entry(10, { hash: 'bbbbbbbbbbbbbbbb' }) })
  )
  ok(sameSize.length === 1 && sameSize[0].status === 'modified', '同大小但哈希不同 → modified', JSON.stringify(sameSize))

  const sameHash = diffTrees(
    snap({ 'a.txt': entry(10, { hash: 'aaaaaaaaaaaaaaaa', mtimeMs: 1000 }) }),
    snap({ 'a.txt': entry(10, { hash: 'aaaaaaaaaaaaaaaa', mtimeMs: 2000 }) })
  )
  ok(sameHash.length === 0, '同大小同哈希（只是 mtime 变了，比如 touch）→ 不算改动', JSON.stringify(sameHash))

  const mtimeOnly = diffTrees(snap({ 'a.txt': entry(10) }), snap({ 'a.txt': entry(10, { mtimeMs: 2000 }) }))
  ok(
    mtimeOnly.length === 1 && mtimeOnly[0].status === 'unknown',
    '没有哈希、只有 mtime 变 → unknown（不能断言内容变了）',
    JSON.stringify(mtimeOnly)
  )

  const sorted = diffTrees(snap({ 'b.txt': entry(1) }), snap({ 'c.txt': entry(1), 'a.txt': entry(1) }))
  ok(
    sorted.map((c) => c.path).join(',') === 'a.txt,b.txt,c.txt',
    '差异按路径稳定排序（界面与探针看同一个顺序）',
    sorted.map((c) => c.path).join(',')
  )

  const { root, cleanup } = tempRoot('tree')
  try {
    writeFile(root, 'src/a.ts', 'const a = 1\n')
    writeFile(root, 'src/b.ts', 'const b = 2\n')
    writeFile(root, 'README.md', '# hi\n')
    writeFile(root, 'node_modules/dep/index.js', 'module.exports = 1\n')
    const before = await captureTree(root)
    ok(before.files.has('src/a.ts'), '扫到了普通文件（相对路径，正斜杠）', [...before.files.keys()].join(','))
    ok(!before.files.has('node_modules/dep/index.js'), 'node_modules 里的文件不扫（依赖目录跳过）')
    ok(before.files.get('src/a.ts').content === 'const a = 1\n', '小文件连内容一起留下（为了逐行 patch）')

    writeFile(root, 'src/a.ts', 'const a = 111\n')
    writeFile(root, 'src/c.ts', 'const c = 3\n')
    unlinkSync(join(root, 'README.md'))
    writeFile(root, 'node_modules/dep/index.js', 'module.exports = 2\n')

    const after = await captureTree(root)
    const changes = diffTrees(before, after)
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]))
    ok(byPath['src/a.ts'] === 'modified', '改过的文件 → modified', JSON.stringify(byPath))
    ok(byPath['src/c.ts'] === 'created', '新文件 → created')
    ok(byPath['README.md'] === 'deleted', '删掉的文件 → deleted')
    ok(!('node_modules/dep/index.js' in byPath), '依赖目录里的改动被忽略（不冒充用户改动）')

    const result = await endTreeSnapshotFor(mod, root, () => {
      writeFile(root, 'src/d.ts', 'const d = 4\n')
    })
    ok(result && result.total === 1, '真实调用：只有真的改了的文件进结果', JSON.stringify(result && result.files))
    ok(result && result.files[0].path === 'src/d.ts' && result.files[0].status === 'created', '新建文件被认领')
    ok(result && result.files[0].added === 1, '新建文件能给出新增行数（读了内容）', String(result?.files?.[0]?.added))
    ok(result && !result.unknown, '没有并发/截断时不给 unknown')

    const quiet = await endTreeSnapshotFor(mod, root, () => {})
    ok(quiet && quiet.total === 0 && !quiet.unknown, '什么都没改 → total=0 且不标 unknown（“扫过且没变”是结论）')
    ok(quiet && quiet.scanned > 0, 'scanned 有值 —— 界面能说清“扫了多少”', String(quiet?.scanned))

    const sameSize = await endTreeSnapshotFor(mod, root, () => {
      writeFile(root, 'src/b.ts', 'const b = 3\n')
      const later = (Date.now() + 2000) / 1000
      utimesSync(join(root, 'src/b.ts'), later, later)
    })
    const sameSizeFile = sameSize?.files.find((f) => f.path === 'src/b.ts')
    ok(
      sameSize?.total === 1 && sameSizeFile?.status === 'modified' && sameSizeFile.added === 1 && sameSizeFile.removed === 1,
      '结束快照复用未变文件后，等长改写仍按内容判定并给出行数',
      JSON.stringify(sameSize?.files)
    )

    writeFile(root, 'big.bin', 'x'.repeat(300 * 1024) + '\n')
    const beforeBig = await captureTree(root)
    writeFile(root, 'big.bin', 'y'.repeat(300 * 1024) + '\n')
    const bumped = (Date.now() + 2000) / 1000
    utimesSync(join(root, 'big.bin'), bumped, bumped)
    const bigChanges = diffTrees(beforeBig, await captureTree(root))
    ok(
      bigChanges.some((c) => c.path === 'big.bin' && c.status === 'unknown'),
      '大文件等长改写 → unknown（没读内容就不能说“内容变了”）',
      JSON.stringify(bigChanges)
    )
    writeFile(root, 'big.bin', 'y'.repeat(300 * 1024 + 10) + '\n')
    const bigGrew = diffTrees(beforeBig, await captureTree(root))
    ok(
      bigGrew.some((c) => c.path === 'big.bin' && c.status === 'modified'),
      '大文件长度变了 → modified（大小是硬证据）',
      JSON.stringify(bigGrew)
    )
    ok(
      beforeBig.files.get('big.bin').content === undefined,
      '大文件不留内容（避免把几十 MB 读进内存）'
    )
    const bigResult = await endTreeSnapshotFor(mod, root, () => {
      writeFile(root, 'big2.bin', 'z'.repeat(300 * 1024) + '\n')
    })
    const bigFile = bigResult?.files.find((f) => f.path === 'big2.bin')
    ok(bigFile && bigFile.added === -1 && bigFile.patch === '', '大文件不给行数与 patch（如实退化，不编造）', JSON.stringify(bigFile))

    await beginTreeSnapshot('call-A', root, 's1')
    await beginTreeSnapshot('call-B', root, 's2')
    writeFile(root, 'src/shared.ts', 'export const x = 1\n')
    const a = await endTreeSnapshot('call-A')
    const b = await endTreeSnapshot('call-B')
    ok(a?.unknown === 'concurrent', '同一目录两个并发快照 → A 标 concurrent', String(a?.unknown))
    ok(b?.unknown === 'concurrent', '同一目录两个并发快照 → B 也标 concurrent', String(b?.unknown))
    ok(
      (a?.files ?? []).length > 0 && (b?.files ?? []).length > 0,
      '并发时仍然列出差异（信息给到，但明确说不能归属）'
    )

    const other = tempRoot('other')
    try {
      await beginTreeSnapshot('call-C', root, 's1')
      await beginTreeSnapshot('call-D', other.root, 's2')
      writeFile(root, 'src/only-c.ts', 'export const c = 1\n')
      const c = await endTreeSnapshot('call-C')
      const d = await endTreeSnapshot('call-D')
      ok(!c?.unknown, '另一个目录的快照不算并发（worktree 隔离场景）', String(c?.unknown))
      ok(d && d.total === 0, '隔离目录自己那份快照没有差异')
    } finally {
      other.cleanup()
    }

    ok((await endTreeSnapshot('never-started')) === null, '没拍过快照的调用 → null（不显示改动卡片）')

    const evictOther = tempRoot('evict-other')
    try {
      await beginTreeSnapshot('evict-0', evictOther.root, 's1')
      for (let index = 1; index <= 32; index += 1) await beginTreeSnapshot(`evict-${index}`, root, 's1')
      const evicted = await endTreeSnapshot('evict-0')
      ok(evicted !== null, '被淘汰的快照不静默返回 null', String(evicted))
      ok(evicted?.unknown === 'truncated', '被淘汰的快照标 truncated（如实说没记录）', String(evicted?.unknown))
      ok(evicted?.total === 0 && evicted?.files.length === 0, '被淘汰的快照不编造差异')
      ok(evicted?.root === evictOther.root, '被淘汰的快照仍报告它自己的 root', String(evicted?.root))
      for (let index = 1; index <= 32; index += 1) await endTreeSnapshot(`evict-${index}`)
    } finally {
      evictOther.cleanup()
    }

    const dupOther = tempRoot('dup')
    try {
      await beginTreeSnapshot('dup', root, 's1')
      await beginTreeSnapshot('dup', dupOther.root, 's1')
      const dup = await endTreeSnapshot('dup')
      ok(dup?.root === dupOther.root, '同一 callId 换了目录时重建快照，不沿用旧根', String(dup?.root))
    } finally {
      dupOther.cleanup()
    }

    const unreadable = tempRoot('unreadable')
    const missing = join(unreadable.root, 'not-there')
    unreadable.cleanup()
    await beginTreeSnapshot('call-E', missing, 's1')
    const e = await endTreeSnapshot('call-E')
    ok(e?.unknown === 'unreadable', '根目录读不到 → unreadable（不假装“没有改动”）', String(e?.unknown))

    const wide = tempRoot('wide')
    try {
      for (let dir = 0; dir < 30; dir += 1) {
        const abs = join(wide.root, `dir-${dir}`)
        mkdirSync(abs, { recursive: true })
        for (let file = 0; file < 100; file += 1) writeFileSync(join(abs, `f-${file}.txt`), `line ${dir}/${file}\n`)
      }
      const measured = await measureTimerLag(async () => {
        await beginTreeSnapshot('wide-call', wide.root, 'unit')
        writeFileSync(join(wide.root, 'dir-0', 'late.txt'), 'late\n')
        return endTreeSnapshot('wide-call')
      })
      const wideResult = measured.value
      ok(wideResult && wideResult.scanned >= 3001, '3000 个文件的目录照样扫完', String(wideResult?.scanned))
      ok(
        wideResult?.files.length === 1,
        '只有 late.txt 是新增（before 完整，没有把整棵树误报成新增）',
        JSON.stringify(wideResult?.files)
      )
      ok(
        wideResult?.files.some((f) => f.path === 'dir-0/late.txt' && f.status === 'created'),
        'begin 完成后才出现的文件仍被 end 检出（前后两次扫描都真实发生）',
        JSON.stringify(wideResult?.files)
      )
      ok(
        measured.max < 60,
        '扫描 3000 个文件期间 10ms 定时器最大延迟 < 60ms（不阻塞主进程事件循环）',
        `实测最大延迟 ${measured.max.toFixed(1)}ms，样本 ${measured.samples} 次，扫描耗时 ${measured.elapsed.toFixed(0)}ms`
      )

      const fastReady = beginTreeSnapshot('wide-fast', wide.root, 'unit')
      const fast = await endTreeSnapshot('wide-fast')
      ok(
        fast?.unknown === 'concurrent',
        '工具在 before 扫描完成前就结束 → 标 concurrent，不静默当作没有改动',
        String(fast?.unknown)
      )
      await fastReady

      const inFlight = beginTreeSnapshot('wide-cancel', wide.root, 'unit')
      clearSnapshots()
      const cancelled = await endTreeSnapshot('wide-cancel')
      ok(cancelled === null, 'clearSnapshots 取消 in-flight 的 begin → end 返回 null', String(cancelled))
      const settled = await inFlight.then(() => 'resolved', () => 'rejected')
      ok(settled === 'resolved', '被取消的 begin 正常收尾（不产生未处理 rejection）', settled)
    } finally {
      wide.cleanup()
    }
  } finally {
    cleanup()
  }
}

async function endTreeSnapshotFor(mod, root, mutate) {
  const { beginTreeSnapshot, endTreeSnapshot } = mod
  const id = 'call-' + Math.random().toString(36).slice(2)
  await beginTreeSnapshot(id, root, 'unit')
  mutate()
  return endTreeSnapshot(id)
}

function gitRepo(label) {
  const { root, cleanup } = tempRoot(label)
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'test'])
  run(['config', 'core.autocrlf', 'false'])
  return {
    root,
    cleanup,
    run,
    write: (rel, text) => writeFile(root, rel, text),
    remove: (rel) => unlinkSync(join(root, ...rel.split('/'))),
    commit: (msg) => {
      run(['add', '-A'])
      run(['commit', '-q', '-m', msg])
      return run(['rev-parse', 'HEAD']).trim()
    },
    head: () => run(['rev-parse', 'HEAD']).trim()
  }
}

async function endGitSnapshotFor(mod, root, mutate) {
  const { beginTreeSnapshot, endTreeSnapshot } = mod
  const id = 'git-call-' + Math.random().toString(36).slice(2)
  await beginTreeSnapshot(id, root, 'unit')
  await mutate()
  return endTreeSnapshot(id)
}

export async function runGitWorkspaceChangesTests(ok, mod) {
  const { captureTree, diffTrees, clearSnapshots } = mod

  const repo = gitRepo('git-base')
  try {
    repo.write('a.txt', 'line1\nline2\n')
    repo.write('keep.txt', 'keep\n')
    repo.commit('init')

    const snap = await captureTree(repo.root)
    ok(snap.mode === 'git', 'Git 工作树内 → captureTree 走 git 路径', String(snap.mode))
    ok(snap.files.size === 0, '全部干净时，git 路径的脏文件集合是空的（不用扫全树）', String(snap.files.size))

    const created = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('new.txt', 'hello\n')
    })
    ok(created?.total === 1, '新建未跟踪文件 → 只有 1 处改动', JSON.stringify(created?.files))
    const createdFile = created?.files.find((f) => f.path === 'new.txt')
    ok(createdFile?.status === 'created', '新建文件 → created', String(createdFile?.status))
    ok(createdFile?.added === 1 && createdFile?.beforeSize === -1, '新建文件给出新增行数，before 标记为不存在', JSON.stringify(createdFile))
    ok(!created?.unknown, '正常新建没有 unknown 标记', String(created?.unknown))
    repo.remove('new.txt')

    const modified = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('a.txt', 'line1\nline2-changed\n')
    })
    const aFile = modified?.files.find((f) => f.path === 'a.txt')
    ok(aFile?.status === 'modified', '原本干净的 tracked 文件被改 → modified（before 内容按需用 git show 取）', JSON.stringify(aFile))
    ok(aFile?.added === 1 && aFile?.removed === 1, '干净文件改动能给出正确的增删行数', JSON.stringify(aFile))
    ok(aFile?.beforeSize === 'line1\nline2\n'.length, '干净文件改动的 beforeSize 来自 git blob 的真实大小', String(aFile?.beforeSize))
    repo.run(['checkout', '--', 'a.txt'])

    repo.write('a.txt', 'line1\nline2-dirty\n')
    const unchangedDirty = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('a.txt', 'line1\nline2-dirty\n')
    })
    ok((unchangedDirty?.total ?? -1) === 0, '已经是脏的文件，命令前后内容完全一样 → 不算改动', JSON.stringify(unchangedDirty))

    const bothDirty = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('a.txt', 'line1\nline2-dirty-more\n')
    })
    const aFile2 = bothDirty?.files.find((f) => f.path === 'a.txt')
    ok(
      aFile2?.status === 'modified' && aFile2?.beforeSize === 'line1\nline2-dirty\n'.length,
      '已经是脏的文件被再次修改 → modified（两次快照都在脏集合里，直接比较，不用查 git）',
      JSON.stringify(aFile2)
    )
    repo.run(['checkout', '--', 'a.txt'])

    const deleted = await endGitSnapshotFor(mod, repo.root, () => {
      repo.remove('keep.txt')
    })
    const delFile = deleted?.files.find((f) => f.path === 'keep.txt')
    ok(delFile?.status === 'deleted', '原本干净的文件被删除 → deleted', JSON.stringify(delFile))
    ok(delFile?.afterSize === -1 && delFile?.beforeSize === 'keep\n'.length, 'deleted 的 afterSize 为 -1，beforeSize 来自 git blob', JSON.stringify(delFile))
    repo.run(['checkout', '--', 'keep.txt'])

    repo.write('a.txt', 'line1\nline2-temp\n')
    const reverted = await endGitSnapshotFor(mod, repo.root, () => {
      repo.run(['checkout', '--', 'a.txt'])
    })
    const revertedFile = reverted?.files.find((f) => f.path === 'a.txt')
    ok(
      revertedFile?.status === 'modified' && revertedFile?.afterSize === 'line1\nline2\n'.length,
      '脏文件被恢复成干净（前有后无），按新内容与旧内容比较后仍判定为真实改动',
      JSON.stringify(revertedFile)
    )

    repo.write('.gitignore', 'ignored.txt\n')
    repo.commit('add gitignore')
    const ignored = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('ignored.txt', 'secret\n')
    })
    ok(
      (ignored?.total ?? -1) === 0 && !ignored?.files.some((f) => f.path === 'ignored.txt'),
      '.gitignore 命中的新文件不报告（有意的行为变化：不再报告忽略文件）',
      JSON.stringify(ignored)
    )

    repo.write('stay.txt', 'stay\n')
    repo.write('to-delete.txt', 'bye\n')
    repo.write('to-modify.txt', 'before-commit\n')
    repo.commit('stage head-change fixtures')
    const headChanged = await endGitSnapshotFor(mod, repo.root, async () => {
      repo.write('brand-new.txt', 'via commit\n')
      repo.remove('to-delete.txt')
      repo.write('to-modify.txt', 'after-commit\n')
      repo.commit('batch change head')
    })
    const byPath = Object.fromEntries((headChanged?.files ?? []).map((f) => [f.path, f]))
    ok(byPath['brand-new.txt']?.status === 'created', 'HEAD 变了（commit）：新文件按 created 并入变化', JSON.stringify(byPath['brand-new.txt']))
    ok(byPath['to-delete.txt']?.status === 'deleted', 'HEAD 变了（commit）：被删的文件按 deleted 并入变化', JSON.stringify(byPath['to-delete.txt']))
    ok(byPath['to-modify.txt']?.status === 'modified', 'HEAD 变了（commit）：被改的文件按 modified 并入变化', JSON.stringify(byPath['to-modify.txt']))
    ok(!byPath['stay.txt'], 'HEAD 变了，但没碰过的文件不出现在变化里', JSON.stringify(headChanged?.files?.map((f) => f.path)))

    repo.write('temp-untracked.txt', 'scratch\n')
    const untrackedDeleted = await endGitSnapshotFor(mod, repo.root, () => {
      repo.remove('temp-untracked.txt')
    })
    const untrackedDelFile = untrackedDeleted?.files.find((f) => f.path === 'temp-untracked.txt')
    ok(
      untrackedDelFile?.status === 'deleted' && untrackedDelFile?.afterSize === -1,
      '未跟踪的脏文件被删除（之前从未提交过）→ deleted，不会被误判成“恢复成干净”',
      JSON.stringify(untrackedDelFile)
    )

    repo.run(['rm', '-q', 'keep.txt'])
    const recreated = await endGitSnapshotFor(mod, repo.root, () => {
      repo.write('keep.txt', 'brand-new-content\n')
    })
    const recreatedFile = recreated?.files.find((f) => f.path === 'keep.txt')
    ok(
      recreatedFile?.status === 'created' && recreatedFile?.beforeSize === -1,
      '已跟踪文件先被删除（before 就脏）、命令里又在原路径写回新内容（after 也脏）→ created（存在性翻转，两边都在脏集合里直接判断）',
      JSON.stringify(recreatedFile)
    )
    repo.run(['checkout', 'HEAD', '--', 'keep.txt'])

    for (let i = 0; i < 4001; i++) writeFileSync(join(repo.root, `dirty-${i}.txt`), String(i))
    const dirtyTruncated = await captureTree(repo.root)
    ok(dirtyTruncated.mode === 'git', '脏文件数巨大时仍然走 git 路径', String(dirtyTruncated.mode))
    ok(dirtyTruncated.truncated === true, '脏文件数超过上限（4000）→ truncated', String(dirtyTruncated.truncated))
    for (let i = 0; i < 4001; i++) unlinkSync(join(repo.root, `dirty-${i}.txt`))
  } finally {
    clearSnapshots()
    repo.cleanup()
  }

  const wide = tempRoot('git-non-repo-wide')
  try {
    for (let dir = 0; dir < 45; dir += 1) {
      const abs = join(wide.root, `dir-${dir}`)
      mkdirSync(abs, { recursive: true })
      for (let file = 0; file < 100; file += 1) writeFileSync(join(abs, `f-${file}.txt`), `line ${dir}/${file}\n`)
    }
    const before = await captureTree(wide.root)
    ok(before.mode === 'walk', '非 Git 目录 → captureTree 走目录遍历路径', String(before.mode))
    ok(before.truncated === true, '非 Git 目录超过 4000 个文件 → truncated', String(before.truncated))
    ok(before.files.size === 4000, '非 Git 目录截断后正好停在上限', String(before.files.size))

    const after = await captureTree(wide.root, before)
    ok(after.files.size === before.files.size, '同一棵树重复扫描，截断后的文件数一致', String(after.files.size))
    const sameKeys = [...before.files.keys()].every((k) => after.files.has(k)) && [...after.files.keys()].every((k) => before.files.has(k))
    ok(sameKeys, '遍历顺序确定 → 两次截断截到的是同一批文件（不会互相误报新建/删除）', String(sameKeys))

    const noise = diffTrees(before, after)
    ok(noise.length === 0, '非 Git 目录在截断上限之上，没有任何实际改动时不会产生误报', JSON.stringify(noise))
  } finally {
    wide.cleanup()
  }
}
