import { mkdir, open, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ABANDONED_LOCK_MS = 5 * 60 * 1000
const ABANDONED_GUARD_MS = 30 * 1000
const OWN_IMAGE = basename(process.execPath).toLowerCase()

function runningImage(pid: number): string | null {
  if (process.platform !== 'win32') return null
  try {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const image = /^"([^"]+)","\d+"/m.exec(row)?.[1]
    return image ? image.toLowerCase() : null
  } catch {
    return null
  }
}

function ownerAlive(owner: { pid: number; image?: string }): boolean {
  try {
    process.kill(owner.pid, 0)
  } catch (probeError) {
    if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError
    return false
  }
  const expected = typeof owner.image === 'string' ? owner.image.toLowerCase() : OWN_IMAGE
  const actual = runningImage(owner.pid)
  return actual === null || actual === expected
}

async function staleGuard(guardPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(guardPath)).mtimeMs > ABANDONED_GUARD_MS
  } catch {
    return false
  }
}

async function abandonedLock(lock: string): Promise<boolean> {
  try {
    const info = await stat(lock)
    return Date.now() - info.mtimeMs > ABANDONED_LOCK_MS
  } catch {
    return false
  }
}

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
        if (await staleGuard(guardPath)) { await unlink(guardPath).catch(() => undefined); continue }
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
      let owner: { pid: number; nonce: string; image?: string }
      try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) } catch {
        if (attempt !== 0 || !(await abandonedLock(lock))) throw new Error('数据目录存在未知写入者，拒绝启动；请核实 .runtime-writer')
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录写入锁无效，拒绝启动')
      if (ownerAlive(owner)) throw new Error(`数据目录正由进程 ${owner.pid} 使用`)
      if (attempt !== 0) throw new Error('数据目录锁竞争，请稍后重试')
      const current = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as typeof owner
      if (current.nonce !== owner.nonce) throw new Error('数据目录锁已变化')
      await rm(lock, { recursive: true })
    }
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, image: OWN_IMAGE }), { flag: 'wx' })
  })
  return async () => {
    await guard(async () => {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { nonce: string }
    if (owner.nonce !== nonce) throw new Error('拒绝释放其他写入者的锁')
    await rm(lock, { recursive: true })
    })
  }
}
