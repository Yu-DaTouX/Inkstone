import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WAIT_MS = 4000

async function waitFor(predicate) {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

export async function runFilesWatchTests(ok, { FilesWatcher }) {
  const root = await mkdtemp(join(tmpdir(), 'yan-files-watch-'))
  const watcher = new FilesWatcher()
  try {
    await mkdir(join(root, 'src'), { recursive: true })

    const first = []
    const listed = await watcher.set('w1', root, ['', 'src'], (dir) => first.push(dir))
    ok(listed.dirs.includes('') && listed.dirs.includes('src'), '目录监听登记展开的相对目录')
    ok(listed.dropped.length === 0, '目录监听不丢弃工作区内的目录')

    const outside = await watcher.set('w2', root, ['..'], () => {})
    ok(outside.dirs.length === 0 && outside.dropped.includes('..'), '目录监听拒绝越界路径')

    first.length = 0
    await writeFile(join(root, 'src', 'added.txt'), 'x')
    ok(await waitFor(() => first.includes('src')), '子目录变化通知到该目录')

    first.length = 0
    await writeFile(join(root, 'root.txt'), 'x')
    ok(await waitFor(() => first.includes('')), '根目录变化通知到根目录')

    const shared = []
    await watcher.set('w4', root, [''], () => shared.push('w4'))
    await watcher.set('w5', root, [''], () => shared.push('w5'))
    await writeFile(join(root, 'shared.txt'), 'x')
    ok(await waitFor(() => shared.includes('w4') && shared.includes('w5')), '同一目录被多个监听方共享')

    watcher.release('w1')
    watcher.release('w4')
    watcher.release('w5')
    shared.length = 0
    await writeFile(join(root, 'after-release.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 500))
    ok(shared.length === 0, '释放后不再收到通知')

    const many = []
    for (let i = 0; i < 260; i += 1) {
      const dir = join(root, `d${String(i).padStart(3, '0')}`)
      many.push(`d${String(i).padStart(3, '0')}`)
      await mkdir(dir)
    }
    const limited = await watcher.set('w6', root, many, () => {})
    ok(limited.dirs.length === 256 && limited.dropped.length === 4, '目录监听对监听数量设上限并报告被丢弃的目录')
  } finally {
    watcher.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
