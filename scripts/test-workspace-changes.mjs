/**
 * shell / 第三方工具的**目录级改动归属**（L05，`src/main/snapshots.ts`）。
 *
 * 为什么要单测：真实窗口里很难制造“同一目录两个任务同时改文件”“同大小不同
 * 内容”“目录太大被截断”这些组合，而它们决定界面到底显示“改了”还是
 * “无法可靠归属”。纯逻辑里一次钉死，live 只补真实工具链那一段。
 *
 * 全部在系统临时目录里造数据，不碰用户目录。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个临时工作目录；返回 root 与清理函数 */
function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `yan-ws-${label}-`))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeFile(root, rel, text) {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
}

export function runWorkspaceChangesTests(ok, mod) {
  const { captureTree, diffTrees, beginTreeSnapshot, endTreeSnapshot } = mod

  /* ---------------------------------------------------------- 纯差分 */
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

  /* 等长内容的替换：只有哈希能看出来，这是“别拿 size 冒充结论”的关键用例 */
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

  /* ------------------------------------------------- 真实目录：扫描 + 差分 */
  const { root, cleanup } = tempRoot('tree')
  try {
    writeFile(root, 'src/a.ts', 'const a = 1\n')
    writeFile(root, 'src/b.ts', 'const b = 2\n')
    writeFile(root, 'README.md', '# hi\n')
    writeFile(root, 'node_modules/dep/index.js', 'module.exports = 1\n')
    const before = captureTree(root)
    ok(before.files.has('src/a.ts'), '扫到了普通文件（相对路径，正斜杠）', [...before.files.keys()].join(','))
    ok(!before.files.has('node_modules/dep/index.js'), 'node_modules 里的文件不扫（依赖目录跳过）')
    ok(before.files.get('src/a.ts').content === 'const a = 1\n', '小文件连内容一起留下（为了逐行 patch）')

    /* 改一个、加一个、删一个 */
    writeFile(root, 'src/a.ts', 'const a = 111\n')
    writeFile(root, 'src/c.ts', 'const c = 3\n')
    unlinkSync(join(root, 'README.md'))
    writeFile(root, 'node_modules/dep/index.js', 'module.exports = 2\n')

    const after = captureTree(root)
    const changes = diffTrees(before, after)
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]))
    ok(byPath['src/a.ts'] === 'modified', '改过的文件 → modified', JSON.stringify(byPath))
    ok(byPath['src/c.ts'] === 'created', '新文件 → created')
    ok(byPath['README.md'] === 'deleted', '删掉的文件 → deleted')
    ok(!('node_modules/dep/index.js' in byPath), '依赖目录里的改动被忽略（不冒充用户改动）')

    const result = endTreeSnapshotFor(mod, root, () => {
      writeFile(root, 'src/d.ts', 'const d = 4\n')
    })
    ok(result && result.total === 1, '真实调用：只有真的改了的文件进结果', JSON.stringify(result && result.files))
    ok(result && result.files[0].path === 'src/d.ts' && result.files[0].status === 'created', '新建文件被认领')
    ok(result && result.files[0].added === 1, '新建文件能给出新增行数（读了内容）', String(result?.files?.[0]?.added))
    ok(result && !result.unknown, '没有并发/截断时不给 unknown')

    const quiet = endTreeSnapshotFor(mod, root, () => {})
    ok(quiet && quiet.total === 0 && !quiet.unknown, '什么都没改 → total=0 且不标 unknown（“扫过且没变”是结论）')
    ok(quiet && quiet.scanned > 0, 'scanned 有值 —— 界面能说清“扫了多少”', String(quiet?.scanned))

    /* 大文件：只记元信息，不读内容 → 行数写 -1，不编造 */
    writeFile(root, 'big.bin', 'x'.repeat(300 * 1024) + '\n')
    const beforeBig = captureTree(root)
    /* 等长内容改写：大文件没读过内容 → 只能给 unknown（如实，不猜） */
    writeFile(root, 'big.bin', 'y'.repeat(300 * 1024) + '\n')
    const bigChanges = diffTrees(beforeBig, captureTree(root))
    ok(
      bigChanges.some((c) => c.path === 'big.bin' && c.status === 'unknown'),
      '大文件等长改写 → unknown（没读内容就不能说“内容变了”）',
      JSON.stringify(bigChanges)
    )
    /* 长度变了就是硬证据，哪怕是大文件 */
    writeFile(root, 'big.bin', 'y'.repeat(300 * 1024 + 10) + '\n')
    const bigGrew = diffTrees(beforeBig, captureTree(root))
    ok(
      bigGrew.some((c) => c.path === 'big.bin' && c.status === 'modified'),
      '大文件长度变了 → modified（大小是硬证据）',
      JSON.stringify(bigGrew)
    )
    ok(
      beforeBig.files.get('big.bin').content === undefined,
      '大文件不留内容（避免把几十 MB 读进内存）'
    )
    const bigResult = endTreeSnapshotFor(mod, root, () => {
      writeFile(root, 'big2.bin', 'z'.repeat(300 * 1024) + '\n')
    })
    const bigFile = bigResult?.files.find((f) => f.path === 'big2.bin')
    ok(bigFile && bigFile.added === -1 && bigFile.patch === '', '大文件不给行数与 patch（如实退化，不编造）', JSON.stringify(bigFile))

    /* -------------------------------------------------- 并发：谁都不认领 */
    beginTreeSnapshot('call-A', root, 's1')
    beginTreeSnapshot('call-B', root, 's2')
    writeFile(root, 'src/shared.ts', 'export const x = 1\n')
    const a = endTreeSnapshot('call-A')
    const b = endTreeSnapshot('call-B')
    ok(a?.unknown === 'concurrent', '同一目录两个并发快照 → A 标 concurrent', String(a?.unknown))
    ok(b?.unknown === 'concurrent', '同一目录两个并发快照 → B 也标 concurrent', String(b?.unknown))
    ok(
      (a?.files ?? []).length > 0 && (b?.files ?? []).length > 0,
      '并发时仍然列出差异（信息给到，但明确说不能归属）'
    )

    /* 不同目录（隔离 worktree）不算并发 */
    const other = tempRoot('other')
    try {
      beginTreeSnapshot('call-C', root, 's1')
      beginTreeSnapshot('call-D', other.root, 's2')
      writeFile(root, 'src/only-c.ts', 'export const c = 1\n')
      const c = endTreeSnapshot('call-C')
      const d = endTreeSnapshot('call-D')
      ok(!c?.unknown, '另一个目录的快照不算并发（worktree 隔离场景）', String(c?.unknown))
      ok(d && d.total === 0, '隔离目录自己那份快照没有差异')
    } finally {
      other.cleanup()
    }

    ok(endTreeSnapshot('never-started') === null, '没拍过快照的调用 → null（不显示改动卡片）')

    const unreadable = tempRoot('unreadable')
    const missing = join(unreadable.root, 'not-there')
    unreadable.cleanup()
    beginTreeSnapshot('call-E', missing, 's1')
    const e = endTreeSnapshot('call-E')
    ok(e?.unknown === 'unreadable', '根目录读不到 → unreadable（不假装“没有改动”）', String(e?.unknown))
  } finally {
    cleanup()
  }
}

/** 拍一次“调用期间做点什么”的快照，返回结果（省掉每个用例重复 begin/end 样板） */
function endTreeSnapshotFor(mod, root, mutate) {
  const { beginTreeSnapshot, endTreeSnapshot } = mod
  const id = 'call-' + Math.random().toString(36).slice(2)
  beginTreeSnapshot(id, root, 'unit')
  mutate()
  return endTreeSnapshot(id)
}
