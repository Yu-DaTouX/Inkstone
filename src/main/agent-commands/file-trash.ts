import { realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CapabilityCommandError, type CapabilityCommandResult } from '../capability-server'
import { getSettings } from '../settings'
import { YAN_DIR } from '../paths'
import type { DangerConfirmHost } from './danger-confirm'

export interface FileTrashHost extends DangerConfirmHost {
  trashItem(): ((path: string) => Promise<void>) | undefined
}

export async function runFileTrashCommand(host: FileTrashHost, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
  const trash = host.trashItem()
  if (!trash) throw new CapabilityCommandError('trash_unavailable', '回收站当前不可用（宿主未注入）')
  const raw = [
    ...(typeof params.path === 'string' ? [params.path] : []),
    ...(Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === 'string') : [])
  ].map((p) => p.trim()).filter(Boolean)
  if (!raw.length) throw new CapabilityCommandError('trash_path_required', '缺少 --path（或请求文件里的 paths）')
  if (raw.length > 200) throw new CapabilityCommandError('trash_too_many', '一次最多移动 200 个路径')
  signal?.throwIfAborted()
  const cwd = host.cwd()
  const paths = raw.map((item) => isAbsolute(item) ? resolve(item) : resolve(cwd, item))
  const settings = await getSettings()
  if (settings.guardOutsideWrites && (await host.permissionMode()) !== 'all') {
    const roots = await Promise.all([
      host.cwd(), tmpdir(), '/tmp', '/var/tmp', join(YAN_DIR, 'tmp'), join(YAN_DIR, 'artifacts'),
      ...(settings.guardAllowRoots ?? [])
    ].map((root) => realpath(root).catch(() => resolve(root))))
    const outside: string[] = []
    for (const path of paths) {
      const actual = join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path))
      if (!roots.some((root) => {
        const rel = relative(root, actual)
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      })) outside.push(path)
    }
    if (outside.length) {
      const answer = await host.confirmDanger({
        tool: 'yan file trash',
        detail: outside.join('\n').slice(0, 20_000),
        reasons: ['要移动当前项目和已允许目录之外的文件到回收站'],
        cwd: host.cwd(),
        owner: host.approvalOwner(),
        outsideDirs: outside,
        signal
      })
      if (answer?.decision !== 'allow') {
        throw new CapabilityCommandError('trash_outside_denied', answer?.feedback ?? '没有得到目录外操作的确认，未移动到回收站')
      }
    }
  }
  signal?.throwIfAborted()
  const home = resolve(homedir()).toLowerCase()
  const trashed: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const abs of paths) {
    signal?.throwIfAborted()
    const key = abs.toLowerCase().replace(/[\\/]+$/, '')
    if (dirname(abs) === abs || key === home) {
      failed.push({ path: abs, error: '拒绝把盘符根目录或家目录整体移到回收站' })
      continue
    }
    try {
      await stat(abs)
      signal?.throwIfAborted()
      await trash(abs)
      trashed.push(abs)
    } catch (error) {
      if (signal?.aborted) throw error
      failed.push({ path: abs, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    data: { trashed, failed },
    summary: { kind: 'file-trash', trashed: trashed.length, failed: failed.length }
  }
}
