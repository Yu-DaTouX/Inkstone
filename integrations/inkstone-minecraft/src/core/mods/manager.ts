import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ModInstallResult,
  ModListResult,
  ModrinthProject,
  ModrinthSearchQuery,
  ModrinthSearchResult,
  ModrinthVersion,
  ModUpdateCheckResult,
  ModUpdateInfo,
  ModUpdateResult
} from '../../shared/mods-api.ts'
import type { TaskProgress } from '../../shared/api.ts'
import { downloadFiles, type RemoteFile } from '../download/download.ts'
import { analyzeMods, countIssues } from './analyze.ts'
import { ModrinthClient } from './modrinth.ts'
import { modsDir, readModEntries, scanModFiles, type HashCache } from './scan.ts'
import { ModStore } from './store.ts'
import { listTrash, moveToTrash, purgeTrash, restoreFromTrash } from './trash.ts'

export interface InstanceContext {
  folder: string
  versionId: string
  gameDir: string
  loader: string
  minecraftVersion: string | null
}

export interface ModsManagerOptions {
  dataDir: string
  fetchImpl?: typeof fetch
  apiBase?: string
  client?: ModrinthClient
}

export interface ModWorkOptions {
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
}

function contextKey(ctx: InstanceContext): string {
  return `${ctx.gameDir.toLowerCase()}|${ctx.versionId}`
}

export class ModsManager {
  readonly store: ModStore
  readonly client: ModrinthClient
  private readonly hashCache: HashCache = new Map()
  private readonly updates = new Map<string, ModUpdateInfo>()
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: ModsManagerOptions) {
    this.store = new ModStore(options.dataDir)
    this.fetchImpl = options.fetchImpl
    this.client =
      options.client ??
      new ModrinthClient({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.apiBase ? { apiBase: options.apiBase } : {})
      })
  }

  private updateKey(ctx: InstanceContext, sha1: string): string {
    return `${contextKey(ctx)}|${sha1.toLowerCase()}`
  }

  private updatesFor(ctx: InstanceContext): ModUpdateInfo[] {
    return [...this.updates.entries()].filter(([key]) => key.startsWith(`${contextKey(ctx)}|`)).map(([, value]) => value)
  }

  async list(ctx: InstanceContext): Promise<ModListResult> {
    const mods = await readModEntries({ gameDir: ctx.gameDir, store: this.store, hashCache: this.hashCache })
    analyzeMods(mods, { loader: ctx.loader, minecraftVersion: ctx.minecraftVersion })
    const updates = this.updatesFor(ctx)
    return {
      versionId: ctx.versionId,
      gameDir: ctx.gameDir,
      loader: ctx.loader,
      minecraftVersion: ctx.minecraftVersion,
      mods,
      counts: {
        total: mods.length,
        enabled: mods.filter((mod) => mod.enabled).length,
        disabled: mods.filter((mod) => !mod.enabled).length,
        updates: updates.length,
        issues: countIssues(mods)
      },
      trash: await listTrash(ctx.gameDir)
    }
  }

  async toggle(ctx: InstanceContext, file: string, enabled: boolean): Promise<ModListResult> {
    const target = await this.targetPath(ctx, file)
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) throw new Error('找不到这个 Mod 文件')
    const disabled = file.toLowerCase().endsWith('.disabled')
    if (enabled === !disabled) return this.list(ctx)
    const nextName = enabled ? file.slice(0, -'.disabled'.length) : `${file}.disabled`
    const next = join(modsDir(ctx.gameDir), nextName)
    const conflict = await stat(next).catch(() => null)
    if (conflict) throw new Error(`已经有 ${nextName}，先处理重复文件`)
    await rename(target, next)
    return this.list(ctx)
  }

  private async targetPath(ctx: InstanceContext, file: string): Promise<string> {
    if (!file || basename(file) !== file || /[\\/]/.test(file)) throw new Error('文件名不合法')
    return join(modsDir(ctx.gameDir), file)
  }

  async remove(ctx: InstanceContext, file: string): Promise<ModListResult> {
    const info = await stat(await this.targetPath(ctx, file)).catch(() => null)
    if (!info?.isFile()) throw new Error('找不到这个 Mod 文件')
    await moveToTrash(ctx.gameDir, ctx.versionId, file)
    return this.list(ctx)
  }

  async restore(ctx: InstanceContext, id: string): Promise<ModListResult> {
    await restoreFromTrash(ctx.gameDir, id)
    return this.list(ctx)
  }

  async purge(ctx: InstanceContext, id: string): Promise<ModListResult> {
    await purgeTrash(ctx.gameDir, id)
    return this.list(ctx)
  }

  async checkUpdates(ctx: InstanceContext, options: ModWorkOptions = {}): Promise<ModUpdateCheckResult> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const hashes = [...new Set(files.map((file) => file.sha1))]
    if (hashes.length === 0) return { checkedAt: Date.now(), updates: [], unknown: [], error: null }
    options.onProgress?.({ done: 0, total: 2, unit: 'steps' }, '查询 Modrinth')
    try {
      const known = await this.client.byHashes(hashes)
      for (const [sha1, version] of known) {
        const existing = this.store.modrinthOf(sha1)
        if (existing && existing.projectId === version.projectId && existing.title) continue
        await this.store.rememberModrinth(sha1, { projectId: version.projectId, title: null, iconUrl: existing?.iconUrl ?? null })
      }
      options.onProgress?.({ done: 1, total: 2, unit: 'steps' }, '匹配可更新版本')
      const latest = await this.client.updates(hashes, { loader: ctx.loader, minecraft: ctx.minecraftVersion })
      const updates: ModUpdateInfo[] = []
      for (const [sha1, version] of latest) {
        if (version.file.sha1.toLowerCase() === sha1) continue
        const current = files.find((file) => file.sha1 === sha1)
        if (!current) continue
        const record = this.store.modrinthOf(sha1)
        const info: ModUpdateInfo = {
          sha1,
          file: current.file,
          projectId: version.projectId,
          projectTitle: record?.title ?? null,
          versionId: version.id,
          versionNumber: version.versionNumber,
          fileName: version.file.fileName,
          fileSha1: version.file.sha1,
          fileSize: version.file.size,
          downloadUrl: version.file.url,
          iconUrl: record?.iconUrl ?? null,
          gameVersions: version.gameVersions,
          loaders: version.loaders
        }
        updates.push(info)
        this.updates.set(this.updateKey(ctx, sha1), info)
      }
      const unknown = files.filter((file) => !known.has(file.sha1)).map((file) => file.file)
      options.onProgress?.({ done: 2, total: 2, unit: 'steps' }, '检查完成')
      return { checkedAt: Date.now(), updates, unknown, error: null }
    } catch (error) {
      return { checkedAt: Date.now(), updates: [], unknown: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async update(ctx: InstanceContext, updates: ModUpdateInfo[], options: ModWorkOptions = {}): Promise<ModUpdateResult> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const queue = updates.filter((item) => files.some((file) => file.sha1 === item.sha1 && file.enabled))
    const result: ModUpdateResult = { updated: [], skipped: [], trashed: [] }
    if (queue.length === 0) return result
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const tempOf = (item: ModUpdateInfo): string => join(dir, `.${item.fileSha1}.download`)
    const downloads: RemoteFile[] = queue.map((item) => ({ url: item.downloadUrl, dest: tempOf(item), sha1: item.fileSha1, size: item.fileSize }))
    options.onProgress?.({ done: 0, total: queue.length, unit: 'files' }, '下载更新')
    await downloadFiles(downloads, {
      source: 'official',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      onProgress: (progress) => options.onProgress?.(progress, '下载更新')
    })
    for (const item of queue) {
      const temp = tempOf(item)
      const current = files.find((file) => file.sha1 === item.sha1)
      if (!current) {
        await rm(temp, { force: true })
        result.skipped.push(item.file)
        continue
      }
      await moveToTrash(ctx.gameDir, ctx.versionId, current.file)
      result.trashed.push(current.file)
      await rename(temp, join(dir, item.fileName))
      result.updated.push(item.fileName)
      this.updates.delete(this.updateKey(ctx, item.sha1))
    }
    return result
  }

  search(query: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    return this.client.search(query)
  }

  versions(projectId: string, filter: { loader?: string | null; minecraft?: string | null } = {}): Promise<ModrinthVersion[]> {
    return this.client.versions(projectId, filter)
  }

  project(projectId: string): Promise<ModrinthProject | null> {
    return this.client.project(projectId)
  }

  private async installedContext(ctx: InstanceContext): Promise<{ files: Awaited<ReturnType<typeof scanModFiles>>; projectIds: Set<string>; names: Set<string> }> {
    const files = await scanModFiles(ctx.gameDir, this.hashCache)
    const projectIds = new Set<string>()
    const known = await this.client.byHashes([...new Set(files.map((file) => file.sha1))]).catch(() => new Map<string, ModrinthVersion>())
    for (const [sha1, version] of known) {
      projectIds.add(version.projectId)
      const existing = this.store.modrinthOf(sha1)
      if (!existing || existing.projectId !== version.projectId) {
        await this.store.rememberModrinth(sha1, { projectId: version.projectId, title: null, iconUrl: existing?.iconUrl ?? null })
      }
    }
    return { files, projectIds, names: new Set(files.map((file) => file.file.toLowerCase())) }
  }

  async install(ctx: InstanceContext, versionFileId: string, options: ModWorkOptions = {}): Promise<ModInstallResult> {
    const version = await this.client.versionById(versionFileId)
    if (!version) throw new Error('Modrinth 上没有这个版本')
    const project = await this.client.project(version.projectId).catch(() => null)
    const { projectIds, names } = await this.installedContext(ctx)
    const plan: Array<{ version: ModrinthVersion; kind: 'target' | 'dependency' }> = [{ version, kind: 'target' }]
    const dependencyVersions = await this.resolveDependencies(version, ctx, projectIds, options)
    for (const dep of dependencyVersions) plan.push({ version: dep, kind: 'dependency' })
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const installed: string[] = []
    const skipped: string[] = []
    const dependencies: string[] = []
    const downloads: RemoteFile[] = []
    const staged: Array<{ version: ModrinthVersion; kind: 'target' | 'dependency' }> = []
    for (const item of plan) {
      if (names.has(item.version.file.fileName.toLowerCase())) {
        skipped.push(item.version.file.fileName)
        continue
      }
      downloads.push({ url: item.version.file.url, dest: join(dir, item.version.file.fileName), sha1: item.version.file.sha1, size: item.version.file.size })
      staged.push(item)
    }
    if (downloads.length > 0) {
      await downloadFiles(downloads, {
        source: 'official',
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? '下载 Mod')
      })
    }
    for (const item of staged) {
      installed.push(item.version.file.fileName)
      if (item.kind === 'dependency') dependencies.push(item.version.file.fileName)
      await this.store.rememberModrinth(item.version.file.sha1, { projectId: item.version.projectId, title: null, iconUrl: null })
    }
    if (project) {
      for (const sha1 of [version.file.sha1, ...dependencyVersions.map((dep) => dep.file.sha1)]) {
        const record = this.store.modrinthOf(sha1)
        if (record && !record.iconUrl && project.iconUrl) await this.store.rememberModrinth(sha1, { ...record, iconUrl: project.iconUrl })
      }
    }
    return { installed, skipped, dependencies, targetDir: dir }
  }

  private async resolveDependencies(
    version: ModrinthVersion,
    ctx: InstanceContext,
    installedProjectIds: Set<string>,
    options: ModWorkOptions
  ): Promise<ModrinthVersion[]> {
    const required = version.dependencies.filter((dep) => dep.kind === 'required')
    if (required.length === 0) return []
    options.onProgress?.({ done: 0, total: 2, unit: 'steps' }, '查找前置 Mod')
    const byId = required.map((dep) => dep.versionId).filter((id): id is string => !!id)
    const exact = byId.length > 0 ? await this.client.versionsByIds(byId) : []
    const chosen: ModrinthVersion[] = []
    const seen = new Set<string>([version.projectId])
    for (const dep of required) {
      if (dep.projectId && installedProjectIds.has(dep.projectId)) continue
      const exactHit = dep.versionId ? exact.find((item) => item.id === dep.versionId) : undefined
      if (exactHit) {
        if (seen.has(exactHit.projectId)) continue
        seen.add(exactHit.projectId)
        chosen.push(exactHit)
        continue
      }
      if (!dep.projectId) continue
      if (seen.has(dep.projectId)) continue
      const list = await this.client.versions(dep.projectId, { loader: ctx.loader, minecraft: ctx.minecraftVersion })
      const usable = list.filter((item) => this.usable(item, ctx))
      const best = usable.sort((a, b) => (b.publishedAt > a.publishedAt ? 1 : -1))[0]
      if (!best) continue
      seen.add(best.projectId)
      chosen.push(best)
    }
    return chosen
  }

  private usable(version: ModrinthVersion, ctx: InstanceContext): boolean {
    if (version.loaders.length > 0 && ctx.loader !== 'vanilla' && !version.loaders.includes(ctx.loader)) return false
    if (ctx.minecraftVersion && version.gameVersions.length > 0 && !version.gameVersions.includes(ctx.minecraftVersion)) return false
    return true
  }

  async addFiles(ctx: InstanceContext, paths: string[]): Promise<string[]> {
    const dir = modsDir(ctx.gameDir)
    await mkdir(dir, { recursive: true })
    const existing = new Set((await scanModFiles(ctx.gameDir, this.hashCache)).map((file) => file.file.toLowerCase()))
    const copied: string[] = []
    for (const path of paths) {
      const name = basename(path)
      if (!name.toLowerCase().endsWith('.jar')) continue
      if (existing.has(name.toLowerCase())) continue
      await copyFile(path, join(dir, name))
      copied.push(name)
    }
    return copied
  }
}
