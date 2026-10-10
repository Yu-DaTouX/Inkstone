import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskApplyItem, TaskApplyResult, TaskInput, TaskOutput } from '../shared/agent-service'

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
export async function checkedPath(root: string, name: string, writing = false): Promise<string> {
  const base = await realpath(root)
  const target = resolve(base, name)
  if (!inside(base, target)) throw new Error('文件路径超出授权目录')
  if (process.platform === 'win32' && relative(base, target).split(/[\\/]/).some(part => part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('拒绝 Windows 设备名、数据流或歧义路径')
  let probe = target
  while (true) {
    try {
      const resolved = await realpath(probe)
      if (!inside(base, resolved)) throw new Error('符号链接超出授权目录')
      break
    } catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || probe === base) throw error
      probe = dirname(probe)
    }
  }
  return target
}
export async function fileHash(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('目标不是普通文件')
    const hash = createHash('sha256')
    const handle = await open(path, 'r')
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk) } finally { await handle.close() }
    return hash.digest('hex')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function copyInputs(workspace: string, sources: string[]): Promise<TaskInput[]> {
  if (sources.length > 64) throw new Error('最多选择 64 个输入文件；请先缩小范围')
  const planned: Array<{ source: string; name: string; bytes: number }> = []
  let total = 0
  const names = new Set<string>()
  for (const source of sources) {
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('只接受普通文件，不递归复制目录或链接')
    if (info.size > MAX_INPUT_BYTES || (total += info.size) > MAX_TOTAL_BYTES) throw new Error('输入超过复制容量上限，请先拆分任务')
    const name = basename(source)
    if (names.has(name.toLowerCase())) throw new Error(`输入文件重名：${name}`)
    names.add(name.toLowerCase()); planned.push({ source: await realpath(source), name, bytes: info.size })
  }
  await mkdir(join(workspace, 'inputs'), { recursive: true })
  await mkdir(join(workspace, 'outputs'), { recursive: true })
  const inputs: TaskInput[] = []
  for (const plan of planned) {
    const before = await fileHash(plan.source)
    const target = join(workspace, 'inputs', plan.name)
    await copyFile(plan.source, target)
    const sha256 = await fileHash(target)
    if (!sha256 || sha256 !== before || await fileHash(plan.source) !== before) throw new Error(`复制期间原件发生变化：${plan.name}`)
    inputs.push({ ...plan, sha256 })
  }
  return inputs
}
export async function collectOutputs(root: string): Promise<TaskOutput[]> {
  const results: TaskOutput[] = []
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.children') continue
      if (entry.isSymbolicLink()) throw new Error('成果目录不接受符号链接')
      const full = await checkedPath(root, relative(root, join(path, entry.name)))
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        if (results.length >= 1024) throw new Error('成果文件超过 1024 个，请缩小范围')
        results.push({ name: relative(root, full), sha256: (await fileHash(full))!, bytes: (await stat(full)).size })
      }
    }
  }
  await visit(root)
  return results
}
export async function previewOutput(root: string, name: string): Promise<{ text: string; truncated: boolean }> {
  const path = await checkedPath(root, name)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(128 * 1024 + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { text: buffer.subarray(0, Math.min(bytesRead, buffer.length - 1)).toString('utf8'), truncated: bytesRead === buffer.length }
  } finally { await handle.close() }
}
export async function planApply(root: string, items: Array<{ output: string; destination: string }>): Promise<TaskApplyItem[]> {
  if (!items.length || items.length > 64) throw new Error('应用清单须包含 1 至 64 个文件')
  const destinations = new Set<string>()
  const planned: TaskApplyItem[] = []
  let total = 0
  for (const item of items) {
    const source = await checkedPath(root, item.output)
    const bytes = (await stat(source)).size
    if (bytes > MAX_INPUT_BYTES || (total += bytes) > MAX_TOTAL_BYTES) throw new Error('成果应用超过容量上限，请先拆分交付')
    const outputSha256 = await fileHash(source)
    if (!outputSha256) throw new Error('成果不存在')
    const parent = await realpath(dirname(resolve(item.destination)))
    const destination = join(parent, basename(item.destination))
    if (inside(await realpath(root), destination)) throw new Error('应用目标不能位于成果目录内')
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination
    if (destinations.has(key)) throw new Error('应用目标重复')
    destinations.add(key)
    planned.push({ output: item.output, destination, expectedSha256: await fileHash(destination), outputSha256 })
  }
  return planned
}
/** Each file is checked again immediately before replacement; partial completion is explicit. */
export async function applyOutputs(root: string, plan: TaskApplyItem[], beforeReplace?: (item: TaskApplyItem, index: number) => Promise<void>): Promise<TaskApplyResult> {
  const result: TaskApplyResult = { applied: [], conflicts: [], pending: plan.map(item => item.destination) }
  for (const [index, item] of plan.entries()) {
    let temp: string | undefined
    try {
      const source = await checkedPath(root, item.output)
      if (await fileHash(source) !== item.outputSha256 || await fileHash(item.destination) !== item.expectedSha256 || await realpath(dirname(item.destination)) !== dirname(item.destination)) {
        result.conflicts.push(item.destination); continue
      }
      temp = `${item.destination}.inkstone-${process.pid}-${index}.new`
      const handle = await open(temp, 'wx')
      try { await handle.writeFile(await readFile(source)); await handle.sync() } finally { await handle.close() }
      await beforeReplace?.(item, index)
      if (await fileHash(item.destination) !== item.expectedSha256 || await fileHash(temp) !== item.outputSha256) { result.conflicts.push(item.destination); continue }
      // External writers are not locked by this host; this is optimistic version checking.
      await rename(temp, item.destination)
      temp = undefined
      result.applied.push(item.destination)
      result.pending = result.pending.filter(path => path !== item.destination)
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); break }
    finally { if (temp) await unlink(temp).catch(() => undefined) }
  }
  return result
}
