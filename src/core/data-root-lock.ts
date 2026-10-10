import { mkdir, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One cooperating writer per canonical data root. Unknown owners fail closed. */
export async function lockDataRoot(root: string): Promise<() => Promise<void>> {
  await mkdir(resolve(root), { recursive: true })
  const canonical = await realpath(resolve(root))
  const lock = join(canonical, '.runtime-writer')
  const guardPath = join(canonical, '.runtime-writer-guard')
  async function guard<T>(operation: () => Promise<T>): Promise<T> {
    let handle
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await open(guardPath, 'wx'); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 10))
      }
    }
    if (!handle) throw new Error('数据目录锁正在交接或存在中断的锁守卫，请核实后重试')
    try { return await operation() } finally { await handle.close(); await unlink(guardPath) }
  }
  const nonce = randomUUID()
  await guard(async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await mkdir(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid: number; nonce: string }
      try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) } catch { throw new Error('数据目录存在未知写入者，拒绝启动；请核实 .runtime-writer') }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录写入锁无效，拒绝启动')
      try { process.kill(owner.pid, 0); throw new Error(`数据目录正由进程 ${owner.pid} 使用`) } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError
      }
      if (attempt !== 0) throw new Error('数据目录锁竞争，请稍后重试')
      // Verify the dead owner again before reclaiming its directory.
      const current = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as typeof owner
      if (current.nonce !== owner.nonce) throw new Error('数据目录锁已变化')
      await rm(lock, { recursive: true })
    }
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx' })
  })
  return async () => {
    await guard(async () => {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { nonce: string }
    if (owner.nonce !== nonce) throw new Error('拒绝释放其他写入者的锁')
    await rm(lock, { recursive: true })
    })
  }
}
