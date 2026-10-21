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

    const raced = []
    const older = watcher.set('w7', root, ['src'], () => raced.push('old'))
    const newer = watcher.set('w7', root, [''], () => raced.push('new'))
    const [olderResult, newerResult] = await Promise.all([older, newer])
    ok(olderResult.superseded === true && newerResult.dirs.join() === '', '目录监听：旧的订阅被新订阅取代，不覆盖结果')
    raced.length = 0
    await writeFile(join(root, 'src', 'raced.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 500))
    ok(!raced.includes('old'), '目录监听：被取代的订阅不再收到通知')
    watcher.release('w7')

    const released = []
    const pending = watcher.set('w8', root, ['src'], () => released.push('w8'))
    watcher.release('w8')
    const pendingResult = await pending
    await writeFile(join(root, 'src', 'released.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 500))
    ok(pendingResult.superseded === true && released.length === 0, '目录监听：释放在途订阅后不再挂上监听')

    const many = []
    for (let i = 0; i < 260; i += 1) {
      const dir = join(root, `d${String(i).padStart(3, '0')}`)
      many.push(`d${String(i).padStart(3, '0')}`)
      await mkdir(dir)
    }
    const limited = await watcher.set('w6', root, many, () => {})
    ok(limited.dirs.length === 256 && limited.dropped.length === 4, '目录监听对监听数量设上限并报告被丢弃的目录')

    const created = []
    const fakeWatch = (dir, _options, listener) => {
      const handlers = new Map()
      const entry = {
        dir,
        closed: false,
        emit: () => listener('change', 'x'),
        fail: () => handlers.get('error')?.(new Error('EPERM')),
        close() {
          entry.closed = true
        },
        on(event, handler) {
          handlers.set(event, handler)
          return entry
        }
      }
      created.push(entry)
      return entry
    }

    const flaky = new FilesWatcher(fakeWatch)
    const fired = []
    const firstAttach = await flaky.set('f1', root, ['src'], (dir) => fired.push(dir))
    ok(firstAttach.dirs.includes('src') && created.length === 1, '目录监听可以挂上替身 watcher')
    created[0]?.emit()
    ok(await waitFor(() => fired.includes('src')), '替身 watcher 的事件能通知到监听方')
    fired.length = 0
    created[0]?.fail()
    await flaky.set('f1', root, ['src'], (dir) => fired.push(dir))
    ok(created.length === 2, '**watcher 出错后下次 set 重新挂上监听**（旧实现永久失效）')
    created[1]?.emit()
    ok(await waitFor(() => fired.includes('src')), '重新挂上后该目录的实时刷新恢复')
    flaky.dispose()

    let attempts = 0
    const broken = new FilesWatcher((dir, options, listener) => {
      attempts += 1
      if (attempts === 1) throw new Error('EMFILE')
      return fakeWatch(dir, options, listener)
    })
    const firstTry = await broken.set('f2', root, ['src'], () => {})
    ok(firstTry.dirs.length === 0 && firstTry.dropped.includes('src'), '挂不上监听的目录报为 dropped，不假装已监听')
    const secondTry = await broken.set('f2', root, ['src'], () => {})
    ok(attempts === 2 && secondTry.dirs.includes('src') && !secondTry.dropped.includes('src'), '上次挂失败的目录下次 set 会重新挂上')
    broken.dispose()
  } finally {
    watcher.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
