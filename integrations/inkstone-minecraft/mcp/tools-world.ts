import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DevProject } from '../src/core/dev/runner.ts'
import {
  createSnapshot,
  dataVersionFor,
  deleteSnapshot,
  describeVersion,
  formatBytes,
  importWorld,
  listSnapshots,
  listWorlds,
  restoreSnapshot,
  runDirOf,
  savesDirOf,
  worldPath,
  type SnapshotEntry,
  type WorldEntry
} from '../src/core/dev/worlds.ts'
import { failure, text, type ToolDefinition, type ToolResult } from './protocol.ts'
import { USER_IN_CONTROL } from './tools.ts'

export interface WorldToolContext {
  options: { runtimesDir: string; javaPaths: string[]; maxMemoryMb: number; log: (line: string) => void }
  project(args: Record<string, unknown>): DevProject
  minecraft(project: DevProject): Promise<string | null>
}

const PROJECT_PROPERTY = { type: 'string', description: 'Fabric mod 项目根目录（含 build.gradle）。省略时用 INKSTONE_MC_PROJECT 或当前目录' }
const WORLD_PROPERTY = { type: 'string', description: '开发存档名，例如 inkstone-test 或导入后的名字（action=list 看有哪些）；snapshot/snapshots/restore 省略时用当前正在运行的世界' }

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function entryDetail(entry: WorldEntry): string {
  const parts = [`${entry.files} 个文件 ${formatBytes(entry.bytes)}`]
  if (entry.level?.lastPlayed) parts.push(`最后游玩 ${new Date(entry.level.lastPlayed).toLocaleString()}`)
  if (entry.imported) parts.push(`导入自 ${entry.imported.source}`)
  if (entry.error) parts.push(entry.error)
  return parts.join('，')
}

function formatWorld(entry: WorldEntry): string {
  const head = `${entry.active ? '▶ ' : '  '}${entry.name}`
  const level = entry.level ? `Minecraft ${describeVersion(entry.level)}${entry.level.levelName && entry.level.levelName !== entry.name ? `，世界里叫 ${entry.level.levelName}` : ''}` : '不是存档目录'
  return `${head}  ${level}；${entryDetail(entry)}`
}

function formatSnapshot(entry: SnapshotEntry): string {
  const when = new Date(entry.at).toLocaleString()
  return `  ${entry.id}  ${when}${entry.level ? `，Minecraft ${describeVersion(entry.level)}` : '，缺 level.dat'}，${entry.files} 个文件 ${formatBytes(entry.bytes)}`
}

interface SessionState {
  running: boolean
  world: string | null
  owner: 'agent' | 'user' | null
}

async function sessionState(project: DevProject): Promise<SessionState> {
  try {
    const info = await project.status()
    return { running: !!info.pid, world: info.world, owner: info.control?.owner ?? null }
  } catch {
    return { running: false, world: null, owner: null }
  }
}

async function runDir(project: DevProject): Promise<string> {
  const spec = await project.readSpec()
  return runDirOf(project.projectDir, spec?.workingDir)
}

async function requireWorld(args: Record<string, unknown>, project: DevProject): Promise<string> {
  const world = str(args, 'world') ?? (await sessionState(project)).world
  if (!world) throw new Error('需要 world（开发存档名，action=list 看有哪些）；游戏运行在某个世界里时可以省略，默认用当前世界')
  return world
}

export function createWorldTools(context: WorldToolContext): ToolDefinition[] {
  return [
    {
      name: 'mc_world',
      title: '开发存档与快照',
      description:
        '管理开发客户端的世界存档。action=list 列出项目 run/saves 里的存档（版本、大小、导入来源、哪个正在用）；import 把用户指定的外部存档复制成只读副本进开发存档（source 指向某个世界文件夹，如 F:/Minecraft/.minecraft/saves/X；先读 level.dat 的 DataVersion 与项目 Minecraft 版本比较：存档更新会拒绝导入，存档更旧会提示会被升级；原存档只读、不写入；重名自动加 -2、-3 后缀，也可以 name 指定名字）；snapshot 给存档拍快照（先执行 save-all flush 落盘，存到 .inkstone/dev/snapshots/<存档>/<id>，label 给快照起名）；snapshots 列快照；restore 恢复到某个快照（必须在游戏停止时做：游戏在运行时自动「停→备份→恢复→重新启动」，restart=false 时只报告需要先停；恢复前自动把当前状态存成 before-restore 快照，backup=false 关闭）；delete_snapshot 删掉一个快照（snapshot 传 id）。用户接管开发客户端（控制方为 user）时 snapshot/restore 会被拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: { type: 'string', enum: ['list', 'import', 'snapshot', 'snapshots', 'restore', 'delete_snapshot'], description: '要做什么，默认 list' },
          world: WORLD_PROPERTY,
          source: { type: 'string', description: 'import 用：外部存档的世界文件夹（含 level.dat 的目录），绝对路径' },
          name: { type: 'string', description: 'import 用：导入后的存档名，默认用源文件夹名；重名自动加后缀' },
          label: { type: 'string', description: 'snapshot 用：快照标签，会拼在时间戳后面，例如 baseline' },
          snapshot: { type: 'string', description: 'restore/delete_snapshot 用：快照 id（action=snapshots 看有哪些）' },
          restart: { type: 'boolean', description: 'restore 用：游戏在运行时恢复后自动重新启动（默认 true）' },
          backup: { type: 'boolean', description: 'restore 用：恢复前把当前状态存成 before-restore 快照（默认 true）' }
        },
        required: ['action']
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const project = context.project(args)
          const action = str(args, 'action') ?? 'list'
          const dir = await runDir(project)
          if (action === 'list') {
            const state = await sessionState(project)
            const worlds = await listWorlds(dir, state.world)
            if (!worlds.length) return text(`开发存档目录还是空的：${savesDirOf(dir)}\n用 mc_world action=import source=<世界文件夹> 导入用户指定的存档，或 mc_run action=start 让它建测试世界`)
            return text([`开发存档 ${worlds.length} 个（${savesDirOf(dir)}）${state.running ? `，正在用 ${state.world ?? '标题界面'}` : '，游戏没在运行'}`, ...worlds.map(formatWorld)].join('\n'))
          }
          if (action === 'import') {
            const source = str(args, 'source')
            if (!source) return failure('import 需要 source（外部存档的世界文件夹，含 level.dat）')
            const projectVersion = await context.minecraft(project)
            const result = await importWorld({ runDir: dir, source, name: str(args, 'name') ?? null, projectVersion })
            const lines = [
              `已导入 ${result.world}（${result.files} 个文件，${formatBytes(result.bytes)}）`,
              `存档版本：Minecraft ${describeVersion(result.level)}；项目：${projectVersion ?? '未知'}${dataVersionFor(projectVersion) === null && result.compare.basis === 'none' ? '（版本表里没有这个版本）' : ''}`,
              `位置：${result.dir}`,
              result.renamedFrom ? `名字 ${result.renamedFrom} 已被占用，改叫 ${result.world}` : '',
              ...result.warnings,
              `原存档只读、未写入：${result.source}`,
              `用它做测试：mc_run action=start world=${result.world}`
            ]
            return text(lines.filter(Boolean).join('\n'))
          }
          if (action === 'snapshot') {
            const world = await requireWorld(args, project)
            if (!existsSync(join(worldPath(dir, world), 'level.dat'))) return failure(`开发存档 ${world} 不存在：${worldPath(dir, world)}`)
            const state = await sessionState(project)
            let lease: string | null = null
            if (state.running) {
              if ((await project.control())?.owner === 'user') return failure(USER_IN_CONTROL)
              let result
              try {
                result = await project.companion('/snapshot-begin', {}, 95_000) as Record<string, unknown>
              } catch (thrown) {
                return failure(`快照保存屏障不可用，未复制存档。请更新伴随 mod，或经用户授权停游戏后再拍快照：${thrown instanceof Error ? thrown.message : String(thrown)}`)
              }
              if (result.ok !== true || typeof result.lease !== 'string') return failure(`快照保存屏障失败：${String(result.error ?? '伴随 mod 没有返回 lease')}`)
              lease = result.lease
              if (typeof result.worldPath !== 'string' || resolve(result.worldPath).toLowerCase() !== resolve(worldPath(dir, world)).toLowerCase()) {
                await project.companion('/snapshot-end', { lease })
                return failure('当前服务器世界与请求的存档目录不一致，未复制存档；请核对 world 参数')
              }
            }
            let snapshot: SnapshotEntry
            const guarded = lease !== null
            try {
              snapshot = await createSnapshot({ runDir: dir, projectDir: project.projectDir, world, label: str(args, 'label') ?? null, beforePublish: lease ? async () => {
                const result = await project.companion('/snapshot-end', { lease }) as Record<string, unknown>
                lease = null
                if (result.ok !== true) throw new Error(`快照屏障失效，副本未发布：${String(result.error ?? '超时或用户接管')}`)
              } : undefined })
            } finally {
              if (lease) await project.companion('/snapshot-end', { lease }).catch(() => undefined)
            }
            return text(
              [
                `已创建快照 ${snapshot.id}（${snapshot.files} 个文件，${formatBytes(snapshot.bytes)}）`,
                guarded ? '服务器线程同步保存并完成复制屏障后发布快照' : '游戏没在运行，直接复制存档目录',
                `位置：${snapshot.dir}`,
                `恢复：mc_world action=restore world=${world} snapshot=${snapshot.id}`
              ].join('\n')
            )
          }
          if (action === 'snapshots') {
            const world = str(args, 'world') ?? null
            const snapshots = await listSnapshots(project.projectDir, world)
            if (!snapshots.length) return text(world ? `存档 ${world} 还没有快照\n拍一个：mc_world action=snapshot world=${world} label=baseline` : '还没有任何快照')
            const grouped = new Map<string, SnapshotEntry[]>()
            for (const snapshot of snapshots) {
              const list = grouped.get(snapshot.world) ?? []
              list.push(snapshot)
              grouped.set(snapshot.world, list)
            }
            const lines = [`共 ${snapshots.length} 个快照（${join(project.projectDir, '.inkstone', 'dev', 'snapshots')}）`]
            for (const [name, list] of grouped) {
              lines.push(`${name}：`)
              for (const snapshot of list) lines.push(formatSnapshot(snapshot))
            }
            return text(lines.join('\n'))
          }
          if (action === 'restore') {
            const world = await requireWorld(args, project)
            const id = str(args, 'snapshot')
            if (!id) return failure('restore 需要 snapshot（快照 id，从 mc_world action=snapshots 看）')
            const state = await sessionState(project)
            const restart = args.restart !== false
            if (state.running) {
              if ((await project.control())?.owner === 'user') return failure(USER_IN_CONTROL)
              if (!restart) return failure(`恢复需要先停游戏：${world} 正在运行。用 mc_run action=stop，或让它自动停-恢复-启动（restart=true）`)
              await project.stop()
            }
            const restored = await restoreSnapshot({ runDir: dir, projectDir: project.projectDir, world, id, backup: args.backup !== false })
            const lines = [`已恢复存档 ${world} 到快照 ${id}（${restored.files} 个文件，${formatBytes(restored.bytes)}）`]
            if (restored.backup) lines.push(`恢复前的状态已存成快照 ${restored.backup.id}（要回退就再恢复它）`)
            if (!restored.replaced) lines.push('原来没有这个存档，直接新建')
            if (state.running) {
              try {
                await project.launch({ projectDir: project.projectDir, world })
                lines.push(`已重新启动游戏并进入 ${world}`)
              } catch (thrown) {
                lines.push(`恢复成功，但重新启动失败：${thrown instanceof Error ? thrown.message : String(thrown)}`)
                lines.push(`用 mc_run action=start world=${world} 重试`)
              }
            } else {
              lines.push('游戏没在运行，下次 mc_run action=start 会用恢复后的存档')
            }
            return text(lines.join('\n'))
          }
          if (action === 'delete_snapshot') {
            const world = await requireWorld(args, project)
            const id = str(args, 'snapshot')
            if (!id) return failure('delete_snapshot 需要 snapshot（快照 id）')
            await deleteSnapshot(project.projectDir, world, id)
            const rest = await listSnapshots(project.projectDir, world)
            return text(`已删除快照 ${id}（存档 ${world}）${rest.length ? `，还剩 ${rest.length} 个` : '，该存档已没有快照'}`)
          }
          return failure(`不支持的 action：${action}（可选 list、import、snapshot、snapshots、restore、delete_snapshot）`)
        } catch (thrown) {
          return failure(thrown instanceof Error ? thrown.message : String(thrown))
        }
      }
    }
  ]
}
